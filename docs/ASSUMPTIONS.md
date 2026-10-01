# Assumptions Register

Every item here is a safe, inexpensive and reversible default chosen because chapter 4 or another detail is not yet available. Each one is configurable unless marked **code**. Status: `open` = needs client confirmation.

Configuration keys refer to rows of `app.app_settings` (seeded by migration `20261001000900_reference_data.sql`; change them with `scripts/set-setting.sh` or SQL, without redeploying).

## A. Scope and process

| ID | Assumption | Where | Status |
|----|-----------|-------|--------|
| A-01 | Chapter 4 is unavailable; chapters 1–3 are the baseline. Differences will be classified in `CHAPTER_4_IMPACT.md`. | — | open |
| A-02 | Chapter 4 may define API/verification-environment responsibilities (設計02-A: 「APIの提供条件は第4章」). Until then, the backend provides: REST API, OpenAPI, Postman, a local stack, and a staging environment once a Supabase project is provisioned by the client. | docs | open |
| A-03 | Supabase (Auth/Postgres/Storage/Realtime/Queues/Edge Functions) and OpenAI are the providers. Accounts and billing belong to the client. | infra | open |
| A-05 | The worker runs as an Edge Function (wall-clock limits apply). If image generation regularly exceeds them, only the worker moves to a container (`scripts/worker-server.ts`, e.g. Cloud Run) with the same queue and code; the public API is unchanged. | infra | open |
| A-04 | No Docker is available on the developer machine. Local verification uses a user-space PostgreSQL 16 with a **test-only** shim of the Supabase `auth`/`storage`/`realtime` schemas (`supabase/tests/shim/`). Realtime WebSocket delivery, GoTrue and the Storage server are verified only against `supabase start` (Docker) or staging. | tests | open |

## B. Authentication and accounts

| ID | Assumption | Key | Status |
|----|-----------|-----|--------|
| B-01 | Auth method is Supabase Auth. Apple and Google native sign-in (`signInWithIdToken`) and email/password (test accounts only) are enabled. The spec leaves the method to the server side (AC-1). | `supabase/config.toml` | open |
| B-02 | Anonymous sign-in is disabled. Pre-registration answers stay on the device (Q-2). | config | open |
| B-03 | Access-token lifetime 3600 s, refresh-token rotation on. The client refreshes proactively. | config | open |
| B-04 | Display name = character name. Before the user names the character, the server returns `display_name: null` and the client shows its own placeholder string. | **code** | open |
| B-05 | Character ID (キャラID) format: `C-` + 8 Crockford base32 characters (e.g. `C-7K3F9Q2A`), random and immutable. An internal UUID is also kept. | **code** | open |
| B-06 | Character name: 1–20 characters after NFKC normalisation and trimming. No control characters or URLs. Checked against a local deny-list only (no external AI, because the consent in AC-2 covers diagnosis and navigator input only). | `profile.character_name.*` | open |

## C. Consent (AC-2)

| ID | Assumption | Key | Status |
|----|-----------|-----|--------|
| C-01 | One consent type `ai_data_transfer` covers diagnosis answers and navigator input. The current version string is configurable. Consent wording is supplied by the client and not stored by the backend; only the version is. | `consent.ai_data_transfer.current_version` | open |
| C-02 | Consent is append-only. Withdrawing consent blocks new diagnosis submissions, navigator messages and AI retries. Already generated results remain. | **code** | open |
| C-03 | A consent-version bump requires re-consent before *new* AI use. Already submitted jobs continue under the version they were accepted with. | **code** | open |
| C-04 | Chat text and chat images are **not** sent to external AI moderation by default, because the consent text does not cover them. A local filter plus user reports are used instead. Turning external chat moderation on requires a consent update. | `moderation.chat.external_enabled=false` | open |

## D. Diagnosis and AI

