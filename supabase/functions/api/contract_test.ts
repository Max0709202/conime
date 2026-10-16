// 契約テスト（API09「モックと本実装で契約を変えない」）。DB なしで実行できる：
//   deno test --allow-env --allow-read --allow-net supabase/functions
// 1. ルーターの実装が openapi.yaml の 39 本（実動作13・モック26）と一致する
// 2. モックの応答（_shared/mock/fixtures.ts）が openapi.yaml の応答例と一致する
// 3. 応答例と、モック API が実際に返す応答が OpenAPI のスキーマに一致する
import { assertEquals } from "jsr:@std/assert@1.0.8";
import { parse } from "npm:yaml@2.6.1";
import Ajv2020 from "npm:ajv@8.17.1/dist/2020.js";
import addFormats from "npm:ajv-formats@3.0.1";
import { jose } from "../_shared/deps.ts";

const JWT_SECRET = "contract-test-secret-with-at-least-32-characters";
Deno.env.set("JWT_SECRET", JWT_SECRET);
Deno.env.set("MOCK_MODE", "true");
const { app } = await import("./app.ts");
const { FIXTURES } = await import("../_shared/mock/fixtures.ts");

// deno-lint-ignore no-explicit-any
const spec: any = parse(await Deno.readTextFile(new URL("../../../openapi/openapi.yaml", import.meta.url)));
const METHODS = ["get", "post", "patch", "delete"] as const;

// deno-lint-ignore no-explicit-any
const ajv = new (Ajv2020 as any)({ strict: false, allErrors: true });
// deno-lint-ignore no-explicit-any
(addFormats as any)(ajv);
ajv.addSchema({ $id: "openapi", components: spec.components });
// deno-lint-ignore no-explicit-any
const withRefs = (schema: any) => JSON.parse(JSON.stringify(schema).replaceAll('"#/components/', '"openapi#/components/'));

// deno-lint-ignore no-explicit-any
function responseSchema(op: any, status: string) {
  let resp = op.responses[status];
  if (resp?.$ref) resp = spec.components.responses[resp.$ref.split("/").pop()];
  return resp?.content?.["application/json"]?.schema;
}

const appOps: { key: string; stage: string; op: Record<string, unknown> }[] = [];
for (const [path, item] of Object.entries<Record<string, Record<string, unknown>>>(spec.paths)) {
  for (const m of METHODS) {
    const op = item[m];
    if (op && op["x-conime-stage"]) appOps.push({ key: `${m.toUpperCase()} ${path}`, stage: String(op["x-conime-stage"]), op });
  }
}

Deno.test("openapi.yaml：アプリ API は39本（実動作13・モック26）", () => {
  assertEquals(appOps.length, 39);
  assertEquals(appOps.filter((o) => o.stage === "live").length, 13);
  assertEquals(appOps.filter((o) => o.stage === "mock").length, 26);
});

Deno.test("ルーターの実装が openapi.yaml の操作と一致する", () => {
  const implemented = new Set(
    app.routes
      .filter((r) => (METHODS as readonly string[]).includes(r.method.toLowerCase()))
      .map((r) => `${r.method} ${r.path.replace(/^\/api\/v1/, "").replace(/:(\w+)/g, "{$1}")}`)
      .filter((k) => !k.endsWith(" /docs") && !k.endsWith(" /openapi.yaml")),
  );
  assertEquals([...implemented].sort(), appOps.map((o) => o.key).sort());
});

Deno.test("モックの応答が openapi.yaml の応答例と一致する", () => {
  for (const { key, op } of appOps.filter((o) => o.stage === "mock")) {
    // deno-lint-ignore no-explicit-any
    const [status, resp] = Object.entries<any>(op.responses as object).find(([s]) => s.startsWith("2"))!;
    // deno-lint-ignore no-explicit-any
    const fixture = (FIXTURES as any)[key];
    assertEquals(fixture?.status, Number(status), key);
    const content = resp.content?.["application/json"];
    if (content?.examples) {
      for (const [name, ex] of Object.entries<{ value: unknown }>(content.examples)) assertEquals(fixture.examples[name], ex.value, `${key} (${name})`);
    } else {
      assertEquals(fixture.body, content?.example, key);
    }
  }
});

