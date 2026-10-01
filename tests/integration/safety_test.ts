// Blocks, reports, navigator and account deletion.
import { assert, assertEquals } from "@std/assert";
import { expectError, expectOk, FIXTURE, itest } from "./harness.ts";

itest("block / unblock / list and recommendation exclusion (S-2, I-01)", async (h) => {
  const t = await h.token(FIXTURE.carol);
  const target = "10000000-0000-4000-8000-000000000150";
  const b = await h.api("POST", "/v1/blocks", { token: t, body: { user_id: target } });
  expectOk(b, 201, "Block");
  expectOk(await h.api("POST", "/v1/blocks", { token: t, body: { user_id: target } }), 200, "Block");
  const list = await h.api("GET", "/v1/blocks", { token: t });
  expectOk(list, 200, "BlockPage");
  assert(list.json.items.some((x: { user: { user_id: string } }) => x.user.user_id === target));
  const recs = await h.api("GET", "/v1/recommendations/users?limit=20", { token: t });
  assert(!recs.json.items.some((r: { user: { user_id: string } }) => r.user.user_id === target), "blocked user excluded");
  // the blocked user cannot see carol's profile; carol still can see theirs (with is_blocked_by_me)
  expectError(await h.api("GET", `/v1/users/${FIXTURE.carol}`, { token: await h.token(target) }), 404, "USER_NOT_FOUND");
  const p = await h.api("GET", `/v1/users/${target}`, { token: t });
  expectOk(p, 200, "PublicProfile");
  assertEquals([p.json.is_blocked_by_me, p.json.can_message], [true, false]);
  const del = await h.api("DELETE", `/v1/blocks/${target}`, { token: t });
  assertEquals(del.status, 204);
  assertEquals((await h.api("DELETE", `/v1/blocks/${target}`, { token: t })).status, 204, "unblock is idempotent");
  expectError(await h.api("POST", "/v1/blocks", { token: t, body: { user_id: FIXTURE.carol } }), 400, "CANNOT_BLOCK_SELF");
  expectError(await h.api("POST", "/v1/blocks", { token: t, body: { user_id: crypto.randomUUID() } }), 404, "USER_NOT_FOUND");
  const audit = await h.sql`select action from app.audit_logs where actor_id = ${FIXTURE.carol} and action like 'block.%'`;
  assert(audit.length >= 2, "block actions are audited");
});

itest("public profiles expose only public answers", async (h) => {
  const p = await h.api("GET", `/v1/users/${FIXTURE.bob}`, { token: await h.token(FIXTURE.carol) });
  expectOk(p, 200, "PublicProfile");
  const codes = p.json.answers_display.map((d: { question_code: string }) => d.question_code);
  for (const privateCode of ["Q2", "Q4", "Q5", "Q8", "Q10"]) assert(!codes.includes(privateCode), `${privateCode} is private`);
  assert(codes.includes("Q1"));
  assertEquals(JSON.stringify(p.json).includes("email"), false);
});

