import { Router } from 'express'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { BlindDatingService } from '../services/blind-dating.service.js'
import { ContentFilterService } from '../services/ai/content-filter.service.js'
import { supabase } from '../config/supabase.js'
import { logger } from '../config/logger.js'

const router = Router()

/**
 * GET /api/blind-dating/settings
 * Get current user's blind dating settings
 */
router.get('/settings', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    let settings = await BlindDatingService.getSettings(userId)
    
    // Return default settings if none exist
    if (!settings) {
      settings = {
        id: '',
        user_id: userId,
        is_enabled: false,
        daily_match_time: '09:00:00',
        max_active_matches: 3,
        preferred_reveal_threshold: 30,
        auto_match: true,
        notifications_enabled: true
      }
    }
    
    res.json({ settings })
  } catch (error) {
    logger.error({ error, userId: req.user!.id }, 'Error getting blind dating settings')
    res.status(500).json({ error: 'Failed to get settings' })
  }
})

/**
 * PUT /api/blind-dating/settings
 * Update blind dating settings
 */
router.put('/settings', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    const {
      is_enabled,
      daily_match_time,
      max_active_matches,
      preferred_reveal_threshold,
      auto_match,
      notifications_enabled
    } = req.body

    const settings = await BlindDatingService.updateSettings(userId, {
      is_enabled,
      daily_match_time,
      max_active_matches: Math.min(Math.max(max_active_matches || 3, 1), 5), // Limit 1-5
      preferred_reveal_threshold: Math.min(Math.max(preferred_reveal_threshold || 30, 10), 100), // Limit 10-100
      auto_match,
      notifications_enabled
    })

    res.json({ settings })
  } catch (error) {
    logger.error({ error, userId: req.user!.id }, 'Error updating blind dating settings')
    res.status(500).json({ error: 'Failed to update settings' })
  }
})

/**
 * POST /api/blind-dating/enable
 * Enable blind dating for the user
 */
router.post('/enable', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    const settings = await BlindDatingService.enableBlindDating(userId)
    res.json({ 
      success: true, 
      message: 'Blind dating enabled! We\'ll find you a match.',
      settings 
    })
  } catch (error) {
    logger.error({ error, userId: req.user!.id }, 'Error enabling blind dating')
    res.status(500).json({ error: 'Failed to enable blind dating' })
  }
})

/**
 * POST /api/blind-dating/disable
 * Disable blind dating for the user
 */
router.post('/disable', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    const settings = await BlindDatingService.disableBlindDating(userId)
    res.json({ 
      success: true, 
      message: 'Blind dating disabled.',
      settings 
    })
  } catch (error) {
    logger.error({ error, userId: req.user!.id }, 'Error disabling blind dating')
    res.status(500).json({ error: 'Failed to disable blind dating' })
  }
})

/**
 * GET /api/blind-dating/matches
 * Get all active blind date matches for the user
 */
router.get('/matches', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    const matches = await BlindDatingService.getActiveMatches(userId)
    
    // Enrich with anonymized profiles
    const enrichedMatches = await Promise.all(
      matches.map(async (match) => {
        const isUserA = match.user_a === userId
        const otherUserId = isUserA ? match.user_b : match.user_a
        const isRevealed = match.status === 'revealed' || 
                          (isUserA ? match.user_b_revealed : match.user_a_revealed)
        
        const otherUserProfile = await BlindDatingService.getAnonymizedProfile(otherUserId, isRevealed)
        const canReveal = BlindDatingService.isRevealAvailable(match)
        const messagesUntilReveal = Math.max(0, match.reveal_threshold - match.message_count)
        
        return {
          ...match,
          otherUser: otherUserProfile,
          canReveal,
          messagesUntilReveal,
          hasRevealedSelf: isUserA ? match.user_a_revealed : match.user_b_revealed,
          otherHasRevealed: isUserA ? match.user_b_revealed : match.user_a_revealed
        }
      })
    )
    
    res.json({ matches: enrichedMatches })
  } catch (error) {
    logger.error({ error, userId: req.user!.id }, 'Error getting blind date matches')
    res.status(500).json({ error: 'Failed to get matches' })
  }
})

