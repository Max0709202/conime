-- 同意管理（認証01・AC-2）：版管理・再同意・撤回・追記のみ
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(11);

insert into auth.users (id, email) values ('33333333-3333-4333-8333-333333333333', 'consent@conime.test');
-- 既存の ai_transfer の有効版を外し、テスト用の版を用意する
update public.consent_documents set is_current = false where doc_type = 'ai_transfer';
insert into public.consent_documents (id, doc_type, version, title, body, is_current, requires_reconsent) values
  ('bbbbbbbb-0000-4000-8000-000000000001', 'ai_transfer', 101, 'v101', 'v101', true, true);

create function pg_temp.consent(p_doc uuid, p_decision text) returns void language sql as $$
  insert into public.user_consents (user_id, document_id, decision) values ('33333333-3333-4333-8333-333333333333', p_doc, p_decision)
$$;
create function pg_temp.valid() returns boolean language sql as $$
  select private.valid_consent_id('33333333-3333-4333-8333-333333333333', 'ai_transfer') is not null
$$;
create function pg_temp.publish(p_id uuid, p_version int, p_reconsent boolean) returns void language sql as $$
  update public.consent_documents set is_current = false where doc_type = 'ai_transfer';
  insert into public.consent_documents (id, doc_type, version, title, body, is_current, requires_reconsent)
  values (p_id, 'ai_transfer', p_version, 'v', 'v', true, p_reconsent);
$$;

select ok(not pg_temp.valid(), '同意の記録がなければ同意なし');
select pg_temp.consent('bbbbbbbb-0000-4000-8000-000000000001', 'granted');
select ok(pg_temp.valid(), '最新の有効版に granted で同意あり');
select pg_temp.consent('bbbbbbbb-0000-4000-8000-000000000001', 'revoked');
select ok(not pg_temp.valid(), '撤回（revoked）後は同意なし');
select pg_temp.consent('bbbbbbbb-0000-4000-8000-000000000001', 'granted');
select ok(pg_temp.valid(), '再度 granted で同意あり');

select pg_temp.publish('bbbbbbbb-0000-4000-8000-000000000002', 102, false);
select ok(pg_temp.valid(), '再同意不要の版上げでは旧版への同意が有効なまま');

select pg_temp.publish('bbbbbbbb-0000-4000-8000-000000000003', 103, true);
select ok(not pg_temp.valid(), 'requires_reconsent = true の版上げで旧版への同意は無効');

set local role authenticated;
set local request.jwt.claims = '{"sub":"33333333-3333-4333-8333-333333333333","role":"authenticated"}';
select is(
  (select x ->> 'status' from jsonb_array_elements(private.consent_status()) x where x ->> 'doc_type' = 'ai_transfer'),
  'reconsent_required',
  'consent_status は reconsent_required を返す'
);
select throws_ok(
  $$insert into public.user_consents (user_id, document_id, decision) values ('33333333-3333-4333-8333-333333333333', 'bbbbbbbb-0000-4000-8000-000000000001', 'granted')$$,
  '42501', null, '旧版の文書には同意できない（RLS）'
);
select lives_ok(
  $$insert into public.user_consents (user_id, document_id, decision) values ('33333333-3333-4333-8333-333333333333', 'bbbbbbbb-0000-4000-8000-000000000003', 'granted')$$,
  '最新の有効版に同意できる'
);
reset role;
select ok(pg_temp.valid(), '最新版への再同意で同意あり');

select throws_ok(
  $$update public.user_consents set decision = 'revoked' where user_id = '33333333-3333-4333-8333-333333333333'$$,
  '42501', 'user_consents is append-only', '同意履歴は postgres でも更新できない（追記のみ）'
);

select * from finish();
rollback;
