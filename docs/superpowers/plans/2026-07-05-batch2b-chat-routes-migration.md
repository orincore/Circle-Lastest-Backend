# Batch 2b: chat.routes.ts + chat-list.routes.ts Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the two chat HTTP route files — `src/server/routes/chat.routes.ts` and `src/server/routes/chat-list.routes.ts` — from `supabase-js` to Drizzle ORM against the local Postgres replica, with zero changes to any HTTP response shape.

**Architecture:** Two tasks, one per file, each independently verifiable over real HTTP (boot the server, mint a JWT with the project's own `signJwt`, curl the endpoints). Both files keep their route handlers' structure; only the `supabase.from(...)`/`.rpc(...)` call sites inside them change. `chat.repo.ts` (migrated in Batch 2a) already provides the repo-level functions these routes call — those calls don't change at all.

**Tech Stack:** Drizzle ORM (`drizzle-orm/node-postgres`), `pg` Pool via `src/server/config/db.ts`, Express, tsx for smoke scripts.

## Global Constraints

(Verbatim from `docs/superpowers/specs/2026-07-05-supabase-to-postgres-migration-design.md` "Conventions established in Batch 1", plus batch-specific facts verified during planning.)

- **camelCase ↔ snake_case bridge.** Drizzle's schema properties are camelCase (`firstName`); every HTTP response must keep the exact snake_case / shape it has today. Convert at the response boundary — never change a response key.
- **`db.execute(sql\`...\`)` returns raw driver rows** with snake_case column names; only the query-builder path (`db.select()...`) returns camelCase.
- **No public shape changes.** Response JSON, status codes, and error bodies stay byte-compatible except where this plan explicitly documents a behavior fix.
- **No test framework.** Verification is `npx tsc --noEmit -p .` + smoke scripts run with `npx tsx`.
- **`npx tsx -e "..."` cannot use top-level await** (it compiles CJS). Write smoke scripts to a temporary `.mts` file at the worktree root, run `npx tsx <file>`, delete before committing.
- **Verified during planning:** the `get_unread_count` Postgres function does **NOT** exist in the local replica (checked `pg_proc`). The `supabase.rpc('get_unread_count', ...)` path in chat-list.routes.ts therefore already always fails over to its manual fallback locally. The migration replaces RPC + fallback with one direct SQL count (same semantics as the fallback).
- **Verified during planning:** `chat_deletions` has `unique(chat_id, user_id)`; `chat_user_settings` has `unique(user_id, chat_id)` — both upserts below rely on these.
- **`chat_members` has NO `id` column** (composite PK `chat_id, user_id`). The old code in chat.routes.ts `DELETE /:chatId` selected `chat_members.id` via supabase, which always errored → membership check silently always failed → fell through to the "has this user sent a message here" fallback. Migrating fixes this (documented behavior fix in Task 1).
- Route mounts (from `src/server/app.ts`): chat.routes.ts at **`/chat`** (line 280), chat-list.routes.ts at **`/api/chat-list`** (line 312). Server listens on port 8080 (`npx tsx src/index.ts`).
- JWT for smoke tests: `signJwt({ sub, email, username })` from `src/server/utils/jwt.ts`, header `Authorization: Bearer <token>`.

---

### Task 1: chat.routes.ts

**Files:**
- Modify: `src/server/routes/chat.routes.ts` (imports; `emitUnreadCountUpdate`; handlers `POST /with-user/:userId`, `POST /:chatId/messages`, `DELETE /:chatId`, `GET /:chatId/members`. All other handlers only call already-migrated `chat.repo.ts` functions and are untouched.)

**Interfaces:**
- Consumes: `db` from `../config/db.js`; `blindDateMatches`, `chatDeletions`, `chatMembers`, `friendships`, `messageReceipts`, `messages`, `profiles` from `../db/schema.js`; everything it already imports from `../repos/chat.repo.js` (unchanged).
- Produces: nothing consumed by Task 2 (the two files are independent). A file-local `areFriends(a, b)` helper (not exported).

- [ ] **Step 1: Replace imports and the top-of-file helpers**

Replace the `supabase` import (line 3) and the whole `emitUnreadCountUpdate` function with the following, and add the `areFriends` helper right after `emitUnreadCountUpdate`:

```ts
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
```

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
```

Note: the old `emitUnreadCountUpdate` fetched all message ids then all read-receipt ids and diffed them in JS (O(n²) `includes`); the count query above returns the same number in one round trip.

- [ ] **Step 2: Rewrite `POST /with-user/:userId`**

Replace the friendship check and profile fetch (the two supabase calls) with:

```ts
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
```

And update the response object to use the camelCase row fields (response keys unchanged):

```ts
    res.json({
      chat,
      otherUser: {
        id: userProfile.id,
        name: `${userProfile.firstName || ''} ${userProfile.lastName || ''}`.trim(),
        profilePhoto: userProfile.profilePhotoUrl
      }
    })
```

- [ ] **Step 3: Rewrite `POST /:chatId/messages`**

Three supabase call sites change; everything else in the handler (blind-date filtering, `insertMessage`, socket emits, points) is untouched.

(a) Members fetch:

```ts
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
```

(b) Friendship check (inside `if (!isBlindDate) { ... }`):

```ts
    if (!isBlindDate) {
      if (!(await areFriends(userId, otherUserId))) {
        return res.status(403).json({
          error: 'Messaging not allowed',
          reason: 'not_friends',
          message: 'You can only send messages to friends. Send a friend request first.'
        })
      }
    }
```

(c) Sender info + blind-match lookup inside the post-insert `try` block:

```ts
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
```

Then in the name-derivation code below it, swap the snake_case property reads for camelCase (the `maskName` helper itself is unchanged):

```ts
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
```

- [ ] **Step 4: Rewrite `DELETE /:chatId` (clear conversation)**

Replace the blind-date match check, membership check + fallback, and the select-then-insert/update deletion upsert with:

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
```

**Documented behavior fixes** (call these out in the commit message):
1. The old membership check selected `chat_members.id`, a column that doesn't exist (composite PK) — supabase returned an error, `data` was null, and every member fell through to the "has sent at least one message" fallback. Members who had never sent a message could not clear their chat. Now membership is checked correctly.
2. The old code returned a dedicated 500 body on upsert failure; now a failed upsert throws to the handler's outer catch, which returns the same `{ error: 'Failed to clear chat' }` 500. Net response is identical.

- [ ] **Step 5: Rewrite `GET /:chatId/members`**

Replace both supabase calls (membership check + members-with-profiles fetch):

```ts
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
```

(The old `membershipError` early-return disappears — a query error now throws to the outer catch, producing the handler's existing 500. **Documented behavior fix 3:** the old code read `member.profiles?.[0]?.first_name` — but supabase returns a to-one embed as an object, not an array, so `[0]` was always undefined and every member came back with all-undefined profile fields. The join now actually populates them, which is what the response contract always declared.)

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit -p .`
Expected: zero errors project-wide. (`chat-list.routes.ts` still imports the `supabase` client at this point — that client still exists in `config/supabase.ts`, so it type-checks fine until Task 2 migrates it.)

Also run: `grep -c supabase src/server/routes/chat.routes.ts`
Expected: `0`

- [ ] **Step 7: HTTP smoke test against the running server**

Start the server in the background from the worktree root:

```bash
npx tsx src/index.ts > /tmp/batch2b-server.log 2>&1 &
sleep 10
```

Write `task1-smoke.mts` at the worktree root:

```ts
import { db } from './src/server/config/db.js'
import { signJwt } from './src/server/utils/jwt.js'
import { sql } from 'drizzle-orm'

const BASE = 'http://localhost:8080'

// Find a 1:1 chat with exactly two members
const found: any = await db.execute(sql`
  select cm.chat_id as chat_id, array_agg(cm.user_id::text) as ids
  from chat_members cm
  group by cm.chat_id
  having count(*) = 2
  limit 1`)
const row = found.rows[0]
if (!row) { console.log('No 2-member chat in replica - skipping'); process.exit(0) }
const chatId = row.chat_id as string
const [userA, userB] = row.ids as string[]

const prof: any = await db.execute(sql`select id, email, username from profiles where id = ${userA}`)
const p = prof.rows[0]
const token = signJwt({ sub: p.id, email: p.email, username: p.username })
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

async function check(name: string, resp: Response, expectOk = true) {
  const body = await resp.json().catch(() => null)
  console.log(name, '->', resp.status, JSON.stringify(body)?.slice(0, 180))
  if (expectOk && !resp.ok) { console.error('FAIL:', name); process.exit(1) }
  return body
}

await check('GET /chat/inbox', await fetch(`${BASE}/chat/inbox`, { headers: H }))
await check('GET /chat/:id/messages', await fetch(`${BASE}/chat/${chatId}/messages`, { headers: H }))
const membersBody = await check('GET /chat/:id/members', await fetch(`${BASE}/chat/${chatId}/members`, { headers: H }))
console.log('members have populated profile fields:',
  Array.isArray(membersBody?.members) && membersBody.members.every((m: any) => 'first_name' in m))
await check('GET /chat/:id/mute', await fetch(`${BASE}/chat/${chatId}/mute`, { headers: H }))

// 200 if the pair are friends, 403 { reason: 'not_friends' } otherwise - both prove the new query runs
const withUser = await fetch(`${BASE}/chat/with-user/${userB}`, { method: 'POST', headers: H })
const withUserBody = await withUser.json().catch(() => null)
console.log('POST /chat/with-user ->', withUser.status, JSON.stringify(withUserBody)?.slice(0, 180))
if (![200, 403].includes(withUser.status)) { console.error('FAIL: with-user'); process.exit(1) }

const send = await fetch(`${BASE}/chat/${chatId}/messages`, {
  method: 'POST', headers: H, body: JSON.stringify({ text: 'batch2b smoke test message' })
})
const sendBody = await send.json().catch(() => null)
console.log('POST /chat/:id/messages ->', send.status, JSON.stringify(sendBody)?.slice(0, 180))
if (![200, 403].includes(send.status)) { console.error('FAIL: send message'); process.exit(1) }
if (send.status === 200) {
  // Clean up the smoke message
  await db.execute(sql`delete from messages where id = ${sendBody.message.id}`)
  console.log('cleaned up smoke message')
}

// Clear-chat: exercises membership check + chat_deletions upsert, then restore state
await check('DELETE /chat/:id (clear)', await fetch(`${BASE}/chat/${chatId}`, { method: 'DELETE', headers: H }))
await check('DELETE again (upsert conflict path)', await fetch(`${BASE}/chat/${chatId}`, { method: 'DELETE', headers: H }))
await db.execute(sql`delete from chat_deletions where chat_id = ${chatId} and user_id = ${userA}`)
console.log('cleaned up chat_deletions row')
process.exit(0)
```

Run: `npx tsx task1-smoke.mts`
Expected: every checked endpoint prints 200; `with-user` and send-message print 200 or 403 (`not_friends`); "members have populated profile fields: true"; both DELETE calls 200 (second one proves the `onConflictDoUpdate` path); cleanup lines print.

Then: `rm task1-smoke.mts` and stop the background server (`kill %1` or by PID).

- [ ] **Step 8: Commit**

```bash
git add src/server/routes/chat.routes.ts
git commit -m "feat: migrate chat.routes.ts direct Supabase calls to Drizzle

Behavior fixes: DELETE /:chatId membership check now works (old code
selected a nonexistent chat_members.id and always fell to the fallback);
GET /:chatId/members now returns populated profile fields (old code
indexed a to-one embed as an array, yielding undefined for every field).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: chat-list.routes.ts

**Files:**
- Modify: `src/server/routes/chat-list.routes.ts` (imports; `GET /`; `POST /:chatId/archive`; `POST /:chatId/pin`)

**Interfaces:**
- Consumes: `db` from `../config/db.js`; `blindDateMatches`, `chatDeletions`, `chatUserSettings`, `messageReceipts`, `messages`, `profiles` from `../db/schema.js`; `getUserInbox` from `../repos/chat.repo.js` (unchanged).
- Produces: nothing consumed elsewhere.

- [ ] **Step 1: Replace imports**

Replace `import { supabase } from '../config/supabase.js'` (line 3) with:

```ts
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
```

- [ ] **Step 2: Rewrite the settings load in `GET /`**

```ts
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
```

- [ ] **Step 3: Rewrite the unread-counts loop in `GET /`**

Replace the whole `if (includeCounts && chatIds.length > 0) { ... }` block (RPC attempt + manual fallback) with a single count query per chat. The `get_unread_count` RPC does not exist in the local replica (verified in `pg_proc` during planning), so the RPC path was already dead locally — the query below is its fallback's exact semantics in one statement:

```ts
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
```

- [ ] **Step 4: Rewrite the blind-date section in `GET /`**

Replace the two supabase calls (`blind_date_matches` list + per-match `profiles` fetch). The `BlindDateInfo` interface, `maskWord`/name-masking, `needsLabels` mapping, and `blindDateMap.set(...)` logic are unchanged except for camelCase property reads:

```ts
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
```

Inside the rest of that loop body, the property reads become:
- `otherProfile?.age` (unchanged name, now camelCase row) for `age`
- `otherProfile?.first_name` → `otherProfile?.firstName`, `otherProfile.last_name` → `otherProfile.lastName` in the masked-name block
- `otherProfile?.needs` unchanged (Drizzle returns `text[]` as a real string array, so the existing `Array.isArray(needs)` check still passes)
- `otherProfile?.gender` unchanged name
- `blindDateMap.set(match.chat_id, ...)` → `blindDateMap.set(match.chatId, ...)`

(The old per-profile `profileError` console.error disappears; a query failure now throws to the route's outer catch, same as any other DB error in this handler.)

- [ ] **Step 5: Rewrite the archive and pin upserts**

`POST /:chatId/archive` — replace the supabase upsert with:

```ts
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
```

`POST /:chatId/pin` — identical shape with `pinned` in place of `archived`:

```ts
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
```

(Response keys stay snake_case exactly as supabase's `select('user_id, chat_id, archived, pinned')` returned them.)

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit -p .`
Expected: zero errors project-wide.

Run: `grep -c supabase src/server/routes/chat-list.routes.ts`
Expected: `0`

- [ ] **Step 7: HTTP smoke test against the running server**

Start the server in the background (same as Task 1 Step 7). Write `task2-smoke.mts` at the worktree root:

```ts
import { db } from './src/server/config/db.js'
import { signJwt } from './src/server/utils/jwt.js'
import { sql } from 'drizzle-orm'

const BASE = 'http://localhost:8080'

const found: any = await db.execute(sql`
  select cm.chat_id as chat_id, cm.user_id as user_id
  from chat_members cm limit 1`)
const row = found.rows[0]
if (!row) { console.log('No chat membership in replica - skipping'); process.exit(0) }
const chatId = row.chat_id as string
const userId = row.user_id as string

const prof: any = await db.execute(sql`select id, email, username from profiles where id = ${userId}`)
const p = prof.rows[0]
const token = signJwt({ sub: p.id, email: p.email, username: p.username })
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

// Remember the pre-test setting so we can restore it
const before: any = await db.execute(sql`
  select archived, pinned from chat_user_settings where user_id = ${userId} and chat_id = ${chatId}`)
const hadRow = before.rows.length > 0
const prev = before.rows[0] ?? { archived: false, pinned: false }

async function post(path: string, body: any) {
  const resp = await fetch(`${BASE}${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) })
  const json: any = await resp.json().catch(() => null)
  console.log('POST', path, '->', resp.status, JSON.stringify(json)?.slice(0, 160))
  if (!resp.ok) { console.error('FAIL:', path); process.exit(1) }
  return json
}

const list = await fetch(`${BASE}/api/chat-list?includeCounts=true&includeArchived=true`, { headers: H })
const listBody: any = await list.json()
console.log('GET /api/chat-list ->', list.status, 'chats:', listBody?.chats?.length)
if (!list.ok || !Array.isArray(listBody?.chats)) { console.error('FAIL: chat-list'); process.exit(1) }
const sample = listBody.chats.find((c: any) => c.chatId === chatId) ?? listBody.chats[0]
console.log('sample item keys ok:',
  sample ? ['chatId','unreadCount','archived','pinned','messageCount','isBlindDateOngoing'].every(k => k in sample) : 'no chats')
console.log('messageCount is a number:', sample ? typeof sample.messageCount === 'number' : 'n/a')

const pinOn = await post(`/api/chat-list/${chatId}/pin`, { pinned: true })
if (pinOn.setting?.pinned !== true || !('user_id' in pinOn.setting)) { console.error('FAIL: pin=true shape'); process.exit(1) }
const archOn = await post(`/api/chat-list/${chatId}/archive`, { archived: true })
if (archOn.setting?.archived !== true || archOn.setting?.pinned !== true) { console.error('FAIL: archive upsert must preserve pinned'); process.exit(1) }

// Restore original state
await post(`/api/chat-list/${chatId}/pin`, { pinned: !!prev.pinned })
await post(`/api/chat-list/${chatId}/archive`, { archived: !!prev.archived })
if (!hadRow) {
  await db.execute(sql`delete from chat_user_settings where user_id = ${userId} and chat_id = ${chatId}`)
  console.log('cleaned up chat_user_settings row created by smoke test')
}
console.log('OK')
process.exit(0)
```

Run: `npx tsx task2-smoke.mts`
Expected: chat-list returns 200 with a `chats` array, "sample item keys ok: true", "messageCount is a number: true"; pin/archive return the snake_case `setting` object; the archive upsert preserves `pinned: true` (proves `onConflictDoUpdate` only touches its own column); ends with "OK".

Then: `rm task2-smoke.mts`, stop the background server.

- [ ] **Step 8: Commit**

```bash
git add src/server/routes/chat-list.routes.ts
git commit -m "feat: migrate chat-list.routes.ts to Drizzle

Replaces the get_unread_count RPC call (function absent from the local
replica, so this path was already dead locally) plus its manual fallback
with a single SQL count implementing the fallback's exact semantics.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Batch 2b exit criteria

Both tasks committed; `npx tsc --noEmit -p .` clean project-wide; `grep -rc supabase src/server/routes/chat.routes.ts src/server/routes/chat-list.routes.ts` returns 0 for both; both HTTP smoke tests pass against the local replica; server boots cleanly (`npx tsx src/index.ts`). Remaining in Batch 2 after this: `sockets/optimized-socket.ts` (own plan, Batch 2c).
