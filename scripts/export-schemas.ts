// Generates JSON Schema bundles from the contract-first sources:
//   openapi/openapi.yaml (components.schemas) -> schemas/api/conime-api.schema.json
//   schemas/ai/*.json                         -> bundled for the Edge Functions
// Output for the runtime: supabase/functions/_shared/generated/{api,ai}-schemas.json
// Run: deno task schemas   (CI fails if the generated files are stale; see scripts/ci.sh)
import { parse } from "@std/yaml";

const root = new URL("..", import.meta.url).pathname;
const doc = parse(await Deno.readTextFile(`${root}openapi/openapi.yaml`)) as {
  components: { schemas: Record<string, unknown> };
  info: { version: string };
};

function rewriteRefs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(rewriteRefs);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = k === "$ref" && typeof v === "string" ? v.replace("#/components/schemas/", "#/$defs/") : rewriteRefs(v);
    }
    return out;
  }
  return node;
}

const apiBundle = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "conime-api",
  title: `CONIME API schemas ${doc.info.version} (generated from openapi/openapi.yaml)`,
  $defs: rewriteRefs(doc.components.schemas),
};

const aiBundle: Record<string, unknown> = {};
for await (const f of Deno.readDir(`${root}schemas/ai`)) {
  if (!f.name.endsWith(".json")) continue;
  const s = JSON.parse(await Deno.readTextFile(`${root}schemas/ai/${f.name}`));
  aiBundle[s.$id] = s;
}

const write = (p: string, v: unknown) => Deno.writeTextFile(`${root}${p}`, JSON.stringify(v, null, 2) + "\n");
await write("schemas/api/conime-api.schema.json", apiBundle);
await write("supabase/functions/_shared/generated/api-schemas.json", apiBundle);
await write("supabase/functions/_shared/generated/ai-schemas.json", aiBundle);
console.log(`exported ${Object.keys(doc.components.schemas).length} API schemas, ${Object.keys(aiBundle).length} AI schemas`);
