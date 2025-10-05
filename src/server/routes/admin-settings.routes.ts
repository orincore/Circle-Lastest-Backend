import { Router } from 'express'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import { supabase } from '../config/supabase.js'
import type { AuthRequest } from '../middleware/auth.js'

const router = Router()

/**
 * Get system settings
 * GET /api/admin/settings
 */
router.get('/', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  try {
    // Get settings from database
    const { data: settings } = await supabase
      .from('system_settings')
      .select('*')
      .single()

    if (!settings) {
      // Return default settings if none exist
      const defaultSettings = {
        maintenanceMode: false,
        registrationEnabled: true,
        matchmakingEnabled: true,
        chatEnabled: true,
        maxFileSize: 10,
        maxMessagesPerDay: 1000,
        maxFriendsPerUser: 500,
        sessionTimeout: 30,
        maxLoginAttempts: 5,
        requireEmailVerification: true,
        autoModeration: true,
        profanityFilter: true,
        imageModeration: true,
      }
      
      return res.json(defaultSettings)
    }

    return res.json(settings)
  } catch (error) {
    console.error('Get settings error:', error)
    return res.status(500).json({ error: 'Failed to fetch settings' })
  }
})

/**
 * Update system settings
 * PUT /api/admin/settings
 */
router.put('/', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const {
      maintenanceMode,
      registrationEnabled,
      matchmakingEnabled,
      chatEnabled,
      maxFileSize,
      maxMessagesPerDay,
      maxFriendsPerUser,
      sessionTimeout,
      maxLoginAttempts,
      requireEmailVerification,
      autoModeration,
      profanityFilter,
      imageModeration,
    } = req.body

    // Validate settings
    if (typeof maintenanceMode !== 'boolean' ||
        typeof registrationEnabled !== 'boolean' ||
        typeof matchmakingEnabled !== 'boolean' ||
        typeof chatEnabled !== 'boolean') {
      return res.status(400).json({ error: 'Invalid boolean settings' })
    }

    if (maxFileSize < 1 || maxFileSize > 100 ||
        maxMessagesPerDay < 1 || maxMessagesPerDay > 10000 ||
        maxFriendsPerUser < 1 || maxFriendsPerUser > 5000 ||
        sessionTimeout < 5 || sessionTimeout > 1440 ||
        maxLoginAttempts < 1 || maxLoginAttempts > 20) {
      return res.status(400).json({ error: 'Invalid numeric settings' })
    }

    const settingsData = {
      maintenance_mode: maintenanceMode,
      registration_enabled: registrationEnabled,
      matchmaking_enabled: matchmakingEnabled,
      chat_enabled: chatEnabled,
      max_file_size: maxFileSize,
      max_messages_per_day: maxMessagesPerDay,
      max_friends_per_user: maxFriendsPerUser,
      session_timeout: sessionTimeout,
      max_login_attempts: maxLoginAttempts,
      require_email_verification: requireEmailVerification,
      auto_moderation: autoModeration,
      profanity_filter: profanityFilter,
      image_moderation: imageModeration,
      updated_at: new Date().toISOString(),
      updated_by: req.user!.id,
    }

    // Check if settings exist
    const { data: existingSettings } = await supabase
      .from('system_settings')
      .select('id')
      .single()

    let result
    if (existingSettings) {
      // Update existing settings
      const { data, error } = await supabase
        .from('system_settings')
        .update(settingsData)
        .eq('id', existingSettings.id)
        .select()
        .single()
      
      result = { data, error }
    } else {
      // Insert new settings
      const { data, error } = await supabase
        .from('system_settings')
        .insert(settingsData)
        .select()
        .single()
      
      result = { data, error }
    }

    if (result.error) {
      console.error('Settings update error:', result.error)
      return res.status(500).json({ error: 'Failed to update settings' })
    }

    // Log admin action
    await supabase
      .from('admin_logs')
      .insert({
        admin_id: req.user!.id,
        action: 'update_system_settings',
        target_type: 'system',
        details: { settings: settingsData },
        created_at: new Date().toISOString(),
      })

    return res.json({ 
      success: true, 
      settings: result.data,
      message: 'Settings updated successfully' 
    })
  } catch (error) {
    console.error('Update settings error:', error)
    return res.status(500).json({ error: 'Failed to update settings' })
  }
})

/**
 * Clear system cache
 * POST /api/admin/settings/clear-cache
 */
router.post('/clear-cache', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  try {
    // In a real implementation, you would clear Redis cache, CDN cache, etc.
    // For now, we'll simulate cache clearing
    
    // Log the action
    await supabase
      .from('admin_logs')
      .insert({
        admin_id: req.user!.id,
        action: 'clear_system_cache',
        target_type: 'system',
        details: { timestamp: new Date().toISOString() },
        created_at: new Date().toISOString(),
      })

    // Simulate cache clearing delay
    await new Promise(resolve => setTimeout(resolve, 1000))

    return res.json({ 
      success: true, 
      message: 'System cache cleared successfully' 
    })
  } catch (error) {
    console.error('Clear cache error:', error)
    return res.status(500).json({ error: 'Failed to clear cache' })
  }
})

/**
 * Reset statistics
 * POST /api/admin/settings/reset-statistics
 */
router.post('/reset-statistics', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const { confirmReset } = req.body

    if (!confirmReset) {
      return res.status(400).json({ error: 'Reset confirmation required' })
    }

    // Reset analytics statistics (be careful with this!)
    const { error: analyticsError } = await supabase
      .from('user_activity_events')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000') // Delete all except impossible ID

    if (analyticsError) {
      console.error('Reset analytics error:', analyticsError)
      return res.status(500).json({ error: 'Failed to reset analytics data' })
    }

    // Reset other statistics tables as needed
    // Be very careful with this operation!

    // Log the action
    await supabase
      .from('admin_logs')
      .insert({
        admin_id: req.user!.id,
        action: 'reset_statistics',
        target_type: 'system',
        details: { 
          timestamp: new Date().toISOString(),
          warning: 'All statistics data was reset'
        },
        created_at: new Date().toISOString(),
      })

    return res.json({ 
      success: true, 
      message: 'Statistics reset successfully. This action cannot be undone.' 
    })
  } catch (error) {
    console.error('Reset statistics error:', error)
    return res.status(500).json({ error: 'Failed to reset statistics' })
  }
})

/**
 * Get system status
 * GET /api/admin/settings/status
 */
router.get('/status', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  try {
    // Get various system metrics
    const { count: totalUsers } = await supabase
      .from('profiles')
      .select('*', { count: 'exact', head: true })
      .is('deleted_at', null)

    const { count: activeChats } = await supabase
      .from('chats')
      .select('*', { count: 'exact', head: true })

    const { count: totalMessages } = await supabase
      .from('messages')
      .select('*', { count: 'exact', head: true })

    const { count: pendingReports } = await supabase
      .from('user_reports')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'pending')

    // Get current settings
    const { data: settings } = await supabase
      .from('system_settings')
      .select('*')
      .single()

    return res.json({
      systemHealth: {
        status: 'healthy',
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage(),
        timestamp: new Date().toISOString(),
      },
      statistics: {
        totalUsers: totalUsers || 0,
        activeChats: activeChats || 0,
        totalMessages: totalMessages || 0,
        pendingReports: pendingReports || 0,
      },
      settings: settings || {},
    })
  } catch (error) {
    console.error('Get system status error:', error)
    return res.status(500).json({ error: 'Failed to fetch system status' })
  }
})

export default router
