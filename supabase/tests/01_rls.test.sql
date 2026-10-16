-- RLS：本人・他人・未ログインの3視点（認証03）
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(32);

-- ------------------------------------------------------------ テストデータ（postgres で作成）
insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'rls-a@conime.test'),
  ('22222222-2222-4222-8222-222222222222', 'rls-b@conime.test');

insert into public.question_sets (id, version, status) values ('aaaaaaaa-0000-4000-8000-000000000099', 9999, 'draft');

insert into public.consent_documents (id, doc_type, version, title, body, is_current)
values ('aaaaaaaa-0000-4000-8000-0000000000c1', 'terms', 9999, '旧版', '旧版', false);

insert into public.user_consents (id, user_id, document_id, decision)
select 'aaaaaaaa-0000-4000-8000-0000000000d1', '11111111-1111-4111-8111-111111111111', d.id, 'granted'
from public.consent_documents d where d.doc_type = 'ai_transfer' and d.is_current;

insert into public.question_sets (id, version, status, published_at)
values ('aaaaaaaa-0000-4000-8000-000000000098', 9998, 'archived', now());
insert into public.diagnosis_submissions (id, user_id, question_set_id, ai_consent_id, idempotency_key)
values ('aaaaaaaa-0000-4000-8000-0000000000e1', '11111111-1111-4111-8111-111111111111',
        'aaaaaaaa-0000-4000-8000-000000000098', 'aaaaaaaa-0000-4000-8000-0000000000d1', 'k1');
insert into public.characters (user_id, name) values ('11111111-1111-4111-8111-111111111111', 'エー');
insert into public.generation_jobs (user_id, job_type, dedupe_key) values ('11111111-1111-4111-8111-111111111111', 'diagnosis', 'rls-test');

insert into public.guilds (id, name) values ('aaaaaaaa-0000-4000-8000-0000000000f1', 'RLS ギルド');
insert into public.guild_members (guild_id, user_id) values ('aaaaaaaa-0000-4000-8000-0000000000f1', '11111111-1111-4111-8111-111111111111');
insert into public.conversations (id, kind, guild_id) values ('aaaaaaaa-0000-4000-8000-0000000000f2', 'guild', 'aaaaaaaa-0000-4000-8000-0000000000f1');
insert into public.messages (id, conversation_id, sender_type, sender_id, body)
values ('aaaaaaaa-0000-4000-8000-0000000000f3', 'aaaaaaaa-0000-4000-8000-0000000000f2', 'user', '11111111-1111-4111-8111-111111111111', 'hello');
insert into public.notifications (id, user_id, type, title) values ('aaaaaaaa-0000-4000-8000-0000000000f4', '11111111-1111-4111-8111-111111111111', 'system', 'お知らせ');
insert into public.goodtos (giver_id, receiver_id, target_type, target_id)
values ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'message', 'aaaaaaaa-0000-4000-8000-0000000000f3');
insert into public.reports (reporter_id, target_type, target_id, reason_code)
values ('11111111-1111-4111-8111-111111111111', 'user', '22222222-2222-4222-8222-222222222222', 'spam');

-- ------------------------------------------------------------ 未ログイン（anon）
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';

select is((select count(*)::int from public.question_sets where status = 'published'), 1, '【未ログイン】公開中の質問セットを取得できる');
select is((select count(*)::int from public.question_sets where id = 'aaaaaaaa-0000-4000-8000-000000000099'), 0, '【未ログイン】draft の質問セットは見えない');
select is((select count(*)::int from public.consent_documents where id = 'aaaaaaaa-0000-4000-8000-0000000000c1'), 0, '【未ログイン】旧版の同意文書は見えない');
select throws_ok('select * from public.profiles', '42501', null, '【未ログイン】profiles は参照できない');
select throws_ok('select * from public.characters', '42501', null, '【未ログイン】characters は参照できない');
select throws_ok(
  $$insert into public.user_consents (user_id, document_id, decision) values ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-0000000000c1', 'granted')$$,
  '42501', null, '【未ログイン】同意を記録できない');

-- ------------------------------------------------------------ 本人（ユーザーA）
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';

