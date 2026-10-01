import { assert, assertEquals, assertFalse } from "@std/assert";
import { cleanUserText, normalizeAlias, normalizeName, splitMultiValue } from "../../supabase/functions/_shared/domain/normalize.ts";
import { type MasterQuestion, validateDiagnosisAnswers } from "../../supabase/functions/_shared/domain/diagnosis.ts";
import { mimeMatches, sniffImageMime } from "../../supabase/functions/_shared/domain/image.ts";
import {
  buildImagePrompt, deriveElement, deriveRarity, deriveStats, deriveVisualElements, findForbiddenNames,
} from "../../supabase/functions/_shared/domain/character.ts";
import { crossedEvolutionStage, cumulativeExpForLevel, levelForExp, stageForLevel } from "../../supabase/functions/_shared/domain/growth.ts";
import { extractTextItems } from "../../supabase/functions/_shared/worker/normalize-answers.ts";

Deno.test("normalizeAlias folds width, case, kana and punctuation", () => {
  assertEquals(normalizeAlias("ホシクズ・ノ アルカディア！"), normalizeAlias("ほしくずのあるかでぃあ"));
  assertEquals(normalizeAlias("ＡＢＣ　ｄｅｆ"), "abcdef");
  assertEquals(normalizeAlias("星屑のアルカディア"), "星屑のあるかでぃあ");
  assertEquals(normalizeAlias("スーパー"), "すーぱー"); // long vowel mark kept
  assertEquals(normalizeAlias("「」！？…"), "");
});

Deno.test("cleanUserText keeps content as entered, normalizeName folds look-alikes", () => {
  assertEquals(cleanUserText("  元気？\u0007\r\n  ｶﾀｶﾅ  "), "元気？\n  ｶﾀｶﾅ");
  assertEquals(normalizeName("  ﾙﾐﾅ　 さん "), "ルミナ さん");
});

Deno.test("splitMultiValue splits Japanese and ASCII separators", () => {
  assertEquals(splitMultiValue("作品A、作品B／作品C, 作品D\n作品E"), ["作品A", "作品B", "作品C", "作品D", "作品E"]);
  assertEquals(splitMultiValue(" 、 "), []);
});

const Q = (over: Partial<MasterQuestion>): MasterQuestion => ({
  id: crypto.randomUUID(), code: "Q1", answer_type: "free_text_fields", required: true, min_selections: null, max_selections: null,
  field_count: 3, min_items: 1, max_items: null, max_chars: 50, option_ids: [], ...over,
});

Deno.test("diagnosis validation: free text fields limits", () => {
  const q = Q({});
  assertEquals(validateDiagnosisAnswers([q], [{ question_id: q.id, texts: ["a", "", "c"] }]).errors, []);
  const tooMany = validateDiagnosisAnswers([q], [{ question_id: q.id, texts: ["a", "b", "c", "d"] }]);
  assertEquals(tooMany.errors[0].rule, "maxItems");
  const tooLong = validateDiagnosisAnswers([q], [{ question_id: q.id, texts: ["あ".repeat(51)] }]);
  assertEquals(tooLong.errors[0].rule, "maxLength");
  const empty = validateDiagnosisAnswers([q], [{ question_id: q.id, texts: ["", ""] }]);
  assertEquals(empty.errors[0].rule, "minItems");
});

Deno.test("diagnosis validation: choices", () => {
  const opts = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const single = Q({ code: "Q6", answer_type: "single_choice", min_selections: 1, max_selections: 1, option_ids: opts });
  const multi = Q({ code: "Q9", answer_type: "multi_choice", min_selections: 1, max_selections: 3, option_ids: opts });
  assertEquals(validateDiagnosisAnswers([single, multi], [{ question_id: single.id, option_ids: [opts[0]] }, { question_id: multi.id, option_ids: opts.slice(0, 3) }]).errors, []);
  const r1 = validateDiagnosisAnswers([single], [{ question_id: single.id, option_ids: [opts[0], opts[1]] }]);
  assertEquals(r1.errors[0].rule, "maxItems");
  const r2 = validateDiagnosisAnswers([multi], [{ question_id: multi.id, option_ids: opts }]);
  assertEquals(r2.errors[0].rule, "maxItems");
  const r3 = validateDiagnosisAnswers([single], [{ question_id: single.id, option_ids: [crypto.randomUUID()] }]);
  assertEquals(r3.errors[0].rule, "option");
  const r4 = validateDiagnosisAnswers([single], [{ question_id: single.id, option_ids: [opts[0]], texts: ["free"] }]);
  assertEquals(r4.errors[0].rule, "type");
});

Deno.test("diagnosis validation: unknown, duplicate and missing questions", () => {
  const q1 = Q({});
  const q2 = Q({ code: "Q2", required: false });
  const r = validateDiagnosisAnswers([q1, q2], [{ question_id: crypto.randomUUID(), texts: ["x"] }, { question_id: q2.id, texts: ["x"] }, { question_id: q2.id, texts: ["y"] }]);
  const rules = r.errors.map((e) => e.rule).sort();
  assertEquals(rules, ["question", "required", "unique"]);
});

