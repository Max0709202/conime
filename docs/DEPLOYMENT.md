# Deployment Guide

## 1. Local development on Linux

### Option A: no Docker (verified)

This is the mode used for all Linux verification in `TEST_REPORT.md`. It needs a PostgreSQL 16+ server binary install (no running service or sudo required), Deno 2, Node 20+ (tooling only) and `curl`.

```bash
curl -fsSL https://deno.land/install.sh | sh        # Deno into ~/.deno
npm install                                         # OpenAPI lint, Prism mock, newman
scripts/db-local.sh reset --seed                    # user-space PostgreSQL on :54329 + pgmq + pgTAP + shim + migrations + seed
scripts/dev-api.sh                                  # API + storage emulator + worker on http://127.0.0.1:8787
scripts/test-all.sh                                 # lint, type-check, unit, pgTAP, integration
```

`scripts/db-local.sh` installs a **test-only shim** of the Supabase `auth`, `storage` and `realtime` schemas (`supabase/tests/shim/`). The shim is never deployed. Realtime WebSocket delivery and Supabase Storage/Auth servers are not available in this mode.

### Option B: Supabase local stack (Docker)

```bash
npm i -g supabase            # or brew/scoop; CLI ≥ 2.x
supabase start               # Postgres 17, Auth, Storage, Realtime, Edge runtime
supabase db reset            # migrations + supabase/seed/*.sql
supabase functions serve --env-file .env.local   # api + worker
deno run -A scripts/seed-storage.ts               # placeholder images for seeded data
supabase test db             # pgTAP suites (same files as Option A)
```

For `.env.local` in Option B, set `SUPABASE_URL=http://127.0.0.1:54321`, `SUPABASE_SERVICE_ROLE_KEY` (from `supabase status`), `STORAGE_DRIVER=supabase` and `CONIME_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres`.

## 2. Staging (requires the client's Supabase and OpenAI accounts)

> Provisioning a real Supabase project and an OpenAI API key is a paid external action that needs the client's approval and credentials. Nothing below has been executed yet.

1. **Create the project** (region: Tokyo `ap-northeast-1`). Enable **Queues** (pgmq) and the `pg_cron` and `pg_net` extensions.
2. **Link and migrate:**
   ```bash
   supabase link --project-ref <ref>
   supabase db push                               # applies supabase/migrations
   psql "$STAGING_DB_URL" -f supabase/settings/staging.sql
   ```
