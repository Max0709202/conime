-- API functions: account bootstrap, consent, question set, diagnosis submission,
-- generation jobs, profile, character and growth reads.
--
-- Conventions
--   app.api_*  : called by the /v1 API inside a transaction running as role
--                "authenticated" with the caller's JWT claims. SECURITY DEFINER,
--                identity from auth.uid(), errors via app.raise_api_error().
--   app.svc_*  : service_role only (worker / trusted server steps).
--   Image references are returned as {"status","__image_path","stage_level","updated_at"};
--   the API replaces "__image_path" with a short-lived signed URL.

-- ---------------------------------------------------------------------------
-- Shared JSON builders
-- ---------------------------------------------------------------------------
create or replace function app.ts(p timestamptz) returns text
language sql immutable set search_path = '' as $$
  select to_char(p at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;

create or replace function app.image_ref_json(p_path text, p_status text, p_stage integer, p_updated timestamptz)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'status', coalesce(p_status, 'none'),
    '__image_path', p_path,
    'stage_level', p_stage,
    'updated_at', app.ts(p_updated))
$$;

create or replace function app.level_for_exp(p_rule_version text, p_exp integer) returns integer
language sql stable security definer set search_path = '' as $$
  select least(
    app.setting_int('growth.max_level', 100),
    coalesce((select max(level) from app.level_rules
              where rule_version = p_rule_version and exp_required <= p_exp), 1))
$$;

create or replace function app.user_level(p_user uuid) returns integer
language sql stable security definer set search_path = '' as $$
  select coalesce((select level from app.user_growth where user_id = p_user), 1)
$$;

-- Public summary of any user (display name = character name, B-04).
create or replace function app.user_summary_json(p_user uuid, p_role text default null) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case
    when p.id is null or p.status <> 'active' then jsonb_build_object(
      'user_id', p_user, 'display_name', null, 'character_id', null, 'level', 1,
      'is_deleted', true, 'role', p_role,
      'avatar', app.image_ref_json(null, 'none', null, null))
    else jsonb_build_object(
      'user_id', p.id,
      'display_name', a.name,
      'character_id', a.character_code,
      'level', coalesce(g.level, 1),
      'is_deleted', false,
      'role', p_role,
      'avatar', app.image_ref_json(a.current_image_path,
                  case when a.id is null then 'none' else a.image_status end,
                  a.current_image_stage, a.image_updated_at))
  end
  from (select p_user as uid) x
  left join app.profiles p on p.id = x.uid
  left join app.user_avatars a on a.user_id = x.uid
  left join app.user_growth g on g.user_id = x.uid
$$;

create or replace function app.job_json(j app.ai_jobs) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', j.id,
    'kind', j.kind,
    'status', case when j.status = 'superseded' then 'completed' else j.status end,
    'attempt', j.attempts,
    'retryable', j.status = 'failed'
                 and j.manual_retries < app.setting_int('ai.jobs.max_manual_retries', 3)
                 and coalesce(j.last_error_code, '') not in ('CONSENT_REQUIRED', 'ACCOUNT_DELETED'),
    'error_code', j.last_error_code,
    'created_at', app.ts(j.created_at),
    'updated_at', app.ts(j.updated_at),
    'completed_at', app.ts(j.completed_at),
    'poll_after_seconds', case when j.status in ('completed', 'failed', 'superseded') then null
                               else app.setting_int('client.generation_poll_seconds', 3) end)
$$;

