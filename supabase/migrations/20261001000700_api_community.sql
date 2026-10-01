-- API functions: guilds, conversations, messages, attachments, read markers,
-- and realtime broadcast triggers.

-- ---------------------------------------------------------------------------
-- Realtime helpers. Broadcast failures never abort the business transaction;
-- PostgreSQL + REST remain the source of truth.
-- ---------------------------------------------------------------------------
create or replace function app.broadcast(p_topic text, p_type text, p_data jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform realtime.send(
    jsonb_build_object('event_id', gen_random_uuid(), 'type', p_type,
                       'occurred_at', app.ts(clock_timestamp()), 'data', p_data),
    p_type, p_topic, true);
exception when others then
  raise warning 'broadcast to % failed: %', p_topic, sqlerrm;
end;
$$;

-- Escape LIKE wildcards in user search input.
create or replace function app.like_escape(p text) returns text
language sql immutable set search_path = '' as $$
  select replace(replace(replace(p, '\', '\\'), '%', '\%'), '_', '\_')
$$;

-- ---------------------------------------------------------------------------
-- Guilds
-- ---------------------------------------------------------------------------
create or replace function app.guild_capacity(p_capacity integer) returns integer
language sql stable security definer set search_path = '' as $$
  select coalesce(p_capacity, app.setting_int('guild.default_capacity', 100))
$$;

create or replace function app.guild_summary_json(p_guild_id uuid, p_viewer uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', g.id,
    'name', g.name,
    'description', g.description,
    'tags', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name) order by t.name)
                      from app.guild_tags gt join app.tags t on t.id = gt.tag_id where gt.guild_id = g.id), '[]'::jsonb),
    'member_count', g.member_count,
    'capacity', app.guild_capacity(g.capacity),
    'is_full', g.member_count >= app.guild_capacity(g.capacity),
    'is_member', exists (select 1 from app.guild_members m where m.guild_id = g.id and m.user_id = p_viewer))
  from app.guilds g where g.id = p_guild_id
$$;

create or replace function app.membership_json(p_guild_id uuid, p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'guild_id', m.guild_id, 'guild_name', g.name, 'role', m.role, 'joined_at', app.ts(m.joined_at),
    'conversation_id', c.id)
  from app.guild_members m
  join app.guilds g on g.id = m.guild_id
  join app.conversations c on c.guild_id = m.guild_id
  where m.guild_id = p_guild_id and m.user_id = p_user
$$;

-- p_cursor: {"t": timestamp, "i": uuid} from the previous page.
create or replace function app.api_list_guilds(
  p_q text, p_tag_id uuid, p_membership text, p_cursor jsonb, p_limit integer
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := app.require_user();
  v_pattern text := case when nullif(btrim(coalesce(p_q, '')), '') is null then null
                         else '%' || app.like_escape(lower(btrim(p_q))) || '%' end;
  v_rows jsonb;
  v_more boolean;
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 100);
begin
  with page as (
    select g.id, g.created_at
    from app.guilds g
    where g.status = 'published'
      and (v_pattern is null
           or lower(g.name) like v_pattern
           or lower(g.description) like v_pattern
           or exists (select 1 from app.guild_tags gt join app.tags t on t.id = gt.tag_id
                      where gt.guild_id = g.id and lower(t.name) like v_pattern))
      and (p_tag_id is null or exists (select 1 from app.guild_tags gt where gt.guild_id = g.id and gt.tag_id = p_tag_id))
      and (coalesce(p_membership, 'all') = 'all'
           or (p_membership = 'joined' and exists (select 1 from app.guild_members m where m.guild_id = g.id and m.user_id = v_uid))
           or (p_membership = 'not_joined' and not exists (select 1 from app.guild_members m where m.guild_id = g.id and m.user_id = v_uid)))
      and (p_cursor is null or (g.created_at, g.id) < ((p_cursor ->> 't')::timestamptz, (p_cursor ->> 'i')::uuid))
    order by g.created_at desc, g.id desc
    limit v_limit + 1
  )
  select jsonb_agg(jsonb_build_object('j', app.guild_summary_json(id, v_uid), 't', created_at, 'i', id)
                   order by created_at desc, id desc)
    into v_rows from page;

  v_rows := coalesce(v_rows, '[]'::jsonb);
  v_more := jsonb_array_length(v_rows) > v_limit;
  if v_more then
    v_rows := v_rows - v_limit;
  end if;
  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(e -> 'j') from jsonb_array_elements(v_rows) e), '[]'::jsonb),
    'next_cursor', case when v_more then jsonb_build_object('t', v_rows -> (v_limit - 1) ->> 't', 'i', v_rows -> (v_limit - 1) ->> 'i') end);
