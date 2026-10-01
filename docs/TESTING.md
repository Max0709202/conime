# Testing on Linux

Everything except realtime WebSocket delivery runs without Docker. Commands assume the repository root.

| Suite | What it covers | Command | Needs |
|-------|---------------|---------|-------|
| All Linux checks | OpenAPI lint, type-check, lint, unit, pgTAP, integration | `scripts/test-all.sh` | PostgreSQL 16+ binaries, Deno, Node |
| Unit | Normalization, diagnosis validation, image signatures, character derivation, growth math, cursors, error catalog ↔ docs, JWT verification, schema validation of AI output | `deno task test:unit` | — |
| Database / RLS (pgTAP) | RLS on every table; allow **and** deny for anonymous, owner, other user, guild member, non-member, blocked user, deleted account, service role; realtime channel authorization; business rules; job lease state machine; anime-v1 golden | `scripts/test-db.sh` (or `supabase test db`) | local DB |
| API integration | All endpoints over HTTP: success, missing/expired/foreign JWT, invalid IDs, outdated question set, missing consent, idempotency, empty states, pagination, rate limits, deletion states, storage, AI failure modes | `scripts/test-integration.sh` | local DB |
| Golden formulas | Every active formula version (`tests/golden/*.json`) against the SQL implementation | `scripts/test-integration.sh tests/integration/golden_matching_test.ts` | local DB |
| Concurrency | Final guild seat, duplicate messages, sequence ordering, duplicate/concurrent グッと, duplicate diagnosis, parallel workers, multi-boundary EXP | `scripts/test-integration.sh tests/integration/concurrency_test.ts` | local DB |
| Security | Cross-user access, non-member/non-participant, blocked users, storage path abuse, server-authoritative values, secret exposure, injection-shaped input | `scripts/test-integration.sh tests/integration/security_test.ts` | local DB |
| Postman | 62 requests, 187 assertions (status, schema, error envelope) | `npx newman run postman/CONIME_Backend.postman_collection.json -e postman/local.postman_environment.json` | dev server |
| C# DTO contract | Generated DTOs vs 22 real responses (strict, lossless round trip) | `deno run -A scripts/capture-contract-fixtures.ts && (cd tests/unity-contracts && dotnet run)` | dev server, .NET 8 |
| Realtime (headless) | Private channels, delivery, non-member denial, DMs, reconnect + catch-up, token refresh, read state, duplicates | `deno task test:realtime` (env in the script header) | **Supabase stack** (Docker or staging) |
| Load (k6) | MVP traffic model; scenarios measured separately; queue/connection monitor | `docs/LOAD_TEST.md` | dev server or staging |
| AI evaluation | Normalization accuracy, schema validity, invented-ID rejection, latency, cost with a budget stop | `deno task test:ai-eval` (mock) / `AI_EVAL_TARGET=staging …` (live, budget-capped) | dev server or staging |

AI in CI: the mock provider is deterministic and supports fault injection (`invalid_json`, `missing_fields`, `invented_ids`, `refusal`, `timeout`, `rate_limit`, `unavailable`, `franchise_name`). Live image generation never runs in normal CI.

Test data: `scripts/db-local.sh reset --seed` loads a deterministic seed with 200 users (fixtures alice=001 … frank=006; 191–199 without diagnosis; 200 without consent), 7 guilds (one full at 10/10, one with a single free seat, one draft), conversations with text and image messages, blocks, and users exactly one グッと short of Lv5 / Lv10.