/**
 * GET /api/blind-dating/match/:matchId
 * Get a specific blind date match
 */
router.get('/match/:matchId', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    const { matchId } = req.params
    
    const match = await BlindDatingService.getMatchById(matchId)
    
    if (!match) {
      return res.status(404).json({ error: 'Match not found' })
    }
    
    if (match.user_a !== userId && match.user_b !== userId) {
      return res.status(403).json({ error: 'Not authorized to view this match' })
    }
    
    const isUserA = match.user_a === userId
    const otherUserId = isUserA ? match.user_b : match.user_a
    const isRevealed = match.status === 'revealed' || 
                      (isUserA ? match.user_b_revealed : match.user_a_revealed)
    
    const otherUserProfile = await BlindDatingService.getAnonymizedProfile(otherUserId, isRevealed)
    
    res.json({
      match,
      otherUser: otherUserProfile,
      canReveal: BlindDatingService.isRevealAvailable(match),
      messagesUntilReveal: Math.max(0, match.reveal_threshold - match.message_count),
      hasRevealedSelf: isUserA ? match.user_a_revealed : match.user_b_revealed,
      otherHasRevealed: isUserA ? match.user_b_revealed : match.user_a_revealed
    })
  } catch (error) {
    logger.error({ error, userId: req.user!.id, matchId: req.params.matchId }, 'Error getting blind date match')
    res.status(500).json({ error: 'Failed to get match' })
  }
})

/**
 * POST /api/blind-dating/find-match
 * Manually trigger finding a new match
 */
router.post('/find-match', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    
    // Check settings
    const settings = await BlindDatingService.getSettings(userId)
    if (!settings?.is_enabled) {
      return res.status(400).json({ error: 'Enable blind dating first in your settings' })
    }
    
    // Check active matches
    const activeMatches = await BlindDatingService.getActiveMatches(userId)
    if (activeMatches.length >= settings.max_active_matches) {
      return res.status(400).json({ 
        error: 'You have reached your maximum active blind dates',
        activeMatches: activeMatches.length,
        maxMatches: settings.max_active_matches
      })
    }
    
    const match = await BlindDatingService.findMatch(userId)
    
    if (!match) {
      return res.json({ 
        success: false, 
        message: 'No compatible matches found right now. Try again later!' 
      })
    }
    
    const isUserA = match.user_a === userId
    const otherUserId = isUserA ? match.user_b : match.user_a
    const otherUserProfile = await BlindDatingService.getAnonymizedProfile(otherUserId, false)
    
    res.json({
      success: true,
      message: 'New blind date match found!',
      match: {
        ...match,
        otherUser: otherUserProfile,
        canReveal: false,
        messagesUntilReveal: match.reveal_threshold
      }
    })
  } catch (error) {
    logger.error({ error, userId: req.user!.id }, 'Error finding blind date match')
    res.status(500).json({ error: 'Failed to find match' })
  }
})

/**
 * POST /api/blind-dating/reveal/:matchId
 * Request to reveal identity in a blind date
 */
router.post('/reveal/:matchId', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    const { matchId } = req.params
    
    const result = await BlindDatingService.requestReveal(matchId, userId)
    
    if (!result.success) {
      return res.status(400).json({ error: result.message })
    }
    
    res.json(result)
  } catch (error) {
    logger.error({ error, userId: req.user!.id, matchId: req.params.matchId }, 'Error revealing identity')
    res.status(500).json({ error: 'Failed to reveal identity' })
  }
})

/**
 * POST /api/blind-dating/end/:matchId
 * End a blind date match
 */
