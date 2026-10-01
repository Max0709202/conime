// Queue consumer and job pipelines. Host-agnostic: runs inside the `worker` Edge
// Function or any container (e.g. Cloud Run) with the same dependencies.
//
// Safety properties:
//   * a job is processed only under a lease (svc_claim_job) with a fencing token;
//   * every stage first checks whether its output already exists, so re-delivered
//     or retried jobs never duplicate features, characters, images or recommendations;
//   * AI output is schema-validated and IDs are checked against the supplied candidates.
import type { Db } from "../db/pool.ts";
import type { StorageGateway } from "../storage/gateway.ts";
import type { AiRunner } from "../ai/runner.ts";
import { AiError } from "../ai/provider.ts";
import type { AuthAdmin } from "../http/app.ts";
import {
  buildImagePrompt, type ContextAnswer, DEFAULT_RARITY_WEIGHTS, deriveElement, deriveRarity, deriveStats,
  deriveVisualElements, findForbiddenNames, type VisualElements,
} from "../domain/character.ts";
import { normalizeAnswers } from "./normalize-answers.ts";

export interface WorkerDeps {
  db: Db;
  storage: StorageGateway;
  ai: AiRunner;
  authAdmin: AuthAdmin;
  log?: (e: Record<string, unknown>) => void;
}

type Job = {
  id: string; user_id: string; kind: "diagnosis_generation" | "evolution_image"; status: string;
  payload: Record<string, unknown>; stage_state: Record<string, unknown>; attempts: number; max_attempts: number;
  lock_token: string;
};

interface JobContext {
  job: Job;
  user_id: string;
  consent_valid: boolean;
  submission_id: string | null;
  answers: ContextAnswer[];
  avatar: Record<string, unknown> | null;
  growth: Record<string, unknown> | null;
  has_recommendations: boolean;
}

class StageError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean, readonly delaySec?: number) {
    super(message);
  }
}

const log = (deps: WorkerDeps, e: Record<string, unknown>) => (deps.log ?? ((x) => console.log(JSON.stringify(x))))(e);

// ---------------------------------------------------------------------------
// Queue consumption
// ---------------------------------------------------------------------------
export async function runWorkerBatch(deps: WorkerDeps, opts: { maxMessages?: number; visibilitySeconds?: number; deadlineMs?: number } = {}) {
  const deadline = Date.now() + (opts.deadlineMs ?? 50_000);
  const results: Array<{ job_id: string; outcome: string }> = [];
  while (Date.now() < deadline) {
    const msgs = await deps.db.asService(null, (tx) =>
      tx`select msg_id, job_id from app.svc_queue_read(${opts.visibilitySeconds ?? 300}, ${opts.maxMessages ?? 5})`);
    if (!msgs.length) break;
    for (const m of msgs) {
      const jobId = String(m.job_id ?? "");
      const outcome = await processMessage(deps, Number(m.msg_id), jobId);
      results.push({ job_id: jobId, outcome });
      if (Date.now() >= deadline) break;
    }
  }
  return { processed: results.length, results };
}

async function processMessage(deps: WorkerDeps, msgId: number, jobId: string): Promise<string> {
  const archive = () => deps.db.asService(null, (tx) => tx`select app.svc_queue_archive(${msgId})`);
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) {
    await archive();
    return "invalid_message";
  }
  const leaseSeconds = 180;
  const claim = await deps.db.callService<{ claimed: boolean; job?: Job; exists?: boolean; status?: string; next_attempt_at?: string }>(
    null, "svc_claim_job", [jobId, leaseSeconds]);
  if (!claim.claimed) {
    if (!claim.exists || ["completed", "failed", "superseded"].includes(String(claim.status))) {
      await archive(); // duplicate delivery of a finished job
      return "duplicate_archived";
    }
    if (claim.next_attempt_at && new Date(claim.next_attempt_at) > new Date()) {
      const secs = Math.ceil((new Date(claim.next_attempt_at).getTime() - Date.now()) / 1000);
      await deps.db.asService(null, (tx) => tx`select app.svc_queue_defer(${msgId}, ${secs})`);
      return "deferred";
    }
    return "leased_elsewhere"; // message becomes visible again after its visibility timeout
  }

  const job = claim.job!;
  try {
    const outcome = job.kind === "diagnosis_generation" ? await runDiagnosis(deps, job) : await runEvolution(deps, job);
    await archive();
    return outcome;
  } catch (err) {
    const e = toStageError(err, job);
    log(deps, { level: e.retryable ? "warn" : "error", msg: "job stage failed", job_id: job.id, kind: job.kind, code: e.code, error: e.message.slice(0, 300) });
    try {
      const status = await deps.db.callService<string>(null, "svc_fail_job", [job.id, job.lock_token, e.code, e.message, e.retryable, e.delaySec ?? null]);
      await archive();
      return status;
    } catch (inner) {
      log(deps, { level: "error", msg: "fail_job failed (lease lost?)", job_id: job.id, error: String(inner).slice(0, 200) });
      return "lease_lost";
    }
  }
}

