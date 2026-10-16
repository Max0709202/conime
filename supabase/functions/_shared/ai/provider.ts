import { env } from "../env.ts";
import { MockProvider } from "./mock_provider.ts";

// 生成 AI の抽象化（基盤02）。第1段階は MockProvider。提供元が決まったら（U-04）実装を追加し AI_PROVIDER で切り替える。
// API キーはサーバー側（Edge Functions の Secrets）のみで保持し、アプリには渡さない（設計02-A）

export interface SelectedOption {
  code: string;
  label: string;
  attributes: Record<string, unknown>;
}

// 生成の入力：回答（加工しない）と、選択肢のキャラ要素。メールアドレス等の識別情報は含めない（引継01）
export interface DiagnosisAnswerInput {
  code: string;
  title: string;
  answer_type: string;
  usages: string[];
  option_codes: string[];
  texts: string[];
  selected: SelectedOption[];
}

export interface GeneratedProfile {
  personality: string;
  strengths: string[];
  weaknesses: string[];
  profile_items: { key: string; label: string; values: string[] }[];
  ai_comments: string[];
}

export interface GeneratedCharacter {
  species: string;
  class: string;
  attribute: string;
  rarity: string;
  title: string;
  status_items: Record<string, unknown>;
}

export interface DiagnosisGeneration {
  profile: GeneratedProfile;
  character: GeneratedCharacter;
  provider: string;
}

export interface GenerateOptions {
  // dev のみ（X-Mock-Scenario）。generation_failed / generation_slow
  mockScenario?: string;
}

export class AiError extends Error {
  constructor(readonly code: string, message?: string, readonly retryable = true) {
    super(message ?? code);
  }
}

export interface AiProvider {
  readonly name: string;
  generateDiagnosis(answers: DiagnosisAnswerInput[], options?: GenerateOptions): Promise<DiagnosisGeneration>;
  // 現在のキャラ画像（PNG）。stage = 進化段階（0 = 初期、5 = Lv.5 …）
  renderCharacterImage(answers: DiagnosisAnswerInput[], stage: number): Promise<Uint8Array>;
}

export function getAiProvider(): AiProvider {
  switch (env.aiProvider) {
    case "mock":
      return new MockProvider();
    default:
      throw new Error(`unknown AI_PROVIDER: ${env.aiProvider}`);
  }
}
