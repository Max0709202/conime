// deno-lint-ignore-file no-explicit-any
import { Hono, z } from "../../_shared/deps.ts";
import { ApiError } from "../../_shared/errors.ts";
import { UUID_RE } from "../../_shared/http.ts";
import { FIXTURES, type FixtureKey } from "../../_shared/mock/fixtures.ts";
import { type AppEnv, type Ctx, memberTx, mockScenario, parseBody, requireUser } from "../context.ts";
import { consentSummary } from "./consents.ts";

// 第2段階 API 26本のモック（API09・API10）。応答は openapi.yaml の応答例と同じ内容（_shared/mock/fixtures.ts）。
// 第2段階で同じ契約のまま中身を本実装へ差し替える。会員認証・入力検証・X-Mock-Scenario は本実装と同じ扱い
export const mocks = new Hono<AppEnv>();

const clone = <T>(v: T): T => structuredClone(v);

function fixture(key: FixtureKey, example?: string): { status: number; body: any } {
  const f = FIXTURES[key] as { status: number; body?: unknown; examples?: Record<string, unknown> };
  const body = f.examples ? f.examples[example ?? Object.keys(f.examples)[0]] : f.body;
  return { status: f.status, body: clone(body) };
}

// empty シナリオ：一覧・推薦を0件にする
function respond(c: Ctx, key: FixtureKey, opts: { example?: string; list?: boolean; patch?: (data: any) => void } = {}) {
  const { status, body } = fixture(key, opts.example);
  if (status === 204) return c.body(null, 204);
  if (opts.list && mockScenario(c) === "empty") body.data = [];
  if (opts.patch) opts.patch(body.data);
  return c.json(body, status as 200);
}

const uuidParam = (c: Ctx, name: string) => {
  const v = c.req.param(name);
  if (!v || !UUID_RE.test(v)) throw new ApiError("NOT_FOUND", `${name} not found`);
  return v;
};

// 全モックは会員向け（JWT の検証・利用制限は本実装と同じ）
mocks.use("*", async (c, next) => {
  await requireUser(c);
  await next();
});

// ------------------------------------------------------------------ ユーザー・推薦
mocks.get("/users/:user_id", (c) => {
  const id = uuidParam(c, "user_id");
  return respond(c, "GET /users/{user_id}", { patch: (d) => (d.id = id) });
});

mocks.get("/me/recommendations", (c) => {
  const kind = c.req.query("kind");
  if (kind !== "user" && kind !== "guild" && kind !== "work") {
    throw new ApiError("VALIDATION_ERROR", "kind must be user, guild or work", [
      { field: "kind", reason: "enum", allowed: ["user", "guild", "work"] },
    ]);
  }
  return respond(c, "GET /me/recommendations", { example: kind, list: true });
});

// ------------------------------------------------------------------ ギルド
mocks.get("/guilds", (c) => respond(c, "GET /guilds", { list: true }));
mocks.get("/me/guilds", (c) => respond(c, "GET /me/guilds", { list: true }));

mocks.get("/guilds/:guild_id", (c) => {
  const id = uuidParam(c, "guild_id");
  return respond(c, "GET /guilds/{guild_id}", { patch: (d) => (d.id = id) });
});

mocks.post("/guilds/:guild_id/join", (c) => {
  const id = uuidParam(c, "guild_id");
  if (mockScenario(c) === "guild_full") throw new ApiError("GUILD_FULL", undefined, [{ guild_id: id, capacity: 100 }]);
  return respond(c, "POST /guilds/{guild_id}/join", { patch: (d) => (d.guild_id = id) });
});

mocks.get("/guilds/:guild_id/announcements", (c) => {
  uuidParam(c, "guild_id");
  return respond(c, "GET /guilds/{guild_id}/announcements", { list: true });
});

mocks.get("/guilds/:guild_id/members", (c) => {
  uuidParam(c, "guild_id");
  return respond(c, "GET /guilds/{guild_id}/members", { list: true });
});

// ------------------------------------------------------------------ トークルーム・DM
mocks.get("/conversations", (c) => {
  if (c.req.query("kind") !== "dm") {
    throw new ApiError("VALIDATION_ERROR", "kind must be dm", [{ field: "kind", reason: "enum", allowed: ["dm"] }]);
  }
  return respond(c, "GET /conversations", { list: true });
});

mocks.post("/conversations/dm", async (c) => {
  await parseBody(c, z.object({ user_id: z.string().uuid() }));
  return respond(c, "POST /conversations/dm");
});

mocks.get("/conversations/:conversation_id/messages", (c) => {
  const id = uuidParam(c, "conversation_id");
  return respond(c, "GET /conversations/{conversation_id}/messages", {
    list: true,
    patch: (d) => d.forEach((m: any) => (m.conversation_id = id)),
  });
});