Deno.test("応答例が OpenAPI のスキーマに一致する", () => {
  for (const { key, op } of appOps) {
    // deno-lint-ignore no-explicit-any
    for (const [status, resp] of Object.entries<any>(op.responses as object)) {
      const schema = responseSchema(op, status);
      const content = (resp.$ref ? spec.components.responses[resp.$ref.split("/").pop()] : resp).content?.["application/json"];
      const examples = content?.examples ? Object.values<{ value: unknown }>(content.examples).map((e) => e.value) : content?.example ? [content.example] : [];
      for (const ex of examples) {
        const validate = ajv.compile(withRefs(schema));
        assertEquals(validate(ex), true, `${key} ${status}: ${JSON.stringify(validate.errors)}`);
      }
    }
  }
});

Deno.test("モック API の実際の応答が OpenAPI のスキーマに一致する", async () => {
  const now = Math.floor(Date.now() / 1000);
  const token = await new jose.SignJWT({ role: "authenticated", email: "contract@conime.test" })
    .setProtectedHeader({ alg: "HS256" }).setSubject(crypto.randomUUID()).setIssuedAt(now).setExpirationTime(now + 600)
    .sign(new TextEncoder().encode(JWT_SECRET));
  const bodies: Record<string, unknown> = {
    "POST /conversations/dm": { user_id: crypto.randomUUID() },
    "POST /conversations/{conversation_id}/messages": { body: "テスト" },
    "POST /conversations/{conversation_id}/read": {},
    "POST /uploads/message-images": { content_type: "image/png", size_bytes: 100 },
    "POST /goodtos": { target_type: "message", target_id: crypto.randomUUID() },
    "POST /me/notifications/read": { all: true },
    "POST /reports": { target_type: "user", target_id: crypto.randomUUID(), reason_code: "spam" },
    "POST /blocks": { user_id: crypto.randomUUID() },
    "POST /me/withdrawal": {},
  };
  // POST /navigator/messages は同意確認で DB を使うため Postman（04〜06）で確認する
  for (const { key, op } of appOps.filter((o) => o.stage === "mock" && o.key !== "POST /navigator/messages")) {
    const [method, path] = key.split(" ");
    const url = "http://localhost/api/v1" + path.replace(/\{\w+\}/g, crypto.randomUUID()) +
      (path === "/me/recommendations" ? "?kind=guild" : path === "/conversations" ? "?kind=dm" : "");
    const res = await app.request(url, {
      method,
      headers: { apikey: "test", Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: method === "GET" || method === "DELETE" ? undefined : JSON.stringify(bodies[key] ?? {}),
    });
    // deno-lint-ignore no-explicit-any
    const expected = Object.keys(op.responses as any).find((s) => s.startsWith("2"))!;
    assertEquals(String(res.status), expected, key);
    if (res.status === 204) continue;
    const validate = ajv.compile(withRefs(responseSchema(op, expected)));
    const json = await res.json();
    assertEquals(validate(json), true, `${key}: ${JSON.stringify(validate.errors)}`);
  }
});

Deno.test("会員 API は anon key だけでは 401 UNAUTHENTICATED、期限切れは 401 TOKEN_EXPIRED", async () => {
  const anon = await app.request("http://localhost/api/v1/me/growth", { headers: { apikey: "test" } });
  assertEquals(anon.status, 401);
  assertEquals((await anon.json()).error.code, "UNAUTHENTICATED");
  const past = Math.floor(Date.now() / 1000) - 7200;
  const expired = await new jose.SignJWT({ role: "authenticated" }).setProtectedHeader({ alg: "HS256" })
    .setSubject(crypto.randomUUID()).setIssuedAt(past).setExpirationTime(past + 3600).sign(new TextEncoder().encode(JWT_SECRET));
  const res = await app.request("http://localhost/api/v1/me/growth", { headers: { apikey: "test", Authorization: `Bearer ${expired}` } });
  assertEquals(res.status, 401);
  assertEquals((await res.json()).error.code, "TOKEN_EXPIRED");
});
