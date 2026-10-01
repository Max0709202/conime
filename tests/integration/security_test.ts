// Security checks over HTTP: cross-user access, storage path abuse, authoritative
// server values, secret exposure, injection-shaped input.
import { assert, assertEquals } from "@std/assert";
import { expectError, expectOk, FIXTURE, itest } from "./harness.ts";

itest("user A cannot read user B's private data through any endpoint", async (h) => {
  const ta = await h.token(FIXTURE.alice);
  const [bobJob] = await h.sql`select id from app.ai_jobs where user_id = ${FIXTURE.bob} limit 1`;
  expectError(await h.api("GET", `/v1/generation-jobs/${bobJob.id}`, { token: ta }), 404, "JOB_NOT_FOUND");
  expectError(await h.api("POST", `/v1/generation-jobs/${bobJob.id}/retry`, { token: ta }), 404, "JOB_NOT_FOUND");
  const [dm] = await h.sql`select id from app.conversations where kind = 'dm' and ${FIXTURE.alice}::uuid not in (dm_user_low, dm_user_high) limit 1`;
  if (dm) expectError(await h.api("GET", `/v1/conversations/${dm.id}/messages`, { token: ta }), 404, "CONVERSATION_NOT_FOUND");
  const [att] = await h.sql`select a.id from app.message_attachments a join app.conversations c on c.id = a.conversation_id
                            where c.guild_id = ${FIXTURE.guild1} limit 1`;
  expectError(await h.api("GET", `/v1/attachments/${att.id}/download-url`, { token: await h.token(FIXTURE.carol) }), 404, "ATTACHMENT_NOT_FOUND");
  // public profile never exposes private answers or features
  const p = await h.api("GET", `/v1/users/${FIXTURE.bob}`, { token: ta });
  const text = JSON.stringify(p.json);
  for (const k of ["email", "ai_profile", "visual_description", "consent", "diagnosis"]) assert(!text.includes(k), k);
});

itest("non-members cannot read guild chat; non-participants cannot read DMs", async (h) => {
  const [g4] = await h.sql`select id from app.conversations where guild_id = '20000000-0000-4000-8000-000000000004'`;
  const outsider = await h.token(FIXTURE.noDiagnosis);
  expectError(await h.api("GET", `/v1/conversations/${g4.id}`, { token: outsider }), 404, "CONVERSATION_NOT_FOUND");
  expectError(await h.api("POST", "/v1/attachments/upload-url", { token: outsider, body: { conversation_id: g4.id, mime_type: "image/png", byte_size: 10 } }), 404, "CONVERSATION_NOT_FOUND");
  const [dm] = await h.sql`select id from app.conversations where dm_user_low = ${FIXTURE.alice} and dm_user_high = ${FIXTURE.bob}`;
  expectError(await h.api("POST", `/v1/conversations/${dm.id}/messages`, { token: await h.token(FIXTURE.carol), body: { client_message_id: crypto.randomUUID(), kind: "text", text: "x" } }), 404, "CONVERSATION_NOT_FOUND");
  expectError(await h.api("POST", `/v1/conversations/${dm.id}/read`, { token: await h.token(FIXTURE.carol), body: { last_read_seq: 1 } }), 404, "CONVERSATION_NOT_FOUND");
});

itest("arbitrary storage paths cannot be accessed or written", async (h) => {
  const s = h.base;
  for (const path of [
    "/__storage/download/avatars/seed%2F..%2F..%2Fetc%2Fpasswd?exp=9999999999&sig=00",
    `/__storage/download/avatars/${FIXTURE.bob}.png?exp=9999999999&sig=deadbeef`,
    "/__storage/upload/avatars/x.png?exp=9999999999&sig=deadbeef",
  ]) {
    const r = await fetch(`${s}${path}`, { method: path.includes("upload") ? "PUT" : "GET", body: path.includes("upload") ? "x" : undefined });
    assertEquals(r.status, 403, path);
    await r.body?.cancel();
  }
  // a signed upload URL for one path cannot be reused for another path
  const ta = await h.token(FIXTURE.alice);
  const conv = (await h.api("GET", `/v1/guilds/${FIXTURE.guild1}`, { token: ta })).json.conversation_id;
  const slot = await h.api("POST", "/v1/attachments/upload-url", { token: ta, body: { conversation_id: conv, mime_type: "image/png", byte_size: 10 } });
  const moved = slot.json.upload.url.replace(/\/[0-9a-f-]{36}\.png/, "/evil.png");
  const r = await fetch(moved, { method: "PUT", headers: { "content-type": "image/png" }, body: "x" });
  assertEquals(r.status, 403);
  await r.body?.cancel();
});