function toStageError(err: unknown, job: Job): StageError {
  if (err instanceof StageError) return err;
  if (err instanceof AiError) {
    if (err.code === "AI_BUDGET_EXCEEDED") return new StageError(err.code, err.message, true, 3600);
    if (err.code === "AI_RATE_LIMITED") return new StageError(err.code, err.message, true, Math.max(30, err.retryAfterSec ?? 60));
    return new StageError(err.code, err.message, err.retryable);
  }
  return new StageError("INTERNAL", `${(err as Error)?.message ?? err} (job ${job.id})`, true);
}

async function context(deps: WorkerDeps, job: Job): Promise<JobContext> {
  const ctx = await deps.db.callService<JobContext>(null, "svc_job_context", [job.id]);
  if (!ctx) throw new StageError("JOB_NOT_FOUND", "job vanished", false);
  return ctx;
}

const update = (deps: WorkerDeps, job: Job, status: string | null, patch: Record<string, unknown> = {}) =>
  deps.db.callService(null, "svc_update_job", [job.id, job.lock_token, status, patch, 180]);

function isFinalAttempt(job: Job) {
  return job.attempts + 1 >= job.max_attempts;
}

// ---------------------------------------------------------------------------
// Diagnosis pipeline (設計02-B, 設計03, 設計05-A)
// ---------------------------------------------------------------------------
async function runDiagnosis(deps: WorkerDeps, job: Job): Promise<string> {
  let ctx = await context(deps, job);
  if (!ctx.consent_valid) throw new StageError("CONSENT_REQUIRED", "consent withdrawn or account inactive", false);
  if (!ctx.submission_id) throw new StageError("NOT_FOUND", "submission missing", false);
  const run = { jobId: job.id, userId: ctx.user_id, retryCount: job.attempts };
  const state = { ...job.stage_state };

  // 1. normalization
  if (!state.normalized) {
    await update(deps, job, "normalizing_answers");
    const { features, stats } = await normalizeAnswers(deps.db, deps.ai, ctx.answers, run);
    await deps.db.callService(null, "svc_save_features", [ctx.submission_id, features]);
    Object.assign(state, { normalized: true, normalization: stats });
    await update(deps, job, null, { normalized: true, normalization: stats });
  }

  // 2. profile and character attributes
  const ve = deriveVisualElements(ctx.answers);
  if (!state.profile_done || !ctx.avatar) {
    await update(deps, job, "generating_profile");
    await generateProfile(deps, job, ctx, ve, run);
    state.profile_done = true;
    await update(deps, job, null, { profile_done: true });
    ctx = await context(deps, job);
  }

  // 3. initial character image (stage 1)
  const avatar = ctx.avatar!;
  if (!(avatar.image_status === "ready" && Number(avatar.current_image_stage ?? 0) >= 1)) {
    await update(deps, job, "generating_image");
    await generateImage(deps, job, ctx, ve, 1, String(avatar.visual_description ?? ""));
  }

  // 4. anime recommendations
  if (!state.recs_done) {
    await update(deps, job, "generating_recommendations");
    await generateAnimeRecommendations(deps, job, ctx, run);
    await update(deps, job, null, { recs_done: true });
  }

  await deps.db.callService(null, "svc_complete_job", [job.id, job.lock_token]);
  return "completed";
}

function answerText(answers: ContextAnswer[], code: string): string[] {
  return answers.find((a) => a.question_code === code)?.values.map((v) => v.text ?? v.label ?? "").filter(Boolean) ?? [];
}

