import { env } from "./env.ts";
import { ApiError } from "./errors.ts";

// 1ユーザー60回/分（提案・API01）。Edge Function のインスタンス内で数える簡易方式。
// 第1段階（約200人の検証規模）ではこれで足りる。厳密な全体制限が必要になったら DB / Redis へ移す
const windows = new Map<string, { start: number; count: number }>();
const WINDOW_MS = 60_000;

export function checkRateLimit(userId: string, limit = env.rateLimitPerMinute) {
  const now = Date.now();
  const w = windows.get(userId);
  if (!w || now - w.start >= WINDOW_MS) {
    windows.set(userId, { start: now, count: 1 });
    if (windows.size > 10_000) {
      for (const [k, v] of windows) if (now - v.start >= WINDOW_MS) windows.delete(k);
    }
    return;
  }
  w.count += 1;
  if (w.count > limit) {
    const retryAfter = Math.max(1, Math.ceil((w.start + WINDOW_MS - now) / 1000));
    throw new ApiError("RATE_LIMITED", undefined, [{ retry_after_seconds: retryAfter }], {
      "Retry-After": String(retryAfter),
    });
  }
}
