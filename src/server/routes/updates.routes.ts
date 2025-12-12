import { Router } from 'express';
import { Request, Response } from 'express';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import FormData from 'form-data';
import { logger } from '../config/logger.js';

const router = Router();

// Update manifest schema
const UpdateManifestSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  runtimeVersion: z.string(),
  platform: z.enum(['android', 'ios']),
  assets: z.array(z.object({
    hash: z.string(),
    key: z.string(),
    contentType: z.string(),
    url: z.string(),
  })),
  launchAsset: z.object({
    hash: z.string(),
    key: z.string(),
    contentType: z.string(),
    url: z.string(),
  }),
});

// Client update request schema (for query params - legacy)
const UpdateRequestSchema = z.object({
  runtimeVersion: z.string().optional(),
  platform: z.enum(['android', 'ios']).optional(),
  currentBundleId: z.string().optional(),
});

// Helper to convert hex hash to base64url (expo-updates requires base64url encoded hashes)
function hexToBase64Url(hex: string): string {
  const bytes = Buffer.from(hex, 'hex');
  return bytes.toString('base64url');
}

// Helper to convert SHA256 hash to UUID format (required by expo-updates)
function convertSHA256HashToUUID(hash: string): string {
  // Take first 32 chars of hex hash and format as UUID
  const hex = hash.substring(0, 32);
  return `${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20, 32)}`;
}

// Helper to get base URL for assets
function getBaseUrl(req: Request): string {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'api.circle.orincore.com';
  return `${protocol}://${host}`;
}

// Create multipart/mixed response for expo-updates protocol v1
function createMultipartResponse(manifest: object, extensions: object): { boundary: string; body: Buffer } {
  const boundary = `----ExpoUpdatesBoundary${crypto.randomBytes(16).toString('hex')}`;
  
  const manifestJson = JSON.stringify(manifest);
  const extensionsJson = JSON.stringify(extensions);
  
  const parts: string[] = [];
  
  // Manifest part
  parts.push(`--${boundary}`);
  parts.push('Content-Type: application/json; charset=utf-8');
  parts.push('');
  parts.push(manifestJson);
  
  // Extensions part
  parts.push(`--${boundary}`);
  parts.push('Content-Type: application/json; charset=utf-8');
  parts.push('');
  parts.push(extensionsJson);
  
  // End boundary
  parts.push(`--${boundary}--`);
  parts.push('');
  
  const body = Buffer.from(parts.join('\r\n'), 'utf-8');
  
  return { boundary, body };
}

// Create no-update-available directive response
function createNoUpdateDirectiveResponse(): { boundary: string; body: Buffer } {
  const boundary = `----ExpoUpdatesBoundary${crypto.randomBytes(16).toString('hex')}`;
  
  const directive = {
    type: 'noUpdateAvailable'
  };
  
  const directiveJson = JSON.stringify(directive);
  
  const parts: string[] = [];
  
  // Directive part
  parts.push(`--${boundary}`);
  parts.push('Content-Type: application/json; charset=utf-8');
  parts.push('');
  parts.push(directiveJson);
  
  // End boundary
  parts.push(`--${boundary}--`);
  parts.push('');
  
  const body = Buffer.from(parts.join('\r\n'), 'utf-8');
  
  return { boundary, body };
}

// OTA Routes Version - for debugging deployment issues
const OTA_ROUTES_VERSION = '2.0.2';

// Directory structure for updates
const UPDATES_DIR = path.join(process.cwd(), 'public', 'updates');
const MANIFESTS_DIR = path.join(UPDATES_DIR, 'manifests');
const BUNDLES_DIR = path.join(UPDATES_DIR, 'bundles');

// Log version on module load
logger.info({ version: OTA_ROUTES_VERSION, UPDATES_DIR, MANIFESTS_DIR, BUNDLES_DIR }, '🚀 [OTA] Routes module loaded');

// Ensure directories exist
async function ensureDirectories() {
  try {
    await fs.mkdir(UPDATES_DIR, { recursive: true });
    await fs.mkdir(MANIFESTS_DIR, { recursive: true });
    await fs.mkdir(BUNDLES_DIR, { recursive: true });
  } catch (error) {
    logger.error({ error }, 'Failed to create update directories');
  }
}

// Configure multer for memory storage (we'll process the file in memory)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024, // 20MB limit
  },
});

// Initialize directories on startup
ensureDirectories();

