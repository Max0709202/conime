-- =============================================================================
-- 0500 キャラクター・生成・成長（データ02 / データ08）
--   ai_profiles / characters / generation_jobs / exp_events / level_thresholds / goodtos
-- =============================================================================

-- ---------------------------------------------------------------- ai_profiles
create table public.ai_profiles (
  user_id       uuid primary key references public.profiles (user_id) on delete cascade,
  submission_id uuid not null references public.diagnosis_submissions (id) on delete cascade,
  personality   text,
  strengths     text[] not null default '{}',
  weaknesses    text[] not null default '{}',
  profile_items jsonb not null default '[]'::jsonb check (jsonb_typeof(profile_items) = 'array'),
  ai_comments   jsonb not null default '[]'::jsonb check (jsonb_typeof(ai_comments) = 'array'),
  generated_at  timestamptz not null default now()
);
comment on table public.ai_profiles is '生成プロフィール（仕様書 概要7「プロフィール反映」の保存先）';
create index ai_profiles_submission on public.ai_profiles (submission_id);

-- ---------------------------------------------------------------- characters
-- 画面表示用キャラID：C- ＋ 英数字8文字（紛らわしい 0 / O / 1 / I を除く32種）。U-07
create or replace function private.generate_public_code()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  alphabet constant text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  bytes bytea := extensions.gen_random_bytes(8);
  result text := 'C-';
begin
  for i in 0..7 loop
    result := result || substr(alphabet, (get_byte(bytes, i) % 32) + 1, 1);
  end loop;
  return result;
end;
$$;

