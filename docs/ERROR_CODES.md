# API Error-Code Catalog

All errors use one envelope. Every response also carries the header `X-Request-Id` with the same value as `request_id`.

```json
{
  "error": {
    "code": "GUILD_FULL",
    "message": "The guild has reached its capacity.",
    "request_id": "6f1c1c0e-6d0b-4c55-9d71-1e7f5f3b0b0a",
    "details": {}
  }
}
```

`message` is English developer text and may change. **Clients must branch on `code` only** and show their own Japanese copy. `details` is always an object, possibly empty.

Retry column: **auto** = safe to retry automatically with the same `Idempotency-Key` (設計02-C: 15 s timeout, retries after 2 s and 5 s); **after** = retry after `Retry-After`; **no** = do not retry without user action.

The source of truth is `supabase/functions/_shared/http/errors.ts`; `tests/unit/error_catalog_test.ts` fails if this table and the code disagree.

## Authentication and generic

| Code | HTTP | Retry | Meaning / client action |
|------|------|-------|-------------------------|
| `UNAUTHENTICATED` | 401 | no | No bearer token. Send the user to login. |
| `TOKEN_EXPIRED` | 401 | auto | Access token expired. Refresh the session once, then retry. If refresh fails, go to re-login (AC-1). |
| `TOKEN_INVALID` | 401 | no | Signature, audience or role invalid. Re-login. |
| `ACCOUNT_DELETED` | 403 | no | Deletion was requested or completed. Sign out locally (AC-3). |
| `FORBIDDEN` | 403 | no | Authenticated but not allowed. |
| `NOT_FOUND` | 404 | no | Route or resource does not exist or is not visible to the caller. |
| `METHOD_NOT_ALLOWED` | 405 | no | Wrong HTTP method. |
| `VALIDATION_ERROR` | 400 | no | Body/query failed schema validation. `details.fields[]` = `{path, rule, message}`. |
| `INVALID_JSON` | 400 | no | Body is not valid UTF-8 JSON. |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | no | Request `Content-Type` must be `application/json`. |
| `PAYLOAD_TOO_LARGE` | 413 | no | Request body over 256 KB. |
| `IDEMPOTENCY_KEY_REUSED` | 422 | no | Same `Idempotency-Key` sent with a different request body. Generate a new key for a new operation. |
| `IDEMPOTENCY_IN_PROGRESS` | 409 | auto | The original request with this key is still running. Retry shortly. |
| `RATE_LIMITED` | 429 | after | Too many requests. `details.retry_after_seconds`, header `Retry-After`. |
| `INTERNAL_ERROR` | 500 | auto | Unexpected server error. Report `request_id`. |
| `SERVICE_UNAVAILABLE` | 503 | after | Dependency temporarily unavailable. |

## Consent and diagnosis

| Code | HTTP | Retry | Meaning / client action |
|------|------|-------|-------------------------|
| `CONSENT_REQUIRED` | 403 | no | AI-transfer consent is missing, withdrawn or outdated. `details.required_version`. Show consent (AC-2). |
| `CONSENT_VERSION_MISMATCH` | 409 | no | The consent version sent is not the current one. `details.current_version`. |
| `QUESTION_SET_OUTDATED` | 409 | no | Submitted `question_set_version` is not current. `details.current_version`. The client must re-fetch questions and map stored answers. |
| `DIAGNOSIS_ALREADY_SUBMITTED` | 409 | no | The user already has a diagnosis (one per user). `details.submission_id`, `details.job_id`. Continue with job status. |
| `DIAGNOSIS_NOT_COMPLETED` | 409 | no | Requested data needs a completed diagnosis. `details.job_id` if one exists. |
| `JOB_NOT_FOUND` | 404 | no | Unknown generation job or not owned by caller. |
| `JOB_NOT_RETRYABLE` | 409 | no | Job is running or completed. |
| `JOB_RETRY_LIMIT_REACHED` | 409 | no | Manual retry limit reached. Contact support. |

