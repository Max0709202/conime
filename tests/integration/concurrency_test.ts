// Concurrency and idempotency under parallel requests.
import { assert, assertEquals } from "@std/assert";
import { CONSENT_VERSION, expectOk, FIXTURE, itest, QS_VERSION, validAnswers } from "./harness.ts";

itest("simultaneous joins for the final guild slot never exceed capacity", async (h) => {
  const users = await Promise.all(Array.from({ length: 12 }, () => h.newUser()));
  const tokens = await Promise.all(users.map((u) => h.token(u)));
  const results = await Promise.all(tokens.map((t) => h.api("POST", `/v1/guilds/${FIXTURE.lastSeatGuild}/join`, { token: t })));
  const statuses = results.map((r) => r.status).sort();
  assertEquals(statuses.filter((s) => s === 201).length, 1, `exactly one winner: ${statuses}`);
  assert(results.filter((r) => r.status === 409).every((r) => r.json.error.code === "GUILD_FULL"));
  const [g] = await h.sql`select member_count, (select count(*)::int from app.guild_members where guild_id = ${FIXTURE.lastSeatGuild}) as actual from app.guilds where id = ${FIXTURE.lastSeatGuild}`;
  assertEquals([g.member_count, g.actual], [5, 5]);
});

itest("parallel duplicate message submissions create one message", async (h) => {
  const t = await h.token(FIXTURE.bob);
  const conv = (await h.api("GET", `/v1/guilds/${FIXTURE.guild1}`, { token: t })).json.conversation_id;
  const cmid = crypto.randomUUID();
  const rs = await Promise.all(Array.from({ length: 8 }, () =>
    h.api("POST", `/v1/conversations/${conv}/messages`, { token: t, body: { client_message_id: cmid, kind: "text", text: "同時送信" } })));
  assert(rs.every((r) => r.status === 201 || r.status === 200), rs.map((r) => r.status).join());
  assertEquals(new Set(rs.map((r) => r.json.id)).size, 1);
  const [{ n }] = await h.sql`select count(*)::int as n from app.messages where client_message_id = ${cmid}`;
  assertEquals(n, 1);
});

itest("parallel messages in one conversation get unique, gap-free sequence numbers", async (h) => {
  const senders = [FIXTURE.bob, FIXTURE.erin, FIXTURE.frank];
  const t0 = await h.token(FIXTURE.bob);
  const conv = (await h.api("GET", `/v1/guilds/${FIXTURE.guild1}`, { token: t0 })).json.conversation_id;
  const before = (await h.api("GET", `/v1/conversations/${conv}`, { token: t0 })).json.latest_seq;
  const rs = await Promise.all(Array.from({ length: 30 }, async (_, i) =>
    h.api("POST", `/v1/conversations/${conv}/messages`, { token: await h.token(senders[i % 3]), body: { client_message_id: crypto.randomUUID(), kind: "text", text: `並行${i}` } })));
  assert(rs.every((r) => r.status === 201));
  const seqs = rs.map((r) => r.json.seq).sort((a, b) => a - b);
  assertEquals(seqs, Array.from({ length: 30 }, (_, i) => before + 1 + i));
});

