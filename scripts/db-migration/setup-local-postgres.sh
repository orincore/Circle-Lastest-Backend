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
