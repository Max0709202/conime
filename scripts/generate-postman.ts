// Generates postman/CONIME_Backend.postman_collection.json from a declarative list.
// Every request has tests for the expected status codes and, for success responses,
// the response JSON Schema (dereferenced from openapi/openapi.yaml), plus the error
// envelope for error responses. Run: deno run -A scripts/generate-postman.ts
import { parse } from "@std/yaml";

const root = new URL("..", import.meta.url).pathname;
const doc = parse(await Deno.readTextFile(`${root}openapi/openapi.yaml`)) as { components: { schemas: Record<string, unknown> } };
const S = doc.components.schemas;

function deref(node: unknown, seen = new Set<string>()): unknown {
  if (Array.isArray(node)) return node.map((n) => deref(n, seen));
  if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (typeof o.$ref === "string") {
      const name = o.$ref.split("/").pop()!;
      if (seen.has(name)) return {};
      const { $ref: _r, ...rest } = o;
      return { ...(deref(S[name], new Set([...seen, name])) as object), ...(deref(rest, seen) as object) };
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      if (k === "examples" || k === "format") continue; // Postman's validator: keep it portable
      out[k] = deref(v, seen);
    }
    return out;
  }
  return node;
}

interface Req {
  name: string;
  method: string;
  path: string;
  as?: string; // token variable name without braces; omit for public
  body?: unknown;
  expect: number[];
  schema?: string;
  errorCode?: string;
  idem?: boolean;
  tests?: string[]; // extra Postman test lines
  pre?: string[]; // extra pre-request lines
  headers?: Record<string, string>;
}

