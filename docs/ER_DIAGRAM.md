# ER Diagram

Schema `app` (PostgreSQL). Source of truth: `supabase/migrations/`. Only key columns are shown. Every table has RLS enabled (see `20261001000400_rls_and_grants.sql`).

## Accounts, consent, diagnosis and AI

```mermaid
erDiagram
  AUTH_USERS ||--|| PROFILES : "1:1 (trigger)"
  PROFILES ||--o{ CONSENTS : "append-only"
  PROFILES ||--o| ACCOUNT_DELETION_REQUESTS : ""
  PROFILES ||--o| DIAGNOSIS_SUBMISSIONS : "one per user"
  QUESTION_SETS ||--o{ QUESTIONS : ""
  QUESTIONS ||--o{ QUESTION_OPTIONS : ""
  QUESTION_SETS ||--o{ DIAGNOSIS_SUBMISSIONS : "version used"
  CONSENTS ||--o{ DIAGNOSIS_SUBMISSIONS : "authorizes"
  DIAGNOSIS_SUBMISSIONS ||--o{ DIAGNOSIS_ANSWERS : "original answers"
  QUESTIONS ||--o{ DIAGNOSIS_ANSWERS : ""
  QUESTION_OPTIONS ||--o{ DIAGNOSIS_ANSWERS : "selected"
  DIAGNOSIS_SUBMISSIONS ||--o{ PROFILE_FEATURES : "normalized"
  ANIME_WORKS ||--o{ PROFILE_FEATURES : "work_id"
  ANIME_CHARACTERS ||--o{ PROFILE_FEATURES : "character_id"
  TAGS ||--o{ PROFILE_FEATURES : "tag_id"
  PROFILES ||--o| USER_AVATARS : "one character"
  PROFILES ||--o| USER_GROWTH : "derived from ledger"
  PROFILES ||--o{ AI_JOBS : ""
  AI_JOBS ||--o{ AI_RUNS : "per AI call"
  PROMPT_VERSIONS ||..o{ AI_RUNS : "prompt_version (text)"
  PROFILES ||--o{ RECOMMENDATIONS : "anime, ≤3"
  ANIME_WORKS ||--o{ RECOMMENDATIONS : ""

  PROFILES { uuid id PK "= auth.users.id" text status "active|deletion_requested|deleted" jsonb ai_profile }
  CONSENTS { uuid id PK bigint seq "total order" text consent_type text consent_version bool accepted }
  DIAGNOSIS_SUBMISSIONS { uuid id PK uuid user_id UK uuid client_request_id uuid question_set_id uuid consent_id }
  DIAGNOSIS_ANSWERS { uuid id PK int value_index uuid option_id text text_value }
  PROFILE_FEATURES { uuid id PK text question_code text match_key "work:/char:/tag:/opt:" text resolution "option|alias_exact|ai|unresolved" }
  USER_AVATARS { uuid id PK uuid user_id UK text character_code UK "C-XXXXXXXX" text name jsonb visual_elements text current_image_path int current_image_stage text image_status }
  USER_GROWTH { uuid user_id PK int total_exp int gut_points int level int evolution_stage_requested }
  AI_JOBS { uuid id PK text kind text idempotency_key UK text status int attempts uuid lock_token timestamptz locked_until }
  AI_RUNS { uuid id PK text purpose text provider text model text input_hash text status int latency_ms numeric estimated_cost_usd }
```

## Anime master (client supplied) and rules

```mermaid
erDiagram
  ANIME_WORKS ||--o{ WORK_ALIASES : ""
  ANIME_WORKS ||--o{ ANIME_CHARACTERS : ""
  ANIME_CHARACTERS ||--o{ CHARACTER_ALIASES : ""
  TAGS ||--o{ TAG_ALIASES : ""
  ANIME_WORKS ||--o{ WORK_TAGS : ""
  TAGS ||--o{ WORK_TAGS : ""
  MATCHING_RULE_VERSIONS { text kind "user|guild|anime" text version UK text status jsonb rules }
  LEVEL_RULES { text rule_version PK int level PK int exp_required }
  APP_SETTINGS { text key PK jsonb value }
  ANIME_WORKS { uuid id PK text external_code UK text title text status }
  WORK_ALIASES { uuid id PK text alias text alias_normalized "indexed + trigram" }
  TAGS { uuid id PK text kind "genre|world_setting|guild_topic" text code }
```

