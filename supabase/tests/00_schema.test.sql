-- スキーマ：33テーブル・全テーブル RLS 有効（RLS 無効のテーブルがあれば CI を失敗させる：引継01）
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(8);

select is(
  (select count(*)::int from pg_tables where schemaname = 'public'),
  33,
  'public スキーマのテーブルは33件（データ05）'
);

select is(
  (select coalesce(array_agg(tablename::text order by tablename), '{}') from pg_tables where schemaname = 'public' and not rowsecurity),
  '{}'::text[],
  '全テーブルで RLS が有効'
);

select tables_are('public', array[
  'profiles', 'consent_documents', 'user_consents', 'account_deletion_requests',
  'question_sets', 'questions', 'question_options', 'diagnosis_submissions', 'diagnosis_answers', 'answer_entities',
  'works', 'anime_characters', 'tags', 'work_tags',
  'ai_profiles', 'characters', 'generation_jobs', 'exp_events', 'level_thresholds', 'goodtos',
  'guilds', 'guild_tags', 'guild_members', 'guild_announcements', 'conversations', 'conversation_members', 'messages',
  'recommendations', 'notifications', 'reports', 'blocks', 'app_settings', 'idempotency_keys'
], 'テーブル一覧が設計書 データ05 と一致');

select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and has_table_privilege('anon', c.oid, 'INSERT')),
  0,
  'anon はどのテーブルにも INSERT できない'
);

select is(
  (select count(*)::int from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')),
  0,
  'public スキーマに関数を置かない（拡張機能の関数を除く。書き込み関数は PostgREST に公開しない private スキーマ）'
);

select ok(not has_schema_privilege('anon', 'private', 'create'), 'anon は private スキーマにオブジェクトを作れない');

select is(
  (select count(*)::int from public.level_thresholds),
  100,
  'level_thresholds は Lv.1〜100'
);

select is(
  (select count(*)::int from public.level_thresholds where is_evolution),
  20,
  '進化レベルは5の倍数（20段階）'
);

select * from finish();
rollback;
