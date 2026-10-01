-- Guilds, conversations, messages, attachments, reactions, EXP, notifications,
-- navigator, blocks, reports and moderation.

-- ---------------------------------------------------------------------------
-- Guilds (operator-published; creation workflow is out of scope)
-- ---------------------------------------------------------------------------
create table app.guilds (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null check (length(name) between 1 and 60),
  description text not null default '',
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  capacity integer check (capacity is null or capacity > 0), -- null = app setting guild.default_capacity
  member_count integer not null default 0 check (member_count >= 0),
  leader_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index guilds_published_idx on app.guilds (created_at desc) where status = 'published';
create index guilds_name_trgm_idx on app.guilds using gin (lower(name) extensions.gin_trgm_ops);
create trigger guilds_touch before update on app.guilds
  for each row execute function app.touch_updated_at();

create table app.guild_tags (
  guild_id uuid not null references app.guilds (id) on delete cascade,
  tag_id uuid not null references app.tags (id) on delete cascade,
  primary key (guild_id, tag_id)
);
create index guild_tags_tag_idx on app.guild_tags (tag_id);

-- Operator-defined matching parameters in the same key space as profile_features.
create table app.guild_match_traits (
  guild_id uuid not null references app.guilds (id) on delete cascade,
  question_code text not null,
  match_key text not null,
  label text not null,
  primary key (guild_id, question_code, match_key)
);
create index guild_match_traits_key_idx on app.guild_match_traits (question_code, match_key);

create table app.guild_announcements (
  id uuid primary key default gen_random_uuid(),
  guild_id uuid not null references app.guilds (id) on delete cascade,
  title text not null,
  body text not null,
  published_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index guild_announcements_guild_idx on app.guild_announcements (guild_id, published_at desc);

create table app.guild_members (
  guild_id uuid not null references app.guilds (id) on delete cascade,
  user_id uuid not null references app.profiles (id) on delete cascade,
  role text not null default 'member' check (role in ('leader', 'officer', 'member')),
  joined_at timestamptz not null default now(),
  primary key (guild_id, user_id)
);
create index guild_members_user_idx on app.guild_members (user_id);

-- ---------------------------------------------------------------------------
-- Conversations: one per guild (talk room) or one per user pair (DM)
-- ---------------------------------------------------------------------------
create table app.conversations (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('guild', 'dm')),
  guild_id uuid unique references app.guilds (id) on delete cascade,
  dm_user_low uuid references app.profiles (id),
  dm_user_high uuid references app.profiles (id),
  last_seq bigint not null default 0,
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  check (
    (kind = 'guild' and guild_id is not null and dm_user_low is null and dm_user_high is null)
    or (kind = 'dm' and guild_id is null and dm_user_low is not null and dm_user_high is not null
        and dm_user_low < dm_user_high)
  ),
  unique (dm_user_low, dm_user_high)
);

create table app.conversation_members (
  conversation_id uuid not null references app.conversations (id) on delete cascade,
  user_id uuid not null references app.profiles (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);
create index conversation_members_user_idx on app.conversation_members (user_id);

create table app.message_attachments (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references app.conversations (id) on delete cascade,
  uploader_id uuid not null references app.profiles (id) on delete cascade,
  bucket text not null,
  object_path text not null unique,
  declared_mime text not null,
  declared_size bigint not null check (declared_size > 0),
  verified_mime text,
  verified_size bigint,
  status text not null default 'pending' check (status in ('pending', 'ready', 'attached', 'deleted')),
  legal_hold boolean not null default false,
  created_at timestamptz not null default now(),
  verified_at timestamptz,
  deleted_at timestamptz
);
create index message_attachments_cleanup_idx on app.message_attachments (created_at) where status in ('pending', 'ready');

create table app.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references app.conversations (id) on delete cascade,
  seq bigint not null,
  sender_id uuid references app.profiles (id) on delete set null,
  client_message_id uuid,
  kind text not null check (kind in ('text', 'image', 'system')),
  body text check (body is null or length(body) <= 4000),
  attachment_id uuid unique references app.message_attachments (id),
  content_sha256 text,
  reaction_count integer not null default 0 check (reaction_count >= 0),
  legal_hold boolean not null default false,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_reason text,
  unique (conversation_id, seq),
  unique (sender_id, client_message_id),
  check (kind <> 'image' or attachment_id is not null or deleted_at is not null)
);
create index messages_conversation_seq_idx on app.messages (conversation_id, seq desc);
create index messages_sender_idx on app.messages (sender_id);

create table app.conversation_reads (
  conversation_id uuid not null references app.conversations (id) on delete cascade,
  user_id uuid not null references app.profiles (id) on delete cascade,
  last_read_seq bigint not null default 0 check (last_read_seq >= 0),
  updated_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

-- ---------------------------------------------------------------------------
-- グッと reactions and the immutable EXP ledger
-- ---------------------------------------------------------------------------
create table app.reactions (
  id uuid primary key default gen_random_uuid(),
  giver_id uuid not null references app.profiles (id) on delete cascade,
  target_type text not null check (target_type in ('message')),
  target_id uuid not null,
  recipient_id uuid not null references app.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (giver_id, target_type, target_id),
  check (giver_id <> recipient_id)
);
create index reactions_recipient_idx on app.reactions (recipient_id, created_at desc);
create index reactions_target_idx on app.reactions (target_type, target_id);

create table app.exp_ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references app.profiles (id) on delete cascade,
  delta integer not null,
  gut_points_delta integer not null default 0,
  reason text not null check (reason in ('reaction_received', 'operator_adjustment')),
  source_type text not null,
  source_id uuid not null,
  rule_version text not null,
  total_exp_after integer not null,
  created_at timestamptz not null default now(),
  unique (user_id, reason, source_type, source_id)
);
create index exp_ledger_user_idx on app.exp_ledger (user_id, id);
create trigger exp_ledger_append_only before update or delete on app.exp_ledger
  for each row execute function app.reject_mutation();

-- ---------------------------------------------------------------------------
-- Notifications (stored when the event happens; read state separate)
-- ---------------------------------------------------------------------------
create table app.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app.profiles (id) on delete cascade,
  type text not null,
  actor_id uuid references app.profiles (id) on delete set null,
  data jsonb not null default '{}'::jsonb,
  dedupe_key text,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  unique (user_id, dedupe_key)
);
create index notifications_user_idx on app.notifications (user_id, created_at desc, id desc);
create index notifications_unread_idx on app.notifications (user_id) where read_at is null;

