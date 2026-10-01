-- Schedules the worker (Supabase only: requires pg_cron + pg_net and Vault).
-- Before running, store secrets in Vault (once per environment):
--   select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/worker', 'conime_worker_url');
--   select vault.create_secret('<WORKER_SECRET value>', 'conime_worker_secret');
-- Then: psql "$DB_URL" -f supabase/settings/cron.sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function app.invoke_worker(p_task text) returns bigint
language sql security definer set search_path = '' as $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'conime_worker_url'),
    headers := jsonb_build_object('content-type', 'application/json',
                                  'x-worker-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'conime_worker_secret')),
    body := jsonb_build_object('task', p_task),
    timeout_milliseconds := 60000)
$$;
revoke all on function app.invoke_worker(text) from public, anon, authenticated;

select cron.unschedule(jobname) from cron.job where jobname in ('conime-worker-drain', 'conime-maintenance');
-- Drain the AI job queue every 10 seconds (the API also wakes the worker immediately).
select cron.schedule('conime-worker-drain', '10 seconds', $$select app.invoke_worker('drain')$$);
-- Maintenance hourly: deletion processing, orphan uploads, history retention, evidence holds, expiry.
select cron.schedule('conime-maintenance', '7 * * * *', $$select app.invoke_worker('maintenance')$$);
