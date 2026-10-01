// Stage 1: free-text normalization into controlled master IDs (概要8 リストID).
// Exact alias match first; AI only for unresolved values, restricted to supplied
// candidate IDs. Any ID not in an item's candidate list is rejected.
import type { Db } from "../db/pool.ts";
import type { AiRunner } from "../ai/runner.ts";
import { sha256Hex } from "../ai/runner.ts";
import { normalizeAlias, splitMultiValue } from "../domain/normalize.ts";
import type { ContextAnswer } from "../domain/character.ts";

export interface Feature {
  question_code: string;
  feature_kind: "work" | "character" | "genre" | "world_setting" | "option" | "unresolved";
  match_key: string;
  work_id?: string;
  character_id?: string;
  tag_id?: string;
  option_id?: string;
  resolution: "option" | "alias_exact" | "ai" | "unresolved";
  confidence?: number;
}

export interface NormalizationStats {
  options: number;
  alias: number;
  ai: number;
  unresolved: number;
  rejected_ids: number;
}

type Target = "anime_work" | "anime_character" | "genre" | "world_setting";

interface TextItem {
  item_id: string;
  question_code: string;
  target: Target;
  text: string;
  normalized: string;
}

const KIND: Record<Target, { feature: Feature["feature_kind"]; prefix: string; col: "work_id" | "character_id" | "tag_id" }> = {
  anime_work: { feature: "work", prefix: "work", col: "work_id" },
  anime_character: { feature: "character", prefix: "char", col: "character_id" },
  genre: { feature: "genre", prefix: "tag", col: "tag_id" },
  world_setting: { feature: "world_setting", prefix: "tag", col: "tag_id" },
};

function resolvedFeature(item: TextItem, id: string, resolution: Feature["resolution"], confidence: number): Feature {
  const k = KIND[item.target];
  return { question_code: item.question_code, feature_kind: k.feature, match_key: `${k.prefix}:${id}`, [k.col]: id, resolution, confidence };
}

/** Builds the text items to normalize: one per field, or one per comma/slash-separated value for 複数可. */
export function extractTextItems(answers: ContextAnswer[]): TextItem[] {
  const items: TextItem[] = [];
  for (const a of answers) {
    if (!a.normalization_target) continue;
    const texts = a.values.map((v) => v.text).filter((t): t is string => typeof t === "string" && t.length > 0);
    const values = a.answer_type === "free_text_multi" ? texts.flatMap(splitMultiValue) : texts;
    values.slice(0, 10).forEach((text, i) => {
      const normalized = normalizeAlias(text);
      if (normalized.length > 0) {
        items.push({ item_id: `${a.question_code}-${i}`, question_code: a.question_code, target: a.normalization_target as Target, text, normalized });
      }
    });
  }
  return items;
}

export async function normalizeAnswers(
  db: Db,
  ai: AiRunner,
  answers: ContextAnswer[],
  run: { jobId: string; userId: string; retryCount: number },
): Promise<{ features: Feature[]; stats: NormalizationStats }> {
  const features: Feature[] = [];
  const stats: NormalizationStats = { options: 0, alias: 0, ai: 0, unresolved: 0, rejected_ids: 0 };
  const unresolvedItems: TextItem[] = [];

  // Selected options become exact-match keys directly.
  for (const a of answers) {
    for (const v of a.values) {
      if (v.option_id && v.option_code) {
        features.push({ question_code: a.question_code, feature_kind: "option", match_key: `opt:${a.question_code}:${v.option_code}`, option_id: v.option_id, resolution: "option" });
        stats.options++;
      }
    }
  }

  // 1) exact alias match against the local master database
  const items = extractTextItems(answers);
  const needsAi: TextItem[] = [];
  for (const target of Object.keys(KIND) as Target[]) {
    const group = items.filter((i) => i.target === target);
    if (!group.length) continue;
    const map = await db.callService<Record<string, string[]>>(null, "svc_alias_lookup", [target, group.map((g) => g.normalized)]);
    for (const it of group) {
      const ids = map[it.normalized] ?? [];
      if (ids.length === 1) {
        features.push(resolvedFeature(it, ids[0], "alias_exact", 1));
        stats.alias++;
      } else {
        needsAi.push(it); // no alias, or an ambiguous alias shared by several entries
      }
    }
  }

  // 2) AI only for unresolved values that have prefiltered candidates
  const cfg = await ai.config();
  const limit = Number(ai.setting(cfg, "ai.normalization.candidate_limit", 15));
  const minSim = Number(ai.setting(cfg, "ai.normalization.min_similarity", 0.15));
  const withCandidates: Array<{ item: TextItem; candidates: Array<{ id: string; name: string; similarity: number }> }> = [];
  for (const it of needsAi) {
    const candidates = await db.callService<Array<{ id: string; name: string; similarity: number }>>(
      null, "svc_text_candidates", [it.target, it.normalized, limit, minSim]);
    if (candidates.length) withCandidates.push({ item: it, candidates });
    else unresolvedItems.push(it);
  }

  if (withCandidates.length) {
    const { output } = await ai.json<{ results: Array<{ item_id: string; matched_id: string | null; confidence: number }> }>(
      { jobId: run.jobId, userId: run.userId, retryCount: run.retryCount },
      "normalize",
      {
        kinds: { anime_work: "anime/manga work", anime_character: "anime character", genre: "genre", world_setting: "world setting" },
        items: withCandidates.map(({ item, candidates }) => ({ item_id: item.item_id, kind: item.target, text: item.text, candidates })),
      },
    );
    const byItem = new Map(output.results.map((r) => [r.item_id, r]));
    for (const { item, candidates } of withCandidates) {
      const r = byItem.get(item.item_id);
      const allowed = new Set(candidates.map((c) => c.id));
      if (r?.matched_id && allowed.has(r.matched_id)) {
        features.push(resolvedFeature(item, r.matched_id, "ai", Math.max(0, Math.min(1, Number(r.confidence) || 0))));
        stats.ai++;
      } else {
        if (r?.matched_id) stats.rejected_ids++; // invented or out-of-candidate ID: rejected
        unresolvedItems.push(item);
      }
    }
  }

  // Unresolved values are kept (for profile display) but never matched.
  for (const it of unresolvedItems) {
    features.push({
      question_code: it.question_code, feature_kind: "unresolved",
      match_key: `raw:${(await sha256Hex(it.normalized)).slice(0, 24)}`, resolution: "unresolved",
    });
    stats.unresolved++;
  }
  return { features, stats };
}
