-- =============================================================================
-- 0600 ギルド・メッセージ（データ03）
--   guilds / guild_tags / guild_members / guild_announcements /
--   conversations / conversation_members / messages
-- トークルーム・DM・ナビゲーター履歴は conversations の kind 違いとして同じ messages に保存する
-- =============================================================================

-- ---------------------------------------------------------------- guilds
create table public.guilds (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (char_length(name) between 1 and 50),
  description  text check (description is null or char_length(description) <= 1000),
  capacity     integer not null default 100 check (capacity > 0),
  member_count integer not null default 0 check (member_count >= 0),
  status       text not null default 'published' check (status in ('published', 'hidden')),
  leader_info  text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (member_count <= capacity)
);
comment on table public.guilds is 'ギルド。運営のみ作成（GE-1 は対象外）。定員の既定値は app_settings guild.default_capacity';
-- ギルド名の部分一致検索（G-2）
create index guilds_name_trgm on public.guilds using gin (name extensions.gin_trgm_ops);

create trigger guilds_set_updated_at before update on public.guilds
  for each row execute function private.set_updated_at();

create table public.guild_tags (
  guild_id uuid not null references public.guilds (id) on delete cascade,
  tag_id   uuid not null references public.tags (id) on delete cascade,
  primary key (guild_id, tag_id)
);
create index guild_tags_tag on public.guild_tags (tag_id);

create table public.guild_members (
  guild_id  uuid not null references public.guilds (id) on delete cascade,
  user_id   uuid not null references public.profiles (user_id) on delete cascade,
  -- 発言者情報（C-2）に表示。種類は U-16
  role      text not null default 'member' check (role in ('member', 'leader', 'staff')),
  joined_at timestamptz not null default now(),
  primary key (guild_id, user_id)
);
comment on table public.guild_members is 'ギルド所属。参加は参加関数内で行ロックし定員・所属上限を守る（第2段階 P2-4）';
create index guild_members_user on public.guild_members (user_id);

create table public.guild_announcements (
  id           uuid primary key default gen_random_uuid(),
  guild_id     uuid not null references public.guilds (id) on delete cascade,
  title        text not null,
  body         text not null,
  published_at timestamptz not null default now(),
  created_at   timestamptz not null default now()
);
create index guild_announcements_guild_published on public.guild_announcements (guild_id, published_at desc);

-- ---------------------------------------------------------------- conversations
create table public.conversations (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null check (kind in ('guild', 'dm', 'navigator')),
  guild_id   uuid unique references public.guilds (id) on delete cascade,
  -- DM の2者を表すキー（小さい user_id:大きい user_id）
  dm_key     text unique,
  owner_id   uuid references public.profiles (user_id) on delete cascade,
  created_at timestamptz not null default now(),
  check (
    (kind = 'guild' and guild_id is not null and dm_key is null and owner_id is null) or
    (kind = 'dm' and dm_key is not null and guild_id is null and owner_id is null) or
    (kind = 'navigator' and owner_id is not null and guild_id is null and dm_key is null)
  )
);
comment on table public.conversations is '会話。kind = guild（トークルーム）/ dm / navigator';
create unique index conversations_one_navigator on public.conversations (owner_id) where kind = 'navigator';

create table public.conversation_members (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id         uuid not null references public.profiles (user_id) on delete cascade,
  last_read_at    timestamptz,
  joined_at       timestamptz not null default now(),
  primary key (conversation_id, user_id)
);
create index conversation_members_user on public.conversation_members (user_id);

create table public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_type     text not null check (sender_type in ('user', 'navigator', 'system')),
  -- 退会者の過去の発言は「退会したユーザー」として残すため set null（U-17）
  sender_id       uuid references public.profiles (user_id) on delete set null,
  body            text check (body is null or char_length(body) <= 2000),
  image_path      text,
  created_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  check (sender_type = 'user' or sender_id is null),
  check (body is not null or image_path is not null)
);
comment on table public.messages is 'メッセージ。論理削除は deleted_at。履歴上限は app_settings history.*_limit（U-12）';
-- 履歴の新しい順取得（C-1・C-5）
create index messages_conversation_created on public.messages (conversation_id, created_at desc);
create index messages_sender on public.messages (sender_id);

-- ---------------------------------------------------------------- 列の説明（docs/database.md に反映）
comment on table public.guild_tags is 'ギルドタグ';
comment on table public.guild_announcements is 'ギルドのお知らせ（G-4）';
comment on table public.conversation_members is '会話の参加者';
comment on column public.guilds.name is 'ギルド名（部分一致検索の対象）';
comment on column public.guilds.description is '説明';
comment on column public.guilds.capacity is '定員（既定100）';
comment on column public.guilds.member_count is '所属人数';
comment on column public.guilds.status is 'published / hidden';
comment on column public.guilds.leader_info is 'リーダー情報（表示用）';
comment on column public.guild_members.role is 'member / leader / staff（発言者情報・C-2）';
comment on column public.guild_members.joined_at is '参加日時';
comment on column public.guild_announcements.title is '表題';
comment on column public.guild_announcements.body is '本文';
comment on column public.guild_announcements.published_at is '公開日時';
comment on column public.conversations.kind is 'guild / dm / navigator';
comment on column public.conversations.guild_id is 'トークルームのギルド（kind = guild）';
comment on column public.conversations.dm_key is 'DM の2者のキー（kind = dm）';
comment on column public.conversations.owner_id is 'ナビゲーター履歴の所有者（kind = navigator）';
comment on column public.conversation_members.last_read_at is '最後に既読にした日時（未読判定）';
comment on column public.conversation_members.joined_at is '参加日時';
comment on column public.messages.sender_type is 'user / navigator / system';
comment on column public.messages.sender_id is '発言者（退会後は null＝「退会したユーザー」）';
comment on column public.messages.body is '本文（2000文字以内）';
comment on column public.messages.image_path is '画像の Storage パス（message-images バケット）';
comment on column public.messages.deleted_at is '論理削除日時';
