// MVP traffic model (docs/LOAD_TEST.md): ~200 registered users, 5+ guilds,
// peak ≈ 40 concurrently active users. Each scenario is measured separately.
//
//   local:   TOKENS_FILE=tests/load/tokens.local.json k6 run tests/load/mvp-traffic.js
//   staging: API_BASE_URL=... SUPABASE_URL=... SUPABASE_ANON_KEY=... TEST_PASSWORD=... k6 run tests/load/mvp-traffic.js
import http from "k6/http";
import { sleep } from "k6";
import { auth, BASE, loadUsers, ok, signInUsers, uuid } from "./common.js";

const FILE_USERS = loadUsers();
const GUILD1 = "20000000-0000-4000-8000-000000000001";
const SCALE = Number(__ENV.SCALE || 1); // 1 = MVP peak; 3 = 3× headroom
const DURATION = __ENV.DURATION || "2m";

export const options = {
  scenarios: {
    // 40 active users × ~4 reads/min ≈ 2.7 req/s
    rest_reads: { executor: "constant-arrival-rate", rate: Math.ceil(3 * SCALE), timeUnit: "1s", duration: DURATION, preAllocatedVUs: 20, exec: "restReads" },
    // 40 users × 1 message / 2 min ≈ 0.33 msg/s, all in one hot guild room
    message_create: { executor: "constant-arrival-rate", rate: Math.ceil(20 * SCALE), timeUnit: "1m", duration: DURATION, preAllocatedVUs: 10, exec: "messageCreate" },
    // opening rooms + reconnect catch-up
    message_history: { executor: "constant-arrival-rate", rate: Math.ceil(1 * SCALE), timeUnit: "1s", duration: DURATION, preAllocatedVUs: 10, exec: "messageHistory" },
    // user + guild recommendation SQL (once per session)
    recommendations: { executor: "constant-arrival-rate", rate: Math.ceil(30 * SCALE), timeUnit: "1m", duration: DURATION, preAllocatedVUs: 10, exec: "recommendations" },
    // グッと: 40 users × 1 / 3 min
    reactions: { executor: "constant-arrival-rate", rate: Math.ceil(14 * SCALE), timeUnit: "1m", duration: DURATION, preAllocatedVUs: 10, exec: "reactions" },
  },
  thresholds: {
    "http_req_failed{scenario:rest_reads}": ["rate<0.01"],
    "http_req_duration{scenario:rest_reads}": ["p(95)<300"],
    "http_req_failed{scenario:message_create}": ["rate<0.01"],
    "http_req_duration{scenario:message_create}": ["p(95)<500"],
    "http_req_duration{scenario:message_history}": ["p(95)<300"],
    "http_req_duration{scenario:recommendations}": ["p(95)<800"],
    "http_req_duration{scenario:reactions}": ["p(95)<500"],
    checks: ["rate>0.99"],
  },
};

export function setup() {
  const users = FILE_USERS || signInUsers(Number(__ENV.USERS || 60));
  const t = users[0].token;
  const conv = http.get(`${BASE}/v1/guilds/${GUILD1}`, auth(t)).json("conversation_id");
  // members of guild 1 (they can send/react there)
  const members = [];
  let cursor = null;
  do {
    const r = http.get(`${BASE}/v1/guilds/${GUILD1}/members?limit=100${cursor ? `&cursor=${cursor}` : ""}`, auth(t));
    for (const m of r.json("items")) members.push(m.user.user_id);
    cursor = r.json("next_cursor");
  } while (cursor);
  return { users, conv, memberTokens: users.filter((u) => members.includes(u.user_id)).map((u) => u.token) };
}

const pick = (a) => a[Math.floor(Math.random() * a.length)];

export function restReads(d) {
  const t = pick(d.users).token;
  const paths = ["/v1/me/growth", "/v1/notifications?limit=20", "/v1/conversations?limit=20", "/v1/me/profile"];
  const p = pick(paths);
  ok(http.get(`${BASE}${p}`, Object.assign(auth(t), { tags: { name: p.split("?")[0] } })), p);
}

export function messageCreate(d) {
  const t = pick(d.memberTokens);
  ok(http.post(`${BASE}/v1/conversations/${d.conv}/messages`, JSON.stringify({ client_message_id: uuid(), kind: "text", text: "負荷テスト" }),
    Object.assign(auth(t), { tags: { name: "POST messages" } })), "send", [201]);
}

export function messageHistory(d) {
  const t = pick(d.memberTokens);
  const r = http.get(`${BASE}/v1/conversations/${d.conv}/messages?limit=50`, Object.assign(auth(t), { tags: { name: "GET messages" } }));
  ok(r, "history");
  const latest = r.json("latest_seq");
  if (latest) ok(http.get(`${BASE}/v1/conversations/${d.conv}/messages?after_seq=${Math.max(0, latest - 10)}`, Object.assign(auth(t), { tags: { name: "GET messages catch-up" } })), "catch-up");
}

export function recommendations(d) {
  const t = pick(d.users).token;
  ok(http.get(`${BASE}/v1/recommendations/users?limit=10`, Object.assign(auth(t), { tags: { name: "GET rec users" } })), "rec users", [200, 409]);
  ok(http.get(`${BASE}/v1/recommendations/guilds`, Object.assign(auth(t), { tags: { name: "GET rec guilds" } })), "rec guilds", [200, 409]);
}

export function reactions(d) {
  const t = pick(d.memberTokens);
  const r = http.get(`${BASE}/v1/conversations/${d.conv}/messages?limit=30`, auth(t));
  const msgs = (r.json("items") || []).filter((m) => m.kind === "text" && !m.reacted_by_me);
  if (!msgs.length) return;
  const res = http.post(`${BASE}/v1/reactions`, JSON.stringify({ target_type: "message", target_id: pick(msgs).id }),
    Object.assign(auth(t), { tags: { name: "POST reactions" } }));
  ok(res, "react", [201, 400, 409]); // own message / already reacted are valid outcomes
  sleep(0.1);
}