-- ---------------------------------------------------------------------------
-- AI navigator history
-- ---------------------------------------------------------------------------
create table app.navigator_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app.profiles (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  body text not null,
  suggestions jsonb not null default '[]'::jsonb,
  is_fallback boolean not null default false,
  client_message_id uuid,
  reply_to uuid references app.navigator_messages (id) on delete cascade,
  ai_run_id uuid references app.ai_runs (id) on delete set null,
  moderation jsonb,
  legal_hold boolean not null default false,
  created_at timestamptz not null default now(),
  unique (user_id, client_message_id),
  unique (reply_to)
);
create index navigator_messages_user_idx on app.navigator_messages (user_id, created_at desc, id desc);

-- ---------------------------------------------------------------------------
-- Blocks, reports, moderation
-- ---------------------------------------------------------------------------
create table app.blocks (
  blocker_id uuid not null references app.profiles (id) on delete cascade,
  blocked_id uuid not null references app.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index blocks_blocked_idx on app.blocks (blocked_id);

create or replace function app.is_blocked_between(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from app.blocks
    where (blocker_id = a and blocked_id = b) or (blocker_id = b and blocked_id = a)
  )
$$;

create table app.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid references app.profiles (id) on delete set null,
  target_type text not null check (target_type in ('message', 'attachment', 'navigator_message', 'avatar_image', 'user')),
  target_id uuid not null,
  target_user_id uuid,
  reason_code text not null,
  comment text check (comment is null or length(comment) <= 1000),
  status text not null default 'received' check (status in ('received', 'reviewing', 'resolved', 'dismissed')),
  snapshot jsonb not null,
  snapshot_sha256 text not null,
  resolution_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (reporter_id, target_type, target_id)
);
create index reports_status_idx on app.reports (status, created_at);
create index reports_target_idx on app.reports (target_type, target_id);
create trigger reports_touch before update on app.reports
  for each row execute function app.touch_updated_at();

create table app.moderation_events (
  id uuid primary key default gen_random_uuid(),
  target_type text not null,
  target_id uuid,
  source text not null check (source in ('local_filter', 'provider', 'operator', 'report')),
  provider text,
  model text,
  flagged boolean not null,
  categories jsonb not null default '{}'::jsonb,
  action text not null check (action in ('none', 'rejected', 'hidden', 'deleted', 'held', 'released', 'resolved', 'dismissed')),
  actor_id uuid,
  report_id uuid references app.reports (id) on delete set null,
  created_at timestamptz not null default now()
);
create index moderation_events_target_idx on app.moderation_events (target_type, target_id);
