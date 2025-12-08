import { Router } from 'express'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { PromptMatchingService } from '../services/prompt-matching.service.js'
import { supabase } from '../config/supabase.js'
import { logger } from '../config/logger.js'

const router = Router()

// Helper function to format time ago
const getTimeAgo = (date: Date): string => {
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)
  
  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m`
  if (diffHours < 24) return `${diffHours}h`
  if (diffDays < 7) return `${diffDays}d`
  return `${Math.floor(diffDays / 7)}w`
}

/**
 * POST /api/match/request
 * Create a help request from a receiver
 */
router.post('/request', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    const { prompt, role } = req.body

    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
      return res.status(400).json({ error: 'Prompt is required' })
    }

    if (role !== 'receiver') {
      return res.status(400).json({ error: 'Invalid role. Must be "receiver"' })
    }

    if (prompt.length > 500) {
      return res.status(400).json({ error: 'Prompt must be less than 500 characters' })
    }

    // Check if user already has an active request
    const existingRequest = await PromptMatchingService.getUserActiveRequest(userId)
    if (existingRequest) {
      return res.status(400).json({ 
        error: 'You already have an active help request',
        requestId: existingRequest.id,
        status: existingRequest.status
      })
    }

    // Check if user is in invisible mode
    const { data: user } = await supabase
      .from('profiles')
      .select('invisible_mode')
      .eq('id', userId)
      .single()
    
    if (user?.invisible_mode) {
      return res.status(403).json({ 
        error: 'Help requests are disabled while in invisible mode. Turn off invisible mode in settings to use this feature.' 
      })
    }

    // Create help request and find matching giver
    const result = await PromptMatchingService.createHelpRequest(userId, prompt.trim())

    res.json({
      success: true,
      requestId: result.requestId,
      status: result.status,
      message: result.status === 'matched' 
        ? 'Found a helper! Waiting for their response...' 
        : 'Searching for the perfect helper...',
      matchedGiver: result.matchedGiver
    })

  } catch (error) {
    logger.error({ error, userId: req.user!.id }, 'Error creating help request')
    res.status(500).json({ error: 'Failed to create help request' })
  }
})

/**
 * GET /api/match/status/:requestId
 * Get status of a help request
 */
router.get('/status/:requestId', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { requestId } = req.params
    const userId = req.user!.id

    const request = await PromptMatchingService.getHelpRequestStatus(requestId)

    if (!request) {
      return res.status(404).json({ error: 'Help request not found' })
    }

    // Verify user is the receiver
    if (request.receiver_user_id !== userId) {
      return res.status(403).json({ error: 'Unauthorized' })
    }

    res.json({
      requestId: request.id,
      status: request.status,
      attemptsCount: request.attempts_count,
      createdAt: request.created_at,
      expiresAt: request.expires_at,
      matchedGiverId: request.matched_giver_id,
      chatRoomId: request.chat_room_id
    })

  } catch (error) {
    logger.error({ error, userId: req.user!.id }, 'Error getting help request status')
    res.status(500).json({ error: 'Failed to get request status' })
  }
})

/**
 * POST /api/match/cancel/:requestId
 * Cancel a help request
 */
router.post('/cancel/:requestId', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { requestId } = req.params
    const userId = req.user!.id

    const success = await PromptMatchingService.cancelHelpRequest(requestId, userId)

    if (!success) {
      return res.status(404).json({ error: 'Help request not found or already completed' })
    }

    res.json({
      success: true,
      message: 'Help request cancelled'
    })

  } catch (error) {
    logger.error({ error, userId: req.user!.id }, 'Error cancelling help request')
    res.status(500).json({ error: 'Failed to cancel request' })
  }
})

/**
 * POST /api/match/giver/setup
 * Setup or update giver profile
 */
router.post('/giver/setup', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    const { skills, categories } = req.body

    if (!Array.isArray(skills) && !Array.isArray(categories)) {
      return res.status(400).json({ error: 'Skills or categories array required' })
    }

    const giverProfileId = await PromptMatchingService.createOrUpdateGiverProfile(
      userId,
      skills || [],
      categories || []
    )

    res.json({
      success: true,
      message: 'Giver profile updated',
      profileId: giverProfileId
    })

  } catch (error) {
    logger.error({ error, userId: req.user!.id }, 'Error setting up giver profile')
    res.status(500).json({ error: 'Failed to setup giver profile' })
  }
})

/**
 * POST /api/match/giver/toggle
 * Toggle giver availability
 */
router.post('/giver/toggle', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    const { isAvailable } = req.body

    if (typeof isAvailable !== 'boolean') {
      return res.status(400).json({ error: 'isAvailable must be a boolean' })
    }

    // Check if giver profile exists
    const existingProfile = await PromptMatchingService.getGiverProfile(userId)
    
    if (!existingProfile) {
      // Create profile if it doesn't exist
      await PromptMatchingService.createOrUpdateGiverProfile(userId, [], [])
    }

    const success = await PromptMatchingService.toggleGiverAvailability(userId, isAvailable)

    res.json({
      success,
      isAvailable,
      message: isAvailable ? 'You are now available to help' : 'You are now unavailable'
    })

  } catch (error) {
    logger.error({ error, userId: req.user!.id }, 'Error toggling giver availability')
    res.status(500).json({ error: 'Failed to toggle availability' })
  }
})

/**
 * GET /api/match/giver/profile
 * Get current user's giver profile
 */
router.get('/giver/profile', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id

    const profile = await PromptMatchingService.getGiverProfile(userId)

    if (!profile) {
      return res.json({
        exists: false,
        profile: null
      })
    }

    res.json({
      exists: true,
      profile: {
        isAvailable: profile.is_available,
        skills: profile.skills,
        categories: profile.categories,
        totalHelpsGiven: profile.total_helps_given,
        averageRating: profile.average_rating,
        lastActiveAt: profile.last_active_at
      }
    })

  } catch (error) {
    logger.error({ error, userId: req.user!.id }, 'Error getting giver profile')
    res.status(500).json({ error: 'Failed to get giver profile' })
  }
})

/**
 * GET /api/match/requests
 * Get recent help requests (for match page display)
 */
router.get('/requests', requireAuth, async (req: AuthRequest, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 20
    const offset = parseInt(req.query.offset as string) || 0
    const status = req.query.status as string || 'searching'

    // Get help requests with user profile data
    const { data: requests, error } = await supabase
      .from('help_requests')
      .select(`
        id,
        prompt,
        status,
        attempts_count,
        created_at,
        expires_at,
        profiles!help_requests_receiver_user_id_fkey (
          id,
          first_name,
          last_name,
          profile_photo_url,
          age,
          interests
        )
      `)
      .eq('status', status)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) {
      throw error
    }

    // Transform the data for frontend consumption
    const transformedRequests = requests?.map((request: any) => ({
      id: request.id,
      prompt: request.prompt,
      status: request.status,
      attemptsCount: request.attempts_count,
      createdAt: request.created_at,
      expiresAt: request.expires_at,
      user: {
        id: request.profiles?.id,
        firstName: request.profiles?.first_name,
        lastName: request.profiles?.last_name,
        profilePhotoUrl: request.profiles?.profile_photo_url,
        age: request.profiles?.age,
        interests: request.profiles?.interests || []
      },
      timeAgo: getTimeAgo(new Date(request.created_at))
    })) || []

    res.json({
      success: true,
      requests: transformedRequests,
      total: transformedRequests.length,
      hasMore: transformedRequests.length === limit
    })

  } catch (error) {
    logger.error({ error }, 'Error getting help requests')
    res.status(500).json({ error: 'Failed to get help requests' })
  }
})

/**
 * GET /api/match/receiver/active
 * Get user's active help request
 */
router.get('/receiver/active', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id

    const activeRequest = await PromptMatchingService.getUserActiveRequest(userId)

    if (!activeRequest) {
      return res.json({
        hasActiveRequest: false,
        request: null
      })
    }

    res.json({
      hasActiveRequest: true,
      request: {
        id: activeRequest.id,
        prompt: activeRequest.prompt,
        status: activeRequest.status,
        attemptsCount: activeRequest.attempts_count,
        createdAt: activeRequest.created_at,
        expiresAt: activeRequest.expires_at,
        matchedGiverId: activeRequest.matched_giver_id,
        chatRoomId: activeRequest.chat_room_id
      }
    })

  } catch (error) {
    logger.error({ error, userId: req.user!.id }, 'Error getting active request')
    res.status(500).json({ error: 'Failed to get active request' })
  }
})

/**
 * POST /api/match/giver/respond
 * Respond to a help request (accept/decline)
 * This is called from socket handler but also available as REST endpoint
 */
router.post('/giver/respond', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    const { requestId, accepted } = req.body

    if (!requestId || typeof accepted !== 'boolean') {
      return res.status(400).json({ error: 'requestId and accepted (boolean) are required' })
    }

    // Verify this giver has a pending request
    const { data: attempt } = await supabase
      .from('giver_request_attempts')
      .select('id, status')
      .eq('help_request_id', requestId)
      .eq('giver_user_id', userId)
      .eq('status', 'pending')
      .single()

    if (!attempt) {
      return res.status(404).json({ error: 'No pending request found' })
    }

    const result = await PromptMatchingService.handleGiverResponse(requestId, userId, accepted)

    res.json({
      success: result.success,
      accepted,
      chatId: result.chatId,
      message: accepted 
        ? 'Request accepted! Chat created.' 
        : 'Request declined. Searching for next helper...'
    })

  } catch (error) {
    logger.error({ error, userId: req.user!.id }, 'Error responding to help request')
    res.status(500).json({ error: 'Failed to respond to request' })
  }
})

export default router
