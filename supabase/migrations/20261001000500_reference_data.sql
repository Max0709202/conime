-- Reference data required in every environment:
-- settings defaults, question set v1, matching/level rules v1, prompts,
-- private storage buckets and queues.
-- Environment-specific overrides live in supabase/seed/settings.<env>.sql.

-- ---------------------------------------------------------------------------
-- Settings defaults (see docs/ASSUMPTIONS.md for the reasoning behind each value)
-- ---------------------------------------------------------------------------
insert into app.app_settings (key, value, description) values
  ('consent.ai_data_transfer.current_version', '"2026-10-01"', 'Current AI data-transfer consent version (C-01)'),
  ('guild.default_capacity', '100', 'Default guild capacity (G-1, F-01)'),
  ('guild.max_memberships_per_user', '10', 'Per-user guild limit; null = unlimited (G-5, F-02)'),
  ('chat.message.max_chars', '1000', 'F-08'),
  ('chat.history.guild_max_messages', '1000', 'Retrievable guild messages per room (C-5, F-07)'),
  ('chat.history.dm_max_messages', '1000', 'Retrievable DM messages per thread (F-07)'),
  ('navigator.history.max_messages', '200', 'Retrievable navigator messages per user (F-07)'),
  ('attachments.bucket', '"chat-attachments"', 'Private bucket for chat images'),
  ('attachments.allowed_mime_types', '["image/jpeg","image/png","image/heic","image/webp"]', 'F-09'),
  ('attachments.max_bytes', '10485760', 'F-09 (10 MB)'),
  ('attachments.upload_url_ttl_seconds', '600', 'F-10'),
  ('attachments.download_url_ttl_seconds', '3600', 'F-10'),
  ('attachments.orphan_ttl_hours', '24', 'F-11'),
  ('avatars.bucket', '"avatars"', 'Private bucket for generated character images'),
  ('profile.character_name.min_length', '1', 'B-06'),
  ('profile.character_name.max_length', '20', 'B-06'),
  ('profile.character_name.denylist', '["admin","運営","公式","conime"]', 'B-06 local deny-list (substring, case-insensitive)'),
  ('character.rarity_weights', '{"N":50,"R":30,"SR":15,"SSR":5}', 'D-06 deterministic rarity weights'),
  ('growth.level_rule_version', '"level-v1"', 'Active level table (G-03)'),
  ('growth.max_level', '100', 'L-3'),
  ('growth.evolution.interval_levels', '5', 'L-3'),
  ('growth.reaction.exp', '10', 'EXP per グッと received (G-01)'),
  ('growth.reaction.gut_points', '1', 'グッとポイント per グッと received (G-01)'),
  ('recommendations.users.limit', '10', 'E-05'),
  ('recommendations.users.min_percent', '50', 'E-05'),
  ('recommendations.guilds.limit', '3', 'M-1'),
  ('notifications.enabled_types', '["reaction_received","level_up","character_evolved","generation_completed","generation_failed","dm_received"]', 'H-01'),
  ('navigator.daily_limit', '30', 'H-02'),
  ('navigator.max_chars', '500', 'H-02'),
  ('navigator.context_turns', '10', 'H-02'),
  ('navigator.default_suggestions', '["CONIMEでは何ができるの？","ギルドに参加するには？","グッとって何？"]', 'N-1'),
  ('navigator.fallback_message', '"ごめんなさい、いまはうまく答えられませんでした。少し時間をおいて、もう一度話しかけてください。"', 'N-2'),
  ('reports.reason_codes', '[{"code":"spam","label":"スパム・宣伝"},{"code":"harassment","label":"嫌がらせ・誹謗中傷"},{"code":"sexual","label":"性的な内容"},{"code":"violence","label":"暴力的な内容"},{"code":"hate","label":"差別・ヘイト"},{"code":"self_harm","label":"自傷・自殺に関する内容"},{"code":"impersonation","label":"なりすまし"},{"code":"copyright","label":"著作権の侵害"},{"code":"privacy","label":"個人情報の掲載"},{"code":"other","label":"その他"}]', 'I-02'),
  ('rate_limits', '{"question_set":{"limit":60,"window_seconds":60},"diagnosis_submit":{"limit":5,"window_seconds":3600},"message_send":{"limit":60,"window_seconds":60},"upload_url":{"limit":20,"window_seconds":600},"reaction":{"limit":120,"window_seconds":60},"report":{"limit":20,"window_seconds":3600},"block":{"limit":30,"window_seconds":3600},"dm_open":{"limit":20,"window_seconds":3600},"guild_join":{"limit":30,"window_seconds":3600},"consent":{"limit":20,"window_seconds":3600},"character_name":{"limit":20,"window_seconds":3600},"job_retry":{"limit":10,"window_seconds":3600},"default":{"limit":300,"window_seconds":60}}', 'I-06'),
  ('ai.models.text', '"gpt-5-mini"', 'D-07'),
  ('ai.models.image', '"gpt-image-1"', 'D-07'),
  ('ai.text.reasoning_effort', '"minimal"', 'Reasoning effort for reasoning models; null for non-reasoning models'),
  ('ai.text.max_output_tokens', '{"normalize":1500,"profile":2500,"anime_recs":1500,"navigator":800}', 'Output token caps per purpose'),
  ('ai.models.moderation', '"omni-moderation-latest"', 'D-07'),
  ('ai.pricing', '{"gpt-5-mini":{"input_per_mtok":0.25,"output_per_mtok":2.0},"gpt-image-1":{"per_image":{"medium":0.063,"low":0.016,"high":0.25}},"omni-moderation-latest":{"input_per_mtok":0}}', 'USD estimates; verify against the provider price list (D-07)'),
  ('ai.budget.daily_usd', '0', 'Daily AI spend guard in USD; 0 = AI calls deferred except mock (D-11)'),
  ('ai.jobs.max_attempts', '3', 'D-09'),
  ('ai.jobs.backoff_seconds', '[30,120,600]', 'D-09'),
  ('ai.jobs.max_manual_retries', '3', 'D-09'),
  ('ai.jobs.lease_seconds', '180', 'Worker lease per job'),
  ('ai.normalization.candidate_limit', '15', 'D-04'),
  ('ai.normalization.min_similarity', '0.15', 'D-04 trigram prefilter threshold'),
  ('ai.anime_recs.fallback_enabled', 'true', 'D-10'),
  ('ai.image.size', '"1024x1536"', 'D-08'),
  ('ai.image.quality', '"medium"', 'D-08'),
  ('ai.timeouts.text_ms', '45000', 'Text generation timeout'),
  ('ai.timeouts.image_ms', '120000', 'Image generation timeout'),
  ('ai.timeouts.navigator_ms', '12000', 'Navigator timeout (client waits 15 s)'),
  ('moderation.chat.external_enabled', 'false', 'C-04'),
  ('moderation.local_denylist', '["死ね","殺す","ころす","しね"]', 'Local filter for chat/character names (substring). Operator-maintained.'),
  ('retention.evidence_days_after_resolution', '90', 'I-04'),
  ('retention.audit_log_days', '365', 'I-05'),
  ('retention.ai_runs_days', '180', 'AI run metadata retention'),
  ('account_deletion.grace_days', '0', 'I-05'),
  ('client.request_timeout_seconds', '15', '設計02-C'),
  ('client.retry_delays_seconds', '[2,5]', '設計02-C'),
  ('client.generation_poll_seconds', '3', 'Job polling interval')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Question set v1 (概要6). Deterministic UUIDs so that tests, Postman and the
