-- =============================================================================
-- seed.sql：質問セット v1・同意文書（仮）・検証データ（連携01）
--   supabase db reset で migrations の後に投入される。
--   質問文・選択肢・制約は仮置き（U-06）。仕様書 v3.1 の確定文言で差し替える。
--   同意文書は dev 検証用の仮文書（U-21）。貴社支給の文書で差し替える。
-- =============================================================================

-- ---------------------------------------------------------------- 質問セット v1（API06）
insert into public.question_sets (id, version, status, published_at)
values ('0b9d6c1e-5a4f-4c47-9d0a-000000000001', 1, 'published', '2026-10-20T00:00:00Z');

insert into public.questions (question_set_id, code, sort_order, title, answer_type, is_required, constraints, usages)
select '0b9d6c1e-5a4f-4c47-9d0a-000000000001', v.code, v.sort_order, v.title, v.answer_type, true, v.constraints::jsonb, v.usages
from (values
  ('Q1',   1, '好きなアニメ（マンガ含む）3作品',             'free_fields',   '{"field_count":3,"required_field_count":3,"max_length":50}',  array['match_score','profile_display']),
  ('Q2',   2, 'その作品が好きな理由',                       'free_fields',   '{"field_count":1,"required_field_count":1,"max_length":200}', array['profile_display']),
  ('Q3',   3, '好きなキャラクター3人',                       'free_fields',   '{"field_count":3,"required_field_count":3,"max_length":50}',  array['character_base','match_score','profile_display']),
  ('Q4',   4, 'そのキャラクターが好きな理由',                 'free_fields',   '{"field_count":1,"required_field_count":1,"max_length":200}', array['profile_display']),
  ('Q5',   5, 'アニメにハマったきっかけ',                     'free_fields',   '{"field_count":1,"required_field_count":1,"max_length":100}', array['profile_display']),
  ('Q6',   6, 'アニメを見る頻度',                           'single_choice', '{}',                                                         array['match_score','profile_display']),
  ('Q7',   7, '最近見ている作品（複数可）',                   'free_multi',    '{"max_length":200}',                                         array['match_score','profile_display']),
  ('Q8',   8, 'これから見たい作品（複数可）',                 'free_multi',    '{"max_length":200}',                                         array['match_score','profile_display']),
  ('Q9',   9, '好きな楽しみ方',                             'multi_choice',  '{"min_select":1,"max_select":3}',                            array['match_score','profile_display']),
  ('Q10', 10, '推しへの想いをひと言で',                       'free_fields',   '{"field_count":1,"required_field_count":1,"max_length":100}', array['profile_display']),
  ('Q11', 11, '好きなジャンル・世界観（複数可）',             'free_multi',    '{"max_length":200}',                                         array['character_base','match_score','profile_display']),
  ('Q12', 12, '憧れのキャラクター（自分がなりたい姿）',       'free_fields',   '{"field_count":1,"required_field_count":1,"max_length":50}',  array['character_base','profile_display']),
  ('Q13', 13, 'マイキャラのテーマカラー',                     'single_choice', '{}',                                                         array['character_adjust','match_score','profile_display']),
  ('Q14', 14, 'マイキャラのエフェクト',                       'single_choice', '{}',                                                         array['character_adjust','match_score','profile_display']),
  ('Q15', 15, 'マイキャラの雰囲気',                           'single_choice', '{}',                                                         array['character_adjust','match_score','profile_display']),
  ('Q16', 16, 'マイキャラの表情',                             'single_choice', '{}',                                                         array['character_adjust','match_score','profile_display']),
  ('Q17', 17, 'マイキャラの画風',                             'single_choice', '{}',                                                         array['character_adjust','match_score','profile_display']),
  ('Q18', 18, 'マイキャラのフォルム',                         'single_choice', '{}',                                                         array['character_adjust','match_score','profile_display']),
  ('Q19', 19, 'マイキャラの種族・性別',                       'single_choice', '{}',                                                         array['character_adjust','profile_display']),
  ('Q20', 20, 'マイキャラの見た目',                           'single_choice', '{}',                                                         array['character_adjust','profile_display'])
) as v(code, sort_order, title, answer_type, constraints, usages);