Deno.test("image signature sniffing", () => {
  assertEquals(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assertEquals(sniffImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
  assertEquals(sniffImageMime(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
  assertEquals(sniffImageMime(new Uint8Array([0, 0, 0, 24, ...new TextEncoder().encode("ftypheic")])), "image/heic");
  assertEquals(sniffImageMime(new TextEncoder().encode("%PDF-1.7")), null);
  assert(mimeMatches("image/png", "image/png"));
  assertFalse(mimeMatches("image/png", "image/jpeg"));
  assertFalse(mimeMatches("image/png", null));
});

const answers = [
  { question_code: "Q13", label: "休日", purposes: [], normalization_target: null, values: [{ option_code: "A", attributes: { theme_color: "赤" } }] },
  { question_code: "Q14", label: "許せない", purposes: [], normalization_target: null, values: [{ option_code: "C", attributes: { effect: "光" } }] },
  { question_code: "Q18", label: "役割", purposes: [], normalization_target: null, values: [{ option_code: "B", attributes: { form: "リアル調高め", suppress_effect: true } }] },
  { question_code: "Q19", label: "種族", purposes: [], normalization_target: null, values: [{ option_code: "D", attributes: { species_gender: "人間・女性" } }] },
];

Deno.test("visual elements follow 概要7, including effect suppression for Q18 B/C", () => {
  const ve = deriveVisualElements(answers);
  assertEquals(ve.theme_color, "赤");
  assertEquals(ve.effect, null);
  assertEquals(ve.form, "リアル調高め");
  assertEquals(deriveElement(ve), "炎"); // from theme colour when the effect is suppressed
  const ve2 = deriveVisualElements(answers.slice(0, 2));
  assertEquals(deriveElement(ve2), "光");
});

Deno.test("rarity and stats are deterministic per seed", async () => {
  assertEquals(await deriveRarity("user-1"), await deriveRarity("user-1"));
  const s1 = await deriveStats("user-1", deriveVisualElements(answers));
  assertEquals(s1, await deriveStats("user-1", deriveVisualElements(answers)));
  for (const v of Object.values(s1)) assert(v >= 40 && v <= 90);
  const counts: Record<string, number> = {};
  for (let i = 0; i < 2000; i++) counts[await deriveRarity(`u${i}`)] = (counts[await deriveRarity(`u${i}`)] ?? 0) + 1;
  assert(counts.N > counts.R && counts.R > counts.SR && counts.SR > counts.SSR, JSON.stringify(counts));
});

Deno.test("image prompt is English, original-only and stage aware", () => {
  const p = buildImagePrompt("TEMPLATE no logos.", deriveVisualElements(answers), "Hooded coat", 25);
  assert(p.startsWith("TEMPLATE"));
  assert(p.includes("human woman") && p.includes("Theme color: red") && p.includes("seasoned"));
  assertFalse(p.includes("Effect:"));
});

Deno.test("forbidden name detection uses normalized substring match", () => {
  assertEquals(findForbiddenNames("A hero like ホシクズノアルカディア in space", ["星屑のアルカディア", "ほしくずのあるかでぃあ"]), ["ほしくずのあるかでぃあ"]);
  assertEquals(findForbiddenNames("Original adventurer", ["星屑のアルカディア", "ab"]), []);
});

Deno.test("growth level-v1 math and evolution boundaries (G-03, G-04)", () => {
  assertEquals(cumulativeExpForLevel(1), 0);
  assertEquals(cumulativeExpForLevel(5), 280);
  assertEquals(cumulativeExpForLevel(100), 53955);
  assertEquals(levelForExp(279), 4);
  assertEquals(levelForExp(280), 5);
  assertEquals(levelForExp(10_000_000), 100);
  assertEquals(stageForLevel(4), 1);
  assertEquals(stageForLevel(9), 5);
  assertEquals(crossedEvolutionStage(4, 5), 5);
  assertEquals(crossedEvolutionStage(5, 9), null);
  assertEquals(crossedEvolutionStage(4, 28), 25); // multiple boundaries → final stage only
  assertEquals(crossedEvolutionStage(99, 100), 100);
});

Deno.test("text items: 複数可 answers are split, fields are not", () => {
  const items = extractTextItems([
    { question_code: "Q1", answer_type: "free_text_fields", label: "", purposes: [], normalization_target: "anime_work", values: [{ text: "作品A、作品B" }] },
    { question_code: "Q7", answer_type: "free_text_multi", label: "", purposes: [], normalization_target: "anime_work", values: [{ text: "作品A、作品B" }] },
    { question_code: "Q2", answer_type: "free_text_fields", label: "", purposes: [], normalization_target: null, values: [{ text: "場面" }] },
  ]);
  assertEquals(items.map((i) => `${i.question_code}:${i.text}`), ["Q1:作品A、作品B", "Q7:作品A", "Q7:作品B"]);
});
