import { supabase } from '../config/supabase.js'
import { cache, cacheKeys } from '../services/cache.js'

// Cache TTLs (seconds). Short, because invalidation keeps them fresh on writes;
// the TTL is just a safety net for anything we miss.
const INBOX_TTL = 60
const HISTORY_TTL = 120

/**
 * Invalidate all chat caches affected by a change in `chatId`:
 * the chat's message-history pages and every member's inbox.
 */
export async function invalidateChatCaches(chatId: string, memberIds?: string[]): Promise<void> {
  try {
    await cache.delByPrefix(cacheKeys.historyPrefix(chatId))
    let ids = memberIds
    if (!ids) {
      const { data: members } = await supabase
        .from('chat_members')
        .select('user_id')
        .eq('chat_id', chatId)
      ids = (members || []).map((m: any) => m.user_id)
    }
    if (ids && ids.length) {
      await cache.del(...ids.map((id) => cacheKeys.inbox(id)))
    }
  } catch {
    // best-effort
  }
}

/** Invalidate a single user's inbox cache (e.g. when their unread count changes). */
export async function invalidateInbox(userId: string): Promise<void> {
  await cache.del(cacheKeys.inbox(userId))
}

export interface Chat {
  id: string
  created_at: string
  last_message_at: string | null
}

export interface ChatMember {
  chat_id: string
  user_id: string
  joined_at: string
}

export interface ChatMessage {
  id: string
  chat_id: string
  sender_id: string
  text: string
  media_url?: string | null
  media_type?: string
  thumbnail?: string | null
  reply_to_id?: string
  created_at: string
  updated_at?: string
  is_edited?: boolean
  is_deleted?: boolean
  is_view_once?: boolean
  view_once_viewed_at?: string | null
}

/**
 * View-once media must never sit in bulk history/broadcast payloads — only
 * the dedicated consume flow (consumeViewOnceMessage) hands out the real
 * media_url, exactly once. Otherwise a captured payload or a simple app
 * restart (which used to reset the client's local "already viewed" state)
 * would make "view once" meaningless.
 */
function stripViewOnceMedia<T extends { is_view_once?: boolean; media_url?: string | null; thumbnail?: string | null }>(
  row: T
): T {
  if (!row.is_view_once) return row
  return { ...row, media_url: null, thumbnail: null }
}

export interface MessageReaction {
  id: string
  message_id: string
  user_id: string
  emoji: string
  created_at: string
}

export interface ChatDeletion {
  id: string
  chat_id: string
  user_id: string
  deleted_at: string
  created_at: string
}

export async function ensureChatForUsers(a: string, b: string): Promise<Chat> {
  // Find an existing 1:1 chat for these two users
  const { data: existing, error: findErr } = await supabase
    .from('chat_members')
    .select('chat_id')
    .in('user_id', [a, b])
  if (findErr) throw findErr

  if (existing && existing.length) {
    // Count members per chat_id
    const counts: Record<string, number> = {}
    for (const row of existing) counts[row.chat_id] = (counts[row.chat_id] || 0) + 1
    const chatId = Object.entries(counts).find(([, c]) => c >= 2)?.[0]
    if (chatId) {
      const { data, error } = await supabase.from('chats').select('*').eq('id', chatId).maybeSingle()
      if (error) throw error
      if (data) return data as Chat
    }
  }

  // Create a new chat and add members - set last_message_at to now so it appears at top of list
  const { data: chat, error: chatErr } = await supabase.from('chats').insert({ last_message_at: new Date().toISOString() }).select('*').single()
  if (chatErr) throw chatErr
  const { error: mErr } = await supabase.from('chat_members').insert([
    { chat_id: chat.id, user_id: a },
    { chat_id: chat.id, user_id: b },
  ])
  if (mErr) throw mErr
  return chat as Chat
}

export async function getUserInbox(userId: string) {
  // Serve from cache when available — this is the hot path the app polls.
  const cacheKey = cacheKeys.inbox(userId)
  const cached = await cache.getJSON<any[]>(cacheKey)
  if (cached) return cached

  const results = await computeUserInbox(userId)
  // Don't cache empty inboxes for as long; they fill in quickly for new users.
  await cache.setJSON(cacheKey, results, results.length ? INBOX_TTL : 15)
  return results
}