itest("parallel duplicate グッと from one user counts once; many givers count exactly", async (h) => {
  const tb = await h.token(FIXTURE.bob);
  const conv = (await h.api("GET", `/v1/guilds/${FIXTURE.guild1}`, { token: tb })).json.conversation_id;
  const msg = await h.api("POST", `/v1/conversations/${conv}/messages`, { token: tb, body: { client_message_id: crypto.randomUUID(), kind: "text", text: "並行グッと" } });
  const [{ exp0 }] = await h.sql`select total_exp as exp0 from app.user_growth where user_id = ${FIXTURE.bob}`;
  const te = await h.token(FIXTURE.erin);
  const dup = await Promise.all(Array.from({ length: 6 }, () => h.api("POST", "/v1/reactions", { token: te, body: { target_type: "message", target_id: msg.json.id } })));
  assertEquals(dup.filter((r) => r.status === 201).length, 1);
  assert(dup.filter((r) => r.status !== 201).every((r) => r.json.error.code === "ALREADY_REACTED"));
  const givers = (await h.sql`select user_id from app.guild_members where guild_id = ${FIXTURE.guild1} and user_id not in (${FIXTURE.bob}, ${FIXTURE.erin}, ${FIXTURE.alice}) limit 15`).map((r) => r.user_id);
  const many = await Promise.all(givers.map(async (g) => h.api("POST", "/v1/reactions", { token: await h.token(g), body: { target_type: "message", target_id: msg.json.id } })));
  assert(many.every((r) => r.status === 201), many.map((r) => `${r.status}:${r.json?.error?.code}`).join());
  const [m] = await h.sql`select reaction_count, (select count(*)::int from app.reactions where target_id = ${msg.json.id}) as actual from app.messages where id = ${msg.json.id}`;
  assertEquals([m.reaction_count, m.actual], [1 + givers.length, 1 + givers.length]);
  const [{ exp1 }] = await h.sql`select total_exp as exp1 from app.user_growth where user_id = ${FIXTURE.bob}`;
  assertEquals(exp1 - exp0, 10 * (1 + givers.length), "EXP exact under concurrent updates");
  const [{ ledger }] = await h.sql`select coalesce(sum(delta), 0)::int as ledger from app.exp_ledger where user_id = ${FIXTURE.bob}`;
  assertEquals(ledger, exp1, "ledger and cached total agree");
  const [{ evo }] = await h.sql`select count(*)::int as evo from app.ai_jobs where user_id = ${FIXTURE.bob} and kind = 'evolution_image' and status <> 'superseded'`;
  assertEquals(evo, 1, "bob crossed Lv10 once → exactly one evolution job");
});

itest("parallel duplicate diagnosis submissions create one submission and one job", async (h) => {
  const user = await h.newUser({ consent: true });
  const t = await h.token(user);
  const answers = await validAnswers(h);
  const body = { client_request_id: crypto.randomUUID(), question_set_version: QS_VERSION, consent_version: CONSENT_VERSION, answers };
  const rs = await Promise.all(Array.from({ length: 5 }, () => h.api("POST", "/v1/diagnosis/submissions", { token: t, body })));
  assert(rs.every((r) => r.status === 202 || r.status === 200), rs.map((r) => r.status).join());
  assertEquals(new Set(rs.map((r) => r.json.submission_id)).size, 1);
  const [{ subs, jobs }] = await h.sql`select (select count(*)::int from app.diagnosis_submissions where user_id = ${user}) as subs,
                                              (select count(*)::int from app.ai_jobs where user_id = ${user}) as jobs`;
  assertEquals([subs, jobs], [1, 1]);
  // two workers consuming concurrently, plus extra deliveries: still one character and one image
  for (let i = 0; i < 3; i++) await h.sql`select pgmq.send('ai_jobs', jsonb_build_object('job_id', ${rs[0].json.job.id}::text))`;
  await Promise.all([h.worker(), h.worker(), h.worker()]);
  const job = await h.api("GET", `/v1/generation-jobs/${rs[0].json.job.id}`, { token: t });
  expectOk(job, 200, "GenerationJob");
  assertEquals(job.json.status, "completed");
  const [{ avatars, images, recs }] = await h.sql`select (select count(*)::int from app.user_avatars where user_id = ${user}) as avatars,
     (select count(*)::int from storage.objects where bucket_id = 'avatars' and name like ${`${user}/%`}) as images,
     (select count(*)::int from app.recommendations where user_id = ${user}) as recs`;
  assertEquals(avatars, 1);
  assertEquals(images, 1);
  assert(recs <= 3);
});

itest("one EXP event crossing several 5-level boundaries generates only the final stage image", async (h) => {
  const user = FIXTURE.alice.replace(/1$/, "7"); // fixture user 7: one グッと short of Lv5
  await h.sql`select app.apply_exp(${user}::uuid, 3000, 0, 'operator_adjustment', 'test', gen_random_uuid())`;
  const jobs = await h.sql`select (payload ->> 'stage_level')::int as stage, status from app.ai_jobs where user_id = ${user} and kind = 'evolution_image' order by created_at`;
  assertEquals(jobs.filter((j) => j.status !== "superseded").map((j) => j.stage), [20]);
  await h.worker();
  const [a] = await h.sql`select current_image_stage from app.user_avatars where user_id = ${user}`;
  assertEquals(a.current_image_stage, 20);
});
