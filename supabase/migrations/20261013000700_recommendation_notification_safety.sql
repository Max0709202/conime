-- =============================================================================
-- 0700 推薦・通知・安心安全・共通（データ04）
--   recommendations / notifications / reports / blocks / app_settings / idempotency_keys
-- =============================================================================

create table public.recommendations (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles (user_id) on delete cascade,
  kind          text not null check (kind in ('user', 'guild', 'work')),
  -- profiles / guilds / works への論理参照（kind で参照先が変わる）
  target_id     uuid not null,
  rank          smallint not null check (rank >= 1),
  score         numeric(5, 2) check (score between 0 and 100),
  matched_items jsonb not null default '[]'::jsonb check (jsonb_typeof(matched_items) = 'array'),
  reason        text,
  generated_at  timestamptz not null default now(),
  unique (user_id, kind, rank)
);
comment on table public.recommendations is '推薦結果。最新の計算結果のみ保持し、アプリは相性%と一致項目をそのまま表示（M-3）';

create table public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (user_id) on delete cascade,
  type       text not null check (type in ('goodto_received', 'level_up', 'guild_announcement', 'dm_received', 'system')),
  title      text not null,
  body       text,
  link       text,
  created_at timestamptz not null default now(),
  read_at    timestamptz
);
comment on table public.notifications is 'アプリ内通知。事象発生時に保存し read_at で既読（NT-1・U-15）';
create index notifications_user_created on public.notifications (user_id, created_at desc);
-- 未読通知の取得
create index notifications_user_unread on public.notifications (user_id) where read_at is null;

create table public.reports (
  id          uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles (user_id) on delete cascade,
  target_type text not null check (target_type in ('message', 'character_image', 'navigator_reply', 'user')),
  target_id   uuid not null,
  reason_code text not null check (reason_code in ('spam', 'harassment', 'inappropriate', 'impersonation', 'other')),
  detail      text check (detail is null or char_length(detail) <= 1000),
  status      text not null default 'open' check (status in ('open', 'reviewing', 'resolved', 'dismissed')),
  created_at  timestamptz not null default now()
);
comment on table public.reports is '通報（S-1）';
create index reports_reporter on public.reports (reporter_id);
create index reports_status_created on public.reports (status, created_at);

