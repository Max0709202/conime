import { jose } from "./deps.ts";
import { env } from "./env.ts";
import { ApiError } from "./errors.ts";

export interface AuthUser {
  userId: string;
  email: string | null;
  claims: Record<string, unknown>;
}

let jwks: ReturnType<typeof jose.createRemoteJWKSet> | undefined;
const secretKey = env.jwtSecret ? new TextEncoder().encode(env.jwtSecret) : undefined;

export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1];
}

// Supabase Auth のアクセストークンを検証する。
//   HS256（従来の JWT Secret）は JWT_SECRET で、非対称鍵（JWT Signing Keys）は JWKS で検証する。
//   JWT_SECRET 未設定の HS256 は Supabase Auth の /auth/v1/user で検証する。
// 期限切れは 401 TOKEN_EXPIRED、それ以外の不正・anon key のみは 401 UNAUTHENTICATED（API02）
export async function verifyAccessToken(token: string | undefined): Promise<AuthUser> {
  if (!token) throw new ApiError("UNAUTHENTICATED");
  let claims: jose.JWTPayload;
  try {
    const header = jose.decodeProtectedHeader(token);
    if (header.alg === "HS256") {
      if (secretKey) {
        claims = (await jose.jwtVerify(token, secretKey, { algorithms: ["HS256"] })).payload;
      } else {
        claims = await verifyWithAuthServer(token);
      }
    } else {
      jwks ??= jose.createRemoteJWKSet(new URL(`${env.supabaseUrl}/auth/v1/.well-known/jwks.json`));
      claims = (await jose.jwtVerify(token, jwks)).payload;
    }
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (e instanceof jose.errors.JWTExpired) throw new ApiError("TOKEN_EXPIRED");
    throw new ApiError("UNAUTHENTICATED", "invalid access token");
  }
  if (claims.role !== "authenticated" || typeof claims.sub !== "string") {
    throw new ApiError("UNAUTHENTICATED", "a user access token is required");
  }
  return {
    userId: claims.sub,
    email: typeof claims.email === "string" ? claims.email : null,
    claims: claims as Record<string, unknown>,
  };
}

async function verifyWithAuthServer(token: string): Promise<jose.JWTPayload> {
  const claims = jose.decodeJwt(token);
  if (typeof claims.exp === "number" && claims.exp * 1000 <= Date.now()) throw new ApiError("TOKEN_EXPIRED");
  const res = await fetch(`${env.supabaseUrl}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: Deno.env.get("SUPABASE_ANON_KEY") ?? "" },
  });
  await res.body?.cancel();
  if (!res.ok) throw new ApiError("UNAUTHENTICATED", "invalid access token");
  return claims;
}
