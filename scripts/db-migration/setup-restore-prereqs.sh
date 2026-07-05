#!/usr/bin/env bash
set -euo pipefail

# The Supabase dump only includes `--schema=public`, but some public-schema
# DDL references objects that live outside public on Supabase:
#   - column defaults calling extensions.uuid_generate_v4() (uuid-ossp lives
#     in a schema called `extensions` on Supabase, not `public`)
#   - explore_interactions has FKs to auth.users
#   - RLS policies reference auth.uid()/auth.role()/auth.jwt()
# None of these exist in a vanilla local Postgres, so this script creates
# minimal, idempotent stubs for them before pg_restore runs.

PSQL="/opt/homebrew/opt/postgresql@17/bin/psql"
if [ ! -x "$PSQL" ]; then
  echo "postgresql@17 psql not found at $PSQL - falling back to 'psql' on PATH (must be v17+)" >&2
  PSQL="psql"
fi

set -a
source .env
set +a

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set in .env" >&2
  exit 1
fi

# CREATE EXTENSION requires superuser privileges, which the app role (circle,
# from DATABASE_URL) does not have. Connect as the OS superuser instead, but
# target the same host/port/dbname that DATABASE_URL points at.
if [[ "$DATABASE_URL" =~ ^postgres(ql)?://[^@]+@([^:/]+)(:([0-9]+))?/([^?]+) ]]; then
  DB_HOST="${BASH_REMATCH[2]}"
  DB_PORT="${BASH_REMATCH[4]:-5432}"
  DB_NAME="${BASH_REMATCH[5]}"
else
  echo "Could not parse host/port/dbname out of DATABASE_URL" >&2
  exit 1
fi

SUPERUSER=$(whoami)

"$PSQL" -h "$DB_HOST" -p "$DB_PORT" -U "$SUPERUSER" -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL'
-- pg_dump --schema=public does not emit CREATE EXTENSION statements, so every
-- extension referenced by public-schema DDL (column types, function bodies)
-- must be installed here first, in the same schema Supabase uses.
CREATE EXTENSION IF NOT EXISTS "vector" SCHEMA public;

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "pgcrypto" SCHEMA extensions;
GRANT USAGE ON SCHEMA extensions TO circle;

-- KNOWN LIMITATION: this auth.users stub is permanently empty. The restore
-- only succeeds today because explore_interactions (the only public table
-- with FKs to auth.users) has zero rows on the live Supabase source. If that
-- table ever gains rows before a future restore (including the eventual VPS
-- restore), pg_restore will fail again on those FK constraints with "key is
-- not present in table auth.users" - re-check explore_interactions' row
-- count before relying on this script unchanged.
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY);
GRANT USAGE ON SCHEMA auth TO circle;
-- REFERENCES (not just SELECT) is required because explore_interactions has
-- FK constraints pointing at auth.users, and pg_restore creates those FKs
-- while connected as the app role (circle), not a superuser.
GRANT SELECT, REFERENCES ON auth.users TO circle;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid AS $$ SELECT NULL::uuid $$ LANGUAGE sql STABLE;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text AS $$ SELECT NULL::text $$ LANGUAGE sql STABLE;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb AS $$ SELECT NULL::jsonb $$ LANGUAGE sql STABLE;
SQL

echo "Restore prerequisites ready (extensions schema + uuid-ossp/pgcrypto, auth schema stubs)"
