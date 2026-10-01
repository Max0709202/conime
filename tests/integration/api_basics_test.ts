// Public endpoints, authentication failures, envelope/headers, input hygiene, rate limits.
import { assert, assertEquals } from "@std/assert";
import { expectError, expectOk, FIXTURE, itest } from "./harness.ts";

itest("health, app-config and question set are public and match the contract", async (h) => {
  expectOk(await h.api("GET", "/v1/health"), 200, "Health");
  const cfg = await h.api("GET", "/v1/app-config");
  expectOk(cfg, 200, "AppConfig");
  assertEquals(cfg.json.growth, { max_level: 100, evolution_interval_levels: 5 });
  const qs = await h.api("GET", "/v1/question-sets/current");
  expectOk(qs, 200, "QuestionSet");
  assertEquals(qs.json.questions.length, 20);
  assertEquals(qs.json.questions.map((q: { code: string }) => q.code).slice(0, 3), ["Q1", "Q2", "Q3"]);
  const q9 = qs.json.questions.find((q: { code: string }) => q.code === "Q9");
  assertEquals(q9.constraints.max_selections, 3);
  assertEquals(q9.options.length, 9);
});

itest("Supabase function path prefix (/api/v1) is accepted", async (h) => {
  expectOk(await h.api("GET", "/api/v1/health"), 200, "Health");
});

itest("request id is echoed when supplied as a UUID", async (h) => {
  const rid = crypto.randomUUID();
  const res = await h.api("GET", "/v1/health", { headers: { "x-request-id": rid } });
  assertEquals(res.headers.get("x-request-id"), rid);
  const bad = await h.api("GET", "/v1/health", { headers: { "x-request-id": "not-a-uuid" } });
  assert(bad.headers.get("x-request-id") !== "not-a-uuid");
});

itest("protected endpoints reject missing, malformed, expired and foreign tokens", async (h) => {
  expectError(await h.api("GET", "/v1/me"), 401, "UNAUTHENTICATED");
  expectError(await h.api("GET", "/v1/me", { headers: { authorization: "Bearer garbage" } }), 401, "TOKEN_INVALID");
  expectError(await h.api("GET", "/v1/me", { token: await h.token(FIXTURE.alice, { expiresInSec: -300 }) }), 401, "TOKEN_EXPIRED");
  const { mintTestToken } = await import("../../supabase/functions/_shared/auth/jwt.ts");
  expectError(await h.api("GET", "/v1/me", { token: await mintTestToken("some-other-project-secret-123456789", FIXTURE.alice) }), 401, "TOKEN_INVALID");
  // valid signature but the user does not exist in Auth
  expectError(await h.api("GET", "/v1/me", { token: await h.token(crypto.randomUUID()) }), 401, "TOKEN_INVALID");
});

itest("unknown routes and invalid identifiers use the error envelope", async (h) => {
  const t = await h.token(FIXTURE.alice);
  expectError(await h.api("GET", "/v1/does-not-exist", { token: t }), 404, "NOT_FOUND");
  expectError(await h.api("GET", "/v1/guilds/not-a-uuid", { token: t }), 400, "VALIDATION_ERROR");
  expectError(await h.api("GET", "/v1/guilds/00000000-0000-4000-8000-000000000000", { token: t }), 404, "GUILD_NOT_FOUND");
  expectError(await h.api("GET", "/v1/guilds?limit=1000", { token: t }), 400, "VALIDATION_ERROR");
  expectError(await h.api("GET", "/v1/guilds?cursor=tampered", { token: t }), 400, "VALIDATION_ERROR");
});

itest("body hygiene: content type, JSON syntax, unknown fields, size", async (h) => {
  const t = await h.token(FIXTURE.alice);
  expectError(await h.api("POST", "/v1/blocks", { token: t, raw: "user_id=x", headers: { "content-type": "application/x-www-form-urlencoded" } }), 415, "UNSUPPORTED_MEDIA_TYPE");
  expectError(await h.api("POST", "/v1/blocks", { token: t, raw: "{bad json", headers: { "content-type": "application/json" } }), 400, "INVALID_JSON");
  expectError(await h.api("POST", "/v1/blocks", { token: t, body: { user_id: FIXTURE.bob, blocker_id: FIXTURE.carol } }), 400, "VALIDATION_ERROR");
  expectError(await h.api("POST", "/v1/reports", { token: t, raw: JSON.stringify({ comment: "x".repeat(300_000) }), headers: { "content-type": "application/json" } }), 413, "PAYLOAD_TOO_LARGE");
});

itest("/v1/me returns onboarding state", async (h) => {
  const me = await h.api("GET", "/v1/me", { token: await h.token(FIXTURE.alice) });
  expectOk(me, 200, "Me");
  assertEquals(me.json.user_id, FIXTURE.alice);
  assertEquals(me.json.onboarding.diagnosis_status, "completed");
  assertEquals(me.json.onboarding.consent_required, false);
  const nc = await h.api("GET", "/v1/me", { token: await h.token(FIXTURE.noConsent) });
  expectOk(nc, 200, "Me");
  assertEquals(nc.json.onboarding.consent_required, true);
  assertEquals(nc.json.onboarding.diagnosis_status, "not_submitted");
});

itest("rate limits return 429 with Retry-After (per IP for public endpoints)", async (h) => {
  const ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
  let last = null;
  for (let i = 0; i < 61; i++) last = await h.api("GET", "/v1/question-sets/current", { headers: { "x-forwarded-for": ip } });
  expectError(last!, 429, "RATE_LIMITED");
  assert(Number(last!.headers.get("retry-after")) > 0);
  assert(last!.json.error.details.retry_after_seconds > 0);
  // a different client is unaffected
  expectOk(await h.api("GET", "/v1/question-sets/current", { headers: { "x-forwarded-for": "198.51.100.7" } }), 200);
});

itest("idempotency: same key + same body replays; same key + different body is rejected", async (h) => {
  const user = await h.newUser({ consent: true });
  const t = await h.token(user);
  await h.api("GET", "/v1/me", { token: t });
  const key = crypto.randomUUID();
  const body = { consent_type: "ai_data_transfer", consent_version: "2026-10-01", accepted: true };
  const a = await h.api("POST", "/v1/consents", { token: t, body, headers: { "idempotency-key": key } });
  expectOk(a, 200, "ConsentStatus");
  const b = await h.api("POST", "/v1/consents", { token: t, body, headers: { "idempotency-key": key } });
  expectOk(b, 200, "ConsentStatus");
  assertEquals(b.headers.get("idempotent-replayed"), "true");
  assertEquals(b.json, a.json);
  const rows = await h.sql`select count(*)::int as n from app.consents where user_id = ${user}`;
  assertEquals(rows[0].n, 2, "the replay did not insert another consent row (1 seeded + 1 recorded)");
  expectError(await h.api("POST", "/v1/consents", { token: t, body: { ...body, accepted: false }, headers: { "idempotency-key": key } }), 422, "IDEMPOTENCY_KEY_REUSED");
  expectError(await h.api("POST", "/v1/consents", { token: t, body, headers: { "idempotency-key": "short" } }), 400, "VALIDATION_ERROR");
});
