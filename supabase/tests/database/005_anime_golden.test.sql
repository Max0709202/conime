-- Golden test for anime-v1 candidate scoring (概要8 アニメ(仮)) with an isolated master.
\ir _helpers.inc
begin;
select plan(9);

-- isolate: deactivate seeded works for this transaction
update app.anime_works set status = 'inactive';
select pg_temp.mk_user('ab000000-0000-4000-8000-000000000001');
insert into app.consents (id, user_id, consent_type, consent_version, accepted)
values ('ab100000-0000-4000-8000-000000000001', 'ab000000-0000-4000-8000-000000000001', 'ai_data_transfer', '2026-10-01', true);
insert into app.diagnosis_submissions (id, user_id, client_request_id, question_set_id, consent_id)
values ('ab200000-0000-4000-8000-000000000001', 'ab000000-0000-4000-8000-000000000001', gen_random_uuid(),
        (select id from app.question_sets where status = 'active'), 'ab100000-0000-4000-8000-000000000001');
insert into app.tags (kind, code, name) values ('genre', 'g_test_a', 'GA'), ('genre', 'g_test_b', 'GB'), ('genre', 'g_test_c', 'GC'),
  ('genre', 'g_test_bad', 'BAD'), ('world_setting', 'w_test', 'WT') on conflict do nothing;
insert into app.anime_works (id, external_code, title) values
  ('ab300000-0000-4000-8000-000000000001', 'T-FAV', 'Fav'),            -- user's favourite (viewed)
  ('ab300000-0000-4000-8000-000000000002', 'T-KID', 'Kid'),            -- childhood (viewed)
  ('ab300000-0000-4000-8000-000000000003', 'T-BEST', 'Best'),          -- GA + GB + WT + action → high
  ('ab300000-0000-4000-8000-000000000004', 'T-MID', 'Mid'),            -- GA only
  ('ab300000-0000-4000-8000-000000000005', 'T-DISLIKED', 'Disliked'),  -- has disliked genre → excluded
  ('ab300000-0000-4000-8000-000000000006', 'T-NONE', 'None');          -- no overlap
insert into app.work_tags (work_id, tag_id)
select w, (select id from app.tags where kind = k and code = c) from (values
  ('ab300000-0000-4000-8000-000000000001'::uuid, 'genre', 'g_test_a'), ('ab300000-0000-4000-8000-000000000001', 'genre', 'g_test_b'),
  ('ab300000-0000-4000-8000-000000000003', 'genre', 'g_test_a'), ('ab300000-0000-4000-8000-000000000003', 'genre', 'g_test_b'),
  ('ab300000-0000-4000-8000-000000000003', 'world_setting', 'w_test'), ('ab300000-0000-4000-8000-000000000003', 'genre', 'action'),
  ('ab300000-0000-4000-8000-000000000004', 'genre', 'g_test_a'),
  ('ab300000-0000-4000-8000-000000000005', 'genre', 'g_test_a'), ('ab300000-0000-4000-8000-000000000005', 'genre', 'g_test_bad'),
  ('ab300000-0000-4000-8000-000000000006', 'genre', 'g_test_c')) v(w, k, c);
insert into app.profile_features (user_id, submission_id, question_code, feature_kind, match_key, work_id, tag_id, option_id, resolution)
values
  ('ab000000-0000-4000-8000-000000000001', 'ab200000-0000-4000-8000-000000000001', 'Q1', 'work', 'work:fav', 'ab300000-0000-4000-8000-000000000001', null, null, 'alias_exact'),
  ('ab000000-0000-4000-8000-000000000001', 'ab200000-0000-4000-8000-000000000001', 'Q7', 'work', 'work:kid', 'ab300000-0000-4000-8000-000000000002', null, null, 'alias_exact'),
  ('ab000000-0000-4000-8000-000000000001', 'ab200000-0000-4000-8000-000000000001', 'Q8', 'genre', 'tag:bad', null, (select id from app.tags where code = 'g_test_bad'), null, 'alias_exact'),
  ('ab000000-0000-4000-8000-000000000001', 'ab200000-0000-4000-8000-000000000001', 'Q11', 'world_setting', 'tag:wt', null, (select id from app.tags where code = 'w_test'), null, 'alias_exact'),
  ('ab000000-0000-4000-8000-000000000001', 'ab200000-0000-4000-8000-000000000001', 'Q15', 'option', 'opt:Q15:A', null, null, md5('conime/qs-2026-10-v1/Q15/A')::uuid, 'option');

create temp table c as select app.svc_anime_candidates('ab000000-0000-4000-8000-000000000001') as r;
select is((select r ->> 'rule_version' from c), 'anime-v1', 'rule version');
select ok(not exists (select 1 from c, jsonb_array_elements(r -> 'candidates') x where x ->> 'title' in ('Fav', 'Kid')), 'Q1/Q7 works excluded as already viewed');
select ok(not exists (select 1 from c, jsonb_array_elements(r -> 'candidates') x where x ->> 'title' = 'Disliked'), 'works with a Q8 disliked genre excluded');
select is((select r -> 'candidates' -> 0 ->> 'title' from c), 'Best', 'highest score first');
-- Best: GA, GB (favourite genres, 2×10=20) + world setting (30) + Q15:A → action (30) = 80
select is((select (r -> 'candidates' -> 0 ->> 'score')::numeric from c), 80::numeric, 'Best scores 20 + 30 + 30 = 80');
select is((select (x ->> 'score')::numeric from c, jsonb_array_elements(r -> 'candidates') x where x ->> 'title' = 'Mid'), 10::numeric, 'Mid scores 10');
select is((select (x ->> 'score')::numeric from c, jsonb_array_elements(r -> 'candidates') x where x ->> 'title' = 'None'), 0::numeric, 'no overlap scores 0 but remains a candidate');
select is((select (r ->> 'result_limit')::int from c), 3, 'AI may return at most 3');
select throws_ok($$select app.svc_save_anime_recommendations('ab000000-0000-4000-8000-000000000001', null,
  '[{"rank":1,"work_id":"ab300000-0000-4000-8000-000000000001","score":0,"reason":"x","reason_source":"ai"}]', 'anime-v1')$$,
  'CNM03', null, 'saving a work outside the candidate set is rejected');

select * from finish();
rollback;