-- ---------------------------------------------------------------------------
-- Consent
-- ---------------------------------------------------------------------------
create or replace function app.consent_status_json(p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  with cur as (select app.setting_text('consent.ai_data_transfer.current_version', '') as v),
  latest as (
    select * from app.consents
    where user_id = p_user and consent_type = 'ai_data_transfer'
    order by seq desc limit 1
  )
  select jsonb_build_object('ai_data_transfer', jsonb_build_object(
    'current_version', cur.v,
    'accepted', coalesce(l.accepted, false),
    'accepted_version', case when l.accepted then l.consent_version end,
    'accepted_at', case when l.accepted then app.ts(l.created_at) end,
    'withdrawn_at', case when l.accepted = false then app.ts(l.created_at) end,
    'is_valid', coalesce(l.accepted and l.consent_version = cur.v, false)))
  from cur left join latest l on true
$$;

-- Returns the consent row id that authorizes AI processing, or raises CONSENT_REQUIRED.
create or replace function app.require_valid_consent(p_user uuid) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare
  v_current text := app.setting_text('consent.ai_data_transfer.current_version', '');
  v_row app.consents;
begin
  select * into v_row from app.consents
   where user_id = p_user and consent_type = 'ai_data_transfer'
   order by seq desc limit 1;
  if v_row.id is null or not v_row.accepted or v_row.consent_version <> v_current then
    perform app.raise_api_error('CONSENT_REQUIRED', jsonb_build_object('required_version', v_current));
  end if;
  return v_row.id;
end;
$$;

create or replace function app.api_consent_status() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  return app.consent_status_json(app.require_user());
end;
$$;

create or replace function app.api_record_consent(p_type text, p_version text, p_accepted boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := app.require_user();
  v_current text := app.setting_text('consent.ai_data_transfer.current_version', '');
begin
  if p_type <> 'ai_data_transfer' then
    perform app.raise_api_error('VALIDATION_ERROR', jsonb_build_object('fields',
      jsonb_build_array(jsonb_build_object('path', '/consent_type', 'rule', 'enum', 'message', 'unknown consent type'))));
  end if;
  if p_accepted and p_version <> v_current then
    perform app.raise_api_error('CONSENT_VERSION_MISMATCH', jsonb_build_object('current_version', v_current));
  end if;
  insert into app.consents (user_id, consent_type, consent_version, accepted, request_id)
  values (v_uid, p_type, p_version, p_accepted, nullif(current_setting('app.request_id', true), '')::uuid);
  perform app.audit(case when p_accepted then 'consent.accepted' else 'consent.withdrawn' end,
                    'consent', p_type, jsonb_build_object('version', p_version));
  return app.consent_status_json(v_uid);
end;
$$;

-- ---------------------------------------------------------------------------
-- Account bootstrap (/v1/me)
-- ---------------------------------------------------------------------------
create or replace function app.diagnosis_state(p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'status', case
      when j.id is null then 'not_submitted'
      when j.status in ('completed', 'superseded') then 'completed'
      when j.status = 'failed' then 'failed'
      else 'processing' end,
    'job_id', j.id)
  from (select 1) x
  left join app.diagnosis_submissions s on s.user_id = p_user
  left join app.ai_jobs j on j.idempotency_key = 'diagnosis:' || s.id
$$;

create or replace function app.api_me() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_profile app.profiles;
  v_diag jsonb;
  v_consent jsonb;
begin
  if v_uid is null then
    perform app.raise_api_error('UNAUTHENTICATED');
  end if;
  if not exists (select 1 from auth.users where id = v_uid and deleted_at is null) then
    perform app.raise_api_error('TOKEN_INVALID');
  end if;
  insert into app.profiles (id) values (v_uid) on conflict (id) do nothing;
  select * into v_profile from app.profiles where id = v_uid;
  if v_profile.status <> 'active' then
    perform app.raise_api_error('ACCOUNT_DELETED');
  end if;
  update app.profiles set last_active_at = now()
   where id = v_uid and (last_active_at is null or last_active_at < now() - interval '5 minutes');

  v_diag := app.diagnosis_state(v_uid);
  v_consent := app.consent_status_json(v_uid) -> 'ai_data_transfer';
  return jsonb_build_object(
    'user_id', v_uid,
    'account_status', v_profile.status,
    'created_at', app.ts(v_profile.created_at),
    'onboarding', jsonb_build_object(
      'consent_required', not (v_consent ->> 'is_valid')::boolean,
      'consent_current_version', v_consent ->> 'current_version',
      'diagnosis_status', v_diag ->> 'status',
      'diagnosis_job_id', v_diag -> 'job_id',
      'character_named', exists (select 1 from app.user_avatars where user_id = v_uid and name is not null)));
end;
$$;

-- ---------------------------------------------------------------------------
-- Question set (public, pre-registration)
-- ---------------------------------------------------------------------------
create or replace function app.api_get_current_question_set() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'version', s.version,
    'published_at', app.ts(s.published_at),
    'questions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', q.id, 'code', q.code, 'position', q.position, 'text', q.text_ja,
        'answer_type', q.answer_type, 'required', q.required,
        'purposes', to_jsonb(q.purposes),
        'constraints', jsonb_build_object(
          'min_selections', q.min_selections, 'max_selections', q.max_selections,
          'field_count', q.field_count, 'min_items', q.min_items,
          'max_items', q.max_items, 'max_chars', q.max_chars),
        'options', coalesce((
          select jsonb_agg(jsonb_build_object('id', o.id, 'code', o.code, 'position', o.position, 'label', o.label_ja)
                           order by o.position)
          from app.question_options o where o.question_id = q.id), '[]'::jsonb))
        order by q.position)
      from app.questions q where q.question_set_id = s.id), '[]'::jsonb))
  from app.question_sets s
  where s.status = 'active'