-- client can refer to stable IDs: md5('conime/<version>/<code>[/<option>]').
-- ---------------------------------------------------------------------------
insert into app.question_sets (id, version, status, published_at)
values (md5('conime/qs-2026-10-v1')::uuid, 'qs-2026-10-v1', 'active', '2026-10-01T00:00:00Z');

with q (code, pos, text_ja, label, answer_type, required, min_sel, max_sel, field_count, min_items, max_items, max_chars, purposes, norm, public_display) as (
  values
  ('Q1', 1, '好きなアニメ（マンガ含む）3作品', '好きな作品', 'free_text_fields', true, null, null, 3, 1, null, 50,
     array['matching','profile_display','recommendation_material'], 'anime_work', true),
  ('Q2', 2, '心に残るシーン', '心に残るシーン', 'free_text_fields', true, null, null, 1, 1, null, 200,
     array['profile_display','recommendation_material'], null, false),
  ('Q3', 3, '好きなアニメキャラクター3人', '好きなキャラ', 'free_text_fields', true, null, null, 3, 1, null, 50,
     array['character_base','matching','profile_display','recommendation_material'], 'anime_character', true),
  ('Q4', 4, '好きなキャラのどんなところが好きか', '好きなところ', 'free_text_fields', true, null, null, 1, 1, null, 200,
     array['profile_display','recommendation_material'], null, false),
  ('Q5', 5, '欲しい能力', '欲しい能力', 'free_text_fields', true, null, null, 1, 1, null, 200,
     array['profile_display','recommendation_material'], null, false),
  ('Q6', 6, 'この1年間の視聴ペース', '視聴ペース', 'single_choice', true, 1, 1, null, null, null, null,
     array['matching','profile_display'], null, true),
  ('Q7', 7, '小学生の頃に見ていた代表作', '小学生の頃の作品', 'free_text_multi', false, null, null, null, 1, 5, 50,
     array['matching','profile_display'], 'anime_work', true),
  ('Q8', 8, '勧められてもハマらなかったジャンル', '苦手ジャンル', 'free_text_multi', false, null, null, null, 1, 5, 50,
     array['matching','profile_display'], 'genre', false),
  ('Q9', 9, '好きな楽しみ方', '楽しみ方', 'multi_choice', true, 1, 3, null, null, null, null,
     array['matching','profile_display'], null, true),
  ('Q10', 10, '好きなキャラと旅をするなら', '旅をするなら', 'free_text_fields', true, null, null, 1, 1, null, 200,
     array['profile_display'], null, false),
  ('Q11', 11, 'どのアニメの世界観で遊びたいか', '遊びたい世界観', 'free_text_multi', true, null, null, null, 1, 5, 50,
     array['character_base','matching','profile_display'], 'world_setting', true),
  ('Q12', 12, '生まれ変わるならどのキャラか', 'なりたいキャラ', 'free_text_fields', true, null, null, 1, 1, null, 50,
     array['character_base','profile_display','recommendation_material'], 'anime_character', true),
  ('Q13', 13, '休日に1番幸せなのは', '休日', 'single_choice', true, 1, 1, null, null, null, null,
     array['character_adjust','matching','profile_display'], null, true),
  ('Q14', 14, 'いちばん許せないのは', '許せないこと', 'single_choice', true, 1, 1, null, null, null, null,
     array['character_adjust','matching','profile_display'], null, true),
  ('Q15', 15, '主人公なら1番燃える展開は', '燃える展開', 'single_choice', true, 1, 1, null, null, null, null,
     array['character_adjust','matching','profile_display'], null, true),
  ('Q16', 16, '仲間がピンチ、あなたなら', '行動タイプ', 'single_choice', true, 1, 1, null, null, null, null,
     array['character_adjust','matching','profile_display'], null, true),
  ('Q17', 17, '最後の戦いが終わった後は', '戦いの後', 'single_choice', true, 1, 1, null, null, null, null,
     array['character_adjust','matching','profile_display'], null, true),
  ('Q18', 18, '物語でなりたいポジションは', 'なりたい役割', 'single_choice', true, 1, 1, null, null, null, null,
     array['character_adjust','matching','profile_display'], null, true),
  ('Q19', 19, 'どんな種族で冒険したいか', '種族', 'single_choice', true, 1, 1, null, null, null, null,
     array['character_adjust','profile_display'], null, true),
  ('Q20', 20, 'アバターでどうなりたいか', '見た目', 'single_choice', true, 1, 1, null, null, null, null,
     array['character_adjust','profile_display'], null, true)
)
insert into app.questions (id, question_set_id, code, position, text_ja, profile_label, answer_type, required,
  min_selections, max_selections, field_count, min_items, max_items, max_chars, purposes, normalization_target, public_display)
