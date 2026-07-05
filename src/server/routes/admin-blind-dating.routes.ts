/**
 * Admin Blind Dating Routes
 * Handles admin operations for blind dating feature
 */

import express from 'express'
import { requireAuth, AuthRequest } from '../middleware/auth.js'
import { requireAdmin, AdminRequest } from '../middleware/adminAuth.js'
import { and, desc, eq, gte, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { db } from '../config/db.js'
import { blindDateBlockedMessages, blindDateDailyQueue, blindDateMatches, blindDatingSettings, chatMembers, chats, messages, profiles } from '../db/schema.js'
import { BlindDatingService } from '../services/blind-dating.service.js'
import { logger } from '../config/logger.js'

const router = express.Router()

/**
 * GET /api/admin/blind-dating/stats
 * Get blind dating statistics
 */
router.get('/stats', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    // Get diagnostics from service
    const diagnostics = await BlindDatingService.getDiagnostics()

    // Get additional stats
    const [{ count: totalMatches }] = await db.select({ count: sql<number>`count(*)::int` }).from(blindDateMatches)
    const [{ count: activeMatches }] = await db.select({ count: sql<number>`count(*)::int` }).from(blindDateMatches).where(eq(blindDateMatches.status, 'active'))
    const [{ count: revealedMatches }] = await db.select({ count: sql<number>`count(*)::int` }).from(blindDateMatches).where(eq(blindDateMatches.status, 'revealed'))
    const [{ count: endedMatches }] = await db.select({ count: sql<number>`count(*)::int` }).from(blindDateMatches).where(eq(blindDateMatches.status, 'ended'))
    const [{ count: blockedMessages }] = await db.select({ count: sql<number>`count(*)::int` }).from(blindDateBlockedMessages)

    // Get matches created today
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const [{ count: matchesToday }] = await db.select({ count: sql<number>`count(*)::int` }).from(blindDateMatches).where(gte(blindDateMatches.matchedAt, today.toISOString()))

    // Get matches created this week
    const weekAgo = new Date()
    weekAgo.setDate(weekAgo.getDate() - 7)
    const [{ count: matchesThisWeek }] = await db.select({ count: sql<number>`count(*)::int` }).from(blindDateMatches).where(gte(blindDateMatches.matchedAt, weekAgo.toISOString()))

    // Calculate success rate (revealed / (revealed + ended))
    const completedMatches = revealedMatches + endedMatches
    const successRate = completedMatches > 0
      ? Math.round((revealedMatches / completedMatches) * 100)
      : 0

    res.json({
      stats: {
        ...diagnostics,
        totalMatches,
        activeMatches,
        revealedMatches,
        endedMatches,
        blockedMessages,
        matchesToday,
        matchesThisWeek,
        successRate
      }
    })
  } catch (error) {
    logger.error({ error }, 'Error getting blind dating stats')
    res.status(500).json({ error: 'Failed to get stats' })
  }
})

/**
 * GET /api/admin/blind-dating/users
 * Get all users with blind dating settings
 */
