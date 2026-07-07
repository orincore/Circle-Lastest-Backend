import { Router } from 'express'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { and, eq, gt, inArray, ne, notExists, sql } from 'drizzle-orm'
import { db } from '../config/db.js'
import {
  blindDateMatches,
  chatDeletions,
  chatUserSettings,
  messageReceipts,
  messages,
  profiles,
} from '../db/schema.js'
import { getUserInbox } from '../repos/chat.repo.js'
import { emitToUser } from '../sockets/optimized-socket.js'

const router = Router()

// GET /api/chat-list
// Returns chat list enriched with archive/pin/mute flags and optional message counts
router.get('/', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    const includeCounts = String(req.query.includeCounts || 'false') === 'true'

    const inbox = await getUserInbox(userId)

    // Load user chat settings (archive/pin)
    const chatIds = inbox.map(i => i.chat.id)

    let settingsMap = new Map<string, { archived: boolean; pinned: boolean }>()
    if (chatIds.length > 0) {
      const settings = await db
        .select({
          chatId: chatUserSettings.chatId,
          archived: chatUserSettings.archived,
          pinned: chatUserSettings.pinned,
        })
        .from(chatUserSettings)
        .where(and(eq(chatUserSettings.userId, userId), inArray(chatUserSettings.chatId, chatIds)))

      settingsMap = new Map(settings.map(s => [s.chatId, { archived: !!s.archived, pinned: !!s.pinned }]))
    }

    // Optionally load UNREAD counts (messages from others without a read
    // receipt by this user). Previously this counted ALL messages in the chat,
    // which made every badge wrong — so the client had it disabled and badges
    // were 0 on launch until a realtime event arrived.
    let countsMap = new Map<string, number>()
    if (includeCounts && chatIds.length > 0) {
      for (const chatId of chatIds) {
        try {
          // Count messages from others (post-clear, not deleted) that this
          // user has no 'read' receipt for.
          const [deletion] = await db
            .select({ deletedAt: chatDeletions.deletedAt })
            .from(chatDeletions)
            .where(and(eq(chatDeletions.chatId, chatId), eq(chatDeletions.userId, userId)))
            .limit(1)

          const conditions = [
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
          ]
          if (deletion?.deletedAt) {
            conditions.push(gt(messages.createdAt, deletion.deletedAt))
          }

          const [row] = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(messages)
            .where(and(...conditions))

          countsMap.set(chatId, row?.count ?? 0)
        } catch (countError) {
          console.error('chat-list unread count error for chat', chatId, countError)
          countsMap.set(chatId, 0)
        }
      }
    }

    // Determine which chats are blind date chats with an ACTIVE match (ongoing, not yet revealed)
    // Also fetch match details for blind date info display
    interface BlindDateInfo {
      isOngoing: boolean
      matchReason?: string
      otherUserGender?: string
      otherUserAge?: number
      maskedName?: string
    }
    let blindDateMap = new Map<string, BlindDateInfo>()
    if (chatIds.length > 0) {
      const blindMatches = await db
        .select({
          chatId: blindDateMatches.chatId,
          userA: blindDateMatches.userA,
          userB: blindDateMatches.userB,
        })
        .from(blindDateMatches)
        .where(and(inArray(blindDateMatches.chatId, chatIds), eq(blindDateMatches.status, 'active')))

      if (blindMatches.length > 0) {
        // Get other user profiles for blind date matches
        for (const match of blindMatches) {
          if (!match.chatId) continue
          const otherUserId = match.userA === userId ? match.userB : match.userA

          // Get other user's profile for gender, age, and name masking
          const [otherProfile] = await db
            .select({
              firstName: profiles.firstName,
              lastName: profiles.lastName,
              gender: profiles.gender,
              age: profiles.age,
              needs: profiles.needs,
              isSuspended: profiles.isSuspended,
              deletedAt: profiles.deletedAt,
            })
            .from(profiles)
            .where(eq(profiles.id, otherUserId))
            .limit(1)

          // Skip if user is suspended or deleted
          if (otherProfile?.isSuspended || otherProfile?.deletedAt) {
            continue
          }

          // Get age directly from profile
          const age: number | undefined = otherProfile?.age
          
          // Mask name: "Adarsh Suradkar" -> "A***** S*******"
          // Helper function to mask a word
          const maskWord = (word: string) => {
            if (!word || word.length === 0) return ''
            if (word.length === 1) return word[0] + '*'
            return word[0] + '*'.repeat(word.length - 1)
          }
          
          let maskedName = 'Anonymous'
          if (otherProfile?.firstName && otherProfile.firstName.trim()) {
            const firstName = maskWord(otherProfile.firstName.trim())
            const lastName = otherProfile.lastName?.trim() ? maskWord(otherProfile.lastName.trim()) : ''
            maskedName = lastName ? `${firstName} ${lastName}` : firstName
          }
          
          // Determine match reason from needs (looking_for field)
          let matchReason = 'Connection'
          const needs = otherProfile?.needs
          if (needs && Array.isArray(needs) && needs.length > 0) {
            // Map needs to friendly labels
            const needsLabels: Record<string, string> = {
              'friendship': 'Friendship',
              'relationship': 'Relationship', 
              'dating': 'Dating',
              'casual': 'Casual',
              'serious': 'Serious Relationship',
              'networking': 'Networking',
              'chat': 'Chat Buddy',
              'friends': 'Friendship',
              'love': 'Relationship',
              'partner': 'Relationship'
            }
            const primaryNeed = String(needs[0] || '').toLowerCase().trim()
            matchReason = needsLabels[primaryNeed] || (primaryNeed ? primaryNeed.charAt(0).toUpperCase() + primaryNeed.slice(1) : 'Connection')
          }
          
          // Determine gender display
          let genderDisplay = otherProfile?.gender
          if (genderDisplay) {
            // Capitalize first letter
            genderDisplay = genderDisplay.charAt(0).toUpperCase() + genderDisplay.slice(1).toLowerCase()
          }
          
          blindDateMap.set(match.chatId, {
            isOngoing: true,
            matchReason,
            otherUserGender: genderDisplay || undefined,
            otherUserAge: age,
            maskedName
          })
        }
      }
    }

    // Filter out archived by default unless includeArchived=true
    const includeArchived = String(req.query.includeArchived || 'false') === 'true'

    // Map response
    let items = inbox.map(item => {
      const s = settingsMap.get(item.chat.id) || { archived: false, pinned: false }
      const count = countsMap.get(item.chat.id)
      const blindDateInfo = blindDateMap.get(item.chat.id)
      const isBlindDateOngoing = !!blindDateInfo?.isOngoing
      
      return {
        chatId: item.chat.id,
        lastMessageAt: item.chat.last_message_at,
        unreadCount: item.unreadCount,
        lastMessage: item.lastMessage ? {
          id: item.lastMessage.id,
          senderId: item.lastMessage.sender_id,
          text: item.lastMessage.text,
          mediaUrl: (item.lastMessage as any).media_url,
          mediaType: (item.lastMessage as any).media_type,
          thumbnail: (item.lastMessage as any).thumbnail,
          // A shared meme has no text/media of its own -- the client's preview
          // fallback relies on this field to say "Shared a meme" instead of
          // "Media". It was missing here, so it always showed "Media" on any
          // REST refresh even though shared_meme_id was already correct on
          // the underlying row (the realtime socket payload sends it fine,
          // which is why it only broke on refresh/restart, not immediately).
          sharedMemeId: (item.lastMessage as any).shared_meme_id,
          isEdited: item.lastMessage.is_edited,
          isDeleted: item.lastMessage.is_deleted,
          status: (item.lastMessage as any).status || 'sent',
          createdAt: new Date(item.lastMessage.created_at).getTime(),
        } : null,
        otherUser: item.otherId ? {
          id: item.otherId,
          name: isBlindDateOngoing && blindDateInfo?.maskedName ? blindDateInfo.maskedName : item.otherName,
          profilePhoto: item.otherProfilePhoto,
        } : null,
        archived: s.archived,
        pinned: s.pinned,
        messageCount: count,
        isBlindDateOngoing,
        // Blind date specific info
        blindDateInfo: isBlindDateOngoing ? {
          matchReason: blindDateInfo?.matchReason,
          gender: blindDateInfo?.otherUserGender,
          age: blindDateInfo?.otherUserAge,
          maskedName: blindDateInfo?.maskedName
        } : null,
      }
    })

    if (!includeArchived) {
      items = items.filter(i => !i.archived)
    }

    // Sort: pinned first, then by lastMessageAt desc (fallback unread/created)
    items.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      const ta = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0
      const tb = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0
      return tb - ta
    })

    res.json({ chats: items })
  } catch (error) {
    console.error('chat-list get error:', error)
    res.status(500).json({ error: 'Failed to load chat list' })
  }
})