router.post('/end/:matchId', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    const { matchId } = req.params
    const { reason } = req.body
    
    const success = await BlindDatingService.endMatch(matchId, userId, reason)
    
    if (!success) {
      return res.status(400).json({ error: 'Failed to end match' })
    }
    
    res.json({ success: true, message: 'Blind date ended' })
  } catch (error) {
    logger.error({ error, userId: req.user!.id, matchId: req.params.matchId }, 'Error ending blind date')
    res.status(500).json({ error: 'Failed to end blind date' })
  }
})

/**
 * GET /api/blind-dating/chat/:chatId/status
 * Get blind date status for a chat
 */
router.get('/chat/:chatId/status', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    const { chatId } = req.params
    
    const status = await BlindDatingService.getChatBlindDateStatus(chatId, userId)
    
    res.json(status || { isBlindDate: false })
  } catch (error) {
    logger.error({ error, userId: req.user!.id, chatId: req.params.chatId }, 'Error getting chat blind date status')
    res.status(500).json({ error: 'Failed to get status' })
  }
})

/**
 * POST /api/blind-dating/filter-message
 * Filter a message for personal information
 */
router.post('/filter-message', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    const { message, matchId, chatId } = req.body
    
    if (!message) {
      return res.status(400).json({ error: 'Message is required' })
    }
    
    // Get match ID from chat if not provided
    let actualMatchId = matchId
    if (!actualMatchId && chatId) {
      const match = await BlindDatingService.getMatchByChatId(chatId)
      actualMatchId = match?.id
    }
    
    if (!actualMatchId) {
      // Not a blind date chat, allow message
      return res.json({ allowed: true, originalMessage: message })
    }
    
    const result = await BlindDatingService.filterMessage(message, actualMatchId, userId)
    
    res.json(result)
  } catch (error) {
    logger.error({ error, userId: req.user!.id }, 'Error filtering message')
    res.status(500).json({ error: 'Failed to filter message' })
  }
})

/**
 * GET /api/blind-dating/blocked-messages/:matchId
 * Get blocked messages for a blind date (after reveal)
 */
router.get('/blocked-messages/:matchId', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    const { matchId } = req.params
    
    // Verify user is part of the match
    const match = await BlindDatingService.getMatchById(matchId)
    if (!match) {
      return res.status(404).json({ error: 'Match not found' })
    }
    
    if (match.user_a !== userId && match.user_b !== userId) {
      return res.status(403).json({ error: 'Not authorized' })
    }
    
    // Only show blocked messages after reveal
    if (match.status !== 'revealed') {
      return res.json({ messages: [] })
    }
    
    const { data: blockedMessages, error } = await supabase
      .from('blind_date_blocked_messages')
      .select('*')
      .eq('blind_date_id', matchId)
      .order('created_at', { ascending: true })
    
    if (error) {
      throw error
    }
    
    res.json({ messages: blockedMessages || [] })
  } catch (error) {
    logger.error({ error, userId: req.user!.id, matchId: req.params.matchId }, 'Error getting blocked messages')
    res.status(500).json({ error: 'Failed to get blocked messages' })
  }
})

/**
 * POST /api/blind-dating/test-filter
 * Test the message filter (for debugging)
 */
router.post('/test-filter', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { message } = req.body
    
    if (!message) {
      return res.status(400).json({ error: 'Message is required' })
    }
    
    // Quick check first
    const quickCheckResult = ContentFilterService.quickCheck(message)
    
    // Full analysis
    const analysis = await ContentFilterService.analyzeMessage(message)
    
    // Sanitized version
    const sanitized = ContentFilterService.sanitizeMessage(message, analysis)
    
    res.json({
      quickCheckTriggered: quickCheckResult,
      analysis,
      sanitizedMessage: sanitized,
      serviceInfo: ContentFilterService.getServiceInfo()
    })
  } catch (error) {
    logger.error({ error, userId: req.user!.id }, 'Error testing message filter')
    res.status(500).json({ error: 'Failed to test filter' })
  }
})

