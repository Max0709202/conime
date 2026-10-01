// Executes AI calls with: budget guard, timeout, strict output-schema validation,
// cost estimation and an app.ai_runs record per execution (provider, model,
// prompt version, input hash, schema version, latency, usage, cost, status,
// retry count, safety result). Inputs are hashed, never stored or logged.
import type { Db } from "../db/pool.ts";
import { aiOutputErrors, aiSchema } from "../http/validate.ts";
import { AiError, type AiPurpose, type AiProvider, type ModerationResult, type Usage } from "./provider.ts";

export interface AiConfig {
  settings: Record<string, unknown>;
  prompts: Record<string, { version: string; system_prompt: string; output_schema_version: string | null }>;
}

export interface RunContext {
  jobId?: string | null;
  userId?: string | null;
  retryCount?: number;
  requestId?: string | null;
}

export async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

export class AiRunner {
  private cache: { at: number; cfg: AiConfig } | null = null;

  constructor(private readonly db: Db, readonly provider: AiProvider, private readonly cacheMs = 30_000) {}

  async config(): Promise<AiConfig> {
    if (!this.cache || Date.now() - this.cache.at > this.cacheMs) {
      this.cache = { at: Date.now(), cfg: await this.db.callService<AiConfig>(null, "svc_ai_config") };
    }
    return this.cache.cfg;
  }

  setting<T>(cfg: AiConfig, key: string, fallback: T): T {
    const v = cfg.settings?.[key];
    return (v === undefined || v === null ? fallback : v) as T;
  }

  private estimateCost(cfg: AiConfig, model: string, usage: Usage, quality?: string): number {
    const pricing = this.setting<Record<string, Record<string, unknown>>>(cfg, "ai.pricing", {});
    const p = pricing[model.replace(/\+mock$/, "")];
    if (!p || this.provider.name === "mock") return 0;
    if (usage.images) {
      const per = (p.per_image as Record<string, number> | undefined)?.[quality ?? "medium"] ?? 0;
      return per * usage.images;
    }
    return ((usage.input_tokens ?? 0) * Number(p.input_per_mtok ?? 0) + (usage.output_tokens ?? 0) * Number(p.output_per_mtok ?? 0)) / 1e6;
  }

  private async assertBudget(estimate: number) {
    if (this.provider.name === "mock") return;
    const status = await this.db.callService<{ spent_today_usd: number; daily_budget_usd: number }>(null, "svc_ai_budget_status");
    if (Number(status.spent_today_usd) + estimate > Number(status.daily_budget_usd)) {
      throw new AiError("AI_BUDGET_EXCEEDED", "daily AI budget reached");
    }
  }

  private async record(run: Record<string, unknown>): Promise<string | null> {
    try {
      return await this.db.callService<string>(null, "svc_record_ai_run", [run]);
    } catch (err) {
      console.error(JSON.stringify({ level: "error", msg: "ai_run record failed", error: String(err) }));
      return null;
    }
  }

  /** Structured JSON generation validated against schemas/ai/<schemaId>.json. */
  async json<T>(ctx: RunContext, purpose: Exclude<AiPurpose, "image" | "moderation">, input: unknown): Promise<{ output: T; runId: string | null }> {
    const cfg = await this.config();
    const prompt = cfg.prompts[purpose];
    if (!prompt?.output_schema_version) throw new AiError("AI_BAD_REQUEST", `no active prompt for ${purpose}`);
    const model = this.setting(cfg, "ai.models.text", "gpt-5-mini");
    const timeoutMs = Number(this.setting(cfg, purpose === "navigator" ? "ai.timeouts.navigator_ms" : "ai.timeouts.text_ms", 45000));
    const maxOut = Number(this.setting<Record<string, number>>(cfg, "ai.text.max_output_tokens", {})[purpose] ?? 2000);
    const inputJson = JSON.stringify(input);
    const base = {
      job_id: ctx.jobId ?? null, user_id: ctx.userId ?? null, purpose, provider: this.provider.name, model,
      prompt_version: prompt.version, input_hash: await sha256Hex(`${prompt.version}:${inputJson}`),
      output_schema_version: prompt.output_schema_version, retry_count: ctx.retryCount ?? 0,
    };
    const started = performance.now();
    try {
      await this.assertBudget(this.estimateCost(cfg, model, { input_tokens: inputJson.length, output_tokens: maxOut }));
      const res = await this.provider.generateJson({
        purpose, model, system: prompt.system_prompt, input, schemaName: prompt.output_schema_version,
        schema: aiSchema(prompt.output_schema_version), timeoutMs, maxOutputTokens: maxOut,
        reasoningEffort: this.setting<string | null>(cfg, "ai.text.reasoning_effort", null),
      });
      const errors = aiOutputErrors(prompt.output_schema_version, res.output);
      const latency = Math.round(performance.now() - started);
      const cost = this.estimateCost(cfg, model, res.usage);
      if (errors.length) {
        await this.record({ ...base, model: res.model, status: "invalid_output", error_code: "AI_INVALID_OUTPUT", latency_ms: latency,
          usage: res.usage, estimated_cost_usd: cost, safety: { schema_errors: errors.length } });
        throw new AiError("AI_INVALID_OUTPUT", `schema validation failed: ${errors[0].path} ${errors[0].message}`, res.usage);
      }
      const runId = await this.record({ ...base, model: res.model, status: "succeeded", latency_ms: latency, usage: res.usage, estimated_cost_usd: cost });
      return { output: res.output as T, runId };
    } catch (err) {
      if (err instanceof AiError && err.message.startsWith("schema validation failed")) throw err;
      const e = err instanceof AiError ? err : new AiError("AI_UNAVAILABLE", String(err));
      await this.record({ ...base, status: statusFor(e), error_code: e.code, latency_ms: Math.round(performance.now() - started),
        usage: e.usage, estimated_cost_usd: this.estimateCost(cfg, model, e.usage) });
      throw e;
    }
  }

