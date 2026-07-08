import { Router } from 'express'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { and, eq, inArray, ne, notExists, or, sql } from 'drizzle-orm'
import { db } from '../config/db.js'
import {
  blindDateMatches,
  chatDeletions,
  chatMembers,
  friendships,
  messageReceipts,
  messages,
  profiles,
} from '../db/schema.js'
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
  invalidateChatCaches,
  getChatMuteSetting,
  setChatMuteSetting,
  isChatMuted,
  ensureChatForUsers
} from '../repos/chat.repo.js'

const router = Router()

// Helper function to calculate and emit unread count for a specific chat
async function emitUnreadCountUpdate(chatId: string, userId: string) {
  try {
    // Messages from others in this chat that this user has no 'read' receipt for
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(messages)
      .where(and(
        eq(messages.chatId, chatId),
        eq(messages.isDeleted, false),
        ne(messages.senderId, userId),
        notExists(
          db.select({ one: sql`1` })
            .from(messageReceipts)
            .where(and(
              eq(messageReceipts.messageId, messages.id),
              eq(messageReceipts.userId, userId),
              eq(messageReceipts.status, 'read'),
            ))
        ),
      ))

    const unreadCount = row?.count ?? 0
    emitToUser(userId, 'chat:unread_count', { chatId, unreadCount })
  } catch (error) {
    console.error('Error calculating/emitting unread count:', error)
  }
}