-- 選択肢。attributes はキャラ要素（調整）として MockProvider / 第2段階の生成で使う
insert into public.question_options (question_id, code, label, sort_order, attributes)
select q.id, o.code, o.label, o.sort_order, o.attributes::jsonb
from (values
  ('Q6',  'A', 'ほぼ毎日',       1, '{}'),
  ('Q6',  'B', '週に数回',       2, '{}'),
  ('Q6',  'C', '月に数回',       3, '{}'),
  ('Q6',  'D', 'たまに',         4, '{}'),
  ('Q9',  'A', '視聴・読書',     1, '{}'),
  ('Q9',  'B', 'グッズ',         2, '{}'),
  ('Q9',  'C', '聖地巡礼',       3, '{}'),
  ('Q9',  'D', 'イベント・ライブ', 4, '{}'),
  ('Q9',  'E', '考察・感想の共有', 5, '{}'),
  ('Q9',  'F', '二次創作',       6, '{}'),
  ('Q9',  'G', 'コスプレ',       7, '{}'),
  ('Q9',  'H', 'ゲーム',         8, '{}'),
  ('Q9',  'I', '音楽・主題歌',   9, '{}'),
  ('Q13', 'A', 'レッド',         1, '{"element":"theme_color","value":"red","hex":"#E5484D"}'),
  ('Q13', 'B', 'ブルー',         2, '{"element":"theme_color","value":"blue","hex":"#3E63DD"}'),
  ('Q13', 'C', 'グリーン',       3, '{"element":"theme_color","value":"green","hex":"#30A46C"}'),
  ('Q13', 'D', 'イエロー',       4, '{"element":"theme_color","value":"yellow","hex":"#F5D90A"}'),
  ('Q13', 'E', 'パープル',       5, '{"element":"theme_color","value":"purple","hex":"#8E4EC6"}'),
  ('Q13', 'F', 'モノクロ',       6, '{"element":"theme_color","value":"mono","hex":"#6F6F6F"}'),
  ('Q14', 'A', '炎',             1, '{"element":"effect","value":"fire","attribute":"炎"}'),
  ('Q14', 'B', '氷',             2, '{"element":"effect","value":"ice","attribute":"氷"}'),
  ('Q14', 'C', '雷',             3, '{"element":"effect","value":"thunder","attribute":"雷"}'),
  ('Q14', 'D', '光',             4, '{"element":"effect","value":"light","attribute":"光"}'),
  ('Q14', 'E', '闇',             5, '{"element":"effect","value":"dark","attribute":"闇"}'),
  ('Q14', 'F', '風',             6, '{"element":"effect","value":"wind","attribute":"風"}'),
  ('Q15', 'A', '明るい',         1, '{"element":"mood","value":"bright","class":"アイドル"}'),
  ('Q15', 'B', 'クール',         2, '{"element":"mood","value":"cool","class":"ナイト"}'),
  ('Q15', 'C', 'やさしい',       3, '{"element":"mood","value":"gentle","class":"ヒーラー"}'),
  ('Q15', 'D', 'ミステリアス',   4, '{"element":"mood","value":"mysterious","class":"メイジ"}'),
  ('Q15', 'E', '元気',           5, '{"element":"mood","value":"energetic","class":"ファイター"}'),
  ('Q15', 'F', '落ち着き',       6, '{"element":"mood","value":"calm","class":"ガーディアン"}'),
  ('Q16', 'A', '笑顔',           1, '{"element":"expression","value":"smile"}'),
  ('Q16', 'B', '真剣',           2, '{"element":"expression","value":"serious"}'),
  ('Q16', 'C', 'クールな無表情', 3, '{"element":"expression","value":"blank"}'),
  ('Q16', 'D', 'ほほえみ',       4, '{"element":"expression","value":"gentle_smile"}'),
  ('Q16', 'E', '不敵な笑み',     5, '{"element":"expression","value":"fearless"}'),
  ('Q16', 'F', '照れ顔',         6, '{"element":"expression","value":"shy"}'),
  ('Q17', 'A', '王道アニメ',     1, '{"element":"art_style","value":"anime"}'),
  ('Q17', 'B', '少女マンガ',     2, '{"element":"art_style","value":"shoujo"}'),
  ('Q17', 'C', '劇画',           3, '{"element":"art_style","value":"gekiga"}'),
  ('Q17', 'D', 'デフォルメ',     4, '{"element":"art_style","value":"chibi"}'),
  ('Q17', 'E', '水彩',           5, '{"element":"art_style","value":"watercolor"}'),
  ('Q17', 'F', 'ドット絵',       6, '{"element":"art_style","value":"pixel"}'),
  ('Q18', 'A', '人型',           1, '{"element":"form","value":"humanoid"}'),
  ('Q18', 'B', 'どうぶつ',       2, '{"element":"form","value":"animal","suppress_effect":true}'),
  ('Q18', 'C', 'ぬいぐるみ',     3, '{"element":"form","value":"plush","suppress_effect":true}'),
  ('Q18', 'D', '精霊',           4, '{"element":"form","value":"spirit"}'),
  ('Q18', 'E', 'ちびキャラ',     5, '{"element":"form","value":"mini"}'),
  ('Q18', 'F', 'メカ',           6, '{"element":"form","value":"mecha"}'),
  ('Q19', 'A', '人間・男性',     1, '{"element":"species_gender","species":"ヒューマン","gender":"male"}'),
  ('Q19', 'B', '人間・女性',     2, '{"element":"species_gender","species":"ヒューマン","gender":"female"}'),
  ('Q19', 'C', '人間・性別なし', 3, '{"element":"species_gender","species":"ヒューマン","gender":"none"}'),
  ('Q19', 'D', '獣人',           4, '{"element":"species_gender","species":"ビースト","gender":"none"}'),
  ('Q19', 'E', 'ロボット',       5, '{"element":"species_gender","species":"ロボット","gender":"none"}'),
  ('Q19', 'F', '精霊・妖精',     6, '{"element":"species_gender","species":"スピリット","gender":"none"}'),
  ('Q20', 'A', 'こども',         1, '{"element":"appearance","value":"child"}'),
  ('Q20', 'B', '少年・少女',     2, '{"element":"appearance","value":"teen"}'),
  ('Q20', 'C', '青年',           3, '{"element":"appearance","value":"young_adult"}'),
  ('Q20', 'D', 'おとな',         4, '{"element":"appearance","value":"adult"}'),
  ('Q20', 'E', 'ベテラン',       5, '{"element":"appearance","value":"senior"}'),
  ('Q20', 'F', '年齢不詳',       6, '{"element":"appearance","value":"ageless"}')
) as o(qcode, code, label, sort_order, attributes)
join public.questions q
  on q.question_set_id = '0b9d6c1e-5a4f-4c47-9d0a-000000000001' and q.code = o.qcode;