select md5('conime/qs-2026-10-v1/' || code)::uuid, md5('conime/qs-2026-10-v1')::uuid, code, pos, text_ja, label,
  answer_type, required, min_sel, max_sel, field_count, min_items, max_items, max_chars, purposes, norm, public_display
from q;

-- Options with deterministic character elements (概要7) and anime genre mapping (概要8).
with o (qcode, code, pos, label, attrs) as (
  values
  ('Q6','A',1,'年に数作','{}'), ('Q6','B',2,'月1〜2作','{}'), ('Q6','C',3,'月3〜5作','{}'), ('Q6','D',4,'月6作以上','{}'),
  ('Q9','A',1,'視聴・読書','{}'), ('Q9','B',2,'グッズ','{}'), ('Q9','C',3,'イベント・展示会','{}'),
  ('Q9','D',4,'聖地巡礼','{}'), ('Q9','E',5,'コスプレ','{}'), ('Q9','F',6,'SNSで感想','{}'),
  ('Q9','G',7,'考察','{}'), ('Q9','H',8,'二次創作','{}'), ('Q9','I',9,'アニソン・声優・ライブ','{}'),
  ('Q13','A',1,'友達と遊ぶ','{"theme_color":"赤"}'), ('Q13','B',2,'一人で没頭','{"theme_color":"青"}'),
  ('Q13','C',3,'大切な人とのんびり','{"theme_color":"黄"}'), ('Q13','D',4,'自分の世界に浸る','{"theme_color":"黒"}'),
  ('Q13','E',5,'気分でごろごろ','{"theme_color":"緑"}'), ('Q13','F',6,'初めてに挑戦','{"theme_color":"白"}'),
  ('Q14','A',1,'頑張る人を馬鹿にする','{"effect":"炎"}'), ('Q14','B',2,'筋が通らない','{"effect":"氷"}'),
  ('Q14','C',3,'弱い立場を傷つける','{"effect":"光"}'), ('Q14','D',4,'内面に踏み込む','{"effect":"闇"}'),
  ('Q14','E',5,'生き方の押し付け','{"effect":"風"}'), ('Q14','F',6,'可能性の否定','{"effect":"雷"}'),
  ('Q15','A',1,'最終決戦','{"mood":"バトル寄り","genre_codes":["action"]}'),
  ('Q15','B',2,'逆転勝利','{"mood":"シンプル","genre_codes":["sports"]}'),
  ('Q15','C',3,'学校行事で一つに','{"mood":"さわやか","genre_codes":["school"]}'),
  ('Q15','D',4,'衝撃の真相','{"mood":"厨二病的","genre_codes":["mystery"]}'),
  ('Q15','E',5,'素顔を見せた瞬間','{"mood":"華やか","genre_codes":["romance"]}'),
  ('Q15','F',6,'近未来の冒険','{"mood":"ゴテゴテ","genre_codes":["sf"]}'),
  ('Q16','A',1,'逃がして手当て','{"expression":"柔和"}'), ('Q16','B',2,'正面から突破','{"expression":"熱血"}'),
  ('Q16','C',3,'合理的に助ける','{"expression":"クール"}'), ('Q16','D',4,'仲裁する','{"expression":"キュート"}'),
  ('Q16','E',5,'逃げる','{"expression":"無表情"}'), ('Q16','F',6,'有利な方に寝返る','{"expression":"冷酷"}'),
  ('Q17','A',1,'次の冒険へ','{"art_style":"現代アニメ"}'), ('Q17','B',2,'欲しい物を買い漁る','{"art_style":"フィギュア・ドール"}'),
  ('Q17','C',3,'日常に戻る','{"art_style":"カジュアル"}'), ('Q17','D',4,'家庭を築く','{"art_style":"フォーマル・シネマティック"}'),
  ('Q17','E',5,'気ままに旅','{"art_style":"近未来SF"}'), ('Q17','F',6,'竜に乗って未知の大陸へ','{"art_style":"和モダン"}'),
  ('Q18','A',1,'勇者・ヒーロー','{"form":"頭身高めバトル"}'), ('Q18','B',2,'親友・仲間・恋人','{"form":"リアル調高め","suppress_effect":true}'),
  ('Q18','C',3,'学園生活の主人公','{"form":"リアル調低め","suppress_effect":true}'), ('Q18','D',4,'マスコット','{"form":"SDマスコット"}'),
  ('Q18','E',5,'孤高のライバル','{"form":"パーツ強化"}'), ('Q18','F',6,'黒幕・魔王','{"form":"ファンタジー調"}'),
  ('Q19','A',1,'モンスター','{"species_gender":"モンスター"}'), ('Q19','B',2,'ロボット','{"species_gender":"ロボット"}'),
  ('Q19','C',3,'人間・男性','{"species_gender":"人間・男性"}'), ('Q19','D',4,'人間・女性','{"species_gender":"人間・女性"}'),
  ('Q19','E',5,'性別なし','{"species_gender":"性別なし"}'), ('Q19','F',6,'動物・マスコット','{"species_gender":"動物・マスコット"}'),
  ('Q20','A',1,'かわいい','{"look":"かわいい"}'), ('Q20','B',2,'かっこいい','{"look":"かっこいい"}'),
  ('Q20','C',3,'美しい','{"look":"美しい"}'), ('Q20','D',4,'ダーク','{"look":"ダーク"}'),
  ('Q20','E',5,'人外','{"look":"人外"}'), ('Q20','F',6,'独創的・個性的','{"look":"個性派"}')
)
insert into app.question_options (id, question_id, code, position, label_ja, attributes)
select md5('conime/qs-2026-10-v1/' || qcode || '/' || code)::uuid,
       md5('conime/qs-2026-10-v1/' || qcode)::uuid, code, pos, label, attrs::jsonb
