// Edge Function：worker（生成ジョブの実行・再試行）
//   api（診断送信・再試行の直後）と pg_cron（private.kick_worker、毎分）から起動される。
//   x-worker-secret ヘッダーで保護し、すぐに 202 を返してバックグラウンドでジョブを処理する。
//   ジョブは FOR UPDATE SKIP LOCKED で取得するため、同時に複数起動しても二重に生成しない。
import { AiError, type DiagnosisAnswerInput, getAiProvider } from "../_shared/ai/provider.ts";
import { sql } from "../_shared/db.ts";
import { env } from "../_shared/env.ts";
import { sleep } from "../_shared/http.ts";
import { CHARACTER_BUCKET, uploadObject } from "../_shared/storage.ts";
import { runInBackground } from "../_shared/worker_client.ts";

interface Job {
  id: string;
  user_id: string;
  job_type: string;
  attempts: number;
  payload: Record<string, unknown>;
}

const RUN_BUDGET_MS = 120_000;
const RETRY_DELAYS_SECONDS = [2, 5, 10];
const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ fn: "worker", ...o }));

let running: Promise<void> | null = null;

Deno.serve((req) => {
  if (req.method !== "POST") return new Response(null, { status: 405 });
  if (!env.workerSecret || req.headers.get("x-worker-secret") !== env.workerSecret) {
    return Response.json({ error: { code: "UNAUTHENTICATED", message: "invalid worker secret" } }, { status: 401 });
  }
  // 同じインスタンスでは1本のループで処理する
  running ??= drain().finally(() => (running = null));
  runInBackground(running);
  return Response.json({ data: { accepted: true } }, { status: 202 });
});

async function drain() {
  const deadline = Date.now() + RUN_BUDGET_MS;
  while (Date.now() < deadline) {
    const jobs = await sql<Job[]>`select id, user_id, job_type, attempts, payload from private.claim_generation_jobs(5)`;
    if (jobs.length === 0) {
      // 再試行待ち（run_after が近い）のジョブがあれば少し待って続ける
      const [next] = await sql<{ wait: number | null }[]>`
        select extract(epoch from min(run_after) - now())::float8 as wait
        from public.generation_jobs where status = 'queued'`;
      if (next.wait !== null && next.wait < 15) {
        await sleep(Math.max(200, next.wait * 1000));
        continue;
      }
      return;
    }
    await Promise.all(jobs.map(processJob));
  }
}

async function processJob(job: Job) {
  const started = Date.now();
  try {
    if (job.job_type === "diagnosis") await runDiagnosisJob(job);
    else if (job.job_type === "character_image") await runCharacterImageJob(job);
    else throw new AiError("UNSUPPORTED_JOB_TYPE", job.job_type, false);
    log({ job_id: job.id, job_type: job.job_type, status: "succeeded", attempts: job.attempts, ms: Date.now() - started });
  } catch (e) {
    const code = e instanceof AiError ? e.code : "WORKER_ERROR";
    const retryable = e instanceof AiError ? e.retryable : true;
    const delay = RETRY_DELAYS_SECONDS[Math.min(job.attempts - 1, RETRY_DELAYS_SECONDS.length - 1)];
    const [row] = await sql`select private.fail_generation_job(${job.id}, ${code}, ${delay}::int, ${retryable}) as status`;
    log({ job_id: job.id, job_type: job.job_type, status: row.status, attempts: job.attempts, error_code: code, error: String(e) });
  }
}

async function loadAnswers(submissionId: string): Promise<DiagnosisAnswerInput[]> {
  return await sql<DiagnosisAnswerInput[]>`
    select q.code, q.title, q.answer_type, q.usages, a.option_codes, a.texts,
           coalesce((
             select json_agg(json_build_object('code', o.code, 'label', o.label, 'attributes', o.attributes) order by o.sort_order)
             from public.question_options o
             where o.question_id = q.id and o.code = any (a.option_codes)
           ), '[]'::json) as selected
    from public.diagnosis_answers a
    join public.questions q on q.id = a.question_id
    where a.submission_id = ${submissionId}
    order by q.sort_order`;
}

// 画像の生成とアップロード。失敗しても診断結果は完了扱いにし、画像だけ failed にする（部分完了・U-08）
async function renderAndUpload(job: Job, answers: DiagnosisAnswerInput[], stage: number) {
  try {
    const png = await getAiProvider().renderCharacterImage(answers, stage);
    const path = `${job.user_id}/current.png`;
    await uploadObject(CHARACTER_BUCKET, path, png, "image/png");
    return { path, status: "ready" as const };
  } catch (e) {
    log({ job_id: job.id, msg: "image upload failed", error: String(e) });
    return { path: null, status: "failed" as const };
  }
}

async function runDiagnosisJob(job: Job) {
  const submissionId = String(job.payload.submission_id);
  const answers = await loadAnswers(submissionId);
  if (answers.length === 0) throw new AiError("ANSWERS_NOT_FOUND", submissionId, false);
  const scenario = env.mockMode ? (job.payload.mock_scenario as string | undefined) : undefined;
  const generated = await getAiProvider().generateDiagnosis(answers, { mockScenario: scenario });
  const image = await renderAndUpload(job, answers, 0);
  await sql`select private.complete_diagnosis_job(${job.id}, ${sql.json(generated as never)}, ${image.path}, ${image.status})`;
}

async function runCharacterImageJob(job: Job) {
  const answers = await loadAnswers(String(job.payload.submission_id));
  const stage = Number(job.payload.image_stage ?? 0);
  const image = await renderAndUpload(job, answers, stage);
  if (image.status !== "ready") throw new AiError("IMAGE_GENERATION_FAILED");
  await sql`select private.complete_image_job(${job.id}, ${image.path}, ${image.status})`;
}
