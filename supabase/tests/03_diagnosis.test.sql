-- 診断送信（API07・API08）：同意確認・1人1回・冪等性・版・再試行・タイムアウト・worker 関数
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(28);

insert into auth.users (id, email) values
  ('44444444-4444-4444-8444-444444444444', 'diag-a@conime.test'),
  ('55555555-5555-4555-8555-555555555555', 'diag-b@conime.test');

-- テスト用の質問セット（既存の published は deprecated にする）
update public.question_sets set status = 'deprecated' where status = 'published';
insert into public.question_sets (id, version, status, published_at) values
  ('cccccccc-0000-4000-8000-000000000001', 201, 'published', now()),
  ('cccccccc-0000-4000-8000-000000000002', 200, 'archived', now() - interval '60 days'),
  ('cccccccc-0000-4000-8000-000000000003', 199, 'deprecated', now() - interval '60 days');
insert into public.questions (id, question_set_id, code, sort_order, title, answer_type) values
  ('cccccccc-0000-4000-8000-0000000000a1', 'cccccccc-0000-4000-8000-000000000001', 'Q1', 1, 'テスト', 'free_fields'),
  ('cccccccc-0000-4000-8000-0000000000a2', 'cccccccc-0000-4000-8000-000000000002', 'Q1', 1, '旧版', 'free_fields');

-- A は AI 送信同意あり、B はなし
insert into public.user_consents (user_id, document_id, decision)
select '44444444-4444-4444-8444-444444444444', id, 'granted' from public.consent_documents where doc_type = 'ai_transfer' and is_current;