end;
$$;

create or replace function app.api_guild_detail(p_guild_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := app.require_user();
  v_g app.guilds;
  v_m app.guild_members;
begin
  select * into v_g from app.guilds where id = p_guild_id;
  select * into v_m from app.guild_members where guild_id = p_guild_id and user_id = v_uid;
  if v_g.id is null or (v_g.status <> 'published' and v_m.user_id is null) then
    perform app.raise_api_error('GUILD_NOT_FOUND');
  end if;
  return app.guild_summary_json(v_g.id, v_uid) || jsonb_build_object(
    'leader_name', v_g.leader_name,
    'my_role', v_m.role,
    'joined_at', app.ts(v_m.joined_at),
    'conversation_id', case when v_m.user_id is not null then (select id from app.conversations where guild_id = v_g.id) end,
    'created_at', app.ts(v_g.created_at));
end;
$$;

-- Join without approval (G-3). Capacity and per-user limit enforced under row locks.
create or replace function app.api_join_guild(p_guild_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := app.require_user();
  v_g app.guilds;
  v_limit integer;
  v_count integer;
  v_capacity integer;
  v_conv uuid;
begin
  -- Serialize this user's joins (per-user limit) and this guild's joins (capacity).
  perform 1 from app.profiles where id = v_uid for update;
  select * into v_g from app.guilds where id = p_guild_id and status = 'published' for update;
  if v_g.id is null then
    perform app.raise_api_error('GUILD_NOT_FOUND');
  end if;

  if exists (select 1 from app.guild_members where guild_id = v_g.id and user_id = v_uid) then
    return jsonb_build_object('already_member', true,
      'membership', app.membership_json(v_g.id, v_uid), 'guild', app.guild_summary_json(v_g.id, v_uid));
  end if;

  v_limit := app.setting_int('guild.max_memberships_per_user', null);
  if v_limit is not null then
    select count(*) into v_count from app.guild_members where user_id = v_uid;
    if v_count >= v_limit then
      perform app.raise_api_error('GUILD_MEMBERSHIP_LIMIT_REACHED', jsonb_build_object('limit', v_limit));
    end if;
  end if;

  v_capacity := app.guild_capacity(v_g.capacity);
  if v_g.member_count >= v_capacity then
    perform app.raise_api_error('GUILD_FULL', jsonb_build_object('capacity', v_capacity, 'member_count', v_g.member_count));
  end if;

  insert into app.guild_members (guild_id, user_id) values (v_g.id, v_uid);
  update app.guilds set member_count = member_count + 1 where id = v_g.id;

  insert into app.conversations (kind, guild_id) values ('guild', v_g.id)
  on conflict (guild_id) do nothing;
  select id into v_conv from app.conversations where guild_id = v_g.id;
  insert into app.conversation_members (conversation_id, user_id) values (v_conv, v_uid)
  on conflict do nothing;
  -- New members start with history read (no flood of unread badges).
  insert into app.conversation_reads (conversation_id, user_id, last_read_seq)
  select v_conv, v_uid, c.last_seq from app.conversations c where c.id = v_conv
  on conflict (conversation_id, user_id) do update set last_read_seq = excluded.last_read_seq;

  perform app.audit('guild.joined', 'guild', v_g.id::text);
  return jsonb_build_object('already_member', false,
    'membership', app.membership_json(v_g.id, v_uid), 'guild', app.guild_summary_json(v_g.id, v_uid));
end;
$$;

create or replace function app.api_my_memberships() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := app.require_user();
begin
  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(app.membership_json(m.guild_id, v_uid) order by m.joined_at, m.guild_id)
                       from app.guild_members m where m.user_id = v_uid), '[]'::jsonb),
    'limit', app.setting_int('guild.max_memberships_per_user', null));
end;
$$;

create or replace function app.require_guild_member(p_guild_id uuid, p_uid uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from app.guilds where id = p_guild_id and status = 'published')
     and not exists (select 1 from app.guild_members where guild_id = p_guild_id and user_id = p_uid) then
    perform app.raise_api_error('GUILD_NOT_FOUND');
  end if;
  if not exists (select 1 from app.guild_members where guild_id = p_guild_id and user_id = p_uid) then
    perform app.raise_api_error('NOT_A_MEMBER');
  end if;
end;
$$;