| ID | Assumption | Key | Status |
|----|-----------|-----|--------|
| D-01 | One diagnosis per user, with no retake (Q-2 “やり直しボタンは設けない”, Q-4 “1ユーザー1体”). A second submission with a different `client_request_id` returns `DIAGNOSIS_ALREADY_SUBMITTED`. | **code** | open |
| D-02 | A submission must use the **currently active** question-set version. Otherwise `QUESTION_SET_OUTDATED` is returned with the current version. | **code** | open |
| D-03 | Question master v1 reproduces 概要6 (Q1–Q20). Free-text limits: 50 characters per field and 3 fields for Q1/Q3 (at least 1 filled); 200 characters for single free text; up to 5 items × 50 characters for “複数可”. Q7 and Q8 are optional (a user may have none); all other questions are required. Per-question values are in the question master. | question master | open |
| D-04 | Free-text normalisation: exact alias match (NFKC, case/width/kana-folded, punctuation removed) first. Unresolved values go to AI with up to 15 trigram-prefiltered candidates per value; the AI may choose only a supplied ID or `null`. | `ai.normalization.*` | open |
| D-05 | Visual elements (theme colour, effect, mood, expression, art style, form, species/gender, look) are mapped deterministically from the Q13–Q20 options (概要7). AI writes only original text. The Q14 effect is suppressed when Q18 is B or C (概要7). | question master `attributes` | open |
| D-06 | Rarity and base stats are deterministic: they are seeded from the character UUID and use configurable weights. AI does not choose them, which keeps cost low and prevents manipulation. | `character.rarity_weights`, `character.stats` | open |
| D-07 | Model IDs are configuration: text `gpt-5-mini`, image `gpt-image-1`, moderation `omni-moderation-latest`. Verify availability and pricing on the client's OpenAI account before staging. | `ai.models.*`, `ai.pricing.*` | open |
| D-08 | Image: one 1024×1536 PNG per generation, in portrait to fit the iPhone layout. | `ai.image.*` | open |
| D-09 | AI retry: up to 3 attempts per stage with exponential backoff (30 s, 120 s, 600 s). After that the job is `failed` with `retryable=true`, and the user may call the retry endpoint, which allows up to 3 manual retries. | `ai.jobs.*` | open |
| D-10 | If anime-recommendation AI fails validation twice, the job falls back to deterministic top-3 candidates with template reasons (`reason_source=template`) rather than failing the whole diagnosis. | `ai.anime_recs.fallback_enabled=true` | open |
| D-11 | Daily AI budget guard: when the estimated spend for the current UTC day exceeds the limit, new AI stages are deferred (`retrying`), not failed. | `ai.budget.daily_usd` (local 0 = mock only, staging 5, production 30) | open |
| D-13 | Generated text is post-validated: the image description and titles must not contain names of works/characters the user mentioned (normalized match). Rejected output is regenerated once, then the stage is retried as a job failure. | **code** | open |
| D-14 | Original answers, chat messages and navigator input are stored as entered (control characters removed, trimmed; no width conversion). Only character names are NFKC-normalized. Matching uses separate normalized keys. | **code** | open |
| D-12 | If the image stage fails permanently, the profile and character text are still returned. `image_status=failed` and the job is `failed`/retryable. | **code** | open |

## E. Recommendations and matching (概要8 is marked 仮)

| ID | Assumption | Key | Status |
|----|-----------|-----|--------|
| E-01 | User matching `user-v1` uses the exact values from 概要8 “フレンド”: base 50 + capped exact-match points, maximum 100. No partial points. | `matching_rule_versions(kind=user)` | open |
| E-02 | Q7/Q8/Q11 “リストID一致で +2% (最大2%)” = +2 if **any** ID matches. | rule JSON | open |
| E-03 | Guild matching `guild-v1` uses 概要8 “ギルド(仮)” values. Guild parameters are operator-defined `guild_match_traits` in the same key space as user features. Top 3; guilds the user already belongs to are excluded; full guilds are included with `is_full=true`. | rule JSON | open |
| E-04 | Anime scoring `anime-v1`: favourite-work genre tags vs candidate genre tags +10 each (cap 40); any Q11 world tag match +30; Q15 option→genre mapping match +30. Q1/Q7 works are excluded as already viewed; works carrying a Q8 disliked genre are excluded. The top 10 candidates go to AI, which returns ≤3. | rule JSON | open |
| E-05 | User recommendations return the top 10 eligible users with at least one matched item (so `compatibility_percent` > 50; minimum configurable). Only users with completed diagnosis, `active` status and no block in either direction are eligible. | `recommendations.users.limit` | open |
| E-06 | User and guild recommendations are recalculated on each request (deterministic and cheap at MVP scale), so new users appear immediately. Anime recommendations are generated once per diagnosis and stored. | **code** | open |
| E-07 | Ties are ordered by score desc, then number of matched items desc, then most recent activity desc, then ID. | **code** | open |

## F. Guilds, chat and DMs

| ID | Assumption | Key | Status |
|----|-----------|-----|--------|
| F-01 | Default guild capacity 100 (G-1). Per-guild override is allowed. | `guild.default_capacity` | open |
| F-02 | Per-user guild membership limit: 10 (G-5 allows a limit). `null` = unlimited. | `guild.max_memberships_per_user` | open |
| F-03 | Guild search fields: name, description and tag names (partial, case-insensitive). | **code** | open |
| F-04 | Guild member list and talk room are visible to members only. Guild detail (name, description, tags, member count, capacity) is visible to any registered user. | RLS | open |
| F-05 | Guild member roles: `leader`, `officer`, `member` (C-2). Unknown values must be tolerated by the client. Roles are assigned by operators. | **code** | open |
| F-06 | DM start condition (M-4): the peer is an active registered user and there is no block in either direction. No mutual-follow or shared-guild requirement. | **code** | open |
| F-07 | History retention (C-5): the newest 1,000 messages per guild room and per DM thread, and the newest 200 navigator messages per user, are retrievable. Older rows are purged daily unless they are under evidence hold. | `chat.history.*`, `navigator.history.max_messages` | open |
| F-08 | Message text: 1–1,000 characters. | `chat.message.max_chars` | open |
| F-09 | Image messages: JPEG, PNG, HEIC, WebP; max 10 MB; max 4096 px per side is not enforced server-side (not decoded). MIME is verified by magic bytes after upload. | `attachments.*` | open |
| F-10 | Upload slot valid for 10 min (enforced by the API when the attachment is used; the Supabase signed upload URL itself is valid for 2 h and cannot be shortened). Signed download URL valid for 1 h. | `attachments.*_ttl_seconds` | open |
| F-13 | Leaving a guild is not provided (not in chapters 1–3). Memberships end only by account deletion or operator action. | scope | open |
| F-11 | Unattached uploads are deleted after 24 h by the maintenance job. | `attachments.orphan_ttl_hours` | open |
| F-12 | Guild talk room: the server hides messages from users the viewer has blocked in REST history. Realtime events carry `sender_id`; the client hides senders listed by `GET /v1/blocks`, following the server's list rather than its own judgment (S-2). | **code** | open |