async function computeUserInbox(userId: string) {
  // Get chats the user is a member of
  const { data: memberships, error: mErr } = await supabase
    .from('chat_members')
    .select('chat_id')
    .eq('user_id', userId)
  if (mErr) throw mErr
  const chatIds = (memberships || []).map((m) => m.chat_id)
  if (!chatIds.length) return []

  // Fetch chats
  const { data: chats, error: cErr } = await supabase
    .from('chats')
    .select('*')
    .in('id', chatIds)
    .order('last_message_at', { ascending: false, nullsFirst: false })
  if (cErr) throw cErr

  // For each chat, find the other participant to display name
  const results = [] as Array<{ chat: Chat; lastMessage: ChatMessage | null; unreadCount: number; otherId?: string; otherName?: string; otherProfilePhoto?: string }>
  // Preload members for all chats
  const { data: members, error: memErr } = await supabase
    .from('chat_members')
    .select('chat_id, user_id')
    .in('chat_id', chatIds)
  if (memErr) throw memErr
  const otherIdsSet = new Set<string>()
  // Get user's chat deletion records to filter out cleared chats and messages
  const { data: deletions, error: delErr } = await supabase
    .from('chat_deletions')
    .select('chat_id, deleted_at')
    .eq('user_id', userId)
  if (delErr) throw delErr

  const deletionMap = new Map((deletions || []).map(d => [d.chat_id, d.deleted_at]))

  // --- Last message per chat (parallel instead of sequential) ---
  const lastMessages = await Promise.all((chats as Chat[]).map(async (chat) => {
    const deletedAt = deletionMap.get(chat.id)
    let q = supabase
      .from('messages')
      .select('*')
      .eq('chat_id', chat.id)
      .eq('is_deleted', false)
      .order('created_at', { ascending: false })
      .limit(1)
    if (deletedAt) q = q.gt('created_at', deletedAt)
    const { data: last, error: lmErr } = await q.maybeSingle()
    if (lmErr) throw lmErr
    return { chat, deletedAt, lastMessage: last ? (last as ChatMessage) : null }
  }))

  // Keep only chats that should appear in the inbox (cleared+empty chats drop out).
  const visible = lastMessages.filter(({ deletedAt, lastMessage }) => !(deletedAt && !lastMessage))
  const visibleChatIds = visible.map(v => v.chat.id)

  // --- Unread counts: 2 batched queries total (was 2 per chat + a receipt-history
  //     scan per chat). Fetch all candidate unread messages for the visible chats,
  //     then all of the user's read receipts for those messages, in one round trip each. ---
  const unreadByChat = new Map<string, number>()
  if (visibleChatIds.length) {
    const { data: candidateMsgs, error: cmErr } = await supabase
      .from('messages')
      .select('id, chat_id, created_at')
      .in('chat_id', visibleChatIds)
      .eq('is_deleted', false)
      .not('sender_id', 'eq', userId)
    if (cmErr) throw cmErr

    // Apply per-chat clear date and collect ids.
    const perChatMsgIds = new Map<string, string[]>()
    const allMsgIds: string[] = []
    for (const m of candidateMsgs || []) {
      const deletedAt = deletionMap.get(m.chat_id)
      if (deletedAt && !(new Date(m.created_at) > new Date(deletedAt))) continue
      const arr = perChatMsgIds.get(m.chat_id) || []
      arr.push(m.id)
      perChatMsgIds.set(m.chat_id, arr)
      allMsgIds.push(m.id)
    }

    // One query for the user's read receipts across all those messages.
    const readSet = new Set<string>()
    if (allMsgIds.length) {
      // Chunk to stay within URL/param limits on very large inboxes.
      const chunkSize = 500
      for (let i = 0; i < allMsgIds.length; i += chunkSize) {
        const chunk = allMsgIds.slice(i, i + chunkSize)
        const { data: reads, error: rErr } = await supabase
          .from('message_receipts')
          .select('message_id')
          .eq('status', 'read')
          .eq('user_id', userId)
          .in('message_id', chunk)
        if (rErr) throw rErr
        for (const r of reads || []) readSet.add(r.message_id)
      }
    }

    for (const [chatId, ids] of perChatMsgIds.entries()) {
      unreadByChat.set(chatId, ids.filter(id => !readSet.has(id)).length)
    }
  }

  for (const { chat, lastMessage } of visible) {
    const mems = (members || []).filter((m: { chat_id: string; user_id: string }) => m.chat_id === chat.id)
    const otherId = mems.map((m: { user_id: string }) => m.user_id).find((id: string) => id !== userId)
    if (otherId) otherIdsSet.add(otherId)
    results.push({ chat, lastMessage, unreadCount: unreadByChat.get(chat.id) || 0, otherId })
  }

  // fetch names and profile photos for others - exclude suspended/deleted accounts
  if (otherIdsSet.size) {
    const { data: profiles, error: pErr } = await supabase
      .from('profiles')
      .select('id, first_name, last_name, profile_photo_url, is_suspended, deleted_at')
      .in('id', Array.from(otherIdsSet))
    if (!pErr && profiles) {
      // Filter out suspended/deleted users
      const activeProfiles = profiles.filter((p: any) => !p.deleted_at && !p.is_suspended)
      const nameMap = new Map((activeProfiles as any[]).map((p) => [p.id, `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim()]))
      const photoMap = new Map((activeProfiles as any[]).map((p) => [p.id, p.profile_photo_url]))
      // Track which users are suspended/deleted
      const suspendedOrDeletedIds = new Set(
        profiles.filter((p: any) => p.deleted_at || p.is_suspended).map((p: any) => p.id)
      )
      for (const item of results) {
        if (item.otherId) {
          // Mark suspended/deleted users
          if (suspendedOrDeletedIds.has(item.otherId)) {
            item.otherName = 'Deleted User'
            item.otherProfilePhoto = undefined
          } else {
            item.otherName = nameMap.get(item.otherId)
            item.otherProfilePhoto = photoMap.get(item.otherId)
          }
        }
      }
    }
  }

  // Get message receipt status for user's own messages (optimized single query)
  const userMessageIds = results
    .filter(item => item.lastMessage && item.lastMessage.sender_id === userId)
    .map(item => item.lastMessage!.id);

  if (userMessageIds.length > 0) {
    try {
      // Get all receipts for user's messages in a single query
      const { data: receipts, error: receiptsErr } = await supabase
        .from('message_receipts')
        .select('message_id, status')
        .in('message_id', userMessageIds)
        .order('created_at', { ascending: false });

      if (!receiptsErr && receipts) {
        // Create a map of message_id -> highest status
        const statusMap = new Map<string, string>();
        
        for (const receipt of receipts) {
          const currentStatus = statusMap.get(receipt.message_id);
          // Priority: read > delivered
          if (!currentStatus || 
              (receipt.status === 'read') || 
              (receipt.status === 'delivered' && currentStatus !== 'read')) {
            statusMap.set(receipt.message_id, receipt.status);
          }
        }

        // Apply status to messages
        for (const item of results) {
          if (item.lastMessage && item.lastMessage.sender_id === userId) {
            const status = statusMap.get(item.lastMessage.id) || 'sent';
            (item.lastMessage as any).status = status;
          }
        }
      } else {
        // Default all user messages to 'sent' if query fails
        for (const item of results) {
          if (item.lastMessage && item.lastMessage.sender_id === userId) {
            (item.lastMessage as any).status = 'sent';
          }
        }
      }
    } catch (error) {
      console.error('Error fetching message receipts:', error);
      // Default all user messages to 'sent' on error
      for (const item of results) {
        if (item.lastMessage && item.lastMessage.sender_id === userId) {
          (item.lastMessage as any).status = 'sent';
        }
      }
    }
  }
  return results
}

export async function getChatMessages(chatId: string, limit = 30, before?: string, userId?: string) {
  // Cache only the first page (the one fetched on chat open). Paginated/older
  // pages (`before` set) are rarely re-fetched, so caching them adds little.
  const cacheable = !before && !!userId
  const histKey = cacheable ? cacheKeys.history(chatId, userId!, limit) : ''
  if (cacheable) {
    const hit = await cache.getJSON<any[]>(histKey)
    if (hit) return hit as (ChatMessage & { reactions: MessageReaction[]; receipts: { user_id: string; status: string }[] })[]
  }

  let q = supabase
    .from('messages')
    .select(`
      *,
      reactions:message_reactions(
        id,
        user_id,
        emoji,
        created_at
      ),
      receipts:message_receipts(
        user_id,
        status
      )
    `)
    .eq('chat_id', chatId)
    .eq('is_deleted', false) // Only return non-deleted messages
    .order('created_at', { ascending: false })
    .limit(limit)
  
  if (before) q = q.lt('created_at', before)
  
  // If userId is provided, filter out messages that were sent before the user cleared the chat
  if (userId) {
    // Get the user's chat deletion record to see when they cleared the chat
    const { data: deletion } = await supabase
      .from('chat_deletions')
      .select('deleted_at')
      .eq('chat_id', chatId)
      .eq('user_id', userId)
      .maybeSingle()
    
    if (deletion) {
      // Only show messages created after the user cleared the chat
      q = q.gt('created_at', deletion.deleted_at)
    }
  }
  
  const { data, error } = await q
  if (error) throw error

  const rows = ((data || []) as (ChatMessage & { reactions: MessageReaction[]; receipts: { user_id: string; status: string }[] })[])
    .map(stripViewOnceMedia)
  if (cacheable) await cache.setJSON(histKey, rows, HISTORY_TTL)
  return rows
}

export async function getRecentChatTextMessagesForModeration(chatId: string, limit = 10) {
  const { data, error } = await supabase
    .from('messages')
    .select('id, chat_id, sender_id, text, created_at, is_deleted, media_url, media_type')
    .eq('chat_id', chatId)
    .eq('is_deleted', false)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  // Return only text messages (ignore media-only messages for context)
  return (data || [])
    .filter((m: any) => typeof m.text === 'string' && m.text.trim().length > 0)
    .map((m: any) => ({
      sender_id: m.sender_id,
      text: String(m.text),
      created_at: m.created_at,
    }))
}

export async function insertMessage(
  chatId: string,
  senderId: string,
  text: string,
  mediaUrl?: string,
  mediaType?: string,
  thumbnail?: string,
  replyToId?: string,
  isViewOnce?: boolean
): Promise<ChatMessage> {
  // Insert the message
  const messageData: any = {
    chat_id: chatId,
    sender_id: senderId,
    text: text || '' // Allow empty text for media messages
  }

  // Add media fields if provided
  if (mediaUrl) messageData.media_url = mediaUrl
  if (mediaType) messageData.media_type = mediaType
  if (thumbnail) messageData.thumbnail = thumbnail
  if (replyToId) messageData.reply_to_id = replyToId
  if (isViewOnce) messageData.is_view_once = true

  //console.log('📝 Inserting message with data:', messageData)

  const { data, error } = await supabase
    .from('messages')
    .insert(messageData)
    .select('*')
    .single()

  if (error) {
    console.error('❌ Message insert error:', error)
    throw error
  }
  
  //console.log('✅ Message inserted successfully:', data)

  // Update chat last_message_at (best-effort)
  try {
    await supabase
      .from('chats')
      .update({ last_message_at: (data as any)?.created_at ?? new Date().toISOString() })
      .eq('id', chatId)
  } catch {}

  // A new message changes both the chat history and every member's inbox.
  await invalidateChatCaches(chatId)

  return stripViewOnceMedia(data as ChatMessage)
}

export type ConsumeViewOnceResult =
  | { ok: true; mediaUrl: string | null; mediaType: string | null; senderId: string }
  | { ok: false; reason: 'not_found' | 'sender_cannot_view' | 'already_viewed' }

/**
 * Atomically consume a view-once message: only succeeds the very first time
 * it's called for a given message, via a conditional UPDATE guarded by
 * `view_once_viewed_at IS NULL` (so two simultaneous taps — e.g. from two of
 * the recipient's devices — can't both "win"). The sender-vs-recipient check
 * MUST happen before that update, not after: otherwise the sender merely
 * tapping their own bubble would burn the recipient's one-and-only view
 * before we ever get a chance to reject it.
 */
export async function consumeViewOnceMessage(
  messageId: string,
  chatId: string,
  requestingUserId: string
): Promise<ConsumeViewOnceResult> {
  const { data: existing, error: fetchError } = await supabase
    .from('messages')
    .select('id, chat_id, sender_id, media_url, media_type, is_view_once, view_once_viewed_at')
    .eq('id', messageId)
    .eq('chat_id', chatId)
    .maybeSingle()

  if (fetchError || !existing || !existing.is_view_once) return { ok: false, reason: 'not_found' }
  if (existing.sender_id === requestingUserId) return { ok: false, reason: 'sender_cannot_view' }
  if (existing.view_once_viewed_at) return { ok: false, reason: 'already_viewed' }

  const { data: updated, error: updateError } = await supabase
    .from('messages')
    .update({ view_once_viewed_at: new Date().toISOString() })
    .eq('id', messageId)
    .is('view_once_viewed_at', null) // conditional — only the first caller wins the race
    .select('media_url, media_type, sender_id')
    .maybeSingle()

  if (updateError || !updated) return { ok: false, reason: 'already_viewed' } // lost the race

  return {
    ok: true,
    mediaUrl: (existing as any).media_url ?? null,
    mediaType: (existing as any).media_type ?? null,
    senderId: (existing as any).sender_id,
  }
}

export async function insertReceipt(messageId: string, userId: string, status: 'delivered' | 'read') {
  try {
    //console.log(`📝 Inserting ${status} receipt for message ${messageId} by user ${userId}`);
    
    // Use upsert to handle duplicates gracefully without errors
    const { error } = await supabase
      .from('message_receipts')
      .upsert(
        { message_id: messageId, user_id: userId, status },
        { 
          onConflict: 'message_id,user_id,status',
          ignoreDuplicates: true 
        }
      )
      .select('id')
    
    if (error) {
      console.error(`❌ Receipt insert failed:`, error);

      // For network errors (fetch failed), don't throw - just log and continue
      if (error.message?.includes('fetch failed') || error.message?.includes('TypeError: fetch failed')) {
        console.warn(`🌐 Network error inserting receipt - continuing without throwing`);
        return; // Don't throw, just return
      }

      throw error;
    } else {
      // A 'read' receipt clears unread for this user — refresh their inbox cache.
      if (status === 'read') {
        await invalidateInbox(userId)
      }
    }
  } catch (error) {
    // Handle network errors gracefully
    if (error instanceof TypeError && error.message?.includes('fetch failed')) {
      console.warn(`🌐 Network connectivity issue inserting ${status} receipt - skipping:`, {
        messageId,
        userId,
        error: error.message
      });
      return; // Don't throw for network errors
    }
    
    console.error(`❌ Failed to insert ${status} receipt:`, {
      messageId,
      userId,
      error: error instanceof Error ? {
        message: error.message,
        stack: error.stack,
        name: error.name
      } : error
    });
    throw error;
  }
}

export async function editMessage(messageId: string, userId: string, newText: string): Promise<ChatMessage> {
  // Ensure ownership
  const { data: msg, error: findErr } = await supabase
    .from('messages')
    .select('id, sender_id, chat_id')
    .eq('id', messageId)
    .maybeSingle()
  if (findErr) throw findErr
  if (!msg || msg.sender_id !== userId) {
    const e: any = new Error('Forbidden')
    e.status = 403
    throw e
  }

  // Update the message
  const { data, error } = await supabase
    .from('messages')
    .update({
      text: newText,
      updated_at: new Date().toISOString(),
      is_edited: true
    })
    .eq('id', messageId)
    .select('*')
    .single()
  if (error) throw error
  await invalidateChatCaches((msg as any).chat_id)
  return data as ChatMessage
}

export async function deleteMessage(chatId: string, messageId: string, userId: string) {
  // ensure ownership
  const { data: msg, error: findErr } = await supabase
    .from('messages')
    .select('id, chat_id, sender_id')
    .eq('id', messageId)
    .maybeSingle()
  if (findErr) throw findErr
  if (!msg || msg.chat_id !== chatId || msg.sender_id !== userId) {
    const e: any = new Error('Forbidden')
    e.status = 403
    throw e
  }

  // Soft delete by marking as deleted instead of hard delete
  // Keep original text intact - only mark as deleted
  const { error } = await supabase
    .from('messages')
    .update({
      is_deleted: true,
      updated_at: new Date().toISOString()
    })
    .eq('id', messageId)
  if (error) throw error
  await invalidateChatCaches(chatId)
}

export async function toggleReaction(messageId: string, userId: string, emoji: string): Promise<{ action: 'added' | 'removed', reaction?: MessageReaction }> {
  // Check if reaction already exists
  const { data: existing, error: checkErr } = await supabase
    .from('message_reactions')
    .select('*')
    .eq('message_id', messageId)
    .eq('user_id', userId)
    .eq('emoji', emoji)
    .maybeSingle()
  if (checkErr) throw checkErr

  if (existing) {
    // Reaction exists, remove it
    const { error: deleteErr } = await supabase
      .from('message_reactions')
      .delete()
      .eq('id', existing.id)
    if (deleteErr) throw deleteErr
    return { action: 'removed', reaction: existing as MessageReaction }
  }

  // Add new reaction
  const { data, error } = await supabase
    .from('message_reactions')
    .insert({ message_id: messageId, user_id: userId, emoji })
    .select('*')
    .single()
  if (error) throw error
  return { action: 'added', reaction: data as MessageReaction }
}

// Keep the old function for backward compatibility
export async function addReaction(messageId: string, userId: string, emoji: string): Promise<MessageReaction> {
  const result = await toggleReaction(messageId, userId, emoji)
  if (result.action === 'removed') {
    throw new Error('Reaction was removed (toggled off)')
  }
  return result.reaction!
}

export async function removeReaction(messageId: string, userId: string, emoji: string) {
  const { error } = await supabase
    .from('message_reactions')
    .delete()
    .eq('message_id', messageId)
    .eq('user_id', userId)
    .eq('emoji', emoji)
  if (error) throw error
}

// Chat mute settings functions
export interface ChatMuteSetting {
  id: string
  user_id: string
  chat_id: string
  is_muted: boolean
  muted_until?: string | null
  created_at: string
  updated_at: string
}

export async function getChatMuteSetting(userId: string, chatId: string): Promise<ChatMuteSetting | null> {
  try {
    const { data, error } = await supabase
      .from('chat_mute_settings')
      .select('*')
      .eq('user_id', userId)
      .eq('chat_id', chatId)
      .maybeSingle()
    
    if (error) {
      console.error('Error getting chat mute setting:', error)
      // If table doesn't exist, return null (not muted)
      if (error.code === '42P01') { // Table doesn't exist
        //console.log('chat_mute_settings table does not exist, treating as not muted')
        return null
      }
      throw error
    }
    return data as ChatMuteSetting | null
  } catch (error) {
    console.error('Failed to get chat mute setting:', error)
    return null // Default to not muted if there's an error
  }
}

export async function setChatMuteSetting(userId: string, chatId: string, isMuted: boolean, mutedUntil?: string): Promise<ChatMuteSetting> {
  try {
    const { data, error } = await supabase
      .from('chat_mute_settings')
      .upsert({
        user_id: userId,
        chat_id: chatId,
        is_muted: isMuted,
        muted_until: mutedUntil || null,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'user_id,chat_id'
      })
      .select('*')
      .single()
    
    if (error) {
      console.error('Error setting chat mute setting:', error)
      if (error.code === '42P01') { // Table doesn't exist
        throw new Error('chat_mute_settings table does not exist. Please run the database migration.')
      }
      throw error
    }
    return data as ChatMuteSetting
  } catch (error) {
    console.error('Failed to set chat mute setting:', error)
    throw error
  }
}

export async function isChatMuted(userId: string, chatId: string): Promise<boolean> {
  //console.log('Checking if chat is muted:', { userId, chatId })
  const setting = await getChatMuteSetting(userId, chatId)
  //console.log('Retrieved mute setting:', setting)
  
  if (!setting) {
    //console.log('No mute setting found, chat is not muted')
    return false
  }
  
  // Check if temporarily muted and time has expired
  if (setting.muted_until) {
    const mutedUntil = new Date(setting.muted_until)
    const now = new Date()
    if (now > mutedUntil) {
      // Mute period expired, update setting
      //console.log('Mute period expired, updating setting')
      await setChatMuteSetting(userId, chatId, false)
      return false
    }
  }
  
  //console.log('Final mute status:', setting.is_muted)
  return setting.is_muted
}

export async function getMessageReactions(messageId: string): Promise<MessageReaction[]> {
  const { data, error } = await supabase
    .from('message_reactions')
    .select('*')
    .eq('message_id', messageId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data || []) as MessageReaction[]
}
