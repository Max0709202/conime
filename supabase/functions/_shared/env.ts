// 環境変数。SUPABASE_* は Edge Runtime が自動で設定する（.env.example 参照）
const get = (name: string): string | undefined => {
  const v = Deno.env.get(name);
  return v === undefined || v === "" ? undefined : v;
};

export const env = {
  supabaseUrl: get("SUPABASE_URL") ?? "http://127.0.0.1:54321",
  // 署名付き URL をアプリに返すときの公開 URL（local では Edge Runtime 内の SUPABASE_URL がコンテナ名になるため）
  publicSupabaseUrl: get("PUBLIC_SUPABASE_URL") ?? get("SUPABASE_URL") ?? "http://127.0.0.1:54321",
  serviceRoleKey: get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  dbUrl: get("SUPABASE_DB_URL") ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  jwtSecret: get("JWT_SECRET") ?? get("SUPABASE_JWT_SECRET"),
  workerSecret: get("WORKER_SECRET") ?? "",
  mockMode: (get("MOCK_MODE") ?? "false").toLowerCase() === "true",
  mockGenerationDelaySeconds: Number(get("MOCK_GENERATION_DELAY_SECONDS") ?? "5"),
  rateLimitPerMinute: Number(get("RATE_LIMIT_PER_MINUTE") ?? "60"),
  aiProvider: get("AI_PROVIDER") ?? "mock",
  apiVersion: "1.0.0",
};
