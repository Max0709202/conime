// Edge Function "api": the versioned /v1 REST API for the Unity client.
import { buildDeps } from "../_shared/deps.ts";
import { createApp } from "../_shared/http/routes.ts";

const deps = buildDeps();
const supabaseUrl = Deno.env.get("SUPABASE_URL");
const workerSecret = Deno.env.get("WORKER_SECRET");

// Best-effort immediate processing after enqueueing; pg_cron drains the queue regardless.
deps.wakeWorker = () => {
  if (!supabaseUrl || !workerSecret) return;
  const p = fetch(`${supabaseUrl}/functions/v1/worker`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-worker-secret": workerSecret },
    body: JSON.stringify({ task: "drain" }),
  }).then((r) => r.body?.cancel()).catch(() => {});
  // deno-lint-ignore no-explicit-any
  (globalThis as any).EdgeRuntime?.waitUntil?.(p);
};

Deno.serve(createApp(deps).fetch);
