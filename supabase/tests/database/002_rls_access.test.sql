-- Row Level Security behaviour with allow AND deny cases:
-- anonymous, owner, other user, guild member, non-member, blocked user,
-- deleted account, service role, realtime channel authorization.
\ir _helpers.inc
begin;
select plan(68);

-- ---------------------------------------------------------------- fixtures
select pg_temp.mk_user('aaaaaaaa-0000-4000-8000-000000000001'); -- A owner
select pg_temp.mk_user('bbbbbbbb-0000-4000-8000-000000000002'); -- B other user / guild co-member
select pg_temp.mk_user('cccccccc-0000-4000-8000-000000000003'); -- C blocked by A, DM peer
select pg_temp.mk_user('dddddddd-0000-4000-8000-000000000004'); -- D deleted account (was member)
select pg_temp.mk_user('eeeeeeee-0000-4000-8000-000000000005'); -- E non-member

insert into app.consents (id, user_id, consent_type, consent_version, accepted)
values ('a0000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'ai_data_transfer', '2026-10-01', true);
insert into app.diagnosis_submissions (id, user_id, client_request_id, question_set_id, consent_id)
values ('a1000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', gen_random_uuid(),
        (select id from app.question_sets where status = 'active'), 'a0000000-0000-4000-8000-000000000001');
insert into app.diagnosis_answers (submission_id, question_id, value_index, text_value)
values ('a1000000-0000-4000-8000-000000000001', md5('conime/qs-2026-10-v1/Q2')::uuid, 0, 'secret scene');
insert into app.profile_features (user_id, submission_id, question_code, feature_kind, match_key, resolution)
values ('aaaaaaaa-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'Q6', 'option', 'opt:Q6:A', 'option');
insert into app.user_avatars (user_id, character_code, attributes_version) values ('aaaaaaaa-0000-4000-8000-000000000001', 'C-AAAAAAAA', 'v1');
insert into app.user_growth (user_id, rule_version) values ('aaaaaaaa-0000-4000-8000-000000000001', 'level-v1');
insert into app.ai_jobs (user_id, kind, idempotency_key) values ('aaaaaaaa-0000-4000-8000-000000000001', 'diagnosis_generation', 'test:a');
insert into app.notifications (user_id, type) values ('aaaaaaaa-0000-4000-8000-000000000001', 'level_up');
insert into app.navigator_messages (user_id, role, body) values ('aaaaaaaa-0000-4000-8000-000000000001', 'user', 'hello');
insert into app.blocks (blocker_id, blocked_id) values ('aaaaaaaa-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000003');

insert into app.guilds (id, slug, name, status) values
  ('99999999-0000-4000-8000-000000000001', 't-pub', 'Published', 'published'),
  ('99999999-0000-4000-8000-000000000002', 't-draft', 'Draft', 'draft');
insert into app.guild_members (guild_id, user_id) values
  ('99999999-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001'),
  ('99999999-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002'),
  ('99999999-0000-4000-8000-000000000001', 'dddddddd-0000-4000-8000-000000000004');
insert into app.guild_announcements (guild_id, title, body) values ('99999999-0000-4000-8000-000000000001', 't', 'b');
insert into app.conversations (id, kind, guild_id) values ('88888888-0000-4000-8000-000000000001', 'guild', '99999999-0000-4000-8000-000000000001');
insert into app.conversations (id, kind, dm_user_low, dm_user_high) values
  ('88888888-0000-4000-8000-000000000002', 'dm', 'aaaaaaaa-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000003');
insert into app.conversation_members (conversation_id, user_id) values
  ('88888888-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001'),
  ('88888888-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002'),
  ('88888888-0000-4000-8000-000000000001', 'dddddddd-0000-4000-8000-000000000004'),
  ('88888888-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001'),
  ('88888888-0000-4000-8000-000000000002', 'cccccccc-0000-4000-8000-000000000003');
insert into app.messages (id, conversation_id, seq, sender_id, client_message_id, kind, body) values
  ('77777777-0000-4000-8000-000000000001', '88888888-0000-4000-8000-000000000001', 1, 'bbbbbbbb-0000-4000-8000-000000000002', gen_random_uuid(), 'text', 'guild msg'),
  ('77777777-0000-4000-8000-000000000002', '88888888-0000-4000-8000-000000000002', 1, 'cccccccc-0000-4000-8000-000000000003', gen_random_uuid(), 'text', 'dm msg');
insert into app.message_attachments (id, conversation_id, uploader_id, bucket, object_path, declared_mime, declared_size, status) values
  ('66666666-0000-4000-8000-000000000001', '88888888-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002', 'chat-attachments', 't/1.png', 'image/png', 10, 'attached'),
  ('66666666-0000-4000-8000-000000000002', '88888888-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002', 'chat-attachments', 't/2.png', 'image/png', 10, 'pending');
insert into app.reactions (giver_id, target_type, target_id, recipient_id)
values ('aaaaaaaa-0000-4000-8000-000000000001', 'message', '77777777-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002');
insert into app.reports (reporter_id, target_type, target_id, reason_code, snapshot, snapshot_sha256)
values ('aaaaaaaa-0000-4000-8000-000000000001', 'message', '77777777-0000-4000-8000-000000000001', 'spam', '{}', 'x');
insert into realtime.messages (topic, extension, payload, event, private) values
  ('conv:88888888-0000-4000-8000-000000000001', 'broadcast', '{}', 'message.created', true),
  ('user:aaaaaaaa-0000-4000-8000-000000000001', 'broadcast', '{}', 'notification.created', true);
update app.profiles set status = 'deleted' where id = 'dddddddd-0000-4000-8000-000000000004';

-- ---------------------------------------------------------------- anonymous
select pg_temp.as_anon();
select throws_ok('select count(*) from app.profiles', '42501', null, 'anon cannot read profiles');
select throws_ok('select count(*) from app.messages', '42501', null, 'anon cannot read messages');
select throws_ok('select count(*) from app.guilds', '42501', null, 'anon cannot read guilds');
select throws_ok('select count(*) from app.diagnosis_answers', '42501', null, 'anon cannot read answers');
select isnt((select app.api_get_current_question_set()), null, 'anon can read the current question set');
select throws_ok('select app.api_me()', '42501', null, 'anon cannot call authenticated API functions');
reset role;

-- ---------------------------------------------------------------- owner (A)
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');
select is((select count(*)::int from app.profiles), 1, 'A sees only own profile');
select is((select count(*)::int from app.consents), 1, 'A sees own consent');
select is((select count(*)::int from app.diagnosis_submissions), 1, 'A sees own submission');
select is((select count(*)::int from app.diagnosis_answers), 1, 'A sees own answers');
select is((select count(*)::int from app.profile_features), 1, 'A sees own features');
select is((select count(*)::int from app.user_avatars), 1, 'A sees own avatar row');
select is((select count(*)::int from app.user_growth), 1, 'A sees own growth');
select is((select count(*)::int from app.ai_jobs), 1, 'A sees own jobs');
select is((select count(*)::int from app.notifications), 1, 'A sees own notifications');
select is((select count(*)::int from app.navigator_messages), 1, 'A sees own navigator history');
select is((select count(*)::int from app.blocks), 1, 'A sees own block list');
select is((select count(*)::int from app.reports), 1, 'A sees own report');
select is((select count(*)::int from app.reactions), 1, 'A sees reaction they gave');
select throws_ok($$insert into app.messages (conversation_id, seq, sender_id, kind, body) values ('88888888-0000-4000-8000-000000000001', 9, 'aaaaaaaa-0000-4000-8000-000000000001', 'text', 'x')$$,
  '42501', null, 'A cannot insert messages directly');
select throws_ok($$update app.user_growth set total_exp = 999999$$, '42501', null, 'A cannot write EXP directly');
select throws_ok($$update app.guilds set member_count = 0$$, '42501', null, 'A cannot alter guild counters');
select throws_ok($$insert into app.reactions (giver_id, target_type, target_id, recipient_id) values ('aaaaaaaa-0000-4000-8000-000000000001','message',gen_random_uuid(),'bbbbbbbb-0000-4000-8000-000000000002')$$,
  '42501', null, 'A cannot insert reactions directly');
select throws_ok('select count(*) from app.app_settings', '42501', null, 'A cannot read app_settings');
select throws_ok('select count(*) from app.ai_runs', '42501', null, 'A cannot read ai_runs');
select throws_ok('select count(*) from app.guild_match_traits', '42501', null, 'A cannot read guild matching parameters');
select throws_ok($$select app.svc_claim_job(gen_random_uuid(), 60)$$, '42501', null, 'A cannot call service functions');

-- guild / conversation access as member A
select is((select count(*)::int from app.guilds where slug in ('t-pub', 't-draft')), 1, 'A sees the published guild only (not the draft)');
select is((select count(*)::int from app.guild_members where guild_id = '99999999-0000-4000-8000-000000000001'), 3, 'A sees co-members');
select is((select count(*)::int from app.guild_announcements), 1, 'A sees member announcements');
select is((select count(*)::int from app.conversations), 2, 'A sees guild room and own DM');
select is((select count(*)::int from app.messages), 2, 'A reads guild and DM messages');
select is((select count(*)::int from app.message_attachments), 1, 'A sees attached files only (not others'' pending uploads)');

-- realtime authorization as A
select set_config('realtime.topic', 'conv:88888888-0000-4000-8000-000000000001', true);
select ok((select count(*)::int from realtime.messages where topic = realtime.topic()) >= 1, 'A may receive guild room broadcasts');
select set_config('realtime.topic', 'user:aaaaaaaa-0000-4000-8000-000000000001', true);
select is((select count(*)::int from realtime.messages where topic = realtime.topic()), 1, 'A may receive own user channel');
select set_config('realtime.topic', 'user:bbbbbbbb-0000-4000-8000-000000000002', true);
select is((select count(*)::int from realtime.messages), 0, 'A may not join another user''s channel');
select set_config('realtime.topic', 'conv:not-a-uuid', true);
select is((select count(*)::int from realtime.messages), 0, 'malformed topic is denied');
select throws_ok($$insert into realtime.messages (topic, extension, payload, event, private) values ('conv:88888888-0000-4000-8000-000000000001', 'broadcast', '{}', 'x', true)$$,
  '42501', null, 'clients cannot broadcast');
reset role;

-- ---------------------------------------------------------------- other user (B)
select pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002');
select is((select count(*)::int from app.profiles where id = 'aaaaaaaa-0000-4000-8000-000000000001'), 0, 'B cannot read A profile row');
select is((select count(*)::int from app.consents), 0, 'B cannot read A consent');
select is((select count(*)::int from app.diagnosis_answers), 0, 'B cannot read A answers');
select is((select count(*)::int from app.profile_features), 0, 'B cannot read A features');
select is((select count(*)::int from app.user_avatars), 0, 'B cannot read A avatar row directly');
select is((select count(*)::int from app.notifications), 0, 'B cannot read A notifications');
select is((select count(*)::int from app.navigator_messages), 0, 'B cannot read A navigator history');
select is((select count(*)::int from app.reports), 0, 'B cannot read A reports');
select is((select count(*)::int from app.reactions), 1, 'B (recipient) sees the reaction received');
select is((select count(*)::int from app.conversations where kind = 'dm'), 0, 'B cannot see the A–C DM');
select is((select count(*)::int from app.messages where conversation_id = '88888888-0000-4000-8000-000000000002'), 0, 'B cannot read the A–C DM');
select is((select count(*)::int from app.message_attachments), 2, 'B (uploader) sees own pending upload');
reset role;

-- ---------------------------------------------------------------- blocked user (C)
select pg_temp.as_user('cccccccc-0000-4000-8000-000000000003');
select is((select count(*)::int from app.blocks), 0, 'C cannot see that A blocked them');
select is((select count(*)::int from app.guilds where id = '99999999-0000-4000-8000-000000000001'), 1, 'C sees published guild details');
select is((select count(*)::int from app.guild_members), 0, 'C (non-member) cannot list guild members');
select is((select count(*)::int from app.guild_announcements), 0, 'C (non-member) cannot read announcements');
select is((select count(*)::int from app.messages where conversation_id = '88888888-0000-4000-8000-000000000001'), 0, 'C (non-member) cannot read guild chat');
select is((select count(*)::int from app.messages where conversation_id = '88888888-0000-4000-8000-000000000002'), 1, 'C still reads the existing DM history');
select throws_ok($$select app.api_send_message('88888888-0000-4000-8000-000000000002', gen_random_uuid(), 'text', 'hi', null)$$,
  'CNM01', 'BLOCKED', 'C cannot continue the DM after the block');
select throws_ok($$select app.api_public_profile('aaaaaaaa-0000-4000-8000-000000000001')$$, 'CNM01', 'USER_NOT_FOUND', 'C cannot view the blocker''s profile');
select set_config('realtime.topic', 'conv:88888888-0000-4000-8000-000000000001', true);
select is((select count(*)::int from realtime.messages), 0, 'C (non-member) cannot subscribe to the guild room');
reset role;

-- ---------------------------------------------------------------- non-member (E)
select pg_temp.as_user('eeeeeeee-0000-4000-8000-000000000005');
select is((select count(*)::int from app.conversations), 0, 'E sees no conversations');
select throws_ok($$select app.api_list_messages('88888888-0000-4000-8000-000000000001', null, null, 10)$$, 'CNM01', 'CONVERSATION_NOT_FOUND', 'E cannot list guild messages');
select throws_ok($$select app.api_guild_members('99999999-0000-4000-8000-000000000001', null, 10)$$, 'CNM01', 'NOT_A_MEMBER', 'E cannot list members');
select throws_ok($$select app.api_guild_detail('99999999-0000-4000-8000-000000000002')$$, 'CNM01', 'GUILD_NOT_FOUND', 'E cannot see the draft guild');
reset role;

-- ---------------------------------------------------------------- deleted account (D)
select pg_temp.as_user('dddddddd-0000-4000-8000-000000000004');
select is((select count(*)::int from app.messages), 0, 'deleted account cannot read guild chat');
select set_config('realtime.topic', 'conv:88888888-0000-4000-8000-000000000001', true);
select is((select count(*)::int from realtime.messages), 0, 'deleted account cannot subscribe');
select throws_ok('select app.api_my_profile()', 'CNM01', 'ACCOUNT_DELETED', 'deleted account is rejected by API functions');
reset role;

-- ---------------------------------------------------------------- service role
select pg_temp.as_service();
select ok((select count(*) from app.messages) >= 2, 'service_role reads all messages');
select ok((select count(*) from app.app_settings) > 0, 'service_role reads settings');
reset role;

select * from finish();
rollback;