mocks.post("/conversations/:conversation_id/messages", async (c) => {
  const id = uuidParam(c, "conversation_id");
  const body = await parseBody(
    c,
    z.object({ body: z.string().min(1).max(2000).optional(), image_path: z.string().min(1).optional() })
      .refine((b) => b.body !== undefined || b.image_path !== undefined, { message: "body or image_path is required" }),
  );
  return respond(c, "POST /conversations/{conversation_id}/messages", {
    patch: (d) => {
      d.conversation_id = id;
      d.body = body.body ?? null;
    },
  });
});

mocks.post("/conversations/:conversation_id/read", async (c) => {
  const id = uuidParam(c, "conversation_id");
  await parseBody(c, z.object({ last_read_at: z.string().datetime({ offset: true }).optional() }), true);
  return respond(c, "POST /conversations/{conversation_id}/read", { patch: (d) => (d.conversation_id = id) });
});

mocks.post("/uploads/message-images", async (c) => {
  await parseBody(c, z.object({
    content_type: z.enum(["image/jpeg", "image/png"]),
    size_bytes: z.number().int().min(1).max(5 * 1024 * 1024),
  }));
  return respond(c, "POST /uploads/message-images");
});

// ------------------------------------------------------------------ グッと・成長
mocks.post("/goodtos", async (c) => {
  const body = await parseBody(c, z.object({ target_type: z.enum(["message"]), target_id: z.string().uuid() }));
  if (mockScenario(c) === "duplicate_goodto") {
    // 付与済みでも累計を返す（API10）
    throw new ApiError("DUPLICATE_GOODTO", undefined, [{ target_type: body.target_type, target_id: body.target_id, total_count: 12 }]);
  }
  return respond(c, "POST /goodtos", { patch: (d) => (d.target = { type: body.target_type, id: body.target_id }) });
});

mocks.get("/me/goodtos/received", (c) => respond(c, "GET /me/goodtos/received", { list: true }));
mocks.get("/me/growth", (c) => respond(c, "GET /me/growth"));

// ------------------------------------------------------------------ ナビゲーター
mocks.get("/navigator/messages", (c) => respond(c, "GET /navigator/messages", { list: true }));

mocks.post("/navigator/messages", async (c) => {
  const body = await parseBody(c, z.object({ body: z.string().trim().min(1).max(500) }));
  // AI 送信同意が必要（AC-2）。同意の判定はモックでも本実装と同じ
  const consented = await memberTx(c, async (tx) => (await consentSummary(tx)).ai_transfer_granted);
  if (!consented) throw new ApiError("CONSENT_REQUIRED", undefined, [{ doc_type: "ai_transfer" }]);
  if (mockScenario(c) === "ai_unavailable") throw new ApiError("AI_UNAVAILABLE");
  return respond(c, "POST /navigator/messages", { patch: (d) => (d.question.body = body.body) });
});

// ------------------------------------------------------------------ 通知
mocks.get("/me/notifications", (c) => respond(c, "GET /me/notifications", { list: true }));

mocks.post("/me/notifications/read", async (c) => {
  await parseBody(
    c,
    z.object({ notification_ids: z.array(z.string().uuid()).max(100).optional(), all: z.boolean().optional() })
      .refine((b) => b.all === true || (b.notification_ids?.length ?? 0) > 0, { message: "notification_ids or all is required" }),
  );
  return respond(c, "POST /me/notifications/read");
});

// ------------------------------------------------------------------ 安心安全・退会
mocks.post("/reports", async (c) => {
  await parseBody(c, z.object({
    target_type: z.enum(["message", "character_image", "navigator_reply", "user"]),
    target_id: z.string().uuid(),
    reason_code: z.enum(["spam", "harassment", "inappropriate", "impersonation", "other"]),
    detail: z.string().max(1000).optional(),
  }));
  return respond(c, "POST /reports");
});

mocks.get("/me/blocks", (c) => respond(c, "GET /me/blocks", { list: true }));

mocks.post("/blocks", async (c) => {
  const body = await parseBody(c, z.object({ user_id: z.string().uuid() }));
  return respond(c, "POST /blocks", { patch: (d) => (d.user_id = body.user_id) });
});

mocks.delete("/blocks/:user_id", (c) => {
  uuidParam(c, "user_id");
  return respond(c, "DELETE /blocks/{user_id}");
});

mocks.post("/me/withdrawal", async (c) => {
  await parseBody(c, z.object({ reason: z.string().max(500).optional() }), true);
  return respond(c, "POST /me/withdrawal");
});
