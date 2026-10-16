import type { ErrorDetail } from "./errors.ts";

// 診断回答の入力検証（設計書 API07）。質問定義はサーバーの定義を正とする
export interface QuestionDefinition {
  id: string;
  code: string;
  answer_type: "single_choice" | "multi_choice" | "free_fields" | "free_multi";
  is_required: boolean;
  constraints: {
    min_select?: number;
    max_select?: number;
    field_count?: number;
    required_field_count?: number;
    max_length?: number;
  };
  option_codes: string[];
}

export interface AnswerInput {
  question_code: string;
  option_codes?: string[];
  texts?: string[];
}

export interface NormalizedAnswer {
  question_id: string;
  option_codes: string[];
  texts: string[];
}

// 文字数は Unicode のコードポイント数で数える
export const charLength = (s: string) => [...s].length;
const isBlank = (s: string) => s.trim().length === 0;

export function validateAnswers(
  questions: QuestionDefinition[],
  answers: AnswerInput[],
): { errors: ErrorDetail[]; normalized: NormalizedAnswer[] } {
  const errors: ErrorDetail[] = [];
  const normalized: NormalizedAnswer[] = [];
  const byCode = new Map(questions.map((q) => [q.code, q]));
  const seen = new Set<string>();

  answers.forEach((a, i) => {
    const field = `answers[${i}]`;
    const q = byCode.get(a.question_code);
    if (!q) {
      errors.push({ field: `${field}.question_code`, reason: "unknown_question", value: a.question_code });
      return;
    }
    if (seen.has(q.code)) {
      errors.push({ field: `${field}.question_code`, reason: "duplicate_question", value: q.code });
      return;
    }
    seen.add(q.code);

    const optionCodes = a.option_codes ?? [];
    const texts = a.texts ?? [];
    const before = errors.length;

    switch (q.answer_type) {
      case "single_choice": {
        if (texts.length > 0) errors.push({ field: `${field}.texts`, reason: "not_allowed" });
        if (optionCodes.length !== 1) {
          errors.push({ field: `${field}.option_codes`, reason: "exactly_one", count: optionCodes.length });
        } else if (!q.option_codes.includes(optionCodes[0])) {
          errors.push({ field: `${field}.option_codes[0]`, reason: "unknown_option", value: optionCodes[0] });
        }
        break;
      }
      case "multi_choice": {
        if (texts.length > 0) errors.push({ field: `${field}.texts`, reason: "not_allowed" });
        const min = q.constraints.min_select ?? (q.is_required ? 1 : 0);
        const max = q.constraints.max_select ?? q.option_codes.length;
        if (optionCodes.length < min) errors.push({ field: `${field}.option_codes`, reason: "min_select", limit: min });
        if (optionCodes.length > max) errors.push({ field: `${field}.option_codes`, reason: "max_select", limit: max });
        if (new Set(optionCodes).size !== optionCodes.length) {
          errors.push({ field: `${field}.option_codes`, reason: "duplicate_option" });
        }
        optionCodes.forEach((code, j) => {
          if (!q.option_codes.includes(code)) {
            errors.push({ field: `${field}.option_codes[${j}]`, reason: "unknown_option", value: code });
          }
        });
        break;
      }
      case "free_fields": {
        if (optionCodes.length > 0) errors.push({ field: `${field}.option_codes`, reason: "not_allowed" });
        const count = q.constraints.field_count ?? 1;
        const required = q.is_required ? (q.constraints.required_field_count ?? count) : 0;
        if (texts.length !== count) {
          errors.push({ field: `${field}.texts`, reason: "field_count", limit: count, count: texts.length });
        }
        texts.forEach((t, j) => {
          if (j < required && isBlank(t)) errors.push({ field: `${field}.texts[${j}]`, reason: "required" });
          checkLength(errors, `${field}.texts[${j}]`, t, q.constraints.max_length);
        });
        break;
      }
      case "free_multi": {
        if (optionCodes.length > 0) errors.push({ field: `${field}.option_codes`, reason: "not_allowed" });
        if (texts.length !== 1) {
          errors.push({ field: `${field}.texts`, reason: "field_count", limit: 1, count: texts.length });
        } else {
          if (q.is_required && isBlank(texts[0])) errors.push({ field: `${field}.texts[0]`, reason: "required" });
          checkLength(errors, `${field}.texts[0]`, texts[0], q.constraints.max_length);
        }
        break;
      }
    }

    if (errors.length === before) {
      normalized.push({ question_id: q.id, option_codes: optionCodes, texts });
    }
  });

  for (const q of questions) {
    if (q.is_required && !seen.has(q.code)) {
      errors.push({ field: "answers", reason: "required_question_missing", question_code: q.code });
    }
  }
  return { errors, normalized };
}

function checkLength(errors: ErrorDetail[], field: string, text: string, max: number | undefined) {
  if (max !== undefined && charLength(text) > max) errors.push({ field, reason: "max_length", limit: max });
}
