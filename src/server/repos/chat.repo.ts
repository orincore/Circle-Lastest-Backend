import { and, desc, eq, gt, inArray, isNull, lt, ne, notExists, sql } from 'drizzle-orm'
import { db } from '../config/db.js'
import { chats, chatMembers, messages, chatDeletions, profiles, messageReceipts, messageReactions, chatMuteSettings } from '../db/schema.js'
import { cache, cacheKeys } from '../services/cache.js'

// Cache TTLs (seconds). Short, because invalidation keeps them fresh on writes;
// the TTL is just a safety net for anything we miss.
const INBOX_TTL = 60
const HISTORY_TTL = 120

/**
 * Invalidate all chat caches affected by a change in `chatId`:
 * the chat's message-history pages and every member's inbox.
 *
 * Bumps each member's inbox *generation* (see cacheKeys.inbox) rather than
 * deleting the current inbox cache key outright. A plain delete has a race:
 * a GET /inbox that started reading just before this runs can still finish
 * and write its (now-stale) result back to that same key *after* the delete,
 * silently reviving stale data for the rest of the TTL -- e.g. a freshly
 * shared meme rendering as "Media" again after a manual refresh. Bumping the
 * generation instead means any such late write lands on the old, now
 * unreferenced key, which nobody reads and which simply expires.
 */
export async function invalidateChatCaches(chatId: string, memberIds?: string[]): Promise<void> {
  try {
    await cache.delByPrefix(cacheKeys.historyPrefix(chatId))
    let ids = memberIds
    if (!ids) {
      const members = await db.select({ userId: chatMembers.userId }).from(chatMembers).where(eq(chatMembers.chatId, chatId))
      ids = members.map((m) => m.userId)
    }
    if (ids && ids.length) {
      await Promise.all(ids.map((id) => cache.incr(cacheKeys.inboxVersion(id))))
    }
  } catch {
    // best-effort
  }
}

/** Invalidate a single user's inbox cache (e.g. when their unread count changes). */
export async function invalidateInbox(userId: string): Promise<void> {
  await cache.incr(cacheKeys.inboxVersion(userId))
}

/**
 * Unread count for a single chat, respecting the same "cleared chat" cutoff
 * computeUserInbox() applies below (messages sent before the user's
 * chatDeletions.deletedAt don't count). This used to be duplicated inline in
 * optimized-socket.ts's emitUnreadCountUpdate WITHOUT that cutoff check, so
 * a message arriving in a chat the recipient had cleared could push a live
 * badge count that disagreed with what a subsequent inbox fetch showed.
 * Kept as a targeted single-chat query (not routed through the cached
 * getUserInbox) since this fires on every message send and only needs one
 * chat's count, not the whole inbox.
 */
