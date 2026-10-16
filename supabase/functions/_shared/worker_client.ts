import { env } from "./env.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

// worker を非同期に起動する（API05 (4)）。応答は待たない。
// 起動に失敗しても、pg_cron の定期実行（private.kick_worker）が実行待ちのジョブを拾う
export function kickWorker() {
  if (!env.workerSecret) return;
  const p = fetch(`${env.supabaseUrl}/functions/v1/worker`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-worker-secret": env.workerSecret },
    body: "{}",
  }).then((r) => r.body?.cancel()).catch((e) => console.error(JSON.stringify({ msg: "worker kick failed", error: String(e) })));
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(p);
}

export function runInBackground(p: Promise<unknown>) {
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(p);
}
