-- =============================================================================
-- 0900 API 用の関数（private スキーマ・PostgREST からは呼べない）
--   API はユーザーの JWT のクレームを設定した authenticated ロールで接続し、
--   書き込みはこれらの関数経由で行う（認証03）。
--   業務エラーは SQLSTATE P0001 + message = エラーコード（API02）で返し、API が HTTP に変換する。
-- =============================================================================

-- ---------------------------------------------------------------- 設定値
create or replace function private.setting_int(p_key text, p_default integer)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select (s.value #>> '{}')::integer from public.app_settings s where s.key = p_key), p_default)
$$;

-- ---------------------------------------------------------------- 同意（認証01）
-- 「最新の有効版に対する最後の記録が granted」の場合のみ同意あり。
-- requires_reconsent = true の版が出たら、それより前の版への同意は無効
create or replace function private.valid_consent_id(p_user_id uuid, p_doc_type text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  with cur as (
    select d.version from public.consent_documents d where d.doc_type = p_doc_type and d.is_current
  ),
  base as (
    select coalesce(max(d.version), 1) as version
    from public.consent_documents d, cur
    where d.doc_type = p_doc_type and d.requires_reconsent and d.version <= cur.version
  ),
  last as (
    select uc.id, uc.decision, d.version
    from public.user_consents uc
    join public.consent_documents d on d.id = uc.document_id
    where uc.user_id = p_user_id and d.doc_type = p_doc_type
    order by uc.decided_at desc
    limit 1
  )
  select last.id
  from last, base, cur
  where last.decision = 'granted' and last.version >= base.version
$$;

-- 本人の同意状況（最新の有効版ごと）
create or replace function private.consent_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(x) - 'sort_key' - 'decided_document_id' order by x.sort_key), '[]'::jsonb)
  from (
    select
      d.doc_type,
      d.id as document_id,
      d.version,
      d.title,
      d.requires_reconsent,
      case
        when last.decision is null then 'not_decided'
        when last.decision = 'revoked' then 'revoked'
        when private.valid_consent_id((select auth.uid()), d.doc_type) is not null then 'granted'
        else 'reconsent_required'
      end as status,
      last.id as consent_id,
      last.document_id as decided_document_id,
      last.decided_at,
      array_position(array['terms', 'privacy', 'ai_transfer'], d.doc_type) as sort_key
    from public.consent_documents d
    left join lateral (
      select uc.id, uc.decision, uc.document_id, uc.decided_at
      from public.user_consents uc
      join public.consent_documents d2 on d2.id = uc.document_id
      where uc.user_id = (select auth.uid()) and d2.doc_type = d.doc_type
      order by uc.decided_at desc
      limit 1
    ) last on true
    where d.is_current
  ) x
$$;

-- ---------------------------------------------------------------- 診断送信（API07）
-- 受付中の版か：published、または deprecated で版上げから猶予日数以内（U-22）
create or replace function private.question_set_accepting(p_question_set_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select s.status = 'published'
        or (
          s.status = 'deprecated'
          and now() < (select p.published_at from public.question_sets p where p.status = 'published')
                      + make_interval(days => private.setting_int('diagnosis.deprecated_grace_days', 30))
        )
    from public.question_sets s
    where s.id = p_question_set_id
  ), false)
$$;

-- 入力検証に使う質問定義（deprecated の版も返す）
create or replace function private.question_set_definition(p_question_set_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', s.id,
    'version', s.version,
    'status', s.status,
    'accepting', private.question_set_accepting(s.id),
    'questions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', q.id,
        'code', q.code,
        'answer_type', q.answer_type,
        'is_required', q.is_required,
        'constraints', q.constraints,
        'option_codes', coalesce((
          select jsonb_agg(o.code order by o.sort_order) from public.question_options o where o.question_id = q.id
        ), '[]'::jsonb)
      ) order by q.sort_order)
      from public.questions q
      where q.question_set_id = s.id
    ), '[]'::jsonb)
  )
  from public.question_sets s
  where s.id = p_question_set_id
$$;

create or replace function private.submission_json(s public.diagnosis_submissions)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'submission_id', s.id,
    'status', s.status,
    'submitted_at', s.submitted_at,
    'completed_at', s.completed_at,
    'error_code', s.error_code
  )