create table public.characters (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null unique references public.profiles (user_id) on delete cascade,
  public_code   text not null unique default private.generate_public_code()
                check (public_code ~ '^C-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$'),
  name          text check (name is null or char_length(name) between 1 and 20),
  species       text,
  class         text,
  attribute     text,
  rarity        text,
  status_items  jsonb not null default '{}'::jsonb check (jsonb_typeof(status_items) = 'object'),
  title         text,
  level         smallint not null default 1 check (level between 1 and 100),
  exp_total     integer not null default 0 check (exp_total >= 0),
  goodto_points integer not null default 0 check (goodto_points >= 0),
  image_path    text,
  image_status  text not null default 'none' check (image_status in ('none', 'generating', 'ready', 'failed')),
  image_stage   smallint not null default 0 check (image_stage >= 0 and image_stage % 5 = 0),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
comment on table public.characters is 'マイキャラ。1ユーザー1体。アプリから更新できるのは name のみ（Q-4・L-1・L-5）';
comment on column public.characters.image_stage is '現在画像の進化段階（0 = 初期、5 = Lv.5 …）。進化履歴は保持しない（L-3）';

create trigger characters_set_updated_at before update on public.characters
  for each row execute function private.set_updated_at();

-- キャラIDと所有者は変更不可（Q-4）
create or replace function private.characters_immutable_columns()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.public_code is distinct from old.public_code or new.user_id is distinct from old.user_id then
    raise exception 'characters.public_code and user_id are immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger characters_immutable before update on public.characters
  for each row execute function private.characters_immutable_columns();

-- ---------------------------------------------------------------- generation_jobs
create table public.generation_jobs (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (user_id) on delete cascade,
  job_type   text not null check (job_type in ('diagnosis', 'character_image', 'evolution_image', 'recommendation')),
  status     text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed')),
  -- 重複生成の防止（設計04）。例：diagnosis:{submission_id}:0
  dedupe_key text not null unique,
  attempts   smallint not null default 0 check (attempts >= 0),
  payload    jsonb not null default '{}'::jsonb,
  result     jsonb,
  error_code text,
  run_after  timestamptz not null default now(),
  started_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.generation_jobs is '生成ジョブ。失敗時は最大3回自動再試行（app_settings generation.max_retries）し、以降は手動再試行';
create index generation_jobs_status_run_after on public.generation_jobs (status, run_after);
create index generation_jobs_user on public.generation_jobs (user_id);

create trigger generation_jobs_set_updated_at before update on public.generation_jobs
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------- level_thresholds
create table public.level_thresholds (
  level              smallint primary key check (level between 1 and 100),
  required_exp_total integer not null check (required_exp_total >= 0),
  is_evolution       boolean not null,
  check (is_evolution = (level % 5 = 0))
);
comment on table public.level_thresholds is '各レベルに必要な累計 EXP（仮値・U-10）。is_evolution = 5の倍数（L-3）';

-- 仮値：Lv.n に必要な累計 EXP = 25 × (n-1) × n。第2段階で U-10 の回答に合わせて差し替える
insert into public.level_thresholds (level, required_exp_total, is_evolution)
select n, 25 * (n - 1) * n, n % 5 = 0
from generate_series(1, 100) as n;

-- ---------------------------------------------------------------- exp_events
create table public.exp_events (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles (user_id) on delete cascade,
  source_type  text not null check (source_type in ('goodto_received', 'goodto_given', 'admin_adjust')),
  -- goodtos 等への論理参照
  source_id    uuid,
  exp_delta    integer not null default 0,
  points_delta integer not null default 0,
  level_after  smallint not null check (level_after between 1 and 100),
  created_at   timestamptz not null default now()
);
comment on table public.exp_events is '成長台帳。characters.exp_total / goodto_points / level の根拠と再計算用（第2段階 P2-6）';
create index exp_events_user_created on public.exp_events (user_id, created_at desc);
create unique index exp_events_source_once on public.exp_events (user_id, source_type, source_id) where source_id is not null;

-- ---------------------------------------------------------------- goodtos
create table public.goodtos (
  id          uuid primary key default gen_random_uuid(),
  giver_id    uuid not null references public.profiles (user_id) on delete cascade,
  receiver_id uuid not null references public.profiles (user_id) on delete cascade,
  target_type text not null check (target_type in ('message')),
  -- messages 等への論理参照（target_type で参照先が変わる）
  target_id   uuid not null,
  points      integer not null default 1 check (points > 0),
  created_at  timestamptz not null default now(),
  -- グッとは同一ユーザー・同一対象に1回（C-3・L-1）
  unique (giver_id, target_type, target_id),
  check (giver_id <> receiver_id)
);
comment on table public.goodtos is 'グッと。対象アクションは target_type の追加で拡張（U-10）';
create index goodtos_receiver_created on public.goodtos (receiver_id, created_at desc);
create index goodtos_target on public.goodtos (target_type, target_id);

-- ---------------------------------------------------------------- 列の説明（docs/database.md に反映）
comment on column public.ai_profiles.user_id is 'ユーザーID';
comment on column public.ai_profiles.submission_id is '生成元の診断送信';
comment on column public.ai_profiles.personality is '性格';
comment on column public.ai_profiles.strengths is '得意';
comment on column public.ai_profiles.weaknesses is '苦手';
comment on column public.ai_profiles.profile_items is 'プロフィール項目 [{key,label,values}]';
comment on column public.ai_profiles.ai_comments is 'AI コメント';
comment on column public.ai_profiles.generated_at is '生成日時';
comment on column public.characters.id is '内部ID';
comment on column public.characters.user_id is 'ユーザーID（1ユーザー1体）';
comment on column public.characters.public_code is '画面表示用キャラID（C- ＋ 英数字8文字・変更不可・U-07）';
comment on column public.characters.name is 'ユーザーが命名・変更（初回は NULL・1〜20文字）';
comment on column public.characters.species is '種族（Q-3）';
comment on column public.characters.class is 'クラス';
comment on column public.characters.attribute is '属性';
comment on column public.characters.rarity is 'レア度';
comment on column public.characters.status_items is '性格・得意・苦手・スキル・ステータス等（項目は増減する）';
comment on column public.characters.title is '称号（Q-7）';
comment on column public.characters.level is 'レベル 1〜100。アプリから更新不可';
comment on column public.characters.exp_total is '累計 EXP。アプリから更新不可';
comment on column public.characters.goodto_points is 'グッとポイント。アプリから更新不可';
comment on column public.characters.image_path is '現在画像の Storage パス（character-images バケット）';
comment on column public.characters.image_status is 'none / generating / ready / failed（設計04）';
comment on column public.generation_jobs.job_type is 'diagnosis / character_image / evolution_image / recommendation';
comment on column public.generation_jobs.status is 'queued / running / succeeded / failed';
comment on column public.generation_jobs.dedupe_key is '重複生成の防止キー（UNIQUE）';
comment on column public.generation_jobs.attempts is '試行回数';
comment on column public.generation_jobs.payload is '入力（submission_id 等）';
comment on column public.generation_jobs.result is '生成結果';
comment on column public.generation_jobs.error_code is '失敗理由';
comment on column public.generation_jobs.run_after is '実行可能になる日時（再試行の待機）';
comment on column public.generation_jobs.started_at is '最後に実行を開始した日時';
comment on column public.exp_events.source_type is 'goodto_received / goodto_given / admin_adjust';
comment on column public.exp_events.source_id is '発生元（goodtos 等への論理参照）';
comment on column public.exp_events.exp_delta is 'EXP の増減';
comment on column public.exp_events.points_delta is 'グッとポイントの増減';
comment on column public.exp_events.level_after is '反映後のレベル';
comment on column public.level_thresholds.level is 'レベル（1〜100）';
comment on column public.level_thresholds.required_exp_total is '到達に必要な累計 EXP';
comment on column public.level_thresholds.is_evolution is '画像を更新するレベル（5の倍数）';
comment on column public.goodtos.giver_id is '贈り主';
comment on column public.goodtos.receiver_id is '受取人（対象の発言者）';
comment on column public.goodtos.target_type is '対象の種類（message。拡張可能）';
comment on column public.goodtos.target_id is '対象ID（論理参照）';
comment on column public.goodtos.points is '付与ポイント';
