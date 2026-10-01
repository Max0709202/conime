# CONIME Backend (MVP)

Backend for the CONIME iPhone app (Unity). Specification: `CONIME_企画・仕様書_v3.1` chapters 1–3. Supabase (PostgreSQL, Auth, Storage, Realtime, Queues, Edge Functions), TypeScript/Deno and OpenAI behind a provider interface. Contract-first: [`openapi/openapi.yaml`](openapi/openapi.yaml).

**Scope:** backend only ([`docs/SCOPE.md`](docs/SCOPE.md)). No Unity UI or iOS build work. Unverified macOS/iPhone items: [`docs/IOS_VALIDATION_CHECKLIST.md`](docs/IOS_VALIDATION_CHECKLIST.md).

## Quick start (Linux, no Docker)

```bash
curl -fsSL https://deno.land/install.sh | sh     # Deno 2
npm install                                      # tooling: OpenAPI lint, Prism mock, newman
scripts/db-local.sh reset --seed                 # user-space PostgreSQL :54329 with migrations + test data
scripts/dev-api.sh                               # API on http://127.0.0.1:8787 (+ storage emulator + worker)
curl http://127.0.0.1:8787/v1/health
scripts/test-all.sh                              # everything that runs on Linux
```

Frontend without a backend: `npm run mock` serves the contract on `http://127.0.0.1:4010`. With Docker, use the real Supabase stack instead (`supabase start`; see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)).

## Repository layout

```
openapi/openapi.yaml            API contract (source for validation, Postman, C# DTOs)
schemas/                        JSON Schemas: api (generated), ai (AI output schemas)
supabase/
  migrations/                   schema, RLS, SQL business logic (app.api_* / app.svc_*), reference data
  functions/api                 /v1 REST API (Edge Function)
  functions/worker              queue consumer + maintenance (Edge Function; container-portable)
  functions/_shared             http, auth, db, ai (OpenAI + mock), storage, domain, worker
  seed/                         local/staging test data (200 users, 7 guilds, fictional anime master)
  settings/                     staging/production overrides, cron schedule
  tests/database                pgTAP (RLS allow/deny, business rules, golden)
tests/                          unit, integration (HTTP), golden, realtime, load (k6), ai-evaluation, unity-contracts
postman/                        collection + environments
unity-contracts/                generated C# DTOs + UnityWebRequest example
templates/anime-master/         CSV templates for the client's anime data
scripts/                        local DB, dev server, generators, importers, test runners
docs/                           see below
```

## Documentation

| Document | Content |
|----------|---------|
| [SCOPE](docs/SCOPE.md) | In/out of scope |
| [ASSUMPTIONS](docs/ASSUMPTIONS.md) | Every default chosen for missing details (needs client confirmation) |
| [ARCHITECTURE](docs/ARCHITECTURE.md) / [ER_DIAGRAM](docs/ER_DIAGRAM.md) | Components, security model, data flows, schema |
| [ERROR_CODES](docs/ERROR_CODES.md) | Stable error codes and client actions |
| [REALTIME](docs/REALTIME.md) | Channels, envelope, events, reconnect algorithm |
| [UNITY_IOS_INTEGRATION](docs/UNITY_IOS_INTEGRATION.md) | Sequences and examples for the Unity engineer |
| [IOS_VALIDATION_CHECKLIST](docs/IOS_VALIDATION_CHECKLIST.md) | External tests on macOS/iPhone (not done by backend) |
| [TESTING](docs/TESTING.md) / [TEST_REPORT](docs/TEST_REPORT.md) / [LOAD_TEST](docs/LOAD_TEST.md) | How to test; what passed; what is unverified |
| [DEPLOYMENT](docs/DEPLOYMENT.md) | Local, staging, production checklist, backup/restore |
| [OPERATIONS](docs/OPERATIONS.md) | Handover: operator SQL actions, monitoring, retention, runbook |
| [KNOWN_LIMITATIONS](docs/KNOWN_LIMITATIONS.md) | Verification gaps and functional limits |

## Regenerating derived artifacts

```bash
deno task schemas                                # openapi → JSON Schemas (runtime validation)
deno run -A scripts/generate-postman.ts          # openapi → Postman collection
deno run -A scripts/generate-csharp-dtos.ts      # openapi → Unity C# DTOs
deno task seed                                   # deterministic seed SQL
```

## Secrets

No secrets are stored in this repository. `.env.example` lists the variables; local values are placeholders for the Linux dev setup only. Staging and production secrets are set with `supabase secrets set` (see `DEPLOYMENT.md`). The client never receives the OpenAI key, the service-role key or database credentials.
