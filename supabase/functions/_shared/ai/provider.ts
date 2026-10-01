// AI provider interface. The worker and navigator depend only on this interface,
// so the provider (OpenAI, mock) and the worker host (Edge Function, Cloud Run)
// can change without touching the public API.

export type AiPurpose = "normalize" | "profile" | "image" | "anime_recs" | "navigator" | "moderation";

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  images?: number;
}

export interface JsonRequest {
  purpose: AiPurpose;
  model: string;
  system: string;
  input: unknown;
  schemaName: string;
  schema: Record<string, unknown>;
  timeoutMs: number;
  maxOutputTokens?: number;
  reasoningEffort?: string | null;
}

export interface JsonResult {
  output: unknown;
  usage: Usage;
  model: string;
}

export interface ImageRequest {
  model: string;
  prompt: string;
  size: string;
  quality: string;
  timeoutMs: number;
}

export interface ImageResult {
  bytes: Uint8Array;
  mime: "image/png";
  usage: Usage;
  model: string;
}

export interface ModerationResult {
  flagged: boolean;
  categories: Record<string, boolean>;
  model: string;
}

export interface AiProvider {
  readonly name: string;
  generateJson(req: JsonRequest): Promise<JsonResult>;
  generateImage(req: ImageRequest): Promise<ImageResult>;
  moderateText(model: string, text: string, timeoutMs: number): Promise<ModerationResult>;
}

export type AiErrorCode =
  | "AI_TIMEOUT"
  | "AI_RATE_LIMITED"
  | "AI_UNAVAILABLE"
  | "AI_REFUSED"
  | "AI_INVALID_OUTPUT"
  | "AI_BAD_REQUEST"
  | "AI_BUDGET_EXCEEDED"
  | "AI_OUTPUT_UNSAFE";

const RETRYABLE: Record<AiErrorCode, boolean> = {
  AI_TIMEOUT: true,
  AI_RATE_LIMITED: true,
  AI_UNAVAILABLE: true,
  AI_REFUSED: false,
  AI_INVALID_OUTPUT: true,
  AI_BAD_REQUEST: false,
  AI_BUDGET_EXCEEDED: true,
  AI_OUTPUT_UNSAFE: true,
};

export class AiError extends Error {
  readonly retryable: boolean;
  constructor(readonly code: AiErrorCode, message: string, readonly usage: Usage = {}, readonly retryAfterSec?: number) {
    super(message);
    this.retryable = RETRYABLE[code];
  }
}