router.get('/users', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { page = '1', limit = '20', filter = 'all' } = req.query
    const pageNum = parseInt(page as string)
    const limitNum = parseInt(limit as string)
    const offset = (pageNum - 1) * limitNum
    
    const filterCondition = filter === 'enabled' ? eq(blindDatingSettings.isEnabled, true)
      : filter === 'disabled' ? eq(blindDatingSettings.isEnabled, false)
      : undefined

    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(blindDatingSettings).where(filterCondition)

    const rows = await db.select({
      id: blindDatingSettings.id,
      user_id: blindDatingSettings.userId,
      is_enabled: blindDatingSettings.isEnabled,
      daily_match_time: blindDatingSettings.dailyMatchTime,
      max_active_matches: blindDatingSettings.maxActiveMatches,
      preferred_reveal_threshold: blindDatingSettings.preferredRevealThreshold,
      auto_match: blindDatingSettings.autoMatch,
      notifications_enabled: blindDatingSettings.notificationsEnabled,
      last_match_at: blindDatingSettings.lastMatchAt,
      created_at: blindDatingSettings.createdAt,
      updated_at: blindDatingSettings.updatedAt,
      user_id_ref: profiles.id,
      user_first_name: profiles.firstName,
      user_last_name: profiles.lastName,
      user_email: profiles.email,
      user_username: profiles.username,
      user_profile_photo_url: profiles.profilePhotoUrl,
      user_age: profiles.age,
      user_gender: profiles.gender,
      user_created_at: profiles.createdAt,
    })
      .from(blindDatingSettings)
      .leftJoin(profiles, eq(profiles.id, blindDatingSettings.userId))
      .where(filterCondition)
      .orderBy(desc(blindDatingSettings.updatedAt))
      .limit(limitNum)
      .offset(offset)

    const settings = rows.map(r => ({
      id: r.id,
      user_id: r.user_id,
      is_enabled: r.is_enabled,
      daily_match_time: r.daily_match_time,
      max_active_matches: r.max_active_matches,
      preferred_reveal_threshold: r.preferred_reveal_threshold,
      auto_match: r.auto_match,
      notifications_enabled: r.notifications_enabled,
      last_match_at: r.last_match_at,
      created_at: r.created_at,
      updated_at: r.updated_at,
      user: r.user_id_ref ? {
        id: r.user_id_ref,
        first_name: r.user_first_name,
        last_name: r.user_last_name,
        email: r.user_email,
        username: r.user_username,
        profile_photo_url: r.user_profile_photo_url,
        age: r.user_age,
        gender: r.user_gender,
        created_at: r.user_created_at,
      } : null,
    }))

    // Get active match counts for each user
    const usersWithMatchCounts = await Promise.all(
      settings.map(async (setting) => {
        const [{ count: activeMatchCount }] = await db.select({ count: sql<number>`count(*)::int` }).from(blindDateMatches)
          .where(and(
            or(eq(blindDateMatches.userA, setting.user_id), eq(blindDateMatches.userB, setting.user_id)),
            inArray(blindDateMatches.status, ['active', 'revealed']),
          ))

        const [{ count: totalMatchCount }] = await db.select({ count: sql<number>`count(*)::int` }).from(blindDateMatches)
          .where(or(eq(blindDateMatches.userA, setting.user_id), eq(blindDateMatches.userB, setting.user_id)))

        return {
          ...setting,
          activeMatchCount,
          totalMatchCount
        }
      })
    )

    res.json({
      users: usersWithMatchCounts,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: count,
        totalPages: Math.ceil(count / limitNum)
      }
    })
  } catch (error) {
    logger.error({ error }, 'Error getting blind dating users')
    res.status(500).json({ error: 'Failed to get users' })
  }
})

/**
 * GET /api/admin/blind-dating/matches
 * Get all blind date matches
 */
