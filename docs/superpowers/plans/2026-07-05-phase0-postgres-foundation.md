# Phase 0: Postgres Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a local Postgres replica of the Supabase database, wire up Drizzle ORM against it, and introspect a typed schema — so every later migration-phase plan (auth, chat, matchmaking, etc.) has a real Postgres instance and real generated types to write queries against.

**Architecture:** A native Homebrew `postgresql@17` instance (matching Supabase's confirmed server version, PostgreSQL 17.6) runs locally on port 5433, seeded once via `pg_dump`/`pg_restore` from Supabase's connection-pooler endpoint. A new `src/server/config/db.ts` exports a `pg.Pool`-backed Drizzle client, used alongside (not replacing) the existing `supabase`/`supabaseAdmin` clients until later phases migrate individual files. `drizzle-kit pull` introspects the restored database into a typed schema file that later phases import.

**Tech Stack:** `pg` 8.22.0, `drizzle-orm` 0.45.2, `drizzle-kit` 0.31.10 (dev), `@types/pg` 8.20.0 (dev), Postgres 17 (Homebrew locally; Docker on the VPS per the design spec).

## Global Constraints

- Confirmed live Supabase server version: **PostgreSQL 17.6** — the local Postgres instance and all `pg_dump`/`pg_restore`/`psql` client binaries used against it must be v17, not whatever default is on `$PATH` (this machine's default `pg_dump` is v14.20 via a different Homebrew package and **will fail** against a v17 server with a version-mismatch error). Use the v17 binaries at `/opt/homebrew/opt/postgresql@17/bin/`.
- This Mac already runs a native Homebrew Postgres 15 on port 5432 for unrelated local projects (`ashwini_hospital`, `msme_schemes`) — the new local Postgres for this project **must not** use port 5432. Use **5433**.
- **Local dev uses native Homebrew Postgres, not Docker** — Docker Desktop's daemon is not running on this machine and starting it was declined in favor of the already-installed `postgresql@17` Homebrew formula (data directory already initialized at `/opt/homebrew/var/postgresql@17`). This is a local-dev-only deviation from the design spec's general "Docker for parity" preference; the VPS deployment (a later plan) still uses Docker Postgres per the design spec's "Final move to VPS" section — only Phase 0's local setup changed.
- Homebrew `postgresql@17`'s default `pg_hba.conf` uses `trust` auth for local/`127.0.0.1`/`::1` connections (verified) — a password can still be set on a role and included in connection strings (the driver sends it, the server just doesn't require it), so `postgresql://circle:circle_dev_password@localhost:5433/circle` connects successfully without further `pg_hba.conf` changes.
- Project uses TypeScript with `"module": "NodeNext"` — relative imports must include the `.js` extension even though the source files are `.ts` (e.g. `import { env } from './env.js'`), matching the existing codebase pattern.
- Env vars are validated through a single `zod` schema in `src/server/config/env.ts`; any new env var must be added there or `env.FOO` will be `undefined` even if it's in `.env`.
- `.env` is git-ignored (verified) — safe to edit directly with real credentials. `.env.example` is committed — use placeholder values there, never real credentials.
- Working Supabase pooler connection string (region node is `aws-1`, not the stale `aws-0` previously in `.env`): `postgresql://postgres.cwccjihrjmbhyaafwjuf:Orincore7094@aws-1-ap-south-1.pooler.supabase.com:5432/postgres`. Live DB is small: 34MB, **82 tables** in `public` schema (verified via `pg_tables`, not `information_schema.tables` which overcounts by including views — an earlier count of 97 using the latter was wrong) — dump/restore should take seconds, not minutes.
- No live production traffic exists right now (app is fully down) — no downtime constraints anywhere in this plan.
- Any raw data dump file must never be committed to git (it's a full copy of user data) — the dumps directory is added to `.gitignore` in Task 4.

---

### Task 1: Add Postgres/Drizzle dependencies

**Files:**
- Modify: `package.json`

**Interfaces:**
- Produces: `pg`, `drizzle-orm` available as runtime deps; `drizzle-kit`, `@types/pg` available as dev deps, for all later tasks/phases to import.

- [ ] **Step 1: Install runtime dependencies**

Run:
```bash
npm install pg@8.22.0 drizzle-orm@0.45.2
```
Expected: `package.json` `dependencies` gains `"pg": "^8.22.0"` and `"drizzle-orm": "^0.45.2"`; `package-lock.json` updates; no errors.

- [ ] **Step 2: Install dev dependencies**

Run:
```bash
npm install -D drizzle-kit@0.31.10 @types/pg@8.20.0
```
Expected: `package.json` `devDependencies` gains `"drizzle-kit": "^0.31.10"` and `"@types/pg": "^8.20.0"`.

- [ ] **Step 3: Verify install**

Run: `npm ls pg drizzle-orm drizzle-kit @types/pg --depth=0`
Expected: all four listed with version numbers, no `UNMET DEPENDENCY` or `npm error` lines.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add pg and drizzle dependencies for Postgres migration"
```

---

### Task 2: Local Postgres via native Homebrew postgresql@17

**Files:**
- Create: `scripts/db-migration/setup-local-postgres.sh`

**Interfaces:**
- Produces: a reachable Postgres 17 server at `localhost:5433`, role `circle` (password `circle_dev_password`), database `circle` owned by that role — this is what `DATABASE_URL` in Task 3 points at. Same connection contract as if this were Docker — only the underlying mechanism is native Homebrew instead.

- [ ] **Step 1: Write the setup script**

Create `scripts/db-migration/setup-local-postgres.sh` (idempotent — safe to re-run):

```bash
#!/usr/bin/env bash
set -euo pipefail

PG_BIN="/opt/homebrew/opt/postgresql@17/bin"
PG_CONF="/opt/homebrew/var/postgresql@17/postgresql.conf"
PORT=5433

if ! grep -qE "^port = $PORT" "$PG_CONF"; then
  if grep -qE "^port = " "$PG_CONF"; then
    sed -i '' "s/^port = .*/port = $PORT/" "$PG_CONF"
  else
    sed -i '' "s/^#port = 5432.*/port = $PORT/" "$PG_CONF"
  fi
  echo "Set port = $PORT in $PG_CONF"
fi

brew services start postgresql@17

for i in $(seq 1 10); do
  if "$PG_BIN/pg_isready" -h localhost -p "$PORT" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

"$PG_BIN/pg_isready" -h localhost -p "$PORT"

SUPERUSER=$(whoami)

ROLE_EXISTS=$("$PG_BIN/psql" -h localhost -p "$PORT" -U "$SUPERUSER" -d postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='circle'")
if [ "$ROLE_EXISTS" != "1" ]; then
  "$PG_BIN/psql" -h localhost -p "$PORT" -U "$SUPERUSER" -d postgres -c "CREATE ROLE circle WITH LOGIN PASSWORD 'circle_dev_password';"
  echo "Created role circle"
fi

DB_EXISTS=$("$PG_BIN/psql" -h localhost -p "$PORT" -U "$SUPERUSER" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='circle'")
if [ "$DB_EXISTS" != "1" ]; then
  "$PG_BIN/createdb" -h localhost -p "$PORT" -U "$SUPERUSER" -O circle circle
  echo "Created database circle owned by circle"
fi

echo "Local Postgres ready at postgresql://circle:circle_dev_password@localhost:$PORT/circle"
```

- [ ] **Step 2: Make it executable and run it**

Run: `chmod +x scripts/db-migration/setup-local-postgres.sh && bash scripts/db-migration/setup-local-postgres.sh`
Expected: ends with `Local Postgres ready at postgresql://circle:circle_dev_password@localhost:5433/circle`, no errors. (`brew services start postgresql@17` may print `Successfully started` or, if it was already running from a prior run of this script, a message that it's already started — both are fine.)

- [ ] **Step 3: Verify the `circle` role can actually connect**

Run: `/opt/homebrew/opt/postgresql@17/bin/psql "postgresql://circle:circle_dev_password@localhost:5433/circle" -c "SELECT 1 AS ok;"`
Expected: a one-row result `ok | 1`.

- [ ] **Step 4: Commit**

```bash
git add scripts/db-migration/setup-local-postgres.sh
git commit -m "feat: add local Postgres 17 setup script (native Homebrew, port 5433)"
```

---

### Task 3: Env vars + Drizzle client + connectivity check

**Files:**
- Modify: `src/server/config/env.ts`
- Modify: `.env`
- Modify: `.env.example`
- Create: `src/server/config/db.ts`
- Create: `scripts/db-migration/check-db-connection.ts`

**Interfaces:**
- Consumes: Postgres running at `localhost:5433` from Task 2.
- Produces: `env.DATABASE_URL` and `env.SUPABASE_DATABASE_URL` (both `string | undefined`) from `src/server/config/env.ts`; `pool` (a `pg.Pool`) and `db` (a Drizzle instance built from `pool`) exported from `src/server/config/db.ts`. Later tasks/phases import `{ db }` from `'../config/db.js'` the same way they currently import `{ supabase }` from `'../config/supabase.js'`.

- [ ] **Step 1: Add the two new env vars to the schema**

In `src/server/config/env.ts`, add these two lines to `envSchema` immediately after the `SUPABASE_SERVICE_ROLE_KEY` line:

```ts
  DATABASE_URL: z.string().optional(),
  SUPABASE_DATABASE_URL: z.string().optional(),
```

(Plain `z.string()`, not `.url()` — Postgres connection strings with embedded credentials can trip up strict URL validators; the rest of the codebase's DB code will fail loudly with a clear Postgres connection error if the value is malformed, which is a better signal than a Zod parse error.)

- [ ] **Step 2: Fix `.env`**

In `.env`, replace the existing (broken) `DATABASE_URL=postgresql://postgres.cwccjihrjmbhyaafwjuf:...@aws-0-ap-south-1.pooler.supabase.com:5432/postgres` line with these two lines:

```
SUPABASE_DATABASE_URL=postgresql://postgres.cwccjihrjmbhyaafwjuf:Orincore7094@aws-1-ap-south-1.pooler.supabase.com:5432/postgres
DATABASE_URL=postgresql://circle:circle_dev_password@localhost:5433/circle
```

- [ ] **Step 3: Add placeholders to `.env.example`**

In `.env.example`, in the same location, add:

```
# Postgres migration (see docs/superpowers/specs/2026-07-05-supabase-to-postgres-migration-design.md)
SUPABASE_DATABASE_URL=postgresql://postgres.your-project-ref:your_password@your-pooler-host:5432/postgres
DATABASE_URL=postgresql://circle:circle_dev_password@localhost:5433/circle
```

- [ ] **Step 4: Create the Drizzle client**

Create `src/server/config/db.ts`:

```ts
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { env } from './env.js'

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
})

export const db = drizzle(pool)
```

- [ ] **Step 5: Write a connectivity check script**

Create `scripts/db-migration/check-db-connection.ts`:

```ts
import { pool } from '../../src/server/config/db.js'

const result = await pool.query('select 1 as ok')
console.log('DB connection OK:', result.rows[0])
await pool.end()
```

- [ ] **Step 6: Run it**

Run: `npx tsx scripts/db-migration/check-db-connection.ts`
Expected: `DB connection OK: { ok: 1 }`, process exits cleanly (code 0).

- [ ] **Step 7: Commit**

```bash
git add src/server/config/env.ts src/server/config/db.ts .env.example scripts/db-migration/check-db-connection.ts
git commit -m "feat: add Drizzle Postgres client and DATABASE_URL config"
```

(Do not `git add .env` — it's git-ignored and holds real credentials.)

---

### Task 4: Replicate Supabase data into local Postgres

**Files:**
- Modify: `.gitignore`
- Create: `scripts/db-migration/dump-supabase.sh`
- Create: `scripts/db-migration/restore-local.sh`

**Interfaces:**
- Consumes: `SUPABASE_DATABASE_URL` and `DATABASE_URL` from `.env` (Task 3); healthy Postgres container from Task 2.
- Produces: the local Postgres database (`circle` at `localhost:5433`) populated with a full copy of Supabase's `public` schema (tables, data, sequences, constraints, indexes, functions) — this is what Task 5 verifies and Task 6 introspects.

- [ ] **Step 1: Git-ignore the dumps directory**

In `.gitignore`, add a new line: `scripts/db-migration/dumps/`

- [ ] **Step 2: Write the dump script**

Create `scripts/db-migration/dump-supabase.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Supabase server is Postgres 17 — must dump with a v17+ pg_dump client.
# This machine's default `pg_dump` on PATH is v14 (from a different Homebrew
# package) and will fail with a version-mismatch error against a v17 server.
PG_DUMP="/opt/homebrew/opt/postgresql@17/bin/pg_dump"
if [ ! -x "$PG_DUMP" ]; then
  echo "postgresql@17 pg_dump not found at $PG_DUMP - falling back to 'pg_dump' on PATH (must be v17+)" >&2
  PG_DUMP="pg_dump"
fi

set -a
source .env
set +a

if [ -z "${SUPABASE_DATABASE_URL:-}" ]; then
  echo "SUPABASE_DATABASE_URL is not set in .env" >&2
  exit 1
fi

mkdir -p scripts/db-migration/dumps
OUT="scripts/db-migration/dumps/supabase-$(date +%Y%m%d-%H%M%S).dump"

"$PG_DUMP" "$SUPABASE_DATABASE_URL" \
  --schema=public \
  --no-owner \
  --no-acl \
  --format=custom \
  --file="$OUT"

echo "Dump written to $OUT"
echo "$OUT" > scripts/db-migration/dumps/latest.txt
```

- [ ] **Step 3: Write the restore script**

Create `scripts/db-migration/restore-local.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

PG_RESTORE="/opt/homebrew/opt/postgresql@17/bin/pg_restore"
if [ ! -x "$PG_RESTORE" ]; then
  echo "postgresql@17 pg_restore not found at $PG_RESTORE - falling back to 'pg_restore' on PATH (must be v17+)" >&2
  PG_RESTORE="pg_restore"
fi

set -a
source .env
set +a

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set in .env" >&2
  exit 1
fi

DUMP_FILE=$(cat scripts/db-migration/dumps/latest.txt)
if [ ! -f "$DUMP_FILE" ]; then
  echo "Dump file $DUMP_FILE not found - run dump-supabase.sh first" >&2
  exit 1
fi

"$PG_RESTORE" --clean --if-exists --no-owner --no-acl \
  --dbname="$DATABASE_URL" \
  "$DUMP_FILE"

echo "Restored $DUMP_FILE into $DATABASE_URL"
```

- [ ] **Step 4: Make both scripts executable**

Run: `chmod +x scripts/db-migration/dump-supabase.sh scripts/db-migration/restore-local.sh`

- [ ] **Step 5: Run the dump**

Run: `bash scripts/db-migration/dump-supabase.sh`
Expected: `Dump written to scripts/db-migration/dumps/supabase-<timestamp>.dump`, file exists and is non-empty (check with `ls -la scripts/db-migration/dumps/`).

- [ ] **Step 6: Run the restore**

Run: `bash scripts/db-migration/restore-local.sh`
Expected: `pg_restore` prints its progress (table/function/sequence creation) with no fatal errors, ends with `Restored scripts/db-migration/dumps/supabase-<timestamp>.dump into postgresql://circle:circle_dev_password@localhost:5433/circle`.

(`pg_restore` may print non-fatal `NOTICE`/`WARNING` lines about objects that don't exist yet on a fresh restore, e.g. from `--clean --if-exists` trying to drop things that aren't there — that's expected and fine. A real failure looks like `pg_restore: error: ...` and a non-zero exit code.)

- [ ] **Step 7: Commit**

```bash
git add .gitignore scripts/db-migration/dump-supabase.sh scripts/db-migration/restore-local.sh
git commit -m "feat: add Supabase dump/restore scripts for local Postgres replication"
```

---

### Task 5: Verify row-count parity

**Files:**
- Create: `scripts/db-migration/verify-row-counts.ts`

**Interfaces:**
- Consumes: `SUPABASE_DATABASE_URL`, `DATABASE_URL` from `.env`; populated local Postgres from Task 4.
- Produces: a reusable verification script (also reused later for the final pre-cutover check in the VPS migration plan, per the design spec's "Data integrity safeguards" section).

- [ ] **Step 1: Write the verification script**

Create `scripts/db-migration/verify-row-counts.ts`:

```ts
import { Pool } from 'pg'
import 'dotenv/config'

const supabasePool = new Pool({ connectionString: process.env.SUPABASE_DATABASE_URL })
const localPool = new Pool({ connectionString: process.env.DATABASE_URL })

async function getTableNames(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
  )
  return rows.map((r) => r.tablename)
}

async function getRowCount(pool: Pool, table: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM "${table}"`)
  return Number(rows[0].count)
}

async function main() {
  const supabaseTables = await getTableNames(supabasePool)
  const localTables = await getTableNames(localPool)

  const allTables = Array.from(new Set([...supabaseTables, ...localTables])).sort()
  let mismatches = 0

  for (const table of allTables) {
    const inSupabase = supabaseTables.includes(table)
    const inLocal = localTables.includes(table)

    if (!inSupabase || !inLocal) {
      console.log(`MISMATCH  ${table}: supabase=${inSupabase ? 'present' : 'MISSING'} local=${inLocal ? 'present' : 'MISSING'}`)
      mismatches++
      continue
    }

    const [supabaseCount, localCount] = await Promise.all([
      getRowCount(supabasePool, table),
      getRowCount(localPool, table),
    ])

    if (supabaseCount !== localCount) {
      console.log(`MISMATCH  ${table}: supabase=${supabaseCount} local=${localCount}`)
      mismatches++
    } else {
      console.log(`OK        ${table}: ${supabaseCount} rows`)
    }
  }

  await supabasePool.end()
  await localPool.end()

  if (mismatches > 0) {
    console.error(`\n${mismatches} table(s) mismatched.`)
    process.exit(1)
  }
  console.log(`\nAll ${allTables.length} tables match.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
```

- [ ] **Step 2: Run it**

Run: `npx tsx scripts/db-migration/verify-row-counts.ts`
Expected: one `OK        <table>: N rows` line per table (82 tables as of this writing), ending with `All 82 tables match.` and exit code 0. If any line starts with `MISMATCH`, stop and re-run Task 4's restore step (do not proceed to Task 6 with a mismatch).

- [ ] **Step 3: Commit**

```bash
git add scripts/db-migration/verify-row-counts.ts
git commit -m "feat: add row-count verification script for Supabase/Postgres parity"
```

---

### Task 6: Introspect schema with Drizzle and prove an end-to-end query

**Files:**
- Create: `drizzle.config.ts`
- Create (generated): `src/server/db/schema.ts` (and possibly `src/server/db/relations.ts`, generated by `drizzle-kit pull` — exact file set depends on the tool's output for this schema)
- Modify: `src/server/config/db.ts`
- Create: `scripts/db-migration/check-schema-query.ts`

**Interfaces:**
- Consumes: `db`/`pool` from Task 3; populated + verified local Postgres from Tasks 4–5.
- Produces: `src/server/db/schema.ts` exporting one `pgTable(...)`-based constant per table (e.g. `profiles`, `messages`, `chats`, `chat_members` — exact names/casing as generated). **This is the interface every later migration-phase plan (auth, chat, matchmaking, etc.) imports from** — e.g. `import { profiles } from '../db/schema.js'`.

- [ ] **Step 1: Add the Drizzle Kit config**

Create `drizzle.config.ts` (project root):

```ts
import { defineConfig } from 'drizzle-kit'
import 'dotenv/config'

export default defineConfig({
  dialect: 'postgresql',
  out: './src/server/db',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
})
```

- [ ] **Step 2: Run introspection**

Run: `npx drizzle-kit pull`
Expected: output ending in something like `[✓] Your schema file is ready ➜ src/server/db/schema.ts`, and the file(s) exist on disk.

- [ ] **Step 3: Spot-check the generated schema**

Run: `grep -c "pgTable(" src/server/db/schema.ts`
Expected: a number close to 82 (one `pgTable(` call per table).

Run: `grep -o "export const [a-zA-Z_]*" src/server/db/schema.ts | grep -Ei "profiles|messages|chats"`
Expected: lines confirming `export const profiles`, `export const messages`, `export const chats` (or their generated equivalents) are present — note the exact casing/naming Drizzle chose, since later phase plans must match it exactly.

- [ ] **Step 4: Wire the schema into the Drizzle client**

Update `src/server/config/db.ts` to pass the generated schema through, so later code gets relational-query helpers (`db.query.profiles.findFirst(...)` etc.) in addition to the query builder:

```ts
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { env } from './env.js'
import * as schema from '../db/schema.js'

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
})

export const db = drizzle(pool, { schema })
```

- [ ] **Step 5: Prove an end-to-end query against real replicated data**

Create `scripts/db-migration/check-schema-query.ts` — adjust the imported table name in Step 3's grep output if it differs from `profiles`:

```ts
import { db, pool } from '../../src/server/config/db.js'
import { profiles } from '../../src/server/db/schema.js'

const rows = await db.select().from(profiles).limit(1)
console.log(`Fetched ${rows.length} row(s) from profiles via Drizzle:`, rows[0] ?? '(table is empty)')
await pool.end()
```

Run: `npx tsx scripts/db-migration/check-schema-query.ts`
Expected: `Fetched 1 row(s) from profiles via Drizzle: { ... real profile fields ... }` (or `(table is empty)` if the table genuinely has zero rows — cross-check against Task 5's row-count output for `profiles`).

- [ ] **Step 6: Commit**

```bash
git add drizzle.config.ts src/server/db/ src/server/config/db.ts scripts/db-migration/check-schema-query.ts
git commit -m "feat: introspect Supabase schema with drizzle-kit and verify end-to-end query"
```

---

## Phase 0 exit criteria

All five tasks committed, `verify-row-counts.ts` shows zero mismatches, and `check-schema-query.ts` returns real data through Drizzle. At this point `src/server/db/schema.ts` is the frozen interface the next plan (Task batch 1: **Auth & profiles**, per the design spec's migration order) will import from to start rewriting `supabase.from(...)` calls into Drizzle queries.
