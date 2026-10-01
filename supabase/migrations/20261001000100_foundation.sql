-- Foundation: extensions, private schema, settings, profiles, consent, audit,
-- idempotency and rate limiting.
--
-- All application tables live in schema "app", which is NOT exposed through the
-- Supabase Data API. Clients reach data only through the /v1 Edge Function.

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pgmq') then
    create extension if not exists pgmq;
  end if;
  if not exists (select 1 from pg_namespace where nspname = 'pgmq') then
    raise exception 'pgmq (Supabase Queues) is required';
  end if;
end $$;

create schema if not exists app;
revoke all on schema app from public;
grant usage on schema app to anon, authenticated, service_role;

-- Functions are not executable by PUBLIC unless granted explicitly.
alter default privileges in schema app revoke execute on functions from public;
alter default privileges in schema app grant all on tables to service_role;
alter default privileges in schema app grant all on sequences to service_role;

-- ---------------------------------------------------------------------------
-- Generic helpers
-- ---------------------------------------------------------------------------
create or replace function app.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function app.reject_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and current_setting('app.retention_purge', true) = 'on' then
    return old;
  end if;
  raise exception 'table %.% is append-only', tg_table_schema, tg_table_name
    using errcode = 'P0001';
end;
$$;

-- Raise an API error that the Edge Function maps to the error envelope.
-- SQLSTATE 'CNM01'..: message = error code, detail = JSON details.
create or replace function app.raise_api_error(p_code text, p_details jsonb default '{}'::jsonb)
returns void
language plpgsql set search_path = '' as $$
begin
  raise exception using
    errcode = 'CNM01',
    message = p_code,
    detail = coalesce(p_details, '{}'::jsonb)::text;
end;
$$;

-- ---------------------------------------------------------------------------
-- Settings (operational configuration, environment specific values seeded
-- separately). Never readable by clients directly.
-- ---------------------------------------------------------------------------
create table app.app_settings (
  key text primary key,
  value jsonb not null,
  description text,
  updated_at timestamptz not null default now()
);
create trigger app_settings_touch before update on app.app_settings
  for each row execute function app.touch_updated_at();

create or replace function app.setting(p_key text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select value from app.app_settings where key = p_key
$$;

create or replace function app.setting_int(p_key text, p_default integer) returns integer
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select case when jsonb_typeof(value) = 'number' then (value #>> '{}')::integer end
       from app.app_settings where key = p_key),
    p_default)
$$;

create or replace function app.setting_text(p_key text, p_default text) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select value #>> '{}' from app.app_settings where key = p_key and jsonb_typeof(value) <> 'null'), p_default)
$$;

create or replace function app.setting_bool(p_key text, p_default boolean) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select (value #>> '{}')::boolean from app.app_settings
                    where key = p_key and jsonb_typeof(value) = 'boolean'), p_default)
$$;

-- ---------------------------------------------------------------------------
-- Profiles (1:1 with auth.users)
-- ---------------------------------------------------------------------------
create table app.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  status text not null default 'active'
    check (status in ('active', 'deletion_requested', 'deleted')),
  ai_profile jsonb,
  last_active_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index profiles_status_idx on app.profiles (status);
create trigger profiles_touch before update on app.profiles
  for each row execute function app.touch_updated_at();

create or replace function app.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into app.profiles (id) values (new.id) on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function app.handle_new_auth_user();

-- Current user is an active account (used by RLS helpers and API functions).
create or replace function app.current_user_active() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from app.profiles p where p.id = auth.uid() and p.status = 'active')
$$;

-- Require an authenticated active user; returns the user id.
create or replace function app.require_user() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_status text;
begin
  if v_uid is null then
    perform app.raise_api_error('UNAUTHENTICATED');
  end if;
  select status into v_status from app.profiles where id = v_uid;
  if v_status is null then
    perform app.raise_api_error('UNAUTHENTICATED');
  elsif v_status <> 'active' then
    perform app.raise_api_error('ACCOUNT_DELETED');
  end if;
  return v_uid;
end;
$$;