router.get('/matches', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { page = '1', limit = '20', status = 'all' } = req.query
    const pageNum = parseInt(page as string)
    const limitNum = parseInt(limit as string)
    const offset = (pageNum - 1) * limitNum
    
    const userAProfiles = alias(profiles, 'user_a_profiles')
    const userBProfiles = alias(profiles, 'user_b_profiles')

    const statusCondition = status !== 'all' ? eq(blindDateMatches.status, status as string) : undefined

    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(blindDateMatches).where(statusCondition)

    const rows = await db.select({
      id: blindDateMatches.id,
      user_a: blindDateMatches.userA,
      user_b: blindDateMatches.userB,
      chat_id: blindDateMatches.chatId,
      compatibility_score: blindDateMatches.compatibilityScore,
      status: blindDateMatches.status,
      message_count: blindDateMatches.messageCount,
      reveal_threshold: blindDateMatches.revealThreshold,
      user_a_revealed: blindDateMatches.userARevealed,
      user_b_revealed: blindDateMatches.userBRevealed,
      revealed_at: blindDateMatches.revealedAt,
      reveal_requested_by: blindDateMatches.revealRequestedBy,
      reveal_requested_at: blindDateMatches.revealRequestedAt,
      matched_at: blindDateMatches.matchedAt,
      ended_at: blindDateMatches.endedAt,
      ended_by: blindDateMatches.endedBy,
      end_reason: blindDateMatches.endReason,
      created_at: blindDateMatches.createdAt,
      updated_at: blindDateMatches.updatedAt,
      user_a_id: userAProfiles.id,
      user_a_first_name: userAProfiles.firstName,
      user_a_last_name: userAProfiles.lastName,
      user_a_email: userAProfiles.email,
      user_a_username: userAProfiles.username,
      user_a_photo: userAProfiles.profilePhotoUrl,
      user_b_id: userBProfiles.id,
      user_b_first_name: userBProfiles.firstName,
      user_b_last_name: userBProfiles.lastName,
      user_b_email: userBProfiles.email,
      user_b_username: userBProfiles.username,
      user_b_photo: userBProfiles.profilePhotoUrl,
    })
      .from(blindDateMatches)
      .leftJoin(userAProfiles, eq(userAProfiles.id, blindDateMatches.userA))
      .leftJoin(userBProfiles, eq(userBProfiles.id, blindDateMatches.userB))
      .where(statusCondition)
      .orderBy(desc(blindDateMatches.matchedAt))
      .limit(limitNum)
      .offset(offset)

    const matches = rows.map(r => ({
      id: r.id,
      user_a: r.user_a,
      user_b: r.user_b,
      chat_id: r.chat_id,
      compatibility_score: r.compatibility_score,
      status: r.status,
      message_count: r.message_count,
      reveal_threshold: r.reveal_threshold,
      user_a_revealed: r.user_a_revealed,
      user_b_revealed: r.user_b_revealed,
      revealed_at: r.revealed_at,
      reveal_requested_by: r.reveal_requested_by,
      reveal_requested_at: r.reveal_requested_at,
      matched_at: r.matched_at,
      ended_at: r.ended_at,
      ended_by: r.ended_by,
      end_reason: r.end_reason,
      created_at: r.created_at,
      updated_at: r.updated_at,
      user_a_profile: r.user_a_id ? {
        id: r.user_a_id, first_name: r.user_a_first_name, last_name: r.user_a_last_name,
        email: r.user_a_email, username: r.user_a_username, profile_photo_url: r.user_a_photo,
      } : null,
      user_b_profile: r.user_b_id ? {
        id: r.user_b_id, first_name: r.user_b_first_name, last_name: r.user_b_last_name,
        email: r.user_b_email, username: r.user_b_username, profile_photo_url: r.user_b_photo,
      } : null,
    }))

    res.json({
      matches,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: count,
        totalPages: Math.ceil(count / limitNum)
      }
    })
  } catch (error) {
    logger.error({ error }, 'Error getting blind date matches')
    res.status(500).json({ error: 'Failed to get matches' })
  }
})

/**
 * GET /api/admin/blind-dating/blocked-messages
 * Get blocked messages
 */
router.get('/blocked-messages', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { page = '1', limit = '20' } = req.query
    const pageNum = parseInt(page as string)
    const limitNum = parseInt(limit as string)
    const offset = (pageNum - 1) * limitNum
    
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(blindDateBlockedMessages)

    const blockedRows = await db.select({
      id: blindDateBlockedMessages.id,
      blind_date_id: blindDateBlockedMessages.blindDateId,
      sender_id: blindDateBlockedMessages.senderId,
      original_message: blindDateBlockedMessages.originalMessage,
      filtered_message: blindDateBlockedMessages.filteredMessage,
      blocked_reason: blindDateBlockedMessages.blockedReason,
      detection_confidence: blindDateBlockedMessages.detectionConfidence,
      ai_analysis: blindDateBlockedMessages.aiAnalysis,
      was_released: blindDateBlockedMessages.wasReleased,
      released_at: blindDateBlockedMessages.releasedAt,
      created_at: blindDateBlockedMessages.createdAt,
      sender_profile_id: profiles.id,
      sender_first_name: profiles.firstName,
      sender_last_name: profiles.lastName,
      sender_email: profiles.email,
      sender_username: profiles.username,
      blind_date_match_id: blindDateMatches.id,
      blind_date_status: blindDateMatches.status,
      blind_date_matched_at: blindDateMatches.matchedAt,
    })
      .from(blindDateBlockedMessages)
      .leftJoin(profiles, eq(profiles.id, blindDateBlockedMessages.senderId))
      .leftJoin(blindDateMatches, eq(blindDateMatches.id, blindDateBlockedMessages.blindDateId))
      .orderBy(desc(blindDateBlockedMessages.createdAt))
      .limit(limitNum)
      .offset(offset)

    const blockedMessages = blockedRows.map(r => ({
      id: r.id,
      blind_date_id: r.blind_date_id,
      sender_id: r.sender_id,
      original_message: r.original_message,
      filtered_message: r.filtered_message,
      blocked_reason: r.blocked_reason,
      detection_confidence: r.detection_confidence !== null ? Number(r.detection_confidence) : null,
      ai_analysis: r.ai_analysis,
      was_released: r.was_released,
      released_at: r.released_at,
      created_at: r.created_at,
      sender: r.sender_profile_id ? {
        id: r.sender_profile_id, first_name: r.sender_first_name, last_name: r.sender_last_name,
        email: r.sender_email, username: r.sender_username,
      } : null,
      blind_date: r.blind_date_match_id ? {
        id: r.blind_date_match_id, status: r.blind_date_status, matched_at: r.blind_date_matched_at,
      } : null,
    }))

    res.json({
      messages: blockedMessages,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: count,
        totalPages: Math.ceil(count / limitNum)
      }
    })
  } catch (error) {
    logger.error({ error }, 'Error getting blocked messages')
    res.status(500).json({ error: 'Failed to get blocked messages' })
  }
})