const folders: Array<{ name: string; description: string; items: Req[] }> = [
  {
    name: "00 Public", description: "No authentication. Question definitions are available before registration (Q-2).", items: [
      { name: "Health", method: "GET", path: "/v1/health", expect: [200], schema: "Health" },
      { name: "App config", method: "GET", path: "/v1/app-config", expect: [200], schema: "AppConfig",
        tests: ["pm.collectionVariables.set('consent_version', pm.response.json().consent.ai_data_transfer.current_version);"] },
      { name: "Current question set", method: "GET", path: "/v1/question-sets/current", expect: [200], schema: "QuestionSet", tests: [
        "const qs = pm.response.json();",
        "pm.collectionVariables.set('question_set_version', qs.version);",
        "const answers = qs.questions.map(q => (q.answer_type === 'single_choice' || q.answer_type === 'multi_choice')",
        "  ? { question_id: q.id, option_ids: [q.options[0].id] }",
        "  : { question_id: q.id, texts: [q.code === 'Q1' ? '星屑のアルカディア' : q.code === 'Q11' ? '異世界、宇宙' : 'Postmanテスト'] });",
        "pm.collectionVariables.set('valid_answers', JSON.stringify(answers));",
      ] },
    ],
  },
  {
    name: "01 Account & consent", description: "Call /v1/me after every sign-in.", items: [
      { name: "Me (alice)", method: "GET", path: "/v1/me", as: "token_alice", expect: [200], schema: "Me" },
      { name: "Consent status (new user)", method: "GET", path: "/v1/consents", as: "token_new", expect: [200], schema: "ConsentStatus" },
      { name: "Accept consent (new user)", method: "POST", path: "/v1/consents", as: "token_new", idem: true, expect: [200], schema: "ConsentStatus",
        body: { consent_type: "ai_data_transfer", consent_version: "{{consent_version}}", accepted: true } },
      { name: "Accept outdated consent → 409", method: "POST", path: "/v1/consents", as: "token_new", expect: [409], errorCode: "CONSENT_VERSION_MISMATCH",
        body: { consent_type: "ai_data_transfer", consent_version: "1999-01-01", accepted: true } },
    ],
  },
  {
    name: "02 Diagnosis", description: "Submit after registration + consent; poll the job.", items: [
      { name: "Submit without consent → 403", method: "POST", path: "/v1/diagnosis/submissions", as: "token_no_consent", expect: [403], errorCode: "CONSENT_REQUIRED",
        body: { client_request_id: "{{$guid}}", question_set_version: "{{question_set_version}}", consent_version: "{{consent_version}}", answers: "{{valid_answers}}" } },
      { name: "Submit outdated question set → 409", method: "POST", path: "/v1/diagnosis/submissions", as: "token_spare", expect: [409], errorCode: "QUESTION_SET_OUTDATED",
        body: { client_request_id: "{{$guid}}", question_set_version: "qs-1999", consent_version: "{{consent_version}}", answers: "{{valid_answers}}" } },
      { name: "Submit diagnosis (202, or 200 on re-run)", method: "POST", path: "/v1/diagnosis/submissions", as: "token_new", idem: true, expect: [202, 200], schema: "DiagnosisSubmission",
        body: { client_request_id: "{{diagnosis_request_id}}", question_set_version: "{{question_set_version}}", consent_version: "{{consent_version}}", answers: "{{valid_answers}}" },
        tests: ["pm.collectionVariables.set('job_id', pm.response.json().job.id);"] },
      { name: "Second different diagnosis → 409", method: "POST", path: "/v1/diagnosis/submissions", as: "token_new", expect: [409], errorCode: "DIAGNOSIS_ALREADY_SUBMITTED",
        body: { client_request_id: "{{$guid}}", question_set_version: "{{question_set_version}}", consent_version: "{{consent_version}}", answers: "{{valid_answers}}" } },
      { name: "Job status", method: "GET", path: "/v1/generation-jobs/{{job_id}}", as: "token_new", expect: [200], schema: "GenerationJob" },
      { name: "Current submission", method: "GET", path: "/v1/diagnosis/submissions/current", as: "token_new", expect: [200], schema: "DiagnosisSubmission" },
    ],
  },
  {
    name: "03 Profile & growth", description: "", items: [
      { name: "My profile", method: "GET", path: "/v1/me/profile", as: "token_alice", expect: [200], schema: "MyProfile" },
      { name: "My character", method: "GET", path: "/v1/me/character", as: "token_alice", expect: [200], schema: "Character" },
      { name: "Rename character", method: "PATCH", path: "/v1/me/character", as: "token_alice", idem: true, expect: [200], schema: "Character", body: { name: "アリス" } },
      { name: "Rename with invalid name → 400", method: "PATCH", path: "/v1/me/character", as: "token_alice", expect: [400], errorCode: "CHARACTER_NAME_INVALID", body: { name: "あ".repeat(21) } },
      { name: "Growth", method: "GET", path: "/v1/me/growth", as: "token_alice", expect: [200], schema: "Growth" },
      { name: "Received グッと", method: "GET", path: "/v1/me/reactions/received?limit=10", as: "token_alice", expect: [200], schema: "ReceivedReactionPage" },
      { name: "Public profile (bob)", method: "GET", path: "/v1/users/{{user_bob}}", as: "token_alice", expect: [200], schema: "PublicProfile" },
    ],
  },
  {
    name: "04 Recommendations", description: "Deterministic formulas (案A).", items: [
      { name: "User recommendations", method: "GET", path: "/v1/recommendations/users?limit=10", as: "token_alice", expect: [200], schema: "UserRecommendationList",
        tests: ["pm.test('percent = base + points', () => pm.response.json().items.forEach(i => pm.expect(i.compatibility_percent).to.eql(i.base_percent + i.matched_items.reduce((s, m) => s + m.points, 0))));"] },
      { name: "Guild recommendations", method: "GET", path: "/v1/recommendations/guilds", as: "token_alice", expect: [200], schema: "GuildRecommendationList" },
      { name: "Anime recommendations", method: "GET", path: "/v1/recommendations/anime", as: "token_alice", expect: [200], schema: "AnimeRecommendationList" },
    ],
  },
  {
    name: "05 Guilds", description: "", items: [
      { name: "List guilds", method: "GET", path: "/v1/guilds?limit=20", as: "token_alice", expect: [200], schema: "GuildPage" },
      { name: "Search guilds", method: "GET", path: "/v1/guilds?q=%E3%83%9F%E3%82%B9%E3%83%86%E3%83%AA%E3%83%BC", as: "token_alice", expect: [200], schema: "GuildPage" },
      { name: "Guild detail", method: "GET", path: "/v1/guilds/{{guild_1}}", as: "token_alice", expect: [200], schema: "GuildDetail",
        tests: ["pm.collectionVariables.set('guild_1_conversation', pm.response.json().conversation_id);"] },
      { name: "Join guild (201 first time, 200 afterwards)", method: "POST", path: "/v1/guilds/{{guild_3}}/join", as: "token_alice", idem: true, expect: [201, 200], schema: "JoinGuildResult" },
      { name: "Join full guild → 409", method: "POST", path: "/v1/guilds/{{guild_full}}/join", as: "token_alice", expect: [409], errorCode: "GUILD_FULL" },
      { name: "My memberships", method: "GET", path: "/v1/me/guild-memberships", as: "token_alice", expect: [200], schema: "GuildMembershipList" },
      { name: "Guild members", method: "GET", path: "/v1/guilds/{{guild_1}}/members?limit=10", as: "token_alice", expect: [200], schema: "GuildMemberPage" },
      { name: "Guild announcements", method: "GET", path: "/v1/guilds/{{guild_1}}/announcements", as: "token_alice", expect: [200], schema: "AnnouncementPage" },
    ],
  },
  {
    name: "06 Conversations", description: "REST is the source of truth; realtime is a delivery hint.", items: [
      { name: "List conversations", method: "GET", path: "/v1/conversations", as: "token_alice", expect: [200], schema: "ConversationPage" },
      { name: "Send text message", method: "POST", path: "/v1/conversations/{{guild_1_conversation}}/messages", as: "token_alice", idem: true, expect: [201], schema: "Message",
        pre: ["pm.collectionVariables.set('client_message_id', pm.variables.replaceIn('{{$guid}}'));"],
        body: { client_message_id: "{{client_message_id}}", kind: "text", text: "Postmanからこんにちは" },
        tests: ["pm.collectionVariables.set('alice_message_id', pm.response.json().id);", "pm.collectionVariables.set('alice_message_seq', pm.response.json().seq);"] },
      { name: "Retry same client_message_id → 200 same message", method: "POST", path: "/v1/conversations/{{guild_1_conversation}}/messages", as: "token_alice", expect: [200], schema: "Message",
        body: { client_message_id: "{{client_message_id}}", kind: "text", text: "Postmanからこんにちは" },
        tests: ["pm.test('same message', () => pm.expect(pm.response.json().id).to.eql(pm.collectionVariables.get('alice_message_id')));"] },
      { name: "History (newest)", method: "GET", path: "/v1/conversations/{{guild_1_conversation}}/messages?limit=20", as: "token_bob", expect: [200], schema: "MessagePage" },
      { name: "Catch-up after reconnect", method: "GET", path: "/v1/conversations/{{guild_1_conversation}}/messages?after_seq=0&limit=5", as: "token_bob", expect: [200], schema: "MessagePage" },
      { name: "Mark read", method: "POST", path: "/v1/conversations/{{guild_1_conversation}}/read", as: "token_bob", expect: [200], schema: "ReadMarker", body: { last_read_seq: "{{alice_message_seq}}" } },
      { name: "Open DM (alice → bob)", method: "POST", path: "/v1/dm-threads", as: "token_alice", idem: true, expect: [200, 201], schema: "Conversation", body: { peer_user_id: "{{user_bob}}" } },
      { name: "Open DM with a user who blocked you → 403", method: "POST", path: "/v1/dm-threads", as: "token_alice", expect: [403], errorCode: "BLOCKED", body: { peer_user_id: "{{user_frank}}" } },
      { name: "Upload URL for an image", method: "POST", path: "/v1/attachments/upload-url", as: "token_alice", idem: true, expect: [201], schema: "UploadUrl",
        body: { conversation_id: "{{guild_1_conversation}}", mime_type: "image/png", byte_size: 68 },
        tests: ["pm.collectionVariables.set('attachment_id', pm.response.json().attachment_id);"] },
      { name: "Send image before uploading → 409", method: "POST", path: "/v1/conversations/{{guild_1_conversation}}/messages", as: "token_alice", expect: [409], errorCode: "ATTACHMENT_NOT_UPLOADED",
        body: { client_message_id: "{{$guid}}", kind: "image", attachment_id: "{{attachment_id}}" } },
      { name: "Unsupported MIME → 415", method: "POST", path: "/v1/attachments/upload-url", as: "token_alice", expect: [415], errorCode: "ATTACHMENT_TYPE_NOT_ALLOWED",
        body: { conversation_id: "{{guild_1_conversation}}", mime_type: "application/pdf", byte_size: 10 } },
    ],
  },
  {
    name: "07 グッと & notifications", description: "", items: [
      { name: "Give グッと (bob → alice's message)", method: "POST", path: "/v1/reactions", as: "token_bob", idem: true, expect: [201], schema: "ReactionResult",
        body: { target_type: "message", target_id: "{{alice_message_id}}" } },
      { name: "Duplicate グッと → 409", method: "POST", path: "/v1/reactions", as: "token_bob", expect: [409], errorCode: "ALREADY_REACTED",
        body: { target_type: "message", target_id: "{{alice_message_id}}" } },
      { name: "Self グッと → 400", method: "POST", path: "/v1/reactions", as: "token_alice", expect: [400], errorCode: "CANNOT_REACT_TO_SELF",
        body: { target_type: "message", target_id: "{{alice_message_id}}" } },
      { name: "Notifications", method: "GET", path: "/v1/notifications?limit=20", as: "token_alice", expect: [200], schema: "NotificationPage" },
      { name: "Mark all notifications read", method: "POST", path: "/v1/notifications/read", as: "token_alice", expect: [200], schema: "MarkNotificationsReadResult", body: { all: true } },
    ],
  },
  {
    name: "08 Navigator", description: "AI navigator (N-1, N-2). Requires consent.", items: [
      { name: "Navigator history", method: "GET", path: "/v1/navigator/messages", as: "token_alice", expect: [200], schema: "NavigatorHistory" },
      { name: "Ask the navigator", method: "POST", path: "/v1/navigator/messages", as: "token_alice", idem: true, expect: [200], schema: "NavigatorExchange",
        body: { client_message_id: "{{$guid}}", text: "グッとって何？" } },
      { name: "Navigator without consent → 403", method: "POST", path: "/v1/navigator/messages", as: "token_no_consent", expect: [403], errorCode: "CONSENT_REQUIRED",
        body: { client_message_id: "{{$guid}}", text: "こんにちは" } },
    ],
  },
  {
    name: "09 Safety", description: "", items: [
      { name: "Block user", method: "POST", path: "/v1/blocks", as: "token_carol", idem: true, expect: [201, 200], schema: "Block", body: { user_id: "{{user_dave}}" } },
      { name: "List blocks", method: "GET", path: "/v1/blocks", as: "token_carol", expect: [200], schema: "BlockPage" },
      { name: "Unblock user", method: "DELETE", path: "/v1/blocks/{{user_dave}}", as: "token_carol", expect: [204] },
      { name: "Report a message", method: "POST", path: "/v1/reports", as: "token_bob", idem: true, expect: [202], schema: "ReportReceipt",
        body: { target_type: "message", target_id: "{{alice_message_id}}", reason_code: "spam", comment: "Postman test" } },
      { name: "Report with unknown reason → 400", method: "POST", path: "/v1/reports", as: "token_bob", expect: [400], errorCode: "VALIDATION_ERROR",
        body: { target_type: "message", target_id: "{{alice_message_id}}", reason_code: "nope" } },
    ],
  },
  {
    name: "10 Authentication failures", description: "", items: [
      { name: "No token → 401", method: "GET", path: "/v1/me", expect: [401], errorCode: "UNAUTHENTICATED" },
      { name: "Garbage token → 401", method: "GET", path: "/v1/me", headers: { Authorization: "Bearer garbage" }, expect: [401], errorCode: "TOKEN_INVALID" },
      { name: "Invalid UUID → 400", method: "GET", path: "/v1/guilds/not-a-uuid", as: "token_alice", expect: [400], errorCode: "VALIDATION_ERROR" },
      { name: "Unknown route → 404", method: "GET", path: "/v1/nope", as: "token_alice", expect: [404], errorCode: "NOT_FOUND" },
    ],
  },
  {
    name: "99 Destructive (account deletion)", description: "Deletes the 'delete-me' test user. Run last; re-seed to repeat.", items: [
      { name: "Request deletion", method: "POST", path: "/v1/account/deletion", as: "token_delete_me", idem: true, expect: [202], schema: "AccountDeletionStatus", body: { confirm: true } },
      { name: "API is now locked → 403", method: "GET", path: "/v1/me/profile", as: "token_delete_me", expect: [403], errorCode: "ACCOUNT_DELETED" },
      { name: "Deletion status", method: "GET", path: "/v1/account/deletion", as: "token_delete_me", expect: [200], schema: "AccountDeletionStatus" },
    ],
  },
];