create or replace function app.api_guild_members(p_guild_id uuid, p_cursor jsonb, p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := app.require_user();
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  v_rows jsonb;
  v_more boolean;
begin
  perform app.require_guild_member(p_guild_id, v_uid);
  select jsonb_agg(jsonb_build_object(
           'j', jsonb_build_object('user', app.user_summary_json(m.user_id, m.role), 'role', m.role, 'joined_at', app.ts(m.joined_at)),
           't', m.joined_at, 'i', m.user_id) order by m.joined_at, m.user_id)
    into v_rows
  from (
    select gm.* from app.guild_members gm
    join app.profiles p on p.id = gm.user_id and p.status = 'active'
    where gm.guild_id = p_guild_id
      and (p_cursor is null or (gm.joined_at, gm.user_id) > ((p_cursor ->> 't')::timestamptz, (p_cursor ->> 'i')::uuid))
    order by gm.joined_at, gm.user_id
    limit v_limit + 1
  ) m;
  v_rows := coalesce(v_rows, '[]'::jsonb);
  v_more := jsonb_array_length(v_rows) > v_limit;
  if v_more then v_rows := v_rows - v_limit; end if;
  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(e -> 'j') from jsonb_array_elements(v_rows) e), '[]'::jsonb),
    'next_cursor', case when v_more then jsonb_build_object('t', v_rows -> (v_limit - 1) ->> 't', 'i', v_rows -> (v_limit - 1) ->> 'i') end);
end;
$$;

create or replace function app.api_guild_announcements(p_guild_id uuid, p_cursor jsonb, p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := app.require_user();
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  v_rows jsonb;
  v_more boolean;
begin
  perform app.require_guild_member(p_guild_id, v_uid);
  select jsonb_agg(jsonb_build_object(
           'j', jsonb_build_object('id', a.id, 'title', a.title, 'body', a.body, 'published_at', app.ts(a.published_at)),
           't', a.published_at, 'i', a.id) order by a.published_at desc, a.id desc)
    into v_rows
  from (
    select * from app.guild_announcements
    where guild_id = p_guild_id and published_at <= now()
      and (p_cursor is null or (published_at, id) < ((p_cursor ->> 't')::timestamptz, (p_cursor ->> 'i')::uuid))
    order by published_at desc, id desc limit v_limit + 1
  ) a;
  v_rows := coalesce(v_rows, '[]'::jsonb);
  v_more := jsonb_array_length(v_rows) > v_limit;
  if v_more then v_rows := v_rows - v_limit; end if;
  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(e -> 'j') from jsonb_array_elements(v_rows) e), '[]'::jsonb),
    'next_cursor', case when v_more then jsonb_build_object('t', v_rows -> (v_limit - 1) ->> 't', 'i', v_rows -> (v_limit - 1) ->> 'i') end);
end;
$$;

-- ---------------------------------------------------------------------------
-- Conversations
-- ---------------------------------------------------------------------------
create or replace function app.is_member_of_conversation(p_conv uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from app.conversation_members where conversation_id = p_conv and user_id = p_user)
$$;

create or replace function app.dm_peer(c app.conversations, p_viewer uuid) returns uuid
language sql immutable set search_path = '' as $$
  select case when c.kind <> 'dm' then null when c.dm_user_low = p_viewer then c.dm_user_high else c.dm_user_low end
$$;