/**
 * POST /api/admin/blind-dating/enable-for-all
 * Enable blind dating for all users
 */
router.post('/enable-for-all', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    // Get all users without blind dating settings
    const allUsers = await db.select({ id: profiles.id }).from(profiles).where(isNull(profiles.deletedAt))

    let enabled = 0
    let errors = 0

    for (const user of allUsers) {
      try {
        await db.insert(blindDatingSettings).values({
          userId: user.id,
          isEnabled: true,
          autoMatch: true,
          maxActiveMatches: 3,
          preferredRevealThreshold: 30,
          notificationsEnabled: true,
          updatedAt: new Date().toISOString()
        }).onConflictDoUpdate({
          target: blindDatingSettings.userId,
          set: {
            isEnabled: true,
            autoMatch: true,
            maxActiveMatches: 3,
            preferredRevealThreshold: 30,
            notificationsEnabled: true,
            updatedAt: new Date().toISOString()
          },
        })
        enabled++
      } catch (error) {
        errors++
        logger.error({ error, userId: user.id }, 'Failed to enable blind dating for user')
      }
    }
    
    logger.info({ enabled, errors, adminId: req.user!.id }, 'Admin enabled blind dating for all users')
    
    res.json({
      success: true,
      message: `Enabled blind dating for ${enabled} users`,
      enabled,
      errors,
      totalUsers: (allUsers || []).length
    })
  } catch (error) {
    logger.error({ error }, 'Error enabling blind dating for all')
    res.status(500).json({ error: 'Failed to enable blind dating for all users' })
  }
})

/**
 * POST /api/admin/blind-dating/force-match-all
 * Force run matching for all eligible users
 */
router.post('/force-match-all', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    logger.info({ adminId: req.user!.id }, '🚀 Admin triggered force match all users')
    const result = await BlindDatingService.forceMatchAllUsers()
    
    res.json({
      success: true,
      message: `Processed ${result.processed} users, created ${result.matched} matches`,
      ...result
    })
  } catch (error) {
    logger.error({ error }, 'Error in force match all')
    res.status(500).json({ error: 'Failed to force match users' })
  }
})

/**
 * POST /api/admin/blind-dating/test-continuous-matcher
 * Test the continuous blind matching service
 */
router.post('/test-continuous-matcher', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    logger.info({ adminId: req.user!.id }, '🧪 Admin testing continuous blind matcher')
    
    // Import and run one matching cycle
    const { runMatchingCycle } = await import('../workers/continuous-blind-matching.js')
    const result = await runMatchingCycle()
    
    res.json({
      success: true,
      message: 'Continuous matcher test completed',
      result,
      note: 'This ran one matching cycle. The actual service runs every 4-5 hours automatically.'
    })
  } catch (error) {
    logger.error({ error, adminId: req.user!.id }, 'Error testing continuous matcher')
    res.status(500).json({ 
      error: 'Failed to test continuous matcher',
      details: error instanceof Error ? error.message : 'Unknown error'
    })
  }
})