/**
 * POST /api/blind-dating/run-tests
 * Run comprehensive tests on the content filter
 */
router.post('/run-tests', requireAuth, async (req: AuthRequest, res) => {
  try {
    // Validate connection first
    const isConnected = await ContentFilterService.validateConnection()
    
    if (!isConnected) {
      return res.status(503).json({ 
        error: 'Together AI connection failed',
        message: 'Please check TOGETHER_AI_API_KEY environment variable'
      })
    }
    
    // Run the test suite
    const testResults = await ContentFilterService.runTests()
    
    res.json({
      success: true,
      serviceInfo: ContentFilterService.getServiceInfo(),
      summary: {
        total: testResults.passed + testResults.failed,
        passed: testResults.passed,
        failed: testResults.failed,
        passRate: `${Math.round((testResults.passed / (testResults.passed + testResults.failed)) * 100)}%`
      },
      results: testResults.results
    })
  } catch (error) {
    logger.error({ error, userId: req.user!.id }, 'Error running content filter tests')
    res.status(500).json({ error: 'Failed to run tests' })
  }
})

/**
 * GET /api/blind-dating/test-connection
 * Test Together AI connection
 */
router.get('/test-connection', requireAuth, async (req: AuthRequest, res) => {
  try {
    const isConnected = await ContentFilterService.validateConnection()
    
    res.json({
      connected: isConnected,
      serviceInfo: ContentFilterService.getServiceInfo()
    })
  } catch (error) {
    logger.error({ error }, 'Error testing Together AI connection')
    res.status(500).json({ 
      connected: false,
      error: 'Failed to test connection'
    })
  }
})

/**
 * GET /api/blind-dating/stats
 * Get blind dating statistics for the user
 */
router.get('/stats', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    
    // Get total matches
    const { data: allMatches, error: matchError } = await supabase
      .from('blind_date_matches')
      .select('id, status, revealed_at')
      .or(`user_a.eq.${userId},user_b.eq.${userId}`)
    
    if (matchError) throw matchError
    
    const stats = {
      totalMatches: allMatches?.length || 0,
      activeMatches: allMatches?.filter(m => m.status === 'active').length || 0,
      revealedMatches: allMatches?.filter(m => m.status === 'revealed').length || 0,
      endedMatches: allMatches?.filter(m => m.status === 'ended').length || 0,
      successRate: 0
    }
    
    // Calculate success rate (revealed / total ended or revealed)
    const completedMatches = stats.revealedMatches + stats.endedMatches
    if (completedMatches > 0) {
      stats.successRate = Math.round((stats.revealedMatches / completedMatches) * 100)
    }
    
    res.json({ stats })
  } catch (error) {
    logger.error({ error, userId: req.user!.id }, 'Error getting blind dating stats')
    res.status(500).json({ error: 'Failed to get stats' })
  }
})

/**
 * Admin endpoint: Process daily matches (should be called by cron job)
 */
router.post('/admin/process-daily-matches', async (req, res) => {
  try {
    // Verify admin API key
    const apiKey = req.headers['x-admin-api-key']
    if (apiKey !== process.env.ADMIN_API_KEY) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
    
    const result = await BlindDatingService.processDailyMatches()
    
    res.json({
      success: true,
      ...result
    })
  } catch (error) {
    logger.error({ error }, 'Error processing daily matches')
    res.status(500).json({ error: 'Failed to process daily matches' })
  }
})

/**
 * Admin endpoint: Force match all eligible users
 * POST /api/blind-dating/admin/force-match-all
 */
