// Deterministic seed generator for local development, tests and staging.
//
// Writes:
//   supabase/seed/anime-master-sample/*.csv  fictional anime master (client data replaces it)
//   supabase/seed/10_anime_master.sql        via scripts/import-anime-master.ts
//   supabase/seed/20_users_guilds.sql        200 users, diagnoses, characters, guilds,
//                                            conversations, reactions, blocks
// Community activity is created through the real app.api_* functions so that
// counters, EXP, levels and notifications are consistent.
//
//   deno task seed
import { masterToSql, readMaster } from "./import-anime-master.ts";
import { cumulativeExpForLevel, levelForExp, stageForLevel } from "../supabase/functions/_shared/domain/growth.ts";
import { deriveRarity } from "../supabase/functions/_shared/domain/character.ts";

const root = new URL("..", import.meta.url).pathname;
const SEED = 20261001;

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(SEED);
const pick = <T>(a: T[]) => a[Math.floor(rand() * a.length)];
const pickN = <T>(a: T[], n: number) => {
  const c = [...a];
  const out: T[] = [];
  while (out.length < n && c.length) out.push(c.splice(Math.floor(rand() * c.length), 1)[0]);
  return out;
};

// ---------------------------------------------------------------------------
// Fictional anime master (no real titles)
// ---------------------------------------------------------------------------
const GENRES: Array<[string, string, string[]]> = [
  ["action", "アクション・バトル", ["バトル", "アクション", "バトルもの"]],
  ["sports", "スポーツ・競技", ["スポーツ", "スポ根"]],
  ["school", "学園", ["学園もの", "学校"]],
  ["mystery", "ミステリー・サスペンス", ["ミステリー", "サスペンス", "推理"]],
  ["romance", "恋愛", ["ラブコメ", "恋愛もの", "ラブストーリー"]],
  ["sf", "SF", ["エスエフ", "サイエンスフィクション"]],
  ["fantasy", "ファンタジー", ["ハイファンタジー"]],
  ["comedy", "コメディ", ["ギャグ", "お笑い"]],
  ["slice_of_life", "日常", ["日常系", "ほのぼの"]],
  ["horror", "ホラー", ["ホラー系", "怖い話"]],
  ["music", "音楽", ["バンド", "音楽もの"]],
  ["mecha", "ロボット", ["ロボットアニメ", "メカ"]],
  ["isekai", "異世界転生", ["転生もの", "なろう系"]],
  ["drama", "ヒューマンドラマ", ["ドラマ", "感動系"]],
  ["idol", "アイドル", ["アイドルもの"]],
];
const WORLDS: Array<[string, string, string[]]> = [
  ["academy", "学園", ["学校の世界", "がくえん", "スクール"]],
  ["sword_magic", "剣と魔法の異世界", ["異世界", "いせかい", "ファンタジー世界", "剣と魔法"]],
  ["cyber_city", "サイバー都市", ["サイバーパンク", "近未来都市"]],
  ["post_apocalypse", "終末世界", ["ポストアポカリプス", "滅びた世界"]],
  ["space", "宇宙", ["宇宙船", "銀河", "スペース"]],
  ["modern_town", "現代の街", ["現代", "日常の街"]],
  ["feudal_japan", "和風・戦国", ["戦国時代", "和風ファンタジー", "江戸"]],
  ["sky_islands", "空に浮かぶ島", ["空島", "浮遊島"]],
  ["undersea", "海底都市", ["海の底", "海底"]],
  ["magic_school", "魔法学校", ["魔法学園", "魔法の学校"]],
  ["dungeon", "ダンジョン", ["迷宮", "ダンジョン探索"]],
  ["steampunk", "スチームパンク", ["蒸気都市", "スチパン"]],
];
const TOPICS: Array<[string, string]> = [
  ["topic_discussion", "感想・考察"], ["topic_newbie", "初心者歓迎"], ["topic_goods", "グッズ"],
  ["topic_event", "イベント"], ["topic_music", "アニソン"], ["topic_cosplay", "コスプレ"],
];
const TITLE_A = ["星屑", "蒼穹", "紅蓮", "月影", "雷鳴", "白銀", "黄昏", "翡翠", "深淵", "暁", "桜花", "鋼鉄", "虹色", "夜明け", "風花", "琥珀", "漆黒", "群青", "朱色", "氷華"];
const TITLE_B = ["のアルカディア", "ブレイバーズ", "クロニクル", "の守護者", "アカデミア", "ラプソディ", "の旅団", "ストライカーズ", "の方舟", "エンゲージ"];
const CHAR_NAMES = ["アキラ", "ミオ", "レイ", "カナタ", "シオン", "ユウ", "リン", "トワ", "ナギ", "セナ", "ヒナタ", "ルカ", "コハク", "イオ", "マシロ", "ジン", "ツムギ", "ハヤテ", "サクヤ", "ノア"];

