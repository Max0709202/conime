-- Question master, diagnosis answers, anime master, normalized features,
-- characters, AI jobs/runs, prompts, rules and growth state.

-- ---------------------------------------------------------------------------
-- Versioned question master (Q-1, Q-6, 概要6)
-- ---------------------------------------------------------------------------
create table app.question_sets (
  id uuid primary key default gen_random_uuid(),
  version text not null unique check (length(version) between 1 and 64),
  status text not null default 'draft' check (status in ('draft', 'active', 'retired')),
  published_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index question_sets_one_active on app.question_sets ((status)) where status = 'active';

create table app.questions (
  id uuid primary key default gen_random_uuid(),
  question_set_id uuid not null references app.question_sets (id) on delete cascade,
  code text not null check (code ~ '^Q[0-9]{1,3}$'),
  position integer not null,
  text_ja text not null,
  profile_label text not null,
  answer_type text not null
    check (answer_type in ('single_choice', 'multi_choice', 'free_text_fields', 'free_text_multi')),
  required boolean not null default true,
  min_selections integer,
  max_selections integer,
  field_count integer,
  min_items integer,           -- free text: minimum non-empty fields / items
  max_items integer,
  max_chars integer,
  -- usage categories (Q-6); enum values, not relationships
  purposes text[] not null default '{}'
    check (purposes <@ array['character_base', 'character_adjust', 'matching', 'profile_display', 'recommendation_material']),
  normalization_target text
    check (normalization_target in ('anime_work', 'anime_character', 'genre', 'world_setting')),
  public_display boolean not null default false,
  unique (question_set_id, code),
  unique (question_set_id, position),
  check (
    (answer_type = 'single_choice' and min_selections = 1 and max_selections = 1)
    or (answer_type = 'multi_choice' and min_selections >= 1 and max_selections >= min_selections)
    or (answer_type = 'free_text_fields' and field_count >= 1 and max_chars >= 1
        and min_items between 0 and field_count)
    or (answer_type = 'free_text_multi' and max_items >= 1 and max_chars >= 1
        and min_items between 0 and max_items)
  )
);

create table app.question_options (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references app.questions (id) on delete cascade,
  code text not null check (code ~ '^[A-Z]{1,2}$'),
  position integer not null,
  label_ja text not null,
  -- deterministic character elements / genre mapping (概要7, 概要8)
  attributes jsonb not null default '{}'::jsonb,
  unique (question_id, code),
  unique (question_id, position)
);

-- ---------------------------------------------------------------------------
-- Diagnosis submissions and original answers
-- ---------------------------------------------------------------------------
create table app.diagnosis_submissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references app.profiles (id) on delete cascade, -- one diagnosis per user
  client_request_id uuid not null,
  question_set_id uuid not null references app.question_sets (id),
  consent_id uuid not null references app.consents (id),
  submitted_at timestamptz not null default now(),
  unique (user_id, client_request_id)
);

-- One row per selected option or per entered text value.
create table app.diagnosis_answers (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references app.diagnosis_submissions (id) on delete cascade,
  question_id uuid not null references app.questions (id),
  value_index integer not null check (value_index >= 0),
  option_id uuid references app.question_options (id),
  text_value text,
  check ((option_id is null) <> (text_value is null)),
  unique (submission_id, question_id, value_index)
);
create index diagnosis_answers_submission_idx on app.diagnosis_answers (submission_id);

-- ---------------------------------------------------------------------------
-- Anime master (client supplied, A-06). Imported from CSV templates.
-- ---------------------------------------------------------------------------
create table app.anime_works (
  id uuid primary key default gen_random_uuid(),
  external_code text not null unique,
  title text not null,
  title_kana text,
  summary text,
  start_year integer,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger anime_works_touch before update on app.anime_works
  for each row execute function app.touch_updated_at();

create table app.work_aliases (
  id uuid primary key default gen_random_uuid(),
  work_id uuid not null references app.anime_works (id) on delete cascade,
  alias text not null,
  alias_normalized text not null check (length(alias_normalized) > 0),
  unique (alias_normalized, work_id)
);
create index work_aliases_norm_idx on app.work_aliases (alias_normalized);
create index work_aliases_trgm_idx on app.work_aliases using gin (alias_normalized extensions.gin_trgm_ops);

create table app.anime_characters (
  id uuid primary key default gen_random_uuid(),
  external_code text not null unique,
  work_id uuid references app.anime_works (id) on delete set null,
  name text not null,
  name_kana text,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now()
);
create index anime_characters_work_idx on app.anime_characters (work_id);

create table app.character_aliases (
  id uuid primary key default gen_random_uuid(),
  character_id uuid not null references app.anime_characters (id) on delete cascade,
  alias text not null,
  alias_normalized text not null check (length(alias_normalized) > 0),
  unique (alias_normalized, character_id)
);
create index character_aliases_norm_idx on app.character_aliases (alias_normalized);
create index character_aliases_trgm_idx on app.character_aliases using gin (alias_normalized extensions.gin_trgm_ops);

create table app.tags (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('genre', 'world_setting', 'guild_topic')),
  code text not null,
  name text not null,
  unique (kind, code)
);

