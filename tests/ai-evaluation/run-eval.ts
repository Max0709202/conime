// AI evaluation over Japanese diagnosis fixtures. Measures schema validity,
// normalization accuracy, invented-ID rate, latency and cost, with a hard budget stop.
//
// Local (harness check, mock AI):   deno run -A tests/ai-evaluation/run-eval.ts
// Staging (real AI, limited):       AI_EVAL_TARGET=staging API_BASE_URL=... CONIME_DB_URL=<staging db url> \
//                                   EVAL_MAX_USD=2 deno run -A tests/ai-evaluation/run-eval.ts
// The staging run uses the deployed API + worker; this script only creates throw-away users,
// submits diagnoses and reads metrics. Never run unrestricted live image generation in CI.
import postgres from "postgres";
import { mintTestToken } from "../../supabase/functions/_shared/auth/jwt.ts";

interface Fixture { id: string; description: string; answers: Record<string, string[]>; expected: Record<string, string[]> }

const dbUrl = Deno.env.get("CONIME_DB_URL") ?? "postgresql://postgres@127.0.0.1:54329/conime";
const api = Deno.env.get("API_BASE_URL") ?? "http://127.0.0.1:8787";
const maxUsd = Number(Deno.env.get("EVAL_MAX_USD") ?? "1");
const limit = Number(Deno.env.get("EVAL_LIMIT") ?? "100");
const sql = postgres(dbUrl, { max: 2, onnotice: () => {} });
const secret = Deno.env.get("CONIME_JWT_SECRET") ?? "local-only-jwt-secret-change-me-at-least-32-characters";
const staging = Deno.env.get("AI_EVAL_TARGET") === "staging";

const dir = new URL("./fixtures/", import.meta.url);
const fixtures: Fixture[] = [];
for await (const f of Deno.readDir(dir)) if (f.name.endsWith(".json")) fixtures.push(JSON.parse(await Deno.readTextFile(new URL(f.name, dir))));
fixtures.sort((a, b) => a.id.localeCompare(b.id));

const qs = await (await fetch(`${api}/v1/question-sets/current`)).json();
const cfg = await (await fetch(`${api}/v1/app-config`)).json();
const started = new Date();

async function tokenFor(userId: string): Promise<string> {
  if (!staging) return await mintTestToken(secret, userId);
  // Staging: create the user via Auth admin and sign in (requires SUPABASE_URL + SERVICE ROLE key in the environment).
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const email = `eval-${userId}@conime.test`;
  const password = crypto.randomUUID();
  const created = await fetch(`${url}/auth/v1/admin/users`, { method: "POST", headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ id: userId, email, password, email_confirm: true }) });
  if (!created.ok) throw new Error(`admin create user failed ${created.status}`);
  const s = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: key, "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  return (await s.json()).access_token;
}

function answersFor(f: Fixture) {
  return qs.questions.map((q: { id: string; code: string; answer_type: string; options: Array<{ id: string }> }) => {
    if (q.answer_type.endsWith("choice")) return { question_id: q.id, option_ids: [q.options[0].id] };
    const t = f.answers[q.code] ?? ["評価用の回答"];
    return { question_id: q.id, texts: q.answer_type === "free_text_multi" ? [t.join("、")] : t };
  });
}

