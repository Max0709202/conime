-- =============================================================================
-- 0100 基盤：スキーマ・拡張・共通関数
-- 設計書 データ06：アプリ用は public（全テーブル RLS 有効）、内部関数は private
-- =============================================================================

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- 内部関数用スキーマ。PostgREST には公開しない（config.toml の api.schemas に含めない）
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to anon, authenticated, service_role;

-- 新規テーブルへの既定権限を外し、テーブルごとに必要な権限だけを付与する（認証03）
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated, public;
alter default privileges in schema private revoke all on functions from public;

-- updated_at の自動更新（データ06：created_at・updated_at はトリガー更新）
create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- 物理削除の許可フラグ。追記のみのテーブル（user_consents 等）は、
-- 退会者データの物理削除ジョブ（private.purge_withdrawn_users）だけが削除できる
create or replace function private.purge_allowed()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(current_setting('conime.purge', true), '') = 'on'
$$;
