-- Shared helpers for pgTAP files (included with \ir). Works with `supabase test db`
-- (pgtap extension) and with scripts/test-db.sh on the user-space PostgreSQL (tap schema).
\set QUIET on
\set ON_ERROR_STOP off
do $$ begin
  if not exists (select 1 from pg_proc where proname = 'plan') then
    create extension if not exists pgtap with schema extensions;
  end if;
end $$;
set search_path = public, extensions, tap;

-- Switch identity for the rest of the transaction.
create or replace function pg_temp.as_user(p uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create or replace function pg_temp.as_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  perform set_config('role', 'anon', true);
end $$;
create or replace function pg_temp.as_service() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', 'service_role', true);
end $$;

-- Fixture users (created as postgres; profiles via the auth trigger).
create or replace function pg_temp.mk_user(p uuid) returns uuid language plpgsql as $$
begin
  insert into auth.users (id, email) values (p, p::text || '@t.test') on conflict do nothing;
  insert into app.profiles (id) values (p) on conflict do nothing;
  return p;
end $$;
\set QUIET off