router.post('/admin/force-match-all', async (req, res) => {
  try {
    // Verify admin API key
    const apiKey = req.headers['x-admin-api-key']
    if (apiKey !== process.env.ADMIN_API_KEY) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
    
    logger.info('🚀 Admin triggered force match all users')
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
 * Admin endpoint: Get blind dating diagnostics
 * GET /api/blind-dating/admin/diagnostics
 */
router.get('/admin/diagnostics', async (req, res) => {
  try {
    // Verify admin API key
    const apiKey = req.headers['x-admin-api-key']
    if (apiKey !== process.env.ADMIN_API_KEY) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
    
    const diagnostics = await BlindDatingService.getDiagnostics()
    
    res.json({
      success: true,
      diagnostics,
      recommendations: getRecommendations(diagnostics)
    })
  } catch (error) {
    logger.error({ error }, 'Error getting diagnostics')
    res.status(500).json({ error: 'Failed to get diagnostics' })
  }
})

// Helper to provide recommendations based on diagnostics
function getRecommendations(diagnostics: any): string[] {
  const recommendations: string[] = []
  
  if (diagnostics.usersWithBlindDatingEnabled === 0) {
    recommendations.push('❌ No users have blind dating enabled. Users need to enable it in settings.')
  } else if (diagnostics.usersWithBlindDatingEnabled < 2) {
    recommendations.push('⚠️ Only 1 user has blind dating enabled. Need at least 2 users for matching.')
  }
  
  if (diagnostics.eligibleForNewMatches === 0 && diagnostics.usersWithBlindDatingEnabled > 0) {
    recommendations.push('⚠️ All enabled users are at max matches. They need to end some matches first.')
  }
  
  if (diagnostics.usersWithAutoMatch < diagnostics.usersWithBlindDatingEnabled) {
    recommendations.push(`ℹ️ ${diagnostics.usersWithBlindDatingEnabled - diagnostics.usersWithAutoMatch} users have auto-match disabled.`)
  }
  
  if (diagnostics.eligibleForNewMatches >= 2) {
    recommendations.push('✅ System is ready for matching. Run force-match-all to create matches now.')
  }
  
  return recommendations
}

// ============================================================
// TEST ENDPOINTS FOR DEVELOPMENT
// ============================================================

/**
 * POST /api/blind-dating/test/create-test-match
 * Create a test match with an AI bot for testing the full blind dating flow
 */
router.post('/test/create-test-match', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    
    // First enable blind dating if not enabled
    let settings = await BlindDatingService.getSettings(userId)
    if (!settings?.is_enabled) {
      try {
        settings = await BlindDatingService.enableBlindDating(userId)
      } catch (error) {
        logger.error({ error, userId }, 'Failed to enable blind dating')
        return res.status(500).json({ 
          error: 'Failed to enable blind dating',
          details: error instanceof Error ? error.message : 'Unknown error'
        })
      }
    }
    
    // Check if user already has a test match with the bot
    const { data: existingMatches } = await supabase
      .from('blind_date_matches')
      .select('id, status, chat_id')
      .or(`user_a.eq.${userId},user_b.eq.${userId}`)
      .in('status', ['active', 'revealed'])
    
    // Check if there's already a match with the test bot
    const testBotEmail = 'blind_dating_test_bot@circle.internal'
    const { data: testBot } = await supabase
      .from('profiles')
      .select('id')
      .eq('email', testBotEmail)
      .maybeSingle()
    
    if (testBot && existingMatches) {
      const existingTestMatch = existingMatches.find(m => {
        // We need to check if the other user is the test bot
        // This is a simplified check - in production you'd verify both users
        return true // For now, allow multiple test matches
      })
      
      if (existingTestMatch && existingTestMatch.status === 'active') {
        // Return existing match
        const botProfile = await BlindDatingService.getAnonymizedProfile(testBot.id, false)
        return res.json({
          success: true,
          message: '✅ You already have an active test match!',
          match: existingTestMatch,
          botUser: botProfile,
          chatId: existingTestMatch.chat_id,
          instructions: {
            step1: 'Go to the chat and start messaging',
            step2: 'Try sending personal info - it will be blocked!',
            step3: 'The AI bot will respond to your messages',
            step4: 'After 30 messages, you can reveal identities',
            step5: 'Test Hindi messages too: "Mera naam XYZ hai"'
          }
        })
      }
    }
    
    // Create a test match with an AI bot
    const testMatch = await BlindDatingService.createTestMatch(userId)
    
    if (!testMatch) {
      logger.error({ userId }, 'createTestMatch returned null')
      return res.status(500).json({ 
        error: 'Failed to create test match',
        reason: 'Could not create test bot user or match. Check server logs for details.'
      })
    }
    
    // Get anonymized profile of the bot
    let botProfile
    try {
      botProfile = await BlindDatingService.getAnonymizedProfile(testMatch.botUserId, false)
    } catch (error) {
      logger.error({ error, botUserId: testMatch.botUserId }, 'Failed to get bot profile')
      // Continue anyway - match is created
      botProfile = {
        id: testMatch.botUserId,
        first_name: 'Mystery',
        last_name: 'Match',
        username: 'mystery_match_bot',
        is_revealed: false
      }
    }
    
    res.json({
      success: true,
      message: '🤖 Test match created with AI bot! You can now chat anonymously.',
      match: testMatch.match,
      botUser: botProfile,
      chatId: testMatch.match.chat_id,
      instructions: {
        step1: 'Go to the chat and start messaging',
        step2: 'Try sending personal info - it will be blocked!',
        step3: 'The AI bot will respond to your messages',
        step4: `After ${testMatch.match.reveal_threshold} messages, you can reveal identities`,
        step5: 'Test Hindi messages too: "Mera naam XYZ hai"'
      }
    })
  } catch (error) {
    logger.error({ 
      error, 
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
      errorStack: error instanceof Error ? error.stack : undefined,
      userId: req.user!.id 
    }, 'Error creating test match')
    res.status(500).json({ 
      error: 'Failed to create test match',
      details: error instanceof Error ? error.message : 'Unknown error',
      hint: 'Check server logs for more details'
    })
  }
})

/**
 * POST /api/blind-dating/test/ai-chat
 * Get AI response for testing blind date chat
 */
router.post('/test/ai-chat', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { message, matchId, chatId, personality } = req.body
    
    if (!message) {
      return res.status(400).json({ error: 'Message is required' })
    }
    
    // Get AI response simulating a blind date chat partner
    const response = await BlindDatingService.getTestAIResponse(message, {
      matchId,
      chatId,
      personality: personality || 'friendly_indian'
    })
    
    res.json({
      success: true,
      response: response.message,
      filtered: response.wasFiltered,
      blockedInfo: response.blockedInfo,
      personality: response.personality
    })
  } catch (error) {
    logger.error({ error, userId: req.user!.id }, 'Error getting AI chat response')
    res.status(500).json({ error: 'Failed to get AI response' })
  }
})