-- ---------------------------------------------------------------- 同意文書（仮・U-03 / U-21）
insert into public.consent_documents (id, doc_type, version, title, body, is_current, requires_reconsent, published_at) values
  ('c0a5e0d0-0000-4000-8000-000000000001', 'terms', 1, 'CONIME 利用規約（検証用の仮文書）',
   '本文は貴社支給の利用規約で差し替えます（U-21）。', true, false, '2026-10-20T00:00:00Z'),
  ('c0a5e0d0-0000-4000-8000-000000000002', 'privacy', 1, 'CONIME プライバシーポリシー（検証用の仮文書）',
   '本文は貴社支給のプライバシーポリシーで差し替えます（U-21）。', true, false, '2026-10-20T00:00:00Z'),
  ('c0a5e0d0-0000-4000-8000-000000000003', 'ai_transfer', 1, '外部 AI サービスへの情報送信について（検証用の仮文書）',
   E'送信先：外部の生成 AI サービス（提供元は確定後に記載・U-04）\n' ||
   '送信する情報：AI 診断の回答、ナビゲーターへの入力（メールアドレス等の識別情報は送信しません）' || E'\n' ||
   '目的：プロフィール・キャラクター・画像の生成、作品推薦の理由、ナビゲーターの応答' || E'\n' ||
   '同意はいつでも設定画面から撤回できます。文言は貴社支給の文書で差し替えます（U-03）。',
   true, true, '2026-10-20T00:00:00Z');