// POST /api/chat-list/:chatId/archive { archived: boolean }
router.post('/:chatId/archive', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    const { chatId } = req.params
    const archived = !!req.body?.archived

    const now = new Date().toISOString()
    const [data] = await db
      .insert(chatUserSettings)
      .values({ userId, chatId, archived, updatedAt: now })
      .onConflictDoUpdate({
        target: [chatUserSettings.userId, chatUserSettings.chatId],
        set: { archived, updatedAt: now },
      })
      .returning({
        userId: chatUserSettings.userId,
        chatId: chatUserSettings.chatId,
        archived: chatUserSettings.archived,
        pinned: chatUserSettings.pinned,
      })

    // Notify only this user to refresh chat list
    emitToUser(userId, 'chat:list:changed', { chatId })
    res.json({ setting: { user_id: data.userId, chat_id: data.chatId, archived: data.archived, pinned: data.pinned } })
  } catch (error) {
    console.error('archive toggle error:', error)
    res.status(500).json({ error: 'Failed to update archive setting' })
  }
})

// POST /api/chat-list/:chatId/pin { pinned: boolean }
router.post('/:chatId/pin', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    const { chatId } = req.params
    const pinned = !!req.body?.pinned

    const now = new Date().toISOString()
    const [data] = await db
      .insert(chatUserSettings)
      .values({ userId, chatId, pinned, updatedAt: now })
      .onConflictDoUpdate({
        target: [chatUserSettings.userId, chatUserSettings.chatId],
        set: { pinned, updatedAt: now },
      })
      .returning({
        userId: chatUserSettings.userId,
        chatId: chatUserSettings.chatId,
        archived: chatUserSettings.archived,
        pinned: chatUserSettings.pinned,
      })

    // Notify only this user to refresh chat list
    emitToUser(userId, 'chat:list:changed', { chatId })
    res.json({ setting: { user_id: data.userId, chat_id: data.chatId, archived: data.archived, pinned: data.pinned } })
  } catch (error) {
    console.error('pin toggle error:', error)
    res.status(500).json({ error: 'Failed to update pin setting' })
  }
})

export default router
