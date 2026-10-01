// OpenAI implementation (Responses API with strict Structured Outputs, Images API,
// Moderations API). Only the server holds the API key.
import { AiError, type AiProvider, type ImageRequest, type ImageResult, type JsonRequest, type JsonResult, type ModerationResult } from "./provider.ts";

export class OpenAiProvider implements AiProvider {
  readonly name = "openai";

  constructor(private readonly apiKey: string, private readonly baseUrl = "https://api.openai.com/v1") {}

  private async post(path: string, body: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") throw new AiError("AI_TIMEOUT", `timeout after ${timeoutMs} ms`);
      throw new AiError("AI_UNAVAILABLE", `network error: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") ?? "30");
      throw new AiError("AI_RATE_LIMITED", "provider rate limit", {}, Number.isFinite(retryAfter) ? retryAfter : 30);
    }
    if (res.status >= 500) throw new AiError("AI_UNAVAILABLE", `provider status ${res.status}`);
    if (res.status >= 400) throw new AiError("AI_BAD_REQUEST", `provider status ${res.status}: ${text.slice(0, 200)}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new AiError("AI_UNAVAILABLE", "provider returned non-JSON");
    }
  }

  async generateJson(req: JsonRequest): Promise<JsonResult> {
    const body: Record<string, unknown> = {
      model: req.model,
      input: [
        { role: "system", content: req.system },
        { role: "user", content: JSON.stringify(req.input) },
      ],
      text: { format: { type: "json_schema", name: req.schemaName.replace(/[^a-zA-Z0-9_-]/g, "_"), schema: req.schema, strict: true } },
      max_output_tokens: req.maxOutputTokens ?? 2000,
      store: false,
    };
    if (req.reasoningEffort) body.reasoning = { effort: req.reasoningEffort };
    const data = await this.post("/responses", body, req.timeoutMs);
    const usage = {
      input_tokens: Number((data.usage as Record<string, unknown>)?.input_tokens ?? 0),
      output_tokens: Number((data.usage as Record<string, unknown>)?.output_tokens ?? 0),
    };
    let text = "";
    for (const item of (data.output as Array<Record<string, unknown>>) ?? []) {
      for (const c of (item.content as Array<Record<string, unknown>>) ?? []) {
        if (c.type === "refusal") throw new AiError("AI_REFUSED", String(c.refusal ?? "refused").slice(0, 200), usage);
        if (c.type === "output_text") text += String(c.text ?? "");
      }
    }
    if (data.status === "incomplete") throw new AiError("AI_INVALID_OUTPUT", "incomplete response", usage);
    try {
      return { output: JSON.parse(text), usage, model: String(data.model ?? req.model) };
    } catch {
      throw new AiError("AI_INVALID_OUTPUT", "output is not valid JSON", usage);
    }
  }

  async generateImage(req: ImageRequest): Promise<ImageResult> {
    const data = await this.post("/images/generations", {
      model: req.model,
      prompt: req.prompt,
      size: req.size,
      quality: req.quality,
      n: 1,
    }, req.timeoutMs);
    const b64 = (data.data as Array<Record<string, unknown>>)?.[0]?.b64_json;
    if (typeof b64 !== "string") throw new AiError("AI_INVALID_OUTPUT", "no image returned");
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return { bytes, mime: "image/png", usage: { images: 1 }, model: req.model };
  }

  async moderateText(model: string, text: string, timeoutMs: number): Promise<ModerationResult> {
    const data = await this.post("/moderations", { model, input: text }, timeoutMs);
    const r = (data.results as Array<Record<string, unknown>>)?.[0] ?? {};
    return { flagged: Boolean(r.flagged), categories: (r.categories as Record<string, boolean>) ?? {}, model };
  }
}
