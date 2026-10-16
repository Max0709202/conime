// エラーコード（設計書 API02）。アプリは HTTP ステータスではなく error.code で分岐する
export const ERROR_STATUS = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  TOKEN_EXPIRED: 401,
  CONSENT_REQUIRED: 403,
  FORBIDDEN: 403,
  ACCOUNT_WITHDRAWN: 403,
  NOT_FOUND: 404,
  ALREADY_SUBMITTED: 409,
  QUESTION_SET_OUTDATED: 409,
  DUPLICATE_GOODTO: 409,
  GUILD_FULL: 409,
  GUILD_LIMIT_REACHED: 409,
  ALREADY_MEMBER: 409,
  GENERATION_IN_PROGRESS: 409,
  IDEMPOTENCY_KEY_REUSED: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  AI_UNAVAILABLE: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export type ErrorDetail = Record<string, unknown>;

const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  VALIDATION_ERROR: "request validation failed",
  UNAUTHENTICATED: "authentication is required",
  TOKEN_EXPIRED: "access token has expired",
  CONSENT_REQUIRED: "valid ai_transfer consent is required",
  FORBIDDEN: "forbidden",
  ACCOUNT_WITHDRAWN: "account has been withdrawn",
  NOT_FOUND: "resource not found",
  ALREADY_SUBMITTED: "diagnosis has already been submitted",
  QUESTION_SET_OUTDATED: "question set version is no longer accepted",
  DUPLICATE_GOODTO: "goodto has already been given to this target",
  GUILD_FULL: "guild is full",
  GUILD_LIMIT_REACHED: "guild membership limit reached",
  ALREADY_MEMBER: "already a member of this guild",
  GENERATION_IN_PROGRESS: "generation is in progress",
  IDEMPOTENCY_KEY_REUSED: "Idempotency-Key was used with a different request",
  RATE_LIMITED: "too many requests",
  INTERNAL_ERROR: "internal server error",
  AI_UNAVAILABLE: "generative AI is temporarily unavailable",
};

export class ApiError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message?: string,
    readonly details: ErrorDetail[] = [],
    readonly headers: Record<string, string> = {},
  ) {
    super(message ?? DEFAULT_MESSAGES[code]);
    this.status = ERROR_STATUS[code];
  }
}

export const isErrorCode = (v: unknown): v is ErrorCode => typeof v === "string" && v in ERROR_STATUS;

export function errorBody(err: ApiError, requestId: string) {
  return {
    error: { code: err.code, message: err.message, details: err.details, request_id: requestId },
  };
}

// PostgreSQL のエラーを API のエラーに変換する。
// private.* 関数は SQLSTATE P0001 + message = エラーコード、detail = JSON で業務エラーを返す
export function fromDbError(e: unknown): ApiError | undefined {
  if (!e || typeof e !== "object") return undefined;
  const pg = e as { code?: string; message?: string; detail?: string; constraint_name?: string };
  if (pg.code === "P0001" && isErrorCode(pg.message)) {
    let details: ErrorDetail[] = [];
    if (pg.detail) {
      try {
        const parsed = JSON.parse(pg.detail);
        details = Array.isArray(parsed) ? parsed : [parsed];
      } catch { /* detail が JSON でなければ付けない */ }
    }
    return new ApiError(pg.message, undefined, details);
  }
  switch (pg.code) {
    case "23503": // foreign_key_violation
    case "23514": // check_violation
    case "22P02": // invalid_text_representation
    case "22001": // string_data_right_truncation
      return new ApiError("VALIDATION_ERROR", pg.message, pg.constraint_name ? [{ constraint: pg.constraint_name }] : []);
    case "42501": // insufficient_privilege（RLS 違反を含む）
      return new ApiError("FORBIDDEN");
  }
  return undefined;
}
