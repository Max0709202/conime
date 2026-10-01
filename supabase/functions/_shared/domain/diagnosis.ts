// Server-side validation of diagnosis answers against the versioned question master
// (Q-1 limits). The client's own checks are not trusted.
import type { FieldError } from "../http/validate.ts";
import { cleanUserText } from "./normalize.ts";

export interface MasterQuestion {
  id: string;
  code: string;
  answer_type: "single_choice" | "multi_choice" | "free_text_fields" | "free_text_multi";
  required: boolean;
  min_selections: number | null;
  max_selections: number | null;
  field_count: number | null;
  min_items: number | null;
  max_items: number | null;
  max_chars: number | null;
  option_ids: string[];
}

export interface SubmittedAnswer {
  question_id: string;
  option_ids?: string[];
  texts?: string[];
  purposes?: string[];
}

export interface CleanAnswer {
  question_id: string;
  option_ids: string[];
  texts: string[];
}

/** Returns cleaned answers (texts normalized, empty fields kept positionally as "") or field errors. */
export function validateDiagnosisAnswers(
  questions: MasterQuestion[],
  answers: SubmittedAnswer[],
): { answers: CleanAnswer[]; errors: FieldError[] } {
  const errors: FieldError[] = [];
  const byId = new Map(questions.map((q) => [q.id.toLowerCase(), q]));
  const seen = new Set<string>();
  const clean: CleanAnswer[] = [];

  answers.forEach((a, i) => {
    const path = `/answers/${i}`;
    const q = byId.get(a.question_id.toLowerCase());
    if (!q) {
      errors.push({ path: `${path}/question_id`, rule: "question", message: "unknown question for this question set" });
      return;
    }
    if (seen.has(q.id)) {
      errors.push({ path, rule: "unique", message: `question ${q.code} answered more than once` });
      return;
    }
    seen.add(q.id);
    const optionIds = (a.option_ids ?? []).map((o) => o.toLowerCase());
    const texts = (a.texts ?? []).map((t) => cleanUserText(t));

    if (q.answer_type === "single_choice" || q.answer_type === "multi_choice") {
      if (texts.some((t) => t.length > 0)) {
        errors.push({ path: `${path}/texts`, rule: "type", message: `${q.code} accepts options only` });
      }
      const allowed = new Set(q.option_ids.map((o) => o.toLowerCase()));
      optionIds.forEach((o, j) => {
        if (!allowed.has(o)) errors.push({ path: `${path}/option_ids/${j}`, rule: "option", message: "unknown option" });
      });
      if (new Set(optionIds).size !== optionIds.length) {
        errors.push({ path: `${path}/option_ids`, rule: "unique", message: "duplicate option" });
      }
      const min = q.min_selections ?? 1;
      const max = q.max_selections ?? 1;
      if (optionIds.length > max) {
        errors.push({ path: `${path}/option_ids`, rule: "maxItems", message: `${q.code} allows at most ${max} selections` });
      }
      if (optionIds.length < min && (q.required || optionIds.length > 0)) {
        errors.push({ path: `${path}/option_ids`, rule: "minItems", message: `${q.code} needs at least ${min} selections` });
      }
      clean.push({ question_id: q.id, option_ids: optionIds, texts: [] });
      return;
    }

    if (optionIds.length > 0) {
      errors.push({ path: `${path}/option_ids`, rule: "type", message: `${q.code} accepts text only` });
    }
    const maxChars = q.max_chars ?? 200;
    texts.forEach((t, j) => {
      if ([...t].length > maxChars) {
        errors.push({ path: `${path}/texts/${j}`, rule: "maxLength", message: `max ${maxChars} characters` });
      }
    });
    const filled = texts.filter((t) => t.length > 0).length;
    const limit = q.answer_type === "free_text_fields" ? (q.field_count ?? 1) : (q.max_items ?? 1);
    if (texts.length > limit) {
      errors.push({ path: `${path}/texts`, rule: "maxItems", message: `${q.code} allows at most ${limit} entries` });
    }
    const minItems = q.min_items ?? 1;
    if (q.required && filled < minItems) {
      errors.push({ path: `${path}/texts`, rule: "minItems", message: `${q.code} needs at least ${minItems} entries` });
    }
    clean.push({ question_id: q.id, option_ids: [], texts });
  });

  for (const q of questions) {
    if (q.required && !seen.has(q.id)) {
      errors.push({ path: "/answers", rule: "required", message: `missing required question ${q.code}` });
    }
  }
  return { answers: clean, errors };
}