$$;

-- Question master for server-side validation (used by the API before submission).
create or replace function app.api_question_master(p_version text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'version', s.version, 'status', s.status,
    'questions', coalesce((select jsonb_agg(jsonb_build_object(
        'id', q.id, 'code', q.code, 'answer_type', q.answer_type, 'required', q.required,
        'min_selections', q.min_selections, 'max_selections', q.max_selections,
        'field_count', q.field_count, 'min_items', q.min_items, 'max_items', q.max_items,
        'max_chars', q.max_chars,
        'option_ids', coalesce((select jsonb_agg(o.id) from app.question_options o where o.question_id = q.id), '[]'::jsonb)))
      from app.questions q where q.question_set_id = s.id), '[]'::jsonb))
  from app.question_sets s where s.version = p_version
$$;

-- ---------------------------------------------------------------------------
-- Diagnosis submission (Q-3, 設計02-B)
-- p_answers: [{"question_id": uuid, "option_ids": [uuid], "texts": [text]}]
-- Detailed shape/limit validation happens in the API (validateDiagnosisAnswers);
-- this function enforces integrity, consent, version and idempotency.
-- ---------------------------------------------------------------------------
create or replace function app.submission_json(p_submission_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'submission_id', s.id,
    'client_request_id', s.client_request_id,
    'question_set_version', qs.version,
    'submitted_at', app.ts(s.submitted_at),
    'job', app.job_json(j))
  from app.diagnosis_submissions s
  join app.question_sets qs on qs.id = s.question_set_id
  join app.ai_jobs j on j.idempotency_key = 'diagnosis:' || s.id
  where s.id = p_submission_id
$$;