create table public.blocks (
  blocker_id uuid not null references public.profiles (user_id) on delete cascade,
  blocked_id uuid not null references public.profiles (user_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
comment on table public.blocks is 'ブロック。DM・推薦・メッセージ表示の除外判定に使用（RLS 関数 private.is_blocked）';
create index blocks_blocked on public.blocks (blocked_id);

create table public.app_settings (
  key         text primary key check (key ~ '^[a-z_]+(\.[a-z_*]+)+$'),
  value       jsonb not null,
  description text,
  updated_at  timestamptz not null default now()
);
comment on table public.app_settings is 'デプロイなしで変える調整値（定員・所属上限・履歴上限・配点 等）';

create trigger app_settings_set_updated_at before update on public.app_settings
  for each row execute function private.set_updated_at();

create table public.idempotency_keys (
  user_id      uuid not null references public.profiles (user_id) on delete cascade,
  key          text not null check (char_length(key) between 1 and 255),
  endpoint     text not null,
  request_hash text not null,
  status_code  smallint not null,
  response     jsonb not null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '24 hours',
  primary key (user_id, key)
);
comment on table public.idempotency_keys is '作成系 POST の応答を24時間保持し、再送時は同じ応答を返す（API01）';
create index idempotency_keys_expires on public.idempotency_keys (expires_at);

-- 調整値（仮値は U-xx の回答で変更する）
insert into public.app_settings (key, value, description) values
  ('diagnosis.poll_after_seconds',     '3',     '生成状態の取得間隔（秒）'),
  ('diagnosis.deprecated_grace_days',  '30',    '版上げ後に旧版の回答を受け付ける日数（U-22）'),
  ('generation.max_retries',           '3',     '生成ジョブの自動再試行の最大回数（初回を含まない）'),
  ('generation.timeout_seconds',       '180',   '生成の待機上限。超過で failed（U-08）'),
  ('character.name_max_length',        '20',    'キャラ名の最大文字数（U-07）'),
  ('guild.default_capacity',           '100',   'ギルド定員の既定値'),
  ('guild.max_memberships',            'null',  '1ユーザーの所属ギルド上限。null = 上限なし（U-16）'),
  ('history.guild_message_limit',      '1000',  'トークルームの履歴保存上限（件・U-12）'),
  ('history.dm_message_limit',         '1000',  'DM の履歴保存上限（件・U-12）'),
  ('history.navigator_message_limit',  '200',   'ナビゲーター履歴の保存上限（件・U-12・U-18）'),
  ('navigator.daily_limit',            '30',    'ナビゲーターの1人1日の利用上限（U-18）'),
  ('recommendation.max_items',         '3',     '推薦の件数（種類ごと・U-09）'),
  ('matching.weights',                 '{"works": 40, "characters": 20, "enjoyment": 15, "genre_world": 15, "visual": 10}', 'ユーザー推薦（案A）の配点（U-09）'),
  ('growth.max_level',                 '100',   'レベル上限（L-2）'),
  ('growth.goodto_exp',                '10',    'グッと1回で受け取る EXP（仮・U-10）'),
  ('growth.goodto_points',             '1',     'グッと1回で受け取るポイント（仮・U-10）'),
  ('idempotency.ttl_hours',            '24',    '冪等キーの保持時間'),
  ('withdrawal.purge_after_days',      '30',    '退会後に個人データを物理削除するまでの日数（U-17）');

-- ---------------------------------------------------------------- 列の説明（docs/database.md に反映）
comment on column public.recommendations.kind is 'user / guild / work';
comment on column public.recommendations.target_id is '推薦対象（profiles / guilds / works への論理参照）';
comment on column public.recommendations.rank is '順位';
comment on column public.recommendations.score is '相性%（0〜100）';
comment on column public.recommendations.matched_items is '一致した項目（アプリはそのまま表示）';
comment on column public.recommendations.reason is '推薦理由（AI）';
comment on column public.recommendations.generated_at is '計算日時';
comment on column public.notifications.type is 'goodto_received / level_up / guild_announcement / dm_received / system（U-15）';
comment on column public.notifications.title is '表題';
comment on column public.notifications.body is '本文';
comment on column public.notifications.link is 'アプリ内の遷移先';
comment on column public.notifications.read_at is '閲覧日時（null = 未読）';
comment on column public.reports.reporter_id is '通報者';
comment on column public.reports.target_type is 'message / character_image / navigator_reply / user';
comment on column public.reports.target_id is '通報対象ID（論理参照）';
comment on column public.reports.reason_code is 'spam / harassment / inappropriate / impersonation / other';
comment on column public.reports.detail is '詳細（1000文字以内）';
comment on column public.reports.status is 'open / reviewing / resolved / dismissed';
comment on column public.blocks.blocker_id is 'ブロックしたユーザー';
comment on column public.blocks.blocked_id is 'ブロックされたユーザー';
comment on column public.app_settings.key is '設定キー（例：guild.default_capacity）';
comment on column public.app_settings.value is '設定値（jsonb）';
comment on column public.app_settings.description is '説明';
comment on column public.idempotency_keys.user_id is 'ユーザーID';
comment on column public.idempotency_keys.key is 'Idempotency-Key（UUID）';
comment on column public.idempotency_keys.endpoint is '対象の操作（例：POST /diagnoses）';
comment on column public.idempotency_keys.request_hash is '要求内容の SHA-256（同じキーで内容が異なれば 422）';
comment on column public.idempotency_keys.status_code is '保存した応答の HTTP ステータス';
comment on column public.idempotency_keys.response is '保存した応答本文';
comment on column public.idempotency_keys.expires_at is '有効期限（24時間）';