function item(r: Req) {
  const exec: string[] = [
    `pm.test('status is ${r.expect.join(" or ")}', () => pm.expect(pm.response.code).to.be.oneOf(${JSON.stringify(r.expect)}));`,
    "pm.test('X-Request-Id header', () => pm.expect(pm.response.headers.get('X-Request-Id')).to.match(/^[0-9a-f-]{36}$/));",
  ];
  if (r.schema) {
    exec.push(`if (pm.response.code < 300) pm.test('matches ${r.schema} schema', () => pm.response.to.have.jsonSchema(${JSON.stringify(deref(S[r.schema]))}));`);
  }
  if (r.errorCode) {
    exec.push(`pm.test('error envelope ${r.errorCode}', () => { const e = pm.response.json().error; pm.expect(e.code).to.eql('${r.errorCode}'); pm.expect(e.request_id).to.eql(pm.response.headers.get('X-Request-Id')); pm.expect(e.details).to.be.an('object'); });`);
  }
  exec.push(...(r.tests ?? []));
  const headers = Object.entries(r.headers ?? {}).map(([key, value]) => ({ key, value }));
  if (r.as) headers.push({ key: "Authorization", value: `Bearer {{${r.as}}}` });
  if (r.idem) headers.push({ key: "Idempotency-Key", value: "{{$guid}}" });
  let raw: string | undefined;
  if (r.body !== undefined) {
    headers.push({ key: "Content-Type", value: "application/json" });
    raw = JSON.stringify(r.body, null, 2).replace(/"\{\{valid_answers\}\}"/g, "{{valid_answers}}").replace(/"\{\{alice_message_seq\}\}"/g, "{{alice_message_seq}}");
  }
  const [p, q] = r.path.split("?");
  return {
    name: r.name,
    event: [
      ...(r.pre ? [{ listen: "prerequest", script: { type: "text/javascript", exec: r.pre } }] : []),
      { listen: "test", script: { type: "text/javascript", exec } },
    ],
    request: {
      method: r.method,
      header: headers,
      ...(raw !== undefined ? { body: { mode: "raw", raw, options: { raw: { language: "json" } } } } : {}),
      url: {
        raw: `{{base_url}}${r.path}`,
        host: ["{{base_url}}"],
        path: p.split("/").filter(Boolean),
        ...(q ? { query: q.split("&").map((kv) => ({ key: kv.split("=")[0], value: kv.split("=")[1] })) } : {}),
      },
    },
  };
}