/**
 * POST /api/admin/blind-dating/test-reminder-service
 * Test the inactive blind date reminder service
 */
router.post('/test-reminder-service', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    logger.info({ adminId: req.user!.id }, '🧪 Admin testing reminder service')
    
    // Import and run one check cycle
    const { checkInactiveMatches } = await import('../workers/inactive-blind-date-reminder.js')
    await checkInactiveMatches()
    
    res.json({
      success: true,
      message: 'Reminder service test completed',
      note: 'This checked for inactive matches and sent reminders. The actual service runs every 6 hours automatically.'
    })
  } catch (error) {
    logger.error({ error, adminId: req.user!.id }, 'Error testing reminder service')
    res.status(500).json({ 
      error: 'Failed to test reminder service',
      details: error instanceof Error ? error.message : 'Unknown error'
    })
  }
})

/**
 * POST /api/admin/blind-dating/create-match
 * Create a blind date match between two specific users
 * Validates: opposite genders, not already friends, no existing active match
 */
router.post('/create-match', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { userAId, userBId } = req.body
    
    if (!userAId || !userBId) {
      return res.status(400).json({ error: 'Both userAId and userBId are required' })
    }
    
    if (userAId === userBId) {
      return res.status(400).json({ error: 'Cannot create a match between the same user' })
    }
    
    logger.info({ adminId: req.user!.id, userAId, userBId }, '🎯 Admin creating specific blind date match')
    
    const result = await BlindDatingService.adminCreateMatch(userAId, userBId)
    
    if (!result.success) {
      return res.status(400).json({ 
        success: false, 
        error: result.error 
      })
    }
    
    res.json({
      success: true,
      message: 'Blind date match created successfully',
      match: result.match
    })
  } catch (error) {
    logger.error({ error }, 'Error creating specific blind date match')
    res.status(500).json({ error: 'Failed to create blind date match' })
  }
})

/**
 * POST /api/admin/blind-dating/run-detailed-matching
 * Run detailed matching with comprehensive logging
 * Returns detailed information about why each user was matched or not
 */
router.post('/run-detailed-matching', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    logger.info({ adminId: req.user!.id }, '🔍 Admin triggered detailed matching for all users')
    const result = await BlindDatingService.runDetailedMatchingForAll()
    
    // Store the result in the database for history (optional - table doesn't exist in this schema)
    try {
      await db.execute(sql`
        insert into blind_date_matching_logs (admin_id, summary, results_count, matched_count, created_at)
        values (${req.user!.id}::uuid, ${JSON.stringify(result.summary)}::jsonb, ${result.results.length}, ${result.summary.matched}, ${new Date().toISOString()})
      `)
    } catch (err) {
      // Table might not exist, that's OK
      logger.warn({ error: err }, 'Could not save matching log to database')
    }
    
    res.json({
      success: true,
      message: `Processed ${result.summary.totalUsers} users: ${result.summary.matched} matched, ${result.summary.noMatch} no match, ${result.summary.skipped} skipped`,
      ...result
    })
  } catch (error) {
    logger.error({ error }, 'Error in detailed matching')
    res.status(500).json({ error: 'Failed to run detailed matching' })
  }
})

/**
 * GET /api/admin/blind-dating/matching-history
 * Get history of matching runs
 */
router.get('/matching-history', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    let history: any[] = []
    try {
      const result: any = await db.execute(sql`
        select l.*, p.id as admin_profile_id, p.first_name as admin_first_name, p.last_name as admin_last_name, p.email as admin_email
        from blind_date_matching_logs l
        left join profiles p on p.id = l.admin_id
        order by l.created_at desc
        limit 50
      `)
      history = result.rows.map((r: any) => ({
        ...r,
        admin: r.admin_profile_id ? { id: r.admin_profile_id, first_name: r.admin_first_name, last_name: r.admin_last_name, email: r.admin_email } : null,
      }))
    } catch (error) {
      // Table might not exist
      logger.warn({ error }, 'Could not fetch matching history')
      return res.json({ history: [] })
    }

    res.json({ history })
  } catch (error) {
    logger.error({ error }, 'Error getting matching history')
    res.status(500).json({ error: 'Failed to get matching history' })
  }
})