select is((select count(*)::int from public.profiles), 1, '【本人】profiles は自分の1行だけ');
select is((select count(*)::int from public.diagnosis_submissions), 1, '【本人】自分の診断送信を参照できる');
select is((select count(*)::int from public.characters), 1, '【本人】自分のキャラを参照できる');
select is((select count(*)::int from public.generation_jobs), 1, '【本人】自分の生成ジョブを参照できる');
select lives_ok($$update public.characters set name = 'エース'$$, '【本人】キャラ名は変更できる');
select throws_ok($$update public.characters set level = 99$$, '42501', null, '【本人】レベルは変更できない（L-1・L-5）');
select throws_ok($$update public.characters set exp_total = 9999$$, '42501', null, '【本人】EXP は変更できない');
select throws_ok($$update public.characters set public_code = 'C-AAAAAAAA'$$, '42501', null, '【本人】キャラIDは変更できない（Q-4）');
select throws_ok(
  $$insert into public.diagnosis_submissions (user_id, question_set_id, ai_consent_id, idempotency_key)
    values ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000098', 'aaaaaaaa-0000-4000-8000-0000000000d1', 'x')$$,
  '42501', null, '【本人】診断送信はテーブルへ直接書き込めない（API の関数経由のみ）');
select throws_ok($$update public.user_consents set decision = 'revoked'$$, '42501', null, '【本人】同意履歴は更新できない（追記のみ）');
select throws_ok(
  $$insert into public.user_consents (user_id, document_id, decision)
    select '22222222-2222-4222-8222-222222222222', id, 'granted' from public.consent_documents where is_current limit 1$$,
  '42501', null, '【本人】他人の同意は記録できない');
select is((select count(*)::int from public.messages), 1, '【本人】所属ギルドのトークルームのメッセージを参照できる');
select lives_ok($$update public.notifications set read_at = now()$$, '【本人】通知を既読にできる');
select is((select count(*)::int from public.goodtos), 1, '【本人】受け取ったグッとを参照できる');
select is((select count(*)::int from public.app_settings where key = 'guild.default_capacity'), 1, '【会員】公開設定は参照できる');
select is((select count(*)::int from public.app_settings where key = 'matching.weights'), 0, '【会員】配点（非公開設定）は参照できない');

-- ------------------------------------------------------------ 他人（ユーザーB）
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}';

select is((select count(*)::int from public.profiles where user_id = '11111111-1111-4111-8111-111111111111'), 0, '【他人】A の profiles は見えない');
select is((select count(*)::int from public.public_profiles where user_id = '11111111-1111-4111-8111-111111111111'), 1, '【他人】A の公開プロフィールは見える');
select is((select count(*)::int from public.diagnosis_submissions), 0, '【他人】A の診断送信は見えない');
select is((select count(*)::int from public.characters where user_id = '11111111-1111-4111-8111-111111111111'), 0, '【他人】A のキャラ（全列）は見えない');
select is((select count(*)::int from public.public_characters where user_id = '11111111-1111-4111-8111-111111111111'), 1, '【他人】A のキャラの公開情報は見える');
update public.characters set name = 'のっとり' where user_id = '11111111-1111-4111-8111-111111111111'; -- RLS で0行になる
select is((select count(*)::int from public.messages), 0, '【他人】未所属ギルドのメッセージは見えない');
select is((select count(*)::int from public.reports), 0, '【他人】A の通報は見えない');

-- ------------------------------------------------------------ ブロック：A が B をブロックすると相互に公開情報から除外
reset role;
select is((select name from public.characters where user_id = '11111111-1111-4111-8111-111111111111'), 'エース', '【他人】A のキャラ名は変更できない');
insert into public.blocks (blocker_id, blocked_id) values ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}';
select is((select count(*)::int from public.public_profiles where user_id = '11111111-1111-4111-8111-111111111111'), 0, '【ブロック】ブロックされた側からも公開プロフィールが見えない');

-- ------------------------------------------------------------ 運営（admin）
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated","app_metadata":{"role":"admin"}}';
select is((select count(*)::int from public.question_sets where id = 'aaaaaaaa-0000-4000-8000-000000000099'), 1, '【運営】draft の質問セットを参照できる');

reset role;
select * from finish();
rollback;
