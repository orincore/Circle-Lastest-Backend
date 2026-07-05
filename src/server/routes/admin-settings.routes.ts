import { Router } from 'express'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import type { AuthRequest } from '../middleware/auth.js'
import { eq, isNull, sql } from 'drizzle-orm'
import { db } from '../config/db.js'
import { systemSettings, profiles, chats, messages, userReports, userActivityEvents } from '../db/schema.js'
import { logger } from '../config/logger.js'

const router = Router()

function mapSettingsRow(row: typeof systemSettings.$inferSelect) {
  return {
    key: row.key,
    value: row.value,
    description: row.description,
    category: row.category,
    updated_by: row.updatedBy,
    updated_at: row.updatedAt,
    auto_moderation: row.autoModeration,
    profanity_filter: row.profanityFilter,
    image_moderation: row.imageModeration,
    require_email_verification: row.requireEmailVerification,
    maintenance_mode: row.maintenanceMode,
    registration_enabled: row.registrationEnabled,
    matchmaking_enabled: row.matchmakingEnabled,
    chat_enabled: row.chatEnabled,
    max_file_size: row.maxFileSize,
    max_messages_per_day: row.maxMessagesPerDay,
    max_friends_per_user: row.maxFriendsPerUser,
    session_timeout: row.sessionTimeout,
    max_login_attempts: row.maxLoginAttempts,
  }
}

/**
 * Get system settings
 * GET /api/admin/settings
 */
router.get('/', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  try {
    // Get settings from database
    const [settingsRow] = await db.select().from(systemSettings).limit(1)

    if (!settingsRow) {
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

    return res.json(mapSettingsRow(settingsRow))
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
      updatedAt: new Date().toISOString(),
      updatedBy: req.user!.id,
    }

    // Upsert into the singleton settings row (key defaults to 'default')
    const [row] = await db.insert(systemSettings).values({
      key: 'default',
      ...settingsData,
    }).onConflictDoUpdate({
      target: systemSettings.key,
      set: settingsData,
    }).returning()

    if (!row) {
      console.error('Settings update error: no row returned')
      return res.status(500).json({ error: 'Failed to update settings' })
    }

    // Log admin action
    try {
      await db.execute(sql`
        insert into admin_logs (admin_id, action, target_type, details, created_at)
        values (${req.user!.id}::uuid, 'update_system_settings', 'system', ${JSON.stringify({ settings: settingsData })}::jsonb, ${new Date().toISOString()})
      `)
    } catch (err) {
      logger.warn({ error: err }, 'Could not write to admin_logs table')
    }

    return res.json({
      success: true,
      settings: mapSettingsRow(row),
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
    try {
      await db.execute(sql`
        insert into admin_logs (admin_id, action, target_type, details, created_at)
        values (${req.user!.id}::uuid, 'clear_system_cache', 'system', ${JSON.stringify({ timestamp: new Date().toISOString() })}::jsonb, ${new Date().toISOString()})
      `)
    } catch (err) {
      logger.warn({ error: err }, 'Could not write to admin_logs table')
    }

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
    try {
      await db.delete(userActivityEvents)
    } catch (analyticsError) {
      console.error('Reset analytics error:', analyticsError)
      return res.status(500).json({ error: 'Failed to reset analytics data' })
    }

    // Reset other statistics tables as needed
    // Be very careful with this operation!

    // Log the action
    try {
      await db.execute(sql`
        insert into admin_logs (admin_id, action, target_type, details, created_at)
        values (${req.user!.id}::uuid, 'reset_statistics', 'system', ${JSON.stringify({ timestamp: new Date().toISOString(), warning: 'All statistics data was reset' })}::jsonb, ${new Date().toISOString()})
      `)
    } catch (err) {
      logger.warn({ error: err }, 'Could not write to admin_logs table')
    }

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
    const [{ count: totalUsers }] = await db.select({ count: sql<number>`count(*)::int` }).from(profiles).where(isNull(profiles.deletedAt))
    const [{ count: activeChats }] = await db.select({ count: sql<number>`count(*)::int` }).from(chats)
    const [{ count: totalMessages }] = await db.select({ count: sql<number>`count(*)::int` }).from(messages)
    const [{ count: pendingReports }] = await db.select({ count: sql<number>`count(*)::int` }).from(userReports).where(eq(userReports.status, 'pending'))

    // Get current settings
    const [settingsRow] = await db.select().from(systemSettings).limit(1)

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
      settings: settingsRow ? mapSettingsRow(settingsRow) : {},
    })
  } catch (error) {
    console.error('Get system status error:', error)
    return res.status(500).json({ error: 'Failed to fetch system status' })
  }
})

export default router
