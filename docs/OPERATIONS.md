# Operations and Handover Guide

There is no admin dashboard in the MVP (out of scope). Operators use the Supabase dashboard (SQL editor, logs) with the service-level SQL functions below. Every operator function writes `audit_logs` and/or `moderation_events`.

## 1. Daily operation

| Task | How |
|------|-----|
| Change a setting (limits, budgets, capacity, consent version) | `update app.app_settings set value = '<json>' where key = '<key>';`. The API caches settings for 30 s. Keys: `ASSUMPTIONS.md`. |
| Publish / archive a guild | `insert into app.guilds (slug, name, description, status, capacity) values (...)` then `insert into app.conversations (kind, guild_id) values ('guild', <id>)`; archive: `update app.guilds set status = 'archived' where id = ...` |
| Guild matching parameters | `insert into app.guild_match_traits (guild_id, question_code, match_key, label) ...` (keys: `opt:Q6:B`, `work:<uuid>`, `tag:<uuid>`) |
| Guild roles / announcements | `select app.svc_set_guild_role(<guild>, <user>, 'leader');` / `insert into app.guild_announcements (guild_id, title, body) ...` |
| Import or update the anime master | `deno run -A scripts/import-anime-master.ts --dir <csv dir> --apply` (idempotent upsert; see `templates/anime-master/README.md`) |
| Review reports | `select id, target_type, reason_code, snapshot, created_at from app.reports where status = 'received' order by created_at;` |
| Hide a message | `select app.svc_moderation_hide_message(<message_id>, 'harassment', '<operator name>');` |
| Resolve / dismiss a report | `select app.svc_resolve_report(<report_id>, 'resolved' or 'dismissed', '<note>', '<operator name>');` (evidence hold is released 90 days after resolution by maintenance) |
| Retry failed AI jobs | `select id, last_error_code from app.ai_jobs where status = 'failed';`; users can retry, or operators run `update app.ai_jobs set status = 'retrying', attempts = 0, next_attempt_at = now() where id = ...;` + `select pgmq.send('ai_jobs', jsonb_build_object('job_id', '<id>'));` |
| New question-set version | Insert a new `question_sets` row (`draft`) with questions/options, then in one transaction retire the old set and activate the new one. Clients get `QUESTION_SET_OUTDATED` and re-fetch. |
| New formula version | Insert a `matching_rule_versions` row (`draft`), add golden fixtures `tests/golden/<version>.json`, run tests, then switch `status` (one active per kind). |

## 2. Logging and monitoring

**Logs:** API and worker emit one JSON line per request or worker run: `request_id`, route, status, latency, pseudonymous `user_id`. They never contain answers, message text, prompts or tokens. View them in Supabase → Edge Functions → Logs, or configure a log drain (Datadog, Logflare, etc.).

**Key queries:**

```sql
-- queue backlog and age
select * from pgmq.metrics('ai_jobs');
-- jobs by status (last 24 h)
select kind, status, count(*) from app.ai_jobs where created_at > now() - interval '1 day' group by 1, 2;
-- AI spend today and failure rates
select purpose, status, count(*), round(sum(estimated_cost_usd), 4) usd, percentile_disc(0.95) within group (order by latency_ms) p95_ms
from app.ai_runs where created_at > date_trunc('day', now()) group by 1, 2 order by 1, 2;
-- open reports
select count(*) from app.reports where status in ('received', 'reviewing');
-- pending account deletions
select status, count(*) from app.account_deletion_requests group by 1;
-- cron health
select jobname, status, start_time from cron.job_run_details order by start_time desc limit 20;
```

**Suggested alerts:**

| Signal | Threshold |
|--------|-----------|
| API 5xx rate | > 1 % over 5 min |
| `pgmq.metrics('ai_jobs').oldest_msg_age_sec` | > 300 s |
| `ai_jobs` failed in the last hour | > 5 |
| AI spend | > 80 % of `ai.budget.daily_usd` (jobs defer to `retrying` when exceeded) |
| `ai_runs` with `invalid_output` or `refused` | > 10 % per hour |
| Account deletions in `failed` | any |
| Reports pending | > 24 h old |
| DB connections | > 80 % of the plan limit |

## 3. Data retention (configurable; see ASSUMPTIONS I-04, I-05, F-07)

| Data | Retention |
|------|-----------|
| Guild/DM messages | newest 1,000 per conversation (purged hourly), unless under evidence hold |
| Navigator history | newest 200 per user |
| Unattached uploads | 24 h |
| Idempotency keys | 24 h |
| AI run metadata (no content) | 180 days |
| Audit logs | 365 days |
| Evidence under report | until resolved + 90 days |
| Deleted accounts | personal data removed at processing; consent records and pseudonymous audit entries kept |

## 4. Incident runbook

| Symptom | Check | Action |
|---------|-------|--------|
| Diagnosis stuck in `accepted` | `pgmq.metrics`, `cron.job_run_details`, worker logs | Invoke the worker manually: `select app.invoke_worker('drain');` and check `WORKER_SECRET` / Vault values |
| Many `AI_BUDGET_EXCEEDED` | `svc_ai_budget_status()` | Raise `ai.budget.daily_usd` (with approval) or wait for the next UTC day; jobs resume automatically |
| `AI_RATE_LIMITED` | OpenAI dashboard | Jobs back off automatically; lower concurrency or raise provider limits |
| Users get `TOKEN_INVALID` after a key rotation | Auth signing keys | Ensure `CONIME_JWKS_URL` / issuer are correct; legacy HS256 secret set if still used |
| Realtime silent | Realtime logs, policy `conime_realtime_receive` | Clients still work through REST catch-up; check the private-channel setting and token refresh (`setAuth`) |
| Image generation exceeds Edge limits | worker logs (timeouts) | Move the worker to Cloud Run: `scripts/worker-server.ts` (same queue); point `conime_worker_url` to it |

## 5. Handover checklist

- Repository and README walkthrough; `scripts/test-all.sh` green on a clean Linux machine.
- Staging project credentials transferred to the client's owners; the developer's access removed afterwards.
- Open assumptions (`ASSUMPTIONS.md`) reviewed with the client; approved values applied to settings.
- `KNOWN_LIMITATIONS.md` and the unverified items in `TEST_REPORT.md` acknowledged.