from o;

-- ---------------------------------------------------------------------------
-- Genre tags referenced by the Q15 mapping (the anime master import may add more).
-- ---------------------------------------------------------------------------
insert into app.tags (kind, code, name) values
  ('genre', 'action', 'アクション・バトル'),
  ('genre', 'sports', 'スポーツ・競技'),
  ('genre', 'school', '学園'),
  ('genre', 'mystery', 'ミステリー・サスペンス'),
  ('genre', 'romance', '恋愛'),
  ('genre', 'sf', 'SF')
on conflict (kind, code) do nothing;

-- ---------------------------------------------------------------------------
-- Matching rules v1 (概要8; guild and anime values are 仮 — see ASSUMPTIONS E-*)
-- ---------------------------------------------------------------------------
insert into app.matching_rule_versions (kind, version, status, rules, notes) values
('user', 'user-v1', 'active', '{
  "base": 50, "max": 100,
  "items": [
    {"question_code":"Q1","label":"好きな作品","points_per_match":4,"cap":12},
    {"question_code":"Q3","label":"好きなキャラ","points_per_match":4,"cap":12},
    {"question_code":"Q6","label":"視聴ペース","points_per_match":2,"cap":2},
    {"question_code":"Q7","label":"小学生の頃の作品","points_per_match":2,"cap":2},
    {"question_code":"Q8","label":"苦手ジャンル","points_per_match":2,"cap":2},
    {"question_code":"Q9","label":"楽しみ方","points_per_match":2,"cap":6},
    {"question_code":"Q11","label":"遊びたい世界観","points_per_match":2,"cap":2},
    {"question_code":"Q13","label":"休日","points_per_match":2,"cap":2},
    {"question_code":"Q14","label":"許せないこと","points_per_match":2,"cap":2},
    {"question_code":"Q15","label":"燃える展開","points_per_match":2,"cap":2},
    {"question_code":"Q16","label":"行動タイプ","points_per_match":2,"cap":2},
    {"question_code":"Q17","label":"戦いの後","points_per_match":2,"cap":2},
    {"question_code":"Q18","label":"なりたい役割","points_per_match":2,"cap":2}
  ]}', '概要8 フレンド: base 50% + exact-match points, max 100%'),
