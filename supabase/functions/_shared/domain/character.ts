// Deterministic character elements (概要7) and the original-character image prompt.
// AI writes only free text; elements, rarity and stats are derived here so they are
// reproducible and cannot be manipulated through prompt content.
import { normalizeAlias } from "./normalize.ts";

export interface AnswerValue {
  option_id?: string;
  option_code?: string;
  label?: string;
  attributes?: Record<string, unknown>;
  text?: string;
}

export interface ContextAnswer {
  question_code: string;
  answer_type?: string;
  label: string;
  purposes: string[];
  normalization_target: string | null;
  values: AnswerValue[];
}

export interface VisualElements {
  theme_color: string | null;
  effect: string | null;
  mood: string | null;
  expression: string | null;
  art_style: string | null;
  form: string | null;
  species_gender: string | null;
  look: string | null;
}

const ELEMENT_KEYS: (keyof VisualElements)[] = [
  "theme_color", "effect", "mood", "expression", "art_style", "form", "species_gender", "look",
];

export function deriveVisualElements(answers: ContextAnswer[]): VisualElements {
  const ve = Object.fromEntries(ELEMENT_KEYS.map((k) => [k, null])) as unknown as VisualElements;
  let suppressEffect = false;
  for (const a of answers) {
    for (const v of a.values) {
      const attrs = v.attributes ?? {};
      for (const k of ELEMENT_KEYS) {
        if (typeof attrs[k] === "string") ve[k] = attrs[k] as string;
      }
      if (attrs.suppress_effect === true) suppressEffect = true;
    }
  }
  if (suppressEffect) ve.effect = null; // 概要7: Q18 B/C → no effect
  return ve;
}

const COLOR_TO_ELEMENT: Record<string, string> = { 赤: "炎", 青: "氷", 黄: "光", 黒: "闇", 緑: "風", 白: "光" };

/** 属性: the effect element, or the element implied by the theme colour when the effect is suppressed. */
export function deriveElement(ve: VisualElements): string | null {
  return ve.effect ?? (ve.theme_color ? COLOR_TO_ELEMENT[ve.theme_color] ?? null : null);
}

async function seedBytes(seed: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed)));
}

export const DEFAULT_RARITY_WEIGHTS: Record<string, number> = { N: 50, R: 30, SR: 15, SSR: 5 };

export async function deriveRarity(seed: string, weights: Record<string, number> = DEFAULT_RARITY_WEIGHTS): Promise<string> {
  const b = await seedBytes(`rarity:${seed}`);
  const roll = ((b[0] << 8) | b[1]) / 65536;
  const total = Object.values(weights).reduce((s, w) => s + w, 0);
  let acc = 0;
  for (const [rarity, w] of Object.entries(weights)) {
    acc += w / total;
    if (roll < acc) return rarity;
  }
  return Object.keys(weights).at(-1)!;
}

const FORM_BONUS: Record<string, Partial<Record<string, number>>> = {
  頭身高めバトル: { attack: 10, speed: 5 },
  リアル調高め: { defense: 5, intelligence: 5 },
  リアル調低め: { speed: 5, luck: 5 },
  SDマスコット: { luck: 10, hp: 5 },
  パーツ強化: { defense: 10, attack: 5 },
  ファンタジー調: { intelligence: 10, hp: 5 },
};

export async function deriveStats(seed: string, ve: VisualElements): Promise<Record<string, number>> {
  const b = await seedBytes(`stats:${seed}`);
  const keys = ["hp", "attack", "defense", "speed", "intelligence", "luck"];
  const bonus = (ve.form && FORM_BONUS[ve.form]) || {};
  return Object.fromEntries(keys.map((k, i) => [k, 40 + (b[i] % 41) + (bonus[k] ?? 0)]));
}

// ---------------------------------------------------------------------------
// Image prompt
// ---------------------------------------------------------------------------
const EN: Record<string, string> = {
  赤: "red", 青: "blue", 黄: "yellow", 黒: "black", 緑: "green", 白: "white",
  炎: "flames", 氷: "ice crystals", 光: "radiant light", 闇: "dark shadow aura", 風: "swirling wind", 雷: "lightning",
  バトル寄り: "battle-ready", シンプル: "simple and clean", さわやか: "fresh and bright", 厨二病的: "dramatic and edgy",
  華やか: "glamorous", ゴテゴテ: "highly ornate",
  柔和: "gentle smile", 熱血: "fiery determined look", クール: "cool composed look", キュート: "cute cheerful look",
  無表情: "calm expressionless face", 冷酷: "cold stern look",
  現代アニメ: "modern anime cel-shaded", "フィギュア・ドール": "figure-like 3D render", カジュアル: "casual soft illustration",
  "フォーマル・シネマティック": "formal cinematic lighting", 近未来SF: "near-future sci-fi", 和モダン: "modern Japanese wa style",
  頭身高めバトル: "tall heroic proportions in a dynamic pose", リアル調高め: "realistic tall proportions",
  リアル調低め: "realistic petite proportions", SDマスコット: "super-deformed chibi mascot proportions",
  パーツ強化: "enhanced armor parts", ファンタジー調: "fantasy styling",
  モンスター: "friendly monster creature", ロボット: "robot", "人間・男性": "human man", "人間・女性": "human woman",
  性別なし: "androgynous being", "動物・マスコット": "animal mascot",
  かわいい: "cute", かっこいい: "cool", 美しい: "beautiful", ダーク: "dark", 人外: "otherworldly non-human", 個性派: "quirky and unique",
};

const en = (v: string | null) => (v ? EN[v] ?? null : null);

export function evolutionFlavor(stage: number): string {
  if (stage <= 1) return "a starting adventurer with simple gear";
  if (stage < 25) return "an apprentice with a slightly upgraded outfit";
  if (stage < 50) return "a seasoned adventurer with detailed gear and a subtle aura";
  if (stage < 75) return "an elite hero with ornate gear and a strong aura";
  if (stage < 100) return "a legendary hero with majestic gear and a radiant aura";
  return "a mythic final form with an awe-inspiring aura";
}

export function buildImagePrompt(template: string, ve: VisualElements, visualDescription: string, stage: number): string {
  const parts = [
    en(ve.species_gender) && `Subject: ${en(ve.species_gender)}`,
    en(ve.look) && `Impression: ${en(ve.look)}`,
    en(ve.theme_color) && `Theme color: ${en(ve.theme_color)}`,
    en(ve.effect) && `Effect: ${en(ve.effect)}`,
    en(ve.mood) && `Mood: ${en(ve.mood)}`,
    en(ve.expression) && `Expression: ${en(ve.expression)}`,
    en(ve.art_style) && `Art style: ${en(ve.art_style)}`,
    en(ve.form) && `Body form: ${en(ve.form)}`,
    `Growth stage: ${evolutionFlavor(stage)}`,
    `Appearance: ${visualDescription.slice(0, 600)}`,
  ].filter(Boolean);
  return `${template.trim()}\n${parts.join(". ")}.`;
}

/**
 * Detects names of existing works/characters (or the user's raw answers) inside text
 * meant for the image model. Comparison uses normalized forms; names shorter than
 * 3 normalized characters are ignored to avoid false positives.
 */
export function findForbiddenNames(text: string, names: string[]): string[] {
  const hay = normalizeAlias(text);
  const hits = new Set<string>();
  for (const n of names) {
    const k = normalizeAlias(n);
    if (k.length >= 3 && hay.includes(k)) hits.add(n);
  }
  return [...hits];
}
