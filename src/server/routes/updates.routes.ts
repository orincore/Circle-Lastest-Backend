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

// Directory structure for updates
const UPDATES_DIR = path.join(process.cwd(), 'public', 'updates');
const MANIFESTS_DIR = path.join(UPDATES_DIR, 'manifests');
const BUNDLES_DIR = path.join(UPDATES_DIR, 'bundles');

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
  try {
    // Parse from headers (expo-updates protocol) or fallback to query params
    const platform = (req.headers['expo-platform'] as string) || (req.query.platform as string);
    const runtimeVersion = (req.headers['expo-runtime-version'] as string) || (req.query.runtimeVersion as string);
    const currentUpdateId = req.headers['expo-current-update-id'] as string;
    const protocolVersionHeader = req.headers['expo-protocol-version'] as string;
    const protocolVersion = parseInt(protocolVersionHeader || '0', 10);

    logger.info({ 
      platform, 
      runtimeVersion, 
      currentUpdateId,
      protocolVersion,
      allHeaders: JSON.stringify(req.headers)
    }, 'Update manifest requested');

    // Validate required fields
    if (!platform || !runtimeVersion) {
      logger.warn({ platform, runtimeVersion }, 'Missing platform or runtimeVersion');
      return res.status(400).json({ error: 'Missing platform or runtimeVersion' });
    }

    if (platform !== 'ios' && platform !== 'android') {
      return res.status(400).json({ error: 'Invalid platform' });
    }

    // Get the latest manifest for the platform and runtime version
    const manifestPath = path.join(MANIFESTS_DIR, `${platform}-${runtimeVersion}.json`);
    
    try {
      const manifestData = await fs.readFile(manifestPath, 'utf-8');
      const storedManifest = JSON.parse(manifestData);

      const baseUrl = getBaseUrl(req);
      
      // Get the hash and convert to proper format
      const launchAssetHash = storedManifest.launchAsset?.hash || '';
      const base64UrlHash = launchAssetHash.length === 64 ? hexToBase64Url(launchAssetHash) : launchAssetHash;
      
      // Generate a proper UUID from the hash for the update ID
      const updateId = storedManifest.id.includes('-') 
        ? storedManifest.id 
        : convertSHA256HashToUUID(launchAssetHash || storedManifest.id);

      // Check if client already has the latest update (protocol v1)
      if (protocolVersion === 1 && currentUpdateId && currentUpdateId === updateId) {
        logger.info({ currentUpdateId, updateId }, 'Client already has latest update, sending noUpdateAvailable directive');
        
        const { boundary, body } = createNoUpdateDirectiveResponse();
        
        res.setHeader('expo-protocol-version', '1');
        res.setHeader('expo-sfv-version', '0');
        res.setHeader('cache-control', 'private, max-age=0');
        res.setHeader('content-type', `multipart/mixed; boundary=${boundary}`);
        
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

      logger.info({ 
        manifestId: expoManifest.id, 
        platform, 
        runtimeVersion,
        protocolVersion,
        launchAssetUrl: expoManifest.launchAsset.url
      }, 'Serving update manifest');

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
        
        return res.send(body);
      }
      
      // Protocol v0: Return JSON directly
      res.setHeader('expo-protocol-version', '0');
      res.setHeader('expo-sfv-version', '0');
      res.setHeader('cache-control', 'private, max-age=0');
      res.setHeader('content-type', 'application/json');

      return res.json(expoManifest);
    } catch (error: any) {
      // No manifest found
      logger.warn({ platform, runtimeVersion, error: error.message }, 'No manifest found for platform/runtime');
      
      // Protocol v1: Return noUpdateAvailable directive
      if (protocolVersion === 1) {
        const { boundary, body } = createNoUpdateDirectiveResponse();
        
        res.setHeader('expo-protocol-version', '1');
        res.setHeader('expo-sfv-version', '0');
        res.setHeader('cache-control', 'private, max-age=0');
        res.setHeader('content-type', `multipart/mixed; boundary=${boundary}`);
        
        return res.send(body);
      }
      
      // Protocol v0: Return 204
      return res.status(204).send();
    }
  } catch (error) {
    logger.error({ error }, 'Error serving update manifest');
    return res.status(400).json({ error: 'Invalid request parameters' });
  }
});

/**
 * GET /api/updates/assets/:hash
 * Serves update assets (JS bundles, source maps, etc.)
 */
router.get('/assets/:hash', async (req: Request, res: Response) => {
  try {
    const { hash } = req.params;
    
    if (!hash || !/^[a-f0-9]+$/i.test(hash)) {
      return res.status(400).json({ error: 'Invalid asset hash' });
    }

    const assetPath = path.join(BUNDLES_DIR, hash);
    
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

      return res.send(assetData);
    } catch (error) {
      logger.warn({ hash }, 'Asset not found');
      return res.status(404).json({ error: 'Asset not found' });
    }
  } catch (error) {
    logger.error({ error }, 'Error serving asset');
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

export default router;
