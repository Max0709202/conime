import type { Tx } from "./db.ts";
import { ApiError, fromDbError } from "./errors.ts";
import { canonicalJson, sha256Hex, UUID_RE } from "./http.ts";

export interface StoredResponse {
  status: number;
  body: unknown;
}

export function readIdempotencyKey(header: string | undefined, required: boolean): string | undefined {
  if (header === undefined || header === "") {
    if (required) {
      throw new ApiError("VALIDATION_ERROR", "Idempotency-Key header is required", [
        { field: "Idempotency-Key", reason: "required" },
      ]);
    }
    return undefined;
  }
  if (!UUID_RE.test(header)) {
    throw new ApiError("VALIDATION_ERROR", "Idempotency-Key must be a UUID", [
      { field: "Idempotency-Key", reason: "format", format: "uuid" },
    ]);
  }
  return header.toLowerCase();
}

// 重複送信の防止（API01）。ユーザー×キーで成功応答を24時間保存し、同じ内容の再送には初回と同じ応答を返す。
// 処理と応答の保存は同じトランザクションで行うため、処理が二重に実行されることはない。
// 同じキーで内容が異なる場合は 422 IDEMPOTENCY_KEY_REUSED
export async function withIdempotency(
  tx: Tx,
  key: string | undefined,
  endpoint: string,
  body: unknown,
  run: () => Promise<StoredResponse>,
): Promise<StoredResponse & { replayed: boolean }> {
  if (!key) return { ...(await run()), replayed: false };
  const hash = await sha256Hex(canonicalJson(body ?? null));
  try {
    const [row] = await tx`select private.idempotency_lookup(${key}, ${endpoint}, ${hash}) as stored`;
    const stored = row.stored as { status_code: number; response: unknown } | null;
    if (stored) return { status: stored.status_code, body: stored.response, replayed: true };
  } catch (e) {
    throw fromDbError(e) ?? e;
  }
  const result = await run();
  if (result.status >= 200 && result.status < 300) {
    await tx`select private.idempotency_save(${key}, ${endpoint}, ${hash}, ${result.status}, ${tx.json(result.body as never)})`;
  }
  return { ...result, replayed: false };
}
