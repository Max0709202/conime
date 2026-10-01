// PostgreSQL access.
//
// asUser(): runs a transaction as role "authenticated" with the caller's verified JWT
//           claims, exactly like PostgREST does, so RLS and auth.uid() apply.
// asService(): runs a transaction as role "service_role" (worker / trusted steps).
import postgres from "postgres";
import { ApiError, fromDbError } from "../http/errors.ts";

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;

export interface Claims {
  sub: string;
  role: "authenticated";
  [k: string]: unknown;
}

export function createPool(url: string, max = 5): Sql {
  return postgres(url, {
    max,
    prepare: false, // compatible with the Supabase transaction pooler
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
    connection: { application_name: "conime-api" },
    types: {
      // bigint (int8) → number; values used (seq, counts) stay far below 2^53
      bigint: { to: 20, from: [20], serialize: (x: number) => String(x), parse: (x: string) => Number(x) },
    },
  });
}

export class Db {
  constructor(readonly sql: Sql) {}

  async asUser<T>(claims: Claims | null, requestId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await this.sql.begin(async (tx) => {
        await tx`select
          set_config('role', ${claims ? "authenticated" : "anon"}, true),
          set_config('request.jwt.claims', ${claims ? JSON.stringify(claims) : ""}, true),
          set_config('app.request_id', ${requestId}, true)`;
        return await fn(tx);
      }) as T;
    } catch (err) {
      throw fromDbError(err) ?? err;
    }
  }

  async asService<T>(requestId: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await this.sql.begin(async (tx) => {
        await tx`select set_config('role', 'service_role', true), set_config('app.request_id', ${requestId ?? ""}, true)`;
        return await fn(tx);
      }) as T;
    } catch (err) {
      throw fromDbError(err) ?? err;
    }
  }

  /** Calls a JSON-returning app.api_* function as the user and returns its value. */
  async callUser<T = Record<string, unknown>>(
    claims: Claims | null,
    requestId: string,
    fn: string,
    args: unknown[] = [],
  ): Promise<T> {
    assertFnName(fn);
    return await this.asUser(claims, requestId, async (tx) => {
      const rows = await tx.unsafe(`select app.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args as never[]);
      return rows[0]?.r as T;
    });
  }

  /** Calls a JSON-returning app.svc_* function as service_role. */
  async callService<T = Record<string, unknown>>(requestId: string | null, fn: string, args: unknown[] = []): Promise<T> {
    assertFnName(fn);
    return await this.asService(requestId, async (tx) => {
      const rows = await tx.unsafe(`select app.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args as never[]);
      return rows[0]?.r as T;
    });
  }

  async ping(): Promise<boolean> {
    try {
      await this.sql`select 1`;
      return true;
    } catch {
      return false;
    }
  }
}

function assertFnName(fn: string) {
  if (!/^(api|svc)_[a-z0-9_]+$/.test(fn)) throw new ApiError("INTERNAL_ERROR", { reason: "invalid function name" });
}
