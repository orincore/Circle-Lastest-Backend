import { Router } from 'express'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import { supabase } from '../config/supabase.js'
import type { AuthRequest } from '../middleware/auth.js'

const router = Router()

type Platform = 'android' | 'ios'

const BASELINE_VERSION_CONFIG: Record<Platform, {
  min_version: string
  latest_version: string
  force_update: boolean
  update_message: string
  optional_update_message: string
  store_url: string
}> = {
  android: {
    min_version: '2.0.0',
    latest_version: '2.0.1',
    force_update: false,
    update_message: 'Circle 2.x is required for the best experience. Please update to continue.',
    optional_update_message: 'New update available with major improvements!',
    store_url: 'https://play.google.com/store/apps/details?id=com.orincore.Circle'
  },
  ios: {
    min_version: '2.0.0',
    latest_version: '2.0.1',
    force_update: false,
    update_message: 'Circle 2.x is required for the best experience. Please update to continue.',
    optional_update_message: 'New update available with major improvements!',
    store_url: 'https://apps.apple.com/app/circle/id000000000'
  }
}

/**
 * Compare two semantic version strings
 * Returns: -1 if v1 < v2, 0 if equal, 1 if v1 > v2
 */
function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.split('.').map(Number)
  const parts2 = v2.split('.').map(Number)
  
  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0
    const p2 = parts2[i] || 0
    
    if (p1 < p2) return -1
    if (p1 > p2) return 1
  }
  
  return 0
}

/**
 * Check if app version needs update (PUBLIC - no auth required)
 * GET /api/app-version/check
 * Query params: version (current app version), platform (android/ios)
 */
router.get('/check', async (req, res) => {
  try {
    const { version, platform = 'android' } = req.query
    const normalizedPlatform = (String(platform).toLowerCase() === 'ios' ? 'ios' : 'android') as Platform

    if (!version || typeof version !== 'string') {
      return res.status(400).json({ error: 'Version parameter is required' })
    }

    // Get version config from database
    const { data: config, error } = await supabase
      .from('app_version_config')
      .select('*')
      .eq('platform', normalizedPlatform)
      .single()

    if (error || !config) {
      // No config found, fall back to baseline defaults so new major versions are recognised
      const baseline = BASELINE_VERSION_CONFIG[normalizedPlatform]
      const needsUpdate = compareVersions(version, baseline.min_version) < 0
      const hasNewerVersion = compareVersions(version, baseline.latest_version) < 0

      return res.json({
        updateRequired: needsUpdate,
        forceUpdate: needsUpdate && baseline.force_update,
        currentVersion: version,
        latestVersion: baseline.latest_version,
        minVersion: baseline.min_version,
        message: needsUpdate ? baseline.update_message : (hasNewerVersion ? baseline.optional_update_message : null),
        storeUrl: baseline.store_url,
        hasOptionalUpdate: hasNewerVersion && !needsUpdate
      })
    }

    const baseline = BASELINE_VERSION_CONFIG[normalizedPlatform]
    const mergedConfig = {
      ...baseline,
      ...config
    }

    const minVersion = mergedConfig.min_version || baseline.min_version
    const latestVersion = mergedConfig.latest_version || baseline.latest_version
    const forceUpdate = mergedConfig.force_update ?? baseline.force_update
    
    // Check if current version is below minimum
    const needsUpdate = compareVersions(version, minVersion) < 0
    
    // Check if there's a newer version available (for optional update)
    const hasNewerVersion = compareVersions(version, latestVersion) < 0

    return res.json({
      updateRequired: needsUpdate,
      forceUpdate: needsUpdate && forceUpdate,
      currentVersion: version,
      latestVersion: latestVersion,
      minVersion: minVersion,
      message: needsUpdate 
        ? (mergedConfig.update_message || baseline.update_message)
        : (hasNewerVersion ? (mergedConfig.optional_update_message || baseline.optional_update_message) : null),
      storeUrl: mergedConfig.store_url || baseline.store_url,
      hasOptionalUpdate: hasNewerVersion && !needsUpdate
    })
  } catch (error) {
    console.error('Version check error:', error)
    // On error, don't block the user
    return res.json({
      updateRequired: false,
      forceUpdate: false,
      currentVersion: req.query.version || '1.0.0',
      latestVersion: req.query.version || '1.0.0',
      minVersion: '1.0.0',
      message: null,
      storeUrl: 'https://play.google.com/store/apps/details?id=com.orincore.Circle'
    })
  }
})

