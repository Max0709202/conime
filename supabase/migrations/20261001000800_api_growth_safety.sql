-- API functions: notifications, reactions/EXP/levels/evolution, navigator,
-- blocks, reports and account deletion.

-- ---------------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------------
create or replace function app.notification_json(n app.notifications) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', n.id, 'type', n.type,
    'actor', case when n.actor_id is not null then app.user_summary_json(n.actor_id) end,
    'data', n.data, 'read_at', app.ts(n.read_at), 'created_at', app.ts(n.created_at))
$$;

-- Store a notification when the event happens (設計08). With p_dedupe_key the
-- existing row is refreshed instead of duplicated (e.g. one DM entry per thread).
create or replace function app.notify(p_user uuid, p_type text, p_actor uuid, p_data jsonb, p_dedupe_key text default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_row app.notifications;
begin
  if not (coalesce(app.setting('notifications.enabled_types'), '[]'::jsonb) ? p_type) then
    return null;
  end if;
  if not exists (select 1 from app.profiles where id = p_user and status = 'active') then
    return null;
  end if;
  insert into app.notifications (user_id, type, actor_id, data, dedupe_key)
  values (p_user, p_type, p_actor, coalesce(p_data, '{}'::jsonb), p_dedupe_key)
  on conflict (user_id, dedupe_key) do update
    set actor_id = excluded.actor_id, data = excluded.data, created_at = now(), read_at = null
  returning * into v_row;
  perform app.broadcast('user:' || p_user, 'notification.created', app.notification_json(v_row));
  return v_row.id;
end;
$$;

create or replace function app.api_list_notifications(p_unread_only boolean, p_cursor jsonb, p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := app.require_user();
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  v_rows jsonb;
  v_more boolean;
begin
  select jsonb_agg(jsonb_build_object('j', app.notification_json(n), 't', n.created_at, 'i', n.id) order by n.created_at desc, n.id desc)
    into v_rows
  from (
    select * from app.notifications
    where user_id = v_uid
      and (not coalesce(p_unread_only, false) or read_at is null)
      and (p_cursor is null or (created_at, id) < ((p_cursor ->> 't')::timestamptz, (p_cursor ->> 'i')::uuid))
    order by created_at desc, id desc limit v_limit + 1
  ) n;
  v_rows := coalesce(v_rows, '[]'::jsonb);
  v_more := jsonb_array_length(v_rows) > v_limit;
  if v_more then v_rows := v_rows - v_limit; end if;
  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(e -> 'j') from jsonb_array_elements(v_rows) e), '[]'::jsonb),
    'next_cursor', case when v_more then jsonb_build_object('t', v_rows -> (v_limit - 1) ->> 't', 'i', v_rows -> (v_limit - 1) ->> 'i') end,
    'unread_count', (select count(*) from app.notifications where user_id = v_uid and read_at is null));
end;
$$;