create or replace function app.api_submit_diagnosis(
  p_client_request_id uuid, p_question_set_version text, p_consent_version text, p_answers jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := app.require_user();
  v_existing app.diagnosis_submissions;
  v_set app.question_sets;
  v_consent_id uuid;
  v_current_consent text := app.setting_text('consent.ai_data_transfer.current_version', '');
  v_submission_id uuid;
  v_job_id uuid;
  v_bad jsonb;
begin
  -- Idempotent replay / one diagnosis per user (D-01)
  select * into v_existing from app.diagnosis_submissions where user_id = v_uid;
  if v_existing.id is not null then
    if v_existing.client_request_id = p_client_request_id then
      return app.submission_json(v_existing.id) || jsonb_build_object('replay', true);
    end if;
    perform app.raise_api_error('DIAGNOSIS_ALREADY_SUBMITTED', jsonb_build_object(
      'submission_id', v_existing.id,
      'job_id', (select id from app.ai_jobs where idempotency_key = 'diagnosis:' || v_existing.id)));
  end if;

  -- Consent (AC-2): must be accepted for the current version and match the request
  v_consent_id := app.require_valid_consent(v_uid);
  if p_consent_version <> v_current_consent then
    perform app.raise_api_error('CONSENT_VERSION_MISMATCH', jsonb_build_object('current_version', v_current_consent));
  end if;

  -- Question set version (D-02)
  select * into v_set from app.question_sets where status = 'active';
  if v_set.id is null or v_set.version <> p_question_set_version then
    perform app.raise_api_error('QUESTION_SET_OUTDATED', jsonb_build_object('current_version', v_set.version));
  end if;

  if jsonb_typeof(p_answers) <> 'array' then
    perform app.raise_api_error('VALIDATION_ERROR');
  end if;

  -- Integrity: every question belongs to the set and appears once; every option belongs to its question.
  with a as (
    select (e ->> 'question_id')::uuid as qid, e, ord
    from jsonb_array_elements(p_answers) with ordinality as t(e, ord)
  ), problems as (
    select jsonb_build_object('path', '/answers/' || (a.ord - 1), 'rule', 'question', 'message', 'unknown question') as p
      from a left join app.questions q on q.id = a.qid and q.question_set_id = v_set.id
     where q.id is null
    union all
    select jsonb_build_object('path', '/answers', 'rule', 'unique', 'message', 'question answered twice')
      from a group by qid having count(*) > 1
    union all
    select jsonb_build_object('path', '/answers/' || (a.ord - 1) || '/option_ids', 'rule', 'option', 'message', 'unknown option')
      from a cross join lateral jsonb_array_elements_text(coalesce(a.e -> 'option_ids', '[]'::jsonb)) as oid
      left join app.question_options o on o.id = oid::uuid and o.question_id = a.qid
     where o.id is null
    union all
    select jsonb_build_object('path', '/answers', 'rule', 'required', 'message', 'missing required question ' || q.code)
      from app.questions q
     where q.question_set_id = v_set.id and q.required
       and not exists (select 1 from a where a.qid = q.id)
  )
  select jsonb_agg(p) into v_bad from problems;
  if v_bad is not null then
    perform app.raise_api_error('VALIDATION_ERROR', jsonb_build_object('fields', v_bad));
  end if;

  insert into app.diagnosis_submissions (user_id, client_request_id, question_set_id, consent_id)
  values (v_uid, p_client_request_id, v_set.id, v_consent_id)
  on conflict (user_id) do nothing
  returning id into v_submission_id;

  if v_submission_id is null then
    -- Lost a race with a concurrent submission for the same user.
    select * into v_existing from app.diagnosis_submissions where user_id = v_uid;
    if v_existing.client_request_id = p_client_request_id then
      return app.submission_json(v_existing.id) || jsonb_build_object('replay', true);
    end if;
    perform app.raise_api_error('DIAGNOSIS_ALREADY_SUBMITTED', jsonb_build_object('submission_id', v_existing.id));
  end if;

  insert into app.diagnosis_answers (submission_id, question_id, value_index, option_id, text_value)
  select v_submission_id, (e ->> 'question_id')::uuid, (o.ord - 1)::integer, o.val::uuid, null
    from jsonb_array_elements(p_answers) e
    cross join lateral jsonb_array_elements_text(coalesce(e -> 'option_ids', '[]'::jsonb)) with ordinality as o(val, ord)
  union all
  select v_submission_id, (e ->> 'question_id')::uuid, (t.ord - 1)::integer, null, t.val
    from jsonb_array_elements(p_answers) e
    cross join lateral jsonb_array_elements_text(coalesce(e -> 'texts', '[]'::jsonb)) with ordinality as t(val, ord)
   where length(btrim(t.val)) > 0;

  insert into app.ai_jobs (user_id, kind, idempotency_key, payload, max_attempts)
  values (v_uid, 'diagnosis_generation', 'diagnosis:' || v_submission_id,
          jsonb_build_object('submission_id', v_submission_id, 'consent_id', v_consent_id),
          app.setting_int('ai.jobs.max_attempts', 3))
  returning id into v_job_id;

  insert into app.user_growth (user_id, rule_version)
  values (v_uid, app.setting_text('growth.level_rule_version', 'level-v1'))
  on conflict (user_id) do nothing;

  perform pgmq.send('ai_jobs', jsonb_build_object('job_id', v_job_id));
  perform app.audit('diagnosis.submitted', 'diagnosis_submission', v_submission_id::text,
                    jsonb_build_object('question_set_version', v_set.version, 'answer_count', jsonb_array_length(p_answers)));

  return app.submission_json(v_submission_id) || jsonb_build_object('replay', false);
end;
$$;

create or replace function app.api_current_submission() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := app.require_user();
  v_id uuid;
begin
  select id into v_id from app.diagnosis_submissions where user_id = v_uid;
  if v_id is null then
    perform app.raise_api_error('NOT_FOUND');
  end if;
  return app.submission_json(v_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Generation jobs
-- ---------------------------------------------------------------------------
create or replace function app.api_get_job(p_job_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := app.require_user();
  v_job app.ai_jobs;
begin
  select * into v_job from app.ai_jobs where id = p_job_id and user_id = v_uid;
  if v_job.id is null then
    perform app.raise_api_error('JOB_NOT_FOUND');
  end if;
  return app.job_json(v_job);
end;
$$;

create or replace function app.api_retry_job(p_job_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := app.require_user();
  v_job app.ai_jobs;
begin
  select * into v_job from app.ai_jobs where id = p_job_id and user_id = v_uid for update;
  if v_job.id is null then
    perform app.raise_api_error('JOB_NOT_FOUND');
  end if;
  if v_job.status <> 'failed' then
    perform app.raise_api_error('JOB_NOT_RETRYABLE', jsonb_build_object('status', v_job.status));
  end if;
  if v_job.manual_retries >= app.setting_int('ai.jobs.max_manual_retries', 3) then
    perform app.raise_api_error('JOB_RETRY_LIMIT_REACHED');
  end if;
  perform app.require_valid_consent(v_uid);

  update app.ai_jobs
     set status = 'retrying', attempts = 0, manual_retries = manual_retries + 1,
         next_attempt_at = now(), locked_until = null, lock_token = null,
         last_error_code = null, last_error_detail = null
   where id = v_job.id
  returning * into v_job;
  perform pgmq.send('ai_jobs', jsonb_build_object('job_id', v_job.id));
  perform app.audit('generation_job.manual_retry', 'ai_job', v_job.id::text);
  return app.job_json(v_job);
end;
$$;

-- ---------------------------------------------------------------------------
-- Character, profile and growth
-- ---------------------------------------------------------------------------
create or replace function app.character_json(p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', a.id,
    'character_id', a.character_code,
    'name', a.name,
    'species', a.species,
    'character_class', a.character_class,
    'element', a.element,
    'rarity', a.rarity,
    'title', a.title,
    'personality', a.personality,
    'strengths', a.strengths,
    'weaknesses', a.weaknesses,
    'skills', a.skills,
    'stats', a.stats,
    'visual_elements', a.visual_elements,
    'level', app.user_level(a.user_id),
    'image', app.image_ref_json(a.current_image_path, a.image_status, a.current_image_stage, a.image_updated_at),
    'created_at', app.ts(a.created_at))
  from app.user_avatars a where a.user_id = p_user
$$;

create or replace function app.growth_json(p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  with g as (
    select coalesce(ug.total_exp, 0) as total_exp, coalesce(ug.gut_points, 0) as gut_points,
           coalesce(ug.level, 1) as level,
           coalesce(ug.rule_version, app.setting_text('growth.level_rule_version', 'level-v1')) as rule_version
    from (select 1) x left join app.user_growth ug on ug.user_id = p_user
  ), c as (
    select g.*,
           app.setting_int('growth.max_level', 100) as max_level,
           app.setting_int('growth.evolution.interval_levels', 5) as interval_levels,
           (select exp_required from app.level_rules where rule_version = g.rule_version and level = g.level) as cur_exp,
           (select exp_required from app.level_rules where rule_version = g.rule_version and level = g.level + 1) as next_exp
    from g
  )
  select jsonb_build_object(
    'level', c.level,
    'max_level', c.max_level,
    'total_exp', c.total_exp,
    'gut_points', c.gut_points,
    'current_level_exp', coalesce(c.cur_exp, 0),
    'next_level_exp', case when c.level >= c.max_level then null else c.next_exp end,
    'exp_to_next_level', case when c.level >= c.max_level or c.next_exp is null then null
                              else greatest(c.next_exp - c.total_exp, 0) end,
    'progress_ratio', case when c.level >= c.max_level or c.next_exp is null or c.next_exp = c.cur_exp then 1
                           else round(least(1, greatest(0, (c.total_exp - c.cur_exp)::numeric / (c.next_exp - c.cur_exp))), 4) end,
    'evolution_interval_levels', c.interval_levels,
    'next_evolution_level', case when (c.level / c.interval_levels + 1) * c.interval_levels > c.max_level then null
                                 else (c.level / c.interval_levels + 1) * c.interval_levels end,
    'image_status', coalesce((select image_status from app.user_avatars where user_id = p_user), 'none'),
    'rule_version', c.rule_version)
  from c
$$;

create or replace function app.answers_display_json(p_user uuid, p_public_only boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'question_code', x.code, 'label', x.profile_label, 'values', x.vals) order by x.position), '[]'::jsonb)
  from (
    select q.code, q.profile_label, q.position,
           jsonb_agg(coalesce(o.label_ja, a.text_value) order by a.value_index) as vals
    from app.diagnosis_submissions s
    join app.diagnosis_answers a on a.submission_id = s.id
    join app.questions q on q.id = a.question_id
    left join app.question_options o on o.id = a.option_id
    where s.user_id = p_user
      and 'profile_display' = any (q.purposes)
      and (not p_public_only or q.public_display)
    group by q.code, q.profile_label, q.position
  ) x
$$;

create or replace function app.favorites_json(p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'works', coalesce((select jsonb_agg(distinct jsonb_build_object('id', w.id, 'name', w.title))
                       from app.profile_features f join app.anime_works w on w.id = f.work_id
                       where f.user_id = p_user and f.question_code = 'Q1'), '[]'::jsonb),
    'characters', coalesce((select jsonb_agg(distinct jsonb_build_object('id', c.id, 'name', c.name))
                       from app.profile_features f join app.anime_characters c on c.id = f.character_id
                       where f.user_id = p_user and f.question_code = 'Q3'), '[]'::jsonb),
    'world_settings', coalesce((select jsonb_agg(distinct jsonb_build_object('id', t.id, 'name', t.name))
                       from app.profile_features f join app.tags t on t.id = f.tag_id
                       where f.user_id = p_user and f.question_code = 'Q11'), '[]'::jsonb))
$$;

create or replace function app.api_my_profile() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := app.require_user();
  v_profile app.profiles;
begin
  select * into v_profile from app.profiles where id = v_uid;
  return jsonb_build_object(
    'user_id', v_uid,
    'display_name', (select name from app.user_avatars where user_id = v_uid),
    'account_status', v_profile.status,
    'diagnosis', app.diagnosis_state(v_uid),
    'character', app.character_json(v_uid),
    'ai_profile', v_profile.ai_profile,
    'answers_display', app.answers_display_json(v_uid, false),
    'favorites', app.favorites_json(v_uid),
    'growth', app.growth_json(v_uid));
end;
$$;

create or replace function app.api_my_character() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := app.require_user();
  v_json jsonb;
begin
  v_json := app.character_json(v_uid);
  if v_json is null then
    perform app.raise_api_error('CHARACTER_NOT_READY', jsonb_build_object('diagnosis', app.diagnosis_state(v_uid)));
  end if;
  return v_json;
end;
$$;

-- Case-insensitive substring match against a deny-list setting.
create or replace function app.text_hits_denylist(p_text text, p_setting_key text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from jsonb_array_elements_text(coalesce(app.setting(p_setting_key), '[]'::jsonb)) w
    where length(w) > 0 and position(lower(w) in lower(p_text)) > 0)
$$;

-- p_name is NFKC-normalized and trimmed by the API.
create or replace function app.api_rename_character(p_name text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := app.require_user();
  v_min integer := app.setting_int('profile.character_name.min_length', 1);
  v_max integer := app.setting_int('profile.character_name.max_length', 20);
begin
  if not exists (select 1 from app.user_avatars where user_id = v_uid) then
    perform app.raise_api_error('CHARACTER_NOT_READY');
  end if;
  if p_name is null or char_length(p_name) < v_min or char_length(p_name) > v_max
     or p_name ~ '[[:cntrl:]]' or p_name ~* '(https?://|www\.)' then
    perform app.raise_api_error('CHARACTER_NAME_INVALID', jsonb_build_object('min_length', v_min, 'max_length', v_max));
  end if;
  if app.text_hits_denylist(p_name, 'profile.character_name.denylist')
     or app.text_hits_denylist(p_name, 'moderation.local_denylist') then
    insert into app.moderation_events (target_type, target_id, source, flagged, action, actor_id)
    values ('character_name', (select id from app.user_avatars where user_id = v_uid), 'local_filter', true, 'rejected', v_uid);
    perform app.raise_api_error('CHARACTER_NAME_REJECTED');
  end if;
  update app.user_avatars set name = p_name, name_updated_at = now() where user_id = v_uid;
  perform app.audit('character.renamed', 'user_avatar', v_uid::text);
  return app.character_json(v_uid);
end;
$$;

create or replace function app.api_growth() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  return app.growth_json(app.require_user());
end;
$$;

-- Another user's public profile. 404 if the target blocked the caller (I-01).
create or replace function app.api_public_profile(p_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := app.require_user();
  v_blocked_by_me boolean;
begin
  if not exists (select 1 from app.profiles where id = p_user_id and status = 'active')
     or exists (select 1 from app.blocks where blocker_id = p_user_id and blocked_id = v_uid) then
    perform app.raise_api_error('USER_NOT_FOUND');
  end if;
  v_blocked_by_me := exists (select 1 from app.blocks where blocker_id = v_uid and blocked_id = p_user_id);
  return jsonb_build_object(
    'user', app.user_summary_json(p_user_id),
    'character', (select jsonb_build_object(
        'character_id', a.character_code, 'name', a.name, 'title', a.title, 'species', a.species,
        'element', a.element, 'rarity', a.rarity, 'level', app.user_level(p_user_id))
      from app.user_avatars a where a.user_id = p_user_id),
    'favorites', app.favorites_json(p_user_id),
    'answers_display', app.answers_display_json(p_user_id, true),
    'is_blocked_by_me', v_blocked_by_me,
    'can_message', p_user_id <> v_uid and not v_blocked_by_me);
end;
$$;

-- ---------------------------------------------------------------------------
-- Client configuration (public)
-- ---------------------------------------------------------------------------
create or replace function app.api_client_config() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'consent', jsonb_build_object('ai_data_transfer', jsonb_build_object(
      'current_version', app.setting_text('consent.ai_data_transfer.current_version', ''))),
    'question_set', jsonb_build_object('current_version', (select version from app.question_sets where status = 'active')),
    'chat', jsonb_build_object(
      'message_max_chars', app.setting_int('chat.message.max_chars', 1000),
      'history_max_messages', jsonb_build_object(
        'guild', app.setting_int('chat.history.guild_max_messages', 1000),
        'dm', app.setting_int('chat.history.dm_max_messages', 1000),
        'navigator', app.setting_int('navigator.history.max_messages', 200))),
    'attachments', jsonb_build_object(
      'allowed_mime_types', app.setting('attachments.allowed_mime_types'),
      'max_bytes', app.setting_int('attachments.max_bytes', 10485760),
      'upload_url_ttl_seconds', app.setting_int('attachments.upload_url_ttl_seconds', 600),
      'download_url_ttl_seconds', app.setting_int('attachments.download_url_ttl_seconds', 3600)),
    'character_name', jsonb_build_object(
      'min_length', app.setting_int('profile.character_name.min_length', 1),
      'max_length', app.setting_int('profile.character_name.max_length', 20)),
    'growth', jsonb_build_object(
      'max_level', app.setting_int('growth.max_level', 100),
      'evolution_interval_levels', app.setting_int('growth.evolution.interval_levels', 5)),
    'navigator', jsonb_build_object(
      'max_chars', app.setting_int('navigator.max_chars', 500),
      'daily_limit', app.setting_int('navigator.daily_limit', 30),
      'default_suggestions', coalesce(app.setting('navigator.default_suggestions'), '[]'::jsonb),
      'fallback_message', app.setting_text('navigator.fallback_message', '')),
    'reports', jsonb_build_object(
      'reason_codes', coalesce(app.setting('reports.reason_codes'), '[]'::jsonb),
      'target_types', '["message","attachment","navigator_message","avatar_image","user"]'::jsonb),
    'realtime', jsonb_build_object(
      'conversation_topic_format', 'conv:{conversation_id}',
      'user_topic_format', 'user:{user_id}',
      'event_types', '["message.created","message.deleted","reaction.updated","notification.created","conversation.updated","growth.updated","generation.updated"]'::jsonb),
    'client_retry', jsonb_build_object(
      'request_timeout_seconds', app.setting_int('client.request_timeout_seconds', 15),
      'retry_delays_seconds', coalesce(app.setting('client.retry_delays_seconds'), '[2,5]'::jsonb)),
    'polling', jsonb_build_object(
      'generation_job_interval_seconds', app.setting_int('client.generation_poll_seconds', 3)))
$$;
