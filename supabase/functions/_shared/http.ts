// 応答形式（API01）：成功は data（一覧は meta）、失敗は error
export const ok = <T>(data: T, meta?: Record<string, unknown>) => (meta === undefined ? { data } : { data, meta });

export function newRequestId(): string {
  // req_ + 時刻（36進）+ 乱数。ログと error.request_id の突合に使う
  const rand = crypto.getRandomValues(new Uint8Array(10));
  return "req_" + Date.now().toString(36).toUpperCase() +
    Array.from(rand, (b) => (b % 36).toString(36)).join("").toUpperCase();
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

// キー順を揃えた JSON（冪等キーの内容比較用）
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const obj = value as Record<string, unknown>;
  return "{" + Object.keys(obj).sort().filter((k) => obj[k] !== undefined)
    .map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