itest("reports: snapshot + hash + evidence hold, duplicate-safe, reason codes (S-1)", async (h) => {
  const tb = await h.token(FIXTURE.bob);
  const [msg] = await h.sql`select m.id from app.messages m join app.conversations c on c.id = m.conversation_id
                            where c.guild_id = ${FIXTURE.guild1} and m.sender_id <> ${FIXTURE.bob} and m.kind = 'text' order by seq limit 1`;
  const r = await h.api("POST", "/v1/reports", { token: tb, body: { target_type: "message", target_id: msg.id, reason_code: "harassment", comment: "ひどい" } });
  expectOk(r, 202, "ReportReceipt");
  assertEquals(r.json.duplicate, false);
  const again = await h.api("POST", "/v1/reports", { token: tb, body: { target_type: "message", target_id: msg.id, reason_code: "spam" } });
  expectOk(again, 202, "ReportReceipt");
  assertEquals([again.json.duplicate, again.json.report_id], [true, r.json.report_id]);
  const [rep] = await h.sql`select snapshot, snapshot_sha256 from app.reports where id = ${r.json.report_id}`;
  assertEquals(rep.snapshot.message_id, msg.id);
  assertEquals(rep.snapshot_sha256.length, 64);
  const [m] = await h.sql`select legal_hold from app.messages where id = ${msg.id}`;
  assertEquals(m.legal_hold, true);
  expectError(await h.api("POST", "/v1/reports", { token: tb, body: { target_type: "message", target_id: msg.id, reason_code: "bogus" } }), 400, "VALIDATION_ERROR");
  expectError(await h.api("POST", "/v1/reports", { token: tb, body: { target_type: "message", target_id: crypto.randomUUID(), reason_code: "spam" } }), 404, "REPORT_TARGET_NOT_FOUND");
  // cannot report content one cannot see
  const [dm] = await h.sql`select m.id from app.messages m join app.conversations c on c.id = m.conversation_id where c.kind = 'dm' and ${FIXTURE.carol}::uuid not in (c.dm_user_low, c.dm_user_high) limit 1`;
  expectError(await h.api("POST", "/v1/reports", { token: await h.token(FIXTURE.carol), body: { target_type: "message", target_id: dm.id, reason_code: "spam" } }), 404, "REPORT_TARGET_NOT_FOUND");
  // character image report
  const img = await h.api("POST", "/v1/reports", { token: tb, body: { target_type: "avatar_image", target_id: FIXTURE.carol, reason_code: "sexual" } });
  expectOk(img, 202, "ReportReceipt");
});

itest("navigator: consent gate, answer + suggestions, idempotent retry, fallback, moderation, quota (N-1, N-2)", async (h) => {
  expectError(await h.api("POST", "/v1/navigator/messages", { token: await h.token(FIXTURE.noConsent), body: { client_message_id: crypto.randomUUID(), text: "こんにちは" } }), 403, "CONSENT_REQUIRED");
  const user = await h.newUser({ consent: true });
  const t = await h.token(user);
  const hist0 = await h.api("GET", "/v1/navigator/messages", { token: t });
  expectOk(hist0, 200, "NavigatorHistory");
  assertEquals(hist0.json.items, []);
  assertEquals(hist0.json.default_suggestions.length, 3);

  const cmid = crypto.randomUUID();
  const ex = await h.api("POST", "/v1/navigator/messages", { token: t, body: { client_message_id: cmid, text: "ギルドって何？" } });
  expectOk(ex, 200, "NavigatorExchange");
  assertEquals(ex.json.assistant_message.is_fallback, false);
  assert(ex.json.assistant_message.suggestions.length <= 3);
  const replay = await h.api("POST", "/v1/navigator/messages", { token: t, body: { client_message_id: cmid, text: "ギルドって何？" } });
  assertEquals(replay.json.assistant_message.id, ex.json.assistant_message.id, "retry returns the stored exchange (no second AI call)");

  h.ai.inject("navigator", "timeout");
  const fb = await h.api("POST", "/v1/navigator/messages", { token: t, body: { client_message_id: crypto.randomUUID(), text: "もう一つ質問" } });
  expectOk(fb, 200, "NavigatorExchange");
  assertEquals(fb.json.assistant_message.is_fallback, true);
  assert(fb.json.assistant_message.text.length > 0);

  expectError(await h.api("POST", "/v1/navigator/messages", { token: t, body: { client_message_id: crypto.randomUUID(), text: "[[flag]] 悪い言葉" } }), 422, "NAVIGATOR_INPUT_REJECTED");

  const hist = await h.api("GET", "/v1/navigator/messages?limit=10", { token: t });
  assertEquals(hist.json.items.length, 4);
  assertEquals(hist.json.items.map((m: { role: string }) => m.role), ["user", "assistant", "user", "assistant"]);
  assertEquals(hist.json.quota.used_today, 2);

  // navigator response report
  expectOk(await h.api("POST", "/v1/reports", { token: t, body: { target_type: "navigator_message", target_id: ex.json.assistant_message.id, reason_code: "other" } }), 202);

  await h.sql`update app.app_settings set value = '2' where key = 'navigator.daily_limit'`;
  try {
    const q = await h.api("POST", "/v1/navigator/messages", { token: t, body: { client_message_id: crypto.randomUUID(), text: "三つ目" } });
    expectError(q, 429, "NAVIGATOR_QUOTA_EXCEEDED");
    assert(q.json.error.details.resets_at);
  } finally {
    await h.sql`update app.app_settings set value = '30' where key = 'navigator.daily_limit'`;
  }
});