-- Why the viewer cannot send, or null.
create or replace function app.cannot_send_reason(p_conv uuid, p_viewer uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  c app.conversations;
  v_peer uuid;
begin
  select * into c from app.conversations where id = p_conv;
  if not app.is_member_of_conversation(p_conv, p_viewer) then
    return 'not_member';
  end if;
  if c.kind = 'dm' then
    v_peer := app.dm_peer(c, p_viewer);
    if not exists (select 1 from app.profiles where id = v_peer and status = 'active') then
      return 'peer_deleted';
    end if;
    if app.is_blocked_between(p_viewer, v_peer) then
      return 'blocked';
    end if;
  end if;
  return null;
end;
$$;

create or replace function app.history_floor_seq(c app.conversations) returns bigint
language sql stable security definer set search_path = '' as $$
  select greatest(0, c.last_seq - case when c.kind = 'guild'
    then app.setting_int('chat.history.guild_max_messages', 1000)
    else app.setting_int('chat.history.dm_max_messages', 1000) end)
$$;

create or replace function app.conversation_json(p_conv uuid, p_viewer uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  c app.conversations;
  v_read bigint;
  v_reason text;
  v_last jsonb;
  v_unread integer;
begin
  select * into c from app.conversations where id = p_conv;
  select coalesce((select last_read_seq from app.conversation_reads where conversation_id = p_conv and user_id = p_viewer), 0)
    into v_read;
  v_reason := app.cannot_send_reason(p_conv, p_viewer);

  select jsonb_build_object('id', m.id, 'seq', m.seq, 'kind', m.kind,
           'text', case when m.deleted_at is null then left(m.body, 80) end,
           'sender_id', m.sender_id, 'created_at', app.ts(m.created_at))
    into v_last
  from app.messages m
  where m.conversation_id = p_conv and m.seq > app.history_floor_seq(c)
    and (c.kind = 'dm' or m.sender_id is null
         or not exists (select 1 from app.blocks b where b.blocker_id = p_viewer and b.blocked_id = m.sender_id))
  order by m.seq desc limit 1;

  select count(*) into v_unread
  from app.messages m
  where m.conversation_id = p_conv
    and m.seq > greatest(v_read, app.history_floor_seq(c))
    and m.deleted_at is null
    and m.sender_id is distinct from p_viewer
    and (c.kind = 'dm' or m.sender_id is null
         or not exists (select 1 from app.blocks b where b.blocker_id = p_viewer and b.blocked_id = m.sender_id));

  return jsonb_build_object(
    'id', c.id,
    'kind', c.kind,
    'guild', case when c.kind = 'guild' then (select jsonb_build_object('id', g.id, 'name', g.name) from app.guilds g where g.id = c.guild_id) end,
    'peer', case when c.kind = 'dm' then app.user_summary_json(app.dm_peer(c, p_viewer)) end,
    'last_message', v_last,
    'latest_seq', c.last_seq,
    'last_read_seq', v_read,
    'unread_count', v_unread,
    'can_send', v_reason is null,
    'cannot_send_reason', v_reason,
    'realtime_topic', 'conv:' || c.id,
    'updated_at', app.ts(coalesce(c.last_message_at, c.created_at)));
end;
$$;

create or replace function app.api_list_conversations(p_kind text, p_cursor jsonb, p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := app.require_user();
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  v_rows jsonb;
  v_more boolean;
begin
  select jsonb_agg(jsonb_build_object('j', app.conversation_json(x.id, v_uid), 't', x.ts, 'i', x.id) order by x.ts desc, x.id desc)
    into v_rows
  from (
    select c.id, coalesce(c.last_message_at, c.created_at) as ts
    from app.conversations c
    join app.conversation_members cm on cm.conversation_id = c.id and cm.user_id = v_uid
    where (p_kind is null or c.kind = p_kind)
      and (p_cursor is null or (coalesce(c.last_message_at, c.created_at), c.id) < ((p_cursor ->> 't')::timestamptz, (p_cursor ->> 'i')::uuid))
    order by 2 desc, c.id desc
    limit v_limit + 1
  ) x;
  v_rows := coalesce(v_rows, '[]'::jsonb);
  v_more := jsonb_array_length(v_rows) > v_limit;
  if v_more then v_rows := v_rows - v_limit; end if;
  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(e -> 'j') from jsonb_array_elements(v_rows) e), '[]'::jsonb),
    'next_cursor', case when v_more then jsonb_build_object('t', v_rows -> (v_limit - 1) ->> 't', 'i', v_rows -> (v_limit - 1) ->> 'i') end);
end;
$$;

create or replace function app.require_conversation_member(p_conv uuid, p_uid uuid) returns app.conversations
language plpgsql stable security definer set search_path = '' as $$
declare
  c app.conversations;
begin
  select * into c from app.conversations where id = p_conv;
  if c.id is null or not app.is_member_of_conversation(p_conv, p_uid) then
    perform app.raise_api_error('CONVERSATION_NOT_FOUND');
  end if;
  return c;
end;
$$;

