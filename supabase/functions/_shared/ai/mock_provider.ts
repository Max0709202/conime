import { env } from "../env.ts";
import { sleep } from "../http.ts";
import { Canvas, hexToRgb, mix, type RGB } from "./png.ts";
import {
  AiError,
  type AiProvider,
  type DiagnosisAnswerInput,
  type DiagnosisGeneration,
  type GenerateOptions,
} from "./provider.ts";

// 第1段階の生成モック（API09）。回答から決定的にキャラ情報を作り（同じ回答なら同じ結果）、
// Q13（テーマカラー）・Q14（エフェクト）・Q18（フォルム）・Q19（種族・性別）・Q20（見た目）に応じたサンプル画像を描く。
// 約5秒後（MOCK_GENERATION_DELAY_SECONDS）に完了する

const PROFILE_KEYS: Record<string, [string, string]> = {
  Q1: ["favorite_works", "好きな作品"],
  Q2: ["favorite_reason", "作品が好きな理由"],
  Q3: ["favorite_characters", "好きなキャラクター"],
  Q4: ["character_reason", "キャラクターが好きな理由"],
  Q5: ["origin", "ハマったきっかけ"],
  Q6: ["frequency", "見る頻度"],
  Q7: ["watching", "最近見ている作品"],
  Q8: ["want_to_watch", "これから見たい作品"],
  Q9: ["enjoyment", "楽しみ方"],
  Q10: ["oshi_message", "推しへのひと言"],
  Q11: ["genre_world", "好きなジャンル・世界観"],
  Q12: ["ideal_character", "憧れのキャラクター"],
};

const MOODS: Record<string, { personality: string; strengths: string[]; weaknesses: string[] }> = {
  bright: { personality: "明るく前向きで、まわりを笑顔にするムードメーカー。", strengths: ["場を明るくする", "行動力がある"], weaknesses: ["うっかりしがち"] },
  cool: { personality: "冷静沈着で、いざというときに頼れるクールな実力派。", strengths: ["判断が速い", "集中力が高い"], weaknesses: ["本音を見せにくい"] },
  gentle: { personality: "やさしく包み込む、癒やし系のサポーター。", strengths: ["人の話をよく聞く", "思いやりがある"], weaknesses: ["断るのが苦手"] },
  mysterious: { personality: "どこか謎めいた、知的な探究者。", strengths: ["洞察力がある", "発想が独特"], weaknesses: ["マイペースすぎる"] },
  energetic: { personality: "元気いっぱいで、なんにでも全力なチャレンジャー。", strengths: ["あきらめない", "体力がある"], weaknesses: ["せっかち"] },
  calm: { personality: "落ち着いていて、仲間思いの守り手タイプ。", strengths: ["仲間を支える", "粘り強い"], weaknesses: ["考えすぎる"] },
};

const RARITIES = ["N", "R", "R", "SR", "SR", "SR", "SSR"];

export class MockProvider implements AiProvider {
  readonly name = "mock";

  async generateDiagnosis(answers: DiagnosisAnswerInput[], options: GenerateOptions = {}): Promise<DiagnosisGeneration> {
    if (options.mockScenario === "generation_failed") {
      throw new AiError("MOCK_GENERATION_FAILED", "generation_failed scenario");
    }
    const delay = options.mockScenario === "generation_slow" ? 60 : env.mockGenerationDelaySeconds;
    await sleep(delay * 1000);

    const seed = await seedBytes(answers);
    const attr = (code: string) => answers.find((a) => a.code === code)?.selected[0]?.attributes ?? {};
    const label = (code: string) => answers.find((a) => a.code === code)?.selected[0]?.label;

    const mood = String(attr("Q15").value ?? "calm");
    const moodText = MOODS[mood] ?? MOODS.calm;
    const suppressEffect = attr("Q18").suppress_effect === true; // Q18 が B・C ならエフェクトなし（API06）
    const species = String(attr("Q19").species ?? "ヒューマン");
    const klass = String(attr("Q15").class ?? "ガーディアン");
    const attribute = suppressEffect ? "無" : String(attr("Q14").attribute ?? "光");
    const rarity = RARITIES[seed[0] % RARITIES.length];
    const stat = (i: number) => 40 + (seed[i] % 50);

    const profileItems = answers
      .filter((a) => a.usages.includes("profile_display") && PROFILE_KEYS[a.code])
      .map((a) => {
        const values = a.selected.length > 0
          ? a.selected.map((o) => o.label)
          : a.texts.flatMap((t) => t.split(/[、,，\n]/)).map((t) => t.trim()).filter(Boolean);
        return { key: PROFILE_KEYS[a.code][0], label: PROFILE_KEYS[a.code][1], values };
      })
      .filter((item) => item.values.length > 0);

    const favorite = answers.find((a) => a.code === "Q1")?.texts.find((t) => t.trim()) ?? "アニメ";
    const skillName = attribute === "無" ? "まごころタックル" : `${attribute}の${klass === "ヒーラー" ? "いやし" : "一撃"}`;

    return {
      provider: this.name,
      profile: {
        personality: moodText.personality,
        strengths: moodText.strengths,
        weaknesses: moodText.weaknesses,
        profile_items: profileItems,
        ai_comments: [`「${favorite}」が好きなあなたにぴったりのキャラクターが誕生しました。`],
      },
      character: {
        species,
        class: klass,
        attribute,
        rarity,
        title: `はじまりの${klass}`,
        status_items: {
          personality: moodText.personality,
          strengths: moodText.strengths,
          weaknesses: moodText.weaknesses,
          skills: [{ name: skillName, description: `${label("Q15") ?? "まっすぐ"}な心で仲間を助ける` }],
          stats: { hp: stat(1), atk: stat(2), def: stat(3), spd: stat(4) },
          theme_color: String(attr("Q13").hex ?? "#8E4EC6"),
          effect: suppressEffect ? null : (attr("Q14").value ?? null),
          expression: attr("Q16").value ?? null,
          art_style: attr("Q17").value ?? null,
          form: attr("Q18").value ?? null,
          gender: attr("Q19").gender ?? null,
          appearance: attr("Q20").value ?? null,
        },
      },
    };
  }

