/**
 * Admin Blind Dating Routes
 * Handles admin operations for blind dating feature
 */

import express from 'express'
import { requireAuth, AuthRequest } from '../middleware/auth.js'
import { requireAdmin, AdminRequest } from '../middleware/adminAuth.js'
import { supabase } from '../config/supabase.js'
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
    const { count: totalMatches } = await supabase
      .from('blind_date_matches')
      .select('*', { count: 'exact', head: true })
    
    const { count: activeMatches } = await supabase
      .from('blind_date_matches')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'active')
    
    const { count: revealedMatches } = await supabase
      .from('blind_date_matches')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'revealed')
    
    const { count: endedMatches } = await supabase
      .from('blind_date_matches')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'ended')
    
    const { count: blockedMessages } = await supabase
      .from('blind_date_blocked_messages')
      .select('*', { count: 'exact', head: true })
    
    // Get matches created today
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const { count: matchesToday } = await supabase
      .from('blind_date_matches')
      .select('*', { count: 'exact', head: true })
      .gte('matched_at', today.toISOString())
    
    // Get matches created this week
    const weekAgo = new Date()
    weekAgo.setDate(weekAgo.getDate() - 7)
    const { count: matchesThisWeek } = await supabase
      .from('blind_date_matches')
      .select('*', { count: 'exact', head: true })
      .gte('matched_at', weekAgo.toISOString())
    
    // Calculate success rate (revealed / (revealed + ended))
    const completedMatches = (revealedMatches || 0) + (endedMatches || 0)
    const successRate = completedMatches > 0 
      ? Math.round(((revealedMatches || 0) / completedMatches) * 100) 
      : 0
    
    res.json({
      stats: {
        ...diagnostics,
        totalMatches: totalMatches || 0,
        activeMatches: activeMatches || 0,
        revealedMatches: revealedMatches || 0,
        endedMatches: endedMatches || 0,
        blockedMessages: blockedMessages || 0,
        matchesToday: matchesToday || 0,
        matchesThisWeek: matchesThisWeek || 0,
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
    
    let query = supabase
      .from('blind_dating_settings')
      .select(`
        *,
        user:profiles!blind_dating_settings_user_id_fkey (
          id,
          first_name,
          last_name,
          email,
          username,
          profile_photo_url,
          age,
          gender,
          created_at
        )
      `, { count: 'exact' })
    
    // Apply filter
    if (filter === 'enabled') {
      query = query.eq('is_enabled', true)
    } else if (filter === 'disabled') {
      query = query.eq('is_enabled', false)
    }
    
    const { data: settings, error, count } = await query
      .order('updated_at', { ascending: false })
      .range(offset, offset + limitNum - 1)
    
    if (error) {
      throw error
    }
    
    // Get active match counts for each user
    const usersWithMatchCounts = await Promise.all(
      (settings || []).map(async (setting) => {
        const { count: activeMatchCount } = await supabase
          .from('blind_date_matches')
          .select('*', { count: 'exact', head: true })
          .or(`user_a.eq.${setting.user_id},user_b.eq.${setting.user_id}`)
          .in('status', ['active', 'revealed'])
        
        const { count: totalMatchCount } = await supabase
          .from('blind_date_matches')
          .select('*', { count: 'exact', head: true })
          .or(`user_a.eq.${setting.user_id},user_b.eq.${setting.user_id}`)
        
        return {
          ...setting,
          activeMatchCount: activeMatchCount || 0,
          totalMatchCount: totalMatchCount || 0
        }
      })
    )
    
    res.json({
      users: usersWithMatchCounts,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limitNum)
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
    
    let query = supabase
      .from('blind_date_matches')
      .select(`
        *,
        user_a_profile:profiles!blind_date_matches_user_a_fkey (
          id,
          first_name,
          last_name,
          email,
          username,
          profile_photo_url
        ),
        user_b_profile:profiles!blind_date_matches_user_b_fkey (
          id,
          first_name,
          last_name,
          email,
          username,
          profile_photo_url
        )
      `, { count: 'exact' })
    
    // Apply status filter
    if (status !== 'all') {
      query = query.eq('status', status)
    }
    
    const { data: matches, error, count } = await query
      .order('matched_at', { ascending: false })
      .range(offset, offset + limitNum - 1)
    
    if (error) {
      throw error
    }
    
    res.json({
      matches,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limitNum)
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
    
    const { data: messages, error, count } = await supabase
      .from('blind_date_blocked_messages')
      .select(`
        *,
        sender:profiles!blind_date_blocked_messages_sender_id_fkey (
          id,
          first_name,
          last_name,
          email,
          username
        ),
        blind_date:blind_date_matches!blind_date_blocked_messages_blind_date_id_fkey (
          id,
          status,
          matched_at
        )
      `, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limitNum - 1)
    
    if (error) {
      throw error
    }
    
    res.json({
      messages,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limitNum)
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
    const { data: allUsers } = await supabase
      .from('profiles')
      .select('id')
      .is('deleted_at', null)
    
    let enabled = 0
    let errors = 0
    
    for (const user of (allUsers || [])) {
      try {
        await supabase
          .from('blind_dating_settings')
          .upsert({
            user_id: user.id,
            is_enabled: true,
            auto_match: true,
            max_active_matches: 3,
            preferred_reveal_threshold: 30,
            notifications_enabled: true,
            updated_at: new Date().toISOString()
          }, { onConflict: 'user_id' })
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
    
    // Store the result in the database for history (optional - table may not exist)
    try {
      await supabase
        .from('blind_date_matching_logs')
        .insert({
          admin_id: req.user!.id,
          summary: result.summary,
          results_count: result.results.length,
          matched_count: result.summary.matched,
          created_at: new Date().toISOString()
        })
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
    const { data: history, error } = await supabase
      .from('blind_date_matching_logs')
      .select(`
        *,
        admin:profiles!blind_date_matching_logs_admin_id_fkey (
          id,
          first_name,
          last_name,
          email
        )
      `)
      .order('created_at', { ascending: false })
      .limit(50)
    
    if (error) {
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
    
    const { data, error } = await supabase
      .from('blind_dating_settings')
      .upsert({
        user_id: userId,
        is_enabled,
        max_active_matches,
        auto_match,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id' })
      .select()
      .single()
    
    if (error) {
      throw error
    }
    
    logger.info({ userId, adminId: req.user!.id, settings: req.body }, 'Admin updated user blind dating settings')
    
    res.json({ success: true, settings: data })
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
    
    const { error } = await supabase
      .from('blind_date_matches')
      .update({
        status: 'ended',
        ended_at: new Date().toISOString(),
        end_reason: reason || 'admin_ended',
        updated_at: new Date().toISOString()
      })
      .eq('id', matchId)
    
    if (error) {
      throw error
    }
    
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
    
    const { data: queue, error } = await supabase
      .from('blind_date_daily_queue')
      .select(`
        *,
        user:profiles!blind_date_daily_queue_user_id_fkey (
          id,
          first_name,
          last_name,
          email,
          username
        ),
        matched_user:profiles!blind_date_daily_queue_matched_user_id_fkey (
          id,
          first_name,
          last_name,
          email,
          username
        )
      `)
      .eq('scheduled_date', dateStr)
      .order('processed_at', { ascending: false })
    
    if (error) {
      throw error
    }
    
    // Calculate summary
    const summary = {
      total: queue?.length || 0,
      pending: queue?.filter(q => q.status === 'pending').length || 0,
      matched: queue?.filter(q => q.status === 'matched').length || 0,
      noMatch: queue?.filter(q => q.status === 'no_match').length || 0,
      errors: queue?.filter(q => q.status === 'error').length || 0
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
    const { count: totalMatches } = await supabase
      .from('blind_date_matches')
      .select('*', { count: 'exact', head: true })
    
    const { count: totalMessages } = await supabase
      .from('blind_date_messages')
      .select('*', { count: 'exact', head: true })
    
    const { count: totalBlockedMessages } = await supabase
      .from('blind_date_blocked_messages')
      .select('*', { count: 'exact', head: true })
    
    const { count: totalQueue } = await supabase
      .from('blind_date_daily_queue')
      .select('*', { count: 'exact', head: true })
    
    // Get all chat IDs associated with blind date matches BEFORE deleting matches
    const { data: blindDateMatches } = await supabase
      .from('blind_date_matches')
      .select('chat_id')
      .not('chat_id', 'is', null)
    
    const chatIds = blindDateMatches?.map(m => m.chat_id).filter(Boolean) || []
    logger.info({ chatCount: chatIds.length }, 'Found blind date chats to delete')
    
    // Delete all related data (in correct order to avoid foreign key constraints)
    
    // 1. Delete blocked messages first
    const { error: blockedError } = await supabase
      .from('blind_date_blocked_messages')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000') // Delete all
    
    if (blockedError) {
      logger.error({ error: blockedError }, 'Error deleting blocked messages')
    }
    
    // 2. Delete blind date messages
    const { error: messagesError } = await supabase
      .from('blind_date_messages')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000') // Delete all
    
    if (messagesError) {
      logger.error({ error: messagesError }, 'Error deleting blind date messages')
    }
    
    // 3. Delete blind date matches
    const { error: matchesError } = await supabase
      .from('blind_date_matches')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000') // Delete all
    
    if (matchesError) {
      logger.error({ error: matchesError }, 'Error deleting matches')
    }
    
    // 4. Delete daily queue
    const { error: queueError } = await supabase
      .from('blind_date_daily_queue')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000') // Delete all
    
    if (queueError) {
      logger.error({ error: queueError }, 'Error deleting daily queue')
    }
    
    // 5. Delete chat messages for blind date chats
    let deletedChatMessages = 0
    if (chatIds.length > 0) {
      const { error: chatMessagesError, count: msgCount } = await supabase
        .from('messages')
        .delete({ count: 'exact' })
        .in('chat_id', chatIds)
      
      if (chatMessagesError) {
        logger.error({ error: chatMessagesError }, 'Error deleting chat messages')
      } else {
        deletedChatMessages = msgCount || 0
        logger.info({ deletedChatMessages }, 'Deleted chat messages for blind date chats')
      }
    }
    
    // 6. Delete chat members for blind date chats
    let deletedChatMembers = 0
    if (chatIds.length > 0) {
      const { error: chatMembersError, count: memberCount } = await supabase
        .from('chat_members')
        .delete({ count: 'exact' })
        .in('chat_id', chatIds)
      
      if (chatMembersError) {
        logger.error({ error: chatMembersError }, 'Error deleting chat members')
      } else {
        deletedChatMembers = memberCount || 0
        logger.info({ deletedChatMembers }, 'Deleted chat members for blind date chats')
      }
    }
    
    // 7. Delete the chats themselves
    let deletedChats = 0
    if (chatIds.length > 0) {
      const { error: chatsError, count: chatCount } = await supabase
        .from('chats')
        .delete({ count: 'exact' })
        .in('id', chatIds)
      
      if (chatsError) {
        logger.error({ error: chatsError }, 'Error deleting chats')
      } else {
        deletedChats = chatCount || 0
        logger.info({ deletedChats }, 'Deleted blind date chats')
      }
    }
    
    // 8. Reset user settings (keep them enabled but reset last_match_at)
    const { error: settingsError } = await supabase
      .from('blind_dating_settings')
      .update({
        last_match_at: null,
        updated_at: new Date().toISOString()
      })
      .neq('user_id', '00000000-0000-0000-0000-000000000000') // Update all
    
    if (settingsError) {
      logger.error({ error: settingsError }, 'Error updating settings')
    }
    
    const result = {
      success: true,
      message: 'All blind date data has been completely reset including chats',
      deletedCounts: {
        matches: totalMatches || 0,
        blindDateMessages: totalMessages || 0,
        blockedMessages: totalBlockedMessages || 0,
        queueEntries: totalQueue || 0,
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
    const { count: activeCount } = await supabase
      .from('blind_date_matches')
      .select('*', { count: 'exact', head: true })
      .in('status', ['active', 'revealed'])
    
    // End all active and revealed matches
    const { error } = await supabase
      .from('blind_date_matches')
      .update({
        status: 'ended',
        ended_at: new Date().toISOString(),
        end_reason: reason,
        updated_at: new Date().toISOString()
      })
      .in('status', ['active', 'revealed'])
    
    if (error) {
      throw error
    }
    
    logger.info({ 
      adminId: req.user!.id, 
      endedCount: activeCount,
      reason 
    }, 'Admin ended all active matches')
    
    res.json({
      success: true,
      message: `Ended ${activeCount || 0} active matches`,
      endedCount: activeCount || 0,
      reason
    })
  } catch (error) {
    logger.error({ error }, 'Error ending all active matches')
    res.status(500).json({ error: 'Failed to end active matches' })
  }
})

export default router
