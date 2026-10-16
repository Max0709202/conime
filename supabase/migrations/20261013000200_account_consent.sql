-- =============================================================================
-- 0200 アカウント・同意（データ01 / データ05）
--   profiles / consent_documents / user_consents / account_deletion_requests
-- =============================================================================

-- ---------------------------------------------------------------- profiles
create table public.profiles (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  display_name text check (display_name is null or char_length(display_name) between 1 and 30),
  role         text not null default 'user' check (role in ('user', 'admin')),
  status       text not null default 'active' check (status in ('active', 'withdrawn')),
  withdrawn_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check ((status = 'withdrawn') = (withdrawn_at is not null))
);
comment on table public.profiles is 'ユーザー。auth.users 作成時にトリガーで自動作成';

create trigger profiles_set_updated_at before update on public.profiles
  for each row execute function private.set_updated_at();

-- auth.users 作成時に profiles を自動作成（データ05）
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (user_id, display_name)
  values (
    new.id,
    nullif(left(btrim(coalesce(new.raw_user_meta_data ->> 'display_name', '')), 30), '')
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- ---------------------------------------------------------------- consent_documents
create table public.consent_documents (
  id                 uuid primary key default gen_random_uuid(),
  doc_type           text not null check (doc_type in ('terms', 'privacy', 'ai_transfer')),
  version            integer not null check (version >= 1),
  title              text not null,
  body               text not null,
  is_current         boolean not null default false,
  requires_reconsent boolean not null default false,
  published_at       timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  unique (doc_type, version)
);
comment on table public.consent_documents is '同意文書。文言変更時は新しい版を登録する';
-- 種類ごとに最新の有効版は1件
create unique index consent_documents_one_current on public.consent_documents (doc_type) where is_current;

-- ---------------------------------------------------------------- user_consents
create table public.user_consents (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (user_id) on delete cascade,
  document_id uuid not null references public.consent_documents (id),
  decision    text not null check (decision in ('granted', 'revoked')),
  decided_at  timestamptz not null default clock_timestamp(),
  app_version text check (app_version is null or char_length(app_version) <= 32)
);
comment on table public.user_consents is '同意履歴。追記のみ（更新・削除不可）';
create index user_consents_user_decided on public.user_consents (user_id, decided_at desc);
create index user_consents_document on public.user_consents (document_id);

create or replace function private.user_consents_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and private.purge_allowed() then
    return old;
  end if;
  raise exception 'user_consents is append-only' using errcode = '42501';
end;
$$;

create trigger user_consents_no_update before update on public.user_consents
  for each row execute function private.user_consents_append_only();
create trigger user_consents_no_delete before delete on public.user_consents
  for each row execute function private.user_consents_append_only();

-- ---------------------------------------------------------------- account_deletion_requests
create table public.account_deletion_requests (
  id           uuid primary key default gen_random_uuid(),
  -- 物理削除後も受付記録を残すため set null
  user_id      uuid references public.profiles (user_id) on delete set null,
  status       text not null default 'requested' check (status in ('requested', 'processing', 'completed')),
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  check ((status = 'completed') = (completed_at is not null))
);
comment on table public.account_deletion_requests is '退会受付（AC-3）。実処理は第2段階';
create index account_deletion_requests_user on public.account_deletion_requests (user_id);

-- ---------------------------------------------------------------- 列の説明（docs/database.md に反映）
comment on column public.profiles.user_id is 'ユーザーID（auth.users.id）';
comment on column public.profiles.display_name is '表示名（1〜30文字）';
comment on column public.profiles.role is 'user / admin（運営。判定は Auth の app_metadata.role）';
comment on column public.profiles.status is 'active / withdrawn（退会済み）';
comment on column public.profiles.withdrawn_at is '退会受付日時。30日後に物理削除（U-17）';
comment on column public.consent_documents.id is '同意文書ID';
comment on column public.consent_documents.doc_type is 'terms（利用規約）/ privacy（プライバシーポリシー）/ ai_transfer（外部 AI 送信・AC-2）';
comment on column public.consent_documents.version is '版（種類ごとに1から）';
comment on column public.consent_documents.title is '表題';
comment on column public.consent_documents.body is '本文（貴社支給・U-03 / U-21）';
comment on column public.consent_documents.is_current is '最新の有効版（種類ごとに1件）';
comment on column public.consent_documents.requires_reconsent is 'true の版では旧版への同意を無効とし再同意を求める';
comment on column public.consent_documents.published_at is '公開日時';
comment on column public.user_consents.id is '同意記録ID（diagnosis_submissions.ai_consent_id の参照先）';
comment on column public.user_consents.user_id is 'ユーザーID';
comment on column public.user_consents.document_id is '同意文書ID（記録時点の最新の有効版）';
comment on column public.user_consents.decision is 'granted（同意）/ revoked（撤回）';
comment on column public.user_consents.decided_at is '記録日時';
comment on column public.user_consents.app_version is 'アプリの版（証跡）';
comment on column public.account_deletion_requests.id is '退会受付ID';
comment on column public.account_deletion_requests.user_id is 'ユーザーID（物理削除後は null）';
comment on column public.account_deletion_requests.status is 'requested / processing / completed';
comment on column public.account_deletion_requests.requested_at is '受付日時';
comment on column public.account_deletion_requests.completed_at is '物理削除の完了日時';
