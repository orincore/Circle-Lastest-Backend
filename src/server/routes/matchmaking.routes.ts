import { Router } from 'express'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { startSearch, getStatus, decide, cancelSearch } from '../services/matchmaking-optimized.js'
import { supabase } from '../config/supabase.js'

const router = Router()

// Start matchmaking search
router.post('/start', requireAuth, async (req: AuthRequest, res) => {
  try {
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
  const status = await decide(req.user!.id, d as 'accept' | 'pass')
  res.json(status)
})

// Send message request to specific user
router.post('/message-request', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { receiverId } = req.body
    const senderId = req.user!.id
    
    if (!receiverId) {
      return res.status(400).json({ error: 'Receiver ID is required' })
    }
    
    if (senderId === receiverId) {
      return res.status(400).json({ error: 'Cannot send message request to yourself' })
    }
    
    // Check if they are already friends
    const { data: existingFriendship } = await supabase
      .from('friendships')
      .select('id')
      .or(`and(user1_id.eq.${senderId},user2_id.eq.${receiverId}),and(user1_id.eq.${receiverId},user2_id.eq.${senderId})`)
      .eq('status', 'active')
      .limit(1)
      .maybeSingle()
    
    if (existingFriendship) {
      return res.status(400).json({ error: 'You are already friends with this user' })
    }
    
    // Check if there's already a pending proposal
    const { data: existingProposal } = await supabase
      .from('matchmaking_proposals')
      .select('id')
      .or(`and(a.eq.${senderId},b.eq.${receiverId}),and(a.eq.${receiverId},b.eq.${senderId})`)
      .eq('status', 'pending')
      .limit(1)
      .maybeSingle()
    
    if (existingProposal) {
      return res.status(400).json({ error: 'Message request already pending' })
    }
    
    // Create matchmaking proposal
    const { data: newProposal, error: insertError } = await supabase
      .from('matchmaking_proposals')
      .insert({
        a: senderId,
        b: receiverId,
        status: 'pending',
        type: 'message_request'
      })
      .select()
      .single()
    
    if (insertError) {
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
    const { data: sentRequest } = await supabase
      .from('matchmaking_proposals')
      .select('id')
      .eq('a', currentUserId)
      .eq('b', userId)
      .eq('status', 'pending')
      .eq('type', 'message_request')
      .limit(1)
      .maybeSingle()
    
    if (sentRequest) {
      return res.json({
        hasPendingRequest: true,
        direction: 'sent',
        requestId: sentRequest.id
      })
    }
    
    const { data: receivedRequest } = await supabase
      .from('matchmaking_proposals')
      .select('id')
      .eq('a', userId)
      .eq('b', currentUserId)
      .eq('status', 'pending')
      .eq('type', 'message_request')
      .limit(1)
      .maybeSingle()
    
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