/**
 * GET /api/blind-dating/test/debug-eligibility
 * Debug why no matches are found
 */
router.get('/test/debug-eligibility', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    
    // Get user's settings
    const settings = await BlindDatingService.getSettings(userId)
    
    // Get all users with blind dating enabled
    const { data: enabledUsers, error: enabledError } = await supabase
      .from('blind_dating_settings')
      .select('user_id, is_enabled, max_active_matches')
      .eq('is_enabled', true)
    
    // Get total users
    const { count: totalUsers } = await supabase
      .from('profiles')
      .select('*', { count: 'exact', head: true })
      .is('deleted_at', null)
    
    // Get user's active matches
    const activeMatches = settings?.is_enabled ? await BlindDatingService.getActiveMatches(userId) : []
    
    // Get users that the current user has already matched with (active only)
    const { data: activeMatchRecords } = await supabase
      .from('blind_date_matches')
      .select('user_a, user_b')
      .or(`user_a.eq.${userId},user_b.eq.${userId}`)
      .in('status', ['active', 'revealed'])
    
    const activeMatchedUserIds = new Set(
      (activeMatchRecords || []).flatMap(m => [m.user_a, m.user_b]).filter(id => id !== userId)
    )
    
    // Get all past matches (including ended)
    const { data: allPastMatches } = await supabase
      .from('blind_date_matches')
      .select('user_a, user_b, status')
      .or(`user_a.eq.${userId},user_b.eq.${userId}`)
    
    // Calculate eligible users (enabled, not already in active match with user)
    const eligibleUserIds = (enabledUsers || [])
      .map(u => u.user_id)
      .filter(id => id !== userId && !activeMatchedUserIds.has(id))
    
    res.json({
      debug: {
        yourUserId: userId,
        yourSettings: {
          blindDatingEnabled: settings?.is_enabled || false,
          maxActiveMatches: settings?.max_active_matches || 3,
          revealThreshold: settings?.preferred_reveal_threshold || 30,
          autoMatch: settings?.auto_match ?? true
        },
        eligibility: {
          totalUsersInApp: totalUsers || 0,
          usersWithBlindDatingEnabled: (enabledUsers || []).length,
          usersEligibleForYou: eligibleUserIds.length,
          eligibleUserIds: eligibleUserIds,
          usersInActiveMatchWithYou: Array.from(activeMatchedUserIds),
          yourCurrentActiveMatches: activeMatches.length,
          totalPastMatches: (allPastMatches || []).length
        },
        reason: getNoMatchReason({
          isEnabled: settings?.is_enabled,
          enabledUsersCount: eligibleUserIds.length,
          activeMatchesCount: activeMatches.length,
          maxActive: settings?.max_active_matches || 3
        }),
        nextSteps: getNextSteps({
          isEnabled: settings?.is_enabled,
          eligibleCount: eligibleUserIds.length,
          activeMatchesCount: activeMatches.length,
          maxActive: settings?.max_active_matches || 3
        })
      }
    })
  } catch (error) {
    logger.error({ error, userId: req.user!.id }, 'Error debugging eligibility')
    res.status(500).json({ error: 'Failed to debug' })
  }
})

