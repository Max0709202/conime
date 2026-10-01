# Known Limitations

## Verification gaps (environment)

| # | Limitation | Mitigation / next step |
|---|-----------|------------------------|
| L-01 | No Docker on the development machine. The real Supabase services (GoTrue, Storage server, Realtime, Edge runtime, pg_cron/pg_net, Vault) have **not** been exercised. Linux tests use user-space PostgreSQL with a test-only shim of the Supabase schemas. | CI job `supabase-stack` (Docker on GitHub runners) and staging verification (`DEPLOYMENT.md` §2). |
| L-02 | Realtime WebSocket delivery, token refresh on an open socket, and reconnect behaviour are untested. Channel authorization (RLS on `realtime.messages`) and broadcast creation are tested. | `tests/realtime/realtime-client.ts` against the Supabase stack or staging. |
| L-03 | OpenAI was never called live (no API key). Request shapes follow the documented Responses, Images and Moderations APIs, and all AI behaviour was tested with the mock provider. Model names and prices in settings are assumptions (D-07). | Staging AI evaluation with a budget cap (`tests/ai-evaluation`). |
| L-04 | JWT verification with asymmetric Supabase signing keys (JWKS) is implemented but only HS256 was exercised. | Staging sign-in through the Postman staging environment. |
| L-05 | iOS/Unity behaviour (IL2CPP JSON, Keychain, background/resume, photo picker, realtime libraries) is not verified. | `IOS_VALIDATION_CHECKLIST.md` (external). |
| L-06 | Load results come from the local dev server, not staging. | Run k6 on staging (`LOAD_TEST.md`). |

## Functional limitations (by design or pending client decision)

| # | Limitation | Note |
|---|-----------|------|
| L-10 | **Uploaded images are stored and served unchanged.** EXIF metadata (including GPS location from iPhone photos) is not stripped server-side, and image dimensions are not checked. | Strip metadata on the client before upload (checklist item 25), or add server-side re-encoding later. **Privacy risk; client decision needed.** |
| L-11 | Chat text and images are not checked by external AI moderation, because the consent does not cover them (C-04). Only a local deny-list plus user reports. | Requires a consent update to enable `moderation.chat.external_enabled`. |
| L-12 | In guild rooms, realtime events from blocked senders reach the blocker's device. Hiding them relies on the client applying `GET /v1/blocks` (F-12). REST history is filtered by the server. | Per-recipient fan-out could be added if the client requires it. |
| L-13 | No push notifications (APNs). In-app notifications only. | Out of chapters 1–3 scope. |
| L-14 | No leaving a guild, no guild creation and no event workflow (mock-only screens). | Scope (F-13, GE-1). |
| L-15 | No admin dashboard. Operators use SQL functions (`OPERATIONS.md`). | Out of scope. |
| L-16 | Guild search is a substring match (name, description, tag names). Not tuned for large guild counts. | Adequate for the MVP (≈ 5–20 guilds). |
| L-17 | Supabase signed upload URLs stay valid for 2 h at the storage layer. The API enforces a 10-minute slot when the attachment is used, and orphan cleanup removes unused uploads after 24 h. | Platform behaviour. |
| L-18 | Settings and rate-limit configuration are cached per Edge isolate for 30 s, so changes take effect within about 30 s. | — |
| L-19 | Rate limits are fixed windows in PostgreSQL (not sliding). Adequate at MVP scale; very high request volumes would need a dedicated store. | — |
| L-20 | AI evaluation fixtures (8) are written against the fictional sample master. 50–100 representative fixtures for the client's real anime master are still needed. | The client supplies the data (A-06); the fixture format is in `tests/ai-evaluation/fixtures`. |
| L-21 | Recommendation quality depends on the anime master's aliases and tags. Unresolved free text is kept but never matched. | Add aliases (`templates/anime-master/README.md`). |
| L-22 | The Edge Function worker has wall-clock limits. A slow image generation could time out and be retried (no duplicates, but extra cost). | Move only the worker to a container (`scripts/worker-server.ts`). |
| L-23 | Seeded test accounts use a known password (`Password123!`). | Staging only; never seed production; rotate after hand-over. |
