-- Authoritative business rules implemented in app.api_* / app.svc_* functions.
\ir _helpers.inc
begin;
select plan(65);

-- fixtures ----------------------------------------------------------------
select pg_temp.mk_user(('f0000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid) from generate_series(1, 8) n;
insert into app.guilds (id, slug, name, status, capacity) values
  ('f9000000-0000-4000-8000-000000000001', 'cap2', 'Cap Two', 'published', 2),
  ('f9000000-0000-4000-8000-000000000002', 'open', 'Open', 'published', null),
  ('f9000000-0000-4000-8000-000000000003', 'third', 'Third', 'published', null);
insert into app.consents (user_id, consent_type, consent_version, accepted)
select ('f0000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'ai_data_transfer', '2026-10-01', true from generate_series(1, 3) n;

-- guild join: capacity, idempotency, per-user limit --------------------------
select pg_temp.as_user('f0000000-0000-4000-8000-000000000001');
select is((app.api_join_guild('f9000000-0000-4000-8000-000000000001') ->> 'already_member')::boolean, false, 'join succeeds');
select is((app.api_join_guild('f9000000-0000-4000-8000-000000000001') ->> 'already_member')::boolean, true, 'second join is idempotent');
select pg_temp.as_user('f0000000-0000-4000-8000-000000000002');
select lives_ok($$select app.api_join_guild('f9000000-0000-4000-8000-000000000001')$$, 'second member fills the guild');
select pg_temp.as_user('f0000000-0000-4000-8000-000000000003');
select throws_ok($$select app.api_join_guild('f9000000-0000-4000-8000-000000000001')$$, 'CNM01', 'GUILD_FULL', 'full guild rejects joins');
reset role;
select is((select member_count from app.guilds where id = 'f9000000-0000-4000-8000-000000000001'), 2, 'member_count matches capacity');
update app.app_settings set value = '2' where key = 'guild.max_memberships_per_user';
select pg_temp.as_user('f0000000-0000-4000-8000-000000000001');
select lives_ok($$select app.api_join_guild('f9000000-0000-4000-8000-000000000002')$$, 'user can belong to multiple guilds');
select throws_ok($$select app.api_join_guild('f9000000-0000-4000-8000-000000000003')$$, 'CNM01', 'GUILD_MEMBERSHIP_LIMIT_REACHED', 'per-user limit enforced');
reset role;
update app.app_settings set value = '10' where key = 'guild.max_memberships_per_user';
select pg_temp.as_user('f0000000-0000-4000-8000-000000000001');
select throws_ok($$select app.api_join_guild('00000000-0000-4000-8000-000000000999')$$, 'CNM01', 'GUILD_NOT_FOUND', 'unknown guild');
select is(jsonb_array_length(app.api_my_memberships() -> 'items'), 2, 'membership list shows both guilds');

-- messages: idempotency, sequence, validation ---------------------------------
select is((app.api_send_message((select id from app.conversations where guild_id = 'f9000000-0000-4000-8000-000000000001'),
  'f1000000-0000-4000-8000-000000000001', 'text', 'hello', null) ->> 'replay')::boolean, false, 'message created');
select is((app.api_send_message((select id from app.conversations where guild_id = 'f9000000-0000-4000-8000-000000000001'),
  'f1000000-0000-4000-8000-000000000001', 'text', 'hello', null) ->> 'replay')::boolean, true, 'same client_message_id replays');
select throws_ok($$select app.api_send_message((select id from app.conversations where guild_id = 'f9000000-0000-4000-8000-000000000001'),
  'f1000000-0000-4000-8000-000000000001', 'text', 'different', null)$$, 'CNM01', 'CLIENT_MESSAGE_ID_CONFLICT', 'reused id with other content is rejected');
select lives_ok($$select app.api_send_message((select id from app.conversations where guild_id = 'f9000000-0000-4000-8000-000000000001'),
  'f1000000-0000-4000-8000-000000000002', 'text', 'second', null)$$, 'second message');
reset role;
select is((select array_agg(seq order by seq) from app.messages m join app.conversations c on c.id = m.conversation_id
           where c.guild_id = 'f9000000-0000-4000-8000-000000000001'), array[1::bigint, 2], 'gap-free per-conversation sequence');
select is((select count(*)::int from app.messages where client_message_id = 'f1000000-0000-4000-8000-000000000001'), 1, 'no duplicate rows');
select pg_temp.as_user('f0000000-0000-4000-8000-000000000001');
select throws_ok($$select app.api_send_message((select id from app.conversations where guild_id = 'f9000000-0000-4000-8000-000000000001'),
  gen_random_uuid(), 'text', repeat('あ', 1001), null)$$, 'CNM01', 'VALIDATION_ERROR', 'over-long text rejected');
select throws_ok($$select app.api_send_message((select id from app.conversations where guild_id = 'f9000000-0000-4000-8000-000000000001'),
  gen_random_uuid(), 'text', 'お前なんか死ね', null)$$, 'CNM01', 'MESSAGE_CONTENT_REJECTED', 'local content filter');
select throws_ok($$select app.api_send_message((select id from app.conversations where guild_id = 'f9000000-0000-4000-8000-000000000001'),
  gen_random_uuid(), 'image', null, gen_random_uuid())$$, 'CNM01', 'ATTACHMENT_NOT_FOUND', 'unknown attachment rejected');
select is((app.api_mark_read((select id from app.conversations where guild_id = 'f9000000-0000-4000-8000-000000000001'), 99) ->> 'last_read_seq')::int, 2,
  'read marker is clamped to latest_seq');
select is((app.api_mark_read((select id from app.conversations where guild_id = 'f9000000-0000-4000-8000-000000000001'), 1) ->> 'last_read_seq')::int, 2,
  'read marker never moves backwards');

-- unread and catch-up for user 2
select pg_temp.as_user('f0000000-0000-4000-8000-000000000002');
select is((app.api_get_conversation((select id from app.conversations where guild_id = 'f9000000-0000-4000-8000-000000000001')) ->> 'unread_count')::int, 2,
  'unread count for the other member');
select is(jsonb_array_length(app.api_list_messages((select id from app.conversations where guild_id = 'f9000000-0000-4000-8000-000000000001'), null, 1, 50) -> 'items'), 1,
  'after_seq catch-up returns only newer messages');

-- attachments
select throws_ok($$select app.api_create_upload_slot((select id from app.conversations where guild_id = 'f9000000-0000-4000-8000-000000000001'), 'application/pdf', 100)$$,
  'CNM01', 'ATTACHMENT_TYPE_NOT_ALLOWED', 'unsupported MIME rejected');
select throws_ok($$select app.api_create_upload_slot((select id from app.conversations where guild_id = 'f9000000-0000-4000-8000-000000000001'), 'image/png', 999999999)$$,
  'CNM01', 'ATTACHMENT_TOO_LARGE', 'oversized upload rejected');
select ok((app.api_create_upload_slot((select id from app.conversations where guild_id = 'f9000000-0000-4000-8000-000000000001'), 'image/png', 100) ->> 'object_path')
  ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.png$', 'server-chosen object path (no client path)');

-- reactions / EXP / level ---------------------------------------------------
select is((app.api_give_reaction('message', (select id from app.messages where client_message_id = 'f1000000-0000-4000-8000-000000000001')) ->> 'reaction_count')::int, 1,
  'グッと counted');
select throws_ok($$select app.api_give_reaction('message', (select id from app.messages where client_message_id = 'f1000000-0000-4000-8000-000000000001'))$$,
  'CNM01', 'ALREADY_REACTED', 'one グッと per user and target');
reset role;
select is((select total_exp from app.user_growth where user_id = 'f0000000-0000-4000-8000-000000000001'), 10, 'recipient received 10 EXP');
select is((select gut_points from app.user_growth where user_id = 'f0000000-0000-4000-8000-000000000001'), 1, 'recipient received 1 グッとポイント');
select is((select count(*)::int from app.exp_ledger where user_id = 'f0000000-0000-4000-8000-000000000001' and reason = 'reaction_received'), 1, 'ledger entry appended');
select throws_ok($$update app.exp_ledger set delta = 100$$, 'P0001', null, 'ledger is append-only');
select is((select count(*)::int from app.notifications where user_id = 'f0000000-0000-4000-8000-000000000001' and type = 'reaction_received'), 1, 'notification stored');
select pg_temp.as_user('f0000000-0000-4000-8000-000000000001');
select throws_ok($$select app.api_give_reaction('message', (select id from app.messages where client_message_id = 'f1000000-0000-4000-8000-000000000002'))$$,
  'CNM01', 'CANNOT_REACT_TO_SELF', 'self グッと rejected');
reset role;

-- level curve and evolution boundaries
select is(app.level_for_exp('level-v1', 279), 4, 'level-v1: 279 EXP → Lv4');
select is(app.level_for_exp('level-v1', 280), 5, 'level-v1: 280 EXP → Lv5');
select is(app.level_for_exp('level-v1', 10000000), 100, 'level capped at 100');
insert into app.user_avatars (user_id, character_code, attributes_version, visual_description) values ('f0000000-0000-4000-8000-000000000004', 'C-TESTEV01', 'v1', 'x');
select is((app.apply_exp('f0000000-0000-4000-8000-000000000004', 270, 0, 'operator_adjustment', 'test', gen_random_uuid()) ->> 'level')::int, 4, 'Lv4 at 270');
select is((select count(*)::int from app.ai_jobs where user_id = 'f0000000-0000-4000-8000-000000000004' and kind = 'evolution_image'), 0, 'no evolution before Lv5');
select is((app.apply_exp('f0000000-0000-4000-8000-000000000004', 10, 1, 'reaction_received', 'reaction', 'f2000000-0000-4000-8000-000000000001') ->> 'level')::int, 5, 'crossing to Lv5');
select is((select count(*)::int from app.ai_jobs where user_id = 'f0000000-0000-4000-8000-000000000004' and kind = 'evolution_image'), 1, 'one evolution job at Lv5');
select is((app.apply_exp('f0000000-0000-4000-8000-000000000004', 10, 1, 'reaction_received', 'reaction', 'f2000000-0000-4000-8000-000000000001') ->> 'applied')::boolean, false,
  'same EXP source applied once (idempotent)');
select is((app.apply_exp('f0000000-0000-4000-8000-000000000004', 5000, 0, 'operator_adjustment', 'test', gen_random_uuid()) ->> 'level')::int, 28, 'multi-boundary jump to Lv28 (5280 EXP)');
select is((select array_agg((payload ->> 'stage_level')::int || ':' || status order by created_at) from app.ai_jobs
           where user_id = 'f0000000-0000-4000-8000-000000000004' and kind = 'evolution_image'),
          array['5:superseded', '25:accepted'], 'only the final stage (Lv25) is generated; Lv5 job superseded');
select is((select count(*)::int from app.notifications where user_id = 'f0000000-0000-4000-8000-000000000004' and type = 'level_up'), 3, 'level_up notifications stored');

-- blocks and DMs ---------------------------------------------------------------
select pg_temp.as_user('f0000000-0000-4000-8000-000000000005');
select throws_ok($$select app.api_open_dm('f0000000-0000-4000-8000-000000000005')$$, 'CNM01', 'CANNOT_MESSAGE_SELF', 'cannot DM self');
select is((app.api_open_dm('f0000000-0000-4000-8000-000000000006') ->> 'created')::boolean, true, 'DM thread created');
select is((app.api_open_dm('f0000000-0000-4000-8000-000000000006') ->> 'created')::boolean, false, 'DM thread reused');
select is((app.api_block('f0000000-0000-4000-8000-000000000007') ->> 'created')::boolean, true, 'block created');
select is((app.api_block('f0000000-0000-4000-8000-000000000007') ->> 'created')::boolean, false, 'block idempotent');
select throws_ok($$select app.api_block('f0000000-0000-4000-8000-000000000005')$$, 'CNM01', 'CANNOT_BLOCK_SELF', 'cannot block self');
select throws_ok($$select app.api_open_dm('f0000000-0000-4000-8000-000000000007')$$, 'CNM01', 'BLOCKED', 'blocker cannot open a DM with blocked user');
select pg_temp.as_user('f0000000-0000-4000-8000-000000000007');
select throws_ok($$select app.api_open_dm('f0000000-0000-4000-8000-000000000005')$$, 'CNM01', 'BLOCKED', 'blocked user cannot open a DM with blocker');
select pg_temp.as_user('f0000000-0000-4000-8000-000000000006');
select lives_ok($$select app.api_send_message((select id from app.conversations where dm_user_low = 'f0000000-0000-4000-8000-000000000005'
  and dm_user_high = 'f0000000-0000-4000-8000-000000000006'), gen_random_uuid(), 'text', 'やあ', null)$$, 'DM message sent');
reset role;
select is((select count(*)::int from app.notifications where user_id = 'f0000000-0000-4000-8000-000000000005' and type = 'dm_received'), 1, 'DM notification stored');

-- consent and diagnosis --------------------------------------------------------
select pg_temp.as_user('f0000000-0000-4000-8000-000000000008');
select throws_ok($$select app.api_submit_diagnosis(gen_random_uuid(), 'qs-2026-10-v1', '2026-10-01', '[]')$$, 'CNM01', 'CONSENT_REQUIRED', 'diagnosis requires consent');
select throws_ok($$select app.api_record_consent('ai_data_transfer', '2020-01-01', true)$$, 'CNM01', 'CONSENT_VERSION_MISMATCH', 'old consent version rejected');
select lives_ok($$select app.api_record_consent('ai_data_transfer', '2026-10-01', true)$$, 'consent recorded');
select throws_ok($$select app.api_submit_diagnosis(gen_random_uuid(), 'qs-old', '2026-10-01', '[]')$$, 'CNM01', 'QUESTION_SET_OUTDATED', 'outdated question set rejected');
select throws_ok($$select app.api_submit_diagnosis(gen_random_uuid(), 'qs-2026-10-v1', '2026-10-01', '[]')$$, 'CNM01', 'VALIDATION_ERROR', 'missing required answers rejected');
select is((app.api_record_consent('ai_data_transfer', '2026-10-01', false) -> 'ai_data_transfer' ->> 'is_valid')::boolean, false, 'consent can be withdrawn');
reset role;

-- account deletion ---------------------------------------------------------------
select pg_temp.as_user('f0000000-0000-4000-8000-000000000003');
select is(app.api_request_account_deletion('test') ->> 'status', 'requested', 'deletion accepted');
select throws_ok('select app.api_me()', 'CNM01', 'ACCOUNT_DELETED', 'account unusable after deletion request');
select is(app.api_account_deletion_status() ->> 'status', 'requested', 'deletion status still readable');
reset role;
select is((app.svc_process_account_deletion('f0000000-0000-4000-8000-000000000003') ->> 'processed')::boolean, true, 'deletion processed');
select is((select status from app.profiles where id = 'f0000000-0000-4000-8000-000000000003'), 'deleted', 'profile marked deleted');

select * from finish();
rollback;