// Two users are friends if a friendship row exists in either direction with an
// accepted-equivalent status ('active' and 'accepted' both count, for compatibility)
async function areFriends(userA: string, userB: string): Promise<boolean> {
  const rows = await db
    .select({ id: friendships.id })
    .from(friendships)
    .where(and(
      or(
        and(eq(friendships.user1Id, userA), eq(friendships.user2Id, userB)),
        and(eq(friendships.user1Id, userB), eq(friendships.user2Id, userA)),
      ),
      inArray(friendships.status, ['active', 'accepted']),
    ))
    .limit(1)
  return rows.length > 0
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
    if (!(await areFriends(currentUserId, userId))) {
      return res.status(403).json({
        error: 'Cannot create chat',
        reason: 'not_friends',
        message: 'You can only chat with friends. Send a friend request first.'
      })
    }

    // Get user profile for the other user
    const [userProfile] = await db
      .select({
        id: profiles.id,
        firstName: profiles.firstName,
        lastName: profiles.lastName,
        profilePhotoUrl: profiles.profilePhotoUrl,
      })
      .from(profiles)
      .where(eq(profiles.id, userId))
      .limit(1)

    if (!userProfile) {
      return res.status(404).json({ error: 'User not found' })
    }
    
    // Create or get existing chat
    const chat = await ensureChatForUsers(currentUserId, userId)
    
    res.json({
      chat,
      otherUser: {
        id: userProfile.id,
        name: `${userProfile.firstName || ''} ${userProfile.lastName || ''}`.trim(),
        profilePhoto: userProfile.profilePhotoUrl
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
  const isViewOnce = req.body?.isViewOnce === true
  const userId = req.user!.id
  
  // Require either text or media
  if (!text && !mediaUrl) return res.status(400).json({ error: 'Message text or media is required' })
  
  try {
    // Get chat members to check friendship status
    const members = await db
      .select({ userId: chatMembers.userId })
      .from(chatMembers)
      .where(eq(chatMembers.chatId, chatId))

    if (members.length !== 2) {
      return res.status(400).json({ error: 'Invalid chat' })
    }
    const otherUserId = members.find((m) => m.userId !== userId)?.userId
    if (!otherUserId) {
      return res.status(400).json({ error: 'Invalid chat members' })
    }
    
    // Check if this is a blind date chat (bypass friendship requirement)
    const { BlindDatingService } = await import('../services/blind-dating.service.js')
    const isBlindDate = await BlindDatingService.isBlindDateChat(chatId)

    // An accepted meme-connect chat has no friendship yet -- that's only
    // created once both sides reveal (see memeConnect.service.ts) -- so it
    // needs the same friendship bypass blind date gets.
    const { isMemeConnectChat } = await import('../services/memeConnect.service.js')
    const isMemeConnect = isBlindDate ? false : await isMemeConnectChat(chatId)

    // Only check friendship if it's neither a blind date nor a meme-connect chat
    if (!isBlindDate && !isMemeConnect) {
      if (!(await areFriends(userId, otherUserId))) {
        return res.status(403).json({
          error: 'Messaging not allowed',
          reason: 'not_friends',
          message: 'You can only send messages to friends. Send a friend request first.'
        })
      }
    }
    
    // For blind date chats ONLY, filter messages for personal information
    // Regular chats and revealed blind dates bypass all filtering
    if (isBlindDate && text && text.trim()) {
      try {
        // Get the match for this chat
        const match = await BlindDatingService.getMatchByChatId(chatId)
        
        // Only filter if match exists AND identities are NOT revealed yet
        // Once revealed (status === 'revealed'), no filtering - users can share anything
        if (match && match.status !== 'revealed') {
          // Fast filtering with timeout to ensure real-time performance
          const filterPromise = BlindDatingService.filterMessage(
            text.trim(),
            match.id,
            userId
          )
          
          // Set a timeout for filtering (max 2 seconds to keep it real-time)
          const timeoutPromise = new Promise<{ allowed: false }>((resolve) => {
            setTimeout(() => resolve({ allowed: false }), 2000)
          })
          
          const filterResult = await Promise.race([filterPromise, timeoutPromise])
          
          if (!filterResult.allowed) {
            // Message contains personal information - block it
            return res.status(403).json({
              error: 'Message blocked',
              reason: 'personal_info_detected',
              message: 'Focus on conversation! Once your vibe matches, we will allow you to share personal information.',
              blockedReason: (filterResult as any).blockedReason || 'Personal information detected'
            })
          }
        }
        // If match is revealed or doesn't exist, proceed without filtering
      } catch (filterError) {
        console.error('Error filtering blind date message:', filterError)
        // On error, allow the message but log it (fail open for real-time performance)
      }
    }
    // Regular chats (not blind date) bypass all filtering - proceed directly
    
    const msg = await insertMessage(chatId, userId, text, mediaUrl, mediaType, thumbnail, undefined, isViewOnce)
    
    // Emit real-time message to other user for chat list updates
    try {
      // Get sender info for notifications
      const [senderInfo] = await db
        .select({
          firstName: profiles.firstName,
          lastName: profiles.lastName,
          username: profiles.username,
          email: profiles.email,
          profilePhotoUrl: profiles.profilePhotoUrl,
        })
        .from(profiles)
        .where(eq(profiles.id, userId))
        .limit(1)

      // Check if this is a blind date chat (active, not revealed)
      const [blindMatch] = await db
        .select({ id: blindDateMatches.id })
        .from(blindDateMatches)
        .where(and(eq(blindDateMatches.chatId, chatId), eq(blindDateMatches.status, 'active')))
        .limit(1)

      const isBlindDateChat = !!blindMatch
      
      // Helper function to mask name for blind date
      const maskName = (firstName: string | null, lastName: string | null): string => {
        const maskWord = (word: string) => {
          if (!word || word.length === 0) return ''
          if (word.length === 1) return word[0] + '*'
          return word[0] + '*'.repeat(word.length - 1)
        }
        
        if (!firstName) return 'Anonymous'
        const maskedFirst = maskWord(firstName.trim())
        const maskedLast = lastName?.trim() ? maskWord(lastName.trim()) : ''
        return maskedLast ? `${maskedFirst} ${maskedLast}` : maskedFirst
      }
      
      const realName = senderInfo
        ? (senderInfo.firstName && senderInfo.lastName
            ? `${senderInfo.firstName} ${senderInfo.lastName}`.trim()
            : senderInfo.username || senderInfo.email?.split('@')[0] || 'Someone')
        : 'Someone'

      // Use masked name for blind date chats
      const senderName = isBlindDateChat
        ? maskName(senderInfo?.firstName || null, senderInfo?.lastName || null)
        : realName

      const senderAvatar = senderInfo?.profilePhotoUrl || null
      
      const messagePayload = {
        id: msg.id,
        chatId: msg.chat_id,
        senderId: msg.sender_id,
        text: msg.text,
        mediaUrl: msg.media_url,
        mediaType: msg.media_type,
        thumbnail: msg.thumbnail,
        sharedMemeId: msg.shared_meme_id,
        createdAt: new Date(msg.created_at).getTime(),
        status: 'sent',
        senderName,
        senderAvatar,
        isBlindDateChat
      }
      
      // Emit to receiver - both chat:message and chat:message:background for chat list
      emitToUser(otherUserId, 'chat:message', { message: messagePayload })
      emitToUser(otherUserId, 'chat:message:background', { message: messagePayload })
      
      // Also emit to sender for confirmation
      emitToUser(userId, 'chat:message', { message: messagePayload })
      
      // Emit unread count update to the receiver
      await emitUnreadCountUpdate(chatId, otherUserId)
      
      // Send push notification to the receiver with masked name for blind date
      try {
        const { PushNotificationService, describeMessageForNotification } = await import('../services/pushNotificationService.js')
        await PushNotificationService.sendMessageNotification(
          otherUserId,
          senderName, // Already masked for blind date
          describeMessageForNotification({
            text: msg.text,
            mediaType: msg.media_type,
            isViewOnce: (msg as any).is_view_once,
            sharedMemeId: msg.shared_meme_id,
          }),
          chatId,
          msg.id
        )
      } catch (pushError) {
        console.error('Failed to send push notification:', pushError)
      }
      
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

// Clear conversation for current user (soft delete: records in chat_deletions)
router.delete('/:chatId', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { chatId } = req.params
    const userId = req.user!.id

    // Check if this is a blind date chat (bypass membership check)
    const { BlindDatingService } = await import('../services/blind-dating.service.js')
    const isBlindDate = await BlindDatingService.isBlindDateChat(chatId)
    
    if (isBlindDate) {
      // For blind date chats, verify user is part of the match
      const [match] = await db
        .select({ userA: blindDateMatches.userA, userB: blindDateMatches.userB })
        .from(blindDateMatches)
        .where(and(
          eq(blindDateMatches.chatId, chatId),
          inArray(blindDateMatches.status, ['active', 'revealed']),
        ))
        .limit(1)

      if (!match || (match.userA !== userId && match.userB !== userId)) {
        return res.status(403).json({ error: 'Not authorized to clear this chat' })
      }
      // User is part of the blind date match, allow deletion
    } else {
      // For regular chats, verify membership or at least message presence by user as fallback
      const [membership] = await db
        .select({ userId: chatMembers.userId })
        .from(chatMembers)
        .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, userId)))
        .limit(1)

      if (!membership) {
        const userMessages = await db
          .select({ id: messages.id })
          .from(messages)
          .where(and(eq(messages.chatId, chatId), eq(messages.senderId, userId)))
          .limit(1)
        if (userMessages.length === 0) {
          return res.status(403).json({ error: 'Not authorized to clear this chat' })
        }
      }
    }

    // Upsert user-specific deletion record (chat_deletions has unique(chat_id, user_id))
    await db
      .insert(chatDeletions)
      .values({ chatId, userId, deletedAt: new Date().toISOString() })
      .onConflictDoUpdate({
        target: [chatDeletions.chatId, chatDeletions.userId],
        set: { deletedAt: new Date().toISOString() },
      })

    // Clearing changes this user's inbox + message history — drop caches.
    await invalidateChatCaches(chatId)

    // Optionally notify only this user (frontends may listen to chat:list:changed)
    try { emitToUser(userId, 'chat:list:changed', { chatId }) } catch {}
    return res.json({ success: true })
  } catch (error) {
    console.error('Clear chat error:', error)
    return res.status(500).json({ error: 'Failed to clear chat' })
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

// Get chat members - useful for determining who the other user is in a 1:1 chat
router.get('/:chatId/members', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { chatId } = req.params
    const userId = req.user!.id

    // Verify user is a member of this chat
    const [membership] = await db
      .select({ userId: chatMembers.userId })
      .from(chatMembers)
      .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, userId)))
      .limit(1)

    if (!membership) {
      return res.status(403).json({ error: 'You are not a member of this chat' })
    }

    // Get all members of the chat with their profile info
    const members = await db
      .select({
        userId: chatMembers.userId,
        joinedAt: chatMembers.joinedAt,
        firstName: profiles.firstName,
        lastName: profiles.lastName,
        profilePhotoUrl: profiles.profilePhotoUrl,
        instagramUsername: profiles.instagramUsername,
      })
      .from(chatMembers)
      .leftJoin(profiles, eq(profiles.id, chatMembers.userId))
      .where(eq(chatMembers.chatId, chatId))

    // Format the response (same keys as before)
    const formattedMembers = members.map((member) => ({
      user_id: member.userId,
      joined_at: member.joinedAt,
      first_name: member.firstName ?? undefined,
      last_name: member.lastName ?? undefined,
      profile_photo_url: member.profilePhotoUrl ?? undefined,
      username: member.instagramUsername ?? undefined,
    }))

    res.json({ members: formattedMembers })
  } catch (error) {
    console.error('Get chat members error:', error)
    res.status(500).json({ error: 'Failed to get chat members' })
  }
})

export default router
