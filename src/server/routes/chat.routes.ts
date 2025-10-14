import { Router } from 'express'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { supabase } from '../config/supabase.js'
import { CirclePointsService } from '../services/circle-points.service.js'
import { emitToUser } from '../sockets/optimized-socket.js'
import { 
  getUserInbox, 
  getChatMessages, 
  insertMessage, 
  editMessage, 
  deleteMessage,
  addReaction,
  toggleReaction,
  removeReaction,
  getMessageReactions,
  getChatMuteSetting,
  setChatMuteSetting,
  isChatMuted,
  ensureChatForUsers
} from '../repos/chat.repo.js'

const router = Router()

// Helper function to calculate and emit unread count for a specific chat
async function emitUnreadCountUpdate(chatId: string, userId: string) {
  try {
    // Get unread count for this specific chat and user
    const { data: msgs, error: msgsErr } = await supabase
      .from('messages')
      .select('id,sender_id')
      .eq('chat_id', chatId)
      .eq('is_deleted', false)
      .not('sender_id', 'eq', userId)
    
    if (msgsErr) {
      console.error('Error fetching messages for unread count:', msgsErr)
      return
    }
    
    const msgIds = (msgs || []).map(m => m.id)
    let readIds: string[] = []
    
    if (msgIds.length) {
      const { data: reads, error: rErr } = await supabase
        .from('message_receipts')
        .select('message_id')
        .eq('status', 'read')
        .eq('user_id', userId)
        .in('message_id', msgIds)
      
      if (rErr) {
        console.error('Error fetching read receipts:', rErr)
        return
      }
      
      readIds = (reads || []).map(r => r.message_id)
    }
    
    const unreadCount = msgIds.filter(id => !readIds.includes(id)).length
    
    //console.log(`📊 Emitting unread count update: chat ${chatId}, user ${userId}, count ${unreadCount}`)
    emitToUser(userId, 'chat:unread_count', { chatId, unreadCount })
    
  } catch (error) {
    console.error('Error calculating/emitting unread count:', error)
  }
}

router.get('/inbox', requireAuth, async (req: AuthRequest, res) => {
  const me = req.user!.id
  const inbox = await getUserInbox(me)
  res.json({ inbox })
})

// Create or get existing chat with a specific user
router.post('/with-user/:userId', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.params.userId
    const currentUserId = req.user!.id
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' })
    }
    
    if (userId === currentUserId) {
      return res.status(400).json({ error: 'Cannot create chat with yourself' })
    }
    
    // Check if users are friends (required for messaging)
    // Accept both 'active' and 'accepted' status for compatibility
    const { data: friendshipCheck } = await supabase
      .from('friendships')
      .select('id')
      .or(`and(user1_id.eq.${currentUserId},user2_id.eq.${userId}),and(user1_id.eq.${userId},user2_id.eq.${currentUserId})`)
      .in('status', ['active', 'accepted'])
      .limit(1)
      .maybeSingle()
    
    if (!friendshipCheck) {
      return res.status(403).json({ 
        error: 'Cannot create chat',
        reason: 'not_friends',
        message: 'You can only chat with friends. Send a friend request first.'
      })
    }
    
    // Get user profile for the other user
    const { data: userProfile } = await supabase
      .from('profiles')
      .select('id, first_name, last_name, profile_photo_url')
      .eq('id', userId)
      .single()
    
    if (!userProfile) {
      return res.status(404).json({ error: 'User not found' })
    }
    
    // Create or get existing chat
    const chat = await ensureChatForUsers(currentUserId, userId)
    
    res.json({ 
      chat,
      otherUser: {
        id: userProfile.id,
        name: `${userProfile.first_name || ''} ${userProfile.last_name || ''}`.trim(),
        profilePhoto: userProfile.profile_photo_url
      }
    })
  } catch (error) {
    console.error('Create chat error:', error)
    res.status(500).json({ error: 'Failed to create chat' })
  }
})

router.get('/:chatId/messages', requireAuth, async (req: AuthRequest, res) => {
  const chatId = req.params.chatId
  const userId = req.user!.id
  const limit = Math.min(parseInt(String(req.query.limit || '30'), 10) || 30, 100)
  const before = (req.query.before as string | undefined) || undefined
  const list = await getChatMessages(chatId, limit, before, userId)
  res.json({ messages: list })
})

