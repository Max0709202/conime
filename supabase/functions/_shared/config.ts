// Environment configuration. Secrets come only from the environment
// (Supabase Edge Function secrets in staging/production, .env.local locally).

export interface EnvConfig {
  environment: "local" | "test" | "staging" | "production";
  databaseUrl: string;
  dbPoolMax: number;
  supabaseUrl: string | null;
  serviceRoleKey: string | null;
  jwtSecret: string | null;
  jwksUrl: string | null;
  jwtIssuer: string | null;
  aiProvider: "openai" | "mock";
  openaiApiKey: string | null;
  openaiBaseUrl: string;
  workerSecret: string | null;
  storageDriver: "supabase" | "local";
  localStorageDir: string;
  publicBaseUrl: string;
  localStorageSigningKey: string;
  apiVersion: string;
}

function env(name: string): string | null {
  const v = Deno.env.get(name);
  return v && v.length > 0 ? v : null;
}

export function loadConfig(): EnvConfig {
  const environment = (env("CONIME_ENV") ?? "local") as EnvConfig["environment"];
  const supabaseUrl = env("SUPABASE_URL");
  const databaseUrl = env("CONIME_DB_URL") ?? env("SUPABASE_DB_URL");
  if (!databaseUrl) throw new Error("CONIME_DB_URL or SUPABASE_DB_URL is required");

  const aiProvider = (env("AI_PROVIDER") ?? "mock") as EnvConfig["aiProvider"];
  if (aiProvider === "openai" && !env("OPENAI_API_KEY")) {
    throw new Error("OPENAI_API_KEY is required when AI_PROVIDER=openai");
  }
  if ((environment === "staging" || environment === "production") && aiProvider === "mock") {
    console.warn(JSON.stringify({ level: "warn", msg: "AI_PROVIDER=mock in a deployed environment" }));
  }

  return {
    environment,
    databaseUrl,
    dbPoolMax: Number(env("CONIME_DB_POOL_MAX") ?? "5"),
    supabaseUrl,
    serviceRoleKey: env("SUPABASE_SERVICE_ROLE_KEY") ?? env("SUPABASE_SECRET_KEY"),
    jwtSecret: env("CONIME_JWT_SECRET") ?? env("SUPABASE_JWT_SECRET"),
    jwksUrl: env("CONIME_JWKS_URL") ?? (supabaseUrl ? `${supabaseUrl}/auth/v1/.well-known/jwks.json` : null),
    jwtIssuer: env("CONIME_JWT_ISSUER") ?? (supabaseUrl ? `${supabaseUrl}/auth/v1` : null),
    aiProvider,
    openaiApiKey: env("OPENAI_API_KEY"),
    openaiBaseUrl: env("OPENAI_BASE_URL") ?? "https://api.openai.com/v1",
    workerSecret: env("WORKER_SECRET"),
    storageDriver: (env("STORAGE_DRIVER") ?? (supabaseUrl ? "supabase" : "local")) as EnvConfig["storageDriver"],
    localStorageDir: env("LOCAL_STORAGE_DIR") ?? ".dev-storage",
    publicBaseUrl: env("PUBLIC_BASE_URL") ?? "http://127.0.0.1:8787",
    localStorageSigningKey: env("LOCAL_STORAGE_SIGNING_KEY") ?? "local-dev-only-signing-key",
    apiVersion: "1.0.0",
  };
}
