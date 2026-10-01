#!/usr/bin/env bash
# Linux-only local database WITHOUT Docker.
#
# Runs a user-space PostgreSQL 16 cluster (no sudo), installs pgmq (SQL-only),
# pgTAP and the test-only Supabase shim, then applies supabase/migrations and,
# optionally, the seed.
#
# Usage:
#   scripts/db-local.sh start            # start cluster (creates it on first run)
#   scripts/db-local.sh reset [--seed]   # drop + recreate database, apply migrations (+ seed)
#   scripts/db-local.sh stop
#   scripts/db-local.sh url              # print the connection URL
#
# With Docker available, prefer the real stack: `supabase start` / `supabase db reset`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
DATA_HOME="${CONIME_PG_HOME:-$HOME/.local/share/conime-pg}"
VENDOR="${CONIME_VENDOR:-$HOME/.local/share/conime-vendor}"
PORT="${CONIME_PG_PORT:-54329}"
DB="${CONIME_DB:-conime}"
URL="postgresql://postgres@127.0.0.1:${PORT}/${DB}"

psql_db() { psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$PORT" -U postgres "$@"; }

vendor() {
  mkdir -p "$VENDOR"
  if [[ ! -f "$VENDOR/pgmq.sql" ]]; then
    echo "· downloading pgmq v1.13.0 (SQL-only install)"
    curl -fsSL -o "$VENDOR/pgmq.tar.gz" https://github.com/pgmq/pgmq/archive/refs/tags/v1.13.0.tar.gz
    tar -xzf "$VENDOR/pgmq.tar.gz" -C "$VENDOR"
    cp "$VENDOR/pgmq-1.13.0/pgmq-extension/sql/pgmq.sql" "$VENDOR/pgmq.sql"
  fi
  if [[ ! -f "$VENDOR/pgtap.sql" ]]; then
    echo "· downloading pgTAP 1.3.3"
    curl -fsSL -o "$VENDOR/pgtap.zip" https://api.pgxn.org/dist/pgtap/1.3.3/pgtap-1.3.3.zip
    python3 -c "import zipfile,sys;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$VENDOR/pgtap.zip" "$VENDOR"
    sed -e 's,MODULE_PATHNAME,$libdir/pgtap,g' -e 's,__OS__,linux,g' -e 's,__VERSION__,1.33,g' \
      "$VENDOR/pgtap-1.3.3/sql/pgtap.sql.in" > "$VENDOR/pgtap.sql"
  fi
}

start() {
  if [[ ! -d "$DATA_HOME/data" ]]; then
    mkdir -p "$DATA_HOME"
    "$PG_BIN/initdb" -D "$DATA_HOME/data" -U postgres --auth=trust -E UTF8 --locale=C.UTF-8 >/dev/null
  fi
  if ! "$PG_BIN/pg_ctl" -D "$DATA_HOME/data" status >/dev/null 2>&1; then
    "$PG_BIN/pg_ctl" -D "$DATA_HOME/data" -l "$DATA_HOME/pg.log" -w \
      -o "-p $PORT -k $DATA_HOME -c listen_addresses=127.0.0.1 -c max_connections=200 -c timezone=UTC" start >/dev/null
  fi
  echo "postgres running on 127.0.0.1:${PORT}"
}

reset() {
  start
  vendor
  psql_db -d postgres -c "drop database if exists \"$DB\" with (force)" -c "create database \"$DB\""
  psql_db -d "$DB" -f "$VENDOR/pgmq.sql" >/dev/null
  psql_db -d "$DB" -f "$ROOT/supabase/tests/shim/00_supabase_shim.sql" >/dev/null
  psql_db -d "$DB" -c "create schema if not exists tap" -c "set search_path = tap, public" -f "$VENDOR/pgtap.sql" >/dev/null 2>&1
  # pgTAP must be usable after `set role anon/authenticated` (as with the extensions schema on Supabase)
  psql_db -d "$DB" -c "grant usage on schema tap to anon, authenticated, service_role" \
    -c "grant execute on all functions in schema tap to anon, authenticated, service_role" >/dev/null
  for f in "$ROOT"/supabase/migrations/*.sql; do
    echo "· migrate $(basename "$f")"
    psql_db -d "$DB" -f "$f" >/dev/null
  done
  if [[ "${1:-}" == "--seed" ]]; then
    for f in "$ROOT"/supabase/seed/*.sql; do
      echo "· seed $(basename "$f")"
      psql_db -d "$DB" -f "$f" >/dev/null
    done
  fi
  echo "database ready: $URL"
}

case "${1:-}" in
  start) start ;;
  stop) "$PG_BIN/pg_ctl" -D "$DATA_HOME/data" stop ;;
  reset) shift; reset "${1:-}" ;;
  url) echo "$URL" ;;
  *) echo "usage: $0 {start|stop|reset [--seed]|url}" >&2; exit 2 ;;
esac
