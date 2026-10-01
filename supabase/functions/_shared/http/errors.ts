// Stable machine-readable error codes. Source of truth for docs/ERROR_CODES.md
// (tests/unit/error_catalog_test.ts keeps them in sync).

export const ERROR_CATALOG = {
  // authentication and generic
  UNAUTHENTICATED: { status: 401, message: "Authentication is required." },
  TOKEN_EXPIRED: { status: 401, message: "Access token has expired." },
  TOKEN_INVALID: { status: 401, message: "Access token is invalid." },
  ACCOUNT_DELETED: { status: 403, message: "The account has been deleted or deletion is in progress." },
  FORBIDDEN: { status: 403, message: "The operation is not allowed." },
  NOT_FOUND: { status: 404, message: "The resource was not found." },
  METHOD_NOT_ALLOWED: { status: 405, message: "Method not allowed." },
  VALIDATION_ERROR: { status: 400, message: "Request validation failed." },
  INVALID_JSON: { status: 400, message: "The request body is not valid JSON." },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, message: "Content-Type must be application/json." },
  PAYLOAD_TOO_LARGE: { status: 413, message: "The request body is too large." },
  IDEMPOTENCY_KEY_REUSED: { status: 422, message: "The Idempotency-Key was used with a different request." },
  IDEMPOTENCY_IN_PROGRESS: { status: 409, message: "A request with this Idempotency-Key is still in progress." },
  RATE_LIMITED: { status: 429, message: "Too many requests." },
  INTERNAL_ERROR: { status: 500, message: "An unexpected error occurred." },
  SERVICE_UNAVAILABLE: { status: 503, message: "The service is temporarily unavailable." },
  // consent and diagnosis
  CONSENT_REQUIRED: { status: 403, message: "Consent to external AI data transfer is required." },
  CONSENT_VERSION_MISMATCH: { status: 409, message: "The consent version is not current." },
  QUESTION_SET_OUTDATED: { status: 409, message: "The question set version is not current." },
  DIAGNOSIS_ALREADY_SUBMITTED: { status: 409, message: "A diagnosis has already been submitted." },
  DIAGNOSIS_NOT_COMPLETED: { status: 409, message: "The diagnosis has not been completed." },
  JOB_NOT_FOUND: { status: 404, message: "The generation job was not found." },
  JOB_NOT_RETRYABLE: { status: 409, message: "The generation job cannot be retried in its current state." },
  JOB_RETRY_LIMIT_REACHED: { status: 409, message: "The manual retry limit has been reached." },
  // character and profile
  CHARACTER_NOT_READY: { status: 409, message: "The character has not been generated yet." },
  CHARACTER_NAME_INVALID: { status: 400, message: "The character name is invalid." },
  CHARACTER_NAME_REJECTED: { status: 422, message: "The character name was rejected." },
  USER_NOT_FOUND: { status: 404, message: "The user was not found." },
  // guilds
  GUILD_NOT_FOUND: { status: 404, message: "The guild was not found." },
  GUILD_FULL: { status: 409, message: "The guild has reached its capacity." },
  GUILD_MEMBERSHIP_LIMIT_REACHED: { status: 409, message: "The guild membership limit has been reached." },
  // conversations, messages, attachments
  CONVERSATION_NOT_FOUND: { status: 404, message: "The conversation was not found." },
  NOT_A_MEMBER: { status: 403, message: "You are not a member." },
  BLOCKED: { status: 403, message: "This interaction is not allowed." },
  CANNOT_MESSAGE_SELF: { status: 400, message: "You cannot open a DM with yourself." },
  MESSAGE_NOT_FOUND: { status: 404, message: "The message was not found." },
  MESSAGE_CONTENT_REJECTED: { status: 422, message: "The message content was rejected." },
  CLIENT_MESSAGE_ID_CONFLICT: { status: 409, message: "client_message_id was already used with different content." },
  ATTACHMENT_NOT_FOUND: { status: 404, message: "The attachment was not found." },
  ATTACHMENT_NOT_UPLOADED: { status: 409, message: "The attachment upload has not completed." },
  ATTACHMENT_ALREADY_USED: { status: 409, message: "The attachment is already used by another message." },
  ATTACHMENT_TOO_LARGE: { status: 413, message: "The attachment is too large." },
  ATTACHMENT_TYPE_NOT_ALLOWED: { status: 415, message: "The attachment type is not allowed." },
  ATTACHMENT_CONTENT_MISMATCH: { status: 422, message: "The file content does not match an allowed image type." },
  // reactions
  ALREADY_REACTED: { status: 409, message: "You have already given グッと to this target." },
  CANNOT_REACT_TO_SELF: { status: 400, message: "You cannot react to your own content." },
  REACTION_TARGET_NOT_FOUND: { status: 404, message: "The reaction target was not found." },
  // navigator, notifications, safety
  NAVIGATOR_QUOTA_EXCEEDED: { status: 429, message: "The daily navigator limit has been reached." },
  NAVIGATOR_INPUT_REJECTED: { status: 422, message: "The navigator input was rejected." },
  NOTIFICATION_NOT_FOUND: { status: 404, message: "The notification was not found." },
  CANNOT_BLOCK_SELF: { status: 400, message: "You cannot block yourself." },
  REPORT_TARGET_NOT_FOUND: { status: 404, message: "The report target was not found." },
} as const satisfies Record<string, { status: number; message: string }>;

export type ErrorCode = keyof typeof ERROR_CATALOG;

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown>;
  readonly headers: Record<string, string>;

  constructor(code: ErrorCode, details: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
    super(ERROR_CATALOG[code].message);
    this.code = code;
    this.status = ERROR_CATALOG[code].status;
    this.details = details;
    this.headers = headers;
  }
}

export function isErrorCode(v: string): v is ErrorCode {
  return Object.prototype.hasOwnProperty.call(ERROR_CATALOG, v);
}

/** Maps a database error raised by app.raise_api_error (SQLSTATE CNM01) to an ApiError. */
export function fromDbError(err: unknown): ApiError | null {
  const e = err as { code?: string; message?: string; detail?: string };
  if (e?.code !== "CNM01" || !e.message || !isErrorCode(e.message)) return null;
  let details: Record<string, unknown> = {};
  try {
    details = e.detail ? JSON.parse(e.detail) : {};
  } catch {
    details = {};
  }
  return new ApiError(e.message, details ?? {});
}

export function errorBody(err: ApiError, requestId: string) {
  return { error: { code: err.code, message: err.message, request_id: requestId, details: err.details } };
}