async function forbiddenNamesFor(deps: WorkerDeps, ctx: JobContext): Promise<string[]> {
  // Names of existing works/characters the user mentioned (resolved titles + raw answers).
  const rows = await deps.db.asService(null, (tx) => tx`
    select coalesce(w.title, c.name) as name from app.profile_features f
    left join app.anime_works w on w.id = f.work_id
    left join app.anime_characters c on c.id = f.character_id
    where f.user_id = ${ctx.user_id} and (f.work_id is not null or f.character_id is not null)`);
  const raw = ["Q1", "Q3", "Q7", "Q11", "Q12"].flatMap((q) => answerText(ctx.answers, q));
  return [...new Set([...rows.map((r) => String(r.name)), ...raw])];
}

async function generateProfile(deps: WorkerDeps, job: Job, ctx: JobContext, ve: VisualElements, run: { jobId: string; userId: string; retryCount: number }) {
  const forbidden = await forbiddenNamesFor(deps, ctx);
  const input = {
    answers: ctx.answers
      .filter((a) => a.purposes.some((p) => ["character_base", "character_adjust", "profile_display", "recommendation_material"].includes(p)))
      .map((a) => ({ question_code: a.question_code, topic: a.label, values: a.values.map((v) => v.text ?? v.label).filter(Boolean) })),
    visual_elements: ve,
    element: deriveElement(ve),
    species: ve.species_gender,
    forbidden_names: forbidden,
    requirements: { skills: 3, strengths: "2-3", weaknesses: "2-3", comment_question_codes: ["Q2", "Q4", "Q5"] },
  };

  type ProfileOut = {
    character: { character_class: string; title: string; personality: string; strengths: string[]; weaknesses: string[]; skills: Array<{ name: string; description: string }>; visual_description: string };
    profile: { summary: string; comments: Array<{ question_code: string; text: string }>; conversation_topics: string[] };
  };
  let out: ProfileOut | null = null;
  for (let attempt = 0; attempt < 2 && !out; attempt++) {
    const r = await deps.ai.json<ProfileOut>({ ...run, retryCount: run.retryCount + attempt }, "profile", input);
    const c = r.output.character;
    const hits = findForbiddenNames(`${c.visual_description}\n${c.title}\n${c.character_class}`, forbidden);
    if (c.skills.length < 3 || hits.length) {
      log(deps, { level: "warn", msg: "profile output rejected", job_id: job.id, reason: hits.length ? "forbidden_names" : "skills" });
      continue;
    }
    out = r.output;
  }
  if (!out) throw new StageError("AI_OUTPUT_UNSAFE", "profile output failed post-validation", true);

  const cfg = await deps.ai.config();
  const labels = new Map(ctx.answers.map((a) => [a.question_code, a.label]));
  const clip = (s: string, n: number) => [...s.trim()].slice(0, n).join("");
  const avatar = {
    species: ve.species_gender,
    character_class: clip(out.character.character_class, 20),
    element: deriveElement(ve),
    rarity: await deriveRarity(ctx.user_id, ai_setting(cfg, "character.rarity_weights", DEFAULT_RARITY_WEIGHTS)),
    title: clip(out.character.title, 24),
    personality: clip(out.character.personality, 120),
    strengths: out.character.strengths.slice(0, 3).map((s) => clip(s, 30)),
    weaknesses: out.character.weaknesses.slice(0, 3).map((s) => clip(s, 30)),
    skills: out.character.skills.slice(0, 3).map((s) => ({ name: clip(s.name, 24), description: clip(s.description, 80) })),
    stats: await deriveStats(ctx.user_id, ve),
    visual_elements: ve,
    visual_description: clip(out.character.visual_description, 600),
  };
  const aiProfile = {
    summary: clip(out.profile.summary, 200),
    comments: out.profile.comments
      .filter((c) => labels.has(c.question_code))
      .slice(0, 5)
      .map((c) => ({ question_code: c.question_code, label: labels.get(c.question_code)!, text: clip(c.text, 200) })),
    conversation_topics: out.profile.conversation_topics.slice(0, 5).map((t) => clip(t, 40)),
  };
  await deps.db.callService(null, "svc_save_profile", [ctx.user_id, avatar, aiProfile, "character-v1"]);
}

function ai_setting<T>(cfg: { settings: Record<string, unknown> }, key: string, fallback: T): T {
  const v = cfg.settings?.[key];
  return (v === undefined || v === null ? fallback : v) as T;
}

