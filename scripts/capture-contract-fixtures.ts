// Captures real API responses (local dev server) for the C# DTO round-trip check.
//   deno run -A scripts/capture-contract-fixtures.ts   → tests/unity-contracts/fixtures/<Schema>.<name>.json
import { mintTestToken } from "../supabase/functions/_shared/auth/jwt.ts";
const api = Deno.env.get("API_BASE_URL") ?? "http://127.0.0.1:8787";
const secret = Deno.env.get("CONIME_JWT_SECRET") ?? "local-only-jwt-secret-change-me-at-least-32-characters";
const alice = await mintTestToken(secret, "10000000-0000-4000-8000-000000000001");
const out = new URL("../tests/unity-contracts/fixtures/", import.meta.url);
const get = async (schema: string, name: string, path: string, token: string | null = alice, init: RequestInit = {}) => {
  const res = await fetch(`${api}${path}`, { ...init, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", ...(init.headers ?? {}) } });
  const body = await res.text();
  await Deno.writeTextFile(new URL(`${schema}.${name}.json`, out), body);
  return JSON.parse(body);
};
await get("AppConfig", "public", "/v1/app-config", null);
await get("QuestionSet", "current", "/v1/question-sets/current", null);
await get("Me", "alice", "/v1/me");
await get("MyProfile", "alice", "/v1/me/profile");
await get("Character", "alice", "/v1/me/character");
await get("Growth", "alice", "/v1/me/growth");
await get("UserRecommendationList", "alice", "/v1/recommendations/users");
await get("GuildRecommendationList", "alice", "/v1/recommendations/guilds");
await get("AnimeRecommendationList", "alice", "/v1/recommendations/anime");
const guilds = await get("GuildPage", "all", "/v1/guilds?limit=5");
void guilds;
const GUILD1 = "20000000-0000-4000-8000-000000000001";
const g = await get("GuildDetail", "guild1", `/v1/guilds/${GUILD1}`);
await get("GuildMembershipList", "alice", "/v1/me/guild-memberships");
await get("GuildMemberPage", "guild1", `/v1/guilds/${GUILD1}/members?limit=5`);
await get("ConversationPage", "alice", "/v1/conversations");
await get("MessagePage", "guild1", `/v1/conversations/${g.conversation_id}/messages?limit=20`);
await get("NotificationPage", "alice", "/v1/notifications");
await get("NavigatorHistory", "alice", "/v1/navigator/messages");
await get("BlockPage", "alice", "/v1/blocks");
await get("ReceivedReactionPage", "alice", "/v1/me/reactions/received");
await get("PublicProfile", "bob", "/v1/users/10000000-0000-4000-8000-000000000002");
await get("ErrorEnvelope", "guild_full", "/v1/guilds/20000000-0000-4000-8000-000000000005/join", alice, { method: "POST" });
await get("UploadUrl", "slot", "/v1/attachments/upload-url", alice, { method: "POST", body: JSON.stringify({ conversation_id: g.conversation_id, mime_type: "image/png", byte_size: 68 }) });
console.log("captured fixtures");