itest("account deletion: immediate lockout, server-side processing, evidence kept (AC-3, I-04, I-05)", async (h) => {
  const user = await h.newUser({ consent: true });
  const t = await h.token(user);
  await h.api("GET", "/v1/me", { token: t });
  // give the user content: guild membership, a message (later reported) and a DM
  expectOk(await h.api("POST", `/v1/guilds/${FIXTURE.guild3}/join`, { token: t }), 201);
  const conv = (await h.api("GET", `/v1/guilds/${FIXTURE.guild3}`, { token: t })).json.conversation_id;
  const msg1 = await h.api("POST", `/v1/conversations/${conv}/messages`, { token: t, body: { client_message_id: crypto.randomUUID(), kind: "text", text: "reported" } });
  const msg2 = await h.api("POST", `/v1/conversations/${conv}/messages`, { token: t, body: { client_message_id: crypto.randomUUID(), kind: "text", text: "ordinary" } });
  const reporter = (await h.sql`select user_id from app.guild_members where guild_id = ${FIXTURE.guild3} and user_id <> ${user} limit 1`)[0].user_id;
  expectOk(await h.api("POST", "/v1/reports", { token: await h.token(reporter), body: { target_type: "message", target_id: msg1.json.id, reason_code: "spam" } }), 202);
  const before = (await h.api("GET", `/v1/guilds/${FIXTURE.guild3}`, { token: t })).json.member_count;

  expectError(await h.api("POST", "/v1/account/deletion", { token: t, body: { confirm: false } }), 400, "VALIDATION_ERROR");
  const req = await h.api("POST", "/v1/account/deletion", { token: t, body: { confirm: true, reason: "test" } });
  expectOk(req, 202, "AccountDeletionStatus");
  assertEquals(req.json.status, "requested");
  expectOk(await h.api("POST", "/v1/account/deletion", { token: t, body: { confirm: true } }), 202, "AccountDeletionStatus");
  expectError(await h.api("GET", "/v1/me", { token: t }), 403, "ACCOUNT_DELETED");
  expectError(await h.api("GET", "/v1/conversations", { token: t }), 403, "ACCOUNT_DELETED");
  const [{ banned_until }] = await h.sql`select banned_until from auth.users where id = ${user}`;
  assert(banned_until, "sign-in revoked in Auth");

  await h.maintenance();
  const status = await h.api("GET", "/v1/account/deletion", { token: t });
  expectOk(status, 200, "AccountDeletionStatus");
  assertEquals(status.json.status, "completed");
  const [p] = await h.sql`select status from app.profiles where id = ${user}`;
  assertEquals(p.status, "deleted");
  const [held] = await h.sql`select body, deleted_at from app.messages where id = ${msg1.json.id}`;
  assertEquals(held.body, "reported", "reported evidence retained while the report is open");
  const [gone] = await h.sql`select body, deleted_at from app.messages where id = ${msg2.json.id}`;
  assertEquals(gone.body, null, "other messages tombstoned");
  assertEquals((await h.api("GET", `/v1/guilds/${FIXTURE.guild3}`, { token: await h.token(reporter) })).json.member_count, before - 1);
  const [{ n }] = await h.sql`select count(*)::int as n from app.consents where user_id = ${user}`;
  assert(n >= 1, "consent records retained as audit evidence");
  const [au] = await h.sql`select deleted_at from auth.users where id = ${user}`;
  assert(au.deleted_at, "Auth user soft-deleted");
  // the deleted user is shown anonymously to others
  const hist = await h.api("GET", `/v1/conversations/${conv}/messages?limit=100`, { token: await h.token(reporter) });
  const shown = hist.json.items.find((m: { id: string }) => m.id === msg2.json.id);
  assertEquals([shown.sender.is_deleted, shown.sender.display_name, shown.text], [true, null, null]);
});
