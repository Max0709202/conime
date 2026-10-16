import { postgres, type Sql, type TransactionSql } from "./deps.ts";
import { env } from "./env.ts";

// Edge Function → PostgreSQL の直接接続（SUPABASE_DB_URL）。
// 会員の要求は authenticated ロール + JWT クレームを設定したトランザクションで実行し、RLS を常に適用する（基盤02 設計方針2）
export const sql: Sql = postgres(env.dbUrl, {
  prepare: false, // Supavisor（transaction mode）対応
  max: 4,
  idle_timeout: 20,
  connect_timeout: 10,
  connection: { application_name: "conime-edge" },
});

export type Tx = TransactionSql;

export type DbRole = "anon" | "authenticated";

export function withRls<T>(role: DbRole, claims: Record<string, unknown>, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`select set_config('role', ${role}, true), set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`;
    return await fn(tx);
  }) as Promise<T>;
}

// service_role 相当（worker・内部処理のみ。RLS をバイパスする）
export function withService<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql.begin((tx) => fn(tx)) as Promise<T>;
}
