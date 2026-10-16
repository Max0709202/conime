import { Hono } from "../_shared/deps.ts";
import { env } from "../_shared/env.ts";
import { ApiError, errorBody, fromDbError } from "../_shared/errors.ts";
import { newRequestId, sleep } from "../_shared/http.ts";
import type { AppEnv } from "./context.ts";
import { docs } from "./docs.ts";
import { character } from "./routes/character.ts";
import { consents } from "./routes/consents.ts";
import { diagnoses } from "./routes/diagnoses.ts";
import { mocks } from "./routes/mocks.ts";
import { questions } from "./routes/questions.ts";
import { system } from "./routes/system.ts";

// アプリ API（Edge Function：api）。ベース URL は /functions/v1/api/v1（API01）
export const app = new Hono<AppEnv>().basePath("/api/v1");

// リクエスト ID・ログ（回答本文・メッセージ本文は出さない：引継01）
app.use("*", async (c, next) => {
  const requestId = newRequestId();
  c.set("requestId", requestId);
  const started = Date.now();
  await next();
  c.header("X-Request-Id", requestId);
  console.log(JSON.stringify({
    fn: "api",
    request_id: requestId,
    user_id: c.get("user")?.userId ?? null,
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    status: c.res.status,
    error_code: c.get("errorCode") ?? null,
    ms: Date.now() - started,
    client_version: c.req.header("X-Client-Version") ?? null,
  }));
});

// API 仕様の閲覧用ページ（dev のみ・ブラウザから開くため apikey 不要）
app.route("/", docs);

// apikey は全要求に必須（API01）
app.use("*", async (c, next) => {
  if (!c.req.header("apikey")) throw new ApiError("UNAUTHENTICATED", "apikey header is required");
  await next();
});

// X-Mock-Scenario の共通シナリオ（dev のみ・API09）。個別のシナリオは各ルートで扱う
app.use("*", async (c, next) => {
  const scenario = env.mockMode ? c.req.header("X-Mock-Scenario") : undefined;
  switch (scenario) {
    case "token_expired":
      throw new ApiError("TOKEN_EXPIRED");
    case "rate_limited":
      throw new ApiError("RATE_LIMITED", undefined, [{ retry_after_seconds: 10 }], { "Retry-After": "10" });
    case "server_error":
      throw new ApiError("INTERNAL_ERROR", "mock scenario: server_error");
    case "timeout":
      await sleep(20_000); // アプリの15秒待機を超える
      break;
  }
  await next();
});

app.route("/", system);
app.route("/", questions);
app.route("/", consents);
app.route("/", diagnoses);
app.route("/", character);
app.route("/", mocks);

app.notFound((c) => {
  const err = new ApiError("NOT_FOUND", "route not found");
  c.set("errorCode", err.code);
  return c.json(errorBody(err, c.get("requestId") ?? newRequestId()), 404);
});

app.onError((e, c) => {
  const err = e instanceof ApiError ? e : fromDbError(e) ?? new ApiError("INTERNAL_ERROR");
  if (err.code === "INTERNAL_ERROR" && !(e instanceof ApiError)) {
    console.error(JSON.stringify({ fn: "api", request_id: c.get("requestId"), error: String(e), stack: (e as Error)?.stack }));
  }
  c.set("errorCode", err.code);
  for (const [k, v] of Object.entries(err.headers)) c.header(k, v);
  return c.json(errorBody(err, c.get("requestId") ?? newRequestId()), err.status as 400);
});