/**
 * Get version config (ADMIN)
 * GET /api/app-version/config
 */
router.get('/config', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const { data: configs, error } = await supabase
      .from('app_version_config')
      .select('*')
      .order('platform')

    if (error) {
      console.error('Get version config error:', error)
      return res.status(500).json({ error: 'Failed to fetch version config' })
    }

    // Return configs or defaults
    const baselineConfigs = {
      android: { platform: 'android', ...BASELINE_VERSION_CONFIG.android },
      ios: { platform: 'ios', ...BASELINE_VERSION_CONFIG.ios }
    }

    // Merge with existing configs
    const result: Record<string, typeof baselineConfigs.android> = { ...baselineConfigs }
    if (configs) {
      configs.forEach((config: typeof baselineConfigs.android) => {
        if (config.platform === 'android' || config.platform === 'ios') {
          result[config.platform] = {
            ...baselineConfigs[config.platform],
            ...config
          }
        }
      })
    }

    return res.json(result)
  } catch (error) {
    console.error('Get version config error:', error)
    return res.status(500).json({ error: 'Failed to fetch version config' })
  }
})

/**
 * Update version config (ADMIN)
 * PUT /api/app-version/config
 */
router.put('/config', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const { 
      platform, 
      min_version, 
      latest_version, 
      force_update, 
      update_message,
      optional_update_message,
      store_url 
    } = req.body

    if (!platform || !['android', 'ios'].includes(platform)) {
      return res.status(400).json({ error: 'Valid platform (android/ios) is required' })
    }

    // Validate version format
    const versionRegex = /^\d+\.\d+\.\d+$/
    if (min_version && !versionRegex.test(min_version)) {
      return res.status(400).json({ error: 'Invalid min_version format. Use semantic versioning (e.g., 1.0.0)' })
    }
    if (latest_version && !versionRegex.test(latest_version)) {
      return res.status(400).json({ error: 'Invalid latest_version format. Use semantic versioning (e.g., 1.0.0)' })
    }

    const baseline = BASELINE_VERSION_CONFIG[platform as Platform]

    const configData = {
      platform,
      min_version: min_version || baseline.min_version,
      latest_version: latest_version || min_version || baseline.latest_version,
      force_update: force_update ?? baseline.force_update,
      update_message: update_message || baseline.update_message,
      optional_update_message: optional_update_message || baseline.optional_update_message,
      store_url: store_url || baseline.store_url,
      updated_at: new Date().toISOString(),
      updated_by: req.user!.id
    }

    // Check if config exists
    const { data: existing } = await supabase
      .from('app_version_config')
      .select('id')
      .eq('platform', platform)
      .single()

    let result
    if (existing) {
      // Update existing
      const { data, error } = await supabase
        .from('app_version_config')
        .update(configData)
        .eq('platform', platform)
        .select()
        .single()
      result = { data, error }
    } else {
      // Insert new
      const { data, error } = await supabase
        .from('app_version_config')
        .insert(configData)
        .select()
        .single()
      result = { data, error }
    }

    if (result.error) {
      console.error('Update version config error:', result.error)
      return res.status(500).json({ error: 'Failed to update version config' })
    }

    // Log admin action
    await supabase
      .from('admin_logs')
      .insert({
        admin_id: req.user!.id,
        action: 'update_app_version_config',
        target_type: 'system',
        details: { platform, config: configData },
        created_at: new Date().toISOString()
      })

    return res.json({
      success: true,
      config: result.data,
      message: `${platform} version config updated successfully`
    })
  } catch (error) {
    console.error('Update version config error:', error)
    return res.status(500).json({ error: 'Failed to update version config' })
  }
})

export default router
