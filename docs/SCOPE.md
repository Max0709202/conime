# CONIME MVP — Backend Scope

Source: `CONIME_企画・仕様書_v3.1.pdf` (v3.1, 2026-09-30, chapters 1–3). Chapter 4 (業務内容 / 開発スコープ) has not been supplied; see `ASSUMPTIONS.md` and, once supplied, `CHAPTER_4_IMPACT.md`.

This repository is **backend only**. The iPhone application (Unity 6000.5+, macOS) is developed separately.

## 1. Responsibilities in scope

| # | Area | Spec reference | Backend deliverable |
|---|------|----------------|---------------------|
| 1 | Authentication / authorization | AC-1, 設計02-A | Supabase Auth integration, JWT verification, RLS, account status gate |
| 2 | Profile storage | Q-3, Q-7 | `profiles`, `user_avatars`, profile read APIs |
| 3 | External-AI transfer consent | AC-2 | Versioned consent records, enforcement before any AI use |
| 4 | Versioned question definitions | Q-1, Q-6, 概要6, 設計02-B | `question_sets`/`questions`/`question_options`, public read API |
| 5 | Diagnosis submission after registration + consent | Q-2, Q-3, 設計03 | Idempotent submission API, validation against server master |
| 6 | Original answer storage | 設計05-B | `diagnosis_submissions`, `diagnosis_answers` |
| 7 | Free-text normalization | 概要8 note | Alias dictionary first, AI fallback restricted to master IDs |
| 8 | AI profile and character attributes | Q-3, Q-7, 概要7 | Schema-validated AI output, deterministic visual elements |
| 9 | Initial character image | 設計04, A-05 | Async generation into a private bucket |
| 10 | Anime recommendations | Q-5, 概要8 | Rule-scored candidates → AI picks ≤3 with reasons, ID-validated |
| 11 | User recommendations | M-2, M-3, 設計05-C | Deterministic versioned exact-match formula |
| 12 | Guild recommendations | M-1 | Separate deterministic versioned formula |
| 13 | Published guild list / search / join | G-1–G-3 | APIs + transactional capacity enforcement |
| 14 | Multiple guild memberships | G-5 | Configurable per-user limit |
| 15 | Guild chat | C-1, G-4 | Per-guild conversation, REST + private realtime channel |
| 16 | One-to-one DMs | C-4, M-4 | DM threads with block checks |
| 17 | Text and image messages | C-1, C-4 | Signed upload, validated attachments |
| 18 | History, pagination, unread, reconnect | C-1, C-5, 非機能要件 | Per-conversation sequence numbers, read markers, catch-up API |
| 19 | “グッと” reactions | C-3, L-1, 設計07 | DB-unique reaction, transactional EXP |
| 20 | EXP / level / growth | L-1, L-2, L-5 | Immutable ledger, versioned level table, cap 100 |
| 21 | Character image update every 5 levels | L-3, 設計08 | Idempotent evolution job, current image only |
| 22 | In-app notifications | NT-1, 設計08 | Stored on event, read state managed separately |
| 23 | AI navigator | N-1, N-2 | Consent-gated, rate-limited, fallback reply |
| 24 | User blocking | S-2 | Server-defined block semantics |
| 25 | Reports (message, image, navigator response) | S-1 | Report records with snapshot + hash, evidence hold |
| 26 | Account deletion | AC-3 | Request API + server-side processing |
| 27 | Content-moderation interface | S-1 | Provider interface, moderation events, operator SQL actions |
| 28 | Operational configuration / versioned rules | M-3, L-1, C-5, G-1 | `app_settings`, `matching_rule_versions`, `level_rules`, `prompt_versions` |
| 29 | Tests | — | Unit, pgTAP/RLS, API integration, realtime, AI, storage, concurrency, security, load |
| 30 | Unity integration documentation | — | OpenAPI, Postman, C# DTOs, `UNITY_IOS_INTEGRATION.md`, `IOS_VALIDATION_CHECKLIST.md` |

## 2. Explicitly out of scope

- Unity screens, scenes, UI, layout, animation, effects, audio/BGM (D-1…D-7, N-1 visuals).
- Client-side pre-registration answer storage and client-side secure token storage (Q-2, 設計02-A).
- Apple/Google native sign-in buttons (backend only enables the providers in Supabase Auth configuration).
- Xcode project, iOS build/signing, TestFlight, App Store, physical iPhone testing.
- Production administration dashboard. Operator actions are exposed as documented SQL functions / scripts only.
- Guild-creation approval and event-application approval workflows (GE-1, 設計09-A/B are **mock-only** in the app; no backend).
- Historical character-image browsing and user-triggered regeneration (Q-4, L-3).
- Payment, subscriptions, shop, monetization.
- Anime database scraping. Anime master data is supplied by the client (A-06) via CSV templates.
- Features that appear only in reference screen images (e.g. shop, billing).

## 3. Backend features intentionally *not* added (possible future scope)

These are reasonable but not required by chapters 1–3. They are not implemented to avoid silent scope growth:

- Leaving a guild (user-initiated). Memberships are removed only by account deletion or operator action.
- Guild announcements authoring API (announcements are operator-seeded; a read API is provided for G-4).
- Push notifications (APNs). Only in-app notifications (NT-1) are implemented.
- Image upload to the navigator (設計06 says 採否は別紙で確認).
- Event features (events are mock-only).
- Recommendation plan B (AI target values, 設計05-B).

## 4. Verification boundary

Linux verification covers the backend contract only. It does **not** verify the iPhone application. Items that require macOS / Unity / iPhone are listed in `IOS_VALIDATION_CHECKLIST.md` and are external integration tests.
