// Headless multi-user realtime verification against a running Supabase stack
// (local `supabase start` or staging). Postman cannot verify realtime delivery.
//
//   SUPABASE_URL=... SUPABASE_ANON_KEY=... API_BASE_URL=.../functions/v1/api \
//   TEST_PASSWORD=... deno run -A tests/realtime/realtime-client.ts
//
// Uses seeded test accounts (user001..@conime.test). Exit code 0 only if every
// scenario passes; a JSON report is written to tests/realtime/results/.
import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = need("SUPABASE_URL");
const ANON_KEY = need("SUPABASE_ANON_KEY");
const API = need("API_BASE_URL");
const PASSWORD = need("TEST_PASSWORD");
const TIMEOUT = Number(Deno.env.get("RT_TIMEOUT_MS") ?? "8000");

const USERS = {
  alice: "user001@conime.test", bob: "user002@conime.test", dave: "user004@conime.test", erin: "user005@conime.test",
};
const GUILD1 = "20000000-0000-4000-8000-000000000001";

function need(k: string): string {
  const v = Deno.env.get(k);
  if (!v) {
    console.error(`missing env ${k}`);
    Deno.exit(2);
  }
  return v;
}

interface Envelope { event_id: string; type: string; occurred_at: string; data: Record<string, unknown> }
interface Actor { name: string; client: SupabaseClient; token: string; events: Envelope[] }

const report: Array<{ scenario: string; ok: boolean; detail?: string; ms: number }> = [];

async function scenario(name: string, fn: () => Promise<void>) {
  const t0 = performance.now();
  try {
    await fn();
    report.push({ scenario: name, ok: true, ms: Math.round(performance.now() - t0) });
    console.log(`✔ ${name}`);
  } catch (err) {
    report.push({ scenario: name, ok: false, detail: String((err as Error).message ?? err), ms: Math.round(performance.now() - t0) });
    console.log(`✘ ${name}: ${(err as Error).message ?? err}`);
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function signIn(name: string, email: string): Promise<Actor> {
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error || !data.session) throw new Error(`sign-in failed for ${name}: ${error?.message}`);
  await client.realtime.setAuth(data.session.access_token);
  return { name, client, token: data.session.access_token, events: [] };
}

async function api(actor: Actor, method: string, path: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${actor.token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

function subscribe(actor: Actor, topic: string): Promise<{ channel: RealtimeChannel; status: string }> {
  return new Promise((resolve) => {
    const channel = actor.client.channel(topic, { config: { private: true } });
    channel.on("broadcast", { event: "*" }, (msg) => actor.events.push(msg.payload as Envelope));
    const timer = setTimeout(() => resolve({ channel, status: "TIMED_OUT" }), TIMEOUT);
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        clearTimeout(timer);
        resolve({ channel, status });
      }
    });
  });
}