  async renderCharacterImage(answers: DiagnosisAnswerInput[], stage: number): Promise<Uint8Array> {
    const attr = (code: string) => answers.find((a) => a.code === code)?.selected[0]?.attributes ?? {};
    const theme = hexToRgb(String(attr("Q13").hex ?? "#8E4EC6"));
    const form = String(attr("Q18").value ?? "humanoid");
    const species = String(attr("Q19").species ?? "ヒューマン");
    const appearance = String(attr("Q20").value ?? "young_adult");
    const effect = attr("Q18").suppress_effect === true ? null : String(attr("Q14").value ?? "light");

    const W = 512;
    const c = new Canvas(W, W);
    const white: RGB = [255, 255, 255];
    const dark: RGB = [34, 30, 58];
    const bgTop = mix(theme, white, 0.75);
    const bgBottom = mix(theme, white, 0.35);
    c.fill((_x, y) => mix(bgTop, bgBottom, y / W));

    // 見た目（Q20）で大きさ、フォルム（Q18）・種族（Q19）で形を変える
    const scale = ({ child: 0.72, teen: 0.84, young_adult: 0.95, adult: 1, senior: 0.92, ageless: 0.88 } as Record<string, number>)[appearance] ?? 0.9;
    const cx = W / 2, cy = W * 0.56, r = 150 * scale * (1 + stage * 0.01);
    const body = mix(theme, white, 0.1);
    const shape = species === "ロボット" || form === "mecha" ? "square" : form === "spirit" || species === "スピリット" ? "drop" : "round";
    c.fill((x, y) => {
      const dx = x - cx, dy = y - cy;
      const inside = shape === "square"
        ? Math.max(Math.abs(dx), Math.abs(dy)) < r * 0.85
        : shape === "drop"
        ? dx * dx + (dy > 0 ? dy * dy : dy * dy * 0.45) < r * r
        : dx * dx + dy * dy < r * r;
      return inside ? mix(body, dark, Math.max(0, dy) / (r * 6)) : null;
    });
    // 耳（どうぶつ・獣人）
    if (form === "animal" || species === "ビースト") {
      for (const side of [-1, 1]) {
        const ex = cx + side * r * 0.62, ey = cy - r * 0.82;
        c.fill((x, y) => ((x - ex) ** 2 + (y - ey) ** 2 < (r * 0.32) ** 2 ? body : null));
      }
    }
    // 目
    for (const side of [-1, 1]) {
      const ex = cx + side * r * 0.32, ey = cy - r * 0.1;
      c.fill((x, y) => ((x - ex) ** 2 + ((y - ey) * 0.8) ** 2 < (r * 0.11) ** 2 ? dark : null));
      c.fill((x, y) => ((x - ex + r * 0.03) ** 2 + (y - ey + r * 0.04) ** 2 < (r * 0.035) ** 2 ? white : null));
    }
    // エフェクト（Q14）：周囲のきらめき
    if (effect) {
      const spark = mix(theme, white, 0.6);
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        const sx = cx + Math.cos(a) * r * 1.35, sy = cy + Math.sin(a) * r * 1.2;
        c.fill((x, y) => (Math.abs(x - sx) + Math.abs(y - sy) < 14 ? spark : null));
      }
    }
    return await c.toPng();
  }
}

async function seedBytes(answers: DiagnosisAnswerInput[]): Promise<Uint8Array> {
  const text = JSON.stringify(answers.map((a) => [a.code, a.option_codes, a.texts]));
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}