/**
 * POST /api/admin/blind-dating/process-daily
 * Manually trigger daily matching process
 */
router.post('/process-daily', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    logger.info({ adminId: req.user!.id }, 'Admin triggered daily matching process')
    const result = await BlindDatingService.processDailyMatches()
    
    res.json({
      success: true,
      message: `Processed ${result.processed} users, created ${result.matched} matches`,
      ...result
    })
  } catch (error) {
    logger.error({ error }, 'Error processing daily matches')
    res.status(500).json({ error: 'Failed to process daily matches' })
  }
})

/**
 * PUT /api/admin/blind-dating/user/:userId/settings
 * Update user's blind dating settings
 */
router.put('/user/:userId/settings', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { userId } = req.params
    const { is_enabled, max_active_matches, auto_match } = req.body
    
    const [row] = await db.insert(blindDatingSettings).values({
      userId,
      isEnabled: is_enabled,
      maxActiveMatches: max_active_matches,
      autoMatch: auto_match,
      updatedAt: new Date().toISOString()
    }).onConflictDoUpdate({
      target: blindDatingSettings.userId,
      set: {
        isEnabled: is_enabled,
        maxActiveMatches: max_active_matches,
        autoMatch: auto_match,
        updatedAt: new Date().toISOString()
      },
    }).returning()

    logger.info({ userId, adminId: req.user!.id, settings: req.body }, 'Admin updated user blind dating settings')

    res.json({
      success: true,
      settings: {
        id: row.id,
        user_id: row.userId,
        is_enabled: row.isEnabled,
        daily_match_time: row.dailyMatchTime,
        max_active_matches: row.maxActiveMatches,
        preferred_reveal_threshold: row.preferredRevealThreshold,
        auto_match: row.autoMatch,
        notifications_enabled: row.notificationsEnabled,
        last_match_at: row.lastMatchAt,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
      }
    })
  } catch (error) {
    logger.error({ error }, 'Error updating user settings')
    res.status(500).json({ error: 'Failed to update settings' })
  }
})

/**
 * DELETE /api/admin/blind-dating/match/:matchId
 * End a blind date match (admin action)
 */
router.delete('/match/:matchId', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { matchId } = req.params
    const { reason } = req.body
    
    await db.update(blindDateMatches).set({
      status: 'ended',
      endedAt: new Date().toISOString(),
      endReason: reason || 'admin_ended',
      updatedAt: new Date().toISOString()
    }).where(eq(blindDateMatches.id, matchId))

    logger.info({ matchId, adminId: req.user!.id, reason }, 'Admin ended blind date match')
    
    res.json({ success: true, message: 'Match ended' })
  } catch (error) {
    logger.error({ error }, 'Error ending match')
    res.status(500).json({ error: 'Failed to end match' })
  }
})

/**
 * GET /api/admin/blind-dating/daily-queue
 * Get daily queue status
 */