async function waitFor(actor: Actor, pred: (e: Envelope) => boolean, ms = TIMEOUT): Promise<Envelope> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const hit = actor.events.find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${actor.name}: event not received within ${ms} ms`);
}

const alice = await signIn("alice", USERS.alice);
const bob = await signIn("bob", USERS.bob);
const dave = await signIn("dave", USERS.dave);
const erin = await signIn("erin", USERS.erin);
const conv = (await api(alice, "GET", `/v1/guilds/${GUILD1}`)).json.conversation_id as string;

await scenario("members subscribe to the private guild channel", async () => {
  const a = await subscribe(alice, `conv:${conv}`);
  const b = await subscribe(bob, `conv:${conv}`);
  assert(a.status === "SUBSCRIBED" && b.status === "SUBSCRIBED", `statuses ${a.status}/${b.status}`);
});

await scenario("guild message is delivered to another member with the documented envelope", async () => {
  const sent = await api(alice, "POST", `/v1/conversations/${conv}/messages`, { client_message_id: crypto.randomUUID(), kind: "text", text: "realtime check" });
  assert(sent.status === 201, `send status ${sent.status}`);
  const ev = await waitFor(bob, (e) => e.type === "message.created" && e.data.id === sent.json.id);
  assert(/^[0-9a-f-]{36}$/.test(ev.event_id) && ev.occurred_at.endsWith("Z"), "envelope shape");
  assert(ev.data.seq === sent.json.seq, "seq matches REST");
});

await scenario("non-member cannot receive guild broadcasts", async () => {
  const d = await subscribe(dave, `conv:${conv}`);
  const before = dave.events.length;
  await api(alice, "POST", `/v1/conversations/${conv}/messages`, { client_message_id: crypto.randomUUID(), kind: "text", text: "secret" });
  await new Promise((r) => setTimeout(r, 2500));
  assert(dave.events.length === before, `non-member received ${dave.events.length - before} events (channel status ${d.status})`);
  await dave.client.removeChannel(d.channel);
});

await scenario("user channel cannot be joined by another user", async () => {
  const bobId = (await bob.client.auth.getUser()).data.user!.id;
  const s = await subscribe(dave, `user:${bobId}`);
  const before = dave.events.length;
  const dm = await api(alice, "POST", "/v1/dm-threads", { peer_user_id: bobId });
  await api(alice, "POST", `/v1/conversations/${dm.json.id}/messages`, { client_message_id: crypto.randomUUID(), kind: "text", text: "for bob only" });
  await new Promise((r) => setTimeout(r, 2000));
  assert(dave.events.length === before, "foreign user channel leaked events");
  await dave.client.removeChannel(s.channel);
});

await scenario("DM delivery and user-channel notifications", async () => {
  const bobId = (await bob.client.auth.getUser()).data.user!.id;
  const dm = await api(alice, "POST", "/v1/dm-threads", { peer_user_id: bobId });
  assert(dm.status === 200 || dm.status === 201, `dm status ${dm.status}`);
  const s1 = await subscribe(bob, `conv:${dm.json.id}`);
  const s2 = await subscribe(bob, `user:${bobId}`);
  assert(s1.status === "SUBSCRIBED" && s2.status === "SUBSCRIBED", "bob subscriptions");
  const sent = await api(alice, "POST", `/v1/conversations/${dm.json.id}/messages`, { client_message_id: crypto.randomUUID(), kind: "text", text: "DM realtime" });
  await waitFor(bob, (e) => e.type === "message.created" && e.data.id === sent.json.id);
  await waitFor(bob, (e) => e.type === "conversation.updated" && e.data.conversation_id === dm.json.id);
  await waitFor(bob, (e) => e.type === "notification.created" && (e.data as { type?: string }).type === "dm_received");
});

await scenario("disconnect → messages sent meanwhile → reconnect → REST catch-up returns all of them", async () => {
  const latest = (await api(bob, "GET", `/v1/conversations/${conv}`)).json.latest_seq as number;
  bob.client.realtime.disconnect();
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) ids.push((await api(alice, "POST", `/v1/conversations/${conv}/messages`, { client_message_id: crypto.randomUUID(), kind: "text", text: `offline ${i}` })).json.id);
  bob.client.realtime.connect();
  const re = await subscribe(bob, `conv:${conv}`);
  assert(re.status === "SUBSCRIBED", `resubscribe ${re.status}`);
  const missed = await api(bob, "GET", `/v1/conversations/${conv}/messages?after_seq=${latest}&limit=100`);
  const got = (missed.json.items as Array<{ id: string }>).map((m) => m.id);
  for (const id of ids) assert(got.includes(id), `missed message ${id} not returned by catch-up`);
});

await scenario("token refresh keeps the realtime connection authorized", async () => {
  const { data, error } = await bob.client.auth.refreshSession();
  assert(!error && data.session, `refresh failed: ${error?.message}`);
  bob.token = data.session!.access_token;
  await bob.client.realtime.setAuth(bob.token);
  const sent = await api(alice, "POST", `/v1/conversations/${conv}/messages`, { client_message_id: crypto.randomUUID(), kind: "text", text: "after refresh" });
  await waitFor(bob, (e) => e.type === "message.created" && e.data.id === sent.json.id);
});

await scenario("unread count and read marker", async () => {
  const c1 = (await api(bob, "GET", `/v1/conversations/${conv}`)).json;
  assert(c1.unread_count >= 1, `unread ${c1.unread_count}`);
  const r = await api(bob, "POST", `/v1/conversations/${conv}/read`, { last_read_seq: c1.latest_seq });
  assert(r.json.unread_count === 0, `after read ${r.json.unread_count}`);
});

await scenario("retried send with the same client_message_id is delivered once", async () => {
  const cmid = crypto.randomUUID();
  const a = await api(alice, "POST", `/v1/conversations/${conv}/messages`, { client_message_id: cmid, kind: "text", text: "once" });
  const b = await api(alice, "POST", `/v1/conversations/${conv}/messages`, { client_message_id: cmid, kind: "text", text: "once" });
  assert(a.json.id === b.json.id && b.status === 200, "replay returns the same message");
  await waitFor(bob, (e) => e.type === "message.created" && e.data.id === a.json.id);
  await new Promise((r) => setTimeout(r, 1500));
  const n = bob.events.filter((e) => e.type === "message.created" && e.data.id === a.json.id).length;
  assert(n === 1, `delivered ${n} times`);
});

await scenario("blocked users cannot continue a DM", async () => {
  const aliceId = (await alice.client.auth.getUser()).data.user!.id;
  const dm = await api(erin, "POST", "/v1/dm-threads", { peer_user_id: aliceId });
  assert(dm.json.can_send === false, "can_send false");
  const s = await api(erin, "POST", `/v1/conversations/${dm.json.id}/messages`, { client_message_id: crypto.randomUUID(), kind: "text", text: "x" });
  assert(s.status === 403 && s.json.error.code === "BLOCKED", `status ${s.status}`);
});

for (const a of [alice, bob, dave, erin]) await a.client.removeAllChannels();
await Deno.mkdir(new URL("./results", import.meta.url), { recursive: true });
const file = new URL(`./results/realtime-${new Date().toISOString().replace(/[:.]/g, "-")}.json`, import.meta.url);
await Deno.writeTextFile(file, JSON.stringify({ target: API, at: new Date().toISOString(), report }, null, 2));
const failed = report.filter((r) => !r.ok).length;
console.log(`${report.length - failed}/${report.length} realtime scenarios passed → ${file.pathname}`);
Deno.exit(failed ? 1 : 0);
