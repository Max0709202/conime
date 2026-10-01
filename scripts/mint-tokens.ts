// LOCAL ONLY: mints HS256 access tokens for seeded users with the local dev secret,
// for k6 runs against the Linux dev server. Never use with a real project secret.
//   deno run -A scripts/mint-tokens.ts [from] [to] > tests/load/tokens.local.json   (default 1..190)
import { mintTestToken } from "../supabase/functions/_shared/auth/jwt.ts";
const secret = Deno.env.get("CONIME_JWT_SECRET") ?? "local-only-jwt-secret-change-me-at-least-32-characters";
const out: Array<{ user_id: string; token: string }> = [];
const from = Number(Deno.args[0] ?? "1");
const to = Number(Deno.args[1] ?? "190");
for (let n = from; n <= to; n++) {
  const id = `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  out.push({ user_id: id, token: await mintTestToken(secret, id, { expiresInSec: 4 * 3600 }) });
}
console.log(JSON.stringify(out));