-- =============================================================================
-- 以下は検証データ（local / dev のみ）。本番には投入しない
-- =============================================================================

-- ---------------------------------------------------------------- マスタ（作品リスト支給前の仮データ・U-05）
insert into public.tags (id, tag_type, code, label) values
  ('7a900000-0000-4000-8000-000000000001', 'genre', 'action', 'アクション'),
  ('7a900000-0000-4000-8000-000000000002', 'genre', 'romance', '恋愛'),
  ('7a900000-0000-4000-8000-000000000003', 'genre', 'comedy', 'コメディ'),
  ('7a900000-0000-4000-8000-000000000004', 'world', 'fantasy', 'ファンタジー'),
  ('7a900000-0000-4000-8000-000000000005', 'world', 'school', '学園'),
  ('7a900000-0000-4000-8000-000000000006', 'world', 'sf', 'SF'),
  ('7a900000-0000-4000-8000-000000000007', 'enjoyment', 'goods', 'グッズ'),
  ('7a900000-0000-4000-8000-000000000008', 'enjoyment', 'pilgrimage', '聖地巡礼'),
  ('7a900000-0000-4000-8000-000000000009', 'pace', 'slow', 'ゆったり'),
  ('7a900000-0000-4000-8000-000000000010', 'development', 'growth', '成長物語');

insert into public.works (id, title, title_kana, aliases) values
  ('a0000000-0000-4000-8000-000000000001', '作品A', 'さくひんえー', array['A']),
  ('a0000000-0000-4000-8000-000000000002', '作品B', 'さくひんびー', array['B']),
  ('a0000000-0000-4000-8000-000000000003', '作品C', 'さくひんしー', array['C']),
  ('a0000000-0000-4000-8000-000000000004', '作品D', 'さくひんでぃー', array['D']),
  ('a0000000-0000-4000-8000-000000000005', '作品E', 'さくひんいー', array['E']);

insert into public.work_tags (work_id, tag_id) values
  ('a0000000-0000-4000-8000-000000000001', '7a900000-0000-4000-8000-000000000001'),
  ('a0000000-0000-4000-8000-000000000001', '7a900000-0000-4000-8000-000000000004'),
  ('a0000000-0000-4000-8000-000000000002', '7a900000-0000-4000-8000-000000000002'),
  ('a0000000-0000-4000-8000-000000000002', '7a900000-0000-4000-8000-000000000005'),
  ('a0000000-0000-4000-8000-000000000003', '7a900000-0000-4000-8000-000000000003'),
  ('a0000000-0000-4000-8000-000000000004', '7a900000-0000-4000-8000-000000000006'),
  ('a0000000-0000-4000-8000-000000000005', '7a900000-0000-4000-8000-000000000010');

insert into public.anime_characters (work_id, name, aliases) values
  ('a0000000-0000-4000-8000-000000000001', 'キャラA', '{}'),
  ('a0000000-0000-4000-8000-000000000002', 'キャラB', '{}'),
  ('a0000000-0000-4000-8000-000000000003', 'キャラC', '{}');

-- ---------------------------------------------------------------- ギルド（5ギルド以上の利用検証・U-16）
insert into public.guilds (id, name, description, capacity, status, leader_info) values
  ('9c000000-0000-4000-8000-000000000001', 'ファンタジー好きの酒場', '剣と魔法の世界が好きな人のギルド', 100, 'published', '運営スタッフ'),
  ('9c000000-0000-4000-8000-000000000002', '学園ものクラブ', '学園作品について語るギルド', 100, 'published', '運営スタッフ'),
  ('9c000000-0000-4000-8000-000000000003', 'グッズ収集部', 'グッズ・推し活の情報交換', 100, 'published', '運営スタッフ'),
  ('9c000000-0000-4000-8000-000000000004', '聖地巡礼の会', '聖地巡礼の記録と計画', 100, 'published', '運営スタッフ'),
  ('9c000000-0000-4000-8000-000000000005', 'SF・ロボット研究所', 'SF・ロボット作品のギルド', 100, 'published', '運営スタッフ');