create or replace function app.api_get_conversation(p_conv uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := app.require_user();
begin
  perform app.require_conversation_member(p_conv, v_uid);
  return app.conversation_json(p_conv, v_uid);
end;
$$;

-- Find or create a DM thread (C-4, M-4, F-06).
create or replace function app.api_open_dm(p_peer uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := app.require_user();
  v_low uuid;
  v_high uuid;
  v_conv uuid;
  v_created boolean := false;
begin
  if p_peer = v_uid then
    perform app.raise_api_error('CANNOT_MESSAGE_SELF');
  end if;
  if not exists (select 1 from app.profiles where id = p_peer and status = 'active') then
    perform app.raise_api_error('USER_NOT_FOUND');
  end if;
  v_low := least(v_uid, p_peer);
  v_high := greatest(v_uid, p_peer);

  select id into v_conv from app.conversations where dm_user_low = v_low and dm_user_high = v_high;
  if v_conv is null then
    if app.is_blocked_between(v_uid, p_peer) then
      perform app.raise_api_error('BLOCKED');
    end if;
    insert into app.conversations (kind, dm_user_low, dm_user_high) values ('dm', v_low, v_high)
    on conflict (dm_user_low, dm_user_high) do nothing
    returning id into v_conv;
    if v_conv is null then
      select id into v_conv from app.conversations where dm_user_low = v_low and dm_user_high = v_high;
    else
      v_created := true;
      insert into app.conversation_members (conversation_id, user_id) values (v_conv, v_low), (v_conv, v_high);
      insert into app.conversation_reads (conversation_id, user_id) values (v_conv, v_low), (v_conv, v_high);
      perform app.audit('dm.opened', 'conversation', v_conv::text);
    end if;
  end if;
  return jsonb_build_object('created', v_created, 'conversation', app.conversation_json(v_conv, v_uid));
end;
$$;

-- ---------------------------------------------------------------------------
-- Messages
-- ---------------------------------------------------------------------------
create or replace function app.message_json(m app.messages, p_viewer uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', m.id,
    'conversation_id', m.conversation_id,
    'seq', m.seq,
    'client_message_id', case when m.sender_id = p_viewer then m.client_message_id end,
    'sender', app.user_summary_json(m.sender_id,
                (select gm.role from app.conversations c join app.guild_members gm
                   on gm.guild_id = c.guild_id and gm.user_id = m.sender_id where c.id = m.conversation_id)),
    'kind', m.kind,
    'text', case when m.deleted_at is null then m.body end,
    'attachment', case when m.attachment_id is not null and m.deleted_at is null then (
        select jsonb_build_object('id', a.id, 'mime_type', coalesce(a.verified_mime, a.declared_mime),
                                  'byte_size', coalesce(a.verified_size, a.declared_size),
                                  '__attachment_path', case when a.status = 'attached' then a.bucket || '/' || a.object_path end)
        from app.message_attachments a where a.id = m.attachment_id) end,
    'reaction_count', m.reaction_count,
    'reacted_by_me', p_viewer is not null and exists (
        select 1 from app.reactions r where r.giver_id = p_viewer and r.target_type = 'message' and r.target_id = m.id),
    'is_deleted', m.deleted_at is not null,
    'created_at', app.ts(m.created_at))
$$;

-- before_seq: older page. after_seq: catch-up. Neither: newest page. Items ascending.
create or replace function app.api_list_messages(p_conv uuid, p_before_seq bigint, p_after_seq bigint, p_limit integer)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := app.require_user();
  c app.conversations;
  v_floor bigint;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_seqs bigint[];
  v_min bigint;
  v_max bigint;
  v_more_older boolean;
  v_more_newer boolean;
begin
  c := app.require_conversation_member(p_conv, v_uid);
  v_floor := app.history_floor_seq(c);

  if p_after_seq is not null then
    select array_agg(x.seq order by x.seq) into v_seqs from (
      select m.seq from app.messages m
      where m.conversation_id = p_conv and m.seq > greatest(p_after_seq, v_floor)
        and (c.kind = 'dm' or m.sender_id is null
             or not exists (select 1 from app.blocks b where b.blocker_id = v_uid and b.blocked_id = m.sender_id))
      order by m.seq asc limit v_limit + 1) x;
    v_more_newer := coalesce(cardinality(v_seqs), 0) > v_limit;
    if v_more_newer then v_seqs := v_seqs[1:v_limit]; end if;
  else
    select array_agg(x.seq order by x.seq desc) into v_seqs from (
      select m.seq from app.messages m
      where m.conversation_id = p_conv and m.seq > v_floor
        and (p_before_seq is null or m.seq < p_before_seq)
        and (c.kind = 'dm' or m.sender_id is null
             or not exists (select 1 from app.blocks b where b.blocker_id = v_uid and b.blocked_id = m.sender_id))
      order by m.seq desc limit v_limit + 1) x;
    v_more_older := coalesce(cardinality(v_seqs), 0) > v_limit;
    if v_more_older then v_seqs := v_seqs[1:v_limit]; end if;
  end if;

  select min(s), max(s) into v_min, v_max from unnest(v_seqs) s;
  if v_more_older is null then
    v_more_older := v_min is not null
      and exists (select 1 from app.messages where conversation_id = p_conv and seq < v_min and seq > v_floor);
  end if;
  if v_more_newer is null then
    v_more_newer := v_max is not null and v_max < c.last_seq;
  end if;

  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(app.message_json(m, v_uid) order by m.seq)
                       from app.messages m where m.conversation_id = p_conv and m.seq = any (v_seqs)), '[]'::jsonb),
    'has_more_older', v_more_older,
    'has_more_newer', v_more_newer,
    'latest_seq', c.last_seq,
    'last_read_seq', coalesce((select last_read_seq from app.conversation_reads
                               where conversation_id = p_conv and user_id = v_uid), 0));
