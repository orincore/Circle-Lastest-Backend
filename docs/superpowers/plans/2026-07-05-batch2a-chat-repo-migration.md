# Batch 2a: chat.repo.ts Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite `src/server/repos/chat.repo.ts` — the canonical data-access layer for chats, messages, reactions, receipts, and mute settings — from `supabase-js` to Drizzle ORM against the local Postgres replica, with zero behavior change for the (not-yet-migrated) route and socket files that import from it.

**Architecture:** One file, migrated in 3 sequential tasks (it's too large — ~780 lines, ~20 exported functions — for one task to stay reviewable). Each migrated function keeps its exact name/signature; three small row-mappers (`rowToChat`, `rowToChatMessage`, `rowToChatDeletion`) bridge Drizzle's camelCase rows back to this file's existing snake_case interfaces (`Chat`, `ChatMessage`, `ChatDeletion`, `MessageReaction`), following the same pattern Batch 1 established with `rowToProfile`. `getChatMessages`'s embedded relation select (`reactions:message_reactions(...)`, `receipts:message_receipts(...)`) becomes a Drizzle relational query (`db.query.messages.findMany({ with: {...} })`), since `messagesRelations` in `src/server/db/relations.ts` already declares `messageReactions: many(messageReactions)` and `messageReceipts: many(messageReceipts)`.

**Tech Stack:** `drizzle-orm` (installed, Phase 0), `db` client + `chats`/`chatMembers`/`messages`/`messageReactions`/`messageReceipts`/`chatDeletions`/`chatMuteSettings`/`profiles` tables from `src/server/db/schema.ts` (introspected, Phase 0).

## Global Constraints

- **This plan covers `chat.repo.ts` only** — `routes/chat.routes.ts`, `routes/chat-list.routes.ts`, and `sockets/optimized-socket.ts` (all of which import from this file, and some of which have their own direct `supabase.from(...)` calls) are separate follow-up plans. Because of that, **this plan's testing is function-level (direct script calls against real data), not full HTTP/socket end-to-end** — that full flow can't be exercised until all of Batch 2's files are migrated.
- **`sockets/index.ts` is dead code — do not touch it.** Its `initSocket` function is exported but never called anywhere (`src/index.ts` only calls `initOptimizedSocket` from `sockets/optimized-socket.ts`). Its several `supabase.from(...)` calls never execute at runtime. Leave this file exactly as-is; it's out of scope for the whole migration until someone decides to delete the dead code (a separate, non-migration decision).
- **camelCase ↔ snake_case bridge** (established in Batch 1): Drizzle's schema properties are camelCase; this file's existing interfaces (`Chat`, `ChatMember`, `ChatMessage`, `MessageReaction`, `ChatDeletion`) are snake_case and used by not-yet-migrated callers — every read maps back via a small `rowToX` function, following the exact pattern `rowToProfile` established in `src/server/repos/profiles.repo.ts`.
- Project uses TypeScript with `"module": "NodeNext"` — relative imports need explicit `.js` extensions.
- The Drizzle client (`db`) is exported from `src/server/config/db.ts`, built with `{ schema }` (Phase 0 Task 6) — so `db.query.<table>.findMany({ with: {...} })` relational queries work, not just `db.select()`.
- `messages` has Drizzle relations already declared (`src/server/db/relations.ts`): `messageReactions: many(messageReactions)`, `messageReceipts: many(messageReceipts)`, `chat: one(chats, ...)`.
- `message_receipts` has a real unique constraint `ux_message_receipts_unique` on `(message_id, user_id, status)` (confirmed in `schema.ts`) — this is what the original `.upsert(..., { onConflict: 'message_id,user_id,status', ignoreDuplicates: true })` targets; Drizzle's equivalent is `.onConflictDoNothing({ target: [messageReceipts.messageId, messageReceipts.userId, messageReceipts.status] })`.
- `message_receipts.status` is a Postgres enum (`message_receipt_status`: `'delivered' | 'read'`), already exported from `schema.ts` as `messageReceiptStatus`.
- No automated test suite exists — verification is direct `npx tsx -e "..."` scripts against real local Postgres data (seeded in Phase 0), matching Batch 1's approach.

---

### Task 1: Chat creation, cache invalidation, and inbox computation

**Files:**
- Modify: `src/server/repos/chat.repo.ts` (imports at the top of the file, plus `invalidateChatCaches`, `invalidateInbox`, the `Chat`/`ChatMember`/`ChatMessage`/`MessageReaction`/`ChatDeletion` interfaces, `stripViewOnceMedia`, `ensureChatForUsers`, `getUserInbox`, `computeUserInbox`)

**Interfaces:**
- Consumes: `db` from `../config/db.js`; `chats`, `chatMembers`, `messages`, `chatDeletions`, `profiles` from `../db/schema.js`.
- Produces: a new exported `rowToChat(row: typeof chats.$inferSelect): Chat` mapper that Task 2 reuses for `insertMessage`'s chat update and Task 3 doesn't need. All existing exports keep their exact names/signatures.

- [ ] **Step 1: Replace the top of the file through `computeUserInbox`**

Replace everything from the top of `src/server/repos/chat.repo.ts` through the end of `computeUserInbox` (i.e. everything before `export async function getChatMessages`) with:

```ts
import { and, desc, eq, gt, inArray, ne } from 'drizzle-orm'
import { db } from '../config/db.js'
import { chats, chatMembers, messages, chatDeletions, profiles } from '../db/schema.js'
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
      const members = await db.select({ userId: chatMembers.userId }).from(chatMembers).where(eq(chatMembers.chatId, chatId))
      ids = members.map((m) => m.userId)
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
  const memberships = await db.select({ chatId: chatMembers.chatId }).from(chatMembers).where(eq(chatMembers.userId, userId))
  const chatIds = memberships.map((m) => m.chatId)
  if (!chatIds.length) return []

  // Fetch chats
  const chatRows = await db.select().from(chats).where(inArray(chats.id, chatIds))
    .orderBy(desc(chats.lastMessageAt).nullsLast())
  const userChats = chatRows.map(rowToChat)

  // For each chat, find the other participant to display name
  const results = [] as Array<{ chat: Chat; lastMessage: ChatMessage | null; unreadCount: number; otherId?: string; otherName?: string; otherProfilePhoto?: string }>
  // Preload members for all chats
  const memberRows = await db.select({ chatId: chatMembers.chatId, userId: chatMembers.userId }).from(chatMembers).where(inArray(chatMembers.chatId, chatIds))
  const otherIdsSet = new Set<string>()
  // Get user's chat deletion records to filter out cleared chats and messages
  const deletionRows = await db.select({ chatId: chatDeletions.chatId, deletedAt: chatDeletions.deletedAt }).from(chatDeletions).where(eq(chatDeletions.userId, userId))

  const deletionMap = new Map(deletionRows.map((d) => [d.chatId, d.deletedAt]))

  // --- Last message per chat (parallel instead of sequential) ---
  const lastMessages = await Promise.all(userChats.map(async (chat) => {
    const deletedAt = deletionMap.get(chat.id)
    const conditions = [eq(messages.chatId, chat.id), eq(messages.isDeleted, false)]
    if (deletedAt) conditions.push(gt(messages.createdAt, deletedAt))
    const rows = await db.select().from(messages).where(and(...conditions)).orderBy(desc(messages.createdAt)).limit(1)
    return { chat, deletedAt, lastMessage: rows[0] ? rowToChatMessage(rows[0]) : null }
  }))

  // Keep only chats that should appear in the inbox (cleared+empty chats drop out).
  const visible = lastMessages.filter(({ deletedAt, lastMessage }) => !(deletedAt && !lastMessage))
  const visibleChatIds = visible.map(v => v.chat.id)

  // --- Unread counts: 2 batched queries total (was 2 per chat + a receipt-history
  //     scan per chat). Fetch all candidate unread messages for the visible chats,
  //     then all of the user's read receipts for those messages, in one round trip each. ---
  const unreadByChat = new Map<string, number>()
  if (visibleChatIds.length) {
    const { messageReceipts } = await import('../db/schema.js')
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
      const { messageReceipts } = await import('../db/schema.js')
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
```

Note: the `await import('../db/schema.js')` for `messageReceipts` inside `computeUserInbox` is intentionally kept as a dynamic import matching the plan's minimal-diff style here — it's fine to instead add `messageReceipts` to the top-level `import { chats, chatMembers, messages, chatDeletions, profiles } from '../db/schema.js'` line and delete both dynamic imports, which is slightly cleaner. Either is acceptable; if you hoist it, make sure both usages inside `computeUserInbox` still resolve.

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit -p .`
Expected: no errors. (The rest of the file, from `getChatMessages` onward, still uses the old `supabase` import at this point — Task 2 removes it. Until then, this step will show errors from the untouched lower half of the file referencing `supabase`, which is expected; only confirm no errors in the code you just replaced. If the type-checker's error list is entirely below the `getChatMessages` line, that's the expected, temporary state.)

- [ ] **Step 3: Manual smoke test against real data**

```bash
npx tsx -e "
import { ensureChatForUsers, getUserInbox, rowToChat } from './src/server/repos/chat.repo.js'
import { db } from './src/server/config/db.js'
import { profiles, chatMembers } from './src/server/db/schema.js'

const someProfiles = await db.select({ id: profiles.id }).from(profiles).limit(2)
if (someProfiles.length < 2) { console.log('Not enough profiles to test with - skipping'); process.exit(0) }
const [a, b] = someProfiles.map(p => p.id)

const chat = await ensureChatForUsers(a, b)
console.log('ensureChatForUsers result has snake_case keys:', 'created_at' in chat, 'last_message_at' in chat)
console.log('Chat:', chat)

const chat2 = await ensureChatForUsers(a, b)
console.log('Calling again returns the same chat (idempotent):', chat.id === chat2.id)

const inbox = await getUserInbox(a)
console.log('Inbox for user', a, 'has', inbox.length, 'entries')
if (inbox.length) console.log('First inbox entry shape check - has chat.created_at:', 'created_at' in inbox[0].chat)
process.exit(0)
"
```
Expected: prints a real chat object with `created_at`/`last_message_at` keys present (not `createdAt`/`lastMessageAt`), confirms calling `ensureChatForUsers` twice with the same pair returns the same chat id, and prints a real inbox array for that user.

- [ ] **Step 4: Commit**

```bash
git add src/server/repos/chat.repo.ts
git commit -m "feat: migrate chat creation and inbox computation in chat.repo.ts to Drizzle"
```

---

### Task 2: Message fetching, moderation, and mutation functions

**Files:**
- Modify: `src/server/repos/chat.repo.ts` (`getChatMessages`, `getRecentChatTextMessagesForModeration`, `insertMessage`, `consumeViewOnceMessage`, `insertReceipt`, `editMessage`, `deleteMessage`)

**Interfaces:**
- Consumes: `rowToChat`, `rowToChatMessage` from Task 1 (same file); `db` from `../config/db.js`; `messages`, `chats`, `chatDeletions`, `messageReceipts` from `../db/schema.js`.
- Produces: same exports as before (`getChatMessages`, `getRecentChatTextMessagesForModeration`, `insertMessage`, `ConsumeViewOnceResult`, `consumeViewOnceMessage`, `insertReceipt`, `editMessage`, `deleteMessage`).

- [ ] **Step 1: Add the new imports this task needs**

At the top of `src/server/repos/chat.repo.ts`, extend the `drizzle-orm` and schema imports Task 1 added to also include what this task's functions need:

```ts
import { and, desc, eq, gt, inArray, isNull, lt, ne } from 'drizzle-orm'
import { chats, chatMembers, messages, chatDeletions, profiles, messageReceipts } from '../db/schema.js'
```

(This replaces Task 1's narrower import lines — the full set of `drizzle-orm` operators and schema tables needed by the whole file so far. `messageReceipts` was previously only reachable via the dynamic `await import(...)` inside `computeUserInbox` — once it's a top-level import, you may simplify those two dynamic imports in `computeUserInbox` to just use the top-level `messageReceipts` binding directly, removing the `const { messageReceipts } = await import('../db/schema.js')` lines.)

- [ ] **Step 2: Replace `getChatMessages` through `deleteMessage`**

Replace everything from `export async function getChatMessages` through the end of `deleteMessage` (i.e. everything before `export async function toggleReaction`) with:

```ts
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
  isViewOnce?: boolean
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

  const insertedRows = await db.insert(messages).values(messageData).returning()
  const data = rowToChatMessage(insertedRows[0])

  // Update chat last_message_at (best-effort)
  try {
    await db.update(chats).set({ lastMessageAt: data.created_at ?? new Date().toISOString() }).where(eq(chats.id, chatId))
  } catch {}

  // A new message changes both the chat history and every member's inbox.
  await invalidateChatCaches(chatId)

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
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit -p .`
Expected: no errors below `toggleReaction` still using `supabase` is expected at this point (Task 3 migrates it) — confirm no errors in the code touched by Tasks 1-2.

- [ ] **Step 4: Manual smoke test against real data**

```bash
npx tsx -e "
import { ensureChatForUsers, insertMessage, getChatMessages, editMessage, deleteMessage, insertReceipt } from './src/server/repos/chat.repo.js'
import { db } from './src/server/config/db.js'
import { profiles } from './src/server/db/schema.js'

const someProfiles = await db.select({ id: profiles.id }).from(profiles).limit(2)
if (someProfiles.length < 2) { console.log('Not enough profiles to test with - skipping'); process.exit(0) }
const [a, b] = someProfiles.map(p => p.id)

const chat = await ensureChatForUsers(a, b)
const msg = await insertMessage(chat.id, a, 'Batch 2a test message')
console.log('Inserted message has snake_case keys:', 'chat_id' in msg, 'sender_id' in msg)

const edited = await editMessage(msg.id, a, 'Batch 2a test message (edited)')
console.log('Edited text:', edited.text, 'is_edited:', edited.is_edited)

await insertReceipt(msg.id, b, 'delivered')
await insertReceipt(msg.id, b, 'read')
console.log('Receipts inserted without error')

const history = await getChatMessages(chat.id, 10)
const found = history.find(m => m.id === msg.id)
console.log('Message appears in history with receipts:', found ? found.receipts.length : 'NOT FOUND')

await deleteMessage(chat.id, msg.id, a)
const historyAfterDelete = await getChatMessages(chat.id, 10)
console.log('Message excluded from history after delete:', !historyAfterDelete.find(m => m.id === msg.id))
process.exit(0)
"
```
Expected: inserted message has `chat_id`/`sender_id` keys (not camelCase), edit shows the new text with `is_edited: true`, receipts insert without error, the message appears in `getChatMessages`'s output with its receipts attached, and after `deleteMessage` it no longer appears in history.

- [ ] **Step 5: Commit**

```bash
git add src/server/repos/chat.repo.ts
git commit -m "feat: migrate message fetch/moderation/mutation functions in chat.repo.ts to Drizzle"
```

---

### Task 3: Reactions and mute settings

**Files:**
- Modify: `src/server/repos/chat.repo.ts` (`toggleReaction`, `addReaction`, `removeReaction`, `getChatMuteSetting`, `setChatMuteSetting`, `isChatMuted`, `getMessageReactions` — the remainder of the file)

**Interfaces:**
- Consumes: `db` from `../config/db.js`; `messageReactions`, `chatMuteSettings` from `../db/schema.js`.
- Produces: same exports as before (`toggleReaction`, `addReaction`, `removeReaction`, `ChatMuteSetting`, `getChatMuteSetting`, `setChatMuteSetting`, `isChatMuted`, `getMessageReactions`). This is the last task for this file — `chat.repo.ts` has zero remaining `supabase` references after this task.

- [ ] **Step 1: Extend the top-of-file imports one more time**

```ts
import { and, desc, eq, gt, inArray, isNull, lt, ne } from 'drizzle-orm'
import { chats, chatMembers, messages, chatDeletions, profiles, messageReceipts, messageReactions, chatMuteSettings } from '../db/schema.js'
```

Also remove the now-unused `import { supabase } from '../config/supabase.js'` line entirely — after this task, nothing in the file references it.

- [ ] **Step 2: Replace `toggleReaction` through the end of the file**

Replace everything from `export async function toggleReaction` through the end of the file with:

```ts
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
```

Note on `setChatMuteSetting`: the original used `.upsert(..., { onConflict: 'user_id,chat_id' })` — the real unique constraint is `chat_mute_settings_user_id_chat_id_key` on `(user_id, chat_id)` (confirmed in `schema.ts`), which the `.onConflictDoUpdate({ target: [chatMuteSettings.userId, chatMuteSettings.chatId], ... })` above targets. Unlike `insertReceipt`'s `onConflictDoNothing`, this one must actually update on conflict (that's the whole point of "set mute status") — confirm this distinction is preserved, don't copy `insertReceipt`'s `onConflictDoNothing` pattern here by mistake.

Also note: the original `getChatMuteSetting`/`setChatMuteSetting` had a special-cased `error.code === '42P01'` branch ("table doesn't exist") with a message like `'chat_mute_settings table does not exist. Please run the database migration.'` — this branch is now dead code to remove, since `chat_mute_settings` is confirmed to exist in the current schema (`schema.ts` line 595) both locally and (since it was faithfully replicated in Phase 0) on the original Supabase source. Don't port that dead branch forward.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit -p .`
Expected: no errors. This is the first point at which the *entire* `chat.repo.ts` file type-checks clean with zero references to `supabase` anywhere in it — confirm with:

Run: `grep -c "supabase" src/server/repos/chat.repo.ts`
Expected: `0`

- [ ] **Step 4: Manual smoke test against real data**

```bash
npx tsx -e "
import { ensureChatForUsers, insertMessage, toggleReaction, getMessageReactions, setChatMuteSetting, getChatMuteSetting, isChatMuted } from './src/server/repos/chat.repo.js'
import { db } from './src/server/config/db.js'
import { profiles } from './src/server/db/schema.js'

const someProfiles = await db.select({ id: profiles.id }).from(profiles).limit(2)
if (someProfiles.length < 2) { console.log('Not enough profiles to test with - skipping'); process.exit(0) }
const [a, b] = someProfiles.map(p => p.id)

const chat = await ensureChatForUsers(a, b)
const msg = await insertMessage(chat.id, a, 'Batch 2a reactions test')

const added = await toggleReaction(msg.id, b, '👍')
console.log('Reaction added:', added.action, added.reaction?.emoji)

const reactions = await getMessageReactions(msg.id)
console.log('getMessageReactions returns it:', reactions.some(r => r.id === added.reaction?.id))

const removed = await toggleReaction(msg.id, b, '👍')
console.log('Toggling again removes it:', removed.action)

const muteSetting = await setChatMuteSetting(a, chat.id, true)
console.log('Mute setting created, is_muted:', muteSetting.is_muted)

const muteSetting2 = await setChatMuteSetting(a, chat.id, false)
console.log('Upsert on conflict updates (not duplicates), is_muted now:', muteSetting2.is_muted, 'same id:', muteSetting.id === muteSetting2.id)

const muted = await isChatMuted(a, chat.id)
console.log('isChatMuted reflects latest value:', muted === false)
process.exit(0)
"
```
Expected: reaction toggles added then removed correctly, `getMessageReactions` reflects it while present, the mute setting upsert reuses the same row id on the second call (confirming `onConflictDoUpdate` targets the right unique constraint rather than erroring or creating a duplicate row), and `isChatMuted` reflects the latest value.

- [ ] **Step 5: Commit**

```bash
git add src/server/repos/chat.repo.ts
git commit -m "feat: migrate reactions and mute settings in chat.repo.ts to Drizzle"
```

---

## Batch 2a exit criteria

All 3 tasks committed, `npx tsc --noEmit -p .` passes, `grep -c "supabase" src/server/repos/chat.repo.ts` returns `0`, and all three tasks' direct-function smoke tests pass against real local Postgres data. `chat.repo.ts`'s public interface (every exported function's name, signature, and snake_case return shape) is unchanged, so `routes/chat.routes.ts`, `routes/chat-list.routes.ts`, and `sockets/optimized-socket.ts` — none of which are touched by this plan — continue to work exactly as before against the same local Postgres data. Those three files, plus their own direct `supabase.from(...)` calls, are separate follow-up plans.
