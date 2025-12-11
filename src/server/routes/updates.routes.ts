import { Router } from 'express';
import { Request, Response } from 'express';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
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

// Client update request schema
const UpdateRequestSchema = z.object({
  runtimeVersion: z.string(),
  platform: z.enum(['android', 'ios']),
  currentBundleId: z.string().optional(),
});

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

// Initialize directories on startup
ensureDirectories();

/**
 * GET /api/updates/manifest
 * Returns the update manifest for expo-updates
 */
router.get('/manifest', async (req: Request, res: Response) => {
  try {
    const query = UpdateRequestSchema.parse(req.query);
    const { runtimeVersion, platform, currentBundleId } = query;

    logger.info({ query }, 'Update manifest requested');

    // Get the latest manifest for the platform and runtime version
    const manifestPath = path.join(MANIFESTS_DIR, `${platform}-${runtimeVersion}.json`);
    
    try {
      const manifestData = await fs.readFile(manifestPath, 'utf-8');
      const manifest = JSON.parse(manifestData);

      // Check if client already has the latest update
      if (currentBundleId && manifest.id === currentBundleId) {
        return res.status(204).send(); // No update available
      }

      // Set required headers for expo-updates
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Expo-Protocol-Version', '0');
      res.setHeader('Expo-Sfv-Version', '0');

      return res.json(manifest);
    } catch (error) {
      // No manifest found - return 204 (no update available)
      logger.warn({ platform, runtimeVersion }, 'No manifest found for platform/runtime');
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
 */
router.post('/upload', async (req: Request, res: Response) => {
  try {
    // This should be protected with API key or internal network only
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== process.env.INTERNAL_API_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { manifest, bundle, platform, runtimeVersion } = req.body;

    if (!manifest || !bundle || !platform || !runtimeVersion) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Generate unique ID for this update
    const updateId = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    // Save bundle file
    const bundleHash = crypto.createHash('sha256').update(bundle).digest('hex');
    const bundlePath = path.join(BUNDLES_DIR, bundleHash);
    await fs.writeFile(bundlePath, bundle);

    // Create manifest
    const updateManifest = {
      id: updateId,
      createdAt: timestamp,
      runtimeVersion,
      platform,
      assets: [],
      launchAsset: {
        hash: bundleHash,
        key: 'bundle.js',
        contentType: 'application/javascript',
        url: `/api/updates/assets/${bundleHash}`,
      },
    };

    // Save manifest
    const manifestPath = path.join(MANIFESTS_DIR, `${platform}-${runtimeVersion}.json`);
    await fs.writeFile(manifestPath, JSON.stringify(updateManifest, null, 2));

    logger.info({ updateId, platform, runtimeVersion }, 'Update uploaded successfully');

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
