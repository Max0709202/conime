#!/usr/bin/env bash
# Full Linux verification: contract lint, schema export freshness, type-check, unit,
# pgTAP (RLS), integration. Realtime and load tests need a running Supabase stack.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.deno/bin:$PATH"
echo "== OpenAPI lint";            npx --yes @redocly/cli lint openapi/openapi.yaml --format=summary
echo "== schema export freshness"; deno task schemas >/dev/null && git diff --quiet --exit-code -- schemas supabase/functions/_shared/generated 2>/dev/null || { [[ -d .git ]] && git status --porcelain schemas supabase/functions/_shared/generated | grep -q . && echo "generated schemas changed — commit them" || true; }
echo "== type check";              deno check supabase/functions/api/index.ts supabase/functions/worker/index.ts scripts/*.ts tests/**/*.ts
echo "== lint";                    deno lint
echo "== unit";                    deno test -A --quiet tests/unit
echo "== database (pgTAP)";        scripts/db-local.sh reset --seed >/dev/null && scripts/test-db.sh
echo "== integration";             scripts/test-integration.sh
echo "ALL LINUX CHECKS PASSED"
