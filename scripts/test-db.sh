#!/usr/bin/env bash
# Runs the pgTAP suites in supabase/tests/database.
#   - With Docker + Supabase CLI: `supabase test db` (real Supabase images).
#   - Otherwise: user-space PostgreSQL from scripts/db-local.sh (Linux, no Docker).
# Usage: scripts/test-db.sh [--fresh]   (--fresh resets the local database first)
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if command -v docker >/dev/null 2>&1 && command -v supabase >/dev/null 2>&1 && [[ "${USE_SUPABASE_CLI:-1}" == "1" ]] \
   && supabase status >/dev/null 2>&1; then
  exec supabase test db
fi

PORT="${CONIME_PG_PORT:-54329}"
DB="${CONIME_DB:-conime}"
if [[ "${1:-}" == "--fresh" ]]; then "$ROOT/scripts/db-local.sh" reset --seed >/dev/null || exit 1; fi

total=0; failed=0; files_failed=()
for f in "$ROOT"/supabase/tests/database/*.test.sql; do
  out="$(cd "$ROOT/supabase/tests/database" && psql -X -h 127.0.0.1 -p "$PORT" -U postgres -d "$DB" -f "$(basename "$f")" 2>&1)"
  plan="$(grep -oE '^ *1\.\.[0-9]+' <<<"$out" | head -1 | tr -d ' ' | cut -d. -f3)"
  oks="$(grep -cE '^ *ok [0-9]+' <<<"$out")"
  notoks="$(grep -cE '^ *not ok [0-9]+' <<<"$out")"
  errors="$(grep -E '(^|: )ERROR:' <<<"$out" | grep -v 'Failed test' || true)"
  ran=$((oks + notoks))
  total=$((total + ran))
  status="ok"
  if [[ -z "$plan" || "$plan" != "$ran" || "$notoks" -gt 0 || -n "$errors" ]]; then
    status="FAIL"; failed=$((failed + 1)); files_failed+=("$(basename "$f")")
    grep -E 'not ok|# +(Failed|got|expected|have|want|Looks)|ERROR|DETAIL' <<<"$out" | head -40
  fi
  printf '%-45s %s  (%s/%s)\n' "$(basename "$f")" "$status" "$oks" "${plan:-?}"
done
echo "pgTAP: $total assertions, $failed failing file(s) ${files_failed[*]:-}"
[[ $failed -eq 0 ]]
