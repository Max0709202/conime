-- DB で担保する業務ルール（概要4）
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(12);

insert into auth.users (id, email) values
  ('66666666-6666-4666-8666-666666666666', 'rule-a@conime.test'),
  ('77777777-7777-4777-8777-777777777777', 'rule-b@conime.test');

select is((select count(*)::int from public.profiles where user_id = '66666666-6666-4666-8666-666666666666'), 1,
  'auth.users の作成時に profiles を自動作成');

insert into public.characters (user_id) values ('66666666-6666-4666-8666-666666666666');
select throws_ok($$insert into public.characters (user_id) values ('66666666-6666-4666-8666-666666666666')$$,
  '23505', null, 'キャラは1ユーザー1体（characters.user_id UNIQUE）');
select matches((select public_code from public.characters where user_id = '66666666-6666-4666-8666-666666666666'),
  '^C-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$', 'キャラIDを自動付与（C- ＋ 英数字8文字・U-07）');
select throws_ok($$update public.characters set public_code = 'C-22222222' where user_id = '66666666-6666-4666-8666-666666666666'$$,
  '42501', null, 'キャラIDは変更不可');
select throws_ok($$update public.characters set level = 101 where user_id = '66666666-6666-4666-8666-666666666666'$$,
  '23514', null, 'レベル上限100（CHECK 1〜100）');
select throws_ok($$update public.characters set image_stage = 3 where user_id = '66666666-6666-4666-8666-666666666666'$$,
  '23514', null, '画像の進化段階は5の倍数');

insert into public.goodtos (giver_id, receiver_id, target_type, target_id)
values ('77777777-7777-4777-8777-777777777777', '66666666-6666-4666-8666-666666666666', 'message', 'dddddddd-0000-4000-8000-000000000001');
select throws_ok(
  $$insert into public.goodtos (giver_id, receiver_id, target_type, target_id)
    values ('77777777-7777-4777-8777-777777777777', '66666666-6666-4666-8666-666666666666', 'message', 'dddddddd-0000-4000-8000-000000000001')$$,
  '23505', null, 'グッとは同一ユーザー・同一対象に1回');
select throws_ok(
  $$insert into public.goodtos (giver_id, receiver_id, target_type, target_id)
    values ('66666666-6666-4666-8666-666666666666', '66666666-6666-4666-8666-666666666666', 'message', 'dddddddd-0000-4000-8000-000000000002')$$,
  '23514', null, '自分にはグッとできない（giver ≠ receiver）');

select throws_ok($$insert into public.guilds (name, capacity, member_count) values ('満員', 2, 3)$$,
  '23514', null, 'ギルドの所属人数は定員を超えない');
select throws_ok($$insert into public.question_sets (version, status, published_at) values (9001, 'published', now())$$,
  '23505', null, 'published の質問セットは同時に1件');
select throws_ok(
  $$insert into public.generation_jobs (user_id, job_type, dedupe_key) values
    ('66666666-6666-4666-8666-666666666666', 'diagnosis', 'same'), ('66666666-6666-4666-8666-666666666666', 'diagnosis', 'same')$$,
  '23505', null, '生成ジョブは dedupe_key で重複を防ぐ');
select throws_ok($$insert into public.blocks (blocker_id, blocked_id) values ('66666666-6666-4666-8666-666666666666', '66666666-6666-4666-8666-666666666666')$$,
  '23514', null, '自分自身はブロックできない');

select * from finish();
rollback;