export async function getChatUnreadCount(chatId: string, userId: string): Promise<number> {
  const [deletion] = await db.select({ deletedAt: chatDeletions.deletedAt })
    .from(chatDeletions)
    .where(and(eq(chatDeletions.chatId, chatId), eq(chatDeletions.userId, userId)))
    .limit(1)
  const deletedAt = deletion?.deletedAt

  const conditions = [eq(messages.chatId, chatId), eq(messages.isDeleted, false), ne(messages.senderId, userId)]
  if (deletedAt) conditions.push(gt(messages.createdAt, deletedAt))

  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .where(and(
      ...conditions,
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

  return row?.count ?? 0
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
  shared_meme_id?: string | null
}

type ChatRow = typeof chats.$inferSelect
type ChatMessageRow = typeof messages.$inferSelect

/** Bridges Drizzle's camelCase `chats` row back to the snake_case `Chat` shape. */
export function rowToChat(row: ChatRow): Chat {
  return {
    id: row.id,
    created_at: row.createdAt,
    last_message_at: row.lastMessageAt,
  }
}

/** Bridges Drizzle's camelCase `messages` row back to the snake_case `ChatMessage` shape. */
export function rowToChatMessage(row: ChatMessageRow): ChatMessage {
  return {
    id: row.id,
    chat_id: row.chatId,
    sender_id: row.senderId,
    text: row.text,
    media_url: row.mediaUrl,
    media_type: row.mediaType ?? undefined,
    thumbnail: row.thumbnail,
    reply_to_id: row.replyToId ?? undefined,
    created_at: row.createdAt,
    updated_at: row.updatedAt ?? undefined,
    is_edited: row.isEdited ?? undefined,
    is_deleted: row.isDeleted ?? undefined,
    is_view_once: row.isViewOnce,
    view_once_viewed_at: row.viewOnceViewedAt,
    shared_meme_id: row.sharedMemeId,
  }
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
  const existing = await db.select({ chatId: chatMembers.chatId }).from(chatMembers).where(inArray(chatMembers.userId, [a, b]))

  if (existing.length) {
    // Count members per chat_id
    const counts: Record<string, number> = {}
    for (const row of existing) counts[row.chatId] = (counts[row.chatId] || 0) + 1
    const chatId = Object.entries(counts).find(([, c]) => c >= 2)?.[0]
    if (chatId) {
      const rows = await db.select().from(chats).where(eq(chats.id, chatId)).limit(1)
      if (rows[0]) return rowToChat(rows[0])
    }
  }

  // Create a new chat and add members - set last_message_at to now so it appears at top of list
  const chatRows = await db.insert(chats).values({ lastMessageAt: new Date().toISOString() }).returning()
  const chat = rowToChat(chatRows[0])
  await db.insert(chatMembers).values([
    { chatId: chat.id, userId: a },
    { chatId: chat.id, userId: b },
  ])
  return chat
}

export async function getUserInbox(userId: string) {
  // Serve from cache when available — this is the hot path the app polls.
  // Keyed by generation (see invalidateChatCaches) so a bump from a
  // concurrent write can never be silently overwritten by a stale read.
  const generation = (await cache.getJSON<number>(cacheKeys.inboxVersion(userId))) ?? 0
  const cacheKey = cacheKeys.inbox(userId, generation)
  const cached = await cache.getJSON<any[]>(cacheKey)
  if (cached) return cached

  const results = await computeUserInbox(userId)
  // Don't cache empty inboxes for as long; they fill in quickly for new users.
  await cache.setJSON(cacheKey, results, results.length ? INBOX_TTL : 15)
  return results
}

async function computeUserInbox(userId: string) {
  // Get chats the user is a member of
  const memberships = await db.select({ chatId: chatMembers.chatId }).from(chatMembers).where(eq(chatMembers.userId, userId))
  const chatIds = memberships.map((m) => m.chatId)
  if (!chatIds.length) return []

  // Fetch chats
  const chatRows = await db.select().from(chats).where(inArray(chats.id, chatIds))
    .orderBy(sql`${chats.lastMessageAt} DESC NULLS LAST`)
  const userChats = chatRows.map(rowToChat)

  // For each chat, find the other participant to display name
  const results = [] as Array<{ chat: Chat; lastMessage: ChatMessage | null; unreadCount: number; otherId?: string; otherName?: string; otherProfilePhoto?: string }>
  // Preload members for all chats
  const memberRows = await db.select({ chatId: chatMembers.chatId, userId: chatMembers.userId }).from(chatMembers).where(inArray(chatMembers.chatId, chatIds))
  const otherIdsSet = new Set<string>()
  // Get user's chat deletion records to filter out cleared chats and messages
  const deletionRows = await db.select({ chatId: chatDeletions.chatId, deletedAt: chatDeletions.deletedAt }).from(chatDeletions).where(eq(chatDeletions.userId, userId))

  const deletionMap = new Map(deletionRows.map((d) => [d.chatId, d.deletedAt]))

  // --- Last message per chat: one query, not N ---
  // `DISTINCT ON (chat_id) ... ORDER BY chat_id, created_at DESC` gets the
  // single latest (non-deleted) message per chat in one round trip using the
  // existing (chat_id, created_at) index, replacing what used to be N
  // parallel per-chat queries (still N round trips even though they ran
  // concurrently). The per-chat "cleared chat" cutoff is applied after the
  // fact in JS below rather than in the query itself (each chat can have a
  // different deletedAt, which doesn't fit a single DISTINCT ON): if the
  // globally-latest message for a chat is at or before that chat's cutoff,
  // then by definition every message in that chat is at or before it too, so
  // the result is the same as if the cutoff had been applied in SQL --
  // just null it out instead of using it.
  const latestPerChat = chatIds.length
    ? await db.selectDistinctOn([messages.chatId])
        .from(messages)
        .where(and(inArray(messages.chatId, chatIds), eq(messages.isDeleted, false)))
        .orderBy(messages.chatId, desc(messages.createdAt))
    : []
  const latestByChat = new Map(latestPerChat.map((row) => [row.chatId, row]))

  const lastMessages = userChats.map((chat) => {
    const deletedAt = deletionMap.get(chat.id)
    const row = latestByChat.get(chat.id)
    // Date(...), not a raw string >: these columns are `timestamp(..., {
    // mode: 'string' })`, i.e. raw Postgres text, not guaranteed to be
    // lexicographically comparable -- same reasoning already applied to the
    // deletion cutoff in the unread-count block below (`new Date(m.createdAt)
    // > new Date(deletedAt)`), mirrored here for consistency.
    const visibleRow = row && (!deletedAt || new Date(row.createdAt) > new Date(deletedAt)) ? row : undefined
    return { chat, deletedAt, lastMessage: visibleRow ? rowToChatMessage(visibleRow) : null }
  })

  // Keep only chats that should appear in the inbox (cleared+empty chats drop out).
  const visible = lastMessages.filter(({ deletedAt, lastMessage }) => !(deletedAt && !lastMessage))
  const visibleChatIds = visible.map(v => v.chat.id)

  // --- Unread counts: 2 batched queries total (was 2 per chat + a receipt-history
  //     scan per chat). Fetch all candidate unread messages for the visible chats,
  //     then all of the user's read receipts for those messages, in one round trip each. ---
  const unreadByChat = new Map<string, number>()
  if (visibleChatIds.length) {
    const candidateMsgs = await db.select({ id: messages.id, chatId: messages.chatId, createdAt: messages.createdAt })
      .from(messages)
      .where(and(inArray(messages.chatId, visibleChatIds), eq(messages.isDeleted, false), ne(messages.senderId, userId)))

    // Apply per-chat clear date and collect ids.
    const perChatMsgIds = new Map<string, string[]>()
    const allMsgIds: string[] = []
    for (const m of candidateMsgs) {
      const deletedAt = deletionMap.get(m.chatId)
      if (deletedAt && !(new Date(m.createdAt) > new Date(deletedAt))) continue
      const arr = perChatMsgIds.get(m.chatId) || []
      arr.push(m.id)
      perChatMsgIds.set(m.chatId, arr)
      allMsgIds.push(m.id)
    }

    // One query for the user's read receipts across all those messages.
    const readSet = new Set<string>()
    if (allMsgIds.length) {
      // Chunk to stay within parameter limits on very large inboxes.
      const chunkSize = 500
      for (let i = 0; i < allMsgIds.length; i += chunkSize) {
        const chunk = allMsgIds.slice(i, i + chunkSize)
        const reads = await db.select({ messageId: messageReceipts.messageId }).from(messageReceipts)
          .where(and(eq(messageReceipts.status, 'read'), eq(messageReceipts.userId, userId), inArray(messageReceipts.messageId, chunk)))
        for (const r of reads) readSet.add(r.messageId)
      }
    }

    for (const [chatId, ids] of perChatMsgIds.entries()) {
      unreadByChat.set(chatId, ids.filter(id => !readSet.has(id)).length)
    }
  }

  for (const { chat, lastMessage } of visible) {
    const mems = memberRows.filter((m) => m.chatId === chat.id)
    const otherId = mems.map((m) => m.userId).find((id) => id !== userId)
    if (otherId) otherIdsSet.add(otherId)
    results.push({ chat, lastMessage, unreadCount: unreadByChat.get(chat.id) || 0, otherId })
  }

  // fetch names and profile photos for others - exclude suspended/deleted accounts
  if (otherIdsSet.size) {
    const profileRows = await db.select({
      id: profiles.id,
      firstName: profiles.firstName,
      lastName: profiles.lastName,
      profilePhotoUrl: profiles.profilePhotoUrl,
      isSuspended: profiles.isSuspended,
      deletedAt: profiles.deletedAt,
    }).from(profiles).where(inArray(profiles.id, Array.from(otherIdsSet)))

    // Filter out suspended/deleted users
    const activeProfiles = profileRows.filter((p) => !p.deletedAt && !p.isSuspended)
    const nameMap = new Map(activeProfiles.map((p) => [p.id, `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim()]))
    const photoMap = new Map(activeProfiles.map((p) => [p.id, p.profilePhotoUrl]))
    // Track which users are suspended/deleted
    const suspendedOrDeletedIds = new Set(
      profileRows.filter((p) => p.deletedAt || p.isSuspended).map((p) => p.id)
    )
    for (const item of results) {
      if (item.otherId) {
        // Mark suspended/deleted users
        if (suspendedOrDeletedIds.has(item.otherId)) {
          item.otherName = 'Deleted User'
          item.otherProfilePhoto = undefined
        } else {
          item.otherName = nameMap.get(item.otherId)
          item.otherProfilePhoto = photoMap.get(item.otherId) ?? undefined
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
      const receipts = await db.select({ messageId: messageReceipts.messageId, status: messageReceipts.status })
        .from(messageReceipts)
        .where(inArray(messageReceipts.messageId, userMessageIds))
        .orderBy(desc(messageReceipts.createdAt))

      // Create a map of message_id -> highest status
      const statusMap = new Map<string, string>();

      for (const receipt of receipts) {
        const currentStatus = statusMap.get(receipt.messageId)
        // Priority: read > delivered
        if (!currentStatus ||
            (receipt.status === 'read') ||
            (receipt.status === 'delivered' && currentStatus !== 'read')) {
          statusMap.set(receipt.messageId, receipt.status);
        }
      }

      // Apply status to messages
      for (const item of results) {
        if (item.lastMessage && item.lastMessage.sender_id === userId) {
          const status = statusMap.get(item.lastMessage.id) || 'sent';
          (item.lastMessage as any).status = status;
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

  // If userId is provided, filter out messages that were sent before the user cleared the chat
  let deletedAfter: string | undefined
  if (userId) {
    const delRows = await db.select({ deletedAt: chatDeletions.deletedAt }).from(chatDeletions)
      .where(and(eq(chatDeletions.chatId, chatId), eq(chatDeletions.userId, userId))).limit(1)
    deletedAfter = delRows[0]?.deletedAt
  }

  const whereConditions = [eq(messages.chatId, chatId), eq(messages.isDeleted, false)]
  if (before) whereConditions.push(lt(messages.createdAt, before))
  if (deletedAfter) whereConditions.push(gt(messages.createdAt, deletedAfter))

  const rowsRaw = await db.query.messages.findMany({
    where: and(...whereConditions),
    orderBy: desc(messages.createdAt),
    limit,
    with: {
      messageReactions: {
        columns: { id: true, userId: true, emoji: true, createdAt: true },
      },
      messageReceipts: {
        columns: { userId: true, status: true },
      },
    },
  })

  const rows = rowsRaw
    .map((m) => ({
      ...rowToChatMessage(m),
      reactions: m.messageReactions.map((r) => ({
        id: r.id,
        message_id: m.id,
        user_id: r.userId,
        emoji: r.emoji,
        created_at: r.createdAt ?? '',
      })),
      receipts: m.messageReceipts.map((r) => ({ user_id: r.userId, status: r.status })),
    }))
    .map(stripViewOnceMedia)

  if (cacheable) await cache.setJSON(histKey, rows, HISTORY_TTL)
  return rows
}

export async function getRecentChatTextMessagesForModeration(chatId: string, limit = 10) {
  const rows = await db.select({
    id: messages.id, chatId: messages.chatId, senderId: messages.senderId, text: messages.text,
    createdAt: messages.createdAt, isDeleted: messages.isDeleted, mediaUrl: messages.mediaUrl, mediaType: messages.mediaType,
  }).from(messages)
    .where(and(eq(messages.chatId, chatId), eq(messages.isDeleted, false)))
    .orderBy(desc(messages.createdAt))
    .limit(limit)

  // Return only text messages (ignore media-only messages for context)
  return rows
    .filter((m) => typeof m.text === 'string' && m.text.trim().length > 0)
    .map((m) => ({
      sender_id: m.senderId,
      text: String(m.text),
      created_at: m.createdAt,
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
  isViewOnce?: boolean,
  sharedMemeId?: string,
  // Optional: pass this when the caller already resolved the chat's member
  // list moments earlier (e.g. optimized-socket.ts's chat:message handler
  // via getCachedChatMembers) so invalidateChatCaches below doesn't have to
  // re-fetch it from the DB again on every single message send. Callers that
  // don't have it handy (REST routes) can omit it -- invalidateChatCaches
  // fetches it itself when not given.
  memberIds?: string[]
): Promise<ChatMessage> {
  // Insert the message
  const messageData: typeof messages.$inferInsert = {
    chatId,
    senderId,
    text: text || '' // Allow empty text for media messages
  }

  // Add media fields if provided
  if (mediaUrl) messageData.mediaUrl = mediaUrl
  if (mediaType) messageData.mediaType = mediaType
  if (thumbnail) messageData.thumbnail = thumbnail
  if (replyToId) messageData.replyToId = replyToId
  if (isViewOnce) messageData.isViewOnce = true
  if (sharedMemeId) messageData.sharedMemeId = sharedMemeId

  const insertedRows = await db.insert(messages).values(messageData).returning()
  const data = rowToChatMessage(insertedRows[0])

  // Update chat last_message_at (best-effort)
  try {
    await db.update(chats).set({ lastMessageAt: data.created_at ?? new Date().toISOString() }).where(eq(chats.id, chatId))
  } catch {}

  // A new message changes both the chat history and every member's inbox.
  await invalidateChatCaches(chatId, memberIds)

  return stripViewOnceMedia(data)
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
  const existingRows = await db.select().from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.chatId, chatId))).limit(1)
  const existing = existingRows[0]

  if (!existing || !existing.isViewOnce) return { ok: false, reason: 'not_found' }
  if (existing.senderId === requestingUserId) return { ok: false, reason: 'sender_cannot_view' }
  if (existing.viewOnceViewedAt) return { ok: false, reason: 'already_viewed' }

  const updatedRows = await db.update(messages)
    .set({ viewOnceViewedAt: new Date().toISOString() })
    .where(and(eq(messages.id, messageId), isNull(messages.viewOnceViewedAt))) // conditional — only the first caller wins the race
    .returning({ mediaUrl: messages.mediaUrl, mediaType: messages.mediaType, senderId: messages.senderId })

  const updated = updatedRows[0]
  if (!updated) return { ok: false, reason: 'already_viewed' } // lost the race

  return {
    ok: true,
    mediaUrl: existing.mediaUrl ?? null,
    mediaType: existing.mediaType ?? null,
    senderId: existing.senderId,
  }
}

export async function insertReceipt(messageId: string, userId: string, status: 'delivered' | 'read') {
  try {
    // Use onConflictDoNothing to handle duplicates gracefully without errors
    await db.insert(messageReceipts)
      .values({ messageId, userId, status })
      .onConflictDoNothing({ target: [messageReceipts.messageId, messageReceipts.userId, messageReceipts.status] })

    // A 'read' receipt clears unread for this user — refresh their inbox cache.
    if (status === 'read') {
      await invalidateInbox(userId)
    }
  } catch (error) {
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
  const msgRows = await db.select({ id: messages.id, senderId: messages.senderId, chatId: messages.chatId })
    .from(messages).where(eq(messages.id, messageId)).limit(1)
  const msg = msgRows[0]
  if (!msg || msg.senderId !== userId) {
    const e: any = new Error('Forbidden')
    e.status = 403
    throw e
  }

  // Update the message
  const updatedRows = await db.update(messages).set({
    text: newText,
    updatedAt: new Date().toISOString(),
    isEdited: true,
  }).where(eq(messages.id, messageId)).returning()
  const data = rowToChatMessage(updatedRows[0])
  await invalidateChatCaches(msg.chatId)
  return data
}

export async function deleteMessage(chatId: string, messageId: string, userId: string) {
  // ensure ownership
  const msgRows = await db.select({ id: messages.id, chatId: messages.chatId, senderId: messages.senderId })
    .from(messages).where(eq(messages.id, messageId)).limit(1)
  const msg = msgRows[0]
  if (!msg || msg.chatId !== chatId || msg.senderId !== userId) {
    const e: any = new Error('Forbidden')
    e.status = 403
    throw e
  }

  // Soft delete by marking as deleted instead of hard delete
  // Keep original text intact - only mark as deleted
  await db.update(messages).set({
    isDeleted: true,
    updatedAt: new Date().toISOString(),
  }).where(eq(messages.id, messageId))
  await invalidateChatCaches(chatId)
}

export async function toggleReaction(messageId: string, userId: string, emoji: string): Promise<{ action: 'added' | 'removed', reaction?: MessageReaction }> {
  // Check if reaction already exists
  const existingRows = await db.select().from(messageReactions)
    .where(and(eq(messageReactions.messageId, messageId), eq(messageReactions.userId, userId), eq(messageReactions.emoji, emoji)))
    .limit(1)
  const existing = existingRows[0]

  if (existing) {
    // Reaction exists, remove it
    await db.delete(messageReactions).where(eq(messageReactions.id, existing.id))
    return { action: 'removed', reaction: rowToMessageReaction(existing) }
  }

  // Add new reaction
  const insertedRows = await db.insert(messageReactions).values({ messageId, userId, emoji }).returning()
  return { action: 'added', reaction: rowToMessageReaction(insertedRows[0]) }
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
  await db.delete(messageReactions).where(
    and(eq(messageReactions.messageId, messageId), eq(messageReactions.userId, userId), eq(messageReactions.emoji, emoji))
  )
}

function rowToMessageReaction(row: typeof messageReactions.$inferSelect): MessageReaction {
  return {
    id: row.id,
    message_id: row.messageId,
    user_id: row.userId,
    emoji: row.emoji,
    created_at: row.createdAt ?? '',
  }
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

function rowToChatMuteSetting(row: typeof chatMuteSettings.$inferSelect): ChatMuteSetting {
  return {
    id: row.id,
    user_id: row.userId,
    chat_id: row.chatId,
    is_muted: row.isMuted ?? false,
    muted_until: row.mutedUntil,
    created_at: row.createdAt ?? '',
    updated_at: row.updatedAt ?? '',
  }
}

export async function getChatMuteSetting(userId: string, chatId: string): Promise<ChatMuteSetting | null> {
  try {
    const rows = await db.select().from(chatMuteSettings)
      .where(and(eq(chatMuteSettings.userId, userId), eq(chatMuteSettings.chatId, chatId)))
      .limit(1)
    return rows[0] ? rowToChatMuteSetting(rows[0]) : null
  } catch (error) {
    console.error('Failed to get chat mute setting:', error)
    return null // Default to not muted if there's an error
  }
}

export async function setChatMuteSetting(userId: string, chatId: string, isMuted: boolean, mutedUntil?: string): Promise<ChatMuteSetting> {
  try {
    const rows = await db.insert(chatMuteSettings).values({
      userId,
      chatId,
      isMuted,
      mutedUntil: mutedUntil || null,
      updatedAt: new Date().toISOString(),
    }).onConflictDoUpdate({
      target: [chatMuteSettings.userId, chatMuteSettings.chatId],
      set: {
        isMuted,
        mutedUntil: mutedUntil || null,
        updatedAt: new Date().toISOString(),
      },
    }).returning()
    return rowToChatMuteSetting(rows[0])
  } catch (error) {
    console.error('Failed to set chat mute setting:', error)
    throw error
  }
}

export async function isChatMuted(userId: string, chatId: string): Promise<boolean> {
  const setting = await getChatMuteSetting(userId, chatId)

  if (!setting) {
    return false
  }

  // Check if temporarily muted and time has expired
  if (setting.muted_until) {
    const mutedUntil = new Date(setting.muted_until)
    const now = new Date()
    if (now > mutedUntil) {
      // Mute period expired, update setting
      await setChatMuteSetting(userId, chatId, false)
      return false
    }
  }

  return setting.is_muted
}

export async function getMessageReactions(messageId: string): Promise<MessageReaction[]> {
  const rows = await db.select().from(messageReactions)
    .where(eq(messageReactions.messageId, messageId))
    .orderBy(messageReactions.createdAt)
  return rows.map(rowToMessageReaction)
}
