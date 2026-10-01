// Wires concrete dependencies from the environment.
import { createClient } from "@supabase/supabase-js";
import { type EnvConfig, loadConfig } from "./config.ts";
import { createPool, Db } from "./db/pool.ts";
import { JwtVerifier } from "./auth/jwt.ts";
import { LocalStorageGateway, type StorageGateway, SupabaseStorageGateway } from "./storage/gateway.ts";
import { AiRunner } from "./ai/runner.ts";
import { OpenAiProvider } from "./ai/openai.ts";
import { MockAiProvider } from "./ai/mock.ts";
import type { AiProvider } from "./ai/provider.ts";
import type { AuthAdmin, Deps } from "./http/app.ts";

/** Supabase Auth admin (service role). */
export class SupabaseAuthAdmin implements AuthAdmin {
  private readonly client;
  constructor(url: string, serviceRoleKey: string) {
    this.client = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  async banUser(userId: string) {
    const { error } = await this.client.auth.admin.updateUserById(userId, { ban_duration: "876000h" });
    if (error) throw new Error(error.message);
  }
  async softDeleteUser(userId: string) {
    const { error } = await this.client.auth.admin.deleteUser(userId, true);
    if (error && !/not found/i.test(error.message)) throw new Error(error.message);
  }
}

/** Local/test Auth admin: updates the auth.users shim directly. */
export class LocalAuthAdmin implements AuthAdmin {
  constructor(private readonly db: Db) {}
  async banUser(userId: string) {
    await this.db.sql`update auth.users set banned_until = 'infinity' where id = ${userId}`;
  }
  async softDeleteUser(userId: string) {
    await this.db.sql`update auth.users set deleted_at = now(), email = null, raw_user_meta_data = '{}' where id = ${userId}`;
  }
}

export function buildDeps(config: EnvConfig = loadConfig(), overrides: Partial<{ provider: AiProvider; storage: StorageGateway; authAdmin: AuthAdmin }> = {}): Deps {
  const db = new Db(createPool(config.databaseUrl, config.dbPoolMax));
  const verifier = new JwtVerifier({ hsSecret: config.jwtSecret, jwksUrl: config.jwtSecret && !config.supabaseUrl ? null : config.jwksUrl, issuer: config.jwtIssuer });

  const storage = overrides.storage ?? (config.storageDriver === "supabase"
    ? new SupabaseStorageGateway(required(config.supabaseUrl, "SUPABASE_URL"), required(config.serviceRoleKey, "SUPABASE_SERVICE_ROLE_KEY"))
    : new LocalStorageGateway(db, config.localStorageDir, config.publicBaseUrl, config.localStorageSigningKey));

  const provider = overrides.provider ?? (config.aiProvider === "openai"
    ? new OpenAiProvider(required(config.openaiApiKey, "OPENAI_API_KEY"), config.openaiBaseUrl)
    : new MockAiProvider());

  const authAdmin = overrides.authAdmin ?? (config.supabaseUrl && config.serviceRoleKey
    ? new SupabaseAuthAdmin(config.supabaseUrl, config.serviceRoleKey)
    : new LocalAuthAdmin(db));

  return { config, db, verifier, storage, ai: new AiRunner(db, provider), authAdmin };
}

function required(v: string | null, name: string): string {
  if (!v) throw new Error(`${name} is required`);
  return v;
}
