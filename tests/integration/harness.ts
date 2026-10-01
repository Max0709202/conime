// Integration-test harness: runs the real API (createApp) over HTTP on localhost
// against the local database, with the deterministic mock AI provider (faults can
// be injected), the filesystem storage emulator (real signed URLs) and the worker
// invoked explicitly. Responses are validated against openapi/openapi.yaml schemas.
//
// Set API_BASE_URL to run the HTTP-only tests against a deployed environment instead
// (tokens are then obtained from Supabase Auth; see tests/integration/README.md).
import { assert, assertEquals } from "@std/assert";
import { buildDeps } from "../../supabase/functions/_shared/deps.ts";
import { createApp } from "../../supabase/functions/_shared/http/routes.ts";
import { loadConfig } from "../../supabase/functions/_shared/config.ts";
import { MockAiProvider } from "../../supabase/functions/_shared/ai/mock.ts";
import { LocalStorageGateway } from "../../supabase/functions/_shared/storage/gateway.ts";
import { mintTestToken } from "../../supabase/functions/_shared/auth/jwt.ts";
import { responseErrors } from "../../supabase/functions/_shared/http/validate.ts";
import { runMaintenance, runWorkerBatch } from "../../supabase/functions/_shared/worker/run.ts";
import type { Deps } from "../../supabase/functions/_shared/http/app.ts";

export const FIXTURE = {
  alice: "10000000-0000-4000-8000-000000000001", // Lv4 (270 EXP), guilds 1+2, blocks erin, blocked by frank
  bob: "10000000-0000-4000-8000-000000000002", // Lv9 (845 EXP), guild 1, DM with alice
  carol: "10000000-0000-4000-8000-000000000003", // guild 2
  dave: "10000000-0000-4000-8000-000000000004", // no guild, unnamed character
  erin: "10000000-0000-4000-8000-000000000005", // guild 1, blocked by alice
  frank: "10000000-0000-4000-8000-000000000006", // guild 1, blocks alice
  noDiagnosis: "10000000-0000-4000-8000-000000000195",
  noConsent: "10000000-0000-4000-8000-000000000200",
  guild1: "20000000-0000-4000-8000-000000000001",
  guild2: "20000000-0000-4000-8000-000000000002",
  guild3: "20000000-0000-4000-8000-000000000003",
  fullGuild: "20000000-0000-4000-8000-000000000005",
  lastSeatGuild: "20000000-0000-4000-8000-000000000006",
  draftGuild: "20000000-0000-4000-8000-000000000007",
};
export const QS_VERSION = "qs-2026-10-v1";
export const CONSENT_VERSION = "2026-10-01";