/**
 * POST /api/blind-dating/test/enable-for-all
 * Enable blind dating for all users (admin/testing)
 */
router.post('/test/enable-for-all', async (req, res) => {
  try {
    // Verify admin API key
    const apiKey = req.headers['x-admin-api-key']
    if (apiKey !== process.env.ADMIN_API_KEY) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
    
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

// Helper to determine reason for no matches
function getNoMatchReason(info: { isEnabled?: boolean; enabledUsersCount: number; activeMatchesCount: number; maxActive: number }): string {
  if (!info.isEnabled) {
    return '❌ Your blind dating is NOT enabled. Enable it first!'
  }
  if (info.activeMatchesCount >= info.maxActive) {
    return `❌ You've reached max active matches (${info.activeMatchesCount}/${info.maxActive})`
  }
  if (info.enabledUsersCount === 0) {
    return '❌ No other eligible users found. Use "Create Test Match" to test with AI bot!'
  }
  return '✅ You should be eligible for matches'
}

// Helper to provide next steps for user
function getNextSteps(info: { isEnabled?: boolean; eligibleCount: number; activeMatchesCount: number; maxActive: number }): string[] {
  const steps: string[] = []
  
  if (!info.isEnabled) {
    steps.push('1. Enable blind dating in your settings')
    steps.push('2. Wait for matches or tap "Find Match"')
  } else if (info.activeMatchesCount >= info.maxActive) {
    steps.push('1. End some of your current blind dates to get new matches')
    steps.push('2. Or increase your max active matches in settings')
  } else if (info.eligibleCount === 0) {
    steps.push('1. Try "Create Test Match" to test with AI bot')
    steps.push('2. Wait for more users to enable blind dating')
    steps.push('3. Ask admin to run "Enable for All" to enable for all users')
  } else {
    steps.push('1. Tap "Find Match" to get matched now')
    steps.push('2. Or wait for the daily automatic matching')
  }
  
  return steps
}

export default router