const results: Array<Record<string, unknown>> = [];
for (const f of fixtures.slice(0, limit)) {
  const [{ spent }] = await sql`select coalesce(sum(estimated_cost_usd), 0)::float as spent from app.ai_runs where created_at >= ${started}`;
  if (spent >= maxUsd) {
    console.warn(`budget ${maxUsd} USD reached (${spent}); stopping`);
    break;
  }
  const userId = crypto.randomUUID();
  if (!staging) await sql`insert into auth.users (id, email) values (${userId}, ${`eval-${userId}@conime.test`})`;
  const token = await tokenFor(userId);
  const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  await fetch(`${api}/v1/me`, { headers: h });
  await fetch(`${api}/v1/consents`, { method: "POST", headers: h, body: JSON.stringify({ consent_type: "ai_data_transfer", consent_version: cfg.consent.ai_data_transfer.current_version, accepted: true }) });
  const t0 = Date.now();
  const sub = await (await fetch(`${api}/v1/diagnosis/submissions`, { method: "POST", headers: h,
    body: JSON.stringify({ client_request_id: crypto.randomUUID(), question_set_version: qs.version, consent_version: cfg.consent.ai_data_transfer.current_version, answers: answersFor(f) }) })).json();
  let job = sub.job;
  while (job && !["completed", "failed"].includes(job.status) && Date.now() - t0 < 180_000) {
    await new Promise((r) => setTimeout(r, 1000));
    job = await (await fetch(`${api}/v1/generation-jobs/${job.id}`, { headers: h })).json();
  }
  const feats = await sql`select f.question_code, f.resolution, coalesce(w.external_code, c.external_code, t.kind || ':' || t.code) as code
    from app.profile_features f left join app.anime_works w on w.id = f.work_id left join app.anime_characters c on c.id = f.character_id
    left join app.tags t on t.id = f.tag_id where f.user_id = ${userId} and f.feature_kind <> 'option'`;
  const runs = await sql`select purpose, status, latency_ms, estimated_cost_usd::float as cost from app.ai_runs where user_id = ${userId}`;
  const [{ stats }] = await sql`select stage_state -> 'normalization' as stats from app.ai_jobs where user_id = ${userId}`;
  let expectedTotal = 0, hit = 0, falsePositive = 0;
  for (const [q, codes] of Object.entries(f.expected)) {
    const got = feats.filter((x) => x.question_code === q && x.resolution !== "unresolved").map((x) => x.code);
    expectedTotal += codes.length;
    hit += codes.filter((c) => got.includes(c)).length;
    falsePositive += got.filter((g) => !codes.includes(g)).length;
  }
  results.push({
    fixture: f.id, job_status: job?.status, duration_ms: Date.now() - t0,
    expected: expectedTotal, matched: hit, false_positives: falsePositive,
    invented_ids_rejected: stats?.rejected_ids ?? 0,
    runs: runs.length, invalid_outputs: runs.filter((r) => r.status === "invalid_output").length,
    cost_usd: runs.reduce((s, r) => s + (r.cost ?? 0), 0),
  });
  console.log(`${f.id}: ${job?.status} matched ${hit}/${expectedTotal} fp=${falsePositive}`);
}

const sum = (k: string) => results.reduce((s, r) => s + Number(r[k] ?? 0), 0);
const summary = {
  target: api, provider_note: staging ? "staging (live AI)" : "local (mock AI unless the dev server uses AI_PROVIDER=openai)",
  fixtures: results.length,
  jobs_completed: results.filter((r) => r.job_status === "completed").length,
  normalization_recall: sum("expected") ? +(sum("matched") / sum("expected")).toFixed(3) : null,
  false_positive_count: sum("false_positives"),
  invented_ids_rejected: sum("invented_ids_rejected"),
  schema_invalid_rate: sum("runs") ? +(sum("invalid_outputs") / sum("runs")).toFixed(3) : 0,
  p50_job_ms: results.map((r) => Number(r.duration_ms)).sort((a, b) => a - b)[Math.floor(results.length / 2)] ?? null,
  total_cost_usd: +sum("cost_usd").toFixed(4),
  budget_usd: maxUsd,
};
await Deno.mkdir(new URL("./results/", import.meta.url), { recursive: true });
const out = new URL(`./results/eval-${started.toISOString().replace(/[:.]/g, "-")}.json`, import.meta.url);
await Deno.writeTextFile(out, JSON.stringify({ summary, results }, null, 2));
console.log(JSON.stringify(summary, null, 2));
await sql.end();
