-- =============================================================================
-- 0300 診断（データ01 / データ07 / データ08）
--   question_sets / questions / question_options /
--   diagnosis_submissions / diagnosis_answers / answer_entities
-- =============================================================================

-- ---------------------------------------------------------------- question_sets
create table public.question_sets (
  id           uuid primary key default gen_random_uuid(),
  version      integer not null unique check (version >= 1),
  status       text not null default 'draft' check (status in ('draft', 'published', 'deprecated', 'archived')),
  published_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (status = 'draft' or published_at is not null)
);
comment on table public.question_sets is '質問セット。published は同時に1件。版上げ後の旧版は deprecated として猶予期間のみ受付（U-22）';
-- published は同時に1件
create unique index question_sets_one_published on public.question_sets ((true)) where status = 'published';

create trigger question_sets_set_updated_at before update on public.question_sets
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------- questions
create table public.questions (
  id              uuid primary key default gen_random_uuid(),
  question_set_id uuid not null references public.question_sets (id) on delete cascade,
  code            text not null check (code ~ '^Q[0-9]{1,3}$'),
  sort_order      integer not null check (sort_order >= 1),
  title           text not null,
  answer_type     text not null check (answer_type in ('single_choice', 'multi_choice', 'free_fields', 'free_multi')),
  is_required     boolean not null default true,
  constraints     jsonb not null default '{}'::jsonb check (jsonb_typeof(constraints) = 'object'),
  usages          text[] not null default '{}'
                  check (usages <@ array['character_base', 'character_adjust', 'match_score', 'profile_display']::text[]),
  created_at      timestamptz not null default now(),
  unique (question_set_id, code),
  unique (question_set_id, sort_order)
);
comment on table public.questions is '質問。版をまたいで同じ意味なら同じ code。constraints = min_select / max_select / field_count / required_field_count / max_length';
comment on column public.questions.usages is 'character_base / character_adjust / match_score / profile_display（Q-6）';

-- ---------------------------------------------------------------- question_options
create table public.question_options (
  id          uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.questions (id) on delete cascade,
  code        text not null check (code ~ '^[A-Z]{1,2}$'),
  label       text not null,
  sort_order  integer not null check (sort_order >= 1),
  attributes  jsonb not null default '{}'::jsonb check (jsonb_typeof(attributes) = 'object'),
  unique (question_id, code)
);
comment on column public.question_options.attributes is 'キャラ要素（テーマカラー・エフェクト・雰囲気 等）';

-- ---------------------------------------------------------------- diagnosis_submissions
create table public.diagnosis_submissions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null unique references public.profiles (user_id) on delete cascade,
  question_set_id uuid not null references public.question_sets (id),
  ai_consent_id   uuid not null references public.user_consents (id),
  status          text not null default 'received' check (status in ('received', 'processing', 'completed', 'failed')),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 255),
  submitted_at    timestamptz not null default now(),
  completed_at    timestamptz,
  error_code      text,
  updated_at      timestamptz not null default now()
);
comment on table public.diagnosis_submissions is '診断送信。1ユーザー1回（user_id UNIQUE）。送信時点で有効だった AI 送信同意を ai_consent_id に記録';
create index diagnosis_submissions_question_set on public.diagnosis_submissions (question_set_id);
create index diagnosis_submissions_ai_consent on public.diagnosis_submissions (ai_consent_id);

create trigger diagnosis_submissions_set_updated_at before update on public.diagnosis_submissions
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------- diagnosis_answers
create table public.diagnosis_answers (
  id            uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.diagnosis_submissions (id) on delete cascade,
  user_id       uuid not null references public.profiles (user_id) on delete cascade,
  question_id   uuid not null references public.questions (id),
  option_codes  text[] not null default '{}',
  texts         text[] not null default '{}',
  created_at    timestamptz not null default now(),
  unique (submission_id, question_id)
);
comment on table public.diagnosis_answers is '診断回答。回答は加工せず保存（選択式は option_codes、自由記述は texts）';
create index diagnosis_answers_user on public.diagnosis_answers (user_id);
create index diagnosis_answers_question on public.diagnosis_answers (question_id);

