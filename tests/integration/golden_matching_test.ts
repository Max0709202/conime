// Golden fixtures for every active matching formula version (tests/golden/*.json),
// evaluated by the authoritative SQL implementation (app.rule_score via app.score_feature_sets).
import { assertEquals } from "@std/assert";
import { itest } from "./harness.ts";

type F = { question_code: string; match_key: string; label?: string };
const FULL: F[] = [
  ...["w1", "w2", "w3"].map((k) => ({ question_code: "Q1", match_key: k, label: k })),
  ...["c1", "c2", "c3"].map((k) => ({ question_code: "Q3", match_key: k, label: k })),
  ...["Q6", "Q7", "Q8", "Q11", "Q13", "Q14", "Q15", "Q16", "Q17", "Q18"].map((q) => ({ question_code: q, match_key: `${q}:x`, label: q })),
  ...["A", "B", "C"].map((o) => ({ question_code: "Q9", match_key: `opt:Q9:${o}`, label: o })),
];

for (const version of ["user-v1", "guild-v1"]) {
  const golden = JSON.parse(await Deno.readTextFile(new URL(`../golden/${version}.json`, import.meta.url)));
  for (const c of golden.cases) {
    itest(`golden ${version}: ${c.name}`, async (h) => {
      const a = c.a === "@full" ? FULL : c.a;
      const b = c.b === "@full" ? FULL : c.b;
      const [{ r }] = await h.sql`select app.score_feature_sets((select rules from app.matching_rule_versions where version = ${version}), ${h.deps.db.sql.json(a)}, ${h.deps.db.sql.json(b)}) as r`;
      assertEquals(Number(r.score), c.expected_score);
      const items = Object.fromEntries(r.matched_items.map((m: { question_code: string; points: number }) => [m.question_code, Number(m.points)]));
      assertEquals(items, c.expected_items);
    });
  }
}

itest("every active rule version has a golden fixture file", async (h) => {
  const rows = await h.sql`select version, kind from app.matching_rule_versions where status = 'active' order by kind`;
  for (const r of rows) {
    if (r.kind === "anime") continue; // anime-v1 golden lives in supabase/tests/database/005_anime_golden.test.sql
    await Deno.stat(new URL(`../golden/${r.version}.json`, import.meta.url));
  }
});
