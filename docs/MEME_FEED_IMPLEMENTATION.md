# Anonymous Meme Feed — Implementation Tracker

Status doc for the meme feed social layer (likes, comments, anonymous connect-requests,
DM sharing) built on top of the meme-scraping pipeline (`memes`/`meme_assets` tables,
`docs/` — see the scraping pipeline's own history in `python-services/instagram-meme-scraper/README.md`).

Read this file first if resuming this work in a new session — it reflects actual
repo state, not just intent. Update the checklist below as each stage lands.

## Design summary

- Every like/comment/post interaction is shown under a **persistent per-user anonymous
  alias** (e.g. `circ25ddv1e`), never the user's real name/username.
- If someone wants to know who's behind an alias, they send a **connect request**
  (`meme_connect_requests` table). Only on mutual accept does a chat get created; real
  identity stays hidden in that chat until **both** sides separately choose to reveal
  (mirrors the existing Blind Dating reveal mechanics in
  `src/server/services/blind-dating.service.ts`, but is a **new, separate** table/flow —
  the existing `blind_date_matches` system is untouched, since it's an auto-matching
  daily dating feature and doesn't fit a "click a specific alias" trigger).
- This build is **backend-only**. The Reels-style vertical feed screen (frontend) and
  user-generated meme submission are both explicitly deferred to follow-up work.

**Since this doc was first written**, substantial work landed on top of the original
backend pass (some by a different session/continuation of this same effort — see the
"other AI IDE" continuity note this doc exists for): Redis caching for feed content
and comments (`services/cache.js`, `MEME_CONTENT_TTL`/`MEME_COMMENTS_TTL`), a
ranking/affinity algorithm driving feed order (`services/memeRanking.service.ts`,
`meme_stats`/`user_source_affinity` tables), deterministic anonymous poster aliases
for admin-seeded memes (`derivePosterAlias()` in `feed-memes.routes.ts`), a blurred
real-photo avatar service for anonymous identities (`services/anonAvatar.service.ts`),
share-count tracking (`meme_shares` table, `GET /share-counts`), and the full
Reels-style CircleReact frontend (feed screen, comments sheet, share picker,
connect-request inbox) is now built, not just the backend. Treat every "Not in this
phase" note below with that in mind -- re-check actual repo state before assuming
something is still missing.

**Most recent addition (this session)**: threaded (one-level-deep, Instagram-style)
replies and soft-delete for comments -- see "Comment threading & delete" below.

## Schema

Migration: `migrations/create_meme_feed_tables.sql`. Tables: `user_meme_aliases`,
`meme_likes`, `meme_comments`, `meme_feed_views`, `meme_connect_requests`; plus one
additive column `messages.shared_meme_id` (nullable FK to `memes.id`, does not touch
the existing `media_type` check constraint).

## API surface (all under `/api/feed`, `requireAuth` only — no admin gate)

- `GET /api/feed/memes?limit=` — randomized feed, excludes this user's
  `meme_feed_views`, backfills with least-recently-seen once unseen content runs out.
  No cursor param needed: the client calls `POST .../view` as each card is seen, so
  the next `GET` naturally excludes it — no offset/cursor bookkeeping required.
- `POST /api/feed/memes/:id/view` — upserts a `meme_feed_views` row.
- `POST /api/feed/memes/:id/like`, `DELETE /api/feed/memes/:id/like` — toggle.
- `GET/POST /api/feed/memes/:id/comments` — always rendered with the commenter's alias.
- `GET /api/feed/me/alias` — get-or-create caller's alias.
- `POST /api/feed/connect-requests` `{ comment_id }` — **not** a user id. The target user
  and meme are resolved server-side from the comment, since the comments API never
  returns the commenter's real `user_id` (only their alias) — the client has no
  legitimate way to supply a target id directly without breaking the anonymity guarantee.
- `GET /api/feed/connect-requests`
- `POST /api/feed/connect-requests/:id/respond` `{ accept }`
- `POST /api/feed/connect-requests/:id/reveal`
- `POST /api/feed/memes/:id/share` `{ chat_id }` — sends a message with `shared_meme_id` set.

## Checklist

- [x] Migration written + applied to dev DB, `drizzle-kit pull` done, known post-pull
      fixes re-applied (`usersInAuth` stub, `relations.ts` import extension), `tsc --noEmit` clean.
- [x] `src/server/services/memeAlias.service.ts` — `getOrCreateAlias(userId)`. Verified:
      idempotent across repeat calls for the same user (real DB round-trip, test row cleaned up).
- [x] `src/server/routes/feed-memes.routes.ts` — feed/view/like/comments/alias endpoints.
      Verified against real data (402 active memes at time of testing): view-exclusion confirmed
      on the full unseen set, like double-insert is a no-op (unique constraint), unlike removes
      the row, comment insert returns the commenter's alias.
- [x] `src/server/services/memeConnect.service.ts` + `src/server/routes/meme-connect.routes.ts`
      — request/respond/reveal, chat creation via `ensureChatForUsers`, friendship-on-reveal.
      Verified full lifecycle: create → duplicate-pending correctly rejected → accept (chat
      created) → reveal both sides → friendship row created. **Bug found + fixed during
      verification**: Drizzle wraps Postgres errors in `DrizzleQueryError`, so the real PG
      error code lives at `e.cause.code`, not `e.code` — the original `e?.code === '23505'`
      checks never matched. Fixed everywhere this pattern was used (memeAlias.service.ts,
      memeConnect.service.ts x2, admin-memes.routes.ts, feed-memes.routes.ts x2) to check
      `e?.code ?? e?.cause?.code`. Worth grepping for this exact pattern before adding new
      duplicate/FK-violation handling anywhere else in the codebase.
- [x] `insertMessage()` extended with optional `sharedMemeId`; share-to-chat endpoint added.
      Verified: message row's `shared_meme_id` matches the shared meme's id.
- [x] Routes mounted in `src/server/app.ts` under `/api/feed`.
- [x] End-to-end verification against the real dev DB for every stage above, all test rows
      (aliases, likes, comments, connect requests, friendships, chats, messages) cleaned up
      afterward — confirmed via direct queries, nothing left behind.
- [x] **Contract fix found while building the frontend comments UI**: `POST /connect-requests`
      originally took `target_user_id` directly, which is unusable by any real client since
      the comments API correctly never exposes a commenter's real `user_id`. Changed to take
      `comment_id`, added `createConnectRequestFromComment()` which resolves the target user
      and meme server-side from the comment row. Re-verified full lifecycle with this contract.
- [x] **Real bug caught by the user running the app**: `GET /api/feed/memes` crashed with
      `cannot cast type record to uuid[]`. Cause: raw `sql` template interpolation of a JS array
      into `= ANY(${memeIds}::uuid[])` produces a Postgres row/record literal `($1,$2,...)`, not
      an array literal — Drizzle's `sql` tag does not do this conversion automatically. This
      slipped through my earlier verification because that pass tested the underlying DB
      behavior with hand-written queries, not the actual route handler code path end-to-end.
      Fixed by replacing every such occurrence with Drizzle's `inArray(column, ids)` helper
      (the correct tool for this exact case), including converting two raw `db.execute(sql...)`
      count-aggregation queries to proper query-builder `.groupBy()` calls. Re-verified directly
      against the real DB with the exact 20-id scenario from the crash log. **Lesson**: when
      "verifying" a route, exercise the actual handler/query code, not just equivalent
      hand-written SQL — they can diverge exactly like this.

## Not in this phase (deferred)

- Reels-style vertical feed frontend screen (CircleReact).
- User-generated meme submission/upload + moderation queue for it.
- Push notifications for new likes/comments/connect-requests (can reuse
  `NotificationService` later, same pattern as `admin.announcements.routes.ts`).