## Character and profile

| Code | HTTP | Retry | Meaning / client action |
|------|------|-------|-------------------------|
| `CHARACTER_NOT_READY` | 409 | no | Character not generated yet. Poll the job. |
| `CHARACTER_NAME_INVALID` | 400 | no | Length/characters invalid. `details.min_length`, `details.max_length`. |
| `CHARACTER_NAME_REJECTED` | 422 | no | Name rejected by content filter. |
| `USER_NOT_FOUND` | 404 | no | User does not exist, is deleted, or is hidden by a block. |

## Guilds

| Code | HTTP | Retry | Meaning / client action |
|------|------|-------|-------------------------|
| `GUILD_NOT_FOUND` | 404 | no | Unknown or unpublished guild. |
| `GUILD_FULL` | 409 | no | Capacity reached (G-3). `details.capacity`, `details.member_count`. |
| `GUILD_MEMBERSHIP_LIMIT_REACHED` | 409 | no | Per-user guild limit reached (G-5). `details.limit`. |

## Conversations, messages and attachments

| Code | HTTP | Retry | Meaning / client action |
|------|------|-------|-------------------------|
| `CONVERSATION_NOT_FOUND` | 404 | no | Unknown conversation or caller is not a member. |
| `NOT_A_MEMBER` | 403 | no | Caller is not a member of the guild/conversation. |
| `BLOCKED` | 403 | no | Interaction prohibited by a block. The direction is not disclosed. |
| `CANNOT_MESSAGE_SELF` | 400 | no | DM peer is the caller. |
| `MESSAGE_NOT_FOUND` | 404 | no | Unknown or invisible message. |
| `MESSAGE_CONTENT_REJECTED` | 422 | no | Text rejected by content filter. |
| `CLIENT_MESSAGE_ID_CONFLICT` | 409 | no | `client_message_id` was already used with different content. |
| `ATTACHMENT_NOT_FOUND` | 404 | no | Unknown attachment or not owned by caller. |
| `ATTACHMENT_NOT_UPLOADED` | 409 | auto | Upload not finished or object missing. Upload, then retry. |
| `ATTACHMENT_ALREADY_USED` | 409 | no | Attachment is already referenced by another message. |
| `ATTACHMENT_TOO_LARGE` | 413 | no | Declared or actual size over limit. `details.max_bytes`. |
| `ATTACHMENT_TYPE_NOT_ALLOWED` | 415 | no | MIME type not allowed. `details.allowed_mime_types`. |
| `ATTACHMENT_CONTENT_MISMATCH` | 422 | no | File bytes do not match the declared image type. |

## Reactions and growth

| Code | HTTP | Retry | Meaning / client action |
|------|------|-------|-------------------------|
| `ALREADY_REACTED` | 409 | no | The caller already gave グッと to this target. `details.reaction_count`. Do not increment locally (C-3, L-1). |
| `CANNOT_REACT_TO_SELF` | 400 | no | Own message. |
| `REACTION_TARGET_NOT_FOUND` | 404 | no | Unknown or invisible target. |

## Navigator, notifications, safety and account

| Code | HTTP | Retry | Meaning / client action |
|------|------|-------|-------------------------|
| `NAVIGATOR_QUOTA_EXCEEDED` | 429 | after | Daily navigator limit reached. `details.resets_at`. |
| `NAVIGATOR_INPUT_REJECTED` | 422 | no | Input rejected by moderation. |
| `NOTIFICATION_NOT_FOUND` | 404 | no | Unknown notification. |
| `CANNOT_BLOCK_SELF` | 400 | no | Caller tried to block themselves. |
| `REPORT_TARGET_NOT_FOUND` | 404 | no | Unknown target or caller cannot see it. |

Navigator AI failures are **not** errors. The API returns `200` with `assistant_message.is_fallback = true` and a fixed fallback text (N-2).
