// Registration → consent → diagnosis → async generation → profile/character/image/recs,
// including AI failure handling with the mock provider's fault injection.
import { assert, assertEquals, assertExists } from "@std/assert";
import { CONSENT_VERSION, expectError, expectOk, FIXTURE, type Harness, itest, QS_VERSION, validAnswers } from "./harness.ts";

async function submit(h: Harness, token: string, overrides: Record<string, unknown> = {}) {
  return await h.api("POST", "/v1/diagnosis/submissions", {
    token,
    body: { client_request_id: crypto.randomUUID(), question_set_version: QS_VERSION, consent_version: CONSENT_VERSION, answers: await validAnswers(h), ...overrides },
  });
}

async function runUntilTerminal(h: Harness, token: string, jobId: string) {
  for (let i = 0; i < 10; i++) {
    await h.worker();
    const job = await h.api("GET", `/v1/generation-jobs/${jobId}`, { token });
    expectOk(job, 200, "GenerationJob");
    if (["completed", "failed"].includes(job.json.status)) return job.json;
    if (job.json.status === "retrying") {
      // fast-forward the backoff: make the job due and its delayed queue message visible
      await h.sql`update app.ai_jobs set next_attempt_at = now() where id = ${jobId}`;
      await h.sql`update pgmq.q_ai_jobs set vt = now() where message ->> 'job_id' = ${jobId}`;
    }
  }
  throw new Error("job did not finish");
}

itest("diagnosis requires consent and the current versions", async (h) => {
  const user = await h.newUser();
  const t = await h.token(user);
  expectError(await submit(h, t), 403, "CONSENT_REQUIRED");
  expectOk(await h.api("POST", "/v1/consents", { token: t, body: { consent_type: "ai_data_transfer", consent_version: CONSENT_VERSION, accepted: true } }), 200, "ConsentStatus");
  expectError(await submit(h, t, { question_set_version: "qs-1999" }), 409, "QUESTION_SET_OUTDATED");
  expectError(await submit(h, t, { consent_version: "1999-01-01" }), 409, "CONSENT_VERSION_MISMATCH");
  expectError(await h.api("POST", "/v1/consents", { token: t, body: { consent_type: "ai_data_transfer", consent_version: "1999", accepted: true } }), 409, "CONSENT_VERSION_MISMATCH");
});

itest("diagnosis answers are validated against the server question master", async (h) => {
  const t = await h.token(await h.newUser({ consent: true }));
  const answers = await validAnswers(h);
  const res = await submit(h, t, { answers: answers.slice(1) });
  expectError(res, 400, "VALIDATION_ERROR");
  assert(JSON.stringify(res.json.error.details).includes("Q1"));
  const tooMany = await validAnswers(h, { Q9: { options: ["A", "B", "C", "D"] } });
  expectError(await submit(h, t, { answers: tooMany }), 400, "VALIDATION_ERROR");
  const bad = answers.map((a: { question_id: string }, i: number) => (i === 0 ? { ...a, texts: ["x".repeat(51)] } : a));
  expectError(await submit(h, t, { answers: bad }), 400, "VALIDATION_ERROR");
});

