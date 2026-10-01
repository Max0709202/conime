// HTTP application: request IDs, error envelope, auth, rate limiting, body
// validation, idempotency and signed-URL post-processing. Route modules declare
// their policy through `kit.route(...)` so these concerns cannot be skipped.
import { Hono, type Context } from "hono";
import type { EnvConfig } from "../config.ts";
import type { Claims, Db } from "../db/pool.ts";
import type { JwtVerifier } from "../auth/jwt.ts";
import type { StorageGateway } from "../storage/gateway.ts";
import type { AiRunner } from "../ai/runner.ts";
import { sha256Hex } from "../ai/runner.ts";
import { ApiError, errorBody } from "./errors.ts";
import { validateBody } from "./validate.ts";

export interface AuthAdmin {
  /** Revoke sign-in immediately after an account deletion request. */
  banUser(userId: string): Promise<void>;
  /** Soft-delete the Auth user after server-side processing. */
  softDeleteUser(userId: string): Promise<void>;
}

export interface Deps {
  config: EnvConfig;
  db: Db;
  verifier: JwtVerifier;
  storage: StorageGateway;
  ai: AiRunner;
  authAdmin: AuthAdmin;
  /** Best-effort trigger of the worker after enqueueing (cron is the safety net). */
  wakeWorker?: () => void;
  log?: (entry: Record<string, unknown>) => void;
}

export interface RouteContext {
  c: Context;
  deps: Deps;
  requestId: string;
  claims: Claims | null;
  userId: string;
  body: unknown;
  ip: string;
}

export interface RouteResult {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface RouteOptions {
  auth?: "required" | "none" | "allow_deleted";
  rateScope?: string;
  bodySchema?: string;
  idempotent?: boolean;
}

const MAX_BODY_BYTES = 256 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Settings cache (rate limits etc.)
// ---------------------------------------------------------------------------
class SettingsCache {
  private at = 0;
  private values: Record<string, unknown> = {};
  constructor(private readonly db: Db, private readonly ttlMs = 30_000) {}
  async get<T>(key: string, fallback: T): Promise<T> {
    if (Date.now() - this.at > this.ttlMs) {
      const rows = await this.db.asService(null, (tx) => tx`select key, value from app.app_settings`);
      this.values = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      this.at = Date.now();
    }
    const v = this.values[key];
    return (v === undefined || v === null ? fallback : v) as T;
  }
}

// ---------------------------------------------------------------------------
// Signed URL post-processing
// ---------------------------------------------------------------------------
async function signImageRefs(deps: Deps, settings: SettingsCache, body: unknown): Promise<unknown> {
  const avatarRefs: Array<Record<string, unknown>> = [];
  const attachmentRefs: Array<Record<string, unknown>> = [];
  const walk = (n: unknown) => {
    if (Array.isArray(n)) n.forEach(walk);
    else if (n && typeof n === "object") {
      const o = n as Record<string, unknown>;
      if ("__image_path" in o) avatarRefs.push(o);
      if ("__attachment_path" in o) attachmentRefs.push(o);
      Object.values(o).forEach(walk);
    }
  };
  walk(body);
  if (!avatarRefs.length && !attachmentRefs.length) return body;

  const avatarBucket = await settings.get("avatars.bucket", "avatars");
  const avatarPaths = [...new Set(avatarRefs.map((o) => o.__image_path).filter((p): p is string => typeof p === "string"))];
  const avatarUrls = avatarPaths.length ? await deps.storage.createSignedUrls(avatarBucket, avatarPaths, 3600) : new Map();
  for (const o of avatarRefs) {
    const s = typeof o.__image_path === "string" ? avatarUrls.get(o.__image_path) : undefined;
    o.url = s?.url ?? null;
    o.url_expires_at = s ? s.expiresAt.toISOString() : null;
    delete o.__image_path;
  }

  const ttl = await settings.get("attachments.download_url_ttl_seconds", 3600);
  const byBucket = new Map<string, string[]>();
  for (const o of attachmentRefs) {
    const full = o.__attachment_path;
    if (typeof full === "string") {
      const [bucket, ...rest] = full.split("/");
      byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), rest.join("/")]);
    }
  }
  const signed = new Map<string, { url: string; expiresAt: Date }>();
  for (const [bucket, paths] of byBucket) {
    for (const [p, s] of await deps.storage.createSignedUrls(bucket, [...new Set(paths)], ttl)) signed.set(`${bucket}/${p}`, s);
  }
  for (const o of attachmentRefs) {
    const s = typeof o.__attachment_path === "string" ? signed.get(o.__attachment_path) : undefined;
    o.url = s?.url ?? null;
    o.url_expires_at = s ? s.expiresAt.toISOString() : null;
    delete o.__attachment_path;
  }
  return body;
}

