# Supabase → Self-Hosted Postgres Migration

## Context

The backend currently runs entirely on Supabase, used purely as a Postgres
database via the `supabase-js` query-builder client (`supabase.from(...)`).
Confirmed during exploration:

- No use of Supabase Auth, Storage, or Realtime anywhere in the backend.
- The React Native app (`CircleReact`) never talks to Supabase directly — all
  access goes through this backend's API.
- ~75 backend files call `supabase.from(...)`; ~30 call sites across 13 files
  call Postgres RPC functions (`.rpc(...)`) that live in the database itself.
- Only one Postgres extension is in active use: `pgcrypto`. PostGIS and
  pg_cron are referenced only in comments as optional/unused fallbacks.
- No automated test suite exists (no Jest/Vitest/Mocha); validation today is
  manual.
- The app currently has no live users / no production traffic, which removes
  downtime and data-loss-in-flight as constraints for this migration.
- Supabase free tier is capped at 512MB storage (limit reached). Destination
  is a Hostinger KVM2 VPS with 80GB storage, which will host both the
  self-hosted Postgres instance and the backend application.

## Goal

Replace Supabase with a self-hosted Postgres instance, first replicated
locally for development, then deployed to the VPS — migrating and testing the
backend's data access code one logical section at a time, with zero data
loss and no dependency on Supabase once complete.

## Decisions

- **Rewrite, not shim.** Backend code is rewritten file-by-file to use a real
  Postgres client instead of standing up a self-hosted PostgREST shim in
  front of Postgres. More upfront effort, but ends in a conventional Node/PG
  stack with no extra moving service to operate long-term.
- **Drizzle ORM** replaces `supabase-js` as the query layer. TypeScript-first,
  generates types from the schema, and supports raw SQL escape hatches for
  the RPC calls and Supabase's embedded-relation selects (e.g.
  `reactions:message_reactions(...)`).
- **Migrate & test entirely on a local Postgres replica first; one cutover
  at the end.** Production stays fully on Supabase throughout development.
  Because there is no live traffic, this carries no user-facing risk, and
  keeps the migration simple: no dual-writes, no split-brain data, no
  feature flags needed to choose between Supabase and Postgres at runtime.
- **VPS:** Hostinger KVM2, hosting both the backend app and Postgres.

## Environments & flow

1. **Local Mac (dev)** — Postgres (native Homebrew `postgresql@17`, since Docker Desktop's daemon wasn't running locally — the VPS still uses Docker, see below), seeded once via `pg_dump` from
   Supabase. All rewriting and testing happens here.
2. **Local full regression pass** — once every section below is migrated,
   run the whole backend end-to-end against the local Postgres replica.
3. **Hostinger KVM2 (prod)** — final home for both Postgres and the backend.
   One cutover: fresh final data sync from Supabase, deploy backend pointed
   at the VPS Postgres. Supabase project is kept paused (not deleted) as a
   rollback safety net for a soak period afterward.

## Phase 0 — Foundational setup (once, first)

1. Get a Supabase connection string from Settings → Database → Connection
   Pooling. In practice the direct (non-pooled) connection didn't work from
   this network — Supabase's free tier serves it IPv6-only — so the pooler
   connection (Supavisor, port 5432, IPv4-reachable) is what's actually used.
2. Local Postgres, matching the Postgres major version Supabase runs (17), so
   behavior stays consistent all the way to the VPS. Implemented as native
   Homebrew `postgresql@17` locally (Docker Desktop's daemon wasn't running on
   the dev machine) — the VPS still uses Docker, only local dev diverged.
3. One-time replication: `pg_dump --schema=public --no-owner --no-acl -Fc`
   from Supabase → restore into local Postgres. Only the `public` schema is
   needed — Supabase's internal `auth`/`storage`/`realtime` schemas aren't
   used by this codebase's application logic, though a few `public`-schema
   objects (FKs, RLS policies, column defaults) reference `auth.*` and an
   `extensions` schema by name — a small prerequisite script creates minimal
   stubs for those before restoring, documented in
   `scripts/db-migration/setup-restore-prereqs.sh`.
4. Introspect the restored local DB with `drizzle-kit pull` (the current
   drizzle-kit command name — `introspect` was renamed) for a first-pass
   schema. Add a `db.ts` with a `pg.Pool`-backed Drizzle client alongside (not
   yet replacing) the existing `supabase` / `supabaseAdmin` clients.
5. Verify: row counts per table must match exactly between Supabase and the
   local restore before any rewriting starts.

## Migration order (one batch at a time)

Within each batch: replace `supabase.from(...)` calls in those files with
Drizzle queries, run the backend locally against local Postgres, manually
exercise the affected endpoints (write small smoke-test scripts under
`scripts/` per batch — no test framework is being introduced). Only move to
the next batch once the current one behaves correctly.