router.get('/daily-queue', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { date } = req.query
    const targetDate = date ? new Date(date as string) : new Date()
    const dateStr = targetDate.toISOString().split('T')[0]
    
    const queueUserProfiles = alias(profiles, 'queue_user_profiles')
    const queueMatchedUserProfiles = alias(profiles, 'queue_matched_user_profiles')

    const queueRows = await db.select({
      id: blindDateDailyQueue.id,
      user_id: blindDateDailyQueue.userId,
      scheduled_date: blindDateDailyQueue.scheduledDate,
      matched_user_id: blindDateDailyQueue.matchedUserId,
      match_id: blindDateDailyQueue.matchId,
      status: blindDateDailyQueue.status,
      processed_at: blindDateDailyQueue.processedAt,
      error_message: blindDateDailyQueue.errorMessage,
      created_at: blindDateDailyQueue.createdAt,
      user_id_ref: queueUserProfiles.id,
      user_first_name: queueUserProfiles.firstName,
      user_last_name: queueUserProfiles.lastName,
      user_email: queueUserProfiles.email,
      user_username: queueUserProfiles.username,
      matched_user_id_ref: queueMatchedUserProfiles.id,
      matched_user_first_name: queueMatchedUserProfiles.firstName,
      matched_user_last_name: queueMatchedUserProfiles.lastName,
      matched_user_email: queueMatchedUserProfiles.email,
      matched_user_username: queueMatchedUserProfiles.username,
    })
      .from(blindDateDailyQueue)
      .leftJoin(queueUserProfiles, eq(queueUserProfiles.id, blindDateDailyQueue.userId))
      .leftJoin(queueMatchedUserProfiles, eq(queueMatchedUserProfiles.id, blindDateDailyQueue.matchedUserId))
      .where(eq(blindDateDailyQueue.scheduledDate, dateStr))
      .orderBy(desc(blindDateDailyQueue.processedAt))

    const queue = queueRows.map(r => ({
      id: r.id,
      user_id: r.user_id,
      scheduled_date: r.scheduled_date,
      matched_user_id: r.matched_user_id,
      match_id: r.match_id,
      status: r.status,
      processed_at: r.processed_at,
      error_message: r.error_message,
      created_at: r.created_at,
      user: r.user_id_ref ? { id: r.user_id_ref, first_name: r.user_first_name, last_name: r.user_last_name, email: r.user_email, username: r.user_username } : null,
      matched_user: r.matched_user_id_ref ? { id: r.matched_user_id_ref, first_name: r.matched_user_first_name, last_name: r.matched_user_last_name, email: r.matched_user_email, username: r.matched_user_username } : null,
    }))

    // Calculate summary
    const summary = {
      total: queue.length,
      pending: queue.filter(q => q.status === 'pending').length,
      matched: queue.filter(q => q.status === 'matched').length,
      noMatch: queue.filter(q => q.status === 'no_match').length,
      errors: queue.filter(q => q.status === 'error').length
    }

    res.json({
      date: dateStr,
      summary,
      queue
    })
  } catch (error) {
    logger.error({ error }, 'Error getting daily queue')
    res.status(500).json({ error: 'Failed to get daily queue' })
  }
})

/**
 * POST /api/admin/blind-dating/reset-all-matches
 * Reset/remove all blind date matches (DANGEROUS OPERATION)
 * This will delete all blind date data INCLUDING the associated chats
 */
