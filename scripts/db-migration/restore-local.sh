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
