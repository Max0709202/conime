// Local Linux development server (no Docker): /v1 API + emulated signed-URL storage
// + in-process worker. Uses the same createApp() as the Edge Function.
//   CONIME_DB_URL=postgresql://postgres@127.0.0.1:54329/conime deno run -A scripts/dev-api.ts
import { buildDeps } from "../supabase/functions/_shared/deps.ts";
import { createApp } from "../supabase/functions/_shared/http/routes.ts";
import { LocalStorageGateway } from "../supabase/functions/_shared/storage/gateway.ts";
import { runMaintenance, runWorkerBatch } from "../supabase/functions/_shared/worker/run.ts";

const port = Number(Deno.env.get("PORT") ?? "8787");
if ((Deno.env.get("CONIME_ENV") ?? "local") !== "local" && (Deno.env.get("CONIME_ENV") ?? "local") !== "test") {
  throw new Error("dev-api is for local/test only");
}
const deps = buildDeps();
const app = createApp(deps);

let draining = false;
async function drain() {
  if (draining) return;
  draining = true;
  try {
    const r = await runWorkerBatch(deps, { deadlineMs: 5_000, visibilitySeconds: 60 });
    if (r.processed) console.log(JSON.stringify({ level: "info", msg: "worker", ...r }));
  } catch (err) {
    console.error(JSON.stringify({ level: "error", msg: "worker error", error: String(err) }));
  } finally {
    draining = false;
  }
}
deps.wakeWorker = () => void drain();
if (Deno.env.get("DEV_WORKER") !== "off") {
  setInterval(drain, Number(Deno.env.get("DEV_WORKER_INTERVAL_MS") ?? "1000"));
  setInterval(() => runMaintenance(deps).catch((e) => console.error(String(e))), 60_000);
}

Deno.serve({ hostname: "127.0.0.1", port, onListen: () => console.log(`dev api listening on http://127.0.0.1:${port}`) }, (req) => {
  const url = new URL(req.url);
  if (url.pathname.startsWith("/__storage/") && deps.storage instanceof LocalStorageGateway) return deps.storage.handle(req);
  return app.fetch(req);
});