/**
 * GET /api/updates/manifest
 * Returns the update manifest for expo-updates protocol v0 and v1
 * 
 * expo-updates sends these headers:
 * - expo-platform: ios | android
 * - expo-runtime-version: string
 * - expo-protocol-version: 0 or 1
 * - expo-current-update-id: UUID of current update (optional)
 * 
 * Protocol v0: Returns JSON directly
 * Protocol v1: Returns multipart/mixed response with manifest and extensions
 */
router.get('/manifest', async (req: Request, res: Response) => {
  const requestId = crypto.randomUUID().substring(0, 8);
  const startTime = Date.now();
  
  try {
    // Parse from headers (expo-updates protocol) or fallback to query params
    const platform = (req.headers['expo-platform'] as string) || (req.query.platform as string);
    const runtimeVersion = (req.headers['expo-runtime-version'] as string) || (req.query.runtimeVersion as string);
    const currentUpdateId = req.headers['expo-current-update-id'] as string;
    const protocolVersionHeader = req.headers['expo-protocol-version'] as string;
    const protocolVersion = parseInt(protocolVersionHeader || '0', 10);
    const acceptHeader = req.headers['accept'] as string;
    const userAgent = req.headers['user-agent'] as string;

    // Log ALL incoming request details for debugging
    logger.info({ 
      requestId,
      method: req.method,
      url: req.url,
      platform, 
      runtimeVersion, 
      currentUpdateId,
      protocolVersion,
      acceptHeader,
      userAgent,
      ip: req.ip,
      allHeaders: req.headers
    }, '🔍 [OTA] Manifest request received');

    // Validate required fields
    if (!platform || !runtimeVersion) {
      logger.warn({ requestId, platform, runtimeVersion }, '❌ [OTA] Missing platform or runtimeVersion');
      return res.status(400).json({ error: 'Missing platform or runtimeVersion' });
    }

    if (platform !== 'ios' && platform !== 'android') {
      logger.warn({ requestId, platform }, '❌ [OTA] Invalid platform');
      return res.status(400).json({ error: 'Invalid platform' });
    }

    // Get the latest manifest for the platform and runtime version
    const manifestPath = path.join(MANIFESTS_DIR, `${platform}-${runtimeVersion}.json`);
    
    logger.info({ requestId, manifestPath, MANIFESTS_DIR }, '📂 [OTA] Looking for manifest file');
    
    try {
      const manifestData = await fs.readFile(manifestPath, 'utf-8');
      const storedManifest = JSON.parse(manifestData);
      
      logger.info({ 
        requestId, 
        storedManifestId: storedManifest.id,
        storedCreatedAt: storedManifest.createdAt,
        storedPlatform: storedManifest.platform,
        storedRuntimeVersion: storedManifest.runtimeVersion,
        launchAssetHash: storedManifest.launchAsset?.hash?.substring(0, 16) + '...',
      }, '✅ [OTA] Manifest file found and parsed');

      const baseUrl = getBaseUrl(req);
      logger.info({ requestId, baseUrl }, '🌐 [OTA] Base URL for assets');
      
      // Get the hash and convert to proper format
      const launchAssetHash = storedManifest.launchAsset?.hash || '';
      const base64UrlHash = launchAssetHash.length === 64 ? hexToBase64Url(launchAssetHash) : launchAssetHash;
      
      // Generate a proper UUID from the hash for the update ID
      const updateId = storedManifest.id.includes('-') 
        ? storedManifest.id 
        : convertSHA256HashToUUID(launchAssetHash || storedManifest.id);

      logger.info({ 
        requestId, 
        updateId, 
        currentUpdateId,
        idsMatch: currentUpdateId === updateId 
      }, '🔑 [OTA] Update ID comparison');

      // Check if client already has the latest update (protocol v1)
      if (protocolVersion === 1 && currentUpdateId && currentUpdateId === updateId) {
        const duration = Date.now() - startTime;
        logger.info({ requestId, currentUpdateId, updateId, duration }, '⏭️ [OTA] Client already has latest update, sending noUpdateAvailable directive');
        
        const { boundary, body } = createNoUpdateDirectiveResponse();
        
        res.setHeader('expo-protocol-version', '1');
        res.setHeader('expo-sfv-version', '0');
        res.setHeader('cache-control', 'private, max-age=0');
        res.setHeader('content-type', `multipart/mixed; boundary=${boundary}`);
        
        logger.info({ requestId, boundary, bodyLength: body.length }, '📤 [OTA] Sending noUpdateAvailable response');
        return res.send(body);
      }

      // Build the manifest in expo-updates format
      const expoManifest = {
        id: updateId,
        createdAt: storedManifest.createdAt,
        runtimeVersion: storedManifest.runtimeVersion,
        launchAsset: {
          hash: base64UrlHash,
          key: storedManifest.launchAsset?.key || 'bundle',
          contentType: storedManifest.launchAsset?.contentType || 'application/javascript',
          url: `${baseUrl}${storedManifest.launchAsset?.url || `/api/updates/assets/${launchAssetHash}`}`,
        },
        assets: (storedManifest.assets || []).map((asset: any) => ({
          hash: asset.hash?.length === 64 ? hexToBase64Url(asset.hash) : asset.hash,
          key: asset.key,
          contentType: asset.contentType,
          fileExtension: asset.fileExtension,
          url: asset.url?.startsWith('http') ? asset.url : `${baseUrl}${asset.url}`,
        })),
        metadata: storedManifest.metadata || {},
        extra: storedManifest.extra || {
          expoClient: {
            name: 'Circle',
            slug: 'circle',
            version: '1.0.0',
            runtimeVersion: storedManifest.runtimeVersion,
          },
          eas: {
            projectId: 'c9234d97-8ff5-45bc-8f8f-8772ef0926a5'
          }
        },
      };

      const duration = Date.now() - startTime;
      logger.info({ 
        requestId,
        manifestId: expoManifest.id, 
        platform, 
        runtimeVersion,
        protocolVersion,
        launchAssetUrl: expoManifest.launchAsset.url,
        launchAssetHash: expoManifest.launchAsset.hash?.substring(0, 16) + '...',
        assetsCount: expoManifest.assets.length,
        duration
      }, '📦 [OTA] Serving update manifest - UPDATE AVAILABLE');

      // Protocol v1: Return multipart/mixed response
      if (protocolVersion === 1) {
        // Extensions contain asset request headers (can be empty)
        const extensions = {
          assetRequestHeaders: {}
        };
        
        const { boundary, body } = createMultipartResponse(expoManifest, extensions);
        
        res.setHeader('expo-protocol-version', '1');
        res.setHeader('expo-sfv-version', '0');
        res.setHeader('cache-control', 'private, max-age=0');
        res.setHeader('content-type', `multipart/mixed; boundary=${boundary}`);
        
        logger.info({ 
          requestId, 
          boundary, 
          bodyLength: body.length,
          responseType: 'multipart/mixed'
        }, '📤 [OTA] Sending multipart manifest response (protocol v1)');
        
        // Log the actual response body for debugging
        logger.debug({ requestId, responseBody: body.toString('utf-8').substring(0, 500) }, '📄 [OTA] Response body preview');
        
        return res.send(body);
      }
      
      // Protocol v0: Return JSON directly
      res.setHeader('expo-protocol-version', '0');
      res.setHeader('expo-sfv-version', '0');
      res.setHeader('cache-control', 'private, max-age=0');
      res.setHeader('content-type', 'application/json');

      logger.info({ requestId, responseType: 'application/json' }, '📤 [OTA] Sending JSON manifest response (protocol v0)');
      return res.json(expoManifest);
    } catch (error: any) {
      // No manifest found
      const duration = Date.now() - startTime;
      logger.warn({ 
        requestId, 
        platform, 
        runtimeVersion, 
        manifestPath,
        error: error.message,
        errorCode: error.code,
        duration
      }, '⚠️ [OTA] No manifest found for platform/runtime');
      
      // List available manifests for debugging
      try {
        const availableManifests = await fs.readdir(MANIFESTS_DIR);
        logger.info({ requestId, availableManifests }, '📋 [OTA] Available manifest files');
      } catch (listError) {
        logger.warn({ requestId, error: (listError as Error).message }, '📋 [OTA] Could not list manifest directory');
      }
      
      // Protocol v1: Return noUpdateAvailable directive
      if (protocolVersion === 1) {
        const { boundary, body } = createNoUpdateDirectiveResponse();
        
        res.setHeader('expo-protocol-version', '1');
        res.setHeader('expo-sfv-version', '0');
        res.setHeader('cache-control', 'private, max-age=0');
        res.setHeader('content-type', `multipart/mixed; boundary=${boundary}`);
        
        logger.info({ requestId }, '📤 [OTA] Sending noUpdateAvailable (no manifest found)');
        return res.send(body);
      }
      
      // Protocol v0: Return 204
      logger.info({ requestId }, '📤 [OTA] Sending 204 No Content (protocol v0, no manifest)');
      return res.status(204).send();
    }
  } catch (error) {
    logger.error({ error }, '❌ [OTA] Error serving update manifest');
    return res.status(400).json({ error: 'Invalid request parameters' });
  }
});

