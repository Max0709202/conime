-- =============================================================================
-- 0400 マスタ（データ02 / データ05）
--   works / anime_characters / tags / work_tags
-- 貴社支給の作品リスト（A-06 / U-05）を取り込む。照合ロジックは第2段階（P2-2）
-- =============================================================================

create table public.works (
  id         uuid primary key default gen_random_uuid(),
  title      text not null,
  title_kana text,
  aliases    text[] not null default '{}',
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.works is '作品リスト。Q1・Q3・Q12 の照合先';
create index works_title_trgm on public.works using gin (title extensions.gin_trgm_ops);

create trigger works_set_updated_at before update on public.works
  for each row execute function private.set_updated_at();

create table public.anime_characters (
  id         uuid primary key default gen_random_uuid(),
  work_id    uuid not null references public.works (id) on delete cascade,
  name       text not null,
  aliases    text[] not null default '{}',
  created_at timestamptz not null default now()
);
comment on table public.anime_characters is '作品キャラ';
create index anime_characters_work on public.anime_characters (work_id);
create index anime_characters_name_trgm on public.anime_characters using gin (name extensions.gin_trgm_ops);

create table public.tags (
  id       uuid primary key default gen_random_uuid(),
  tag_type text not null check (tag_type in ('genre', 'world', 'pace', 'enjoyment', 'action_mood', 'role_mood', 'development')),
  code     text not null,
  label    text not null,
  unique (tag_type, code)
);
comment on table public.tags is 'タグ（ジャンル・世界観・テンポ・楽しみ方 等）';

create table public.work_tags (
  work_id uuid not null references public.works (id) on delete cascade,
  tag_id  uuid not null references public.tags (id) on delete cascade,
  primary key (work_id, tag_id)
);
comment on table public.work_tags is '作品タグ';
create index work_tags_tag on public.work_tags (tag_id);

-- ---------------------------------------------------------------- 列の説明（docs/database.md に反映）
comment on column public.works.title is '作品名';
comment on column public.works.title_kana is '読み';
comment on column public.works.aliases is '別名';
comment on column public.works.is_active is '照合・推薦の対象か';
comment on column public.anime_characters.work_id is '作品ID';
comment on column public.anime_characters.name is 'キャラ名';
comment on column public.anime_characters.aliases is '別名';
comment on column public.tags.tag_type is 'genre / world / pace / enjoyment / action_mood / role_mood / development';
comment on column public.tags.code is 'タグコード';
comment on column public.tags.label is '表示名';