// ---------------------------------------------------------------------------
// Kit
// ---------------------------------------------------------------------------
export class RouteKit {
  readonly settings: SettingsCache;

  constructor(readonly deps: Deps) {
    this.settings = new SettingsCache(deps.db);
  }

  private async rateLimit(ctx: RouteContext, scope: string) {
    const all = await this.settings.get<Record<string, { limit: number; window_seconds: number }>>("rate_limits", {});
    const rule = all[scope] ?? all.default;
    if (!rule) return;
    const subject = ctx.claims ? null : await sha256Hex(`ip:${ctx.ip}`);
    const rows = await this.deps.db.asUser(ctx.claims, ctx.requestId, (tx) =>
      tx`select allowed, retry_after_seconds from app.api_rate_limit(${scope}, ${rule.limit}, ${rule.window_seconds}, ${subject})`);
    if (!rows[0]?.allowed) {
      const retry = Number(rows[0]?.retry_after_seconds ?? rule.window_seconds);
      throw new ApiError("RATE_LIMITED", { retry_after_seconds: retry, scope }, { "retry-after": String(retry) });
    }
  }

  private async readBody(c: Context): Promise<unknown> {
    const ct = (c.req.header("content-type") ?? "").toLowerCase();
    const raw = await c.req.text();
    if (raw.length === 0) return undefined;
    if (!ct.startsWith("application/json")) throw new ApiError("UNSUPPORTED_MEDIA_TYPE");
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) throw new ApiError("PAYLOAD_TOO_LARGE");
    try {
      return JSON.parse(raw);
    } catch {
      throw new ApiError("INVALID_JSON");
    }
  }

  route(opts: RouteOptions, handler: (ctx: RouteContext) => Promise<RouteResult>) {
    return async (c: Context) => {
      const requestId = c.get("requestId") as string;
      const auth = opts.auth ?? "required";
      const claims = auth === "none" ? null : await this.deps.verifier.verify(c.req.header("authorization") ?? null);
      const ip = (c.req.header("x-forwarded-for") ?? "").split(",")[0].trim() || c.req.header("x-real-ip") || "unknown";
      const ctx: RouteContext = { c, deps: this.deps, requestId, claims, userId: claims?.sub ?? "", body: undefined, ip };
      if (claims) c.set("userId", claims.sub);

      if (claims && auth === "required") {
        // Account status gate (ACCOUNT_DELETED) before any other work.
        await this.deps.db.asUser(claims, requestId, (tx) => tx`select app.require_user()`);
      }
      await this.rateLimit(ctx, opts.rateScope ?? "default");

      const method = c.req.method;
      if (method === "POST" || method === "PATCH" || method === "PUT") {
        ctx.body = await this.readBody(c);
        if (opts.bodySchema) ctx.body = validateBody(opts.bodySchema, ctx.body ?? {});
      }

      const idemKey = c.req.header("idempotency-key");
      let idem: { key: string } | null = null;
      if (opts.idempotent && idemKey && claims) {
        if (!/^[A-Za-z0-9_\-:.]{8,64}$/.test(idemKey)) {
          throw new ApiError("VALIDATION_ERROR", { fields: [{ path: "/headers/Idempotency-Key", rule: "pattern", message: "8–64 chars [A-Za-z0-9_-:.]" }] });
        }
        const hash = await sha256Hex(`${method} ${c.req.path}\n${JSON.stringify(ctx.body ?? null)}`);
        const replay = await this.idemBegin(ctx, idemKey, method, hash);
        if (replay) {
          return c.json(replay.body as never, replay.status as never, { "idempotent-replayed": "true" });
        }
        idem = { key: idemKey };
      }

      let result: RouteResult;
      try {
        result = await handler(ctx);
      } catch (err) {
        if (idem) await this.idemAbort(ctx, idem.key);
        throw err;
      }
      const status = result.status ?? 200;
      const body = result.body === undefined ? undefined : await signImageRefs(this.deps, this.settings, result.body);
      if (idem) {
        if (status >= 200 && status < 300) await this.idemFinish(ctx, idem.key, status, body ?? null);
        else await this.idemAbort(ctx, idem.key);
      }
      if (status === 204 || body === undefined) return c.body(null, status as never, result.headers);
      return c.json(body as never, status as never, result.headers);
    };
  }

  private async idemBegin(ctx: RouteContext, key: string, method: string, hash: string): Promise<{ status: number; body: unknown } | null> {
    return await this.deps.db.asService(ctx.requestId, async (tx) => {
      const ins = await tx`insert into app.idempotency_keys (user_id, idem_key, method, route, request_hash)
        select ${ctx.userId}, ${key}, ${method}, ${ctx.c.req.path}, ${hash}
        where exists (select 1 from app.profiles where id = ${ctx.userId})
        on conflict (user_id, idem_key) do nothing returning idem_key`;
      if (ins.length) return null;
      const rows = await tx`select request_hash, state, response_status, response_body, created_at, expires_at
                            from app.idempotency_keys where user_id = ${ctx.userId} and idem_key = ${key} for update`;
      const row = rows[0];
      if (!row) return null; // no profile yet: proceed without idempotency storage
      if (new Date(row.expires_at) < new Date()) {
        await tx`update app.idempotency_keys set request_hash = ${hash}, method = ${method}, route = ${ctx.c.req.path},
                 state = 'in_progress', response_status = null, response_body = null, created_at = now(),
                 expires_at = now() + interval '24 hours' where user_id = ${ctx.userId} and idem_key = ${key}`;
        return null;
      }
      if (row.request_hash !== hash) throw new ApiError("IDEMPOTENCY_KEY_REUSED");
      if (row.state === "completed") return { status: row.response_status, body: row.response_body };
      if (Date.now() - new Date(row.created_at).getTime() < 60_000) throw new ApiError("IDEMPOTENCY_IN_PROGRESS");
      await tx`update app.idempotency_keys set created_at = now() where user_id = ${ctx.userId} and idem_key = ${key}`;
      return null;
    });
  }

  private async idemFinish(ctx: RouteContext, key: string, status: number, body: unknown) {
    await this.deps.db.asService(ctx.requestId, (tx) =>
      tx`update app.idempotency_keys set state = 'completed', response_status = ${status},
         response_body = ${tx.json(body as never)} where user_id = ${ctx.userId} and idem_key = ${key}`);
  }

  private async idemAbort(ctx: RouteContext, key: string) {
    await this.deps.db.asService(ctx.requestId, (tx) =>
      tx`delete from app.idempotency_keys where user_id = ${ctx.userId} and idem_key = ${key} and state = 'in_progress'`)
      .catch(() => {});
  }

  /** Calls app.api_<fn> as the current user. */
  call<T = Record<string, unknown>>(ctx: RouteContext, fn: string, args: unknown[] = []): Promise<T> {
    return this.deps.db.callUser<T>(ctx.claims, ctx.requestId, fn, args);
  }
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------
export function createBaseApp(deps: Deps) {
  const app = new Hono<{ Variables: { requestId: string; userId: string; started: number } }>();
  const log = deps.log ?? ((e) => console.log(JSON.stringify(e)));

  app.use("*", async (c, next) => {
    const incoming = c.req.header("x-request-id");
    const requestId = incoming && UUID_RE.test(incoming) ? incoming.toLowerCase() : crypto.randomUUID();
    c.set("requestId", requestId);
    c.set("started", performance.now());
    await next();
    c.res.headers.set("x-request-id", requestId);
    c.res.headers.set("cache-control", "no-store");
    log({
      level: c.res.status >= 500 ? "error" : "info",
      msg: "request",
      request_id: requestId,
      method: c.req.method,
      route: c.req.routePath,
      status: c.res.status,
      latency_ms: Math.round(performance.now() - (c.get("started") as number)),
      user_id: c.get("userId") ?? null,
    });
  });

  app.onError((err, c) => {
    const requestId = (c.get("requestId") as string) ?? crypto.randomUUID();
    if (err instanceof ApiError) {
      return c.json(errorBody(err, requestId), err.status as never, { ...err.headers, "x-request-id": requestId });
    }
    log({ level: "error", msg: "unhandled", request_id: requestId, error: String((err as Error)?.message ?? err).slice(0, 500) });
    const e = new ApiError("INTERNAL_ERROR");
    return c.json(errorBody(e, requestId), 500, { "x-request-id": requestId });
  });

  app.notFound((c) => {
    const requestId = (c.get("requestId") as string) ?? crypto.randomUUID();
    return c.json(errorBody(new ApiError("NOT_FOUND"), requestId), 404, { "x-request-id": requestId });
  });

  return app;
}