create table app.tag_aliases (
  id uuid primary key default gen_random_uuid(),
  tag_id uuid not null references app.tags (id) on delete cascade,
  alias text not null,
  alias_normalized text not null check (length(alias_normalized) > 0),
  unique (alias_normalized, tag_id)
);
create index tag_aliases_norm_idx on app.tag_aliases (alias_normalized);
create index tag_aliases_trgm_idx on app.tag_aliases using gin (alias_normalized extensions.gin_trgm_ops);

create table app.work_tags (
  work_id uuid not null references app.anime_works (id) on delete cascade,
  tag_id uuid not null references app.tags (id) on delete cascade,
  primary key (work_id, tag_id)
);
create index work_tags_tag_idx on app.work_tags (tag_id);

-- ---------------------------------------------------------------------------
-- Normalized profile features (separate from original answers).
-- match_key is a uniform comparison key: 'work:<uuid>', 'char:<uuid>',
-- 'tag:<uuid>', 'opt:<question_code>:<option_code>'.
-- ---------------------------------------------------------------------------
create table app.profile_features (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app.profiles (id) on delete cascade,
  submission_id uuid not null references app.diagnosis_submissions (id) on delete cascade,
  question_code text not null,
  feature_kind text not null check (feature_kind in ('work', 'character', 'genre', 'world_setting', 'option', 'unresolved')),
  match_key text not null,
  work_id uuid references app.anime_works (id) on delete cascade,
  character_id uuid references app.anime_characters (id) on delete cascade,
  tag_id uuid references app.tags (id) on delete cascade,
  option_id uuid references app.question_options (id),
  resolution text not null check (resolution in ('option', 'alias_exact', 'ai', 'unresolved')),
  confidence numeric(4, 3),
  created_at timestamptz not null default now(),
  unique (user_id, question_code, match_key)
);
create index profile_features_match_idx on app.profile_features (question_code, match_key) where resolution <> 'unresolved';
create index profile_features_user_idx on app.profile_features (user_id);

-- ---------------------------------------------------------------------------
-- Character (マイキャラ): exactly one per user, current image only.
-- ---------------------------------------------------------------------------
create table app.user_avatars (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references app.profiles (id) on delete cascade,
  character_code text not null unique check (character_code ~ '^C-[0-9A-HJKMNP-TV-Z]{8}$'),
  name text check (name is null or length(name) between 1 and 40),
  species text,
  character_class text,
  element text,
  rarity text,
  title text,
  personality text,
  strengths jsonb not null default '[]'::jsonb,
  weaknesses jsonb not null default '[]'::jsonb,
  skills jsonb not null default '[]'::jsonb,
  stats jsonb not null default '{}'::jsonb,
  visual_elements jsonb not null default '{}'::jsonb,
  visual_description text,
  attributes_version text not null,
  current_image_path text,
  current_image_stage integer,
  image_status text not null default 'none' check (image_status in ('none', 'generating', 'ready', 'failed')),
  image_updated_at timestamptz,
  image_legal_hold boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  name_updated_at timestamptz
);
create trigger user_avatars_touch before update on app.user_avatars
  for each row execute function app.touch_updated_at();

-- Crockford base32 random code, e.g. C-7K3F9Q2A
create or replace function app.new_character_code() returns text
language plpgsql volatile set search_path = '' as $$
declare
  v_alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_bytes bytea := extensions.gen_random_bytes(8);
  v_code text := 'C-';
  i integer;