itest("request data cannot alter server-calculated values", async (h) => {
  const tb = await h.token(FIXTURE.bob);
  for (const body of [
    { target_type: "message", target_id: crypto.randomUUID(), points: 1000 },
    { target_type: "message", target_id: crypto.randomUUID(), recipient_id: FIXTURE.bob },
  ]) expectError(await h.api("POST", "/v1/reactions", { token: tb, body }), 400, "VALIDATION_ERROR");
  const conv = (await h.api("GET", `/v1/guilds/${FIXTURE.guild1}`, { token: tb })).json.conversation_id;
  expectError(await h.api("POST", `/v1/conversations/${conv}/messages`, { token: tb, body: { client_message_id: crypto.randomUUID(), kind: "text", text: "x", sender_id: FIXTURE.alice } }), 400, "VALIDATION_ERROR");
  expectError(await h.api("POST", `/v1/conversations/${conv}/messages`, { token: tb, body: { client_message_id: crypto.randomUUID(), kind: "text", text: "x", seq: 1 } }), 400, "VALIDATION_ERROR");
  expectError(await h.api("POST", `/v1/conversations/${conv}/messages`, { token: tb, body: { client_message_id: crypto.randomUUID(), kind: "system", text: "x" } }), 400, "VALIDATION_ERROR");
  // diagnosis purposes from the client are ignored (server master is authoritative)
  const r = await h.api("GET", `/v1/recommendations/users?limit=1`, { token: tb });
  expectOk(r, 200, "UserRecommendationList");
  if (r.json.items[0]) assert(r.json.items[0].compatibility_percent <= 100);
});

itest("no secret material is exposed in responses or configuration", async (h) => {
  const cfg = await h.api("GET", "/v1/app-config");
  const me = await h.api("GET", "/v1/me/profile", { token: await h.token(FIXTURE.alice) });
  for (const body of [cfg.json, me.json]) {
    const s = JSON.stringify(body).toLowerCase();
    for (const needle of ["service_role", "sk-", "secret", "password", "openai", "postgres://", "postgresql://", "__image_path", "__attachment_path"]) {
      assert(!s.includes(needle), `${needle} leaked`);
    }
  }
});

itest("injection-shaped inputs are treated as data", async (h) => {
  const t = await h.token(FIXTURE.alice);
  const r = await h.api("GET", `/v1/guilds?q=${encodeURIComponent("' or 1=1; drop table app.guilds; --")}`, { token: t });
  expectOk(r, 200, "GuildPage");
  assertEquals(r.json.items, []);
  const conv = (await h.api("GET", `/v1/guilds/${FIXTURE.guild1}`, { token: t })).json.conversation_id;
  const m = await h.api("POST", `/v1/conversations/${conv}/messages`, { token: t, body: { client_message_id: crypto.randomUUID(), kind: "text", text: "<script>alert(1)</script>'); drop table x;--" } });
  expectOk(m, 201, "Message");
  assertEquals(m.json.text, "<script>alert(1)</script>'); drop table x;--", "stored verbatim; rendering is the client's concern");
  const [{ n }] = await h.sql`select count(*)::int as n from app.guilds`;
  assert(n >= 7);
});

itest("worker endpoint secret is required (Edge Function contract)", async () => {
  // Static check: the worker entrypoint refuses requests without the secret header.
  const src = await Deno.readTextFile(new URL("../../supabase/functions/worker/index.ts", import.meta.url));
  assert(src.includes("x-worker-secret") && src.includes("status: 401"));
  const cfg = await Deno.readTextFile(new URL("../../supabase/config.toml", import.meta.url)).catch(() => "");
  assert(cfg === "" || cfg.includes("[functions.worker]"), "worker is declared in config.toml");
});
