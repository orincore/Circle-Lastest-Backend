# Batch 2c: optimized-socket.ts Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite all 38 supabase call sites in `src/server/sockets/optimized-socket.ts` (~2184 lines, the live socket layer) to Drizzle ORM against the local Postgres replica, delete the dead `src/server/sockets/index.ts`, and finish Batch 2 (Chat) of the migration.

**Architecture:** Six tasks. Task 1 migrates the module-level helper functions and adds one shared `fetchChatMemberIds` helper reused by later tasks. Tasks 2–5 migrate the socket event handlers in coherent groups (receipts/read-state, send path, reactions/typing/profile, social+clear). Task 5 removes the `supabase` import (last usage). Task 6 deletes the dead `sockets/index.ts`, adds `socket.io-client` as a devDependency, and runs an end-to-end two-client socket smoke test. Per-task verification is type-check + targeted query smoke scripts (handlers are closures and can't be invoked directly); the full behavioral check happens in Task 6.

**Tech Stack:** Drizzle ORM (`drizzle-orm/node-postgres`), `pg` Pool via `src/server/config/db.ts`, Socket.IO, tsx.

## Global Constraints

(Conventions from `docs/superpowers/specs/2026-07-05-supabase-to-postgres-migration-design.md` plus facts verified during planning.)

- **camelCase ↔ snake_case bridge.** Drizzle rows are camelCase; every socket-emitted payload must keep its exact current shape. Convert at the emit boundary.
- **`db.execute(sql\`...\`)` returns raw driver rows** with snake_case column names (`result.rows`); only `db.select()` returns camelCase.
- **No payload shape changes** except where this plan explicitly documents a behavior fix.
- **No test framework.** Verification = `npx tsc --noEmit -p .` + tsx smoke scripts. `npx tsx -e` cannot use top-level await — write temp `.mts` files at the worktree root, delete before committing.
- **Verified during planning (local replica `pg_proc` / `information_schema`):**
  - `get_unread_count` does **NOT** exist → drop that RPC path entirely; its fallback becomes the only (single-query) path.
  - `mark_chat_messages_read(p_chat_id uuid, p_user_id uuid) returns integer` **DOES** exist → keep calling it via `db.execute(sql\`select mark_chat_messages_read(...)\`)`.
  - `friend_requests` is **NOT a table** — only the view `friend_requests_view` exists (over `friendships` where status='pending', exported in schema.ts as `friendRequestsView` with columns `id, senderId, receiverId, status, createdAt, updatedAt`). The old `supabase.from('friend_requests')` in `notifications:get` therefore always errored (in production too — the replica is a full dump of Supabase's public schema); the handler was dead. Migrating to the view **fixes** it (documented behavior fix).
  - `chat_members` has **no `id` column** (composite PK). `chat:clear`'s old membership check selected `id, user_id, chat_id` → always errored → always fell to the "has sent a message" fallback. Fixed by this migration (same fix as Batch 2b's DELETE /:chatId).
  - `message_receipts` unique index: `(message_id, user_id, status)`. `chat_deletions` unique: `(chat_id, user_id)`. `matchmaking_proposals` columns are literally `a` and `b` (schema properties `a`, `b`). `blocks` → `blockerId`/`blockedId`.
- **`chat.repo.ts` is already Drizzle** — its imported functions (`insertReceipt`, `insertMessage`, etc.) are correct as-is; never reimplement them.
- The old `chat:mark-all-read` fallback string-interpolated `userId` into a raw SQL subquery (SQL-injection-shaped). The Drizzle rewrite removes this by construction.
- Server: `npx tsx src/index.ts`, port 8080, WebSocket path `/ws` wait — Socket.IO default path is used by `initOptimizedSocket`; the smoke script in Task 6 connects with `io('http://localhost:8080', { auth: { token } })` and must match however the server reads auth (check `optimized-socket.ts`'s connection middleware — it reads the JWT from `socket.handshake.auth.token` or `socket.handshake.headers.authorization`; the smoke script passes both).
- JWT for smoke tests: `signJwt({ sub, email, username })` from `src/server/utils/jwt.ts`.

---

### Task 1: Module-level helpers (lines ~1–281)

**Files:**
- Modify: `src/server/sockets/optimized-socket.ts` — imports; `emitUnreadCountUpdate`; `flushPendingDeliveries`; `broadcastPresenceToPartners`; `getCachedChatMembers`; `isBlocked`; `areFriends`. Nothing below line ~300 changes in this task.

**Interfaces:**
- Consumes: `db` from `../config/db.js`; tables from `../db/schema.js`.
- Produces: `fetchChatMemberIds(chatId: string): Promise<string[]>` — a new file-local (NOT exported) helper returning all member user-ids of a chat, used by Tasks 2, 3, 4. Also the migrated `emitUnreadCountUpdate(chatId, userId)` (same signature) used everywhere already.

- [ ] **Step 1: Replace the supabase import (line 8) with Drizzle imports**

```ts
import { and, desc, eq, gt, inArray, ne, notExists, notInArray, or, sql } from 'drizzle-orm'
import { db } from '../config/db.js'
import {
  blindDateMatches,
  blocks,
  chatDeletions,
  chatMembers,
  friendRequestsView,
  friendships,
  matchmakingProposals,
  messageReceipts,
  messages,
  profiles,
} from '../db/schema.js'
```

(All of these are used by the end of Task 5; if the type-checker flags any as unused during Tasks 1–4, that's expected — leave them, Task 5 consumes the rest. If lint/tsc `noUnusedLocals` blocks it, add only what each task needs and let the final task's import list match this one.)

- [ ] **Step 2: Rewrite `emitUnreadCountUpdate` (drop the dead RPC, one count query)**

Replace the entire function body:

```ts
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
```

(The `get_unread_count` RPC does not exist in the replica; its fallback's exact semantics are this one query — same code Batch 2b shipped in chat.routes.ts.)

- [ ] **Step 3: Add `fetchChatMemberIds` right after `emitUnreadCountUpdate`**

```ts
// All member user-ids of a chat, straight from Postgres (no cache).
// Shared by handlers that fan events out to every member.
async function fetchChatMemberIds(chatId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: chatMembers.userId })
    .from(chatMembers)
    .where(eq(chatMembers.chatId, chatId))
  return rows.map((r) => r.userId)
}
```

- [ ] **Step 4: Rewrite `flushPendingDeliveries`**

Replace the three supabase queries; the receipt-insert/emit loop below them is unchanged except property names:

```ts
async function flushPendingDeliveries(userId: string) {
  try {
    const memberships = await db
      .select({ chatId: chatMembers.chatId })
      .from(chatMembers)
      .where(eq(chatMembers.userId, userId))
    const chatIds = memberships.map(m => m.chatId)
    if (chatIds.length === 0) return

    // Recent messages from OTHERS across the user's chats.
    const msgs = await db
      .select({ id: messages.id, senderId: messages.senderId, chatId: messages.chatId })
      .from(messages)
      .where(and(
        inArray(messages.chatId, chatIds),
        ne(messages.senderId, userId),
        eq(messages.isDeleted, false),
      ))
      .orderBy(desc(messages.createdAt))
      .limit(500)
    if (msgs.length === 0) return

    const msgIds = msgs.map(m => m.id)

    // Skip any that already have a delivered/read receipt by this user.
    const receipts = await db
      .select({ messageId: messageReceipts.messageId })
      .from(messageReceipts)
      .where(and(
        eq(messageReceipts.userId, userId),
        inArray(messageReceipts.status, ['delivered', 'read']),
        inArray(messageReceipts.messageId, msgIds),
      ))
    const alreadyDone = new Set(receipts.map(r => r.messageId))

    const pending = msgs.filter(m => !alreadyDone.has(m.id))
    if (pending.length === 0) return

    for (const m of pending) {
      try {
        await insertReceipt(m.id, userId, 'delivered')
        // chatId is required so the conversation screen's receipt handler
        // (which filters by chatId) actually applies the update.
        emitToUser(m.senderId, 'chat:message:delivery_receipt', {
          messageId: m.id,
          userId,
          status: 'delivered',
          chatId: m.chatId,
        })
      } catch (e) {
        logger.error({ error: e, messageId: m.id, userId }, 'Failed to flush delivery for message')
      }
    }
    logger.info({ userId, delivered: pending.length }, 'Flushed pending deliveries on connect')
  } catch (error) {
    logger.error({ error, userId }, 'flushPendingDeliveries failed')
  }
}
```

(Keep the existing doc comment above the function.)

- [ ] **Step 5: Rewrite `broadcastPresenceToPartners`**

```ts
async function broadcastPresenceToPartners(userId: string, isOnline: boolean) {
  try {
    const memberships = await db
      .select({ chatId: chatMembers.chatId })
      .from(chatMembers)
      .where(eq(chatMembers.userId, userId))
    const chatIds = memberships.map(m => m.chatId)
    if (chatIds.length === 0) return

    const others = await db
      .select({ chatId: chatMembers.chatId, userId: chatMembers.userId })
      .from(chatMembers)
      .where(and(inArray(chatMembers.chatId, chatIds), ne(chatMembers.userId, userId)))

    for (const o of others) {
      emitToUser(o.userId, 'chat:presence', {
        chatId: o.chatId,
        userId,           // who this presence is about
        isOnline,
        online: isOnline, // legacy field
      })
    }
  } catch (error) {
    logger.error({ error, userId }, 'Failed to broadcast presence to partners')
  }
}
```

(Keep the existing doc comment.)

- [ ] **Step 6: Rewrite the DB portion of `getCachedChatMembers`**

Only the supabase call changes (Redis caching around it is untouched):

```ts
    const memberIds = await fetchChatMemberIds(chatId)
    if (memberIds.length > 0) {
      await redis.setex(cacheKey, CHAT_MEMBERS_CACHE_TTL, JSON.stringify(memberIds))
      return memberIds
    }
    return null
```

- [ ] **Step 7: Rewrite the DB portion of `isBlocked` and `areFriends`**

`isBlocked` (Redis caching untouched):

```ts
    const blockCheck = await db
      .select({ id: blocks.id })
      .from(blocks)
      .where(or(
        and(eq(blocks.blockerId, userId1), eq(blocks.blockedId, userId2)),
        and(eq(blocks.blockerId, userId2), eq(blocks.blockedId, userId1)),
      ))
      .limit(1)

    const blocked = blockCheck.length > 0
```

`areFriends` (Redis caching untouched):

```ts
    const friendship = await db
      .select({ id: friendships.id })
      .from(friendships)
      .where(and(
        or(
          and(eq(friendships.user1Id, userId1), eq(friendships.user2Id, userId2)),
          and(eq(friendships.user1Id, userId2), eq(friendships.user2Id, userId1)),
        ),
        inArray(friendships.status, ['active', 'accepted']),
      ))
      .limit(1)

    const friends = friendship.length > 0
```

- [ ] **Step 8: Type-check**

Run: `npx tsc --noEmit -p .`
Expected: zero errors (the rest of the file still uses... wait — the `supabase` import was removed in Step 1, so all not-yet-migrated call sites below will error with "Cannot find name 'supabase'". That is the expected temporary state, exactly like Batch 2a: confirm ALL remaining errors are `TS2304 Cannot find name 'supabase'` inside `optimized-socket.ts` at lines belonging to Tasks 2–5's handlers, and NO other errors exist.)

- [ ] **Step 9: Smoke test the helpers against real data**

Write `t1-smoke.mts` at the worktree root:

```ts
import { db } from './src/server/config/db.js'
import { sql } from 'drizzle-orm'

// The helpers are file-local, so replicate their queries 1:1 and compare
// against independent raw-SQL ground truth.
const found: any = await db.execute(sql`
  select cm.chat_id as chat_id, array_agg(cm.user_id::text) as ids
  from chat_members cm group by cm.chat_id having count(*) = 2 limit 1`)
const row = found.rows[0]
if (!row) { console.log('no 2-member chat — skipping'); process.exit(0) }
const [userA] = row.ids as string[]
const chatId = row.chat_id as string

// Ground truth: unread count via raw SQL
const truth: any = await db.execute(sql`
  select count(*)::int as c from messages m
  where m.chat_id = ${chatId} and m.is_deleted = false and m.sender_id <> ${userA}
    and not exists (select 1 from message_receipts r
      where r.message_id = m.id and r.user_id = ${userA} and r.status = 'read')`)
console.log('unread ground truth for', chatId, '=', truth.rows[0].c)

// mark_chat_messages_read exists and is callable via raw SQL
const fn: any = await db.execute(sql`select proname from pg_proc where proname = 'mark_chat_messages_read'`)
console.log('mark_chat_messages_read present:', fn.rows.length === 1)
process.exit(0)
```

Run: `npx tsx t1-smoke.mts` — expect a numeric ground truth and `present: true`. Delete the file.

- [ ] **Step 10: Commit**

```bash
git add src/server/sockets/optimized-socket.ts
git commit -m "feat: migrate optimized-socket module helpers to Drizzle

Drops the get_unread_count RPC call (function absent from the replica;
its fallback becomes the single count query) and adds fetchChatMemberIds
for reuse by the handler migrations that follow.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Receipt & read-state handlers

**Files:**
- Modify: `src/server/sockets/optimized-socket.ts` — handlers `chat:message:delivered` (~line 675), `chat:message:read` (~775), `chat:read` (~1755), `chat:mark-all-read` (~1795).

**Interfaces:**
- Consumes: `fetchChatMemberIds`, `emitUnreadCountUpdate` from Task 1; `db`, schema tables from Task 1's imports; `insertReceipt`, `invalidateChatCaches` from chat.repo (already imported).
- Produces: nothing new.

- [ ] **Step 1: `chat:message:delivered` — replace the message lookup**

```ts
        // Get message to find chat ID
        const [message] = await db
          .select({ chatId: messages.chatId, senderId: messages.senderId })
          .from(messages)
          .where(eq(messages.id, messageId))
          .limit(1)

        if (!message) {
          return
        }

        // Don't mark own messages as delivered
        if (message.senderId === userId) {
          return
        }
```

And in the emit below, `message.sender_id` → `message.senderId`, `chatId: message.chat_id` → `chatId: message.chatId`.

- [ ] **Step 2: `chat:message:read` — replace the message lookup and members loop**

Message lookup: identical pattern to Step 1 (select `chatId`, `senderId` where id, limit 1; guard `!message` and `message.senderId === userId`). Update all `message.chat_id` reads in this handler to `message.chatId` and `message.sender_id` to `message.senderId` (they appear in the two `io.to(...)` emits and the `emitUnreadCountUpdate` calls).

Members loop:

```ts
          // Also get all chat members and emit unread count updates to all of them
          // This ensures the chat list updates for all users when messages are read
          const memberIds = await fetchChatMemberIds(message.chatId)
          for (const memberId of memberIds) {
            if (memberId !== userId) {
              // Emit unread count update to other chat members as well
              await emitUnreadCountUpdate(message.chatId, memberId)
            }
          }
```

- [ ] **Step 3: `chat:read` — replace the members fan-out**

```ts
      // Also send to all chat members individually (for chat list unread count updates)
      try {
        const memberIds = await fetchChatMemberIds(chatId)
        for (const memberId of memberIds) {
          io.to(memberId).emit('chat:read', { chatId, messageId, by: userId })
        }

        // Emit updated unread count to the user who read the message
        await emitUnreadCountUpdate(chatId, userId)
      } catch (error) {
        logger.error({ error, chatId, messageId, userId }, 'Failed to send read receipt to members')
      }
```

- [ ] **Step 4: `chat:mark-all-read` — keep the DB function, rewrite the fallback safely**

```ts
      try {
        // Ultra-efficient: one SQL call marks the whole chat read.
        // mark_chat_messages_read(p_chat_id uuid, p_user_id uuid) returns integer
        // exists in the database (verified in pg_proc).
        let rpcFailed = false
        try {
          await db.execute(sql`select mark_chat_messages_read(${chatId}::uuid, ${userId}::uuid)`)
        } catch (rpcError) {
          logger.warn({ error: rpcError, chatId, userId }, 'mark_chat_messages_read failed, using fallback')
          rpcFailed = true
        }

        if (rpcFailed) {
          // Fallback: mark only unread messages, batched
          const unreadMessages = await db
            .select({ id: messages.id })
            .from(messages)
            .where(and(
              eq(messages.chatId, chatId),
              notInArray(
                messages.id,
                db.select({ messageId: messageReceipts.messageId })
                  .from(messageReceipts)
                  .where(and(eq(messageReceipts.userId, userId), eq(messageReceipts.status, 'read')))
              ),
            ))
            .orderBy(desc(messages.createdAt))
            .limit(50)

          if (!unreadMessages.length) {
            socket.emit('chat:mark-all-read:confirmed', { chatId, success: true, markedCount: 0 })
            return
          }

          await db
            .insert(messageReceipts)
            .values(unreadMessages.map(msg => ({
              messageId: msg.id,
              userId,
              status: 'read' as const,
            })))
            .onConflictDoNothing({
              target: [messageReceipts.messageId, messageReceipts.userId, messageReceipts.status],
            })
        }

        // Unread count for this user changed — drop their inbox cache so the
        // chat list reflects zero unread immediately.
        await invalidateChatCaches(chatId)

        // Emit minimal events for real-time updates
        io.to(`chat:${chatId}`).emit('chat:all-read', { chatId, by: userId })
        socket.emit('chat:mark-all-read:confirmed', { chatId, success: true })

      } catch (error) {
        console.error('❌ Error in chat:mark-all-read:', error)
        socket.emit('chat:mark-all-read:confirmed', { chatId, success: false })
      }
```

(Fixes the string-interpolated `userId` SQL injection shape in the old fallback; a failed batch insert now lands in the outer catch and emits `success: false`, same as before.)

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit -p .`
Expected: remaining errors are ONLY `Cannot find name 'supabase'` in Tasks 3–5's handlers (typing #1 ~753, typing #2 ~1425, chat:message ~1609/1620, reaction:toggle ~1898-1909, profile:visit ~2015/2021, friend:status:get ~981, message:request:cancel ~1048/1063, notifications:get ~1111, chat:clear ~1203-1269). No errors in Task 1–2 code.

- [ ] **Step 6: Smoke test mark-all-read semantics**

Write `t2-smoke.mts` at the worktree root:

```ts
import { db } from './src/server/config/db.js'
import { sql } from 'drizzle-orm'

const found: any = await db.execute(sql`
  select m.chat_id as chat_id, m.id as message_id, m.sender_id as sender_id,
         (select cm.user_id from chat_members cm
           where cm.chat_id = m.chat_id and cm.user_id <> m.sender_id limit 1) as reader
  from messages m where m.is_deleted = false limit 1`)
const row = found.rows[0]
if (!row || !row.reader) { console.log('no message+reader pair — skipping'); process.exit(0) }

const before: any = await db.execute(sql`
  select count(*)::int as c from message_receipts
  where user_id = ${row.reader} and status = 'read'`)
await db.execute(sql`select mark_chat_messages_read(${row.chat_id}::uuid, ${row.reader}::uuid)`)
const after: any = await db.execute(sql`
  select count(*)::int as c from message_receipts
  where user_id = ${row.reader} and status = 'read'`)
console.log('read receipts before/after mark_chat_messages_read:', before.rows[0].c, '->', after.rows[0].c)
console.log('function ran without error: true')
process.exit(0)
```

Run: `npx tsx t2-smoke.mts` — expect the function to run without error (count is >= before). Delete the file. (This exercises the real DB function the handler now calls; the full socket round-trip happens in Task 6.)

- [ ] **Step 7: Commit**

```bash
git add src/server/sockets/optimized-socket.ts
git commit -m "feat: migrate socket receipt/read-state handlers to Drizzle

chat:mark-all-read keeps the mark_chat_messages_read DB function (it
exists in the replica) and its fallback no longer string-interpolates
userId into raw SQL.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Send path + typing fan-outs

**Files:**
- Modify: `src/server/sockets/optimized-socket.ts` — handler `chat:typing` (SECOND registration, ~line 1409) and `chat:message` (~1443, supabase sites at ~1609 and ~1620).

**Interfaces:**
- Consumes: `fetchChatMemberIds` from Task 1; `db`, `profiles`, `blindDateMatches` from Task 1's imports.
- Produces: nothing new.

- [ ] **Step 1: `chat:typing` (second registration, ~1425) — replace the members fan-out**

```ts
      // Also send to all chat members individually (for chat list updates)
      try {
        const memberIds = await fetchChatMemberIds(chatId)
        for (const memberId of memberIds) {
          if (memberId !== userId) { // Don't send to sender
            io.to(memberId).emit('chat:typing', { chatId, users: getTyping(chatId) })
          }
        }
      } catch (error) {
        logger.error({ error, chatId, userId }, 'Failed to send typing indicator to members')
      }
```

- [ ] **Step 2: `chat:message` — replace sender-info and blind-match lookups (~1609–1627)**

```ts
          let senderInfo:
            | { firstName: string | null; lastName: string | null; username: string | null; email: string | null; profilePhotoUrl: string | null }
            | undefined
          try {
            const rows = await db
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
            senderInfo = rows[0]
          } catch (senderError) {
            logger.error({ error: senderError, userId }, 'Error fetching sender info')
          }

          // Check if this is a blind date chat (active, not revealed)
          const [blindMatch] = await db
            .select({ id: blindDateMatches.id })
            .from(blindDateMatches)
            .where(and(eq(blindDateMatches.chatId, chatId), eq(blindDateMatches.status, 'active')))
            .limit(1)

          const isBlindDateChat = !!blindMatch
```

Then in the name-derivation block below (the `maskName` helper itself is unchanged):

```ts
          // Use masked name for blind date chats, real name otherwise
          const realName = senderInfo
            ? (senderInfo.firstName && senderInfo.lastName
                ? `${senderInfo.firstName} ${senderInfo.lastName}`.trim()
                : senderInfo.username || senderInfo.email?.split('@')[0] || 'Someone')
            : 'Someone'

          const senderName = isBlindDateChat
            ? maskName(senderInfo?.firstName || null, senderInfo?.lastName || null)
            : realName

          const senderAvatar = senderInfo?.profilePhotoUrl || null
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit -p .`
Expected: remaining `Cannot find name 'supabase'` errors ONLY in Tasks 4–5's handlers. No errors in Task 1–3 code.

- [ ] **Step 4: Commit**

```bash
git add src/server/sockets/optimized-socket.ts
git commit -m "feat: migrate socket send-path and typing fan-out to Drizzle

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Reactions, first typing handler, profile visits

**Files:**
- Modify: `src/server/sockets/optimized-socket.ts` — handlers `chat:typing` (FIRST registration, ~line 729, supabase at ~753), `chat:reaction:toggle` (~1869, supabase at ~1898/1903/1909), `profile:visit` (~1995, supabase at ~2015/2021).

**Interfaces:**
- Consumes: `fetchChatMemberIds` from Task 1; `db`, `profiles`, `messages` from Task 1's imports; `trackProfileVisited` from activityService (already imported — expects objects shaped `{ id, first_name, last_name }`, snake_case).
- Produces: nothing new.

- [ ] **Step 1: `chat:typing` (first registration, ~753) — replace the members fan-out**

```ts
        // Notify other chat members for chat list badges
        const memberIds = await fetchChatMemberIds(chatId)
        for (const memberId of memberIds) {
          if (memberId !== currentUserId) {
            emitToUser(memberId, 'chat:list:typing', {
              chatId,
              by: currentUserId,
              isTyping: !!isTyping,
            })
          }
        }
```

- [ ] **Step 2: `chat:reaction:toggle` — replace the three lookups (~1898–1913)**

```ts
          try {
            const memberIds = await fetchChatMemberIds(chatId)

            let senderInfo:
              | { firstName: string | null; lastName: string | null; username: string | null; email: string | null }
              | undefined
            try {
              const rows = await db
                .select({
                  firstName: profiles.firstName,
                  lastName: profiles.lastName,
                  username: profiles.username,
                  email: profiles.email,
                })
                .from(profiles)
                .where(eq(profiles.id, userId))
                .limit(1)
              senderInfo = rows[0]
            } catch (senderError) {
              logger.error({ error: senderError, userId }, 'Error fetching sender info for reaction')
            }

            const [messageInfo] = await db
              .select({ text: messages.text })
              .from(messages)
              .where(eq(messages.id, messageId))
              .limit(1)

            const senderName = senderInfo
              ? (senderInfo.firstName && senderInfo.lastName
                  ? `${senderInfo.firstName} ${senderInfo.lastName}`.trim()
                  : senderInfo.username || senderInfo.email?.split('@')[0] || 'Someone')
              : 'Someone'

            for (const memberId of memberIds) {
              if (memberId !== userId) {
                io.to(memberId).emit('chat:reaction:added', {
                  chatId,
                  messageId,
                  reaction: {
                    ...reactionData,
                    senderName
                  },
                  messageText: messageInfo?.text || 'a message'
                })
              }
            }
          } catch (error) {
            logger.error({ error, chatId, messageId, userId }, 'Failed to send reaction notification')
          }
```

- [ ] **Step 3: `profile:visit` — replace the two profile lookups (~2015–2029)**

`trackProfileVisited` expects snake_case objects, so map at the boundary:

```ts
        // Track profile visit activity for live feed
        const [visitorRow] = await db
          .select({ id: profiles.id, firstName: profiles.firstName, lastName: profiles.lastName })
          .from(profiles)
          .where(eq(profiles.id, visitorId))
          .limit(1)

        const [ownerRow] = await db
          .select({ id: profiles.id, firstName: profiles.firstName, lastName: profiles.lastName })
          .from(profiles)
          .where(eq(profiles.id, profileOwnerId))
          .limit(1)

        if (visitorRow && ownerRow) {
          await trackProfileVisited(
            { id: visitorRow.id, first_name: visitorRow.firstName, last_name: visitorRow.lastName },
            { id: ownerRow.id, first_name: ownerRow.firstName, last_name: ownerRow.lastName },
          )
        }
```

(Before writing this, check `trackProfileVisited`'s actual parameter type in `src/server/services/activityService.ts` — if it accepts a wider profile object, the two-field mapping above still satisfies it; if it demands more fields, select and map those too.)

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit -p .`
Expected: remaining `Cannot find name 'supabase'` errors ONLY in Task 5's handlers (`friend:status:get`, `message:request:cancel`, `notifications:get`, `chat:clear`).

- [ ] **Step 5: Commit**

```bash
git add src/server/sockets/optimized-socket.ts
git commit -m "feat: migrate socket reaction/typing/profile-visit handlers to Drizzle

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Social handlers + chat clear (removes last supabase usage)

**Files:**
- Modify: `src/server/sockets/optimized-socket.ts` — handlers `friend:status:get` (~963), `message:request:cancel` (~1032), `notifications:get` (~1099), `chat:clear` (~1178).

**Interfaces:**
- Consumes: `db`, `friendships`, `matchmakingProposals`, `friendRequestsView`, `profiles`, `blindDateMatches`, `chatMembers`, `messages`, `chatDeletions` from Task 1's imports; `invalidateChatCaches` from chat.repo.
- Produces: after this task, `grep -c supabase src/server/sockets/optimized-socket.ts` must be 0.

- [ ] **Step 1: `friend:status:get` — replace the friendship lookup**

```ts
        // Check friendships table for any status (active, pending, accepted)
        const [friendshipData] = await db
          .select({ id: friendships.id, status: friendships.status, senderId: friendships.senderId })
          .from(friendships)
          .where(and(
            or(
              and(eq(friendships.user1Id, currentUserId), eq(friendships.user2Id, targetUserId)),
              and(eq(friendships.user1Id, targetUserId), eq(friendships.user2Id, currentUserId)),
            ),
            inArray(friendships.status, ['active', 'accepted', 'pending']),
          ))
          .limit(1)
```

Body below: `friendshipData.sender_id` → `friendshipData.senderId`; everything else (status derivation, `requestId: friendshipData?.id`, emits) unchanged. The old PGRST116/42P01 error-code special-casing disappears — a real query error now lands in the outer catch, which emits the same `{ error: 'Failed to get friend status' }`.

- [ ] **Step 2: `message:request:cancel` — replace find + update**

```ts
        // Check if there's a pending matchmaking proposal
        const proposals = await db
          .select()
          .from(matchmakingProposals)
          .where(and(
            or(
              and(eq(matchmakingProposals.a, senderId), eq(matchmakingProposals.b, receiverId)),
              and(eq(matchmakingProposals.a, receiverId), eq(matchmakingProposals.b, senderId)),
            ),
            eq(matchmakingProposals.status, 'pending'),
          ))

        if (proposals.length > 0) {
          // Cancel the matchmaking proposal
          const proposal = proposals[0]
          await db
            .update(matchmakingProposals)
            .set({ status: 'cancelled' })
            .where(eq(matchmakingProposals.id, proposal.id))
```

The emitted `proposal` object was previously the raw supabase row (snake_case: `matched_at`, `created_at`, `action_source`). To preserve the payload shape, emit a mapped object:

```ts
          const proposalPayload = {
            id: proposal.id,
            a: proposal.a,
            b: proposal.b,
            status: 'cancelled',
            type: proposal.type,
            matched_at: proposal.matchedAt,
            created_at: proposal.createdAt,
            action_source: proposal.actionSource,
          }

          // Notify receiver that message request was cancelled
          io.to(receiverId).emit('message:request:cancelled', {
            proposal: proposalPayload,
            cancelledBy: senderId
          })

          // Confirm to sender
          socket.emit('message:request:cancel:confirmed', {
            proposal: proposalPayload,
            success: true
          })
```

(Note: the old code emitted the proposal with its pre-update `status: 'pending'`; emitting `status: 'cancelled'` reflects what actually happened and is the value clients should see — documented behavior fix, keep it.)

Error handling: query/update failures now land in the outer catch → same `message:request:error` emit as before; the two early-return error emits for `proposalError`/`cancelError` are removed.

- [ ] **Step 3: `notifications:get` — replace the dead `friend_requests` query with the view + join**

```ts
        // Get pending friend requests for this user.
        // friend_requests is a VIEW (friend_requests_view) over friendships
        // where status = 'pending'; join profiles for the sender card.
        const rows = await db
          .select({
            id: friendRequestsView.id,
            senderId: friendRequestsView.senderId,
            receiverId: friendRequestsView.receiverId,
            status: friendRequestsView.status,
            createdAt: friendRequestsView.createdAt,
            updatedAt: friendRequestsView.updatedAt,
            senderProfileId: profiles.id,
            senderFirstName: profiles.firstName,
            senderLastName: profiles.lastName,
            senderProfilePhotoUrl: profiles.profilePhotoUrl,
          })
          .from(friendRequestsView)
          .leftJoin(profiles, eq(profiles.id, friendRequestsView.senderId))
          .where(and(eq(friendRequestsView.receiverId, userId), eq(friendRequestsView.status, 'pending')))
          .orderBy(desc(friendRequestsView.createdAt))

        const notifications = rows.map(r => ({
          id: r.id,
          sender_id: r.senderId,
          receiver_id: r.receiverId,
          status: r.status,
          created_at: r.createdAt,
          updated_at: r.updatedAt,
          sender: r.senderProfileId ? {
            id: r.senderProfileId,
            first_name: r.senderFirstName,
            last_name: r.senderLastName,
            profile_photo_url: r.senderProfilePhotoUrl,
          } : null,
        }))

        // Send notifications list to user
        socket.emit('notifications:list', { notifications })
```

**Documented behavior fix:** the old `supabase.from('friend_requests')` targeted a relation that doesn't exist (only `friend_requests_view` does — verified against the replica, which is a full dump of Supabase's public schema), so this handler always errored-and-returned and never emitted anything. It now works as designed.

- [ ] **Step 4: `chat:clear` — replace all six call sites**

```ts
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
            socket.emit('chat:clear:error', { error: 'Not authorized to clear this chat' })
            return
          }
          // User is part of the blind date match, allow deletion
        } else {
          // For regular chats, verify user is a member of this chat
          const [membership] = await db
            .select({ userId: chatMembers.userId })
            .from(chatMembers)
            .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, userId)))
            .limit(1)

          if (!membership) {
            // Fallback: Check if user has sent messages in this chat
            const userMessages = await db
              .select({ id: messages.id })
              .from(messages)
              .where(and(eq(messages.chatId, chatId), eq(messages.senderId, userId)))
              .limit(1)

            if (userMessages.length === 0) {
              socket.emit('chat:clear:error', { error: 'Not authorized to clear this chat' })
              return
            }
          }
        }

        // Create user-specific chat deletion record instead of deleting messages for everyone
        // This allows the chat to be cleared for the user who initiated it, but remain visible for others
        // (chat_deletions has unique(chat_id, user_id) — single upsert)
        await db
          .insert(chatDeletions)
          .values({ chatId, userId, deletedAt: new Date().toISOString() })
          .onConflictDoUpdate({
            target: [chatDeletions.chatId, chatDeletions.userId],
            set: { deletedAt: new Date().toISOString() },
          })
```

(Everything after — `invalidateChatCaches`, success emit — unchanged. **Documented behavior fix:** the old membership check selected the nonexistent `chat_members.id`, always errored, and always fell to the sent-a-message fallback; now it checks membership for real — same fix Batch 2b made in the HTTP clear route. An upsert failure now lands in the outer catch → same `chat:clear:error` emit.)

- [ ] **Step 5: Remove the last supabase remnants and type-check**

The `supabase` import was already removed in Task 1. Verify nothing else references it:

Run: `grep -c supabase src/server/sockets/optimized-socket.ts` → expected `0`
Run: `npx tsc --noEmit -p .` → expected: zero errors project-wide.

- [ ] **Step 6: Commit**

```bash
git add src/server/sockets/optimized-socket.ts
git commit -m "feat: migrate socket social + chat-clear handlers to Drizzle; file fully off supabase

Behavior fixes: notifications:get now works (old code queried the
nonexistent friend_requests relation instead of friend_requests_view and
always errored); chat:clear membership check now real (old code selected
nonexistent chat_members.id); message:request:cancelled now emits the
proposal with its post-update status.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Delete dead sockets/index.ts + end-to-end socket smoke test

**Files:**
- Delete: `src/server/sockets/index.ts`
- Modify: `package.json` (add `socket.io-client` to devDependencies)

**Interfaces:**
- Consumes: everything Tasks 1–5 produced.
- Produces: Batch 2 (Chat) complete.

- [ ] **Step 1: Confirm sockets/index.ts is dead, then delete it**

```bash
grep -rn "sockets/index" src/ --include="*.ts" | grep -v optimized
```
Expected: no output (its `emitToUser` consumers were repointed to optimized-socket in commit d590f84; `initSocket` is never called).

```bash
git rm src/server/sockets/index.ts
```

- [ ] **Step 2: Type-check after deletion**

Run: `npx tsc --noEmit -p .`
Expected: zero errors (proves nothing imported the dead file).

- [ ] **Step 3: Add socket.io-client for the smoke test**

```bash
npm install --save-dev socket.io-client
```

- [ ] **Step 4: End-to-end two-client socket smoke test**

Start the server: `npx tsx src/index.ts > /tmp/batch2c-server.log 2>&1 &` then poll `curl -s http://localhost:8080/health` until it answers.

Write `t6-smoke.mts` at the worktree root:

```ts
import { io, type Socket } from 'socket.io-client'
import { db } from './src/server/config/db.js'
import { signJwt } from './src/server/utils/jwt.js'
import { sql } from 'drizzle-orm'

const BASE = 'http://localhost:8080'

const found: any = await db.execute(sql`
  select cm.chat_id as chat_id, array_agg(cm.user_id::text) as ids
  from chat_members cm group by cm.chat_id having count(*) = 2 limit 1`)
const row = found.rows[0]
if (!row) { console.log('no 2-member chat — skipping'); process.exit(0) }
const chatId = row.chat_id as string
const [userA, userB] = row.ids as string[]

async function tokenFor(id: string) {
  const r: any = await db.execute(sql`select id, email, username from profiles where id = ${id}`)
  const p = r.rows[0]
  return signJwt({ sub: p.id, email: p.email, username: p.username })
}

function connect(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = io(BASE, {
      auth: { token },
      extraHeaders: { Authorization: `Bearer ${token}` },
      transports: ['websocket'],
      timeout: 8000,
    })
    s.on('connect', () => resolve(s))
    s.on('connect_error', (e) => reject(e))
  })
}

function waitFor(s: Socket, event: string, ms = 6000): Promise<any> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ __timeout: event }), ms)
    s.once(event, (data) => { clearTimeout(t); resolve(data) })
  })
}

const [sockA, sockB] = await Promise.all([tokenFor(userA).then(connect), tokenFor(userB).then(connect)])
console.log('both sockets connected: true')

const results: Record<string, boolean> = {}

// 1. Send a message A -> chat; B should receive chat:message or chat:message:background
const recvMsg = Promise.race([waitFor(sockB, 'chat:message'), waitFor(sockB, 'chat:message:background')])
sockA.emit('chat:message', { chatId, text: 'batch2c e2e smoke', tempId: 'smoke-1' })
const sent = await waitFor(sockA, 'chat:message:sent')
const gotMsg: any = await recvMsg
results['send+receive message'] = !sent.__timeout && !gotMsg.__timeout
const messageId: string | undefined = sent?.messageId

// 2. B marks it read -> A gets read receipt
if (messageId) {
  const readReceipt = waitFor(sockA, 'chat:message:read_receipt')
  sockB.emit('chat:message:read', { messageId })
  results['read receipt'] = !(await readReceipt).__timeout
}

// 3. B mark-all-read -> confirmed
const confirmed = waitFor(sockB, 'chat:mark-all-read:confirmed')
sockB.emit('chat:mark-all-read', { chatId })
const conf: any = await confirmed
results['mark-all-read confirmed'] = conf?.success === true

// 4. typing fan-out
const typing = waitFor(sockB, 'chat:typing')
sockA.emit('chat:typing', { chatId, isTyping: true })
results['typing fan-out'] = !(await typing).__timeout

// 5. friend:status:get responds
const status = waitFor(sockA, 'friend:status:response')
sockA.emit('friend:status:get', { userId: userB })
const st: any = await status
results['friend status'] = !st.__timeout && typeof st.status === 'string'

// 6. notifications:get responds (fixed handler)
const notifs = waitFor(sockA, 'notifications:list')
sockA.emit('notifications:get')
const nl: any = await notifs
results['notifications list'] = !nl.__timeout && Array.isArray(nl.notifications)

// 7. chat:clear -> success, then clean up the deletion record
const cleared = waitFor(sockA, 'chat:clear:success')
sockA.emit('chat:clear', { chatId })
results['chat clear'] = !(await cleared).__timeout
await db.execute(sql`delete from chat_deletions where chat_id = ${chatId} and user_id = ${userA}`)

// Clean up smoke message
if (messageId) await db.execute(sql`delete from message_receipts where message_id = ${messageId}`)
if (messageId) await db.execute(sql`delete from messages where id = ${messageId}`)

console.log(JSON.stringify(results, null, 2))
sockA.close(); sockB.close()
const failed = Object.entries(results).filter(([, ok]) => !ok)
if (failed.length) { console.error('FAILED:', failed.map(([k]) => k).join(', ')); process.exit(1) }
console.log('ALL SOCKET SMOKE CHECKS PASSED')
process.exit(0)
```

Run: `npx tsx t6-smoke.mts`
Expected: `both sockets connected: true`, every result `true`, final line `ALL SOCKET SMOKE CHECKS PASSED`.

Notes for the implementer: before running, read the connection-auth middleware in `optimized-socket.ts` to confirm how the token is read (`socket.handshake.auth.token` vs `Authorization` header) — the script passes both, but if the server expects something else (e.g. a query param), adapt the `connect()` helper. If `chat:message` requires friendship and the picked pair aren't friends and it isn't a blind-date chat, the send may emit `chat:message:error` — in that case pick a different 2-member chat (e.g. iterate candidates until one is a blind-date chat or a friend pair; chat 96a4d888-71d1-4e49-b244-33cbeb98d625 in the replica is a known active blind-date chat).

Then: `rm t6-smoke.mts`, kill the server.

- [ ] **Step 5: Final exit checks + commit**

```bash
npx tsc --noEmit -p .                                   # zero errors
grep -rn "supabase" src/server/sockets/ | wc -l         # 0
git add package.json package-lock.json
git commit -m "chore: remove dead sockets/index.ts; add socket.io-client for e2e socket smoke tests

sockets/index.ts was never initialized (initSocket had no callers) and
its emitToUser consumers were repointed to optimized-socket in d590f84.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

(Note: `git rm` in Step 1 already staged the deletion; this commit includes it.)

---

## Batch 2c exit criteria

All 6 tasks committed; `npx tsc --noEmit -p .` clean project-wide; zero `supabase` references under `src/server/sockets/`; the Task 6 end-to-end socket smoke passes all checks; server boots cleanly. **This completes Batch 2 (Chat)** — next per the design spec's migration order is Batch 3 (**Friends** — `routes/friends.routes.ts` etc.).
