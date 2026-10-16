// deno-lint-ignore-file no-explicit-any
import { createSignedUrl, CHARACTER_BUCKET } from "../../_shared/storage.ts";
import { iso } from "../context.ts";

// characters 行 → 応答形式（API08）
type Row = Record<string, any>;

const CORE_KEYS = new Set(["personality", "strengths", "weaknesses", "skills"]);

export async function characterImage(ch: Row | undefined, fallback: "none" | "generating" | "failed" = "none") {
  if (!ch) return { status: fallback, url: null, expires_at: null, stage: 0 };
  // 生成に失敗しても既存画像があれば表示できる（非機能・設計04）
  const signed = ch.image_path ? await createSignedUrl(CHARACTER_BUCKET, ch.image_path) : null;
  return {
    status: ch.image_status,
    url: signed?.url ?? null,
    expires_at: signed?.expires_at ?? null,
    stage: ch.image_stage,
  };
}

export function characterSummary(ch: Row, profile?: Row) {
  const items = (ch.status_items ?? {}) as Row;
  return {
    public_code: ch.public_code,
    name: ch.name,
    level: ch.level,
    species: ch.species,
    class: ch.class,
    attribute: ch.attribute,
    rarity: ch.rarity,
    title: ch.title,
    personality: items.personality ?? profile?.personality ?? null,
    strengths: items.strengths ?? profile?.strengths ?? [],
    weaknesses: items.weaknesses ?? profile?.weaknesses ?? [],
    skills: items.skills ?? [],
    // 表示項目の追加用（未知のキーはアプリが無視する）
    extra: Object.fromEntries(Object.entries(items).filter(([k]) => !CORE_KEYS.has(k))),
  };
}

export async function characterDetail(ch: Row, maxLevel: number) {
  const s = characterSummary(ch);
  return {
    public_code: s.public_code,
    name: s.name,
    species: s.species,
    class: s.class,
    attribute: s.attribute,
    rarity: s.rarity,
    title: s.title,
    level: ch.level,
    max_level: maxLevel,
    exp_total: ch.exp_total,
    goodto_points: ch.goodto_points,
    personality: s.personality,
    strengths: s.strengths,
    weaknesses: s.weaknesses,
    skills: s.skills,
    status_items: ch.status_items ?? {},
    image: await characterImage(ch),
    created_at: iso(ch.created_at),
  };
}

export function submissionStatus(s: Row, pollAfterSeconds: number) {
  const inProgress = s.status === "received" || s.status === "processing";
  return {
    submission_id: s.submission_id ?? s.id,
    status: s.status,
    submitted_at: iso(s.submitted_at),
    completed_at: iso(s.completed_at),
    error_code: s.error_code ?? null,
    poll_after_seconds: inProgress ? pollAfterSeconds : null,
    retryable: s.status === "failed",
  };
}