1. **Auth & profiles** — `middleware/auth.ts`, `middleware/adminAuth.ts`,
   `middleware/requireVerification.ts`, `repos/profiles.repo.ts`,
   `graphql/resolvers.ts` (its `profiles` resolver folds in here), and
   `routes/auth.routes.ts` (signup/login/Google OAuth/account-deletion route
   handlers — has direct `supabase.from(...)` calls of its own beyond what it
   gets from `profiles.repo.ts`; missed in this list's first pass, added when
   the batch 1 plan was written). Nearly every request depends on this, so it
   goes first.
2. **Chat** — `repos/chat.repo.ts`, `routes/chat.routes.ts`,
   `routes/chat-list.routes.ts`, `sockets/index.ts`,
   `sockets/optimized-socket.ts`. The largest/most complex data-access file
   (embedded relation selects, upsert-with-onConflict), tackled early while
   the rewrite pattern is fresh.
3. **Friends** — `routes/friends.routes.ts`,
   `handlers/friendRequestHandler.ts`.
4. **Matchmaking & blind dating** — `services/matchmaking.ts`,
   `services/matchmaking-optimized.ts`, `routes/matchmaking.routes.ts`,
   `services/blind-dating.service.ts`, `routes/blind-dating.routes.ts`,
   `services/prompt-matching.service.ts`, `routes/prompt-matching.routes.ts`,
   `workers/continuous-blind-matching.ts`,
   `workers/inactive-blind-date-reminder.ts`. Heaviest concentration of the
   30 RPC call sites.
5. **Notifications** — `services/notificationService.ts`,
   `services/pushNotificationService.ts`, `routes/notifications.routes.ts`.
6. **Payments & subscriptions** — `routes/cashfree-subscription.routes.ts`,
   `services/subscription.service.ts`, `routes/refund.routes.ts`,
   `services/refund.service.ts`, `services/revenue.service.ts`,
   `routes/admin.subscription.routes.ts`. Extra manual verification here
   given it's money-touching, regardless of no live users.
7. **Referral & circle points** — `routes/referral.routes.ts`,
   `services/circle-points.service.ts`.
8. **Admin & analytics** — the ~12 `admin*.routes.ts` files,
   `routes/analytics.routes.ts`, `routes/user-analytics.routes.ts`,
   `routes/circle-stats.routes.ts`, `routes/public-stats.routes.ts`,
   `services/ai/*`.
9. **Everything else** (~15 remaining files) — location, explore,
   social-accounts, verification / email-verification / password-reset,
   account-deletion, app-version, public-profile, announcements, campaigns,
   templates, `routes/upload.routes.ts`, `services/activityService.ts`,
   `services/beacon-retry.service.ts`.

**RPC functions**: the 30 `.rpc(...)` call sites invoke Postgres stored
functions that live in the database itself, so they transfer automatically
via `pg_dump`. In Drizzle they're called via
`db.execute(sql\`select * from my_function(${arg})\`)` — same underlying SQL
function, only the calling convention changes.

## Data integrity safeguards (throughout)

- After the initial replication, and again after the final pre-cutover dump:
  compare row counts per table, and checksum a sample of rows (e.g.
  `md5(array_agg(t.* order by id)::text)` per table) between Supabase and
  the target Postgres.
- Schema (sequences, defaults, constraints, indexes, foreign keys) comes
  across via `pg_dump` automatically — no manual re-entry.
- Row Level Security policies become irrelevant once PostgREST is out of the
  picture — access control is fully enforced in application code, as it
  effectively already is today via the service-role key.
- Nothing is deleted from Supabase until well after the VPS is confirmed
  stable.

## Final move to VPS

1. Provision the Hostinger KVM2: Docker, a Postgres container (matching
   version), firewall rules (Postgres not exposed publicly — reachable only
   from the backend, same box), automated nightly `pg_dump` backups with a
   retention window.
2. Take one final `pg_dump` from Supabase, restore to the VPS Postgres, run
   the same row-count/checksum verification.
3. Deploy the fully-migrated backend to the VPS pointed at the local Postgres
   via `DATABASE_URL`; remove the `SUPABASE_*` env vars and the
   `@supabase/supabase-js` dependency.
4. Smoke-test the deployed app end-to-end on the VPS.
5. Keep the Supabase project paused (not deleted) for a safety-net period
   before fully decommissioning it.

## Out of scope

- No changes to Auth, file uploads (already on S3), or realtime
  (already custom Socket.io) — none of these depend on Supabase today.
- No introduction of a formal test framework (Jest/Vitest) — validation is
  manual smoke-testing per batch, matching current project practice.
- No dual-write / logical-replication zero-downtime tooling — not needed
  given there is no live traffic to protect.
