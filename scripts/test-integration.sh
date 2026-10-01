#!/usr/bin/env bash
# API integration, golden, concurrency and security tests over HTTP against a freshly
# reset local database (Linux, no Docker). Usage: scripts/test-integration.sh [test files...]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.deno/bin:$PATH"
scripts/db-local.sh reset --seed >/dev/null
export CONIME_DB_URL="${CONIME_DB_URL:-$(scripts/db-local.sh url)}"
export CONIME_JWT_SECRET="${CONIME_JWT_SECRET:-local-only-jwt-secret-change-me-at-least-32-characters}"
if [[ $# -gt 0 ]]; then files=("$@"); else files=(tests/integration/*_test.ts); fi
# Files run sequentially; each test file shares fixtures in one database.
for f in "${files[@]}"; do
  deno test -A --quiet "$f"
done