3. **Seed test data (staging only):** `psql "$STAGING_DB_URL" -f supabase/seed/10_anime_master.sql -f supabase/seed/20_users_guilds.sql`, then `deno run -A scripts/seed-storage.ts` with `STORAGE_DRIVER=supabase`. Replace the sample anime master with the client's CSVs: `deno run -A scripts/import-anime-master.ts --dir <client csv dir> --apply`.
4. **Secrets** (never in the repository):
   ```bash
   supabase secrets set CONIME_ENV=staging AI_PROVIDER=openai OPENAI_API_KEY=... WORKER_SECRET=$(openssl rand -hex 32) \
     STORAGE_DRIVER=supabase CONIME_DB_URL='postgresql://postgres.<ref>:<password>@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres'
   ```
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_DB_URL` are injected by the platform. Prefer the **transaction pooler** URL (port 6543) for `CONIME_DB_URL`. The pool uses `prepare: false`.
5. **Deploy functions:** `supabase functions deploy api && supabase functions deploy worker` (both `verify_jwt = false` in `config.toml`; the API verifies JWTs itself, and the worker requires `WORKER_SECRET`).
6. **Schedule the worker:** store the worker URL and secret in Vault (see the header of `supabase/settings/cron.sql`), then run `psql "$STAGING_DB_URL" -f supabase/settings/cron.sql`.
7. **Auth:** enable Apple and Google providers with the client's credentials, disable anonymous sign-ins, and keep refresh-token rotation on. Add the app's redirect URL if a browser flow is used.
8. **Realtime:** Settings → disable "Allow public access" (private channels only).
9. **Data API:** keep exposed schemas to `public` and `graphql_public` only. The `app` schema must **not** be exposed.
10. **Verify:**
    ```bash
    npx newman run postman/CONIME_Backend.postman_collection.json -e postman/staging.postman_environment.json   # your filled copy
    SUPABASE_URL=... SUPABASE_ANON_KEY=... API_BASE_URL=... TEST_PASSWORD=... deno task test:realtime
    API_BASE_URL=... SUPABASE_URL=... SUPABASE_ANON_KEY=... TEST_PASSWORD=... k6 run tests/load/mvp-traffic.js
    AI_EVAL_TARGET=staging EVAL_MAX_USD=2 ... deno task test:ai-eval
    ```

## 3. Production checklist

| # | Item | Done |
|---|------|------|
| 1 | Separate Supabase project (no shared credentials with staging); Pro plan or higher for PITR/backups | |
| 2 | Migrations applied with `supabase db push`; `supabase/settings/production.sql` applied; **no seed data** | |
| 3 | Client anime master imported and validated (`import-anime-master.ts`, zero validation errors) | |
| 4 | Consent wording approved; `consent.ai_data_transfer.current_version` matches the published text | |
| 5 | Secrets set: `OPENAI_API_KEY` (production key with an org spend limit), `WORKER_SECRET` (new), `CONIME_DB_URL` (pooler), `CONIME_ENV=production`, `AI_PROVIDER=openai` | |
| 6 | OpenAI usage limits set in the OpenAI dashboard; `ai.budget.daily_usd` agreed | |
| 7 | Model IDs and prices in `ai.models.*` / `ai.pricing` verified against the provider's current list | |
| 8 | Apple and Google sign-in configured; anonymous sign-in disabled; email sign-up policy decided | |
| 9 | Realtime public access disabled; Data API exposes no `app` schema | |
| 10 | Storage buckets `avatars` and `chat-attachments` private, with no storage.objects policies for anon/authenticated | |
| 11 | `cron.sql` scheduled; worker drain and maintenance jobs visible in `cron.job_run_details` | |
| 12 | Point-in-time recovery enabled; restore drill done once (section 4) | |
| 13 | Log drain / alerts configured (`OPERATIONS.md` section 2) | |
| 14 | Rate limits reviewed (`rate_limits` setting) | |
| 15 | Assumptions requiring approval signed off (`ASSUMPTIONS.md`, especially I-04 and I-05) | |
| 16 | Staging verification green: Postman, realtime client, k6, AI evaluation (budget-capped) | |
| 17 | iOS external checklist completed by frontend/client (`IOS_VALIDATION_CHECKLIST.md`) | |

## 4. Backup and restore

- **Automated:** Supabase daily backups (Pro) and point-in-time recovery (add-on). Storage objects are not included in database backups. If chat images must be recoverable, export the `chat-attachments` bucket periodically through the Storage S3-compatible API (e.g. `aws s3 sync --endpoint-url https://<ref>.supabase.co/storage/v1/s3 …`). Avatars can be regenerated, but regeneration costs AI budget.
- **Logical backup (any plan):**
  ```bash
  pg_dump "$DB_URL" --schema=app --format=custom --file=conime-app-$(date +%F).dump
  pg_dump "$DB_URL" --schema=auth --data-only --format=custom --file=conime-auth-$(date +%F).dump   # contains personal data: encrypt and restrict
  ```
- **Restore drill:** restore into a fresh project or the local stack: `supabase db reset` (empty schema) → `pg_restore --data-only --disable-triggers -d "$DB_URL" conime-app.dump`. Then run `scripts/test-db.sh` read-only checks and the Postman read-only folders.
- **Migrations are forward-only.** To roll back a release, deploy the previous function version (`supabase functions deploy` from the previous tag) and apply a new corrective migration. Never edit applied migrations.
