# Load Test Plan and Results

## Traffic assumptions (MVP; for client confirmation)

The specification targets about **200 users and 5+ guilds** in total (概要1). It does **not** assume that all 200 are active at once.

| Assumption | Value |
|------------|-------|
| Registered users | 200 |
| Peak concurrently active users | 40 (20 %) |
| REST reads per active user | about 4 per minute (conversations, notifications, growth, profile) → about 3 req/s |
| Messages | 1 per active user per 2 min → about 0.33 msg/s, worst case all in one guild room |
| History / catch-up | 1 req/s |
| Recommendations (user + guild SQL) | 0.5 sessions/s |
| グッと | 1 per active user per 3 min |
| Diagnoses | bursty onboarding; AI jobs measured separately |

`SCALE` multiplies all rates (1 = assumed peak). Thresholds: REST p95 < 300 ms, message create p95 < 500 ms, history p95 < 300 ms, recommendations p95 < 800 ms, error rate < 1 % (expected 4xx excluded), checks > 99 %.

## Scripts

| Script | Measures |
|--------|----------|
| `tests/load/mvp-traffic.js` | Separate scenarios: `rest_reads`, `message_create`, `message_history`, `recommendations`, `reactions` |
| `tests/load/ai-jobs.js` | Diagnosis submission → job completion time (queue + worker), failures |
| `scripts/load-monitor.ts` | Per-second DB connections (total/active), pgmq queue length and oldest-message age, pending/failed jobs → CSV |

```bash
# local (Linux dev server, mock AI)
deno run -A scripts/mint-tokens.ts > tests/load/tokens.local.json
deno run -A scripts/load-monitor.ts 70 > tests/load/results/monitor.csv &
TOKENS_FILE=$PWD/tests/load/tokens.local.json SCALE=1 DURATION=60s k6 run tests/load/mvp-traffic.js
# staging (Supabase sign-in for USERS test accounts)
API_BASE_URL=https://<ref>.supabase.co/functions/v1/api SUPABASE_URL=https://<ref>.supabase.co SUPABASE_ANON_KEY=... \
  TEST_PASSWORD=... USERS=60 SCALE=1 k6 run tests/load/mvp-traffic.js
```

## Results: local Linux dev server (2026-10-02)

> Environment: single Deno process (the same `createApp` as the Edge Function) and user-space PostgreSQL 16 on the developer machine, mock AI. **These numbers show the SQL and code paths are not a bottleneck. They are not staging numbers.** Network latency, the Supabase gateway, Edge cold starts and the pooler are not included.

| Scenario | p95 at SCALE=1 | p95 at SCALE=5 | max at SCALE=5 |
|----------|---------------:|---------------:|---------------:|
| rest_reads | 14.7 ms | 14.8 ms | 169 ms |
| message_create | 23.9 ms | 19.4 ms | 43 ms |
| message_history (+ catch-up) | 39.1 ms | 39.1 ms | 193 ms |
| recommendations (user + guild) | 107.8 ms | 93.6 ms | 200 ms |
| reactions | 33.5 ms | 31.7 ms | 125 ms |

- Requests: 418 (SCALE=1, 7 req/s) and 2,048 (SCALE=5, 34 req/s). All thresholds passed.
- Errors: 0 % for reads and message creation. The overall `http_req_failed` of 0.29 % at SCALE=5 consists of expected `409 ALREADY_REACTED` / `400 CANNOT_REACT_TO_SELF` responses in the reactions scenario (random targets).
- Database: at most 8 connections (4 active) at SCALE=5.
- AI jobs (mock AI): 9 concurrent diagnoses all completed, 0 failures. Completion about 3 s, dominated by the 3 s client poll interval. The queue backlog never exceeded 0 at 1 s sampling.

## Staging (pending)

Not run yet: there is no staging project. When it exists, run `mvp-traffic.js` at SCALE 1 and 3, and `ai-jobs.js` with `COUNT=10` under the staging AI budget, then record p95, error rate, connection peak (Supabase → Database → Connections) and cold-start impact here.
