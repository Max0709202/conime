-- AI job lease/state machine (duplicate delivery safety) and matching eligibility.
\ir _helpers.inc
begin;
select plan(30);

select pg_temp.mk_user(('e0000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid) from generate_series(1, 6) n;
insert into app.consents (user_id, consent_type, consent_version, accepted)
select ('e0000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'ai_data_transfer', '2026-10-01', true from generate_series(1, 6) n;
insert into app.ai_jobs (id, user_id, kind, idempotency_key, max_attempts)
values ('e1000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001', 'diagnosis_generation', 'test:job1', 3);

-- lease ----------------------------------------------------------------------
create temp table lease as select app.svc_claim_job('e1000000-0000-4000-8000-000000000001', 60) as r;
select is((select (r ->> 'claimed')::boolean from lease), true, 'first delivery claims the job');
select is((app.svc_claim_job('e1000000-0000-4000-8000-000000000001', 60) ->> 'claimed')::boolean, false, 'duplicate delivery cannot claim a leased job');
select throws_ok($$select app.svc_update_job('e1000000-0000-4000-8000-000000000001', gen_random_uuid(), 'generating_profile', '{}', 60)$$,
  'CNM02', 'LEASE_LOST', 'stale worker (wrong fencing token) cannot update');
select lives_ok($$select app.svc_update_job('e1000000-0000-4000-8000-000000000001', (select (r -> 'job' ->> 'lock_token')::uuid from lease), 'normalizing_answers', '{"normalized":true}', 60)$$,
  'lease holder updates the stage');
select is((select stage_state ->> 'normalized' from app.ai_jobs where id = 'e1000000-0000-4000-8000-000000000001'), 'true', 'stage state persisted');

-- retryable failure → backoff + re-queue
select is(app.svc_fail_job('e1000000-0000-4000-8000-000000000001', (select (r -> 'job' ->> 'lock_token')::uuid from lease), 'AI_TIMEOUT', 'x', true), 'retrying', 'retryable failure → retrying');
select ok((select next_attempt_at > now() from app.ai_jobs where id = 'e1000000-0000-4000-8000-000000000001'), 'next attempt scheduled with backoff');
select is((select attempts from app.ai_jobs where id = 'e1000000-0000-4000-8000-000000000001'), 1, 'attempt counted');
select is((select count(*)::int from pgmq.q_ai_jobs where message ->> 'job_id' = 'e1000000-0000-4000-8000-000000000001'), 1, 'delayed queue message created');
select is((app.svc_claim_job('e1000000-0000-4000-8000-000000000001', 60) ->> 'claimed')::boolean, false, 'not claimable before it is due');

-- budget deferral does not consume attempts
update app.ai_jobs set next_attempt_at = now() - interval '1 second' where id = 'e1000000-0000-4000-8000-000000000001';
truncate lease; insert into lease select app.svc_claim_job('e1000000-0000-4000-8000-000000000001', 60);
select is(app.svc_fail_job('e1000000-0000-4000-8000-000000000001', (select (r -> 'job' ->> 'lock_token')::uuid from lease), 'AI_BUDGET_EXCEEDED', 'x', true, 3600), 'retrying', 'budget deferral → retrying');
select is((select attempts from app.ai_jobs where id = 'e1000000-0000-4000-8000-000000000001'), 1, 'deferral does not count as an attempt');

-- completion and duplicate delivery afterwards
update app.ai_jobs set next_attempt_at = now() - interval '1 second' where id = 'e1000000-0000-4000-8000-000000000001';
truncate lease; insert into lease select app.svc_claim_job('e1000000-0000-4000-8000-000000000001', 60);
select lives_ok($$select app.svc_complete_job('e1000000-0000-4000-8000-000000000001', (select (r -> 'job' ->> 'lock_token')::uuid from lease))$$, 'job completed');
select is((app.svc_claim_job('e1000000-0000-4000-8000-000000000001', 60) ->> 'status'), 'completed', 'late duplicate delivery sees completed job');
select is((select count(*)::int from app.notifications where user_id = 'e0000000-0000-4000-8000-000000000001' and type = 'generation_completed'), 1, 'completion notification');

-- permanent failure → manual retry --------------------------------------------
insert into app.ai_jobs (id, user_id, kind, idempotency_key, max_attempts)
values ('e1000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000002', 'diagnosis_generation', 'test:job2', 1);
truncate lease; insert into lease select app.svc_claim_job('e1000000-0000-4000-8000-000000000002', 60);
select is(app.svc_fail_job('e1000000-0000-4000-8000-000000000002', (select (r -> 'job' ->> 'lock_token')::uuid from lease), 'AI_UNAVAILABLE', 'x', true), 'failed', 'attempts exhausted → failed');
select pg_temp.as_user('e0000000-0000-4000-8000-000000000002');
select is((app.api_get_job('e1000000-0000-4000-8000-000000000002') ->> 'retryable')::boolean, true, 'failed job is manually retryable');
select is(app.api_retry_job('e1000000-0000-4000-8000-000000000002') ->> 'status', 'retrying', 'manual retry re-queues');
select throws_ok($$select app.api_retry_job('e1000000-0000-4000-8000-000000000002')$$, 'CNM01', 'JOB_NOT_RETRYABLE', 'cannot retry a job that is not failed');
select pg_temp.as_user('e0000000-0000-4000-8000-000000000003');
select throws_ok($$select app.api_get_job('e1000000-0000-4000-8000-000000000002')$$, 'CNM01', 'JOB_NOT_FOUND', 'other users cannot see the job');
reset role;

-- matching eligibility ---------------------------------------------------------
-- e3..e6 share Q6:A; e4 is blocked by e3, e5 is deleted, e6 has no character.
insert into app.diagnosis_submissions (id, user_id, client_request_id, question_set_id, consent_id)
select ('e2000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, ('e0000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       gen_random_uuid(), (select id from app.question_sets where status = 'active'),
       (select id from app.consents where user_id = ('e0000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid limit 1)
from generate_series(3, 6) n;
insert into app.profile_features (user_id, submission_id, question_code, feature_kind, match_key, resolution)
select ('e0000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, ('e2000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       'Q6', 'option', 'opt:Q6:A', 'option' from generate_series(3, 6) n;
insert into app.profile_features (user_id, submission_id, question_code, feature_kind, match_key, resolution)
values ('e0000000-0000-4000-8000-000000000003', 'e2000000-0000-4000-8000-000000000003', 'Q1', 'unresolved', 'raw:x', 'unresolved'),
       ('e0000000-0000-4000-8000-000000000004', 'e2000000-0000-4000-8000-000000000004', 'Q1', 'unresolved', 'raw:x', 'unresolved');
insert into app.user_avatars (user_id, character_code, attributes_version)
select ('e0000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'C-0000000' || n, 'v1' from generate_series(3, 5) n;
update app.profiles set status = 'deleted' where id = 'e0000000-0000-4000-8000-000000000005';

create temp table m as select app.compute_user_matches('e0000000-0000-4000-8000-000000000003', 1000) as r;
select ok(not exists (select 1 from m, jsonb_array_elements(r -> 'items') i where i -> 'user' ->> 'user_id' = 'e0000000-0000-4000-8000-000000000003'), 'self is never recommended');
select ok(exists (select 1 from m, jsonb_array_elements(r -> 'items') i where i -> 'user' ->> 'user_id' = 'e0000000-0000-4000-8000-000000000004'), 'matching user is recommended');
insert into app.blocks values ('e0000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000004');
truncate m; insert into m select app.compute_user_matches('e0000000-0000-4000-8000-000000000003', 1000);
select ok(not exists (select 1 from m, jsonb_array_elements(r -> 'items') i where i -> 'user' ->> 'user_id' = 'e0000000-0000-4000-8000-000000000004'), 'blocked user excluded');
select ok(not exists (select 1 from m, jsonb_array_elements(r -> 'items') i where i -> 'user' ->> 'user_id' = 'e0000000-0000-4000-8000-000000000005'), 'deleted user excluded');
select ok(not exists (select 1 from m, jsonb_array_elements(r -> 'items') i where i -> 'user' ->> 'user_id' = 'e0000000-0000-4000-8000-000000000006'), 'user without completed diagnosis excluded');
select ok(not exists (select 1 from jsonb_array_elements(app.compute_user_matches('e0000000-0000-4000-8000-000000000004', 1000) -> 'items') i
  where i -> 'user' ->> 'user_id' = 'e0000000-0000-4000-8000-000000000003'), 'block applies in both directions');

-- unresolved values never score; exact rule arithmetic
select is((app.score_feature_sets((select rules from app.matching_rule_versions where version = 'user-v1'),
  '[{"question_code":"Q1","match_key":"raw:x"}]', '[{"question_code":"Q1","match_key":"raw:y","label":"x"}]') ->> 'score')::numeric, 50::numeric,
  'no match → base 50');
select is((app.score_feature_sets((select rules from app.matching_rule_versions where version = 'user-v1'),
  '[{"question_code":"Q1","match_key":"w1"},{"question_code":"Q1","match_key":"w2"},{"question_code":"Q1","match_key":"w3"},{"question_code":"Q1","match_key":"w4"}]',
  '[{"question_code":"Q1","match_key":"w1","label":"a"},{"question_code":"Q1","match_key":"w2","label":"b"},{"question_code":"Q1","match_key":"w3","label":"c"},{"question_code":"Q1","match_key":"w4","label":"d"}]') ->> 'score')::numeric,
  62::numeric, 'Q1 cap: 4 matching works give +12, not +16');
select is((app.score_feature_sets((select rules from app.matching_rule_versions where version = 'guild-v1'),
  '[{"question_code":"Q16","match_key":"opt:Q16:A"},{"question_code":"Q18","match_key":"opt:Q18:B"}]',
  '[{"question_code":"Q16","match_key":"opt:Q16:A","label":"x"},{"question_code":"Q18","match_key":"opt:Q18:B","label":"y"}]') ->> 'score')::numeric,
  15::numeric, 'guild-v1: 7.5 + 7.5');
select is((app.score_feature_sets((select rules from app.matching_rule_versions where version = 'user-v1'),
  '[{"question_code":"Q13","match_key":"opt:Q13:A"}]', '[{"question_code":"Q13","match_key":"opt:Q13:B","label":"x"}]') -> 'matched_items'), '[]'::jsonb,
  'similar-but-different options score nothing');

select * from finish();
rollback;