$$;

-- 送信前の確認（同意 → 送信回数 → 版）。同じ冪等キーの再送なら既存の送信を返す。
-- 同一ユーザーの同時送信はトランザクション単位のアドバイザリロックで直列化する
create or replace function private.diagnosis_precheck(p_question_set_id uuid, p_idempotency_key text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_existing public.diagnosis_submissions;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('diagnosis:' || v_uid::text, 0));

  if private.valid_consent_id(v_uid, 'ai_transfer') is null then
    raise exception 'CONSENT_REQUIRED';
  end if;

  select * into v_existing from public.diagnosis_submissions where user_id = v_uid;
  if found then
    if v_existing.idempotency_key = p_idempotency_key then
      return jsonb_build_object('replay', private.submission_json(v_existing));
    end if;
    raise exception 'ALREADY_SUBMITTED'
      using detail = jsonb_build_object('submission_id', v_existing.id)::text;
  end if;

  if not private.question_set_accepting(p_question_set_id) then
    raise exception 'QUESTION_SET_OUTDATED';
  end if;

  return jsonb_build_object('question_set', private.question_set_definition(p_question_set_id));
end;
$$;

-- 送信・回答・生成ジョブを同じトランザクションで登録する。
-- p_answers = [{ "question_id": uuid, "option_codes": [..], "texts": [..] }]（形式は API が質問定義で検証済み）
create or replace function private.create_diagnosis_submission(
  p_question_set_id uuid,
  p_answers jsonb,
  p_idempotency_key text,
  p_job_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_consent_id uuid;
  v_sub public.diagnosis_submissions;
  v_check jsonb;
begin
  -- 同意・送信回数・版を同じロックの中で再確認する
  v_check := private.diagnosis_precheck(p_question_set_id, p_idempotency_key);
  if v_check ? 'replay' then
    return v_check -> 'replay';
  end if;
  v_consent_id := private.valid_consent_id(v_uid, 'ai_transfer');

  if jsonb_typeof(p_answers) <> 'array' or exists (
    select 1
    from jsonb_array_elements(p_answers) a
    where not exists (
      select 1 from public.questions q
      where q.id = (a ->> 'question_id')::uuid and q.question_set_id = p_question_set_id
    )
  ) then
    raise exception 'VALIDATION_ERROR' using detail = '{"reason":"question_not_in_set"}';
  end if;

  insert into public.diagnosis_submissions (user_id, question_set_id, ai_consent_id, idempotency_key)
  values (v_uid, p_question_set_id, v_consent_id, p_idempotency_key)
  returning * into v_sub;

  insert into public.diagnosis_answers (submission_id, user_id, question_id, option_codes, texts)
  select
    v_sub.id,
    v_uid,
    (a ->> 'question_id')::uuid,
    coalesce(array(select jsonb_array_elements_text(coalesce(a -> 'option_codes', '[]'::jsonb))), '{}'),
    coalesce(array(select jsonb_array_elements_text(coalesce(a -> 'texts', '[]'::jsonb))), '{}')
  from jsonb_array_elements(p_answers) a;

  insert into public.generation_jobs (user_id, job_type, dedupe_key, payload)
  values (
    v_uid, 'diagnosis', 'diagnosis:' || v_sub.id || ':0',
    coalesce(p_job_payload, '{}'::jsonb) || jsonb_build_object('submission_id', v_sub.id)
  );

  return private.submission_json(v_sub);
end;
$$;

-- 生成失敗時の再試行（POST /diagnoses/{id}/retry）。failed のときだけ新しいジョブを登録する
create or replace function private.retry_diagnosis(p_submission_id uuid, p_job_payload jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_sub public.diagnosis_submissions;
  v_n integer;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('diagnosis:' || v_uid::text, 0));

  select * into v_sub from public.diagnosis_submissions where id = p_submission_id and user_id = v_uid for update;
  if not found then
    raise exception 'NOT_FOUND';
  end if;
  if private.valid_consent_id(v_uid, 'ai_transfer') is null then
    raise exception 'CONSENT_REQUIRED';
  end if;
  if v_sub.status in ('received', 'processing') then
    raise exception 'GENERATION_IN_PROGRESS';
  end if;
  if v_sub.status = 'completed' then
    return private.submission_json(v_sub);
  end if;

  select count(*) into v_n from public.generation_jobs
  where job_type = 'diagnosis' and payload ->> 'submission_id' = v_sub.id::text;

  insert into public.generation_jobs (user_id, job_type, dedupe_key, payload)
  values (
    v_uid, 'diagnosis', 'diagnosis:' || v_sub.id || ':' || v_n,
    coalesce(p_job_payload, '{}'::jsonb) || jsonb_build_object('submission_id', v_sub.id)
  );

  update public.diagnosis_submissions
  set status = 'received', error_code = null, completed_at = null
  where id = v_sub.id
  returning * into v_sub;

  return private.submission_json(v_sub);
end;
$$;

-- 生成の待機上限（U-08・仮に3分）を超えた送信を failed にする。
-- 会員の呼び出しでは本人分のみ、pg_cron（JWT なし）では全件が対象
create or replace function private.expire_stale_generation()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_timeout interval := make_interval(secs => private.setting_int('generation.timeout_seconds', 180));
  v_count integer;
begin
  with stale as (
    select s.id
    from public.diagnosis_submissions s
    where s.status in ('received', 'processing')
      and (v_uid is null or s.user_id = v_uid)
      and (
        select max(j.created_at) from public.generation_jobs j
        where j.job_type = 'diagnosis' and j.payload ->> 'submission_id' = s.id::text
      ) < now() - v_timeout
  ),
  jobs as (
    update public.generation_jobs j
    set status = 'failed', error_code = 'GENERATION_TIMEOUT'
    from stale
    where j.job_type = 'diagnosis' and j.payload ->> 'submission_id' = stale.id::text
      and j.status in ('queued', 'running')
    returning j.id
  )
  update public.diagnosis_submissions s
  set status = 'failed', error_code = 'GENERATION_TIMEOUT'
  from stale
  where s.id = stale.id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------- 冪等性（API01）
-- 同じユーザー×キーの要求をロックで直列化し、保存済みの応答があれば返す
create or replace function private.idempotency_lookup(p_key text, p_endpoint text, p_request_hash text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.idempotency_keys;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('idem:' || v_uid::text || ':' || p_key, 0));

  delete from public.idempotency_keys where user_id = v_uid and key = p_key and expires_at <= now();
  select * into v_row from public.idempotency_keys where user_id = v_uid and key = p_key;
  if not found then
    return null;
  end if;
  if v_row.endpoint <> p_endpoint or v_row.request_hash <> p_request_hash then
    raise exception 'IDEMPOTENCY_KEY_REUSED';
  end if;
  return jsonb_build_object('status_code', v_row.status_code, 'response', v_row.response);
end;
$$;

create or replace function private.idempotency_save(
  p_key text, p_endpoint text, p_request_hash text, p_status_code integer, p_response jsonb
)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into public.idempotency_keys (user_id, key, endpoint, request_hash, status_code, response, expires_at)
  values (
    auth.uid(), p_key, p_endpoint, p_request_hash, p_status_code, p_response,
    now() + make_interval(hours => private.setting_int('idempotency.ttl_hours', 24))
  )
  on conflict (user_id, key) do nothing
$$;

-- ---------------------------------------------------------------- worker 用（service_role / postgres のみ）
create or replace function private.claim_generation_jobs(p_limit integer default 5)
returns setof public.generation_jobs
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_job public.generation_jobs;
begin
  for v_job in
    with picked as (
      select j.id from public.generation_jobs j
      where j.status = 'queued' and j.run_after <= now()
      order by j.run_after
      limit p_limit
      for update skip locked
    )
    update public.generation_jobs j
    set status = 'running', attempts = j.attempts + 1, started_at = now()
    from picked
    where j.id = picked.id
    returning j.*
  loop
    if v_job.job_type = 'diagnosis' then
      update public.diagnosis_submissions
      set status = 'processing'
      where id = (v_job.payload ->> 'submission_id')::uuid and status = 'received';
    elsif v_job.job_type = 'character_image' then
      update public.characters set image_status = 'generating' where user_id = v_job.user_id;
    end if;
    return next v_job;
  end loop;
end;
$$;

-- 診断ジョブの成功：プロフィール・キャラ・画像を保存し completed にする
-- p_result = { "profile": {...}, "character": {...} }
create or replace function private.complete_diagnosis_job(
  p_job_id uuid, p_result jsonb, p_image_path text, p_image_status text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_job public.generation_jobs;
  v_submission_id uuid;
  v_profile jsonb := p_result -> 'profile';
  v_character jsonb := p_result -> 'character';
begin
  select * into v_job from public.generation_jobs where id = p_job_id for update;
  if not found or v_job.status <> 'running' then
    return; -- タイムアウト等で既に終了したジョブの結果は反映しない
  end if;
  v_submission_id := (v_job.payload ->> 'submission_id')::uuid;

  insert into public.ai_profiles (user_id, submission_id, personality, strengths, weaknesses, profile_items, ai_comments, generated_at)
  values (
    v_job.user_id, v_submission_id,
    v_profile ->> 'personality',
    coalesce(array(select jsonb_array_elements_text(v_profile -> 'strengths')), '{}'),
    coalesce(array(select jsonb_array_elements_text(v_profile -> 'weaknesses')), '{}'),
    coalesce(v_profile -> 'profile_items', '[]'::jsonb),
    coalesce(v_profile -> 'ai_comments', '[]'::jsonb),
    now()
  )
  on conflict (user_id) do update set
    submission_id = excluded.submission_id,
    personality = excluded.personality,
    strengths = excluded.strengths,
    weaknesses = excluded.weaknesses,
    profile_items = excluded.profile_items,
    ai_comments = excluded.ai_comments,
    generated_at = excluded.generated_at;

  -- 1ユーザー1体（characters.user_id UNIQUE）。再生成時も名前・成長値は保持する
  insert into public.characters (user_id, species, class, attribute, rarity, status_items, title, image_path, image_status)
  values (
    v_job.user_id,
    v_character ->> 'species', v_character ->> 'class', v_character ->> 'attribute', v_character ->> 'rarity',
    coalesce(v_character -> 'status_items', '{}'::jsonb),
    v_character ->> 'title',
    p_image_path, p_image_status
  )
  on conflict (user_id) do update set
    species = excluded.species,
    class = excluded.class,
    attribute = excluded.attribute,
    rarity = excluded.rarity,
    status_items = excluded.status_items,
    title = excluded.title,
    -- 生成失敗時は既存画像を保持する（非機能・設計04）
    image_path = coalesce(excluded.image_path, public.characters.image_path),
    image_status = case
      when excluded.image_status = 'ready' then 'ready'
      when public.characters.image_path is not null then 'ready'
      else excluded.image_status
    end;

  update public.generation_jobs
  set status = 'succeeded', result = p_result, error_code = null
  where id = p_job_id;

  update public.diagnosis_submissions
  set status = 'completed', completed_at = now(), error_code = null
  where id = v_submission_id;
end;
$$;

-- 画像ジョブの成功・失敗（成功時のみ現在画像を差し替える。進化履歴は保持しない）
create or replace function private.complete_image_job(p_job_id uuid, p_image_path text, p_image_status text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_job public.generation_jobs;
begin
  select * into v_job from public.generation_jobs where id = p_job_id for update;
  if not found or v_job.status <> 'running' then
    return;
  end if;
  update public.characters c
  set image_path = case when p_image_status = 'ready' then p_image_path else c.image_path end,
      image_status = case when p_image_status = 'ready' or c.image_path is not null then 'ready' else 'failed' end,
      image_stage = coalesce((v_job.payload ->> 'image_stage')::smallint, c.image_stage)
  where c.user_id = v_job.user_id;
  update public.generation_jobs
  set status = case when p_image_status = 'ready' then 'succeeded' else 'failed' end,
      result = jsonb_build_object('image_path', p_image_path)
  where id = p_job_id;
end;
$$;

-- ジョブの失敗：再試行回数内なら run_after を延ばして queued に戻し、超えたら（または再試行しても無駄な失敗なら）failed
create or replace function private.fail_generation_job(
  p_job_id uuid, p_error_code text, p_retry_delay_seconds integer default 2, p_retryable boolean default true
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_job public.generation_jobs;
begin
  select * into v_job from public.generation_jobs where id = p_job_id for update;
  if not found or v_job.status <> 'running' then
    return coalesce(v_job.status, 'missing');
  end if;

  if p_retryable and v_job.attempts <= private.setting_int('generation.max_retries', 3) then
    update public.generation_jobs
    set status = 'queued', error_code = p_error_code,
        run_after = now() + make_interval(secs => p_retry_delay_seconds)
    where id = p_job_id;
    return 'queued';
  end if;

  update public.generation_jobs set status = 'failed', error_code = p_error_code where id = p_job_id;
  if v_job.job_type = 'diagnosis' then
    update public.diagnosis_submissions
    set status = 'failed', error_code = 'GENERATION_FAILED'
    where id = (v_job.payload ->> 'submission_id')::uuid and status in ('received', 'processing');
  elsif v_job.job_type = 'character_image' then
    update public.characters
    set image_status = case when image_path is null then 'failed' else 'ready' end
    where user_id = v_job.user_id;
  end if;
  return 'failed';
end;
$$;

-- ---------------------------------------------------------------- 定期ジョブ（pg_cron・引継01）
-- 退会者データの物理削除（U-17：30日後）。ギルドの過去の発言は sender_id = null で残る
create or replace function private.purge_withdrawn_users()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user record;
  v_count integer := 0;
begin
  perform set_config('conime.purge', 'on', true);
  for v_user in
    select p.user_id from public.profiles p
    where p.status = 'withdrawn'
      and p.withdrawn_at < now() - make_interval(days => private.setting_int('withdrawal.purge_after_days', 30))
  loop
    update public.account_deletion_requests
    set status = 'completed', completed_at = now()
    where user_id = v_user.user_id and status <> 'completed';
    delete from auth.users where id = v_user.user_id;
    v_count := v_count + 1;
  end loop;
  perform set_config('conime.purge', 'off', true);
  return v_count;
end;
$$;

create or replace function private.run_maintenance()
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.expire_stale_generation();
  -- 停滞ジョブの再投入（worker の異常終了等で running のまま残ったジョブ）
  update public.generation_jobs
  set status = 'queued', run_after = now()
  where status = 'running' and job_type <> 'diagnosis' and started_at < now() - interval '5 minutes';
  delete from public.idempotency_keys where expires_at <= now();
  perform private.purge_withdrawn_users();
end;
$$;

-- 実行待ちのジョブがあれば worker を起動する（pg_net + Vault。未設定の環境では何もしない）
-- Vault に worker_url（https://<ref>.supabase.co/functions/v1/worker）と worker_secret を登録する
create or replace function private.kick_worker()
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
begin
  if not exists (select 1 from public.generation_jobs where status = 'queued' and run_after <= now()) then
    return;
  end if;
  if to_regclass('vault.decrypted_secrets') is null
     or not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'net' and p.proname = 'http_post') then
    return;
  end if;
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1' into v_url using 'worker_url';
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1' into v_secret using 'worker_secret';
  if v_url is null or v_secret is null then
    return;
  end if;
  execute 'select net.http_post(url := $1, body := ''{}''::jsonb, headers := jsonb_build_object(''Content-Type'', ''application/json'', ''x-worker-secret'', $2))'
    using v_url, v_secret;
end;
$$;

-- ---------------------------------------------------------------- 実行権限
revoke all on all functions in schema private from public, anon, authenticated;

grant execute on function
  private.is_admin(),
  private.is_guild_member(uuid),
  private.is_blocked(uuid, uuid),
  private.can_access_conversation(uuid)
to anon, authenticated;

grant execute on function
  private.valid_consent_id(uuid, text),
  private.consent_status(),
  private.diagnosis_precheck(uuid, text),
  private.create_diagnosis_submission(uuid, jsonb, text, jsonb),
  private.retry_diagnosis(uuid, jsonb),
  private.expire_stale_generation(),
  private.idempotency_lookup(text, text, text),
  private.idempotency_save(text, text, text, integer, jsonb)
to authenticated;

grant execute on all functions in schema private to service_role;
