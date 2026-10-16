import { type AuthUser, bearerToken, verifyAccessToken } from "../_shared/auth.ts";
import { type Tx, withRls } from "../_shared/db.ts";
import type { Context, z } from "../_shared/deps.ts";
import { env } from "../_shared/env.ts";
import { ApiError, type ErrorDetail } from "../_shared/errors.ts";
import { checkRateLimit } from "../_shared/rate_limit.ts";

export type AppEnv = {
  Variables: {
    requestId: string;
    user?: AuthUser;
    errorCode?: string;
  };
};
export type Ctx = Context<AppEnv>;

// 会員向け API：アクセストークンを検証し、利用制限を数える
export async function requireUser(c: Ctx): Promise<AuthUser> {
  const cached = c.get("user");
  if (cached) return cached;
  const user = await verifyAccessToken(bearerToken(c.req.header("Authorization")));
  c.set("user", user);
  checkRateLimit(user.userId);
  return user;
}

// 会員のトランザクション（authenticated ロール + JWT クレーム → RLS 適用）。退会済みは 403 ACCOUNT_WITHDRAWN
export async function memberTx<T>(c: Ctx, fn: (tx: Tx, user: AuthUser) => Promise<T>): Promise<T> {
  const user = await requireUser(c);
  return await withRls("authenticated", user.claims, async (tx) => {
    const [profile] = await tx`select status from public.profiles where user_id = ${user.userId}`;
    if (!profile) throw new ApiError("UNAUTHENTICATED", "profile not found");
    if (profile.status === "withdrawn") throw new ApiError("ACCOUNT_WITHDRAWN");
    return await fn(tx, user);
  });
}

// 未ログインでも使える API（anon ロール → RLS 適用）
export function publicTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withRls("anon", { role: "anon" }, fn);
}

export function mockScenario(c: Ctx): string | undefined {
  return env.mockMode ? c.req.header("X-Mock-Scenario") ?? undefined : undefined;
}

const fieldPath = (path: (string | number)[]) =>
  path.reduce<string>((acc, p) => (typeof p === "number" ? `${acc}[${p}]` : acc ? `${acc}.${p}` : p), "");

export function zodDetails(error: z.ZodError): ErrorDetail[] {
  return error.issues.map((i) => {
    const d: ErrorDetail = { field: fieldPath(i.path) || "body", reason: i.code, message: i.message };
    if ("maximum" in i) d.limit = Number(i.maximum);
    if ("minimum" in i) d.limit = Number(i.minimum);
    return d;
  });
}

export async function readJson(c: Ctx, optional = false): Promise<unknown> {
  const text = await c.req.text();
  if (text.trim() === "") {
    if (optional) return {};
    throw new ApiError("VALIDATION_ERROR", "request body is required", [{ field: "body", reason: "required" }]);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError("VALIDATION_ERROR", "request body must be valid JSON", [{ field: "body", reason: "invalid_json" }]);
  }
}

export async function parseBody<S extends z.ZodTypeAny>(c: Ctx, schema: S, optional = false): Promise<z.infer<S>> {
  const raw = await readJson(c, optional);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError("VALIDATION_ERROR", parsed.error.issues[0]?.message, zodDetails(parsed.error));
  }
  return parsed.data;
}

export async function getSetting<T>(tx: Tx, key: string, fallback: T): Promise<T> {
  const [row] = await tx`select value from public.app_settings where key = ${key}`;
  return (row?.value ?? fallback) as T;
}

// ISO 8601（UTC・秒まで）
export const iso = (d: Date | string | null | undefined): string | null =>
  d == null ? null : new Date(d).toISOString().replace(/\.\d{3}Z$/, "Z");