('guild', 'guild-v1', 'active', '{
  "base": 0, "max": 100,
  "items": [
    {"question_code":"Q1","label":"作品","points_per_match":10,"cap":30},
    {"question_code":"Q6","label":"活動量","points_per_match":10,"cap":10},
    {"question_code":"Q9","label":"楽しみ方","points_per_match":10,"cap":30},
    {"question_code":"Q11","label":"世界観","points_per_match":15,"cap":15},
    {"question_code":"Q16","label":"雰囲気（行動タイプ）","points_per_match":7.5,"cap":7.5},
    {"question_code":"Q18","label":"雰囲気（役割）","points_per_match":7.5,"cap":7.5}
  ]}', '概要8 ギルド(仮): top 3, no AI'),
('anime', 'anime-v1', 'active', '{
  "candidate_limit": 10, "result_limit": 3, "max": 100,
  "exclude": {"viewed_question_codes":["Q1","Q7"], "disliked_genre_question_codes":["Q8"]},
  "items": [
    {"key":"favorite_genre","label":"好きな作品と同じジャンル","source_question_code":"Q1","points_per_match":10,"cap":40},
    {"key":"world_setting","label":"遊びたい世界観","source_question_code":"Q11","points_per_match":30,"cap":30},
    {"key":"development_genre","label":"燃える展開","source_question_code":"Q15","points_per_match":30,"cap":30}
  ],
  "reason_material_question_codes": ["Q2","Q3","Q4","Q5","Q12"]
  }', '概要8 アニメ(仮): rule-scored candidates, AI selects ≤3 with reasons');

-- ---------------------------------------------------------------------------
-- Level table level-v1: cumulative EXP for level L = 50(L-1) + 5(L-1)^2 (G-03)
-- ---------------------------------------------------------------------------
insert into app.level_rules (rule_version, level, exp_required)
select 'level-v1', l, 50 * (l - 1) + 5 * (l - 1) * (l - 1)
from generate_series(1, 100) as l;