insert into public.guild_tags (guild_id, tag_id) values
  ('9c000000-0000-4000-8000-000000000001', '7a900000-0000-4000-8000-000000000004'),
  ('9c000000-0000-4000-8000-000000000002', '7a900000-0000-4000-8000-000000000005'),
  ('9c000000-0000-4000-8000-000000000003', '7a900000-0000-4000-8000-000000000007'),
  ('9c000000-0000-4000-8000-000000000004', '7a900000-0000-4000-8000-000000000008'),
  ('9c000000-0000-4000-8000-000000000005', '7a900000-0000-4000-8000-000000000006');

insert into public.conversations (id, kind, guild_id)
select ('c0000000-0000-4000-8000-0000000000' || right(g.id::text, 2))::uuid, 'guild', g.id
from public.guilds g;

insert into public.guild_announcements (guild_id, title, body) values
  ('9c000000-0000-4000-8000-000000000001', 'ギルドへようこそ', '自己紹介をトークルームに書き込んでみましょう。');

-- ---------------------------------------------------------------- 検証アカウント（状態別・連携01）
-- パスワードは共通で conime-dev-2026（dev の検証専用）
do $$
declare
  v_users constant jsonb := '[
    {"id":"d0000000-0000-4000-8000-000000000001","email":"pre-diagnosis@conime.test","name":"診断前ユーザー"},
    {"id":"d0000000-0000-4000-8000-000000000002","email":"diagnosed@conime.test","name":"診断済みユーザー"},
    {"id":"d0000000-0000-4000-8000-000000000003","email":"guild-member@conime.test","name":"ギルド所属ユーザー"}
  ]';
  v_user jsonb;
  v_id uuid;
begin
  for v_user in select * from jsonb_array_elements(v_users) loop
    v_id := (v_user ->> 'id')::uuid;
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, email_change, email_change_token_new, recovery_token
    ) values (
      '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated',
      v_user ->> 'email', extensions.crypt('conime-dev-2026', extensions.gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}', jsonb_build_object('display_name', v_user ->> 'name'),
      now(), now(), '', '', '', ''
    );
    insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (
      gen_random_uuid(), v_id, v_id::text,
      jsonb_build_object('sub', v_id::text, 'email', v_user ->> 'email', 'email_verified', true),
      'email', now(), now(), now()
    );
    -- 3種類の同意を記録（profiles はトリガーで作成済み）
    insert into public.user_consents (user_id, document_id, decision, app_version)
    select v_id, d.id, 'granted', 'seed' from public.consent_documents d where d.is_current;
  end loop;
end $$;

-- 診断済み・ギルド所属ユーザーの診断結果
do $$
declare
  v_answers constant jsonb := '{
    "Q1": {"texts": ["作品A", "作品B", "作品C"]},
    "Q2": {"texts": ["仲間との絆が熱いから"]},
    "Q3": {"texts": ["キャラA", "キャラB", "キャラC"]},
    "Q4": {"texts": ["まっすぐで優しいところ"]},
    "Q5": {"texts": ["友だちにすすめられて"]},
    "Q6": {"option_codes": ["B"]},
    "Q7": {"texts": ["作品D、作品E"]},
    "Q8": {"texts": ["作品C"]},
    "Q9": {"option_codes": ["A", "C", "D"]},
    "Q10": {"texts": ["いつも元気をありがとう"]},
    "Q11": {"texts": ["ファンタジー、学園"]},
    "Q12": {"texts": ["キャラA"]},
    "Q13": {"option_codes": ["E"]},
    "Q14": {"option_codes": ["D"]},
    "Q15": {"option_codes": ["F"]},
    "Q16": {"option_codes": ["D"]},
    "Q17": {"option_codes": ["A"]},
    "Q18": {"option_codes": ["A"]},
    "Q19": {"option_codes": ["E"]},
    "Q20": {"option_codes": ["C"]}
  }';
  v_seed record;
  v_sub_id uuid;