/**
 * GET /api/updates/assets/:hash
 * Serves update assets (JS bundles, source maps, etc.)
 */
router.get('/assets/:hash', async (req: Request, res: Response) => {
  const requestId = crypto.randomUUID().substring(0, 8);
  
  try {
    const { hash } = req.params;
    
    logger.info({ requestId, hash: hash?.substring(0, 16) + '...', userAgent: req.headers['user-agent'], BUNDLES_DIR }, '📥 [OTA] Asset request received');
    
    if (!hash || !/^[a-f0-9]+$/i.test(hash)) {
      logger.warn({ requestId, hash }, '❌ [OTA] Invalid asset hash format');
      return res.status(400).json({ error: 'Invalid asset hash' });
    }

    const assetPath = path.join(BUNDLES_DIR, hash);
    
    // Check if directory exists first
    try {
      await fs.access(BUNDLES_DIR);
      const files = await fs.readdir(BUNDLES_DIR);
      logger.info({ requestId, assetPath, bundlesDirExists: true, filesCount: files.length, filesPreview: files.slice(0, 3) }, '📂 [OTA] Looking for asset file');
    } catch (dirError: any) {
      logger.error({ requestId, BUNDLES_DIR, error: dirError.message }, '❌ [OTA] BUNDLES_DIR does not exist or not accessible');
    }
    
    try {
      const assetData = await fs.readFile(assetPath);
      
      // Determine content type based on file extension or hash
      let contentType = 'application/octet-stream';
      if (hash.endsWith('.js') || hash.includes('bundle')) {
        contentType = 'application/javascript';
      } else if (hash.endsWith('.map')) {
        contentType = 'application/json';
      }

      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=31536000'); // Cache for 1 year
      res.setHeader('ETag', hash);

      logger.info({ 
        requestId, 
        hash: hash.substring(0, 16) + '...', 
        size: assetData.length, 
        contentType 
      }, '✅ [OTA] Asset found and serving');
      
      return res.send(assetData);
    } catch (error: any) {
      logger.warn({ requestId, hash, assetPath, error: error.message, errorCode: error.code }, '⚠️ [OTA] Asset not found');
      
      // List available assets for debugging
      try {
        const availableAssets = await fs.readdir(BUNDLES_DIR);
        logger.info({ requestId, availableAssetsCount: availableAssets.length, sampleAssets: availableAssets.slice(0, 5) }, '📋 [OTA] Available assets');
      } catch (listError) {
        logger.warn({ requestId }, '📋 [OTA] Could not list bundles directory');
      }
      
      return res.status(404).json({ error: 'Asset not found' });
    }
  } catch (error) {
    logger.error({ requestId, error }, '❌ [OTA] Error serving asset');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/updates/upload
 * Upload new update bundle (internal endpoint for CI/CD)
 * Now accepts multipart/form-data instead of JSON to avoid base64 encoding overhead
 */
router.post('/upload', upload.single('bundle'), async (req: Request, res: Response) => {
  try {
    // This should be protected with API key or internal network only
    const apiKey = req.headers['x-api-key'];
    const internalApiKey = process.env.INTERNAL_API_KEY;
    
    // Check if request is from internal network (localhost, Docker network, or NGINX proxy)
    const clientIp = req.ip || req.socket.remoteAddress || '';
    const forwardedFor = req.headers['x-forwarded-for'] as string || '';
    const realIp = req.headers['x-real-ip'] as string || '';
    
    // Helper to check if IP is internal/private
    const isPrivateIp = (ip: string): boolean => {
      if (!ip) return false;
      return ip === '127.0.0.1' || 
             ip === '::1' || 
             ip === '::ffff:127.0.0.1' ||
             ip.startsWith('172.') ||  // Docker network (172.16.0.0 - 172.31.255.255)
             ip.startsWith('10.') ||   // Private network (10.0.0.0/8)
             ip.startsWith('192.168.') || // Private network (192.168.0.0/16)
             ip.startsWith('::ffff:172.') ||
             ip.startsWith('::ffff:10.') ||
             ip.startsWith('::ffff:192.168.');
    };
    
    const isInternalNetwork = 
      isPrivateIp(clientIp) ||
      isPrivateIp(realIp) ||
      forwardedFor.split(',').some(ip => isPrivateIp(ip.trim()));
    
    // Allow if: valid API key OR internal network request
    // If INTERNAL_API_KEY is not set, only allow internal network requests
    const hasValidApiKey = internalApiKey && apiKey === internalApiKey;
    
    if (!hasValidApiKey && !isInternalNetwork) {
      logger.warn({ clientIp, forwardedFor, hasApiKey: !!apiKey, isInternalNetwork }, 'OTA upload unauthorized');
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    logger.info({ clientIp, isInternalNetwork, hasValidApiKey }, 'OTA upload authorized');

    // Extract form fields
    const { platform, runtimeVersion, bundleType, manifest: manifestStr } = req.body;
    const bundleFile = req.file;

    if (!bundleFile || !platform || !runtimeVersion) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Generate unique ID for this update
    const updateId = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    // Get bundle buffer directly from multer (no base64 decoding needed)
    const bundleBuffer = bundleFile.buffer;
    
    const bundleHash = crypto.createHash('sha256').update(bundleBuffer).digest('hex');
    const bundlePath = path.join(BUNDLES_DIR, bundleHash);
    await fs.writeFile(bundlePath, bundleBuffer);

    // Create manifest with expo-updates protocol v1 required fields
    const updateManifest = {
      id: updateId,
      createdAt: timestamp,
      runtimeVersion,
      platform,
      bundleType: bundleType || 'javascript',
      assets: [],
      launchAsset: {
        hash: bundleHash,
        key: bundleType === 'hermes' ? 'bundle.hbc' : 'bundle.js',
        contentType: bundleType === 'hermes' ? 'application/octet-stream' : 'application/javascript',
        url: `/api/updates/assets/${bundleHash}`,
      },
      metadata: {},
      extra: {
        eas: {
          projectId: 'c9234d97-8ff5-45bc-8f8f-8772ef0926a5'
        }
      },
    };

    // Save manifest
    const manifestPath = path.join(MANIFESTS_DIR, `${platform}-${runtimeVersion}.json`);
    await fs.writeFile(manifestPath, JSON.stringify(updateManifest, null, 2));

    logger.info({ updateId, platform, runtimeVersion, bundleSize: bundleBuffer.length }, 'Update uploaded successfully');

    return res.json({ 
      success: true, 
      updateId,
      manifest: updateManifest 
    });
  } catch (error) {
    logger.error({ error }, 'Error uploading update');
    return res.status(500).json({ error: 'Failed to upload update' });
  }
});

/**
 * GET /api/updates/status
 * Get current update status and available versions
 */
router.get('/status', async (req: Request, res: Response) => {
  try {
    const manifests = await fs.readdir(MANIFESTS_DIR);
    const updates = [];

    for (const manifestFile of manifests) {
      if (manifestFile.endsWith('.json')) {
        const manifestPath = path.join(MANIFESTS_DIR, manifestFile);
        const manifestData = await fs.readFile(manifestPath, 'utf-8');
        const manifest = JSON.parse(manifestData);
        
        updates.push({
          platform: manifest.platform,
          runtimeVersion: manifest.runtimeVersion,
          id: manifest.id,
          createdAt: manifest.createdAt,
        });
      }
    }

    return res.json({ updates });
  } catch (error) {
    logger.error({ error }, 'Error getting update status');
    return res.status(500).json({ error: 'Failed to get update status' });
  }
});

/**
 * GET /api/updates/debug
 * Comprehensive debug endpoint to diagnose OTA update issues
 */
router.get('/debug', async (req: Request, res: Response) => {
  const debugInfo: any = {
    timestamp: new Date().toISOString(),
    otaRoutesVersion: OTA_ROUTES_VERSION,
    server: {
      nodeVersion: process.version,
      platform: process.platform,
      cwd: process.cwd(),
    },
    directories: {
      UPDATES_DIR,
      MANIFESTS_DIR,
      BUNDLES_DIR,
    },
    manifests: [],
    bundles: [],
    errors: [],
  };

  try {
    // Check if directories exist
    try {
      await fs.access(UPDATES_DIR);
      debugInfo.directories.updatesExists = true;
    } catch {
      debugInfo.directories.updatesExists = false;
      debugInfo.errors.push('UPDATES_DIR does not exist');
    }

    try {
      await fs.access(MANIFESTS_DIR);
      debugInfo.directories.manifestsExists = true;
    } catch {
      debugInfo.directories.manifestsExists = false;
      debugInfo.errors.push('MANIFESTS_DIR does not exist');
    }

    try {
      await fs.access(BUNDLES_DIR);
      debugInfo.directories.bundlesExists = true;
    } catch {
      debugInfo.directories.bundlesExists = false;
      debugInfo.errors.push('BUNDLES_DIR does not exist');
    }

    // List all manifests with full details
    if (debugInfo.directories.manifestsExists) {
      try {
        const manifestFiles = await fs.readdir(MANIFESTS_DIR);
        debugInfo.manifests = [];
        
        for (const file of manifestFiles) {
          if (file.endsWith('.json')) {
            try {
              const manifestPath = path.join(MANIFESTS_DIR, file);
              const stat = await fs.stat(manifestPath);
              const content = await fs.readFile(manifestPath, 'utf-8');
              const manifest = JSON.parse(content);
              
              // Check if the bundle file exists
              const bundleHash = manifest.launchAsset?.hash;
              let bundleExists = false;
              let bundleSize = 0;
              
              if (bundleHash) {
                const bundlePath = path.join(BUNDLES_DIR, bundleHash);
                try {
                  const bundleStat = await fs.stat(bundlePath);
                  bundleExists = true;
                  bundleSize = bundleStat.size;
                } catch {
                  bundleExists = false;
                  debugInfo.errors.push(`Bundle file missing for manifest ${file}: ${bundleHash}`);
                }
              }
              
              debugInfo.manifests.push({
                file,
                size: stat.size,
                modified: stat.mtime,
                manifest: {
                  id: manifest.id,
                  platform: manifest.platform,
                  runtimeVersion: manifest.runtimeVersion,
                  createdAt: manifest.createdAt,
                  bundleType: manifest.bundleType,
                  launchAsset: {
                    hash: manifest.launchAsset?.hash,
                    hashPreview: manifest.launchAsset?.hash?.substring(0, 16) + '...',
                    key: manifest.launchAsset?.key,
                    contentType: manifest.launchAsset?.contentType,
                    url: manifest.launchAsset?.url,
                  },
                  assetsCount: manifest.assets?.length || 0,
                },
                bundle: {
                  exists: bundleExists,
                  size: bundleSize,
                  sizeFormatted: bundleExists ? `${(bundleSize / 1024 / 1024).toFixed(2)} MB` : 'N/A',
                },
              });
            } catch (parseError: any) {
              debugInfo.errors.push(`Failed to parse manifest ${file}: ${parseError.message}`);
            }
          }
        }
      } catch (readError: any) {
        debugInfo.errors.push(`Failed to read manifests directory: ${readError.message}`);
      }
    }

    // List all bundles
    if (debugInfo.directories.bundlesExists) {
      try {
        const bundleFiles = await fs.readdir(BUNDLES_DIR);
        debugInfo.bundles = [];
        
        for (const file of bundleFiles.slice(0, 20)) { // Limit to 20 for performance
          try {
            const bundlePath = path.join(BUNDLES_DIR, file);
            const stat = await fs.stat(bundlePath);
            debugInfo.bundles.push({
              hash: file,
              hashPreview: file.substring(0, 16) + '...',
              size: stat.size,
              sizeFormatted: `${(stat.size / 1024 / 1024).toFixed(2)} MB`,
              modified: stat.mtime,
            });
          } catch {
            // Skip files we can't stat
          }
        }
        
        debugInfo.bundlesTotal = bundleFiles.length;
      } catch (readError: any) {
        debugInfo.errors.push(`Failed to read bundles directory: ${readError.message}`);
      }
    }

    // Test manifest endpoint simulation
    debugInfo.testEndpoints = {
      manifestUrl: '/api/updates/manifest',
      assetsUrl: '/api/updates/assets/:hash',
      statusUrl: '/api/updates/status',
      uploadUrl: '/api/updates/upload',
    };

    // Add expected request format
    debugInfo.expectedRequestFormat = {
      headers: {
        'expo-platform': 'android | ios',
        'expo-runtime-version': '1.0.0',
        'expo-protocol-version': '0 | 1',
        'expo-current-update-id': 'UUID (optional)',
      },
      example: 'curl -H "expo-platform: android" -H "expo-runtime-version: 1.0.0" -H "expo-protocol-version: 1" https://api.circle.orincore.com/api/updates/manifest',
    };

    // Summary
    debugInfo.summary = {
      totalManifests: debugInfo.manifests.length,
      totalBundles: debugInfo.bundlesTotal || debugInfo.bundles.length,
      totalErrors: debugInfo.errors.length,
      status: debugInfo.errors.length === 0 ? 'OK' : 'ISSUES_FOUND',
    };

    logger.info({ debugInfo: debugInfo.summary }, '🔧 [OTA] Debug info requested');

    return res.json(debugInfo);
  } catch (error: any) {
    logger.error({ error: error.message }, '❌ [OTA] Error generating debug info');
    debugInfo.errors.push(`Fatal error: ${error.message}`);
    return res.status(500).json(debugInfo);
  }
});

/**
 * GET /api/updates/test-manifest
 * Test endpoint that simulates what expo-updates would receive
 * Usage: /api/updates/test-manifest?platform=android&runtimeVersion=1.0.0
 */
router.get('/test-manifest', async (req: Request, res: Response) => {
  const platform = (req.query.platform as string) || 'android';
  const runtimeVersion = (req.query.runtimeVersion as string) || '1.0.0';
  const protocolVersion = parseInt((req.query.protocolVersion as string) || '1', 10);

  logger.info({ platform, runtimeVersion, protocolVersion }, '🧪 [OTA] Test manifest request');

  try {
    const manifestPath = path.join(MANIFESTS_DIR, `${platform}-${runtimeVersion}.json`);
    
    try {
      const manifestData = await fs.readFile(manifestPath, 'utf-8');
      const storedManifest = JSON.parse(manifestData);
      
      const baseUrl = getBaseUrl(req);
      const launchAssetHash = storedManifest.launchAsset?.hash || '';
      const base64UrlHash = launchAssetHash.length === 64 ? hexToBase64Url(launchAssetHash) : launchAssetHash;
      const updateId = storedManifest.id.includes('-') 
        ? storedManifest.id 
        : convertSHA256HashToUUID(launchAssetHash || storedManifest.id);

      // Check if bundle exists
      const bundlePath = path.join(BUNDLES_DIR, launchAssetHash);
      let bundleExists = false;
      let bundleSize = 0;
      try {
        const stat = await fs.stat(bundlePath);
        bundleExists = true;
        bundleSize = stat.size;
      } catch {
        bundleExists = false;
      }

      const expoManifest = {
        id: updateId,
        createdAt: storedManifest.createdAt,
        runtimeVersion: storedManifest.runtimeVersion,
        launchAsset: {
          hash: base64UrlHash,
          key: storedManifest.launchAsset?.key || 'bundle',
          contentType: storedManifest.launchAsset?.contentType || 'application/javascript',
          url: `${baseUrl}${storedManifest.launchAsset?.url || `/api/updates/assets/${launchAssetHash}`}`,
        },
        assets: storedManifest.assets || [],
        metadata: storedManifest.metadata || {},
        extra: storedManifest.extra || {},
      };

      return res.json({
        success: true,
        message: 'Manifest found and would be served',
        request: {
          platform,
          runtimeVersion,
          protocolVersion,
        },
        manifestFile: `${platform}-${runtimeVersion}.json`,
        bundle: {
          exists: bundleExists,
          hash: launchAssetHash,
          size: bundleSize,
          sizeFormatted: bundleExists ? `${(bundleSize / 1024 / 1024).toFixed(2)} MB` : 'N/A',
        },
        manifest: expoManifest,
        responseFormat: protocolVersion === 1 ? 'multipart/mixed' : 'application/json',
      });
    } catch (error: any) {
      // List available manifests
      let availableManifests: string[] = [];
      try {
        availableManifests = await fs.readdir(MANIFESTS_DIR);
      } catch {
        // Ignore
      }

      return res.json({
        success: false,
        message: 'No manifest found for this platform/runtime combination',
        request: {
          platform,
          runtimeVersion,
          protocolVersion,
        },
        manifestFile: `${platform}-${runtimeVersion}.json`,
        error: error.message,
        availableManifests,
        hint: 'Make sure OTA updates have been built and uploaded for this platform and runtime version',
      });
    }
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
