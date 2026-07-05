import { Router } from 'express'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { startSearch, getStatus, decide, cancelSearch } from '../services/matchmaking-optimized.js'
import { and, eq, inArray, or } from 'drizzle-orm'
import { db } from '../config/db.js'
import { friendships, matchmakingProposals, profiles } from '../db/schema.js'
import { checkMatchLimit, SubscriptionService } from '../services/subscription.service.js'

const router = Router()

// Start matchmaking search
router.post('/start', requireAuth, checkMatchLimit, async (req: AuthRequest, res) => {
  try {
    // Check if user is in invisible mode
    const [user] = await db.select({ invisibleMode: profiles.invisibleMode })
      .from(profiles)
      .where(eq(profiles.id, req.user!.id))
      .limit(1)

    if (user?.invisibleMode) {
      return res.status(403).json({ 
        error: 'Matchmaking is disabled while in invisible mode. Turn off invisible mode in settings to use this feature.' 
      })
    }

    const { location } = req.body
    const preferences = location ? {
      latitude: location.latitude,
      longitude: location.longitude,
      maxDistance: location.maxDistance,
      ageRange: location.ageRange
    } : undefined
    
    await startSearch(req.user!.id, preferences)
    res.json({ ok: true })
  } catch (error) {
    console.error('Matchmaking start error:', error)
    res.status(500).json({ error: 'Failed to start matchmaking' })
  }
})

// Cancel matchmaking search (optional)
router.post('/cancel', requireAuth, async (req: AuthRequest, res) => {
  await cancelSearch(req.user!.id)
  res.json({ ok: true })
})

// Get current matchmaking status
router.get('/status', requireAuth, async (req: AuthRequest, res) => {
  const status = await getStatus(req.user!.id)
  res.json(status)
})

// Decide on a proposal: accept or pass
router.post('/decide', requireAuth, async (req: AuthRequest, res) => {
  const d = String(req.body?.decision || '')
  if (d !== 'accept' && d !== 'pass') return res.status(400).json({ error: 'Invalid decision' })
  
  // If accepting, check match limit and increment if needed
  if (d === 'accept') {
    try {
      const { canMatch } = await SubscriptionService.checkDailyMatchLimit(req.user!.id)
      if (!canMatch) {
        return res.status(429).json({ 
          error: 'Daily match limit reached',
          upgrade_required: true,
          message: 'Upgrade to premium for unlimited matches'
        })
      }
      
      // Increment match count for free users
      const isPremium = await SubscriptionService.isPremiumUser(req.user!.id)
      if (!isPremium) {
        await SubscriptionService.incrementDailyMatches(req.user!.id)
      }
    } catch (error) {
      console.error('Error checking match limit:', error)
      return res.status(500).json({ error: 'Failed to process match' })
    }
  }
  
  const status = await decide(req.user!.id, d as 'accept' | 'pass')
  res.json(status)
})

// Send message request to specific user
router.post('/message-request', requireAuth, checkMatchLimit, async (req: AuthRequest, res) => {
  try {
    const { receiverId } = req.body
    const senderId = req.user!.id
    
    if (!receiverId) {
      return res.status(400).json({ error: 'Receiver ID is required' })
    }
    
    if (senderId === receiverId) {
      return res.status(400).json({ error: 'Cannot send message request to yourself' })
    }
    
    // Check if they are already friends (accept both 'active' and 'accepted')
    const [existingFriendship] = await db.select({ id: friendships.id }).from(friendships)
      .where(and(
        or(
          and(eq(friendships.user1Id, senderId), eq(friendships.user2Id, receiverId)),
          and(eq(friendships.user1Id, receiverId), eq(friendships.user2Id, senderId)),
        ),
        inArray(friendships.status, ['active', 'accepted']),
      ))
      .limit(1)

    if (existingFriendship) {
      return res.status(400).json({ error: 'You are already friends with this user' })
    }

    // Check if there's already a pending proposal
    const [existingProposal] = await db.select({ id: matchmakingProposals.id }).from(matchmakingProposals)
      .where(and(
        or(
          and(eq(matchmakingProposals.a, senderId), eq(matchmakingProposals.b, receiverId)),
          and(eq(matchmakingProposals.a, receiverId), eq(matchmakingProposals.b, senderId)),
        ),
        eq(matchmakingProposals.status, 'pending'),
      ))
      .limit(1)

    if (existingProposal) {
      return res.status(400).json({ error: 'Message request already pending' })
    }

    // Create matchmaking proposal
    let newProposal: typeof matchmakingProposals.$inferSelect
    try {
      [newProposal] = await db.insert(matchmakingProposals)
        .values({ a: senderId, b: receiverId, status: 'pending', type: 'message_request' })
        .returning()
    } catch (insertError) {
      console.error('Error creating message request:', insertError)
      return res.status(500).json({ error: 'Failed to send message request' })
    }

    // Emit real-time events
    const io = req.app.get('io')
    if (io) {
      // Notify receiver
      io.to(receiverId).emit('message:request:received', {
        sender_id: senderId,
        receiver_id: receiverId,
        requestId: newProposal.id,
        type: 'message_request'
      })
      
      // Confirm to sender
      io.to(senderId).emit('message:request:sent', {
        sender_id: senderId,
        receiver_id: receiverId,
        requestId: newProposal.id,
        type: 'message_request'
      })
    }
    
    // Increment match count for free users
    try {
      const isPremium = await SubscriptionService.isPremiumUser(senderId)
      if (!isPremium) {
        await SubscriptionService.incrementDailyMatches(senderId)
      }
    } catch (error) {
      console.error('Error incrementing match count:', error)
    }
    
    res.json({ 
      success: true, 
      message: 'Message request sent successfully' 
    })
    
  } catch (error) {
    console.error('Message request error:', error)
    res.status(500).json({ error: 'Failed to send message request' })
  }
})

// Check pending message request status between current user and another user
router.get('/pending-status/:userId', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { userId } = req.params
    const currentUserId = req.user!.id
    
    // Check for pending message requests (matchmaking proposals) in both directions
    const [sentRequest] = await db.select({ id: matchmakingProposals.id }).from(matchmakingProposals)
      .where(and(
        eq(matchmakingProposals.a, currentUserId),
        eq(matchmakingProposals.b, userId),
        eq(matchmakingProposals.status, 'pending'),
        eq(matchmakingProposals.type, 'message_request'),
      ))
      .limit(1)

    if (sentRequest) {
      return res.json({
        hasPendingRequest: true,
        direction: 'sent',
        requestId: sentRequest.id
      })
    }

    const [receivedRequest] = await db.select({ id: matchmakingProposals.id }).from(matchmakingProposals)
      .where(and(
        eq(matchmakingProposals.a, userId),
        eq(matchmakingProposals.b, currentUserId),
        eq(matchmakingProposals.status, 'pending'),
        eq(matchmakingProposals.type, 'message_request'),
      ))
      .limit(1)

    if (receivedRequest) {
      return res.json({
        hasPendingRequest: true,
        direction: 'received',
        requestId: receivedRequest.id
      })
    }
    
    res.json({
      hasPendingRequest: false,
      direction: null,
      requestId: null
    })
    
  } catch (error) {
    console.error('Check pending message request error:', error)
    res.status(500).json({ error: 'Failed to check pending message requests' })
  }
})

export default router
