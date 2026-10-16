import { Hono } from "../../_shared/deps.ts";
import { env } from "../../_shared/env.ts";
import { ok } from "../../_shared/http.ts";
import { type AppEnv, iso } from "../context.ts";

export const system = new Hono<AppEnv>();

// GET /health：活死確認（認証不要）
system.get("/health", (c) =>
  c.json(ok({ status: "ok", api_version: env.apiVersion, mock_mode: env.mockMode, time: iso(new Date()) })));