## Guilds, conversations and community

```mermaid
erDiagram
  GUILDS ||--o{ GUILD_MEMBERS : ""
  PROFILES ||--o{ GUILD_MEMBERS : "many guilds"
  GUILDS ||--o{ GUILD_TAGS : ""
  TAGS ||--o{ GUILD_TAGS : ""
  GUILDS ||--o{ GUILD_MATCH_TRAITS : "matching parameters"
  GUILDS ||--o{ GUILD_ANNOUNCEMENTS : ""
  GUILDS ||--o| CONVERSATIONS : "one talk room"
  CONVERSATIONS ||--o{ CONVERSATION_MEMBERS : ""
  CONVERSATIONS ||--o{ MESSAGES : "seq per conversation"
  CONVERSATIONS ||--o{ CONVERSATION_READS : ""
  CONVERSATIONS ||--o{ MESSAGE_ATTACHMENTS : ""
  MESSAGE_ATTACHMENTS ||--o| MESSAGES : "attachment_id UK"
  MESSAGES ||--o{ REACTIONS : "target (message)"
  PROFILES ||--o{ REACTIONS : "giver / recipient"
  REACTIONS ||--|| EXP_LEDGER : "source_id"
  PROFILES ||--o{ EXP_LEDGER : "append-only"
  PROFILES ||--o{ NOTIFICATIONS : ""
  PROFILES ||--o{ NAVIGATOR_MESSAGES : ""
  PROFILES ||--o{ BLOCKS : "blocker / blocked"
  PROFILES ||--o{ REPORTS : "reporter"
  REPORTS ||--o{ MODERATION_EVENTS : ""

  GUILDS { uuid id PK text status "draft|published|archived" int capacity "null = setting" int member_count }
  GUILD_MEMBERS { uuid guild_id PK uuid user_id PK text role }
  CONVERSATIONS { uuid id PK text kind "guild|dm" uuid guild_id UK uuid dm_user_low uuid dm_user_high bigint last_seq }
  MESSAGES { uuid id PK bigint seq "UK with conversation" uuid sender_id uuid client_message_id "UK with sender" text kind int reaction_count bool legal_hold }
  MESSAGE_ATTACHMENTS { uuid id PK text object_path UK text status "pending|ready|attached|deleted" bool legal_hold }
  CONVERSATION_READS { uuid conversation_id PK uuid user_id PK bigint last_read_seq }
  REACTIONS { uuid id PK uuid giver_id text target_type uuid target_id uuid recipient_id }
  EXP_LEDGER { bigint id PK int delta text reason uuid source_id int total_exp_after }
  REPORTS { uuid id PK text target_type uuid target_id text reason_code jsonb snapshot text snapshot_sha256 text status }
  BLOCKS { uuid blocker_id PK uuid blocked_id PK }
```

## Operational tables (service only)

`audit_logs` (append-only), `idempotency_keys`, `rate_limit_counters`, `moderation_events`, `prompt_versions`, `app_settings`, and the pgmq queue `ai_jobs`.

## Key constraints that enforce business rules

| Rule | Constraint |
|------|-----------|
| One diagnosis / character per user | `diagnosis_submissions.user_id` UNIQUE, `user_avatars.user_id` UNIQUE |
| Immutable character ID | `user_avatars.character_code` UNIQUE, no update path |
| No duplicate messages on retry | UNIQUE `(sender_id, client_message_id)` |
| Gap-free ordering | UNIQUE `(conversation_id, seq)`, seq assigned under `conversations` row lock |
| One グッと per user and target | UNIQUE `(giver_id, target_type, target_id)` |
| EXP applied once per source | UNIQUE `(user_id, reason, source_type, source_id)` on `exp_ledger` |
| One job per diagnosis / evolution stage | `ai_jobs.idempotency_key` UNIQUE |
| One DM thread per pair | UNIQUE `(dm_user_low, dm_user_high)`, CHECK low < high |
| Guild capacity | checked under `guilds` row lock in `app.api_join_guild` |
