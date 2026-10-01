import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import * as jose from "jose";
import { ApiError, ERROR_CATALOG, errorBody, fromDbError } from "../../supabase/functions/_shared/http/errors.ts";
import { decodeCursor, encodeCursor, withOpaqueCursor } from "../../supabase/functions/_shared/http/cursor.ts";
import { aiOutputErrors, parseIntParam, parseUuidParam, validateBody } from "../../supabase/functions/_shared/http/validate.ts";
import { JwtVerifier, mintTestToken } from "../../supabase/functions/_shared/auth/jwt.ts";

const SECRET = "unit-test-secret-unit-test-secret-1234";
const SUB = "10000000-0000-4000-8000-000000000001";
const verifier = new JwtVerifier({ hsSecret: SECRET, jwksUrl: null, issuer: null });

Deno.test("error catalog is in sync with docs/ERROR_CODES.md", async () => {
  const doc = await Deno.readTextFile(new URL("../../docs/ERROR_CODES.md", import.meta.url));
  const documented = new Map([...doc.matchAll(/^\| `([A-Z_]+)` \| (\d{3}) \|/gm)].map((m) => [m[1], Number(m[2])]));
  for (const [code, { status }] of Object.entries(ERROR_CATALOG)) {
    assertEquals(documented.get(code), status, `${code} must be documented with HTTP ${status}`);
  }
  for (const code of documented.keys()) assert(code in ERROR_CATALOG, `${code} documented but not implemented`);
});

Deno.test("error envelope shape", () => {
  const body = errorBody(new ApiError("GUILD_FULL", { capacity: 100 }), "rid");
  assertEquals(body, { error: { code: "GUILD_FULL", message: "The guild has reached its capacity.", request_id: "rid", details: { capacity: 100 } } });
});

Deno.test("database errors map to API errors only for CNM01 with known codes", () => {
  assertEquals(fromDbError({ code: "CNM01", message: "BLOCKED", detail: "{\"a\":1}" })?.code, "BLOCKED");
  assertEquals(fromDbError({ code: "CNM01", message: "BLOCKED", detail: "not json" })?.details, {});
  assertEquals(fromDbError({ code: "CNM01", message: "SOMETHING_ELSE" }), null);
  assertEquals(fromDbError({ code: "23505", message: "duplicate" }), null);
});

Deno.test("cursor round trip and rejection of tampered cursors", () => {
  const c = { t: "2026-10-01T00:00:00.000Z", i: SUB };
  assertEquals(decodeCursor(encodeCursor(c)), c);
  assertEquals(encodeCursor(null), null);
  assertEquals(withOpaqueCursor({ next_cursor: null, items: [] }).next_cursor, null);
  assertThrows(() => decodeCursor("not-base64-json"), ApiError);
  assertThrows(() => decodeCursor(btoa(JSON.stringify({ t: "x", i: 1 }))), ApiError);
});

Deno.test("request validation uses the OpenAPI component schemas", () => {
  validateBody("SendMessageRequest", { client_message_id: SUB, kind: "text", text: "hi" });
  const err = assertThrows(() => validateBody("SendMessageRequest", { client_message_id: "nope", kind: "voice", extra: 1 }), ApiError) as ApiError;
  assertEquals(err.code, "VALIDATION_ERROR");
  const rules = (err.details.fields as Array<{ rule: string }>).map((f) => f.rule).sort();
  assert(rules.includes("pattern") && rules.includes("enum") && rules.includes("additionalProperties"), rules.join());
  assertThrows(() => validateBody("SendMessageRequest", { client_message_id: SUB, kind: "text", text: "あ".repeat(1001) }), ApiError);
  assertThrows(() => validateBody("AccountDeletionRequest", { confirm: false }), ApiError);
  assertThrows(() => validateBody("ReactionRequest", { target_type: "message", target_id: SUB, user_id: SUB }), ApiError, undefined, "client-supplied user_id is rejected");
});

Deno.test("path and query parameter parsing", () => {
  assertEquals(parseUuidParam("id", SUB.toUpperCase()), SUB);
  assertThrows(() => parseUuidParam("id", "1 or 1=1"), ApiError);
  assertEquals(parseIntParam("limit", "10", 1, 100), 10);
  assertEquals(parseIntParam("limit", undefined, 1, 100), null);
  assertThrows(() => parseIntParam("limit", "1000", 1, 100), ApiError);
  assertThrows(() => parseIntParam("limit", "1e2", 1, 100), ApiError);
});

Deno.test("AI output validation: valid, missing fields, wrong types, extra fields", () => {
  assertEquals(aiOutputErrors("navigator-output-v1", { reply: "x", suggestions: ["a"] }), []);
  assert(aiOutputErrors("navigator-output-v1", { reply: "x" }).length > 0);
  assert(aiOutputErrors("anime-recs-output-v1", { recommendations: [{ work_id: 1, reason: "x" }] }).length > 0);
  assert(aiOutputErrors("normalization-output-v1", { results: [], extra: true }).length > 0);
  assert(aiOutputErrors("profile-output-v1", "not an object").length > 0);
});

Deno.test("JWT: valid token yields only identity claims", async () => {
  const claims = await verifier.verify(`Bearer ${await mintTestToken(SECRET, SUB)}`);
  assertEquals(claims.sub, SUB);
  assertEquals(claims.role, "authenticated");
});

Deno.test("JWT: missing, malformed, expired, wrong signature, wrong audience, anonymous, service role", async () => {
  const code = async (h: string | null) => (await assertRejects(() => verifier.verify(h), ApiError) as ApiError).code;
  assertEquals(await code(null), "UNAUTHENTICATED");
  assertEquals(await code("Basic abc"), "UNAUTHENTICATED");
  assertEquals(await code("Bearer not.a.jwt"), "TOKEN_INVALID");
  assertEquals(await code(`Bearer ${await mintTestToken(SECRET, SUB, { expiresInSec: -120 })}`), "TOKEN_EXPIRED");
  assertEquals(await code(`Bearer ${await mintTestToken("another-secret-another-secret-12345", SUB)}`), "TOKEN_INVALID");
  const key = new TextEncoder().encode(SECRET);
  const mk = (payload: Record<string, unknown>, aud = "authenticated") =>
    new jose.SignJWT(payload).setProtectedHeader({ alg: "HS256" }).setSubject(SUB).setAudience(aud).setExpirationTime("1h").sign(key);
  assertEquals(await code(`Bearer ${await mk({ role: "authenticated" }, "other")}`), "TOKEN_INVALID");
  assertEquals(await code(`Bearer ${await mk({ role: "authenticated", is_anonymous: true })}`), "TOKEN_INVALID");
  assertEquals(await code(`Bearer ${await mk({ role: "service_role" })}`), "TOKEN_INVALID");
  const none = `${btoa(JSON.stringify({ alg: "none" }))}.${btoa(JSON.stringify({ sub: SUB, role: "authenticated", aud: "authenticated" }))}.`;
  assertEquals(await code(`Bearer ${none}`), "TOKEN_INVALID");
});
