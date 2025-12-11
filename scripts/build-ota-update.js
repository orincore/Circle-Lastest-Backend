#!/usr/bin/env node

/**
 * Build OTA Update Script (Backend copy)
 * Generates Expo updates and uploads them to our self-hosted server
 *
 * This is a backend-local copy of the root-level scripts/build-ota-update.js
 * so that the script is present inside the backend repo when deployed to the
 * production server (e.g. /root/Circle-Lastest-Backend/scripts).
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

// Configuration
const CONFIG = {
  BACKEND_URL: process.env.BACKEND_URL || 'https://api.circle.orincore.com',
  INTERNAL_API_KEY: process.env.INTERNAL_API_KEY || 'your-internal-api-key',
  RUNTIME_VERSION: process.env.RUNTIME_VERSION || '1.0.0',
  PLATFORMS: ['android', 'ios'],
  OUTPUT_DIR: path.join(__dirname, '../dist-updates'),
  // Directory of the Expo app; can be overridden via env when running on server
  APP_DIR: process.env.CIRCLE_APP_DIR || path.join(__dirname, '../../Circle'),
};

console.log('🚀 Building OTA Updates (backend copy)...\n');

async function buildOTAUpdate() {
  try {
    // Clean output directory
    if (fs.existsSync(CONFIG.OUTPUT_DIR)) {
      fs.rmSync(CONFIG.OUTPUT_DIR, { recursive: true });
    }
    fs.mkdirSync(CONFIG.OUTPUT_DIR, { recursive: true });

    // Build for each platform
    for (const platform of CONFIG.PLATFORMS) {
      console.log(`📱 Building for ${platform}...`);

      // Export the update
      const exportCommand = `npx expo export --platform ${platform} --output-dir ${CONFIG.OUTPUT_DIR}/${platform}`;
      execSync(exportCommand, {
        cwd: CONFIG.APP_DIR,
        stdio: 'inherit',
      });

      // Find the main bundle file
      const bundlePath = findBundleFile(CONFIG.OUTPUT_DIR, platform);
      if (!bundlePath) {
        throw new Error(`Bundle file not found for ${platform}`);
      }

      // Read bundle content
      const bundleContent = fs.readFileSync(bundlePath);
      const bundleHash = crypto.createHash('sha256').update(bundleContent).digest('hex');

      console.log(`📦 Bundle hash for ${platform}: ${bundleHash.substring(0, 12)}...`);

      // Upload to backend
      await uploadUpdate(platform, bundleContent, bundleHash);

      console.log(`✅ ${platform} update uploaded successfully\n`);
    }

    console.log('🎉 All OTA updates built and uploaded successfully!');
  } catch (error) {
    console.error('❌ Error building OTA updates:', error.message);
    process.exit(1);
  }
}

function findBundleFile(outputDir, platform) {
  const platformDir = path.join(outputDir, platform);

  // Look for common bundle file names
  const possibleNames = [
    'index.js',
    'bundle.js',
    'main.js',
    '_expo/static/js/web/index.js',
  ];

  for (const name of possibleNames) {
    const fullPath = path.join(platformDir, name);
    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
  }

  // If not found, look recursively for .js files
  function findJSFiles(dir) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        const result = findJSFiles(fullPath);
        if (result) return result;
      } else if (file.endsWith('.js') && !file.includes('.map')) {
        return fullPath;
      }
    }
    return null;
  }

  return findJSFiles(platformDir);
}

async function uploadUpdate(platform, bundleContent, bundleHash) {
  try {
    const updateData = {
      platform,
      runtimeVersion: CONFIG.RUNTIME_VERSION,
      bundle: bundleContent.toString('utf8'), // Send as UTF-8 string, not base64
      manifest: {
        platform,
        runtimeVersion: CONFIG.RUNTIME_VERSION,
      },
    };

    const response = await axios.post(
      `${CONFIG.BACKEND_URL}/api/updates/upload`,
      updateData,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': CONFIG.INTERNAL_API_KEY,
        },
        timeout: 60000, // 60 second timeout
      },
    );

    if (response.data.success) {
      console.log(`📤 Upload successful for ${platform}:`, response.data.updateId);
    } else {
      throw new Error(`Upload failed: ${response.data.error}`);
    }
  } catch (error) {
    if (error.response) {
      throw new Error(`Upload failed: ${error.response.status} - ${error.response.data?.error || error.response.statusText}`);
    } else {
      throw new Error(`Upload failed: ${error.message}`);
    }
  }
}

// Run the build
buildOTAUpdate();
