# Backend Test Report

Date: 2026-10-02 · Environment: Linux (Ubuntu 24.04, kernel 6.8), PostgreSQL 16.15 (user-space cluster, pgmq 1.13.0 SQL install, pgTAP 1.3.3), Deno 2.9.7, Node 24, k6 1.3.0, .NET 8. No Docker; no Supabase project; no OpenAI key; no Mac/iPhone.

**Important:** everything below was verified on Linux. **Nothing here verifies the iPhone application.** Supabase-hosted services and live OpenAI calls are **not** verified yet (see section 3).

## 1. Results

| Suite | Result | Command |
|-------|--------|---------|
| OpenAPI 3.1 lint (Redocly) | valid, 44 operations on 38 paths | `npx redocly lint openapi/openapi.yaml` |
| Type check + `deno lint` | 0 errors | `scripts/test-all.sh` |
| Unit tests | **22 passed**, 0 failed | `deno task test:unit` |
| Database / RLS (pgTAP) | **409 assertions passed** in 5 files, 0 failed | `scripts/test-db.sh` |
| API integration over HTTP | **53 passed**, 0 failed (7 files) | `scripts/test-integration.sh` |
| Postman / newman (local) | **62 requests, 187 assertions, 0 failed**; 4 consecutive re-runs green | `npx newman run …` |
| C# DTO contract (.NET 8, Newtonsoft, strict) | **22/22** real responses deserialize and round-trip losslessly | `tests/unity-contracts` |
| Load (k6, local dev server) | all thresholds passed at 1× and 5× assumed peak | `docs/LOAD_TEST.md` |
| AI evaluation harness (mock AI) | 8/8 fixtures processed, metrics produced (harness check only) | `deno task test:ai-eval` |
| Secret scan | no keys, tokens or private keys in the repository | `grep` patterns in this report's history |

Full Linux run time (`scripts/test-all.sh`): about 30–45 s.

### Coverage against the required test areas

| Area (task §14) | Covered by |
|-----------------|-----------|
| Unit: schema validation, normalization, matching, EXP/level, evolution boundaries, error mapping, authorization helpers (JWT), AI-output validation | `tests/unit/*` |
| RLS per table: anonymous, owner, other user, guild member, non-member, blocked user, service-only; negative tests | `001_schema_grants` (every table: RLS on, no client writes, no anon access, service-only tables, function grants), `002_rls_access` (68 allow/deny assertions incl. realtime topics and deleted accounts) |
| API: success, missing/expired JWT, invalid IDs, invalid question-set version, missing consent, duplicate idempotency keys, empty results, pagination, rate limits, deletion states | `api_basics_test`, `diagnosis_flow_test`, `community_test`, `safety_test` |
| Realtime | DB side (topic authorization, broadcast rows) verified; WebSocket scenarios written in `tests/realtime/realtime-client.ts` but **not run** (needs Supabase Realtime) |
| AI: invalid JSON, missing fields, invented IDs, refusals, timeout, rate limit, retry, duplicate queue delivery | `diagnosis_flow_test` (mock fault injection), `004_jobs_matching` (lease/backoff/fencing), `concurrency_test` (parallel workers) |
| Storage: valid signed upload, unauthorized upload, unsupported MIME, oversized, unauthorized download, expired signed URL, deleted attachment, orphan cleanup | `community_test`, `security_test` (filesystem emulator with the same signed-URL semantics; real Supabase Storage not exercised) |
| Concurrency/idempotency: duplicate diagnosis/message/reaction, final guild slot, concurrent EXP, multiple queue deliveries, multiple level boundaries | `concurrency_test`, `003_business_rules` |
| Security: no service key exposed; cross-user reads; non-member chat; non-participant DM; blocked communication; AI before consent; arbitrary storage paths; request data cannot alter scores/EXP | `security_test`, `002_rls_access`, `safety_test`, `diagnosis_flow_test` |
| Golden fixtures for every formula version | `tests/golden/user-v1.json` (incl. the 設計05-C example = 66 %), `guild-v1.json`, `005_anime_golden.test.sql` |
| Load | `tests/load/*`, results in `LOAD_TEST.md` |

### Defects found and fixed during testing

| Found by | Defect | Fix |
|----------|--------|-----|
| pgTAP 003 | "Latest consent" ambiguous when acceptance and withdrawal share a timestamp | Monotonic `consents.seq` ordering |
| Integration | JSON parameters double-encoded (postgres.js already serializes `jsonb`), which broke submissions and idempotent replays | Pass native objects/arrays to SQL |
| Integration | Worker lacked pgmq privileges as `service_role` | `app.svc_queue_*` SECURITY DEFINER wrappers |
| Integration | NFKC applied to chat text changed users' full-width characters | Content stored as entered; NFKC only for names (D-14) |
| pgTAP | Character-code fixture violated the Crockford alphabet (constraint correctly rejected it) | Fixture corrected |

## 2. Definition of done status

| Criterion | Status |
|-----------|--------|
| Starts cleanly on Linux from documented commands | ✅ (`README.md` quick start; no Docker path) |
| All migrations apply to an empty database | ✅ on PostgreSQL 16 + test shim · ⏳ real Supabase (PostgreSQL 17) not yet run |
| All automated backend tests pass | ✅ Linux suites |
| All RLS allow/deny tests pass | ✅ 409 pgTAP assertions |
| Postman collection passes against **staging** | ⏳ passes locally; no staging project yet |
| Two headless clients complete guild chat and DM over realtime | ⏳ client written; needs Supabase Realtime (multi-user REST flows pass) |
| Disconnect/reconnect retrieves missed messages | ✅ REST catch-up (`after_seq`) verified · ⏳ socket part with the realtime client |
| Duplicate diagnosis, message and reaction requests are safe | ✅ (sequential and parallel) |
| AI output is schema-validated | ✅ (strict schemas + post-validation; mock) · ⏳ live OpenAI |
| Anime recommendations cannot return unapproved IDs | ✅ (worker check + SQL candidate-set check + tests) |
| Generated images are stored privately | ✅ private buckets + signed URLs (emulator) · ⏳ real Storage |
| Matching and EXP calculations have deterministic tests | ✅ golden fixtures + pgTAP |
| Blocking and reports enforce agreed behaviour | ✅ per ASSUMPTIONS I-01–I-04 (agreement pending) |
| No production secret in the repository | ✅ |
| OpenAPI matches deployed behaviour | ✅ matches local behaviour (response-schema checks in integration + Postman) · ⏳ deployed |
| Frontend has contracts and examples | ✅ OpenAPI, Prism mock, Postman, C# DTOs, integration guide |
| Unverified macOS/iPhone items listed | ✅ `IOS_VALIDATION_CHECKLIST.md` (25 items) |
| No claim that iOS was tested | ✅ none made |

## 3. Not yet verified (needs external resources)

1. Supabase-hosted services: Auth (GoTrue incl. Apple/Google, JWKS keys), Storage server, Realtime WebSocket delivery, Edge runtime, pg_cron/pg_net/Vault scheduling, migrations on PostgreSQL 17. **Needs** Docker for `supabase start` (CI job prepared) or a staging project (client account).
2. Live OpenAI (Responses/Images/Moderation), model availability and prices, cost per diagnosis. **Needs** an API key and budget approval.
3. Staging load numbers, cold starts and pooler behaviour.
4. All iOS/Unity items (`IOS_VALIDATION_CHECKLIST.md`), to be done by the frontend engineer or client.