async function generateImage(deps: WorkerDeps, job: Job, ctx: JobContext, ve: VisualElements, stage: number, visualDescription: string) {
  const cfg = await deps.ai.config();
  const template = cfg.prompts.image?.system_prompt ?? "";
  const prompt = buildImagePrompt(template, ve, visualDescription, stage);
  const forbidden = await forbiddenNamesFor(deps, ctx);
  if (findForbiddenNames(prompt, forbidden).length) throw new StageError("AI_OUTPUT_UNSAFE", "image prompt contains a protected name", false);

  await deps.db.callService(null, "svc_set_image_status", [ctx.user_id, "generating"]);
  const { bytes } = await deps.ai.image({ jobId: job.id, userId: ctx.user_id, retryCount: job.attempts }, prompt);
  const bucket = ai_setting(cfg, "avatars.bucket", "avatars");
  const path = `${ctx.user_id}/${job.id}-s${stage}.png`; // deterministic per job+stage: re-runs overwrite, never duplicate
  await deps.storage.upload(bucket, path, bytes, "image/png");
  const res = await deps.db.callService<{ applied: boolean; delete_path: string | null }>(null, "svc_set_avatar_image", [ctx.user_id, path, stage]);
  if (res.delete_path) {
    // Remove the superseded object only after the replacement is stored and referenced (G-05).
    await deps.storage.remove(bucket, [res.delete_path]).catch((err) =>
      log(deps, { level: "warn", msg: "old image removal failed", job_id: job.id, error: String(err).slice(0, 200) }));
  }
}

async function generateAnimeRecommendations(deps: WorkerDeps, job: Job, ctx: JobContext, run: { jobId: string; userId: string; retryCount: number }) {
  const data = await deps.db.callService<{ rule_version: string; result_limit: number; candidates: Array<{ work_id: string; title: string; score: number; genres: string[]; summary: string | null; matched: Array<{ label: string; values: string[] }> }> }>(
    null, "svc_anime_candidates", [ctx.user_id]);
  const cands = data.candidates;
  if (!cands.length) {
    await deps.db.callService(null, "svc_save_anime_recommendations", [ctx.user_id, job.id, [], data.rule_version]);
    return;
  }
  const byId = new Map(cands.map((c) => [c.work_id, c]));
  const cfg = await deps.ai.config();
  const fallbackEnabled = ai_setting(cfg, "ai.anime_recs.fallback_enabled", true);

  let picks: Array<{ work_id: string; reason: string; source: "ai" | "template" }> | null = null;
  for (let attempt = 0; attempt < 2 && !picks; attempt++) {
    try {
      const r = await deps.ai.json<{ recommendations: Array<{ work_id: string; reason: string }> }>(
        { ...run, retryCount: run.retryCount + attempt }, "anime_recs", {
          result_limit: data.result_limit,
          preferences: {
            scene: answerText(ctx.answers, "Q2"), favorite_characters: answerText(ctx.answers, "Q3"),
            liked_points: answerText(ctx.answers, "Q4"), wished_ability: answerText(ctx.answers, "Q5"), reborn_as: answerText(ctx.answers, "Q12"),
          },
          candidates: cands.map((c) => ({ id: c.work_id, title: c.title, genres: c.genres, summary: c.summary, matched: c.matched.map((m) => m.label) })),
        });
      const recs = r.output.recommendations;
      const ids = recs.map((x) => x.work_id);
      const valid = recs.length <= data.result_limit && ids.every((id) => byId.has(id)) && new Set(ids).size === ids.length &&
        recs.every((x) => x.reason.trim().length > 0);
      if (!valid) {
        log(deps, { level: "warn", msg: "anime recs rejected (unapproved or duplicate IDs)", job_id: job.id });
        continue;
      }
      picks = recs.map((x) => ({ work_id: x.work_id, reason: [...x.reason.trim()].slice(0, 200).join(""), source: "ai" as const }));
    } catch (err) {
      if (!(err instanceof AiError) || !(fallbackEnabled && isFinalAttempt(job))) throw err;
      break;
    }
  }
  if (!picks) {
    if (!fallbackEnabled) throw new StageError("AI_INVALID_OUTPUT", "anime recommendations invalid", true);
    picks = cands.slice(0, data.result_limit).map((c) => ({
      work_id: c.work_id, source: "template" as const,
      reason: c.matched.length ? `${c.matched.map((m) => m.label).join("・")}があなたの好みと一致しています。` : "あなたの診断結果に近い作品です。",
    }));
  }
  const items = picks.map((p, i) => ({ rank: i + 1, work_id: p.work_id, score: byId.get(p.work_id)!.score, reason: p.reason, reason_source: p.source }));
  await deps.db.callService(null, "svc_save_anime_recommendations", [ctx.user_id, job.id, items, data.rule_version]);
}