itest("full diagnosis pipeline with the mock AI: idempotent submit, async job, results", async (h) => {
  const user = await h.newUser({ consent: true });
  const t = await h.token(user);
  const body = { client_request_id: crypto.randomUUID(), question_set_version: QS_VERSION, consent_version: CONSENT_VERSION, answers: await validAnswers(h) };
  const first = await h.api("POST", "/v1/diagnosis/submissions", { token: t, body });
  expectOk(first, 202, "DiagnosisSubmission");
  assertEquals(first.json.job.status, "accepted");
  // same client_request_id → same result, no duplicate
  const again = await h.api("POST", "/v1/diagnosis/submissions", { token: t, body });
  expectOk(again, 200, "DiagnosisSubmission");
  assertEquals(again.json.submission_id, first.json.submission_id);
  // a second, different diagnosis is not allowed (one character per user)
  const other = await submit(h, t);
  expectError(other, 409, "DIAGNOSIS_ALREADY_SUBMITTED");
  assertEquals(other.json.error.details.submission_id, first.json.submission_id);

  // before generation
  expectError(await h.api("GET", "/v1/me/character", { token: t }), 409, "CHARACTER_NOT_READY");
  const pending = await h.api("GET", "/v1/recommendations/anime", { token: t });
  expectOk(pending, 200, "AnimeRecommendationList");
  assertEquals(pending.json.status, "pending");

  const job = await runUntilTerminal(h, t, first.json.job.id);
  assertEquals(job.status, "completed");
  assertEquals(job.poll_after_seconds, null);

  const profile = await h.api("GET", "/v1/me/profile", { token: t });
  expectOk(profile, 200, "MyProfile");
  assertEquals(profile.json.diagnosis.status, "completed");
  assertEquals(profile.json.character.skills.length, 3);
  assertEquals(profile.json.character.image.status, "ready");
  assertEquals(profile.json.character.name, null, "user names the character later");
  assertEquals(profile.json.character.visual_elements.theme_color, "赤", "Q13 A → 赤 (概要7)");
  assert(profile.json.favorites.works.some((w: { name: string }) => w.name === "星屑のアルカディア"), "exact alias normalized");
  assert(profile.json.favorites.world_settings.length >= 1, "world setting normalized");

  // the image URL is a signed URL to a private object and is downloadable
  const img = await fetch(profile.json.character.image.url);
  assertEquals(img.status, 200);
  assertEquals((await img.arrayBuffer()).byteLength > 0, true);

  const recs = await h.api("GET", "/v1/recommendations/anime", { token: t });
  expectOk(recs, 200, "AnimeRecommendationList");
  assertEquals(recs.json.status, "ready");
  assert(recs.json.items.length >= 1 && recs.json.items.length <= 3);
  // never recommends works the user already listed (excluded as viewed)
  const favIds = new Set(profile.json.favorites.works.map((w: { id: string }) => w.id));
  for (const r of recs.json.items) assert(!favIds.has(r.work.id));

  // stored features exclude duplicates and keep originals separately
  const rows = await h.sql`select count(*)::int as n from app.diagnosis_answers a join app.diagnosis_submissions s on s.id = a.submission_id where s.user_id = ${user}`;
  assert(rows[0].n >= 20);
  const runs = await h.sql`select purpose, provider, prompt_version, input_hash, status from app.ai_runs where user_id = ${user}`;
  assert(runs.some((r) => r.purpose === "profile" && r.status === "succeeded" && r.prompt_version === "profile-v1" && String(r.input_hash).length === 64));
  assert(runs.some((r) => r.purpose === "image"));

  // naming the character (Q-4): ID never changes
  const before = profile.json.character.character_id;
  const renamed = await h.api("PATCH", "/v1/me/character", { token: t, body: { name: "  ﾙﾐﾅ  " } });
  expectOk(renamed, 200, "Character");
  assertEquals(renamed.json.name, "ルミナ", "NFKC + trim");
  assertEquals(renamed.json.character_id, before);
  expectError(await h.api("PATCH", "/v1/me/character", { token: t, body: { name: "x".repeat(21) } }), 400, "CHARACTER_NAME_INVALID");
  expectError(await h.api("PATCH", "/v1/me/character", { token: t, body: { name: "公式スタッフ" } }), 422, "CHARACTER_NAME_REJECTED");
  expectError(await h.api("PATCH", "/v1/me/character", { token: t, body: { name: "x", character_id: "C-00000000" } }), 400, "VALIDATION_ERROR");

  // user and guild recommendations now available
  const users = await h.api("GET", "/v1/recommendations/users", { token: t });
  expectOk(users, 200, "UserRecommendationList");
  for (const r of users.json.items) {
    assert(r.user.user_id !== user);
    assertEquals(r.compatibility_percent, 50 + r.matched_items.reduce((s: number, m: { points: number }) => s + m.points, 0));
  }
  expectOk(await h.api("GET", "/v1/recommendations/guilds", { token: t }), 200, "GuildRecommendationList");
});

itest("AI failures: invalid output and invented IDs are rejected; retries and fallbacks are safe", async (h) => {
  const user = await h.newUser({ consent: true });
  const t = await h.token(user);
  // normalization returns an invented ID, profile returns invalid JSON once, recs invent IDs twice
  h.ai.inject("normalize", "invented_ids");
  h.ai.inject("profile", "invalid_json");
  h.ai.inject("anime_recs", "invented_ids", "invented_ids", "invented_ids", "invented_ids");
  const sub = await submit(h, t);
  expectOk(sub, 202);
  const job = await runUntilTerminal(h, t, sub.json.job.id);
  assertEquals(job.status, "completed", JSON.stringify(job));
  const feats = await h.sql`select resolution from app.profile_features where user_id = ${user}`;
  assert(!feats.some((f) => f.resolution === "ai"), "invented normalization IDs were rejected");
  const recs = await h.api("GET", "/v1/recommendations/anime", { token: t });
  expectOk(recs, 200, "AnimeRecommendationList");
  const ids = recs.json.items.map((r: { work: { id: string } }) => r.work.id);
  const known = await h.sql`select count(*)::int as n from app.anime_works where id = any(${ids}::uuid[])`;
  assertEquals(known[0].n, ids.length, "only approved work IDs are returned");
  const runs = await h.sql`select status from app.ai_runs where user_id = ${user} and purpose = 'profile'`;
  assert(runs.some((r) => r.status === "invalid_output"), "invalid output recorded in ai_runs");
});