-- ---------------------------------------------------------------------------
-- Prompt versions (system prompts; user content is passed separately)
-- ---------------------------------------------------------------------------
insert into app.prompt_versions (purpose, version, status, output_schema_version, system_prompt) values
('normalize', 'normalize-v1', 'active', 'normalization-output-v1',
$p$You map free-text answers from a Japanese anime-fan questionnaire to IDs in a controlled master list.
For each item you receive the user's text and a list of candidate entries (id + names). Choose the single candidate
that refers to the same anime work / character / genre / world setting, or null if none clearly matches.
Rules: never invent IDs; only return IDs from that item's candidates; prefer null over a guess; nicknames,
abbreviations and spelling variants count as the same entity; similar-but-different entities do not.
Return JSON that matches the schema exactly.$p$),
('profile', 'profile-v1', 'active', 'profile-output-v1',
$p$あなたはアニメ好きのためのコミュニティアプリ「CONIME」のキャラクターデザイナーです。
ユーザーの診断回答（要約済み）と、すでに決定済みの見た目の要素をもとに、ユーザーの分身となるオリジナルキャラクターと、
プロフィール用の短いコメントを日本語で作成してください。
厳守事項:
- 既存の作品名・キャラクター名・固有の設定・決め台詞を使わない。完全にオリジナルの存在として描写する。
- 回答に含まれる作品やキャラクターは「好み」の手がかりとしてのみ使い、そのまま再現しない。
- 個人を特定できる情報、差別的・性的・暴力的に過激な表現を含めない。
- visual_description は画像生成用の英語の外見描写（服装・色・雰囲気・ポーズ）で、作品名・キャラクター名・作家名・スタジオ名を含めない。
- スキルはちょうど3つ。強み・弱みは各2〜3個。各テキストは簡潔に。
スキーマに完全に一致するJSONのみを返してください。$p$),
('image', 'image-v1', 'active', null,
$p$Original anime-style character illustration for a community app avatar. Full body, single character, centered,
plain soft gradient background, portrait orientation, no text, no logos, no watermark.
Do not depict or imitate any existing copyrighted character, franchise, or a specific artist or studio style.$p$),
('anime_recs', 'anime-recs-v1', 'active', 'anime-recs-output-v1',
$p$あなたはアニメ作品のおすすめ担当です。ユーザーの好み（要約）と、サーバーが選んだ候補作品のリストが渡されます。
候補の中から最大3作品を選び、それぞれに日本語で60〜120文字程度のおすすめ理由を書いてください。
厳守事項: 候補リストにないIDを返さない。作品の内容について候補に書かれていない事実を断定しない。ネタバレをしない。
スキーマに完全に一致するJSONのみを返してください。$p$),
('navigator', 'navigator-v1', 'active', 'navigator-output-v1',
$p$あなたはアニメ好きのためのコミュニティアプリ「CONIME」の案内役ナビゲーターです。ロボット風のキャラクターで、
丁寧で親しみやすい日本語で、短く（200文字以内）答えます。あなたはAIであり、そのことを隠しません。
答えられる範囲: CONIMEの使い方（診断、マイキャラ、レベルと進化、グッと、ギルド、トークルーム、DM、通知、ブロック・通報、退会）とアニメの一般的な話題。
アプリの機能を答えるときは、次の事実だけを使います: 診断は約20問で一人1回。キャラクターは一人1体で名前は変更できるがキャラIDは変わらない。
グッとは同じ相手の同じ発言に1回だけ贈れて、受け取るとEXPが増える。レベル上限は100で、5レベルごとにキャラクターの姿が新しくなる。
ギルドは公開されているものに承認なしで参加でき、複数に所属できる。定員に達したギルドには参加できない。
知らないことや、個人情報・医療・法律・金銭の相談には答えず、運営への問い合わせを勧めます。他のユーザーの情報は扱えません。
最後に、ユーザーが次に送りそうな短い返信候補を3つ提案します（各20文字以内）。
スキーマに完全に一致するJSONのみを返してください。$p$);

-- ---------------------------------------------------------------------------
-- Private storage buckets (no storage.objects policies: signed URLs only)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('chat-attachments', 'chat-attachments', false, 10485760, array['image/jpeg','image/png','image/heic','image/webp']),
  ('avatars', 'avatars', false, 10485760, array['image/png','image/webp','image/jpeg'])
on conflict (id) do update set public = false;

-- ---------------------------------------------------------------------------
-- Queues (Supabase Queues / pgmq)
-- ---------------------------------------------------------------------------
select pgmq.create('ai_jobs');