// Collection-level pre-request: obtain tokens.
//   auth_mode = local_jwt  → mint HS256 tokens with the LOCAL-ONLY secret (never a real secret)
//   auth_mode = supabase   → password sign-in against Supabase Auth with test accounts
const prerequest = [
  "const users = { alice: 'user_alice', bob: 'user_bob', carol: 'user_carol', new: 'user_new', spare: 'user_spare', no_consent: 'user_no_consent', delete_me: 'user_delete_me' };",
  "const mode = pm.environment.get('auth_mode');",
  "const now = Math.floor(Date.now() / 1000);",
  "if (mode === 'local_jwt') {",
  "  const CryptoJS = require('crypto-js');",
  "  const b64 = (o) => CryptoJS.enc.Base64.stringify(CryptoJS.enc.Utf8.parse(JSON.stringify(o))).replace(/=+$/, '').replace(/\\+/g, '-').replace(/\\//g, '_');",
  "  for (const [k, v] of Object.entries(users)) {",
  "    const sub = pm.environment.get(v); if (!sub) continue;",
  "    const head = b64({ alg: 'HS256', typ: 'JWT' });",
  "    const body = b64({ sub, role: 'authenticated', aud: 'authenticated', iat: now, exp: now + 3600, is_anonymous: false });",
  "    const sig = CryptoJS.HmacSHA256(head + '.' + body, pm.environment.get('local_jwt_secret')).toString(CryptoJS.enc.Base64).replace(/=+$/, '').replace(/\\+/g, '-').replace(/\\//g, '_');",
  "    pm.collectionVariables.set('token_' + k, head + '.' + body + '.' + sig);",
  "  }",
  "} else if (mode === 'supabase') {",
  "  for (const k of Object.keys(users)) {",
  "    const email = pm.environment.get('email_' + k); const exp = pm.collectionVariables.get('token_' + k + '_exp');",
  "    if (!email || (exp && Number(exp) > now + 60)) continue;",
  "    pm.sendRequest({ url: pm.environment.get('supabase_url') + '/auth/v1/token?grant_type=password', method: 'POST',",
  "      header: { 'Content-Type': 'application/json', apikey: pm.environment.get('supabase_anon_key') },",
  "      body: { mode: 'raw', raw: JSON.stringify({ email, password: pm.environment.get('test_password') }) } }, (err, res) => {",
  "        if (err || res.code !== 200) { console.error('sign-in failed for ' + k); return; }",
  "        pm.collectionVariables.set('token_' + k, res.json().access_token);",
  "        pm.collectionVariables.set('token_' + k + '_exp', String(res.json().expires_at));",
  "      });",
  "  }",
  "}",
];

const collection = {
  info: {
    name: "CONIME Backend",
    description: "Generated by scripts/generate-postman.ts from openapi/openapi.yaml. See postman/README.md.",
    schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
  },
  event: [{ listen: "prerequest", script: { type: "text/javascript", exec: prerequest } }],
  variable: [{ key: "valid_answers", value: "[]" }],
  item: folders.map((f) => ({ name: f.name, description: f.description, item: f.items.map(item) })),
};

await Deno.writeTextFile(`${root}postman/CONIME_Backend.postman_collection.json`, JSON.stringify(collection, null, 2) + "\n");
console.log(`postman: ${folders.reduce((n, f) => n + f.items.length, 0)} requests in ${folders.length} folders`);
