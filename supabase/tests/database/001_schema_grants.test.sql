-- Schema-wide security invariants: RLS on every table, no client write grants,
-- no anonymous table access, service-only tables, function execute grants.
\ir _helpers.inc
begin;

select plan(
  (select count(*)::int from pg_tables where schemaname = 'app') * 5 + 12
);

-- 1) RLS enabled on every table in schema app
select ok(c.relrowsecurity, format('RLS enabled on app.%s', c.relname))
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'app' and c.relkind = 'r' order by c.relname;

-- 2) authenticated has no INSERT/UPDATE/DELETE on any table
select ok(not has_table_privilege('authenticated', format('app.%I', tablename), 'INSERT'),
          format('authenticated cannot INSERT app.%s', tablename))
from pg_tables where schemaname = 'app' order by tablename;
select ok(not has_table_privilege('authenticated', format('app.%I', tablename), 'UPDATE')
          and not has_table_privilege('authenticated', format('app.%I', tablename), 'DELETE'),
          format('authenticated cannot UPDATE/DELETE app.%s', tablename))
from pg_tables where schemaname = 'app' order by tablename;

-- 3) anon has no table privilege at all
select ok(not has_table_privilege('anon', format('app.%I', tablename), 'SELECT')
          and not has_table_privilege('anon', format('app.%I', tablename), 'INSERT'),
          format('anon has no access to app.%s', tablename))
from pg_tables where schemaname = 'app' order by tablename;

-- 4) service_role has full access (worker)
select ok(has_table_privilege('service_role', format('app.%I', tablename), 'SELECT,INSERT,UPDATE,DELETE'),
          format('service_role can manage app.%s', tablename))
from pg_tables where schemaname = 'app' order by tablename;

-- 5) service-only tables are not readable by authenticated
select ok(not has_table_privilege('authenticated', 'app.app_settings', 'SELECT'), 'app_settings is service-only');
select ok(not has_table_privilege('authenticated', 'app.audit_logs', 'SELECT'), 'audit_logs is service-only');
select ok(not has_table_privilege('authenticated', 'app.ai_runs', 'SELECT'), 'ai_runs is service-only');
select ok(not has_table_privilege('authenticated', 'app.moderation_events', 'SELECT'), 'moderation_events is service-only');
select ok(not has_table_privilege('authenticated', 'app.guild_match_traits', 'SELECT'), 'guild_match_traits is service-only');
select ok(not has_table_privilege('authenticated', 'app.idempotency_keys', 'SELECT'), 'idempotency_keys is service-only');

-- 6) function grants: no svc_* for authenticated/anon; anon only public reads
select is((select count(*)::int from pg_proc p where p.pronamespace = 'app'::regnamespace and p.proname like 'svc\_%'
           and has_function_privilege('authenticated', p.oid, 'EXECUTE')), 0, 'authenticated cannot execute any svc_* function');
select is((select count(*)::int from pg_proc p where p.pronamespace = 'app'::regnamespace and p.proname like 'svc\_%'
           and has_function_privilege('anon', p.oid, 'EXECUTE')), 0, 'anon cannot execute any svc_* function');
select set_eq(
  $$select p.proname::text from pg_proc p where p.pronamespace = 'app'::regnamespace
     and has_function_privilege('anon', p.oid, 'EXECUTE')$$,
  array['api_get_current_question_set', 'api_client_config', 'api_rate_limit'],
  'anon can execute only the public read functions');
select is((select count(*)::int from pg_proc p where p.pronamespace = 'app'::regnamespace
           and p.proname in ('apply_exp', 'notify', 'broadcast', 'audit', 'raise_api_error')
           and has_function_privilege('authenticated', p.oid, 'EXECUTE')), 0, 'internal helpers are not callable by clients');

-- 7) the app schema is not exposed through the Data API (no grants in public either)
select is((select count(*)::int from pg_tables where schemaname = 'public'), 0, 'public schema has no tables');

-- 8) storage buckets are private
select ok(not exists (select 1 from storage.buckets where id in ('chat-attachments', 'avatars') and public), 'buckets are private');

select * from finish();
rollback;
