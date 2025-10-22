import { Router } from 'express'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { supabase } from '../config/supabase.js'
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
      const { data: settings } = await supabase
        .from('chat_user_settings')
        .select('chat_id, archived, pinned')
        .eq('user_id', userId)
        .in('chat_id', chatIds)

      if (settings) {
        settingsMap = new Map(settings.map(s => [s.chat_id, { archived: !!s.archived, pinned: !!s.pinned }]))
      }
    }

    // Optionally load message counts (non-deleted, post-clear)
    let countsMap = new Map<string, number>()
    if (includeCounts && chatIds.length > 0) {
      // For simplicity (and to avoid heavy queries), compute per chat sequentially
      // Optimizations can batch via RPC if needed later
      for (const chatId of chatIds) {
        // Check user-specific clear date
        const { data: deletion } = await supabase
          .from('chat_deletions')
          .select('deleted_at')
          .eq('chat_id', chatId)
          .eq('user_id', userId)
          .maybeSingle()

        let q = supabase
          .from('messages')
          .select('*', { count: 'exact', head: true })
          .eq('chat_id', chatId)
          .eq('is_deleted', false)

        if (deletion?.deleted_at) {
          q = q.gt('created_at', deletion.deleted_at)
        }

        const { count } = await q
        countsMap.set(chatId, count ?? 0)
      }
    }

    // Filter out archived by default unless includeArchived=true
    const includeArchived = String(req.query.includeArchived || 'false') === 'true'

    // Map response
    let items = inbox.map(item => {
      const s = settingsMap.get(item.chat.id) || { archived: false, pinned: false }
      const count = countsMap.get(item.chat.id)
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
          isEdited: item.lastMessage.is_edited,
          isDeleted: item.lastMessage.is_deleted,
          status: (item.lastMessage as any).status || 'sent',
          createdAt: new Date(item.lastMessage.created_at).getTime(),
        } : null,
        otherUser: item.otherId ? {
          id: item.otherId,
          name: item.otherName,
          profilePhoto: item.otherProfilePhoto,
        } : null,
        archived: s.archived,
        pinned: s.pinned,
        messageCount: count,
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

    const { data, error } = await supabase
      .from('chat_user_settings')
      .upsert({
        user_id: userId,
        chat_id: chatId,
        archived,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,chat_id' })
      .select('user_id, chat_id, archived, pinned')
      .single()

    if (error) throw error

    // Notify only this user to refresh chat list
    emitToUser(userId, 'chat:list:changed', { chatId })
    res.json({ setting: data })
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

    const { data, error } = await supabase
      .from('chat_user_settings')
      .upsert({
        user_id: userId,
        chat_id: chatId,
        pinned,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,chat_id' })
      .select('user_id, chat_id, archived, pinned')
      .single()

    if (error) throw error

    // Notify only this user to refresh chat list
    emitToUser(userId, 'chat:list:changed', { chatId })
    res.json({ setting: data })
  } catch (error) {
    console.error('pin toggle error:', error)
    res.status(500).json({ error: 'Failed to update pin setting' })
  }
})

export default router