begin
  for i in 0..7 loop
    v_code := v_code || substr(v_alphabet, (get_byte(v_bytes, i) % 32) + 1, 1);
  end loop;
  return v_code;
end;
$$;

-- ---------------------------------------------------------------------------
-- Prompts, AI jobs and AI runs
-- ---------------------------------------------------------------------------
create table app.prompt_versions (
  id uuid primary key default gen_random_uuid(),
  purpose text not null check (purpose in ('normalize', 'profile', 'image', 'anime_recs', 'navigator')),
  version text not null,
  status text not null default 'active' check (status in ('draft', 'active', 'retired')),
  system_prompt text not null,
  output_schema_version text,
  notes text,
  created_at timestamptz not null default now(),
  unique (purpose, version)
);
create unique index prompt_versions_one_active on app.prompt_versions (purpose) where status = 'active';

create table app.ai_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app.profiles (id) on delete cascade,
  kind text not null check (kind in ('diagnosis_generation', 'evolution_image')),
  idempotency_key text not null unique,
  status text not null default 'accepted' check (status in (
    'accepted', 'normalizing_answers', 'generating_profile', 'generating_image',
    'generating_recommendations', 'completed', 'retrying', 'failed', 'superseded')),
  payload jsonb not null default '{}'::jsonb,
  stage_state jsonb not null default '{}'::jsonb,
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  manual_retries integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  lock_token uuid,
  last_error_code text,
  last_error_detail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
create index ai_jobs_user_idx on app.ai_jobs (user_id, created_at desc);
create index ai_jobs_due_idx on app.ai_jobs (next_attempt_at) where status not in ('completed', 'failed', 'superseded');
create trigger ai_jobs_touch before update on app.ai_jobs
  for each row execute function app.touch_updated_at();

create table app.ai_runs (
  id uuid primary key default gen_random_uuid(),
  job_id uuid references app.ai_jobs (id) on delete set null,
  user_id uuid,
  purpose text not null check (purpose in ('normalize', 'profile', 'image', 'anime_recs', 'navigator', 'moderation')),
  provider text not null,
  model text not null,
  prompt_version text,
  input_hash text not null,
  output_schema_version text,
  status text not null check (status in ('succeeded', 'failed', 'invalid_output', 'refused', 'timeout', 'rate_limited', 'budget_deferred')),
  error_code text,
  latency_ms integer,
  usage jsonb not null default '{}'::jsonb,
  estimated_cost_usd numeric(12, 6),
  retry_count integer not null default 0,
  safety jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index ai_runs_created_idx on app.ai_runs (created_at);
create index ai_runs_job_idx on app.ai_runs (job_id);

-- ---------------------------------------------------------------------------
-- Versioned rules
-- ---------------------------------------------------------------------------
create table app.matching_rule_versions (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('user', 'guild', 'anime')),
  version text not null unique,
  status text not null default 'draft' check (status in ('draft', 'active', 'retired')),
  rules jsonb not null,
  notes text,
  created_at timestamptz not null default now()
);
create unique index matching_rules_one_active on app.matching_rule_versions (kind) where status = 'active';

create table app.level_rules (
  rule_version text not null,
  level integer not null check (level between 1 and 100),
  exp_required integer not null check (exp_required >= 0),
  primary key (rule_version, level)
);

-- Anime recommendations (generated once per diagnosis job)
create table app.recommendations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app.profiles (id) on delete cascade,
  kind text not null check (kind in ('anime')),
  rank integer not null check (rank between 1 and 10),
  work_id uuid not null references app.anime_works (id) on delete cascade,
  score numeric(6, 2) not null,
  reason text not null,
  reason_source text not null check (reason_source in ('ai', 'template')),
  rule_version text not null,
  job_id uuid references app.ai_jobs (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (user_id, kind, rank),
  unique (user_id, kind, work_id)
);

-- Growth state (derived cache of exp_ledger; updated transactionally)
create table app.user_growth (
  user_id uuid primary key references app.profiles (id) on delete cascade,
  total_exp integer not null default 0 check (total_exp >= 0),
  gut_points integer not null default 0 check (gut_points >= 0),
  level integer not null default 1 check (level between 1 and 100),
  rule_version text not null,
  evolution_stage_requested integer not null default 0,
  updated_at timestamptz not null default now()
);