export interface Harness {
  base: string;
  deps: Deps;
  ai: MockAiProvider;
  secret: string;
  token(sub: string, opts?: { expiresInSec?: number }): Promise<string>;
  api(method: string, path: string, opts?: { token?: string; body?: unknown; headers?: Record<string, string>; raw?: BodyInit }): Promise<ApiResponse>;
  newUser(opts?: { consent?: boolean }): Promise<string>;
  worker(): Promise<{ processed: number; results: Array<{ job_id: string; outcome: string }> }>;
  maintenance(): Promise<Record<string, unknown>>;
  // deno-lint-ignore no-explicit-any
  sql<T = Record<string, any>>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

export interface ApiResponse {
  status: number;
  // deno-lint-ignore no-explicit-any
  json: any;
  headers: Headers;
}

let shared: Promise<Harness> | null = null;

export function harness(): Promise<Harness> {
  shared ??= start();
  return shared;
}

async function start(): Promise<Harness> {
  const secret = Deno.env.get("CONIME_JWT_SECRET") ?? "local-only-jwt-secret-change-me-at-least-32-characters";
  Deno.env.set("CONIME_JWT_SECRET", secret);
  Deno.env.set("CONIME_DB_URL", Deno.env.get("CONIME_DB_URL") ?? "postgresql://postgres@127.0.0.1:54329/conime");
  const probe = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (probe.addr as Deno.NetAddr).port;
  probe.close();
  const base = `http://127.0.0.1:${port}`;
  const storageDir = await Deno.makeTempDir({ prefix: "conime-storage-" });
  Deno.env.set("PUBLIC_BASE_URL", base);
  Deno.env.set("LOCAL_STORAGE_DIR", storageDir);
  Deno.env.set("STORAGE_DRIVER", "local");
  Deno.env.set("AI_PROVIDER", "mock");
  Deno.env.delete("SUPABASE_URL");

  const ai = new MockAiProvider();
  const deps = buildDeps(loadConfig(), { provider: ai });
  deps.log = () => {}; // keep test output readable
  const app = createApp(deps);
  const server = Deno.serve({ hostname: "127.0.0.1", port, onListen: () => {} }, (req) => {
    if (new URL(req.url).pathname.startsWith("/__storage/")) return (deps.storage as LocalStorageGateway).handle(req);
    return app.fetch(req);
  });

  const h: Harness = {
    base, deps, ai, secret,
    token: (sub, opts) => mintTestToken(secret, sub, opts),
    async api(method, path, opts = {}) {
      const headers: Record<string, string> = { ...(opts.headers ?? {}) };
      if (opts.token) headers.authorization = `Bearer ${opts.token}`;
      let body: BodyInit | undefined = opts.raw;
      if (opts.body !== undefined) {
        headers["content-type"] ??= "application/json";
        body = JSON.stringify(opts.body);
      }
      const res = await fetch(`${base}${path}`, { method, headers, body });
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = text;
      }
      return { status: res.status, json, headers: res.headers };
    },
    async newUser(opts = {}) {
      const id = crypto.randomUUID();
      // Fixtures use the connection role directly: auth.* is not writable by service_role.
      await deps.db.sql.begin(async (tx) => {
        await tx`insert into auth.users (id, email) values (${id}, ${`${id}@it.test`})`;
        if (opts.consent) {
          await tx`insert into app.consents (user_id, consent_type, consent_version, accepted) values (${id}, 'ai_data_transfer', ${CONSENT_VERSION}, true)`;
        }
      });
      return id;
    },
    worker: () => runWorkerBatch(deps, { deadlineMs: 20_000, visibilitySeconds: 30 }),
    maintenance: () => runMaintenance(deps),
    // deno-lint-ignore no-explicit-any
    sql: (strings, ...values) => deps.db.sql(strings, ...(values as any[])) as any,
    async close() {
      await server.shutdown();
      await deps.db.sql.end({ timeout: 2 });
      await Deno.remove(storageDir, { recursive: true }).catch(() => {});
    },
  };
  return h;
}

/** Asserts the HTTP status and validates the body against an OpenAPI component schema. */
export function expectOk(res: ApiResponse, status: number, schema?: string) {
  assertEquals(res.status, status, `expected ${status}, got ${res.status}: ${JSON.stringify(res.json).slice(0, 400)}`);
  assert(/^[0-9a-f-]{36}$/.test(res.headers.get("x-request-id") ?? ""), "X-Request-Id header");
  if (schema) {
    const errors = responseErrors(schema, res.json);
    assertEquals(errors, [], `response does not match ${schema}: ${JSON.stringify(errors).slice(0, 400)}`);
  }
}

/** Asserts an error envelope with the given status and code. */
export function expectError(res: ApiResponse, status: number, code: string) {
  assertEquals(res.status, status, `expected ${status} ${code}, got ${res.status}: ${JSON.stringify(res.json).slice(0, 300)}`);
  assertEquals(responseErrors("ErrorEnvelope", res.json), [], "error envelope shape");
  assertEquals(res.json.error.code, code);
  assertEquals(res.json.error.request_id, res.headers.get("x-request-id"));
}

/** Integration tests share one server/pool; sanitizers are disabled for that reason. */
export function itest(name: string, fn: (h: Harness) => Promise<void>) {
  Deno.test({ name, sanitizeOps: false, sanitizeResources: false, fn: async () => fn(await harness()) });
}

/** Builds a complete, valid answer set for the current question set. */
export async function validAnswers(h: Harness, overrides: Record<string, { texts?: string[]; options?: string[] }> = {}) {
  const qs = (await h.api("GET", "/v1/question-sets/current")).json;
  return qs.questions.map((q: { id: string; code: string; answer_type: string; options: Array<{ id: string; code: string }> }) => {
    const o = overrides[q.code];
    if (q.answer_type === "single_choice" || q.answer_type === "multi_choice") {
      const codes = o?.options ?? [q.options[0].code];
      return { question_id: q.id, option_ids: codes.map((c) => q.options.find((x) => x.code === c)!.id) };
    }
    const defaults: Record<string, string[]> = {
      Q1: ["星屑のアルカディア", "ホシクズ アルカ", "知らない作品"], Q3: ["アキラ・星屑", "ミオ様"], Q7: ["蒼穹ブレイバーズ"],
      Q8: ["ホラー系"], Q11: ["異世界、宇宙"], Q12: ["アキラ・星屑"],
    };
    return { question_id: q.id, texts: o?.texts ?? defaults[q.code] ?? ["テスト回答"] };
  });
}
