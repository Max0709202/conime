// AI job throughput: submits diagnoses for users without one and measures time to
// completion (queue latency + worker processing). Local: mock AI. Staging: real AI —
// keep COUNT small and the daily budget setting in place (docs/LOAD_TEST.md).
//   TOKENS_FILE=tests/load/new-users.local.json COUNT=20 k6 run tests/load/ai-jobs.js
import http from "k6/http";
import { sleep } from "k6";
import { Trend, Counter } from "k6/metrics";
import { auth, BASE, loadUsers, ok, uuid } from "./common.js";

const completion = new Trend("ai_job_completion_ms", true);
const failed = new Counter("ai_job_failed");
const USERS = loadUsers();
const COUNT = Number(__ENV.COUNT || 10);

export const options = {
  scenarios: { submit: { executor: "per-vu-iterations", vus: Math.min(COUNT, 10), iterations: Math.ceil(COUNT / Math.min(COUNT, 10)), maxDuration: "10m" } },
  thresholds: { ai_job_completion_ms: ["p(95)<120000"], ai_job_failed: ["count==0"] },
};

export function setup() {
  const qs = http.get(`${BASE}/v1/question-sets/current`).json();
  const cfg = http.get(`${BASE}/v1/app-config`).json();
  const answers = qs.questions.map((q) => (q.answer_type.endsWith("choice")
    ? { question_id: q.id, option_ids: [q.options[0].id] }
    : { question_id: q.id, texts: [q.code === "Q1" ? "星屑のアルカディア" : "負荷テスト"] }));
  return { answers, version: qs.version, consent: cfg.consent.ai_data_transfer.current_version };
}

export default function (d) {
  const idx = (__VU - 1) * Math.ceil(COUNT / Math.min(COUNT, 10)) + __ITER;
  if (idx >= USERS.length || idx >= COUNT) return;
  const t = USERS[idx].token;
  http.post(`${BASE}/v1/consents`, JSON.stringify({ consent_type: "ai_data_transfer", consent_version: d.consent, accepted: true }), auth(t));
  const started = Date.now();
  const sub = http.post(`${BASE}/v1/diagnosis/submissions`, JSON.stringify({ client_request_id: uuid(), question_set_version: d.version, consent_version: d.consent, answers: d.answers }), auth(t));
  if (!ok(sub, "submit", [202, 200])) return;
  const jobId = sub.json("job.id");
  for (let i = 0; i < 300; i++) {
    const job = http.get(`${BASE}/v1/generation-jobs/${jobId}`, Object.assign(auth(t), { tags: { name: "GET job" } })).json();
    if (job.status === "completed") { completion.add(Date.now() - started); return; }
    if (job.status === "failed") { failed.add(1); return; }
    sleep(job.poll_after_seconds || 1);
  }
  failed.add(1);
}