-- ---------------------------------------------------------------------------
-- Consent (append-only)
-- ---------------------------------------------------------------------------
create table app.consents (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity unique, -- total order of consent events (latest wins)
  user_id uuid not null references app.profiles (id) on delete cascade,
  consent_type text not null check (consent_type in ('ai_data_transfer')),
  consent_version text not null check (length(consent_version) between 1 and 64),
  accepted boolean not null,
  request_id uuid,
  created_at timestamptz not null default now()
);
create index consents_user_type_idx on app.consents (user_id, consent_type, seq desc);
create trigger consents_append_only before update or delete on app.consents
  for each row execute function app.reject_mutation();

-- ---------------------------------------------------------------------------
-- Account deletion requests
-- ---------------------------------------------------------------------------
create table app.account_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references app.profiles (id) on delete cascade,
  status text not null default 'requested'
    check (status in ('requested', 'processing', 'completed', 'failed')),
  reason text check (length(reason) <= 500),
  requested_at timestamptz not null default now(),
  process_after timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  attempts integer not null default 0,
  last_error text
);
create index account_deletion_pending_idx on app.account_deletion_requests (process_after)
  where status in ('requested', 'failed');

-- ---------------------------------------------------------------------------
-- Audit log (append-only; contains no answer text or personal data)
-- ---------------------------------------------------------------------------
create table app.audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid,
  action text not null,
  target_type text,
  target_id text,
  request_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_actor_idx on app.audit_logs (actor_id, created_at desc);
create index audit_logs_created_idx on app.audit_logs (created_at);
create trigger audit_logs_append_only before update or delete on app.audit_logs
  for each row execute function app.reject_mutation();

create or replace function app.audit(
  p_action text, p_target_type text default null, p_target_id text default null,
  p_metadata jsonb default '{}'::jsonb, p_actor uuid default null
) returns void
language sql security definer set search_path = '' as $$
  insert into app.audit_logs (actor_id, action, target_type, target_id, request_id, metadata)
  values (
    coalesce(p_actor, auth.uid()), p_action, p_target_type, p_target_id,
    nullif(current_setting('app.request_id', true), '')::uuid,
    coalesce(p_metadata, '{}'::jsonb)
  )
$$;

-- ---------------------------------------------------------------------------
-- Idempotency keys (stored HTTP responses for retried mutations)
-- ---------------------------------------------------------------------------
create table app.idempotency_keys (
  user_id uuid not null references app.profiles (id) on delete cascade,
  idem_key text not null check (length(idem_key) between 8 and 64),
  method text not null,
  route text not null,
  request_hash text not null,
  state text not null default 'in_progress' check (state in ('in_progress', 'completed')),
  response_status integer,
  response_body jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours',
  primary key (user_id, idem_key)
);
create index idempotency_expires_idx on app.idempotency_keys (expires_at);

-- ---------------------------------------------------------------------------
-- Rate limiting (fixed window counters)
-- ---------------------------------------------------------------------------
create table app.rate_limit_counters (
  bucket_key text not null,
  window_start timestamptz not null,
  hits integer not null default 0,
  primary key (bucket_key, window_start)
);
create index rate_limit_window_idx on app.rate_limit_counters (window_start);

-- Increments the counter for the caller (auth.uid()) or, for anonymous calls, the
-- supplied subject (an IP hash computed by the API). Returns allowed + retry_after.
create or replace function app.api_rate_limit(
  p_scope text, p_limit integer, p_window_seconds integer, p_subject text default null
) returns table (allowed boolean, retry_after_seconds integer)
language plpgsql security definer set search_path = '' as $$
declare
  v_subject text := coalesce(auth.uid()::text, p_subject, 'anonymous');
  v_window timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_hits integer;
begin
  insert into app.rate_limit_counters as c (bucket_key, window_start, hits)
  values (p_scope || ':' || v_subject, v_window, 1)
  on conflict (bucket_key, window_start) do update set hits = c.hits + 1
  returning hits into v_hits;

  allowed := v_hits <= p_limit;
  retry_after_seconds := case when allowed then 0
    else greatest(1, ceil(extract(epoch from (v_window + make_interval(secs => p_window_seconds) - now())))::integer) end;
  return next;
end;
$$;
