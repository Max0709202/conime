import { Hono, z } from "../../_shared/deps.ts";
import { ApiError, fromDbError } from "../../_shared/errors.ts";
import { ok, UUID_RE } from "../../_shared/http.ts";
import { readIdempotencyKey, withIdempotency } from "../../_shared/idempotency.ts";
import { type QuestionDefinition, validateAnswers } from "../../_shared/validation.ts";
import { kickWorker } from "../../_shared/worker_client.ts";
import { type AppEnv, getSetting, iso, memberTx, mockScenario, parseBody, requireUser } from "../context.ts";
import { characterImage, characterSummary, submissionStatus } from "./serializers.ts";

export const diagnoses = new Hono<AppEnv>();

const DiagnosisSubmitRequest = z.object({
  question_set_id: z.string().uuid(),
  question_set_version: z.number().int().min(1),
  answered_at: z.string().datetime({ offset: true }).optional(),
  answers: z.array(z.object({
    question_code: z.string().min(1).max(10),
    option_codes: z.array(z.string().max(10)).max(30).optional(),
    texts: z.array(z.string().max(2000)).max(10).optional(),
  })).min(1).max(100),
});

const GENERATION_SCENARIOS = new Set(["generation_failed", "generation_slow"]);

// 何をしても DB エラーは API エラーに変換して投げ直す（private.* の業務エラー）
async function db<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    throw fromDbError(e) ?? e;
  }
}

// POST /diagnoses：診断回答の一括送信（API07）。202 で即時受付し、生成は worker が非同期で行う
diagnoses.post("/diagnoses", async (c) => {
  await requireUser(c); // 認証エラー（401）を入力検証（400）より先に返す
  const key = readIdempotencyKey(c.req.header("Idempotency-Key"), true)!;
  const body = await parseBody(c, DiagnosisSubmitRequest);
  const scenario = mockScenario(c);

  const result = await memberTx(c, (tx) =>
    withIdempotency(tx, key, "POST /diagnoses", body, async () => {
      const poll = await getSetting(tx, "diagnosis.poll_after_seconds", 3);
      // 同意 → 送信回数 → 版 の順に確認（同じキーの再送なら既存の送信をそのまま返す）
      const [pre] = await db(tx`select private.diagnosis_precheck(${body.question_set_id}, ${key}) as r`);
      const precheck = pre.r as { replay?: Record<string, unknown>; question_set?: Record<string, unknown> };
      if (precheck.replay) {
        return { status: 202, body: ok(accepted(precheck.replay, poll)) };
      }
      const def = precheck.question_set as { version: number; questions: QuestionDefinition[] };
      if (def.version !== body.question_set_version) {
        throw new ApiError("QUESTION_SET_OUTDATED", "question_set_version does not match question_set_id", [
          { field: "question_set_version", reason: "mismatch", expected: def.version },
        ]);
      }
      const { errors, normalized } = validateAnswers(def.questions, body.answers);
      if (errors.length > 0) {
        throw new ApiError("VALIDATION_ERROR", `${errors[0].field} ${errors[0].reason}`, errors);
      }
      const payload: Record<string, unknown> = { answered_at: body.answered_at ?? null };
      if (scenario && GENERATION_SCENARIOS.has(scenario)) payload.mock_scenario = scenario;

      const [created] = await db(tx`
        select private.create_diagnosis_submission(
          ${body.question_set_id}, ${tx.json(normalized as never)}, ${key}, ${tx.json(payload as never)}
        ) as r`);
      return { status: 202, body: ok(accepted(created.r, poll)) };
    }));

  kickWorker();
  const data = (result.body as { data: { submission_id: string } }).data;
  c.header("Location", `/functions/v1/api/v1/diagnoses/${data.submission_id}`);
  return c.json(result.body as object, 202);
});

function accepted(s: Record<string, unknown>, poll: number) {
  return {
    submission_id: s.submission_id,
    status: s.status,
    submitted_at: iso(s.submitted_at as string),
    poll_after_seconds: poll,
  };
}

// GET /diagnoses/{submission_id}：生成状態だけを返す（何度呼んでも生成を重複させない・設計04）
diagnoses.get("/diagnoses/:submission_id", async (c) => {
  const id = c.req.param("submission_id");
  if (!UUID_RE.test(id)) throw new ApiError("NOT_FOUND", "submission not found");
  const data = await memberTx(c, async (tx) => {
    await tx`select private.expire_stale_generation()`; // 待機上限（3分）を超えたものは failed
    const [s] = await tx`
      select id, status, submitted_at, completed_at, error_code
      from public.diagnosis_submissions where id = ${id}`; // 他人の送信は RLS で見えない → 404
    if (!s) throw new ApiError("NOT_FOUND", "submission not found");
    return submissionStatus(s, await getSetting(tx, "diagnosis.poll_after_seconds", 3));
  });
  // 実行待ちのジョブを worker に拾わせる（新しい生成は登録しない）
  if (data.status === "received") kickWorker();
  return c.json(ok(data));
});

// POST /diagnoses/{submission_id}/retry：生成失敗時の再試行
diagnoses.post("/diagnoses/:submission_id/retry", async (c) => {
  const id = c.req.param("submission_id");
  if (!UUID_RE.test(id)) throw new ApiError("NOT_FOUND", "submission not found");
  const key = readIdempotencyKey(c.req.header("Idempotency-Key"), false);
  const scenario = mockScenario(c);
  const payload: Record<string, unknown> = {};
  if (scenario && GENERATION_SCENARIOS.has(scenario)) payload.mock_scenario = scenario;

  const result = await memberTx(c, (tx) =>
    withIdempotency(tx, key, `POST /diagnoses/${id}/retry`, {}, async () => {
      const [r] = await db(tx`select private.retry_diagnosis(${id}, ${tx.json(payload as never)}) as r`);
      return { status: 202, body: ok(submissionStatus(r.r, await getSetting(tx, "diagnosis.poll_after_seconds", 3))) };
    }));
  kickWorker();
  return c.json(result.body as object, 202);
});

// GET /me/diagnosis-result：プロフィール・キャラ・画像・推薦を一括取得（API08）。各部分に status を持つ
diagnoses.get("/me/diagnosis-result", async (c) => {
  const data = await memberTx(c, async (tx, user) => {
    const [s] = await tx`select id, status from public.diagnosis_submissions where user_id = ${user.userId}`;
    if (!s) throw new ApiError("NOT_FOUND", "diagnosis has not been submitted");
    const [profile] = await tx`select * from public.ai_profiles where user_id = ${user.userId}`;
    const [ch] = await tx`select * from public.characters where user_id = ${user.userId}`;
    const pending = s.status === "received" || s.status === "processing";
    return {
      submission: { submission_id: s.id, status: s.status },
      profile: {
        status: profile ? "ready" : s.status === "failed" ? "failed" : "pending",
        personality: profile?.personality ?? null,
        items: profile?.profile_items ?? [],
        ai_comments: profile?.ai_comments ?? [],
      },
      character: ch ? characterSummary(ch, profile) : null,
      image: await characterImage(ch, pending ? "generating" : s.status === "failed" ? "failed" : "none"),
      // 推薦は第2段階（P2-3）で生成する
      recommendations: { status: "pending", works: [], guilds: [], users: [] },
    };
  });
  return c.json(ok(data));
});