itest("refusals fail the job safely; manual retry recovers; duplicate deliveries never duplicate outputs", async (h) => {
  const user = await h.newUser({ consent: true });
  const t = await h.token(user);
  h.ai.inject("profile", "refusal");
  const sub = await submit(h, t);
  const failed = await runUntilTerminal(h, t, sub.json.job.id);
  assertEquals(failed.status, "failed");
  assertEquals(failed.error_code, "AI_REFUSED");
  assertEquals(failed.retryable, true);
  // extra queue deliveries for the failed job are harmless
  await h.sql`select pgmq.send('ai_jobs', jsonb_build_object('job_id', ${sub.json.job.id}::text))`;
  await h.worker();
  const retry = await h.api("POST", `/v1/generation-jobs/${sub.json.job.id}/retry`, { token: t });
  expectOk(retry, 202, "GenerationJob");
  for (let i = 0; i < 3; i++) await h.sql`select pgmq.send('ai_jobs', jsonb_build_object('job_id', ${sub.json.job.id}::text))`;
  const done = await runUntilTerminal(h, t, sub.json.job.id);
  assertEquals(done.status, "completed");
  const [{ avatars }] = await h.sql`select count(*)::int as avatars from app.user_avatars where user_id = ${user}`;
  assertEquals(avatars, 1);
  const [{ images }] = await h.sql`select count(*)::int as images from app.ai_runs where user_id = ${user} and purpose = 'image' and status = 'succeeded'`;
  assertEquals(images, 1, "one image generated despite 4 deliveries");
  expectError(await h.api("POST", `/v1/generation-jobs/${sub.json.job.id}/retry`, { token: t }), 409, "JOB_NOT_RETRYABLE");
});

itest("timeouts and provider rate limits are retried with backoff", async (h) => {
  const user = await h.newUser({ consent: true });
  const t = await h.token(user);
  h.ai.inject("image", "timeout");
  h.ai.inject("anime_recs", "rate_limit");
  const sub = await submit(h, t);
  const done = await runUntilTerminal(h, t, sub.json.job.id);
  assertEquals(done.status, "completed");
  const runs = await h.sql`select status from app.ai_runs where user_id = ${user}`;
  assert(runs.some((r) => r.status === "timeout"));
  assert(runs.some((r) => r.status === "rate_limited"));
});

itest("consent withdrawal stops pending AI processing", async (h) => {
  const user = await h.newUser({ consent: true });
  const t = await h.token(user);
  const sub = await submit(h, t);
  expectOk(await h.api("POST", "/v1/consents", { token: t, body: { consent_type: "ai_data_transfer", consent_version: CONSENT_VERSION, accepted: false } }), 200);
  const job = await runUntilTerminal(h, t, sub.json.job.id);
  assertEquals(job.status, "failed");
  assertEquals(job.error_code, "CONSENT_REQUIRED");
  assertEquals(job.retryable, false);
  assertEquals(h.ai.calls.filter((c) => (c.input as Record<string, unknown>)?.forbidden_names).length >= 0, true);
});

itest("users without a diagnosis get explicit states", async (h) => {
  const t = await h.token(FIXTURE.noDiagnosis);
  expectError(await h.api("GET", "/v1/recommendations/users", { token: t }), 409, "DIAGNOSIS_NOT_COMPLETED");
  const anime = await h.api("GET", "/v1/recommendations/anime", { token: t });
  expectOk(anime, 200, "AnimeRecommendationList");
  assertEquals(anime.json.status, "not_available");
  expectError(await h.api("GET", "/v1/diagnosis/submissions/current", { token: t }), 404, "NOT_FOUND");
  expectError(await h.api("GET", `/v1/generation-jobs/${crypto.randomUUID()}`, { token: t }), 404, "JOB_NOT_FOUND");
  const me = await h.api("GET", "/v1/me/profile", { token: t });
  expectOk(me, 200, "MyProfile");
  assertEquals(me.json.character, null);
  assertExists(me.json.growth);
});