router.post('/reset-all-matches', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { confirm } = req.body
    
    if (confirm !== 'RESET_ALL_BLIND_DATES') {
      return res.status(400).json({ 
        error: 'Confirmation required. Send { "confirm": "RESET_ALL_BLIND_DATES" } to proceed.' 
      })
    }
    
    logger.warn({ adminId: req.user!.id }, '🚨 ADMIN INITIATED RESET OF ALL BLIND DATE MATCHES')
    
    // Get counts before deletion
    const [{ count: totalMatches }] = await db.select({ count: sql<number>`count(*)::int` }).from(blindDateMatches)

    let totalMessages = 0
    try {
      const r: any = await db.execute(sql`select count(*)::int as count from blind_date_messages`)
      totalMessages = r.rows[0]?.count ?? 0
    } catch {
      // Table doesn't exist in this schema, that's OK
    }

    const [{ count: totalBlockedMessages }] = await db.select({ count: sql<number>`count(*)::int` }).from(blindDateBlockedMessages)
    const [{ count: totalQueue }] = await db.select({ count: sql<number>`count(*)::int` }).from(blindDateDailyQueue)

    // Get all chat IDs associated with blind date matches BEFORE deleting matches
    const matchesWithChat = await db.select({ chatId: blindDateMatches.chatId }).from(blindDateMatches).where(isNotNull(blindDateMatches.chatId))

    const chatIds = matchesWithChat.map(m => m.chatId).filter((id): id is string => !!id)
    logger.info({ chatCount: chatIds.length }, 'Found blind date chats to delete')

    // Delete all related data (in correct order to avoid foreign key constraints)

    // 1. Delete blocked messages first
    try {
      await db.delete(blindDateBlockedMessages)
    } catch (blockedError) {
      logger.error({ error: blockedError }, 'Error deleting blocked messages')
    }

    // 2. Delete blind date messages (table doesn't exist in this schema)
    try {
      await db.execute(sql`delete from blind_date_messages`)
    } catch (messagesError) {
      logger.error({ error: messagesError }, 'Error deleting blind date messages')
    }

    // 3. Delete blind date matches
    try {
      await db.delete(blindDateMatches)
    } catch (matchesError) {
      logger.error({ error: matchesError }, 'Error deleting matches')
    }

    // 4. Delete daily queue
    try {
      await db.delete(blindDateDailyQueue)
    } catch (queueError) {
      logger.error({ error: queueError }, 'Error deleting daily queue')
    }

    // 5. Delete chat messages for blind date chats
    let deletedChatMessages = 0
    if (chatIds.length > 0) {
      try {
        const result = await db.delete(messages).where(inArray(messages.chatId, chatIds))
        deletedChatMessages = result.rowCount ?? 0
        logger.info({ deletedChatMessages }, 'Deleted chat messages for blind date chats')
      } catch (chatMessagesError) {
        logger.error({ error: chatMessagesError }, 'Error deleting chat messages')
      }
    }

    // 6. Delete chat members for blind date chats
    let deletedChatMembers = 0
    if (chatIds.length > 0) {
      try {
        const result = await db.delete(chatMembers).where(inArray(chatMembers.chatId, chatIds))
        deletedChatMembers = result.rowCount ?? 0
        logger.info({ deletedChatMembers }, 'Deleted chat members for blind date chats')
      } catch (chatMembersError) {
        logger.error({ error: chatMembersError }, 'Error deleting chat members')
      }
    }

    // 7. Delete the chats themselves
    let deletedChats = 0
    if (chatIds.length > 0) {
      try {
        const result = await db.delete(chats).where(inArray(chats.id, chatIds))
        deletedChats = result.rowCount ?? 0
        logger.info({ deletedChats }, 'Deleted blind date chats')
      } catch (chatsError) {
        logger.error({ error: chatsError }, 'Error deleting chats')
      }
    }

    // 8. Reset user settings (keep them enabled but reset last_match_at)
    try {
      await db.update(blindDatingSettings).set({
        lastMatchAt: null,
        updatedAt: new Date().toISOString()
      })
    } catch (settingsError) {
      logger.error({ error: settingsError }, 'Error updating settings')
    }

    const result = {
      success: true,
      message: 'All blind date data has been completely reset including chats',
      deletedCounts: {
        matches: totalMatches,
        blindDateMessages: totalMessages,
        blockedMessages: totalBlockedMessages,
        queueEntries: totalQueue,
        chats: deletedChats,
        chatMessages: deletedChatMessages,
        chatMembers: deletedChatMembers
      },
      timestamp: new Date().toISOString(),
      adminId: req.user!.id
    }
    
    logger.warn(result, '✅ BLIND DATE RESET COMPLETED - ALL DATA REMOVED')
    
    res.json(result)
  } catch (error) {
    logger.error({ error, adminId: req.user!.id }, 'Error resetting blind date matches')
    res.status(500).json({ error: 'Failed to reset blind date matches' })
  }
})

/**
 * POST /api/admin/blind-dating/end-all-active-matches
 * End all currently active matches (less destructive than full reset)
 */
router.post('/end-all-active-matches', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { reason = 'admin_bulk_end' } = req.body
    
    logger.info({ adminId: req.user!.id }, 'Admin ending all active blind date matches')
    
    // Get count of active matches
    const [{ count: activeCount }] = await db.select({ count: sql<number>`count(*)::int` }).from(blindDateMatches)
      .where(inArray(blindDateMatches.status, ['active', 'revealed']))

    // End all active and revealed matches
    await db.update(blindDateMatches).set({
      status: 'ended',
      endedAt: new Date().toISOString(),
      endReason: reason,
      updatedAt: new Date().toISOString()
    }).where(inArray(blindDateMatches.status, ['active', 'revealed']))

    logger.info({
      adminId: req.user!.id,
      endedCount: activeCount,
      reason
    }, 'Admin ended all active matches')

    res.json({
      success: true,
      message: `Ended ${activeCount} active matches`,
      endedCount: activeCount,
      reason
    })
  } catch (error) {
    logger.error({ error }, 'Error ending all active matches')
    res.status(500).json({ error: 'Failed to end active matches' })
  }
})

export default router