begin
  for v_seed in
    select * from (values
      ('d0000000-0000-4000-8000-000000000002'::uuid, 'e0000000-0000-4000-8000-000000000002'::uuid, 'ルミナ', 'C-7K3M9Q2X'),
      ('d0000000-0000-4000-8000-000000000003'::uuid, 'e0000000-0000-4000-8000-000000000003'::uuid, 'ソラカ', 'C-4HNW8RTE')
    ) as t(user_id, submission_id, character_name, public_code)
  loop
    v_sub_id := v_seed.submission_id;
    insert into public.diagnosis_submissions (id, user_id, question_set_id, ai_consent_id, status, idempotency_key, completed_at)
    select v_sub_id, v_seed.user_id, '0b9d6c1e-5a4f-4c47-9d0a-000000000001',
           (select uc.id from public.user_consents uc join public.consent_documents d on d.id = uc.document_id
            where uc.user_id = v_seed.user_id and d.doc_type = 'ai_transfer'),
           'completed', 'seed-' || v_sub_id, now();

    insert into public.diagnosis_answers (submission_id, user_id, question_id, option_codes, texts)
    select v_sub_id, v_seed.user_id, q.id,
           coalesce(array(select jsonb_array_elements_text(v_answers -> q.code -> 'option_codes')), '{}'),
           coalesce(array(select jsonb_array_elements_text(v_answers -> q.code -> 'texts')), '{}')
    from public.questions q
    where q.question_set_id = '0b9d6c1e-5a4f-4c47-9d0a-000000000001';

    insert into public.generation_jobs (user_id, job_type, status, dedupe_key, attempts, payload, result)
    values (v_seed.user_id, 'diagnosis', 'succeeded', 'diagnosis:' || v_sub_id || ':0', 1,
            jsonb_build_object('submission_id', v_sub_id), '{"provider":"seed"}');

    insert into public.ai_profiles (user_id, submission_id, personality, strengths, weaknesses, profile_items, ai_comments)
    values (
      v_seed.user_id, v_sub_id,
      '落ち着いていて、仲間思いの守り手タイプ。',
      array['仲間を支える', '粘り強い'], array['考えすぎる'],
      '[{"key":"favorite_works","label":"好きな作品","values":["作品A","作品B","作品C"]},
        {"key":"favorite_characters","label":"好きなキャラクター","values":["キャラA","キャラB","キャラC"]},
        {"key":"enjoyment","label":"楽しみ方","values":["視聴・読書","聖地巡礼","イベント・ライブ"]}]',
      '["仲間との絆を大切にするあなたにぴったりのキャラクターが誕生しました。"]'
    );

    -- 画像は seed で Storage に置けないため、worker が初回起動時に生成する（character_image ジョブ）
    insert into public.characters (user_id, public_code, name, species, class, attribute, rarity, status_items, title, image_status)
    values (
      v_seed.user_id, v_seed.public_code, v_seed.character_name, 'ロボット', 'ガーディアン', '光', 'SR',
      '{"personality":"落ち着いていて、仲間思いの守り手タイプ。","strengths":["仲間を支える","粘り強い"],"weaknesses":["考えすぎる"],
        "skills":[{"name":"ひかりの盾","description":"仲間を守る光の盾を張る"}],
        "stats":{"hp":72,"atk":48,"def":81,"spd":55},"theme_color":"#8E4EC6"}',
      'はじまりの守り手', 'generating'
    );
    insert into public.generation_jobs (user_id, job_type, dedupe_key, payload)
    values (v_seed.user_id, 'character_image', 'character_image:' || v_seed.user_id || ':seed',
            jsonb_build_object('submission_id', v_sub_id, 'image_stage', 0));
  end loop;
end $$;

-- ギルド所属ユーザー：「ファンタジー好きの酒場」に所属
insert into public.guild_members (guild_id, user_id, role) values
  ('9c000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000003', 'member');
update public.guilds set member_count = 1 where id = '9c000000-0000-4000-8000-000000000001';
insert into public.conversation_members (conversation_id, user_id)
values ('c0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000003');
insert into public.messages (conversation_id, sender_type, sender_id, body) values
  ('c0000000-0000-4000-8000-000000000001', 'system', null, 'ギルド所属ユーザー さんが参加しました'),
  ('c0000000-0000-4000-8000-000000000001', 'user', 'd0000000-0000-4000-8000-000000000003', 'よろしくお願いします！');
