#!/usr/bin/env bash
# Starts the local dev API (no Docker). Creates .env.local from .env.example on first run.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
[[ -f .env.local ]] || cp .env.example .env.local
set -a; source .env.local; set +a
export PATH="$HOME/.deno/bin:$PATH"
exec deno run --allow-net --allow-env --allow-read --allow-write="${LOCAL_STORAGE_DIR:-.dev-storage}" scripts/dev-api.ts
