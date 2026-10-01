// Deterministic mock provider for local development and CI. Never calls the network.
// Supports fault injection so tests can exercise invalid JSON, missing fields,
// invented IDs, refusals, timeouts and rate limits.
import { AiError, type AiPurpose, type AiProvider, type ImageRequest, type ImageResult, type JsonRequest, type JsonResult, type ModerationResult } from "./provider.ts";

export type MockFault =
  | "invalid_json"
  | "missing_fields"
  | "invented_ids"
  | "refusal"
  | "timeout"
  | "rate_limit"
  | "unavailable"
  | "franchise_name";

// A valid 1x1 PNG (transparent).
const PNG_1X1 = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

export class MockAiProvider implements AiProvider {
  readonly name = "mock";
  readonly calls: Array<{ purpose: AiPurpose | "image" | "moderation"; input: unknown }> = [];
  private readonly faults = new Map<string, MockFault[]>();

  /** Queue faults for the next calls of a purpose (consumed in order). */
  inject(purpose: AiPurpose, ...faults: MockFault[]) {
    this.faults.set(purpose, [...(this.faults.get(purpose) ?? []), ...faults]);
  }

  private nextFault(purpose: AiPurpose): MockFault | undefined {
    const q = this.faults.get(purpose);
    return q && q.length ? q.shift() : undefined;
  }

  private throwCommon(fault: MockFault | undefined) {
    if (fault === "timeout") throw new AiError("AI_TIMEOUT", "mock timeout");
    if (fault === "rate_limit") throw new AiError("AI_RATE_LIMITED", "mock rate limit", {}, 1);
    if (fault === "unavailable") throw new AiError("AI_UNAVAILABLE", "mock unavailable");
    if (fault === "refusal") throw new AiError("AI_REFUSED", "mock refusal");
    if (fault === "invalid_json") throw new AiError("AI_INVALID_OUTPUT", "output is not valid JSON");
  }

  // deno-lint-ignore require-await
  async generateJson(req: JsonRequest): Promise<JsonResult> {
    this.calls.push({ purpose: req.purpose, input: req.input });
    const fault = this.nextFault(req.purpose);
    this.throwCommon(fault);
    const usage = { input_tokens: JSON.stringify(req.input).length / 2, output_tokens: 200 };
    const input = req.input as Record<string, unknown>;
    let output: unknown;

    switch (req.purpose) {
      case "normalize": {
        const items = (input.items as Array<{ item_id: string; text: string; candidates: Array<{ id: string; name: string; similarity?: number }> }>) ?? [];
        output = {
          results: items.map((it) => {
            const best = it.candidates[0];
            const pick = fault === "invented_ids" ? crypto.randomUUID() : best && (best.similarity ?? 0) >= 0.3 ? best.id : null;
            return { item_id: it.item_id, matched_id: pick, confidence: pick ? 0.8 : 0 };
          }),
        };
        break;
      }
      case "profile": {
        const ve = (input.visual_elements as Record<string, string | null>) ?? {};
        output = {
          character: {
            character_class: "旅する見習い",
            title: `${ve.theme_color ?? "虹"}色の新星`,
            personality: "好きなことにまっすぐで、仲間思いな性格。",
            strengths: ["好奇心", "仲間づくり"],
            weaknesses: ["早起き", "迷子になりやすい"],
            skills: [
              { name: "ひらめきの一手", description: "ピンチのときに新しいアイデアを思いつく。" },
              { name: "語りの灯火", description: "好きな作品の魅力で仲間を元気づける。" },
              { name: "旅支度", description: "どんな冒険にもすぐ出発できる。" },
            ],
            visual_description: fault === "franchise_name"
              ? `A hero inspired by ${String((input.forbidden_names as string[] | undefined)?.[0] ?? "a famous work")}`
              : "Original adventurer in a hooded travel coat with a satchel, bright eyes, confident pose.",
          },
          profile: {
            summary: "作品の世界にどっぷり浸るのが好きな、仲間思いのアニメファン。",
            comments: [{ question_code: "Q2", text: "心に残るシーンから、熱い展開が好きなことが伝わります。" }],
            conversation_topics: ["最近見た作品", "好きなキャラの魅力"],
          },
        };
        if (fault === "missing_fields") output = { character: { title: "欠損" } };
        break;
      }
      case "anime_recs": {
        const cands = (input.candidates as Array<{ id: string; title: string }>) ?? [];
        const limit = Number(input.result_limit ?? 3);
        output = {
          recommendations: fault === "invented_ids"
            ? [{ work_id: crypto.randomUUID(), reason: "存在しない作品" }]
            : cands.slice(0, limit).map((c) => ({ work_id: c.id, reason: `${c.title}は、あなたの好みに近い要素がそろった作品です。` })),
        };
        break;
      }
      case "navigator": {
        output = {
          reply: "CONIMEナビゲーターです。ギルドに参加したり、グッとを贈り合ったりして仲間と交流できますよ。",
          suggestions: ["ギルドを探すには？", "グッとって何？", "レベルの上げ方は？"],
        };
        break;
      }
      default:
        output = {};
    }
    if (fault === "missing_fields" && req.purpose !== "profile") output = {};
    return { output, usage, model: `${req.model}+mock` };
  }

  generateImage(req: ImageRequest): Promise<ImageResult> {
    this.calls.push({ purpose: "image", input: req.prompt });
    const fault = this.nextFault("image");
    this.throwCommon(fault);
    return Promise.resolve({ bytes: PNG_1X1, mime: "image/png", usage: { images: 1 }, model: `${req.model}+mock` });
  }

  moderateText(model: string, text: string): Promise<ModerationResult> {
    this.calls.push({ purpose: "moderation", input: text });
    const fault = this.nextFault("moderation");
    this.throwCommon(fault);
    const flagged = /\[\[flag\]\]/.test(text);
    return Promise.resolve({ flagged, categories: (flagged ? { harassment: true } : {}) as Record<string, boolean>, model: `${model}+mock` });
  }
}
