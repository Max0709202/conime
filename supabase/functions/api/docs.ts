import { Hono } from "../_shared/deps.ts";
import { env } from "../_shared/env.ts";
import type { AppEnv } from "./context.ts";

// GET /docs：openapi.yaml の閲覧用ページ（Redoc）。dev（MOCK_MODE=true）のみ公開する（API11）
export const docs = new Hono<AppEnv>();

// config.toml の static_files で同梱した openapi.yaml を読む（local の functions serve とデプロイ後でパスが異なるため順に試す）
const CANDIDATES = [
  new URL("../../../openapi/openapi.yaml", import.meta.url),
  new URL("./openapi/openapi.yaml", `file://${Deno.cwd()}/`),
  new URL("../openapi/openapi.yaml", `file://${Deno.cwd()}/`),
];

async function readSpec(): Promise<string | null> {
  for (const url of CANDIDATES) {
    try {
      return await Deno.readTextFile(url);
    } catch { /* 次の候補 */ }
  }
  return null;
}

const HTML = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CONIME App API</title>
</head>
<body>
  <redoc spec-url="openapi.yaml" hide-download-button="false"></redoc>
  <script src="https://cdn.jsdelivr.net/npm/redoc@2.1.5/bundles/redoc.standalone.js"></script>
</body>
</html>`;

docs.get("/docs", (c) => (env.mockMode ? c.html(HTML) : c.notFound()));

docs.get("/openapi.yaml", async (c) => {
  if (!env.mockMode) return c.notFound();
  const spec = await readSpec();
  if (spec === null) return c.text("openapi.yaml is not bundled with this function", 500);
  return c.body(spec, 200, { "Content-Type": "application/yaml; charset=utf-8" });
});
