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

# The dump's public-schema DDL references objects outside public (extensions
# schema for uuid-ossp/pgcrypto, auth.users, auth.uid()/role()/jwt()). Set
# those up first so restore-local.sh remains a single self-sufficient entry
# point against a fresh Postgres.
scripts/db-migration/setup-restore-prereqs.sh

# On Supabase the public schema's owner differs from the vanilla default
# (pg_database_owner), so pg_dump captures an explicit "CREATE SCHEMA public"
# TOC entry. Combined with --clean, pg_restore would try to
# "DROP SCHEMA IF EXISTS public" (no CASCADE) before recreating it - which
# fails once the vector extension (installed by setup-restore-prereqs.sh,
# matching its real location on Supabase) lives in that schema. The public
# schema already exists on any fresh Postgres database, so drop that one
# TOC entry (and its COMMENT) and let restore manage tables/data inside the
# existing schema instead of recreating the schema itself.
TOC_LIST=$(mktemp)
trap 'rm -f "$TOC_LIST"' EXIT
"$PG_RESTORE" -l "$DUMP_FILE" | grep -v "SCHEMA - public pg_database_owner" | grep -v "COMMENT - SCHEMA public pg_database_owner" > "$TOC_LIST"

"$PG_RESTORE" --clean --if-exists --no-owner --no-acl \
  --use-list="$TOC_LIST" \
  --dbname="$DATABASE_URL" \
  "$DUMP_FILE"

echo "Restored $DUMP_FILE into $DATABASE_URL"