create or replace function app.api_mark_notifications_read(p_ids uuid[], p_all boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := app.require_user();
  v_count integer;
begin
  if coalesce(p_all, false) then
    update app.notifications set read_at = now() where user_id = v_uid and read_at is null;
  elsif p_ids is not null and cardinality(p_ids) > 0 then
    update app.notifications set read_at = now() where user_id = v_uid and read_at is null and id = any (p_ids);
  else
    perform app.raise_api_error('VALIDATION_ERROR', jsonb_build_object('fields', jsonb_build_array(
      jsonb_build_object('path', '/', 'rule', 'required', 'message', 'notification_ids or all=true is required'))));
  end if;
  get diagnostics v_count = row_count;
  return jsonb_build_object('updated_count', v_count,
    'unread_count', (select count(*) from app.notifications where user_id = v_uid and read_at is null));
end;
$$;

-- ---------------------------------------------------------------------------
-- EXP, level and evolution (L-1 … L-3, 設計07/08)
-- ---------------------------------------------------------------------------
-- Appends an EXP change to the immutable ledger and updates the derived growth
-- state under a row lock. Idempotent per (user, reason, source). Enqueues one
-- evolution-image job when a 5-level boundary is crossed (final stage only, G-04).
create or replace function app.apply_exp(
  p_user uuid, p_delta integer, p_gut_delta integer, p_reason text, p_source_type text, p_source_id uuid
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_rule text := app.setting_text('growth.level_rule_version', 'level-v1');
  v_interval integer := app.setting_int('growth.evolution.interval_levels', 5);
  g app.user_growth;
  v_total integer;
  v_level integer;
  v_old_stage integer;
  v_new_stage integer;
  v_ledger_id bigint;
  v_job_id uuid;
begin
  insert into app.user_growth (user_id, rule_version) values (p_user, v_rule) on conflict (user_id) do nothing;
  select * into g from app.user_growth where user_id = p_user for update;

  v_total := g.total_exp + p_delta;
  insert into app.exp_ledger (user_id, delta, gut_points_delta, reason, source_type, source_id, rule_version, total_exp_after)
  values (p_user, p_delta, p_gut_delta, p_reason, p_source_type, p_source_id, g.rule_version, v_total)
  on conflict (user_id, reason, source_type, source_id) do nothing
  returning id into v_ledger_id;
  if v_ledger_id is null then
    return jsonb_build_object('applied', false, 'level', g.level, 'total_exp', g.total_exp);
  end if;

  v_level := app.level_for_exp(g.rule_version, v_total);
  update app.user_growth
     set total_exp = v_total, gut_points = gut_points + p_gut_delta, level = v_level, updated_at = now()
   where user_id = p_user;

  if v_level > g.level then
    perform app.notify(p_user, 'level_up', null,
      jsonb_build_object('level', v_level, 'previous_level', g.level));
  end if;

  v_old_stage := (g.level / v_interval) * v_interval;
  v_new_stage := (v_level / v_interval) * v_interval;
  if v_new_stage > v_old_stage and v_new_stage >= v_interval and v_new_stage > g.evolution_stage_requested
     and exists (select 1 from app.user_avatars where user_id = p_user) then
    update app.user_growth set evolution_stage_requested = v_new_stage where user_id = p_user;
    insert into app.ai_jobs (user_id, kind, idempotency_key, payload, max_attempts)
    values (p_user, 'evolution_image', 'evolution:' || p_user || ':' || v_new_stage,
            jsonb_build_object('stage_level', v_new_stage, 'from_level', g.level, 'to_level', v_level),
            app.setting_int('ai.jobs.max_attempts', 3))
    on conflict (idempotency_key) do nothing
    returning id into v_job_id;
    if v_job_id is not null then
      -- Only the latest stage is generated; older queued evolution jobs are superseded.
      update app.ai_jobs set status = 'superseded', completed_at = now()
       where user_id = p_user and kind = 'evolution_image' and id <> v_job_id
         and status in ('accepted', 'retrying', 'failed');
      perform pgmq.send('ai_jobs', jsonb_build_object('job_id', v_job_id));
    end if;
  end if;

  perform app.broadcast('user:' || p_user, 'growth.updated', jsonb_build_object(
    'level', v_level, 'previous_level', g.level, 'total_exp', v_total,
    'gut_points', g.gut_points + p_gut_delta, 'evolution_job_id', v_job_id));

  return jsonb_build_object('applied', true, 'level', v_level, 'previous_level', g.level,
                            'total_exp', v_total, 'evolution_job_id', v_job_id);
end;
$$;

-- Give グッと: one per giver and target, in one transaction (C-3, L-1).
create or replace function app.api_give_reaction(p_target_type text, p_target_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := app.require_user();
  m app.messages;
  v_reaction app.reactions;
  v_count integer;
begin
  if p_target_type <> 'message' then
    perform app.raise_api_error('VALIDATION_ERROR', jsonb_build_object('fields', jsonb_build_array(
      jsonb_build_object('path', '/target_type', 'rule', 'enum', 'message', 'unsupported target type'))));
  end if;

  select * into m from app.messages where id = p_target_id;
  if m.id is null or m.deleted_at is not null or m.kind = 'system'
     or not app.is_member_of_conversation(m.conversation_id, v_uid) then
    perform app.raise_api_error('REACTION_TARGET_NOT_FOUND');
  end if;
  if m.sender_id = v_uid then
    perform app.raise_api_error('CANNOT_REACT_TO_SELF');
  end if;
  if m.sender_id is null or not exists (select 1 from app.profiles where id = m.sender_id and status = 'active') then
    perform app.raise_api_error('REACTION_TARGET_NOT_FOUND');
  end if;
  if app.is_blocked_between(v_uid, m.sender_id) then
    perform app.raise_api_error('BLOCKED');
  end if;

  insert into app.reactions (giver_id, target_type, target_id, recipient_id)
  values (v_uid, 'message', m.id, m.sender_id)
  on conflict (giver_id, target_type, target_id) do nothing
  returning * into v_reaction;

  if v_reaction.id is null then
    perform app.raise_api_error('ALREADY_REACTED', jsonb_build_object(
      'reaction_count', (select reaction_count from app.messages where id = m.id)));
  end if;

  update app.messages set reaction_count = reaction_count + 1 where id = m.id returning reaction_count into v_count;

  perform app.apply_exp(m.sender_id,
    app.setting_int('growth.reaction.exp', 10), app.setting_int('growth.reaction.gut_points', 1),
    'reaction_received', 'reaction', v_reaction.id);

  perform app.notify(m.sender_id, 'reaction_received', v_uid,
    jsonb_build_object('message_id', m.id, 'conversation_id', m.conversation_id));
  perform app.broadcast('conv:' || m.conversation_id, 'reaction.updated',
    jsonb_build_object('message_id', m.id, 'reaction_count', v_count));

  return jsonb_build_object(
    'reaction_id', v_reaction.id, 'target_type', 'message', 'target_id', m.id,
    'reaction_count', v_count, 'reacted_by_me', true, 'created_at', app.ts(v_reaction.created_at));
end;
$$;

create or replace function app.api_received_reactions(p_cursor jsonb, p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := app.require_user();
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  v_rows jsonb;
  v_more boolean;
begin
  select jsonb_agg(jsonb_build_object(
           'j', jsonb_build_object('id', r.id, 'giver', app.user_summary_json(r.giver_id),
                                   'target_type', r.target_type, 'target_id', r.target_id,
                                   'created_at', app.ts(r.created_at)),
           't', r.created_at, 'i', r.id) order by r.created_at desc, r.id desc)
    into v_rows
  from (
    select * from app.reactions
    where recipient_id = v_uid
      and (p_cursor is null or (created_at, id) < ((p_cursor ->> 't')::timestamptz, (p_cursor ->> 'i')::uuid))
    order by created_at desc, id desc limit v_limit + 1
  ) r;
  v_rows := coalesce(v_rows, '[]'::jsonb);
  v_more := jsonb_array_length(v_rows) > v_limit;
  if v_more then v_rows := v_rows - v_limit; end if;
  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(e -> 'j') from jsonb_array_elements(v_rows) e), '[]'::jsonb),
    'next_cursor', case when v_more then jsonb_build_object('t', v_rows -> (v_limit - 1) ->> 't', 'i', v_rows -> (v_limit - 1) ->> 'i') end,
    'total', (select count(*) from app.reactions where recipient_id = v_uid));
end;
$$;

-- ---------------------------------------------------------------------------
-- Navigator (N-1, N-2)
-- ---------------------------------------------------------------------------
create or replace function app.navigator_message_json(n app.navigator_messages) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('id', n.id, 'role', n.role, 'text', n.body, 'suggestions', n.suggestions,
                            'is_fallback', n.is_fallback, 'created_at', app.ts(n.created_at))
$$;

create or replace function app.navigator_quota_json(p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'daily_limit', app.setting_int('navigator.daily_limit', 30),
    'used_today', (select count(*) from app.navigator_messages
                   where user_id = p_user and role = 'user'
                     and created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'),
    'resets_at', app.ts((date_trunc('day', now() at time zone 'UTC') + interval '1 day') at time zone 'UTC'))
$$;

create or replace function app.navigator_exchange_json(p_user_msg uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'user_message', app.navigator_message_json(u),
    'assistant_message', app.navigator_message_json(a),
    'quota', app.navigator_quota_json(u.user_id))
  from app.navigator_messages u
  join app.navigator_messages a on a.reply_to = u.id
  where u.id = p_user_msg
$$;

-- Step 1: replay detection, consent and quota. No writes.
create or replace function app.api_navigator_precheck(p_client_message_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := app.require_user();
  v_existing app.navigator_messages;
  v_quota jsonb;
begin
  select * into v_existing from app.navigator_messages where user_id = v_uid and client_message_id = p_client_message_id;
  if v_existing.id is not null and exists (select 1 from app.navigator_messages where reply_to = v_existing.id) then
    return jsonb_build_object('replay', app.navigator_exchange_json(v_existing.id));
  end if;
  perform app.require_valid_consent(v_uid);
  v_quota := app.navigator_quota_json(v_uid);
  if v_existing.id is null and (v_quota ->> 'used_today')::integer >= (v_quota ->> 'daily_limit')::integer then
    perform app.raise_api_error('NAVIGATOR_QUOTA_EXCEEDED', jsonb_build_object('resets_at', v_quota ->> 'resets_at'));
  end if;
  return jsonb_build_object('replay', null, 'pending_user_message_id', v_existing.id);
end;
$$;

-- Step 2: store the user's message (input moderation already done by the API) and return context.
create or replace function app.api_navigator_begin(p_client_message_id uuid, p_text text, p_moderation jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := app.require_user();
  v_msg app.navigator_messages;
  v_turns integer := app.setting_int('navigator.context_turns', 10);
begin
  perform app.require_valid_consent(v_uid);
  if app.text_hits_denylist(p_text, 'moderation.local_denylist')
     or coalesce((p_moderation ->> 'flagged')::boolean, false) then
    insert into app.moderation_events (target_type, target_id, source, provider, model, flagged, categories, action, actor_id)
    values ('navigator_input', p_client_message_id,
            case when p_moderation is null then 'local_filter' else 'provider' end,
            p_moderation ->> 'provider', p_moderation ->> 'model', true,
            coalesce(p_moderation -> 'categories', '{}'::jsonb), 'rejected', v_uid);
    perform app.raise_api_error('NAVIGATOR_INPUT_REJECTED');
  end if;

  insert into app.navigator_messages (user_id, role, body, client_message_id, moderation)
  values (v_uid, 'user', p_text, p_client_message_id, p_moderation)
  on conflict (user_id, client_message_id) do nothing
  returning * into v_msg;
  if v_msg.id is null then
    select * into v_msg from app.navigator_messages where user_id = v_uid and client_message_id = p_client_message_id;
  end if;

  return jsonb_build_object(
    'user_message_id', v_msg.id,
    'context', jsonb_build_object(
      'character_name', (select name from app.user_avatars where user_id = v_uid),
      'level', app.user_level(v_uid),
      'history', coalesce((select jsonb_agg(jsonb_build_object('role', h.role, 'text', h.body) order by h.created_at, h.id)
                           from (select * from app.navigator_messages
                                 where user_id = v_uid and id <> v_msg.id and not is_fallback
                                 order by created_at desc, id desc limit v_turns * 2) h), '[]'::jsonb)));
end;
$$;

-- Step 3 (service): store the assistant reply. Idempotent per user message.
create or replace function app.svc_navigator_complete(
  p_user_message_id uuid, p_text text, p_suggestions jsonb, p_is_fallback boolean, p_ai_run_id uuid, p_moderation jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  u app.navigator_messages;
begin
  select * into u from app.navigator_messages where id = p_user_message_id and role = 'user';
  if u.id is null then
    perform app.raise_api_error('NOT_FOUND');
  end if;
  insert into app.navigator_messages (user_id, role, body, suggestions, is_fallback, reply_to, ai_run_id, moderation)
  values (u.user_id, 'assistant', p_text, coalesce(p_suggestions, '[]'::jsonb), p_is_fallback, u.id, p_ai_run_id, p_moderation)
  on conflict (reply_to) do nothing;
  return app.navigator_exchange_json(u.id);
end;
$$;

create or replace function app.api_navigator_history(p_cursor jsonb, p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := app.require_user();
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  v_keep integer := app.setting_int('navigator.history.max_messages', 200);
  v_rows jsonb;
  v_more boolean;
begin
  select jsonb_agg(jsonb_build_object('j', app.navigator_message_json(n), 't', n.created_at, 'i', n.id) order by n.created_at desc, n.id desc)
    into v_rows
  from (
    select * from (
      select * from app.navigator_messages where user_id = v_uid
      order by created_at desc, id desc limit v_keep
    ) recent
    where (p_cursor is null or (created_at, id) < ((p_cursor ->> 't')::timestamptz, (p_cursor ->> 'i')::uuid))
    order by created_at desc, id desc limit v_limit + 1
  ) n;
  v_rows := coalesce(v_rows, '[]'::jsonb);
  v_more := jsonb_array_length(v_rows) > v_limit;
  if v_more then v_rows := v_rows - v_limit; end if;
  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(e -> 'j' order by o desc) from jsonb_array_elements(v_rows) with ordinality x(e, o)), '[]'::jsonb),
    'next_cursor', case when v_more then jsonb_build_object('t', v_rows -> (v_limit - 1) ->> 't', 'i', v_rows -> (v_limit - 1) ->> 'i') end,
    'default_suggestions', coalesce(app.setting('navigator.default_suggestions'), '[]'::jsonb),
    'quota', app.navigator_quota_json(v_uid));
end;
$$;

-- ---------------------------------------------------------------------------
-- Blocks (S-2, I-01)
-- ---------------------------------------------------------------------------
create or replace function app.api_block(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := app.require_user();
  v_row app.blocks;
begin
  if p_user_id = v_uid then
    perform app.raise_api_error('CANNOT_BLOCK_SELF');
  end if;
  if not exists (select 1 from app.profiles where id = p_user_id) then
    perform app.raise_api_error('USER_NOT_FOUND');
  end if;
  insert into app.blocks (blocker_id, blocked_id) values (v_uid, p_user_id)
  on conflict do nothing returning * into v_row;
  if v_row.blocker_id is null then
    select * into v_row from app.blocks where blocker_id = v_uid and blocked_id = p_user_id;
    return jsonb_build_object('created', false,
      'block', jsonb_build_object('user', app.user_summary_json(p_user_id), 'created_at', app.ts(v_row.created_at)));
  end if;
  perform app.audit('block.created', 'user', p_user_id::text);
  return jsonb_build_object('created', true,
    'block', jsonb_build_object('user', app.user_summary_json(p_user_id), 'created_at', app.ts(v_row.created_at)));
end;
$$;

create or replace function app.api_unblock(p_user_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := app.require_user();
begin
  delete from app.blocks where blocker_id = v_uid and blocked_id = p_user_id;
  if found then
    perform app.audit('block.removed', 'user', p_user_id::text);
  end if;
end;
$$;

create or replace function app.api_list_blocks(p_cursor jsonb, p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := app.require_user();
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  v_rows jsonb;
  v_more boolean;
begin
  select jsonb_agg(jsonb_build_object(
           'j', jsonb_build_object('user', app.user_summary_json(b.blocked_id), 'created_at', app.ts(b.created_at)),
           't', b.created_at, 'i', b.blocked_id) order by b.created_at desc, b.blocked_id desc)
    into v_rows
  from (
    select * from app.blocks where blocker_id = v_uid
      and (p_cursor is null or (created_at, blocked_id) < ((p_cursor ->> 't')::timestamptz, (p_cursor ->> 'i')::uuid))
    order by created_at desc, blocked_id desc limit v_limit + 1
  ) b;
  v_rows := coalesce(v_rows, '[]'::jsonb);
  v_more := jsonb_array_length(v_rows) > v_limit;
  if v_more then v_rows := v_rows - v_limit; end if;
  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(e -> 'j') from jsonb_array_elements(v_rows) e), '[]'::jsonb),
    'next_cursor', case when v_more then jsonb_build_object('t', v_rows -> (v_limit - 1) ->> 't', 'i', v_rows -> (v_limit - 1) ->> 'i') end);
end;
$$;

-- ---------------------------------------------------------------------------
-- Reports (S-1, I-02, I-03): snapshot + SHA-256 + evidence hold
-- ---------------------------------------------------------------------------
create or replace function app.api_create_report(p_target_type text, p_target_id uuid, p_reason_code text, p_comment text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := app.require_user();
  v_snapshot jsonb;
  v_target_user uuid;
  v_report app.reports;
  m app.messages;
  a app.message_attachments;
  n app.navigator_messages;
begin
  if not exists (select 1 from jsonb_array_elements(coalesce(app.setting('reports.reason_codes'), '[]'::jsonb)) r
                 where r ->> 'code' = p_reason_code) then
    perform app.raise_api_error('VALIDATION_ERROR', jsonb_build_object('fields', jsonb_build_array(
      jsonb_build_object('path', '/reason_code', 'rule', 'enum', 'message', 'unknown reason code'))));
  end if;

  if p_target_type = 'message' then
    select * into m from app.messages where id = p_target_id;
    if m.id is null or not app.is_member_of_conversation(m.conversation_id, v_uid) then
      perform app.raise_api_error('REPORT_TARGET_NOT_FOUND');
    end if;
    select * into a from app.message_attachments where id = m.attachment_id;
    v_target_user := m.sender_id;
    v_snapshot := jsonb_build_object('message_id', m.id, 'conversation_id', m.conversation_id, 'seq', m.seq,
      'sender_id', m.sender_id, 'kind', m.kind, 'body', m.body, 'attachment_id', m.attachment_id,
      'attachment_object', case when a.id is not null then a.bucket || '/' || a.object_path end,
      'created_at', app.ts(m.created_at), 'deleted_at', app.ts(m.deleted_at));
    update app.messages set legal_hold = true where id = m.id;
    update app.message_attachments set legal_hold = true where id = m.attachment_id;
  elsif p_target_type = 'attachment' then
    select * into a from app.message_attachments where id = p_target_id;
    if a.id is null or a.status <> 'attached' or not app.is_member_of_conversation(a.conversation_id, v_uid) then
      perform app.raise_api_error('REPORT_TARGET_NOT_FOUND');
    end if;
    v_target_user := a.uploader_id;
    v_snapshot := jsonb_build_object('attachment_id', a.id, 'conversation_id', a.conversation_id,
      'uploader_id', a.uploader_id, 'object', a.bucket || '/' || a.object_path,
      'mime_type', coalesce(a.verified_mime, a.declared_mime), 'byte_size', coalesce(a.verified_size, a.declared_size),
      'message_id', (select id from app.messages where attachment_id = a.id));
    update app.message_attachments set legal_hold = true where id = a.id;
    update app.messages set legal_hold = true where attachment_id = a.id;
  elsif p_target_type = 'navigator_message' then
    select * into n from app.navigator_messages where id = p_target_id and user_id = v_uid and role = 'assistant';
    if n.id is null then
      perform app.raise_api_error('REPORT_TARGET_NOT_FOUND');
    end if;
    v_snapshot := jsonb_build_object('navigator_message_id', n.id, 'body', n.body, 'suggestions', n.suggestions,
      'is_fallback', n.is_fallback, 'ai_run_id', n.ai_run_id,
      'user_input', (select body from app.navigator_messages where id = n.reply_to),
      'created_at', app.ts(n.created_at));
    update app.navigator_messages set legal_hold = true where id in (n.id, n.reply_to);
  elsif p_target_type in ('avatar_image', 'user') then
    if not exists (select 1 from app.profiles where id = p_target_id and status = 'active')
       or exists (select 1 from app.blocks where blocker_id = p_target_id and blocked_id = v_uid)
       or (p_target_type = 'user' and p_target_id = v_uid) then
      perform app.raise_api_error('REPORT_TARGET_NOT_FOUND');
    end if;
    v_target_user := p_target_id;
    select jsonb_build_object('user_id', av.user_id, 'avatar_id', av.id, 'character_id', av.character_code,
             'name', av.name, 'image_object', case when av.current_image_path is not null
                                                   then app.setting_text('avatars.bucket', 'avatars') || '/' || av.current_image_path end,
             'image_stage', av.current_image_stage, 'image_updated_at', app.ts(av.image_updated_at))
      into v_snapshot
      from app.user_avatars av where av.user_id = p_target_id;
    if p_target_type = 'avatar_image' then
      if v_snapshot is null or v_snapshot ->> 'image_object' is null then
        perform app.raise_api_error('REPORT_TARGET_NOT_FOUND');
      end if;
      update app.user_avatars set image_legal_hold = true where user_id = p_target_id;
    end if;
    v_snapshot := coalesce(v_snapshot, jsonb_build_object('user_id', p_target_id));
  else
    perform app.raise_api_error('VALIDATION_ERROR');
  end if;

  insert into app.reports (reporter_id, target_type, target_id, target_user_id, reason_code, comment, snapshot, snapshot_sha256)
  values (v_uid, p_target_type, p_target_id, v_target_user, p_reason_code, nullif(btrim(p_comment), ''),
          v_snapshot, encode(extensions.digest(v_snapshot::text, 'sha256'), 'hex'))
  on conflict (reporter_id, target_type, target_id) do nothing
  returning * into v_report;

  if v_report.id is null then
    select * into v_report from app.reports where reporter_id = v_uid and target_type = p_target_type and target_id = p_target_id;
    return jsonb_build_object('report_id', v_report.id, 'status', v_report.status, 'duplicate', true,
                              'created_at', app.ts(v_report.created_at));
  end if;

  insert into app.moderation_events (target_type, target_id, source, flagged, action, actor_id, report_id)
  values (p_target_type, p_target_id, 'report', true, 'held', v_uid, v_report.id);
  perform app.audit('report.created', p_target_type, p_target_id::text,
                    jsonb_build_object('report_id', v_report.id, 'reason_code', p_reason_code));
  return jsonb_build_object('report_id', v_report.id, 'status', v_report.status, 'duplicate', false,
                            'created_at', app.ts(v_report.created_at));
end;
$$;

-- ---------------------------------------------------------------------------
-- Account deletion (AC-3, I-04, I-05)
-- ---------------------------------------------------------------------------
create or replace function app.deletion_status_json(p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'status', case when r.id is null then 'none'
                   when r.status = 'failed' then 'processing'
                   else r.status end,
    'requested_at', app.ts(r.requested_at),
    'completed_at', app.ts(r.completed_at))
  from (select 1) x left join app.account_deletion_requests r on r.user_id = p_user
$$;

create or replace function app.api_account_deletion_status() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    perform app.raise_api_error('UNAUTHENTICATED');
  end if;
  return app.deletion_status_json(auth.uid());
end;
$$;

create or replace function app.api_request_account_deletion(p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or not exists (select 1 from app.profiles where id = v_uid) then
    perform app.raise_api_error('UNAUTHENTICATED');
  end if;
  update app.profiles set status = 'deletion_requested' where id = v_uid and status = 'active';
  insert into app.account_deletion_requests (user_id, reason, process_after)
  values (v_uid, nullif(btrim(p_reason), ''), now() + make_interval(days => app.setting_int('account_deletion.grace_days', 0)))
  on conflict (user_id) do nothing;
  if found then
    perform app.audit('account.deletion_requested', 'user', v_uid::text);
  end if;
  return app.deletion_status_json(v_uid);
end;
$$;

-- Service: scrub personal data. Returns storage objects to delete (not under hold).
-- Evidence under an unresolved report is retained (I-04, requires client approval).
create or replace function app.svc_process_account_deletion(p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_objects jsonb := '[]'::jsonb;
  v_att_bucket text := app.setting_text('attachments.bucket', 'chat-attachments');
  v_av_bucket text := app.setting_text('avatars.bucket', 'avatars');
  r record;
begin
  update app.account_deletion_requests
     set status = 'processing', started_at = coalesce(started_at, now()), attempts = attempts + 1
   where user_id = p_user and status in ('requested', 'failed', 'processing');
  if not found then
    return jsonb_build_object('processed', false, 'objects', v_objects);
  end if;
  update app.profiles set status = 'deletion_requested' where id = p_user and status = 'active';

  -- Guild memberships (keep capacity counters exact)
  for r in select guild_id from app.guild_members where user_id = p_user loop
    perform 1 from app.guilds where id = r.guild_id for update;
    delete from app.guild_members where guild_id = r.guild_id and user_id = p_user;
    update app.guilds set member_count = greatest(member_count - 1, 0) where id = r.guild_id;
  end loop;
  delete from app.conversation_members cm using app.conversations c
   where cm.conversation_id = c.id and c.kind = 'guild' and cm.user_id = p_user;

  -- Messages: tombstone unless held as evidence
  select v_objects || coalesce(jsonb_agg(jsonb_build_object('bucket', a.bucket, 'path', a.object_path)), '[]'::jsonb)
    into v_objects
    from app.message_attachments a
   where a.uploader_id = p_user and a.status <> 'deleted' and not a.legal_hold;
  update app.message_attachments set status = 'deleted', deleted_at = now()
   where uploader_id = p_user and status <> 'deleted' and not legal_hold;
  update app.messages set body = null, deleted_at = coalesce(deleted_at, now()), deleted_reason = 'account_deleted'
   where sender_id = p_user and not legal_hold;

  -- Character image (current only)
  select v_objects || coalesce(jsonb_agg(jsonb_build_object('bucket', v_av_bucket, 'path', av.current_image_path)), '[]'::jsonb)
    into v_objects
    from app.user_avatars av where av.user_id = p_user and av.current_image_path is not null and not av.image_legal_hold;
  delete from app.user_avatars where user_id = p_user and not image_legal_hold;
  update app.user_avatars set name = null, personality = null, visual_description = null where user_id = p_user;

  -- Personal data
  delete from app.navigator_messages where user_id = p_user and not legal_hold;
  delete from app.notifications where user_id = p_user;
  delete from app.recommendations where user_id = p_user;
  delete from app.ai_jobs where user_id = p_user;
  delete from app.diagnosis_submissions where user_id = p_user;   -- cascades answers and features
  delete from app.blocks where blocker_id = p_user or blocked_id = p_user;
  delete from app.idempotency_keys where user_id = p_user;
  delete from app.conversation_reads where user_id = p_user;
  perform set_config('app.retention_purge', 'on', true);
  delete from app.exp_ledger where user_id = p_user;
  perform set_config('app.retention_purge', 'off', true);
  delete from app.user_growth where user_id = p_user;

  update app.profiles set status = 'deleted', ai_profile = null, deleted_at = now() where id = p_user;
  perform app.audit('account.deletion_processed', 'user', p_user::text,
                    jsonb_build_object('objects', jsonb_array_length(v_objects)), p_user);
  return jsonb_build_object('processed', true, 'objects', v_objects);
end;
$$;

create or replace function app.svc_complete_account_deletion(p_user uuid, p_error text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_error is null then
    update app.account_deletion_requests set status = 'completed', completed_at = now(), last_error = null
     where user_id = p_user;
    perform app.audit('account.deletion_completed', 'user', p_user::text, '{}'::jsonb, p_user);
  else
    update app.account_deletion_requests set status = 'failed', last_error = left(p_error, 500),
           process_after = now() + interval '15 minutes'
     where user_id = p_user;
  end if;
end;
$$;