// ---------------------------------------------------------------------------
// Evolution image (L-3, 設計08): only the latest requested stage is generated.
// ---------------------------------------------------------------------------
async function runEvolution(deps: WorkerDeps, job: Job): Promise<string> {
  const ctx = await context(deps, job);
  if (!ctx.consent_valid) throw new StageError("CONSENT_REQUIRED", "consent withdrawn or account inactive", false);
  const stage = Number(job.payload.stage_level);
  const requested = Number(ctx.growth?.evolution_stage_requested ?? 0);
  if (requested > stage) {
    await deps.db.callService(null, "svc_supersede_job", [job.id, job.lock_token]);
    return "superseded";
  }
  const avatar = ctx.avatar;
  if (!avatar?.visual_description) throw new StageError("CHARACTER_NOT_READY", "no character to evolve", false);
  if (Number(avatar.current_image_stage ?? 0) >= stage && avatar.image_status === "ready") {
    await deps.db.callService(null, "svc_complete_job", [job.id, job.lock_token]);
    return "completed";
  }
  await update(deps, job, "generating_image");
  await generateImage(deps, job, ctx, avatar.visual_elements as VisualElements, stage, String(avatar.visual_description));
  await deps.db.callService(null, "svc_complete_job", [job.id, job.lock_token]);
  return "completed";
}

// ---------------------------------------------------------------------------
// Maintenance (cron, hourly) and account deletion processing
// ---------------------------------------------------------------------------
async function removeObjects(deps: WorkerDeps, objects: Array<{ bucket: string; path: string }>) {
  const byBucket = new Map<string, string[]>();
  for (const o of objects ?? []) byBucket.set(o.bucket, [...(byBucket.get(o.bucket) ?? []), o.path]);
  for (const [bucket, paths] of byBucket) {
    for (let i = 0; i < paths.length; i += 100) await deps.storage.remove(bucket, paths.slice(i, i + 100));
  }
  return objects?.length ?? 0;
}

export async function processAccountDeletions(deps: WorkerDeps, limit = 20) {
  const users = await deps.db.callService<string[]>(null, "svc_due_account_deletions", [limit]);
  const done: string[] = [];
  for (const userId of users) {
    try {
      const res = await deps.db.callService<{ processed: boolean; objects: Array<{ bucket: string; path: string }> }>(null, "svc_process_account_deletion", [userId]);
      if (!res.processed) continue;
      await removeObjects(deps, res.objects);
      await deps.authAdmin.softDeleteUser(userId);
      await deps.db.callService(null, "svc_complete_account_deletion", [userId, null]);
      done.push(userId);
    } catch (err) {
      log(deps, { level: "error", msg: "account deletion failed", user_id: userId, error: String(err).slice(0, 300) });
      await deps.db.callService(null, "svc_complete_account_deletion", [userId, String(err)]).catch(() => {});
    }
  }
  return done.length;
}

export async function runMaintenance(deps: WorkerDeps) {
  const summary: Record<string, unknown> = {};
  summary.requeued_jobs = await deps.db.callService<number>(null, "svc_requeue_stalled_jobs");
  summary.account_deletions = await processAccountDeletions(deps);
  summary.orphan_attachments = await removeObjects(deps, await deps.db.callService(null, "svc_cleanup_orphan_attachments"));
  const purge = await deps.db.callService<{ objects: Array<{ bucket: string; path: string }> }>(null, "svc_purge_history");
  summary.history = { ...purge, objects: await removeObjects(deps, purge.objects) };
  const holds = await deps.db.callService<{ objects: Array<{ bucket: string; path: string }> }>(null, "svc_release_evidence_holds");
  summary.released_objects = await removeObjects(deps, holds.objects);
  summary.expired = await deps.db.callService(null, "svc_purge_expired");
  return summary;
}
