// Edge Function "worker": queue consumer and maintenance. Not callable by clients:
// requires the WORKER_SECRET header (invoked by pg_cron/pg_net and by the api function).
// The same logic can run in a container: see scripts/worker-server.ts.
import { buildDeps } from "../_shared/deps.ts";
import { runMaintenance, runWorkerBatch } from "../_shared/worker/run.ts";

const deps = buildDeps();
const secret = Deno.env.get("WORKER_SECRET") ?? "";

function safeEqual(a: string, b: string) {
  if (!a || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response(null, { status: 405 });
  if (!secret || !safeEqual(req.headers.get("x-worker-secret") ?? "", secret)) return new Response(null, { status: 401 });
  const { task } = await req.json().catch(() => ({ task: "drain" }));
  const started = Date.now();
  const result = task === "maintenance" ? await runMaintenance(deps) : await runWorkerBatch(deps, { deadlineMs: 50_000 });
  console.log(JSON.stringify({ level: "info", msg: "worker run", task, duration_ms: Date.now() - started, result }));
  return Response.json({ task, duration_ms: Date.now() - started, result });
});