## G. Growth (L-1 … L-5)

| ID | Assumption | Key | Status |
|----|-----------|-----|--------|
| G-01 | Receiving one グッと on a message: +10 EXP, +1 グッとポイント. The giver gets nothing. | `growth.reaction.*` | open |
| G-02 | Self-グッと is rejected (`CANNOT_REACT_TO_SELF`). | **code** | open |
| G-03 | Level curve `level-v1`: cumulative EXP to reach level L = `50·(L−1) + 5·(L−1)²`. Lv5 = 280, Lv10 = 855, Lv100 = 53,955. Cap 100. | `level_rules` | open |
| G-04 | Evolution image every 5 levels (Lv5, 10, …, 100). If one EXP event crosses several boundaries, only the final applicable stage is generated (low-cost default). | `growth.evolution.*` | open |
| G-05 | The superseded image object is deleted after the new image is stored and referenced, unless it is under evidence hold. | **code** | open |
| G-06 | Reactions are only possible on messages in conversations the giver belongs to; the target type `action` is reserved for future use (L-1 says target actions are 別途定める). | **code** | open |

## H. Notifications and navigator

| ID | Assumption | Key | Status |
|----|-----------|-----|--------|
| H-01 | Notification types: `reaction_received`, `level_up`, `character_evolved`, `generation_completed`, `generation_failed`, `dm_received`. NT-1 says types are undecided, so enabled types are configurable. | `notifications.enabled_types` | open |
| H-02 | Navigator: 30 user messages per user per day; 500 characters per message; 3 reply suggestions; a fixed fallback message on failure (N-2). Sends only the user's message, the last 10 turns and minimal app context (character name/level), not other users' data. | `navigator.*` | open |
| H-03 | Navigator input and output pass through the moderation interface (covered by consent C-01). | **code** | open |
| H-04 | Navigator replies are truncated to 400 characters, with up to 3 suggestions of at most 30 characters. A retry with the same `client_message_id` returns the stored exchange without a new AI call. | **code** | open |

## I. Safety, privacy and deletion

| ID | Assumption | Key | Status |
|----|-----------|-----|--------|
| I-01 | Block (S-2): no new DMs in either direction; existing DM history remains readable but `can_send=false`; excluded from each other's recommendations; blocked users get `404` for the blocker's public profile; guild co-membership is unaffected; reactions between them are rejected. | **code** | open |
| I-02 | Report reason codes: `spam`, `harassment`, `sexual`, `violence`, `hate`, `self_harm`, `impersonation`, `copyright`, `privacy`, `other`. | `reports.reason_codes` | open |
| I-03 | A report stores a JSON snapshot and SHA-256 of the reported content and places the content under evidence hold until the report is resolved. | **code** | open |
| I-04 | **Policy requiring client approval:** account deletion does not destroy evidence linked to an unresolved report. Held items are kept until the report is closed plus 90 days, then purged. | `retention.evidence_days_after_resolution` | open |
| I-05 | Account deletion: on request, access is revoked immediately (status gate + Auth ban). Processing then runs: profile anonymised; diagnosis answers, features, avatar images, navigator history, notifications, consents (kept as audit summary) and DM/guild message bodies deleted or tombstoned; memberships removed; Auth user soft-deleted. Audit logs retain only the pseudonymous user ID for 1 year. Grace period 0 days (no cancellation flow is specified). | `retention.*`, `account_deletion.grace_days` | open |
| I-08 | Local development relaxes the diagnosis-submission limit to 100 per hour so test collections can be re-run (`supabase/seed/00_settings_local.sql`). Staging and production keep the defaults. | settings | open |
| I-06 | Rate limits (per user unless noted): diagnosis submit 5/h, message send 60/min, upload URL 20/10 min, reactions 120/min, navigator 30/day, reports 20/h, blocks 30/h, DM-thread create 20/h, question set (per IP) 60/min. | `rate_limits.*` | open |
| I-07 | No production admin dashboard. Operators act through documented service-role SQL functions (`docs/OPERATIONS.md`). | — | open |
