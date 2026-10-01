# Realtime Contract

Realtime is a **delivery hint**. PostgreSQL and the REST API are the source of truth. The client must not assume a permanent connection. After any disconnect, background/resume or app start, it fetches missed data through REST (`after_seq`).

## Transport

Supabase Realtime (Phoenix channels over WebSocket), **private broadcast channels only**.

| Item | Value |
|------|-------|
| URL | `wss://<project-ref>.supabase.co/realtime/v1/websocket?apikey=<publishable/anon key>&vsn=1.0.0` |
| Channel join | topic `realtime:<topic>` with `config: { private: true, broadcast: { self: false } }` and the user's `access_token` |
| Authorization | RLS on `realtime.messages`, evaluated when the channel is joined (and on token refresh) |
| Client → server | Not allowed (no broadcast/presence from clients). Send messages through `POST /v1/conversations/{id}/messages` |
| Heartbeat | Phoenix heartbeat every 25–30 s (`phoenix` topic, `heartbeat` event) |
| Token refresh | Send `access_token` on the open socket after refreshing the session (supabase-js: `realtime.setAuth(token)`) |

Project setting required in staging/production: **Realtime → Settings → "Allow public access" disabled**, so that only private channels are accepted.

## Topics

| Topic | Who may join | Events |
|-------|--------------|--------|
| `conv:{conversation_id}` | Members of that guild talk room or DM | `message.created`, `message.deleted`, `reaction.updated` |
| `user:{user_id}` | That user only | `notification.created`, `conversation.updated`, `growth.updated`, `generation.updated` |

`realtime_topic` is returned on every `Conversation` object. Your own user ID is `user_id` from `GET /v1/me`.

Suggested subscriptions: `user:{me}` always; `conv:{id}` for the open conversation and for guild rooms whose unread badge is shown. DM list updates arrive on `user:{me}` as `conversation.updated`.

## Envelope

Every broadcast payload has the same envelope (`#/components/schemas/RealtimeEnvelope`):

```json
{
  "event_id": "8a4f0b7e-3c51-4d4f-9a7e-0e6a3a4b2f10",
  "type": "message.created",
  "occurred_at": "2026-10-01T09:30:00.123Z",
  "data": { }
}
```

`event_id` is unique per broadcast. Use it to drop duplicate deliveries. The broadcast `event` name equals `type`.

## Event data

| type | data |
|------|------|
| `message.created` | `id, conversation_id, seq, client_message_id, sender {user_id, display_name, character_id, level, is_deleted, role}, kind, text, attachment {id, mime_type, byte_size, url: null}, reaction_count, is_deleted, created_at` |
| `message.deleted` | `id, conversation_id, seq` |
| `reaction.updated` | `message_id, reaction_count` |
| `notification.created` | A `Notification` object (see OpenAPI) |
| `conversation.updated` | `conversation_id, latest_seq` |
| `growth.updated` | `level, previous_level, total_exp, gut_points, evolution_job_id` |
| `generation.updated` | `job_id, kind, status, error_code` |

Realtime payloads never contain signed URLs. For an image message, call `GET /v1/attachments/{id}/download-url`, or load the message through REST, which includes signed URLs. Sender avatars are loaded from `GET /v1/users/{id}` or a cached `UserSummary`.

## Client algorithm (reconnect-safe)

1. Keep `last_seq` per conversation (the highest `seq` shown).
2. On `message.created`: if `seq == last_seq + 1`, append. If `seq > last_seq + 1`, fetch `GET …/messages?after_seq={last_seq}` and merge. If `seq <= last_seq`, ignore it (duplicate).
3. Match your own optimistic message by `client_message_id`.
4. On reconnect, resume or app start: for each visible conversation, page `GET …/messages?after_seq={last_seq}&limit=100` while `has_more_newer` is true. Refresh `GET /v1/conversations` for unread counts.
5. Mark read with `POST …/read {last_read_seq}`. The marker never moves backwards.
6. Senders blocked by the viewer: REST history already hides them in guild rooms. For realtime events, hide messages whose `sender.user_id` is in the server-provided `GET /v1/blocks` list (assumption F-12).

## Verification status

- Linux (no Docker): channel authorization (RLS on `realtime.messages`) and broadcast row creation are verified by pgTAP and integration tests.
- WebSocket delivery, token refresh and reconnect are verified by `tests/realtime/realtime-client.ts`. That client needs a running Supabase stack (`supabase start` or staging) and **has not been run yet** in this Docker-less environment (see `TEST_REPORT.md`).