router.post('/:chatId/messages', requireAuth, async (req: AuthRequest, res) => {
  const chatId = req.params.chatId
  const text = String(req.body?.text || '').trim()
  const mediaUrl = req.body?.mediaUrl
  const mediaType = req.body?.mediaType
  const thumbnail = req.body?.thumbnail
  const userId = req.user!.id
  
  // Require either text or media
  if (!text && !mediaUrl) return res.status(400).json({ error: 'Message text or media is required' })
  
  try {
    // Get chat members to check friendship status
    const { data: members } = await supabase
      .from('chat_members')
      .select('user_id')
      .eq('chat_id', chatId)
    
    if (!members || members.length !== 2) {
      return res.status(400).json({ error: 'Invalid chat' })
    }
    const otherUserId = members.find((m: { user_id: string }) => m.user_id !== userId)?.user_id
    if (!otherUserId) {
      return res.status(400).json({ error: 'Invalid chat members' })
    }
    
    // Check if users are friends (accept both 'active' and 'accepted' status)
    const { data: friendshipCheck } = await supabase
      .from('friendships')
      .select('id')
      .or(`and(user1_id.eq.${userId},user2_id.eq.${otherUserId}),and(user1_id.eq.${otherUserId},user2_id.eq.${userId})`)
      .in('status', ['active', 'accepted'])
      .limit(1)
      .maybeSingle()
    
    if (!friendshipCheck) {
      return res.status(403).json({ 
        error: 'Messaging not allowed',
        reason: 'not_friends',
        message: 'You can only send messages to friends. Send a friend request first.'
      })
    }
    
    const msg = await insertMessage(chatId, userId, text, mediaUrl, mediaType, thumbnail)
    
    // Emit real-time message to other user for chat list updates
    try {
      //console.log(`📨 Emitting message to user ${otherUserId} for chat ${chatId}`)
      emitToUser(otherUserId, 'chat:message', {
        message: {
          id: msg.id,
          chatId: msg.chat_id,
          senderId: msg.sender_id,
          text: msg.text,
          mediaUrl: msg.media_url,
          mediaType: msg.media_type,
          thumbnail: msg.thumbnail,
          createdAt: new Date(msg.created_at).getTime(),
          status: 'sent'
        }
      })
      
      // Also emit to sender for confirmation
      emitToUser(userId, 'chat:message', {
        message: {
          id: msg.id,
          chatId: msg.chat_id,
          senderId: msg.sender_id,
          text: msg.text,
          createdAt: new Date(msg.created_at).getTime(),
          status: 'sent'
        }
      })
      
      //console.log(`✅ Message emitted successfully to both users`)
      
      // Emit unread count update to the receiver
      await emitUnreadCountUpdate(chatId, otherUserId)
      
    } catch (error) {
      console.error('Failed to emit message via socket:', error)
    }
    
    // Award Circle points for sending message
    try {
      await Promise.all([
        CirclePointsService.recordActivity({
          user_id: userId,
          activity_type: 'message_sent',
          points_change: 1,
          related_user_id: otherUserId,
          metadata: { chat_id: chatId, message_id: msg.id }
        }),
        CirclePointsService.recordActivity({
          user_id: otherUserId,
          activity_type: 'message_received',
          points_change: 1,
          related_user_id: userId,
          metadata: { chat_id: chatId, message_id: msg.id }
        })
      ])
    } catch (error) {
      console.error('Failed to award Circle points for message:', error)
    }
    
    res.json({ message: msg })
  } catch (error) {
    console.error('Send message error:', error)
    res.status(500).json({ error: 'Failed to send message' })
  }
})

// Edit message
router.put('/messages/:messageId', requireAuth, async (req: AuthRequest, res) => {
  try {
    const messageId = req.params.messageId
    const text = String(req.body?.text || '').trim()
    if (!text) return res.status(400).json({ error: 'Message text is required' })
    const msg = await editMessage(messageId, req.user!.id, text)
    res.json({ message: msg })
  } catch (error) {
    console.error('Edit message error:', error)
    res.status(500).json({ error: 'Failed to edit message' })
  }
})

// Delete message
router.delete('/:chatId/messages/:messageId', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { chatId, messageId } = req.params
    await deleteMessage(chatId, messageId, req.user!.id)
    res.json({ success: true })
  } catch (error) {
    console.error('Delete message error:', error)
    res.status(500).json({ error: 'Failed to delete message' })
  }
})

// Toggle reaction on message (WhatsApp style - same emoji toggles on/off)
router.post('/messages/:messageId/reactions', requireAuth, async (req: AuthRequest, res) => {
  try {
    const messageId = req.params.messageId
    const emoji = String(req.body?.emoji || '').trim()
    if (!emoji) return res.status(400).json({ error: 'Emoji is required' })
    const result = await toggleReaction(messageId, req.user!.id, emoji)
    res.json({ action: result.action, reaction: result.reaction })
  } catch (error) {
    console.error('Toggle reaction error:', error)
    res.status(500).json({ error: 'Failed to toggle reaction. Make sure the message_reactions table exists.' })
  }
})

// Remove reaction from message
router.delete('/messages/:messageId/reactions/:emoji', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { messageId, emoji } = req.params
    await removeReaction(messageId, req.user!.id, decodeURIComponent(emoji))
    res.json({ success: true })
  } catch (error) {
    console.error('Remove reaction error:', error)
    res.status(500).json({ error: 'Failed to remove reaction' })
  }
})

// Get reactions for a message
router.get('/messages/:messageId/reactions', requireAuth, async (req: AuthRequest, res) => {
  try {
    const messageId = req.params.messageId
    const reactions = await getMessageReactions(messageId)
    res.json({ reactions })
  } catch (error) {
    console.error('Get reactions error:', error)
    res.status(500).json({ error: 'Failed to get reactions' })
  }
})

// Get chat mute setting
router.get('/:chatId/mute', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { chatId } = req.params
    const userId = req.user!.id
    //console.log('Getting mute setting for:', { userId, chatId })
    const setting = await getChatMuteSetting(userId, chatId)
    const muted = await isChatMuted(userId, chatId)
    //console.log('Mute setting result:', { userId, chatId, muted, setting })
    res.json({ 
      isMuted: muted,
      setting: setting 
    })
  } catch (error) {
    console.error('Get mute setting error:', error)
    res.status(500).json({ error: 'Failed to get mute setting' })
  }
})

// Set chat mute setting
router.post('/:chatId/mute', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { chatId } = req.params
    const userId = req.user!.id
    const { isMuted, mutedUntil } = req.body
    
    //console.log('Setting mute status:', { userId, chatId, isMuted, mutedUntil })
    
    if (typeof isMuted !== 'boolean') {
      return res.status(400).json({ error: 'isMuted must be a boolean' })
    }
    
    const setting = await setChatMuteSetting(userId, chatId, isMuted, mutedUntil)
    //console.log('Mute setting saved:', setting)
    res.json({ setting })
  } catch (error) {
    console.error('Set mute setting error:', error)
    res.status(500).json({ error: 'Failed to set mute setting' })
  }
})

export default router