-- ---------------------------------------------------------------- answer_entities
create table public.answer_entities (
  id          uuid primary key default gen_random_uuid(),
  answer_id   uuid not null references public.diagnosis_answers (id) on delete cascade,
  user_id     uuid not null references public.profiles (user_id) on delete cascade,
  entity_type text not null check (entity_type in ('work', 'anime_character', 'tag')),
  -- works / anime_characters / tags への論理参照（entity_type で参照先が変わる）
  entity_id   uuid not null,
  source_text text not null,
  confidence  numeric(4, 3) check (confidence between 0 and 1),
  created_at  timestamptz not null default now()
);
comment on table public.answer_entities is '自由記述の正規化結果（作品・キャラ・タグのリストID）。元の回答は変更しない。ロジックは第2段階（P2-2）';
create index answer_entities_answer on public.answer_entities (answer_id);
create index answer_entities_user on public.answer_entities (user_id);
create index answer_entities_entity on public.answer_entities (entity_type, entity_id);

-- ---------------------------------------------------------------- 列の説明（docs/database.md に反映）
comment on table public.question_options is '選択肢。attributes にキャラ要素';
comment on column public.question_sets.id is '質問セットID';
comment on column public.question_sets.version is '版（API の question_set_version）';
comment on column public.question_sets.status is 'draft / published / deprecated / archived';
comment on column public.question_sets.published_at is '公開日時';
comment on column public.questions.id is '質問ID';
comment on column public.questions.question_set_id is '所属する質問セット';
comment on column public.questions.code is 'Q1〜Q20。版をまたいで同じ意味なら同じ code';
comment on column public.questions.sort_order is '出題順（問番号表示）';
comment on column public.questions.title is '問題文';
comment on column public.questions.answer_type is 'single_choice / multi_choice / free_fields / free_multi';
comment on column public.questions.is_required is '必須か';
comment on column public.questions.constraints is 'min_select・max_select・field_count・required_field_count・max_length';
comment on column public.question_options.id is '選択肢ID';
comment on column public.question_options.question_id is '質問ID';
comment on column public.question_options.code is '選択肢コード（A〜）';
comment on column public.question_options.label is '表示文言';
comment on column public.question_options.sort_order is '表示順';
comment on column public.diagnosis_submissions.id is '送信ID（API の submission_id）';
comment on column public.diagnosis_submissions.user_id is 'ユーザーID（1ユーザー1回）';
comment on column public.diagnosis_submissions.question_set_id is '回答した質問セットの版';
comment on column public.diagnosis_submissions.ai_consent_id is '送信時点で有効だった AI 送信同意（証跡）';
comment on column public.diagnosis_submissions.status is 'received / processing / completed / failed（生成状態）';
comment on column public.diagnosis_submissions.idempotency_key is 'アプリが付与した冪等キー';
comment on column public.diagnosis_submissions.submitted_at is '受付日時';
comment on column public.diagnosis_submissions.completed_at is '生成完了日時';
comment on column public.diagnosis_submissions.error_code is '失敗時の理由コード（GENERATION_FAILED / GENERATION_TIMEOUT）';
comment on column public.diagnosis_answers.submission_id is '送信ID';
comment on column public.diagnosis_answers.user_id is '相性計算・RLS 用に非正規化';
comment on column public.diagnosis_answers.question_id is '質問ID';
comment on column public.diagnosis_answers.option_codes is '選択式の回答（例：{A,C,D}）';
comment on column public.diagnosis_answers.texts is '自由記述。加工せず保存';
comment on column public.answer_entities.answer_id is '回答ID';
comment on column public.answer_entities.user_id is 'ユーザーID';
comment on column public.answer_entities.entity_type is 'work / anime_character / tag';
comment on column public.answer_entities.entity_id is 'works / anime_characters / tags の ID（論理参照）';
comment on column public.answer_entities.source_text is '照合元の自由記述';
comment on column public.answer_entities.confidence is '照合の確からしさ（0〜1）';