function buildMaster() {
  const works: string[][] = [["external_code", "title", "title_kana", "summary", "start_year", "status"]];
  const workAliases: string[][] = [["work_external_code", "alias"]];
  const characters: string[][] = [["external_code", "work_external_code", "name", "name_kana", "status"]];
  const characterAliases: string[][] = [["character_external_code", "alias"]];
  const tags: string[][] = [["kind", "code", "name"]];
  const tagAliases: string[][] = [["tag_kind", "tag_code", "alias"]];
  const workTags: string[][] = [["work_external_code", "tag_kind", "tag_code"]];
  const meta: Array<{ code: string; title: string; short: string; genres: string[]; worlds: string[]; chars: Array<{ code: string; name: string; nick: string }> }> = [];

  for (const [code, name, aliases] of GENRES) {
    tags.push(["genre", code, name]);
    aliases.forEach((a) => tagAliases.push(["genre", code, a]));
  }
  for (const [code, name, aliases] of WORLDS) {
    tags.push(["world_setting", code, name]);
    aliases.forEach((a) => tagAliases.push(["world_setting", code, a]));
  }
  for (const [code, name] of TOPICS) tags.push(["guild_topic", code, name]);

  let w = 0;
  for (let i = 0; i < 40; i++) {
    const b = TITLE_B[(i * 7 + Math.floor(i / 20) * 3) % 10];
    const title = `${TITLE_A[i % 20]}${b}`;
    if (meta.some((m) => m.title === title)) continue;
    w++;
    const code = `W${String(w).padStart(3, "0")}`;
    const short = `${TITLE_A[i % 20]}${b.replace(/^の/, "").slice(0, 2)}`;
    const genres = pickN(GENRES.map((g) => g[0]), 2 + (i % 2));
    const worlds = pickN(WORLDS.map((x) => x[0]), 1 + (i % 2));
    works.push([code, title, "", `${title}は、${genres.length}つのジャンルが交差する架空のサンプル作品です。`, String(2000 + (i % 25)), "active"]);
    workAliases.push([code, short]);
    genres.forEach((g) => workTags.push([code, "genre", g]));
    worlds.forEach((x) => workTags.push([code, "world_setting", x]));
    const chars = [0, 1].map((k) => {
      const ccode = `${code}-C${k + 1}`;
      const name = `${CHAR_NAMES[(i * 2 + k) % 20]}・${TITLE_A[(i + k * 3) % 20]}`;
      const nick = CHAR_NAMES[(i * 2 + k) % 20] + (k ? "様" : "くん");
      characters.push([ccode, code, name, "", "active"]);
      characterAliases.push([ccode, nick]);
      return { code: ccode, name, nick };
    });
    meta.push({ code, title, short, genres, worlds, chars });
  }
  return { csv: { works, workAliases, characters, characterAliases, tags, tagAliases, workTags }, meta };
}

