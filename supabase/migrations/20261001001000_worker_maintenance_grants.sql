-- Service-role functions used by the worker (job lease/state machine, stage
-- persistence, AI run logging), maintenance, operator moderation actions, and
-- the final EXECUTE grants.

-- ---------------------------------------------------------------------------
-- Job lifecycle
-- ---------------------------------------------------------------------------
-- Lease a job for processing. Returns null when the job is terminal, leased by
-- another worker, or not yet due (duplicate queue deliveries are therefore safe).
create or replace function app.svc_claim_job(p_job_id uuid, p_lease_seconds integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  j app.ai_jobs;
begin
  update app.ai_jobs
     set locked_until = now() + make_interval(secs => p_lease_seconds), lock_token = gen_random_uuid()
   where id = p_job_id
     and status not in ('completed', 'failed', 'superseded')
     and (locked_until is null or locked_until < now())
     and next_attempt_at <= now()
  returning * into j;
  if j.id is null then
    select * into j from app.ai_jobs where id = p_job_id;
    return jsonb_build_object('claimed', false, 'status', j.status,
      'next_attempt_at', app.ts(j.next_attempt_at), 'locked_until', app.ts(j.locked_until), 'exists', j.id is not null);
  end if;
  return jsonb_build_object('claimed', true, 'job', to_jsonb(j));
end;
$$;

create or replace function app.check_lock(p_job_id uuid, p_lock uuid) returns app.ai_jobs
language plpgsql security definer set search_path = '' as $$
declare
  j app.ai_jobs;
begin
  select * into j from app.ai_jobs where id = p_job_id for update;
  if j.id is null or j.lock_token is distinct from p_lock then
    raise exception 'LEASE_LOST' using errcode = 'CNM02';
  end if;
  return j;
end;
$$;

create or replace function app.svc_update_job(p_job_id uuid, p_lock uuid, p_status text, p_stage_patch jsonb, p_extend_seconds integer)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app.check_lock(p_job_id, p_lock);
  update app.ai_jobs
     set status = coalesce(p_status, status),
         stage_state = stage_state || coalesce(p_stage_patch, '{}'::jsonb),
         locked_until = case when p_extend_seconds is null then locked_until
                             else now() + make_interval(secs => p_extend_seconds) end
   where id = p_job_id;
end;
$$;

-- Record a failure. Retryable failures are rescheduled with backoff and re-queued;
-- otherwise the job fails (manual retry possible, D-09).
create or replace function app.svc_fail_job(p_job_id uuid, p_lock uuid, p_error_code text, p_detail text, p_retryable boolean,
                                            p_delay_seconds integer default null)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  j app.ai_jobs;
  v_backoff jsonb := coalesce(app.setting('ai.jobs.backoff_seconds'), '[30,120,600]'::jsonb);
  v_delay integer;
begin
  j := app.check_lock(p_job_id, p_lock);
  if p_retryable and (p_delay_seconds is not null or j.attempts + 1 < j.max_attempts) then
    v_delay := coalesce(p_delay_seconds,
                        (v_backoff ->> least(j.attempts, jsonb_array_length(v_backoff) - 1))::integer, 60);
    update app.ai_jobs
       set status = 'retrying',
           attempts = attempts + case when p_delay_seconds is null then 1 else 0 end,
           next_attempt_at = now() + make_interval(secs => v_delay),
           locked_until = null, lock_token = null,
           last_error_code = p_error_code, last_error_detail = left(p_detail, 500)
     where id = p_job_id;
    perform pgmq.send('ai_jobs', jsonb_build_object('job_id', p_job_id), v_delay);
    return 'retrying';
  end if;
  update app.ai_jobs
     set status = 'failed', attempts = attempts + 1, locked_until = null, lock_token = null,
         last_error_code = p_error_code, last_error_detail = left(p_detail, 500)
   where id = p_job_id;
  if j.kind = 'diagnosis_generation' then
    perform app.notify(j.user_id, 'generation_failed', null, jsonb_build_object('job_id', j.id, 'kind', j.kind));
  end if;
  update app.user_avatars set image_status = case when current_image_path is null then 'failed' else 'ready' end
   where user_id = j.user_id and image_status = 'generating';
  return 'failed';
end;
$$;

create or replace function app.svc_complete_job(p_job_id uuid, p_lock uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  j app.ai_jobs;
begin
  j := app.check_lock(p_job_id, p_lock);
  update app.ai_jobs
     set status = 'completed', completed_at = now(), locked_until = null, lock_token = null,
         last_error_code = null, last_error_detail = null
   where id = p_job_id;
  if j.kind = 'diagnosis_generation' then
    perform app.notify(j.user_id, 'generation_completed', null, jsonb_build_object('job_id', j.id));
  else
    perform app.notify(j.user_id, 'character_evolved', null,
      jsonb_build_object('job_id', j.id, 'stage_level', (j.payload ->> 'stage_level')::integer));
  end if;
end;
$$;

create or replace function app.svc_supersede_job(p_job_id uuid, p_lock uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app.check_lock(p_job_id, p_lock);
  update app.ai_jobs set status = 'superseded', completed_at = now(), locked_until = null, lock_token = null
   where id = p_job_id;
end;
$$;

create or replace function app.on_ai_job_status() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status is distinct from old.status then
    perform app.broadcast('user:' || new.user_id, 'generation.updated',
      jsonb_build_object('job_id', new.id, 'kind', new.kind, 'status', new.status, 'error_code', new.last_error_code));
  end if;
  return null;
end;
$$;
create trigger ai_jobs_broadcast after update of status on app.ai_jobs
  for each row execute function app.on_ai_job_status();

-- ---------------------------------------------------------------------------
-- Queue access for the worker (service_role needs no direct pgmq privileges)
-- ---------------------------------------------------------------------------
create or replace function app.svc_queue_read(p_vt_seconds integer, p_qty integer)
returns table (msg_id bigint, job_id text, read_ct integer)
language sql security definer set search_path = '' as $$
  select r.msg_id, r.message ->> 'job_id', r.read_ct from pgmq.read('ai_jobs', p_vt_seconds, p_qty) r
$$;

create or replace function app.svc_queue_archive(p_msg_id bigint) returns boolean
language sql security definer set search_path = '' as $$
  select pgmq.archive('ai_jobs', p_msg_id)
$$;

create or replace function app.svc_queue_defer(p_msg_id bigint, p_seconds integer) returns void
language sql security definer set search_path = '' as $$
  select null from pgmq.set_vt('ai_jobs', p_msg_id, p_seconds)
$$;

create or replace function app.svc_queue_depth() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('queue_length', m.queue_length, 'oldest_msg_age_sec', m.oldest_msg_age_sec,
                            'total_messages', m.total_messages)
  from pgmq.metrics('ai_jobs') m
$$;

-- ---------------------------------------------------------------------------
-- Job context for the worker (ids and answer values only; no account data)
-- ---------------------------------------------------------------------------
create or replace function app.svc_job_context(p_job_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  j app.ai_jobs;
  v_consent_ok boolean;
  v_answers jsonb;
  v_submission uuid;
begin
  select * into j from app.ai_jobs where id = p_job_id;
  if j.id is null then
    return null;
  end if;
  v_consent_ok := coalesce((app.consent_status_json(j.user_id) -> 'ai_data_transfer' ->> 'is_valid')::boolean, false)
                  and exists (select 1 from app.profiles where id = j.user_id and status = 'active');
  v_submission := (select id from app.diagnosis_submissions where user_id = j.user_id);

  select jsonb_agg(jsonb_build_object(
           'question_id', q.id, 'question_code', q.code, 'answer_type', q.answer_type,
           'label', q.profile_label, 'purposes', to_jsonb(q.purposes),
           'normalization_target', q.normalization_target,
           'values', (select jsonb_agg(case when a.option_id is not null
                                       then jsonb_build_object('option_id', o.id, 'option_code', o.code, 'label', o.label_ja, 'attributes', o.attributes)
                                       else jsonb_build_object('text', a.text_value) end order by a.value_index)
                      from app.diagnosis_answers a left join app.question_options o on o.id = a.option_id
                      where a.submission_id = v_submission and a.question_id = q.id))
         order by q.position)
    into v_answers
  from app.questions q
  where exists (select 1 from app.diagnosis_answers a where a.submission_id = v_submission and a.question_id = q.id);

  return jsonb_build_object(
    'job', to_jsonb(j) - 'lock_token',
    'user_id', j.user_id,
    'consent_valid', v_consent_ok,
    'submission_id', v_submission,
    'answers', coalesce(v_answers, '[]'::jsonb),
    'avatar', (select to_jsonb(a) from app.user_avatars a where a.user_id = j.user_id),
    'growth', (select to_jsonb(g) from app.user_growth g where g.user_id = j.user_id),
    'has_recommendations', exists (select 1 from app.recommendations where user_id = j.user_id and kind = 'anime'),
    'feature_count', (select count(*) from app.profile_features where user_id = j.user_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- Normalization support
-- ---------------------------------------------------------------------------
-- Exact alias lookup. p_kind: anime_work | anime_character | genre | world_setting.
-- Returns {"<normalized>": [ids...]} for every input that has at least one match.
create or replace function app.svc_alias_lookup(p_kind text, p_values text[]) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(v, ids), '{}'::jsonb) from (
    select x.v, jsonb_agg(distinct x.id) as ids from (
      select wa.alias_normalized as v, wa.work_id as id from app.work_aliases wa
        join app.anime_works w on w.id = wa.work_id and w.status = 'active'
       where p_kind = 'anime_work' and wa.alias_normalized = any (p_values)
      union all
      select ca.alias_normalized, ca.character_id from app.character_aliases ca
        join app.anime_characters c on c.id = ca.character_id and c.status = 'active'
       where p_kind = 'anime_character' and ca.alias_normalized = any (p_values)
      union all
      select ta.alias_normalized, ta.tag_id from app.tag_aliases ta
        join app.tags t on t.id = ta.tag_id
       where p_kind in ('genre', 'world_setting') and t.kind = p_kind and ta.alias_normalized = any (p_values)
    ) x group by x.v
  ) y
$$;

-- Trigram-prefiltered candidates for AI normalization (D-04).
create or replace function app.svc_text_candidates(p_kind text, p_value text, p_limit integer, p_min_similarity real)
returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'similarity', round(sim::numeric, 3)) order by sim desc, name), '[]'::jsonb)
  from (
    select id, name, max(sim) as sim from (
      select w.id, w.title as name, extensions.similarity(wa.alias_normalized, p_value) as sim
        from app.work_aliases wa join app.anime_works w on w.id = wa.work_id and w.status = 'active'
       where p_kind = 'anime_work' and extensions.similarity(wa.alias_normalized, p_value) >= p_min_similarity
      union all
      select c.id, c.name, extensions.similarity(ca.alias_normalized, p_value)
        from app.character_aliases ca join app.anime_characters c on c.id = ca.character_id and c.status = 'active'
       where p_kind = 'anime_character' and extensions.similarity(ca.alias_normalized, p_value) >= p_min_similarity
      union all
      select t.id, t.name, extensions.similarity(ta.alias_normalized, p_value)
        from app.tag_aliases ta join app.tags t on t.id = ta.tag_id
       where p_kind in ('genre', 'world_setting') and t.kind = p_kind
         and extensions.similarity(ta.alias_normalized, p_value) >= p_min_similarity
    ) s group by id, name
    order by max(sim) desc, name limit p_limit
  ) c
$$;

-- Replace the normalized features of a submission (idempotent).
-- p_features: [{question_code, feature_kind, match_key, work_id?, character_id?, tag_id?, option_id?, resolution, confidence?}]
create or replace function app.svc_save_features(p_submission_id uuid, p_features jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
  v_count integer;
begin
  select user_id into v_user from app.diagnosis_submissions where id = p_submission_id;
  if v_user is null then
    raise exception 'unknown submission %', p_submission_id;
  end if;
  delete from app.profile_features where submission_id = p_submission_id;
  insert into app.profile_features (user_id, submission_id, question_code, feature_kind, match_key,
                                    work_id, character_id, tag_id, option_id, resolution, confidence)
  select v_user, p_submission_id, f ->> 'question_code', f ->> 'feature_kind', f ->> 'match_key',
         (f ->> 'work_id')::uuid, (f ->> 'character_id')::uuid, (f ->> 'tag_id')::uuid, (f ->> 'option_id')::uuid,
         f ->> 'resolution', (f ->> 'confidence')::numeric
  from jsonb_array_elements(p_features) f
  on conflict (user_id, question_code, match_key) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Character persistence
-- ---------------------------------------------------------------------------
-- Upsert the single character (1 per user). The character code is assigned once.
create or replace function app.svc_save_profile(p_user uuid, p_avatar jsonb, p_ai_profile jsonb, p_attributes_version text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_code text;
  v_try integer := 0;
begin
  loop
    begin
      insert into app.user_avatars (user_id, character_code, attributes_version)
      values (p_user, app.new_character_code(), p_attributes_version)
      on conflict (user_id) do nothing;
      exit;
    exception when unique_violation then
      v_try := v_try + 1;
      if v_try > 5 then raise; end if;
    end;
  end loop;

  update app.user_avatars set
    species = p_avatar ->> 'species',
    character_class = p_avatar ->> 'character_class',
    element = p_avatar ->> 'element',
    rarity = p_avatar ->> 'rarity',
    title = p_avatar ->> 'title',
    personality = p_avatar ->> 'personality',
    strengths = coalesce(p_avatar -> 'strengths', '[]'::jsonb),
    weaknesses = coalesce(p_avatar -> 'weaknesses', '[]'::jsonb),
    skills = coalesce(p_avatar -> 'skills', '[]'::jsonb),
    stats = coalesce(p_avatar -> 'stats', '{}'::jsonb),
    visual_elements = coalesce(p_avatar -> 'visual_elements', '{}'::jsonb),
    visual_description = p_avatar ->> 'visual_description',
    attributes_version = p_attributes_version
  where user_id = p_user
  returning character_code into v_code;

  update app.profiles set ai_profile = p_ai_profile where id = p_user;
  insert into app.user_growth (user_id, rule_version)
  values (p_user, app.setting_text('growth.level_rule_version', 'level-v1')) on conflict (user_id) do nothing;
  return jsonb_build_object('character_code', v_code);
end;
$$;

create or replace function app.svc_set_image_status(p_user uuid, p_status text) returns void
language sql security definer set search_path = '' as $$
  update app.user_avatars set image_status = p_status where user_id = p_user
$$;

-- Point the character at a newly stored image. Returns the superseded object path
-- to delete, unless it is under evidence hold (G-05).
create or replace function app.svc_set_avatar_image(p_user uuid, p_path text, p_stage integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  a app.user_avatars;
begin
  select * into a from app.user_avatars where user_id = p_user for update;
  if a.id is null then
    raise exception 'no character for %', p_user;
  end if;
  if a.current_image_stage is not null and a.current_image_stage > p_stage and a.current_image_path is not null then
    -- A newer stage is already current; the caller should delete its own upload.
    return jsonb_build_object('applied', false, 'delete_path', p_path);
  end if;
  update app.user_avatars
     set current_image_path = p_path, current_image_stage = p_stage, image_status = 'ready',
         image_updated_at = now(), image_legal_hold = false
   where user_id = p_user;
  return jsonb_build_object('applied', true,
    'delete_path', case when a.current_image_path is not null and a.current_image_path <> p_path and not a.image_legal_hold
                        then a.current_image_path end);
end;
$$;

-- Persist ≤N anime recommendations. Every work must be in the current candidate set.
create or replace function app.svc_save_anime_recommendations(p_user uuid, p_job_id uuid, p_items jsonb, p_rule_version text)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_candidates jsonb := app.svc_anime_candidates(p_user) -> 'candidates';
  v_limit integer := coalesce((app.svc_anime_candidates(p_user) ->> 'result_limit')::integer, 3);
  v_bad integer;
begin
  if jsonb_array_length(p_items) > v_limit then
    raise exception 'too many recommendations' using errcode = 'CNM03';
  end if;
  select count(*) into v_bad
  from jsonb_array_elements(p_items) i
  where not exists (select 1 from jsonb_array_elements(v_candidates) c where c ->> 'work_id' = i ->> 'work_id');
  if v_bad > 0 then
    raise exception 'recommendation outside candidate set' using errcode = 'CNM03';
  end if;
  delete from app.recommendations where user_id = p_user and kind = 'anime';
  insert into app.recommendations (user_id, kind, rank, work_id, score, reason, reason_source, rule_version, job_id)
  select p_user, 'anime', (i ->> 'rank')::integer, (i ->> 'work_id')::uuid, (i ->> 'score')::numeric,
         i ->> 'reason', i ->> 'reason_source', p_rule_version, p_job_id
  from jsonb_array_elements(p_items) i;
  return jsonb_array_length(p_items);
end;
$$;

-- ---------------------------------------------------------------------------
-- AI run log and budget
-- ---------------------------------------------------------------------------
create or replace function app.svc_record_ai_run(p_run jsonb) returns uuid
language sql security definer set search_path = '' as $$
  insert into app.ai_runs (job_id, user_id, purpose, provider, model, prompt_version, input_hash, output_schema_version,
                           status, error_code, latency_ms, usage, estimated_cost_usd, retry_count, safety)
  values ((p_run ->> 'job_id')::uuid, (p_run ->> 'user_id')::uuid, p_run ->> 'purpose', p_run ->> 'provider',
          p_run ->> 'model', p_run ->> 'prompt_version', p_run ->> 'input_hash', p_run ->> 'output_schema_version',
          p_run ->> 'status', p_run ->> 'error_code', (p_run ->> 'latency_ms')::integer,
          coalesce(p_run -> 'usage', '{}'::jsonb), (p_run ->> 'estimated_cost_usd')::numeric,
          coalesce((p_run ->> 'retry_count')::integer, 0), coalesce(p_run -> 'safety', '{}'::jsonb))
  returning id
$$;

create or replace function app.svc_ai_budget_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'spent_today_usd', coalesce((select sum(estimated_cost_usd) from app.ai_runs
                                 where created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'), 0),
    'daily_budget_usd', coalesce((app.setting('ai.budget.daily_usd') #>> '{}')::numeric, 0))
$$;

-- AI configuration for the worker / API (models, prompts, timeouts, pricing).
create or replace function app.svc_ai_config() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'settings', (select jsonb_object_agg(key, value) from app.app_settings where key like 'ai.%' or key like 'moderation.%' or key like 'navigator.%'
                                           or key like 'avatars.%' or key like 'character.%'),
    'prompts', (select jsonb_object_agg(purpose, jsonb_build_object('version', version, 'system_prompt', system_prompt,
                                                                    'output_schema_version', output_schema_version))
                from app.prompt_versions where status = 'active'))
$$;

-- ---------------------------------------------------------------------------
-- Maintenance
-- ---------------------------------------------------------------------------
-- Safety net for lost queue messages: re-send due, unleased, non-terminal jobs.
create or replace function app.svc_requeue_stalled_jobs() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  n integer := 0;
begin
  for r in select id from app.ai_jobs
           where status not in ('completed', 'failed', 'superseded')
             and next_attempt_at <= now() - interval '2 minutes'
             and (locked_until is null or locked_until < now())
           limit 100 loop
    perform pgmq.send('ai_jobs', jsonb_build_object('job_id', r.id));
    n := n + 1;
  end loop;
  return n;
end;
$$;

create or replace function app.svc_cleanup_orphan_attachments() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_objects jsonb;
begin
  with gone as (
    update app.message_attachments
       set status = 'deleted', deleted_at = now()
     where status in ('pending', 'ready') and not legal_hold
       and created_at < now() - make_interval(hours => app.setting_int('attachments.orphan_ttl_hours', 24))
    returning bucket, object_path
  )
  select coalesce(jsonb_agg(jsonb_build_object('bucket', bucket, 'path', object_path)), '[]'::jsonb) into v_objects from gone;
  return v_objects;
end;
$$;

-- Delete messages outside the retention window (C-5, F-07) unless held as evidence.
create or replace function app.svc_purge_history() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_objects jsonb := '[]'::jsonb;
  v_msgs integer := 0;
  v_nav integer := 0;
  v_keep integer := app.setting_int('navigator.history.max_messages', 200);
begin
  drop table if exists pg_temp.purge_msg;
  create temporary table purge_msg on commit drop as
    select m.id, m.attachment_id from app.messages m join app.conversations c on c.id = m.conversation_id
    where m.seq <= app.history_floor_seq(c) and not m.legal_hold;
  select coalesce(jsonb_agg(jsonb_build_object('bucket', a.bucket, 'path', a.object_path)), '[]'::jsonb) into v_objects
    from app.message_attachments a join purge_msg p on p.attachment_id = a.id
   where a.status <> 'deleted' and not a.legal_hold;
  delete from app.messages m using purge_msg p where m.id = p.id;
  get diagnostics v_msgs = row_count;
  update app.message_attachments a set status = 'deleted', deleted_at = now()
    from purge_msg p where p.attachment_id = a.id and a.status <> 'deleted' and not a.legal_hold;

  delete from app.navigator_messages n
   where not n.legal_hold
     and n.id not in (select id from (select id, row_number() over (partition by user_id order by created_at desc, id desc) rn
                                       from app.navigator_messages) r where r.rn <= v_keep);
  get diagnostics v_nav = row_count;
  return jsonb_build_object('messages_deleted', v_msgs, 'navigator_deleted', v_nav, 'objects', v_objects);
end;
$$;

-- Release evidence holds once no open report refers to the item and the retention
-- period after resolution has passed (I-04). Then re-scrub deleted accounts.
create or replace function app.svc_release_evidence_holds() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_days integer := app.setting_int('retention.evidence_days_after_resolution', 90);
  v_objects jsonb := '[]'::jsonb;
begin
  drop table if exists pg_temp.releasable;
  create temporary table releasable on commit drop as
    select target_type, target_id from app.reports
    group by target_type, target_id
    having bool_and(status in ('resolved', 'dismissed') and resolved_at < now() - make_interval(days => v_days));

  update app.messages m set legal_hold = false
    from releasable r where r.target_type = 'message' and r.target_id = m.id and m.legal_hold;
  update app.message_attachments a set legal_hold = false
    from releasable r where r.target_type in ('attachment') and r.target_id = a.id and a.legal_hold;
  update app.message_attachments a set legal_hold = false
    from releasable r join app.messages m on r.target_type = 'message' and r.target_id = m.id
   where a.id = m.attachment_id and a.legal_hold;
  update app.navigator_messages n set legal_hold = false
    from releasable r where r.target_type = 'navigator_message' and (r.target_id = n.id
          or n.id = (select reply_to from app.navigator_messages x where x.id = r.target_id)) and n.legal_hold;
  update app.user_avatars av set image_legal_hold = false
    from releasable r where r.target_type = 'avatar_image' and r.target_id = av.user_id and av.image_legal_hold;

  -- Content of deleted accounts that was retained only as evidence.
  select coalesce(jsonb_agg(jsonb_build_object('bucket', a.bucket, 'path', a.object_path)), '[]'::jsonb) into v_objects
    from app.message_attachments a join app.profiles p on p.id = a.uploader_id and p.status = 'deleted'
   where a.status <> 'deleted' and not a.legal_hold;
  update app.message_attachments a set status = 'deleted', deleted_at = now()
    from app.profiles p where p.id = a.uploader_id and p.status = 'deleted' and a.status <> 'deleted' and not a.legal_hold;
  update app.messages m set body = null, deleted_at = coalesce(m.deleted_at, now()), deleted_reason = 'account_deleted'
    from app.profiles p where p.id = m.sender_id and p.status = 'deleted' and not m.legal_hold and m.body is not null;
  delete from app.navigator_messages n using app.profiles p where p.id = n.user_id and p.status = 'deleted' and not n.legal_hold;
  select v_objects || coalesce(jsonb_agg(jsonb_build_object('bucket', app.setting_text('avatars.bucket', 'avatars'), 'path', av.current_image_path)), '[]'::jsonb)
    into v_objects
    from app.user_avatars av join app.profiles p on p.id = av.user_id and p.status = 'deleted'
   where not av.image_legal_hold and av.current_image_path is not null;
  delete from app.user_avatars av using app.profiles p where p.id = av.user_id and p.status = 'deleted' and not av.image_legal_hold;
  return jsonb_build_object('objects', v_objects);
end;
$$;

create or replace function app.svc_purge_expired() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_idem integer; v_rate integer; v_runs integer; v_audit integer;
begin
  delete from app.idempotency_keys where expires_at < now();
  get diagnostics v_idem = row_count;
  delete from app.rate_limit_counters where window_start < now() - interval '2 days';
  get diagnostics v_rate = row_count;
  delete from app.ai_runs where created_at < now() - make_interval(days => app.setting_int('retention.ai_runs_days', 180));
  get diagnostics v_runs = row_count;
  perform set_config('app.retention_purge', 'on', true);
  delete from app.audit_logs where created_at < now() - make_interval(days => app.setting_int('retention.audit_log_days', 365));
  get diagnostics v_audit = row_count;
  perform set_config('app.retention_purge', 'off', true);
  return jsonb_build_object('idempotency_keys', v_idem, 'rate_limit_counters', v_rate, 'ai_runs', v_runs, 'audit_logs', v_audit);
end;
$$;

create or replace function app.svc_due_account_deletions(p_limit integer) returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(user_id), '{}') from (
    select user_id from app.account_deletion_requests
    where status in ('requested', 'failed', 'processing') and process_after <= now()
      and (status <> 'processing' or started_at < now() - interval '15 minutes')
    order by requested_at limit p_limit) x
$$;

-- ---------------------------------------------------------------------------
-- Operator moderation actions (no admin dashboard in the MVP; see docs/OPERATIONS.md)
-- ---------------------------------------------------------------------------
create or replace function app.svc_moderation_hide_message(p_message_id uuid, p_reason text, p_operator text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update app.messages set deleted_at = now(), deleted_reason = coalesce(p_reason, 'moderation')
   where id = p_message_id and deleted_at is null;
  insert into app.moderation_events (target_type, target_id, source, flagged, action, categories)
  values ('message', p_message_id, 'operator', true, 'hidden', jsonb_build_object('operator', p_operator, 'reason', p_reason));
  perform app.audit('moderation.message_hidden', 'message', p_message_id::text,
                    jsonb_build_object('operator', p_operator), null);
end;
$$;

create or replace function app.svc_resolve_report(p_report_id uuid, p_status text, p_note text, p_operator text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_status not in ('reviewing', 'resolved', 'dismissed') then
    raise exception 'invalid status %', p_status;
  end if;
  update app.reports set status = p_status, resolution_note = p_note,
         resolved_at = case when p_status in ('resolved', 'dismissed') then now() end
   where id = p_report_id;
  insert into app.moderation_events (target_type, target_id, source, flagged, action, report_id, categories)
  select target_type, target_id, 'operator', p_status = 'resolved',
         case p_status when 'resolved' then 'resolved' when 'dismissed' then 'dismissed' else 'held' end,
         id, jsonb_build_object('operator', p_operator)
  from app.reports where id = p_report_id;
  perform app.audit('moderation.report_' || p_status, 'report', p_report_id::text,
                    jsonb_build_object('operator', p_operator), null);
end;
$$;

create or replace function app.svc_set_guild_role(p_guild_id uuid, p_user uuid, p_role text) returns void
language sql security definer set search_path = '' as $$
  update app.guild_members set role = p_role where guild_id = p_guild_id and user_id = p_user
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig, p.proname from pg_proc p
           where p.pronamespace = 'app'::regnamespace loop
    execute format('revoke all on function %s from public', r.sig);
    if r.proname like 'api\_%' then
      execute format('grant execute on function %s to authenticated', r.sig);
    end if;
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end $$;

grant execute on function app.api_get_current_question_set(), app.api_client_config(),
  app.api_rate_limit(text, integer, integer, text) to anon;
grant execute on function app.is_conversation_member(uuid), app.is_guild_member(uuid),
  app.current_user_active(), app.realtime_topic_allowed(text), app.require_user() to authenticated;