end;
$$;

-- Send a message. Idempotent on (sender, client_message_id). For images the API
-- verifies the uploaded object first (app.svc_mark_attachment_ready).
create or replace function app.api_send_message(
  p_conv uuid, p_client_message_id uuid, p_kind text, p_text text, p_attachment_id uuid
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := app.require_user();
  c app.conversations;
  v_existing app.messages;
  v_att app.message_attachments;
  v_reason text;
  v_seq bigint;
  v_msg app.messages;
  v_max_chars integer := app.setting_int('chat.message.max_chars', 1000);
  v_peer uuid;
begin
  c := app.require_conversation_member(p_conv, v_uid);

  select * into v_existing from app.messages where sender_id = v_uid and client_message_id = p_client_message_id;
  if v_existing.id is not null then
    if v_existing.conversation_id = p_conv and v_existing.kind = p_kind
       and v_existing.body is not distinct from p_text
       and v_existing.attachment_id is not distinct from p_attachment_id then
      return jsonb_build_object('replay', true, 'message', app.message_json(v_existing, v_uid));
    end if;
    perform app.raise_api_error('CLIENT_MESSAGE_ID_CONFLICT');
  end if;

  v_reason := app.cannot_send_reason(p_conv, v_uid);
  if v_reason = 'blocked' then
    perform app.raise_api_error('BLOCKED');
  elsif v_reason is not null then
    perform app.raise_api_error('FORBIDDEN', jsonb_build_object('reason', v_reason));
  end if;

  if p_kind = 'text' then
    if p_text is null or char_length(btrim(p_text)) = 0 or p_attachment_id is not null then
      perform app.raise_api_error('VALIDATION_ERROR', jsonb_build_object('fields', jsonb_build_array(
        jsonb_build_object('path', '/text', 'rule', 'required', 'message', 'text messages need text and no attachment'))));
    end if;
    if char_length(p_text) > v_max_chars then
      perform app.raise_api_error('VALIDATION_ERROR', jsonb_build_object('fields', jsonb_build_array(
        jsonb_build_object('path', '/text', 'rule', 'maxLength', 'message', 'max ' || v_max_chars || ' characters'))));
    end if;
    if app.text_hits_denylist(p_text, 'moderation.local_denylist') then
      insert into app.moderation_events (target_type, target_id, source, flagged, action, actor_id)
      values ('message_draft', p_client_message_id, 'local_filter', true, 'rejected', v_uid);
      perform app.raise_api_error('MESSAGE_CONTENT_REJECTED');
    end if;
  elsif p_kind = 'image' then
    if p_attachment_id is null or p_text is not null then
      perform app.raise_api_error('VALIDATION_ERROR', jsonb_build_object('fields', jsonb_build_array(
        jsonb_build_object('path', '/attachment_id', 'rule', 'required', 'message', 'image messages need attachment_id and no text'))));
    end if;
    select * into v_att from app.message_attachments
     where id = p_attachment_id and uploader_id = v_uid and conversation_id = p_conv for update;
    if v_att.id is null or v_att.status = 'deleted' then
      perform app.raise_api_error('ATTACHMENT_NOT_FOUND');
    elsif v_att.status = 'attached' then
      perform app.raise_api_error('ATTACHMENT_ALREADY_USED');
    elsif v_att.status <> 'ready' then
      perform app.raise_api_error('ATTACHMENT_NOT_UPLOADED');
    end if;
  else
    perform app.raise_api_error('VALIDATION_ERROR');
  end if;

  -- Per-conversation sequence under row lock: commit order == seq order.
  update app.conversations set last_seq = last_seq + 1, last_message_at = now()
   where id = p_conv returning last_seq into v_seq;

  insert into app.messages (conversation_id, seq, sender_id, client_message_id, kind, body, attachment_id, content_sha256)
  values (p_conv, v_seq, v_uid, p_client_message_id, p_kind, p_text, p_attachment_id,
          encode(extensions.digest(coalesce(p_text, '') || coalesce(p_attachment_id::text, ''), 'sha256'), 'hex'))
  on conflict (sender_id, client_message_id) do nothing
  returning * into v_msg;

  if v_msg.id is null then
    select * into v_existing from app.messages where sender_id = v_uid and client_message_id = p_client_message_id;
    return jsonb_build_object('replay', true, 'message', app.message_json(v_existing, v_uid));
  end if;

  if p_kind = 'image' then
    update app.message_attachments set status = 'attached' where id = p_attachment_id;
  end if;

  insert into app.conversation_reads (conversation_id, user_id, last_read_seq) values (p_conv, v_uid, v_seq)
  on conflict (conversation_id, user_id) do update set last_read_seq = greatest(app.conversation_reads.last_read_seq, excluded.last_read_seq), updated_at = now();

  if c.kind = 'dm' then
    v_peer := app.dm_peer(c, v_uid);
    perform app.notify(v_peer, 'dm_received', v_uid,
      jsonb_build_object('conversation_id', p_conv, 'message_id', v_msg.id, 'seq', v_seq),
      'dm:' || p_conv::text);
    perform app.broadcast('user:' || v_peer, 'conversation.updated',
      jsonb_build_object('conversation_id', p_conv, 'latest_seq', v_seq));
    perform app.broadcast('user:' || v_uid, 'conversation.updated',
      jsonb_build_object('conversation_id', p_conv, 'latest_seq', v_seq));
  end if;

  return jsonb_build_object('replay', false, 'message', app.message_json(v_msg, v_uid));
end;
$$;

create or replace function app.api_mark_read(p_conv uuid, p_seq bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := app.require_user();
  c app.conversations;
  v_seq bigint;
begin
  c := app.require_conversation_member(p_conv, v_uid);
  v_seq := least(greatest(p_seq, 0), c.last_seq);
  insert into app.conversation_reads (conversation_id, user_id, last_read_seq) values (p_conv, v_uid, v_seq)
  on conflict (conversation_id, user_id) do update
    set last_read_seq = greatest(app.conversation_reads.last_read_seq, excluded.last_read_seq), updated_at = now();
  if c.kind = 'dm' then
    update app.notifications set read_at = now()
     where user_id = v_uid and dedupe_key = 'dm:' || p_conv::text and read_at is null
       and coalesce((data ->> 'seq')::bigint, 0) <= v_seq;
  end if;
  return jsonb_build_object(
    'conversation_id', p_conv,
    'last_read_seq', (select last_read_seq from app.conversation_reads where conversation_id = p_conv and user_id = v_uid),
    'unread_count', (app.conversation_json(p_conv, v_uid) ->> 'unread_count')::integer);
end;
$$;

-- ---------------------------------------------------------------------------
-- Attachments
-- ---------------------------------------------------------------------------
create or replace function app.api_create_upload_slot(p_conv uuid, p_mime text, p_size bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := app.require_user();
  v_reason text;
  v_allowed jsonb := coalesce(app.setting('attachments.allowed_mime_types'), '[]'::jsonb);
  v_max bigint := app.setting_int('attachments.max_bytes', 10485760);
  v_bucket text := app.setting_text('attachments.bucket', 'chat-attachments');
  v_id uuid := gen_random_uuid();
  v_ext text;
  v_path text;
begin
  perform app.require_conversation_member(p_conv, v_uid);
  v_reason := app.cannot_send_reason(p_conv, v_uid);
  if v_reason = 'blocked' then
    perform app.raise_api_error('BLOCKED');
  elsif v_reason is not null then
    perform app.raise_api_error('FORBIDDEN', jsonb_build_object('reason', v_reason));
  end if;
  if not (v_allowed ? lower(p_mime)) then
    perform app.raise_api_error('ATTACHMENT_TYPE_NOT_ALLOWED', jsonb_build_object('allowed_mime_types', v_allowed));
  end if;
  if p_size > v_max then
    perform app.raise_api_error('ATTACHMENT_TOO_LARGE', jsonb_build_object('max_bytes', v_max));
  end if;
  v_ext := case lower(p_mime) when 'image/jpeg' then 'jpg' when 'image/png' then 'png'
                              when 'image/heic' then 'heic' when 'image/webp' then 'webp' else 'bin' end;
  -- Server-chosen path; no client-supplied file names or OS paths.
  v_path := p_conv::text || '/' || v_uid::text || '/' || v_id::text || '.' || v_ext;
  insert into app.message_attachments (id, conversation_id, uploader_id, bucket, object_path, declared_mime, declared_size)
  values (v_id, p_conv, v_uid, v_bucket, v_path, lower(p_mime), p_size);
  return jsonb_build_object(
    'attachment_id', v_id, 'bucket', v_bucket, 'object_path', v_path, 'mime_type', lower(p_mime),
    'max_bytes', v_max, 'ttl_seconds', app.setting_int('attachments.upload_url_ttl_seconds', 600));
end;
$$;

-- Attachment lookup for the uploader before sending (verification input).
create or replace function app.api_attachment_for_send(p_attachment_id uuid, p_conv uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := app.require_user();
  a app.message_attachments;
begin
  select * into a from app.message_attachments
   where id = p_attachment_id and uploader_id = v_uid and conversation_id = p_conv;
  if a.id is null or a.status = 'deleted' then
    perform app.raise_api_error('ATTACHMENT_NOT_FOUND');
  end if;
  return jsonb_build_object('id', a.id, 'status', a.status, 'bucket', a.bucket, 'object_path', a.object_path,
                            'declared_mime', a.declared_mime, 'declared_size', a.declared_size,
                            'max_bytes', app.setting_int('attachments.max_bytes', 10485760),
                            'expired', a.status = 'pending' and a.created_at <
                              now() - make_interval(secs => app.setting_int('attachments.upload_url_ttl_seconds', 600)));
end;
$$;

-- Service step: record verified size/MIME (from storage + magic bytes).
create or replace function app.svc_mark_attachment_ready(p_attachment_id uuid, p_mime text, p_size bigint) returns void
language sql security definer set search_path = '' as $$
  update app.message_attachments
     set status = 'ready', verified_mime = p_mime, verified_size = p_size, verified_at = now()
   where id = p_attachment_id and status = 'pending'
$$;

create or replace function app.api_attachment_download(p_attachment_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := app.require_user();
  a app.message_attachments;
begin
  select * into a from app.message_attachments where id = p_attachment_id;
  if a.id is null or a.status = 'deleted'
     or not app.is_member_of_conversation(a.conversation_id, v_uid)
     or (a.status <> 'attached' and a.uploader_id <> v_uid) then
    perform app.raise_api_error('ATTACHMENT_NOT_FOUND');
  end if;
  if exists (select 1 from app.messages m where m.attachment_id = a.id and m.deleted_at is not null) then
    perform app.raise_api_error('ATTACHMENT_NOT_FOUND');
  end if;
  return jsonb_build_object('attachment_id', a.id, 'bucket', a.bucket, 'object_path', a.object_path,
                            'mime_type', coalesce(a.verified_mime, a.declared_mime),
                            'byte_size', coalesce(a.verified_size, a.declared_size),
                            'ttl_seconds', app.setting_int('attachments.download_url_ttl_seconds', 3600));
end;
$$;

-- ---------------------------------------------------------------------------
-- Realtime triggers
-- ---------------------------------------------------------------------------
create or replace function app.message_realtime_payload(m app.messages) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', m.id, 'conversation_id', m.conversation_id, 'seq', m.seq,
    'client_message_id', m.client_message_id,
    'sender', (app.user_summary_json(m.sender_id,
                (select gm.role from app.conversations c join app.guild_members gm
                   on gm.guild_id = c.guild_id and gm.user_id = m.sender_id where c.id = m.conversation_id))
              ) - 'avatar',
    'kind', m.kind,
    'text', case when m.deleted_at is null then m.body end,
    'attachment', case when m.attachment_id is not null and m.deleted_at is null then (
        select jsonb_build_object('id', a.id, 'mime_type', coalesce(a.verified_mime, a.declared_mime),
                                  'byte_size', coalesce(a.verified_size, a.declared_size), 'url', null, 'url_expires_at', null)
        from app.message_attachments a where a.id = m.attachment_id) end,
    'reaction_count', m.reaction_count,
    'is_deleted', m.deleted_at is not null,
    'created_at', app.ts(m.created_at))
$$;

create or replace function app.on_message_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform app.broadcast('conv:' || new.conversation_id, 'message.created', app.message_realtime_payload(new));
  return null;
end;
$$;
create trigger messages_broadcast_insert after insert on app.messages
  for each row execute function app.on_message_insert();

create or replace function app.on_message_delete_mark() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.deleted_at is null and new.deleted_at is not null then
    perform app.broadcast('conv:' || new.conversation_id, 'message.deleted',
      jsonb_build_object('id', new.id, 'conversation_id', new.conversation_id, 'seq', new.seq));
  end if;
  return null;
end;
$$;
create trigger messages_broadcast_delete after update of deleted_at on app.messages
  for each row execute function app.on_message_delete_mark();