function toCsv(rows: string[][]) {
  return rows.map((r) => r.map((v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(",")).join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Users, diagnoses, guilds and community activity
// ---------------------------------------------------------------------------
const uid = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const gid = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const q = (s: string | null) => (s === null ? "null" : `'${s.replace(/'/g, "''")}'`);
const qid = (code: string) => `md5('conime/qs-2026-10-v1/${code}')::uuid`;
const oid = (code: string, opt: string) => `md5('conime/qs-2026-10-v1/${code}/${opt}')::uuid`;
const OPTIONS: Record<string, string[]> = {
  Q6: ["A", "B", "C", "D"], Q9: ["A", "B", "C", "D", "E", "F", "G", "H", "I"],
  Q13: ["A", "B", "C", "D", "E", "F"], Q14: ["A", "B", "C", "D", "E", "F"], Q15: ["A", "B", "C", "D", "E", "F"],
  Q16: ["A", "B", "C", "D", "E", "F"], Q17: ["A", "B", "C", "D", "E", "F"], Q18: ["A", "B", "C", "D", "E", "F"],
  Q19: ["A", "B", "C", "D", "E", "F"], Q20: ["A", "B", "C", "D", "E", "F"],
};
const SCENES = ["最終回で仲間が全員そろう場面", "ライバルと背中を預け合う瞬間", "雨の中で本音を打ち明けるシーン", "初めて空を飛んだ場面", "主人公が涙をこらえて笑うところ"];
const LIKES = ["まっすぐで諦めないところ", "仲間を大切にするところ", "クールに見えて優しいところ", "頭脳戦で相手を出し抜くところ"];
const ABILITIES = ["時間を止める力", "どこでも行ける扉", "動物と話せる力", "一瞬で絵が描ける力", "空を飛ぶ力"];
const TRAVELS = ["のんびり温泉めぐり", "世界の果てまで冒険", "屋台を食べ歩く旅", "星空を見に山へ"];
const NAMES = ["ネオン", "ソラ", "ミナト", "ルナ", "ハル", "ユキ", "レン", "アオイ", "ヒカリ", "ツバサ", "カイ", "モモ", "リク", "スズ", "タクミ", "ナナ", "ケイ", "ミコ", "ショウ", "エマ"];
const FIXTURE_NAMES: Record<number, string> = { 1: "アリス", 2: "ボブ", 3: "キャロル", 4: "デイブ", 5: "エリン", 6: "フランク" };
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const charCode = (n: number) => "C-" + Array.from({ length: 8 }, (_, i) => CROCKFORD[(n * 7919 + i * 104729 + (n >> i)) % 32]).join("");

async function main() {
  const { csv, meta } = buildMaster();
  const sampleDir = `${root}supabase/seed/anime-master-sample`;
  await Deno.mkdir(sampleDir, { recursive: true });
  const files: Record<string, string[][]> = {
    "anime_works.csv": csv.works, "work_aliases.csv": csv.workAliases, "anime_characters.csv": csv.characters,
    "character_aliases.csv": csv.characterAliases, "tags.csv": csv.tags, "tag_aliases.csv": csv.tagAliases, "work_tags.csv": csv.workTags,
  };
  for (const [f, rows] of Object.entries(files)) await Deno.writeTextFile(`${sampleDir}/${f}`, toCsv(rows));
  await Deno.writeTextFile(`${root}supabase/seed/10_anime_master.sql`, masterToSql(await readMaster(sampleDir)));

  const out: string[] = [
    "-- generated by scripts/generate-seed.ts (deterministic). Test data only.",
    "set client_min_messages = warning;",
    "create or replace function pg_temp.as_user(p uuid) returns void language sql as $$ select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, false) $$;",
  ];

  // ---- auth users (works on the shim and on Supabase/GoTrue)
  out.push(`do $$
declare full_auth boolean := exists (select 1 from information_schema.columns where table_schema = 'auth' and table_name = 'users' and column_name = 'instance_id');
declare n integer; u uuid; e text;
begin
  for n in 1..200 loop
    u := ('10000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid;
    e := 'user' || lpad(n::text, 3, '0') || '@conime.test';
    if full_auth then
      execute $q$insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
          raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token,
          email_change_token_new, email_change)
        values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2,
          extensions.crypt('Password123!', extensions.gen_salt('bf', 6)), now(),
          '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '')
        on conflict (id) do nothing$q$ using u, e;
      if to_regclass('auth.identities') is not null then
        execute $q$insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
          values (gen_random_uuid(), $1, $1::text, jsonb_build_object('sub', $1::text, 'email', $2), 'email', now(), now(), now())
          on conflict do nothing$q$ using u, e;
      end if;
    else
      insert into auth.users (id, email, encrypted_password) values (u, e, extensions.crypt('Password123!', extensions.gen_salt('bf', 4)))
      on conflict (id) do nothing;
    end if;
  end loop;
end $$;`);

  // ---- consent (all but user 200)
  out.push(`insert into app.consents (user_id, consent_type, consent_version, accepted)
select ('10000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'ai_data_transfer', '2026-10-01', true
from generate_series(1, 199) n;`);

  // ---- growth via the real EXP function (before characters exist → no evolution jobs)
  const expFor = (n: number): number => {
    if (n === 1 || (n >= 7 && n <= 10)) return cumulativeExpForLevel(5) - 10; // one グッと short of Lv5
    if (n === 2) return cumulativeExpForLevel(10) - 10; // one グッと short of Lv10
    if (n === 3 || n === 4 || n === 5 || n === 6) return 0;
    if (n === 11) return cumulativeExpForLevel(14) + 5; // multi-boundary tests start here
    return Math.floor(rand() * 1500);
  };
  const exps: number[] = [];
  for (let n = 1; n <= 190; n++) {
    exps[n] = expFor(n);
    out.push(`select app.apply_exp('${uid(n)}', ${exps[n]}, 0, 'operator_adjustment', 'seed', md5('seed-exp-${n}')::uuid);`);
  }

  // ---- diagnoses (users 1..190), stored in final state (no AI cost)
  for (let n = 1; n <= 190; n++) {
    const cluster = n % 8;
    const clusterWorks = meta.filter((_, i) => i % 8 === cluster);
    const favs = pickN(rand() < 0.75 ? clusterWorks : meta, 3);
    const unknownFav = rand() < 0.1;
    const sub = `md5('seed-sub-${n}')::uuid`;
    out.push(`insert into app.diagnosis_submissions (id, user_id, client_request_id, question_set_id, consent_id)
select ${sub}, '${uid(n)}', md5('seed-req-${n}')::uuid, md5('conime/qs-2026-10-v1')::uuid,
  (select id from app.consents where user_id = '${uid(n)}' order by seq desc limit 1);`);
    const ans: Array<[string, number, string | null, string | null]> = []; // code, idx, optionCode, text
    favs.forEach((w, i) => ans.push(["Q1", i, null, unknownFav && i === 2 ? "架空のどこにもない作品" : rand() < 0.3 ? w.short : w.title]));
    ans.push(["Q2", 0, null, pick(SCENES)]);
    const favChars = favs.map((w) => pick(w.chars));
    favChars.forEach((c, i) => ans.push(["Q3", i, null, rand() < 0.3 ? c.nick : c.name]));
    ans.push(["Q4", 0, null, pick(LIKES)], ["Q5", 0, null, pick(ABILITIES)]);
    const childhood = pickN(meta, rand() < 0.5 ? 1 : 2);
    ans.push(["Q7", 0, null, childhood.map((w) => w.title).join("、")]);
    const disliked = rand() < 0.6 ? pick(GENRES) : null;
    if (disliked) ans.push(["Q8", 0, null, pick([disliked[1], ...disliked[2]])]);
    ans.push(["Q10", 0, null, pick(TRAVELS)]);
    const worlds = pickN(WORLDS, rand() < 0.5 ? 1 : 2);
    ans.push(["Q11", 0, null, worlds.map((w) => pick([w[1], ...w[2]])).join("、")]);
    const reborn = pick(pick(meta).chars);
    ans.push(["Q12", 0, null, reborn.name]);
    const opts: Record<string, string[]> = {};
    for (const [code, list] of Object.entries(OPTIONS)) {
      opts[code] = code === "Q9" ? pickN(list, 1 + Math.floor(rand() * 3)) : [pick(list)];
      opts[code].forEach((o, i) => ans.push([code, i, o, null]));
    }
    out.push(`insert into app.diagnosis_answers (submission_id, question_id, value_index, option_id, text_value) values\n` +
      ans.map(([code, i, o, t]) => `(${sub}, ${qid(code)}, ${i}, ${o ? oid(code, o) : "null"}, ${q(t)})`).join(",\n") + ";");

    // normalized features (resolved directly from known master IDs)
    const f: string[] = [];
    const work = (code: string, w: { code: string }) => `('${uid(n)}', ${sub}, '${code}', 'work', 'work:' || (select id from app.anime_works where external_code = '${w.code}'), (select id from app.anime_works where external_code = '${w.code}'), null, null, null, 'alias_exact')`;
    favs.forEach((w, i) => {
      if (unknownFav && i === 2) f.push(`('${uid(n)}', ${sub}, 'Q1', 'unresolved', 'raw:seed-${n}', null, null, null, null, 'unresolved')`);
      else f.push(work("Q1", w));
    });
    childhood.forEach((w) => f.push(work("Q7", w)));
    const chr = (code: string, c: { code: string }) => `('${uid(n)}', ${sub}, '${code}', 'character', 'char:' || (select id from app.anime_characters where external_code = '${c.code}'), null, (select id from app.anime_characters where external_code = '${c.code}'), null, null, 'alias_exact')`;
    favChars.forEach((c) => f.push(chr("Q3", c)));
    f.push(chr("Q12", reborn));
    const tag = (code: string, kind: string, tcode: string, fk: string) => `('${uid(n)}', ${sub}, '${code}', '${fk}', 'tag:' || (select id from app.tags where kind = '${kind}' and code = '${tcode}'), null, null, (select id from app.tags where kind = '${kind}' and code = '${tcode}'), null, 'alias_exact')`;
    if (disliked) f.push(tag("Q8", "genre", disliked[0], "genre"));
    worlds.forEach((w) => f.push(tag("Q11", "world_setting", w[0], "world_setting")));
    for (const [code, list] of Object.entries(opts)) {
      list.forEach((o) => f.push(`('${uid(n)}', ${sub}, '${code}', 'option', 'opt:${code}:${o}', null, null, null, ${oid(code, o)}, 'option')`));
    }
    out.push(`insert into app.profile_features (user_id, submission_id, question_code, feature_kind, match_key, work_id, character_id, tag_id, option_id, resolution) values\n${f.join(",\n")}\non conflict do nothing;`);

    out.push(`insert into app.ai_jobs (user_id, kind, idempotency_key, status, payload, stage_state, completed_at)
values ('${uid(n)}', 'diagnosis_generation', 'diagnosis:' || ${sub}, 'completed', jsonb_build_object('submission_id', ${sub}), '{"seeded":true,"normalized":true,"profile_done":true,"recs_done":true}', now());`);

    const name = FIXTURE_NAMES[n] ?? `${NAMES[n % NAMES.length]}${n > 20 ? Math.floor(n / 20) : ""}`;
    const level = levelForExp(exps[n]);
    out.push(`insert into app.user_avatars (user_id, character_code, name, character_class, rarity, title, personality, strengths, weaknesses, skills, stats, attributes_version, visual_description, current_image_path, current_image_stage, image_status, image_updated_at)
values ('${uid(n)}', '${charCode(n)}', ${n === 4 ? "null" : q(name)}, '旅の見習い', '${await deriveRarity(uid(n))}', '駆け出しの冒険者', '好きなことにまっすぐな性格。',
  '["好奇心","仲間づくり"]', '["早起き"]', '[{"name":"ひらめき","description":"新しいアイデアを思いつく。"},{"name":"語りの灯火","description":"仲間を元気づける。"},{"name":"旅支度","description":"すぐに出発できる。"}]',
  '{"hp":60,"attack":55,"defense":50,"speed":58,"intelligence":62,"luck":49}', 'character-v1',
  'Original adventurer in a travel coat.', 'seed/${uid(n)}.png', ${stageForLevel(level)}, 'ready', now());`);
  }
  // Visual elements / element / species from the stored option attributes (概要7)
  out.push(`update app.user_avatars av set
  visual_elements = x.ve,
  species = x.ve ->> 'species_gender',
  element = coalesce(case when x.suppress then null else x.ve ->> 'effect' end,
                     case x.ve ->> 'theme_color' when '赤' then '炎' when '青' then '氷' when '黄' then '光' when '黒' then '闇' when '緑' then '風' when '白' then '光' end)
from (
  select s.user_id, jsonb_object_agg(k.key, k.value) filter (where k.key <> 'suppress_effect' and k.key <> 'genre_codes') as ve,
         bool_or(k.key = 'suppress_effect') as suppress
  from app.diagnosis_submissions s
  join app.diagnosis_answers a on a.submission_id = s.id
  join app.question_options o on o.id = a.option_id
  cross join lateral jsonb_each(o.attributes) k
  group by s.user_id
) x where x.user_id = av.user_id;`);
  out.push(`update app.user_avatars set visual_elements = visual_elements - 'effect' where (visual_elements ? 'effect') and element is distinct from visual_elements ->> 'effect';`);
  out.push(`update app.profiles p set ai_profile = jsonb_build_object('summary', '作品の世界にどっぷり浸るのが好きなアニメファン。', 'comments', '[]'::jsonb, 'conversation_topics', '["最近見た作品","好きなキャラ"]'::jsonb)
where exists (select 1 from app.user_avatars a where a.user_id = p.id);`);

  // anime recommendations with template reasons (deterministic candidates)
  out.push(`do $$
declare r record; c jsonb; i integer;
begin
  for r in select user_id from app.user_avatars loop
    c := app.svc_anime_candidates(r.user_id);
    i := 0;
    insert into app.recommendations (user_id, kind, rank, work_id, score, reason, reason_source, rule_version)
    select r.user_id, 'anime', row_number() over (), (e ->> 'work_id')::uuid, (e ->> 'score')::numeric,
           'あなたの診断結果に近い要素を持つ作品です。', 'template', c ->> 'rule_version'
    from (select e from jsonb_array_elements(c -> 'candidates') e limit 3) s;
  end loop;
end $$;`);

  // ---- guilds
  const guilds: Array<{ n: number; slug: string; name: string; desc: string; cap: number | null; status: string; topics: string[]; traits: Array<[string, string, string]> }> = [];
  const traitWork = (code: string) => meta.find((m) => m.code === code)!;
  const g = (n: number, slug: string, name: string, desc: string, cap: number | null, status: string, topics: string[], worksCodes: string[], q6: string, q9: string[], world: string, q16: string, q18: string) => {
    const traits: Array<[string, string, string]> = [];
    worksCodes.forEach((c) => traits.push(["Q1", `work:(select id from app.anime_works where external_code = '${c}')`, traitWork(c).title]));
    traits.push(["Q6", `'opt:Q6:${q6}'`, "活動量"]);
    q9.forEach((o) => traits.push(["Q9", `'opt:Q9:${o}'`, "楽しみ方"]));
    traits.push(["Q11", `tag:(select id from app.tags where kind = 'world_setting' and code = '${world}')`, WORLDS.find((w) => w[0] === world)![1]]);
    traits.push(["Q16", `'opt:Q16:${q16}'`, "行動タイプ"]);
    traits.push(["Q18", `'opt:Q18:${q18}'`, "役割"]);
    guilds.push({ n, slug, name, desc, cap, status, topics, traits });
  };
  g(1, "stardust-fans", "星屑ファン倶楽部", "星屑作品を語り合うギルド。初心者歓迎！", null, "published", ["topic_discussion", "topic_newbie"], ["W001", "W009", "W017"], "B", ["A", "F", "G"], "space", "A", "B");
  g(2, "isekai-adventurers", "異世界冒険者ギルド", "剣と魔法の世界が好きな人の集まり。", null, "published", ["topic_discussion"], ["W002", "W010", "W018"], "C", ["A", "G", "H"], "sword_magic", "B", "A");
  g(3, "sports-club", "スポーツアニメ同好会", "熱い試合展開を一緒に応援しよう。", null, "published", ["topic_event", "topic_newbie"], ["W003", "W011", "W019"], "D", ["C", "D", "F"], "modern_town", "B", "C");
  g(4, "mystery-lab", "ミステリー考察部", "伏線と考察が大好きな人へ。", null, "published", ["topic_discussion"], ["W004", "W012", "W020"], "B", ["G", "F"], "cyber_city", "C", "E");
  g(5, "full-house", "満員御礼ギルド", "定員に達したテスト用ギルド。", 10, "published", ["topic_goods"], ["W005"], "A", ["B"], "academy", "D", "D");
  g(6, "last-seat", "ラスト一席ギルド", "残り1枠のテスト用ギルド。", 5, "published", ["topic_music"], ["W006"], "A", ["I"], "magic_school", "A", "B");
  g(7, "coming-soon", "準備中ギルド", "未公開（検索・参加できない）", null, "draft", ["topic_cosplay"], ["W007"], "A", ["E"], "steampunk", "A", "A");
  for (const gg of guilds) {
    out.push(`insert into app.guilds (id, slug, name, description, status, capacity, leader_name) values ('${gid(gg.n)}', '${gg.slug}', ${q(gg.name)}, ${q(gg.desc)}, '${gg.status}', ${gg.cap ?? "null"}, '運営チーム');`);
    out.push(`insert into app.conversations (kind, guild_id) values ('guild', '${gid(gg.n)}');`);
    for (const t of gg.topics) out.push(`insert into app.guild_tags (guild_id, tag_id) select '${gid(gg.n)}', id from app.tags where kind = 'guild_topic' and code = '${t}';`);
    for (const [qc, key, label] of gg.traits) {
      const keyExpr = key.startsWith("'") ? key : `'${key.split(":")[0]}:' || ${key.slice(key.indexOf(":") + 1)}`;
      out.push(`insert into app.guild_match_traits (guild_id, question_code, match_key, label) values ('${gid(gg.n)}', '${qc}', ${keyExpr}, ${q(label)}) on conflict do nothing;`);
    }
    out.push(`insert into app.guild_announcements (guild_id, title, body) values ('${gid(gg.n)}', 'ようこそ！', ${q(`${gg.name}へようこそ。マナーを守って楽しく交流しましょう。`)});`);
  }

  // ---- memberships via the real join function
  const join = (u: number, gn: number) => out.push(`select pg_temp.as_user('${uid(u)}'); select app.api_join_guild('${gid(gn)}');`);
  [1, 2].forEach((gn) => join(1, gn)); // alice: 2 guilds
  join(2, 1); join(3, 2); join(5, 1); join(6, 1);
  for (let u = 12; u <= 100; u++) join(u, 1 + (u % 4));
  for (let u = 21; u <= 60; u += 3) join(u, 1 + ((u + 1) % 4)); // multi-guild members
  for (let u = 101; u <= 110; u++) join(u, 5); // full guild (10/10)
  for (let u = 111; u <= 114; u++) join(u, 6); // 4/5: one seat left

  // ---- guild chat: text + image messages
  const conv = (gn: number) => `(select id from app.conversations where guild_id = '${gid(gn)}')`;
  const LINES = ["こんにちは！よろしくお願いします", "最新話みました？", "あの伏線、気づいた人いる？", "今日のイベント楽しかった！", "おすすめの作品ありますか？", "グッズ届きました", "考察メモをまとめました", "次の配信楽しみ"];
  let mi = 0;
  const send = (u: number, convExpr: string, text: string) => {
    mi++;
    out.push(`select pg_temp.as_user('${uid(u)}'); select app.api_send_message(${convExpr}, md5('seed-msg-${mi}')::uuid, 'text', ${q(text)}, null);`);
  };
  const g1Members = [2, 5, 6, ...Array.from({ length: 89 }, (_, i) => i + 12).filter((u) => 1 + (u % 4) === 1)];
  for (let i = 0; i < 40; i++) send(g1Members[i % g1Members.length], conv(1), LINES[i % LINES.length]);
  send(1, conv(1), "アリスです。星屑シリーズが大好きです！");
  for (let i = 0; i < 15; i++) send([3, 13, 17, 21][i % 4], conv(2), LINES[(i + 3) % LINES.length]);
  for (let k = 0; k < 2; k++) {
    mi++;
    out.push(`select pg_temp.as_user('${uid(5)}');
do $$ declare s jsonb; begin
  s := app.api_create_upload_slot((select id from app.conversations where guild_id = '${gid(1)}'), 'image/png', 68);
  perform app.svc_mark_attachment_ready((s ->> 'attachment_id')::uuid, 'image/png', 68);
  perform app.api_send_message((select id from app.conversations where guild_id = '${gid(1)}'), md5('seed-msg-${mi}')::uuid, 'image', null, (s ->> 'attachment_id')::uuid);
end $$;`);
  }

  // ---- reactions (not on fixtures 1/2 so their near-boundary EXP stays exact)
  out.push(`do $$
declare m record; giver uuid; i integer := 0;
begin
  for m in select ms.id, ms.sender_id, ms.conversation_id from app.messages ms
           where ms.kind = 'text' and ms.sender_id not in ('${uid(1)}', '${uid(2)}') order by ms.conversation_id, ms.seq loop
    i := i + 1;
    for giver in select cm.user_id from app.conversation_members cm
                 where cm.conversation_id = m.conversation_id and cm.user_id <> m.sender_id
                   and cm.user_id not in ('${uid(1)}', '${uid(2)}')
                 order by md5(cm.user_id::text || m.id::text) limit (i % 4) loop
      perform set_config('request.jwt.claims', json_build_object('sub', giver, 'role', 'authenticated')::text, false);
      perform app.api_give_reaction('message', m.id);
    end loop;
  end loop;
end $$;`);

  // ---- DMs and blocks
  out.push(`select pg_temp.as_user('${uid(1)}'); select app.api_open_dm('${uid(2)}');`);
  const dm12 = `(select id from app.conversations where dm_user_low = '${uid(1)}' and dm_user_high = '${uid(2)}')`;
  send(1, dm12, "ボブさん、はじめまして！");
  send(2, dm12, "アリスさん、よろしく！");
  send(1, dm12, "同じギルドですね");
  out.push(`select pg_temp.as_user('${uid(1)}'); select app.api_open_dm('${uid(5)}');`);
  const dm15 = `(select id from app.conversations where dm_user_low = '${uid(1)}' and dm_user_high = '${uid(5)}')`;
  send(5, dm15, "こんにちは");
  out.push(`select pg_temp.as_user('${uid(1)}'); select app.api_block('${uid(5)}');`); // alice blocks erin
  out.push(`select pg_temp.as_user('${uid(6)}'); select app.api_block('${uid(1)}');`); // frank blocks alice

  out.push(`select set_config('request.jwt.claims', '', false);`);
  out.push(`-- seeded avatar/attachment objects are uploaded by scripts/seed-storage.ts`);
  await Deno.writeTextFile(`${root}supabase/seed/20_users_guilds.sql`, out.join("\n") + "\n");
  console.log(`seed written: ${meta.length} works, 200 users, ${guilds.length} guilds, ${mi} messages`);
}

await main();