  async image(ctx: RunContext, prompt: string): Promise<{ bytes: Uint8Array; runId: string | null }> {
    const cfg = await this.config();
    const model = this.setting(cfg, "ai.models.image", "gpt-image-1");
    const quality = this.setting(cfg, "ai.image.quality", "medium");
    const size = this.setting(cfg, "ai.image.size", "1024x1536");
    const base = {
      job_id: ctx.jobId ?? null, user_id: ctx.userId ?? null, purpose: "image", provider: this.provider.name, model,
      prompt_version: cfg.prompts.image?.version ?? null, input_hash: await sha256Hex(prompt),
      output_schema_version: null, retry_count: ctx.retryCount ?? 0,
    };
    const started = performance.now();
    try {
      await this.assertBudget(this.estimateCost(cfg, model, { images: 1 }, quality));
      const res = await this.provider.generateImage({ model, prompt, size, quality,
        timeoutMs: Number(this.setting(cfg, "ai.timeouts.image_ms", 120000)) });
      const runId = await this.record({ ...base, model: res.model, status: "succeeded", latency_ms: Math.round(performance.now() - started),
        usage: res.usage, estimated_cost_usd: this.estimateCost(cfg, model, res.usage, quality) });
      return { bytes: res.bytes, runId };
    } catch (err) {
      const e = err instanceof AiError ? err : new AiError("AI_UNAVAILABLE", String(err));
      await this.record({ ...base, status: statusFor(e), error_code: e.code, latency_ms: Math.round(performance.now() - started), usage: {} });
      throw e;
    }
  }

  /** Moderation; returns null when the provider is unavailable (callers fall back to local filtering). */
  async moderate(ctx: RunContext, text: string): Promise<ModerationResult | null> {
    const cfg = await this.config();
    const model = this.setting(cfg, "ai.models.moderation", "omni-moderation-latest");
    const started = performance.now();
    try {
      const res = await this.provider.moderateText(model, text, 8000);
      await this.record({ job_id: ctx.jobId ?? null, user_id: ctx.userId ?? null, purpose: "moderation", provider: this.provider.name,
        model: res.model, input_hash: await sha256Hex(text), status: "succeeded", latency_ms: Math.round(performance.now() - started),
        usage: {}, estimated_cost_usd: 0, safety: { flagged: res.flagged } });
      return res;
    } catch (err) {
      const e = err instanceof AiError ? err : new AiError("AI_UNAVAILABLE", String(err));
      await this.record({ job_id: ctx.jobId ?? null, user_id: ctx.userId ?? null, purpose: "moderation", provider: this.provider.name,
        model, input_hash: await sha256Hex(text), status: statusFor(e), error_code: e.code,
        latency_ms: Math.round(performance.now() - started), usage: {} });
      return null;
    }
  }
}

function statusFor(e: AiError): string {
  switch (e.code) {
    case "AI_TIMEOUT": return "timeout";
    case "AI_RATE_LIMITED": return "rate_limited";
    case "AI_REFUSED": return "refused";
    case "AI_INVALID_OUTPUT": return "invalid_output";
    case "AI_BUDGET_EXCEEDED": return "budget_deferred";
    default: return "failed";
  }
}