create function pg_temp.as_user(p_uid uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
$$;
create function pg_temp.answers() returns jsonb language sql as $$
  select '[{"question_id":"cccccccc-0000-4000-8000-0000000000a1","texts":["作品A","作品B","作品C"]}]'::jsonb
$$;

-- ------------------------------------------------------------ 同意・版
select pg_temp.as_user('55555555-5555-4555-8555-555555555555');
set local role authenticated;
select throws_ok($$select private.diagnosis_precheck('cccccccc-0000-4000-8000-000000000001', 'key-b')$$,
  'P0001', 'CONSENT_REQUIRED', 'AI 送信同意がなければ 403 CONSENT_REQUIRED');
reset role;

select pg_temp.as_user('44444444-4444-4444-8444-444444444444');
set local role authenticated;
select throws_ok($$select private.diagnosis_precheck('cccccccc-0000-4000-8000-000000000002', 'key-a')$$,
  'P0001', 'QUESTION_SET_OUTDATED', 'archived の版は 409 QUESTION_SET_OUTDATED');
select throws_ok($$select private.diagnosis_precheck('00000000-0000-4000-8000-000000000000', 'key-a')$$,
  'P0001', 'QUESTION_SET_OUTDATED', '存在しない質問セットも 409 QUESTION_SET_OUTDATED');
reset role;
select ok(private.question_set_accepting('cccccccc-0000-4000-8000-000000000001'), 'published の版は受付');
update public.question_sets set published_at = now() - interval '40 days' where id = 'cccccccc-0000-4000-8000-000000000001';
select ok(not private.question_set_accepting('cccccccc-0000-4000-8000-000000000003'), 'deprecated でも版上げから30日を超えたら受付しない');
update public.question_sets set published_at = now() - interval '10 days' where id = 'cccccccc-0000-4000-8000-000000000001';
select ok(private.question_set_accepting('cccccccc-0000-4000-8000-000000000003'), 'deprecated は版上げから30日以内なら受付（U-22）');

-- ------------------------------------------------------------ 送信・冪等性・1人1回
set local role authenticated;
select throws_ok(
  $$select private.create_diagnosis_submission('cccccccc-0000-4000-8000-000000000001',
    '[{"question_id":"cccccccc-0000-4000-8000-0000000000a2","texts":["x"]}]'::jsonb, 'key-a')$$,
  'P0001', 'VALIDATION_ERROR', '別の版の質問への回答は受け付けない');

select is(
  private.create_diagnosis_submission('cccccccc-0000-4000-8000-000000000001', pg_temp.answers(), 'key-a', '{"answered_at":null}') ->> 'status',
  'received', '送信は received で受付');
select is((select count(*)::int from public.diagnosis_answers), 1, '回答を保存（本人分のみ見える）');
select is((select texts from public.diagnosis_answers), array['作品A', '作品B', '作品C'], '自由記述は加工せず保存');
select is((select count(*)::int from public.generation_jobs where job_type = 'diagnosis'), 1, '同じトランザクションで生成ジョブを登録');
select is(
  private.create_diagnosis_submission('cccccccc-0000-4000-8000-000000000001', pg_temp.answers(), 'key-a') ->> 'submission_id',
  (select id::text from public.diagnosis_submissions),
  '同じ冪等キーの再送は同じ submission_id を返す');
select is((select count(*)::int from public.generation_jobs where job_type = 'diagnosis'), 1, '再送でジョブは増えない（重複生成しない）');
select throws_ok(
  $$select private.create_diagnosis_submission('cccccccc-0000-4000-8000-000000000001', pg_temp.answers(), 'key-other')$$,
  'P0001', 'ALREADY_SUBMITTED', '別のキーでの二重送信は 409 ALREADY_SUBMITTED');

-- 冪等キーの保存と照合
select lives_ok($$select private.idempotency_save('idem-1', 'POST /me/consents', 'hash-1', 201, '{"data":1}')$$, '成功応答を保存');
select is(private.idempotency_lookup('idem-1', 'POST /me/consents', 'hash-1') -> 'response', '{"data":1}'::jsonb, '同じ内容の再送には保存した応答を返す');
select throws_ok($$select private.idempotency_lookup('idem-1', 'POST /me/consents', 'hash-2')$$,
  'P0001', 'IDEMPOTENCY_KEY_REUSED', '同じキーで内容が異なれば 422 IDEMPOTENCY_KEY_REUSED');

-- ------------------------------------------------------------ 再試行
select throws_ok($$select private.retry_diagnosis((select id from public.diagnosis_submissions))$$,
  'P0001', 'GENERATION_IN_PROGRESS', '生成中の再試行は 409 GENERATION_IN_PROGRESS');
reset role;

-- worker：取得 → 失敗（再試行回数内は queued に戻る）→ 上限で failed
select is((select count(*)::int from private.claim_generation_jobs(10) where user_id = '44444444-4444-4444-8444-444444444444'), 1, 'worker がジョブを取得');
select is((select status from public.diagnosis_submissions where user_id = '44444444-4444-4444-8444-444444444444'), 'processing', '取得時に processing');
select is(private.fail_generation_job((select id from public.generation_jobs where user_id = '44444444-4444-4444-8444-444444444444' and job_type = 'diagnosis'), 'X', 0), 'queued', '再試行回数内の失敗は queued に戻る');
update public.generation_jobs set attempts = 4, status = 'running' where user_id = '44444444-4444-4444-8444-444444444444' and job_type = 'diagnosis';
select is(private.fail_generation_job((select id from public.generation_jobs where user_id = '44444444-4444-4444-8444-444444444444' and job_type = 'diagnosis'), 'X', 0), 'failed', '自動再試行3回の後は failed');
select is((select status from public.diagnosis_submissions where user_id = '44444444-4444-4444-8444-444444444444'), 'failed', '送信も failed（回答は保持）');

set local role authenticated;
select is(private.retry_diagnosis((select id from public.diagnosis_submissions)) ->> 'status', 'received', 'failed なら再試行で received に戻る');
reset role;
select is((select count(*)::int from public.generation_jobs where job_type = 'diagnosis' and user_id = '44444444-4444-4444-8444-444444444444'), 2, '再試行で新しいジョブを登録（dedupe_key :1）');

-- 成功：プロフィール・キャラを保存して completed
update public.generation_jobs set status = 'running' where dedupe_key like 'diagnosis:%:1' and user_id = '44444444-4444-4444-8444-444444444444';
select private.complete_diagnosis_job(
  (select id from public.generation_jobs where dedupe_key like 'diagnosis:%:1' and user_id = '44444444-4444-4444-8444-444444444444'),
  '{"profile":{"personality":"p","strengths":["s"],"weaknesses":["w"],"profile_items":[],"ai_comments":[]},"character":{"species":"ロボット","class":"ナイト","attribute":"光","rarity":"SR","title":"t","status_items":{}}}',
  '44444444-4444-4444-8444-444444444444/current.png', 'ready');
select is((select status from public.diagnosis_submissions where user_id = '44444444-4444-4444-8444-444444444444'), 'completed', '生成成功で completed');

-- タイムアウト（3分）
insert into public.diagnosis_submissions (user_id, question_set_id, ai_consent_id, idempotency_key, status)
select '55555555-5555-4555-8555-555555555555', 'cccccccc-0000-4000-8000-000000000001', uc.id, 'key-b', 'processing'
from public.user_consents uc where uc.user_id = '44444444-4444-4444-8444-444444444444' limit 1;
insert into public.generation_jobs (user_id, job_type, dedupe_key, payload, status, created_at)
select '55555555-5555-4555-8555-555555555555', 'diagnosis', 'timeout-test', jsonb_build_object('submission_id', s.id), 'running', now() - interval '4 minutes'
from public.diagnosis_submissions s where s.user_id = '55555555-5555-4555-8555-555555555555';
select set_config('request.jwt.claims', '', true); -- pg_cron と同じく JWT なしで全件が対象
select private.expire_stale_generation();
select is((select error_code from public.diagnosis_submissions where user_id = '55555555-5555-4555-8555-555555555555'), 'GENERATION_TIMEOUT', '待機上限（3分）を超えたら failed（GENERATION_TIMEOUT）');

-- 再試行しても無駄な失敗（入力の欠落など）は自動再試行せず failed
insert into public.generation_jobs (id, user_id, job_type, dedupe_key, status, attempts)
values ('cccccccc-0000-4000-8000-0000000000b1', '55555555-5555-4555-8555-555555555555', 'character_image', 'non-retryable-test', 'running', 1);
select is(private.fail_generation_job('cccccccc-0000-4000-8000-0000000000b1', 'ANSWERS_NOT_FOUND', 0, false), 'failed', '再試行不可の失敗は1回目で failed');

select * from finish();
rollback;
