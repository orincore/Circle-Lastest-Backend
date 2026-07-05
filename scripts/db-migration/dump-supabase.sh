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
