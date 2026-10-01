// Container host for the worker (e.g. Cloud Run) if Edge Function limits become
// unsuitable for image generation. Same code and queue as the `worker` Edge Function;
// only the cron target URL changes. The public API is unaffected.
//   deno run -A scripts/worker-server.ts   (env: SUPABASE_DB_URL, WORKER_SECRET, AI_PROVIDER, OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
import { buildDeps } from "../supabase/functions/_shared/deps.ts";
import { runMaintenance, runWorkerBatch } from "../supabase/functions/_shared/worker/run.ts";

const deps = buildDeps();
const secret = Deno.env.get("WORKER_SECRET") ?? "";
const port = Number(Deno.env.get("PORT") ?? "8080");
Deno.serve({ port }, async (req) => {
  if (new URL(req.url).pathname === "/healthz") return new Response("ok");
  if (req.method !== "POST" || !secret || req.headers.get("x-worker-secret") !== secret) return new Response(null, { status: 401 });
  const { task } = await req.json().catch(() => ({ task: "drain" }));
  const result = task === "maintenance" ? await runMaintenance(deps) : await runWorkerBatch(deps, { deadlineMs: 240_000 });
  return Response.json({ task, result });
});
