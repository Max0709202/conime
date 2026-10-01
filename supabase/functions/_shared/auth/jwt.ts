// Supabase Auth access-token verification.
// Supports asymmetric signing keys (ES256/RS256 via JWKS, current Supabase default)
// and the legacy shared secret (HS256). The user is always taken from `sub`.
import * as jose from "jose";
import { ApiError } from "../http/errors.ts";
import type { Claims } from "../db/pool.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface JwtVerifierOptions {
  hsSecret: string | null;
  jwksUrl: string | null;
  issuer: string | null;
  clockToleranceSec?: number;
}

export class JwtVerifier {
  private readonly hsKey: Uint8Array | null;
  private readonly jwks: ReturnType<typeof jose.createRemoteJWKSet> | null;

  constructor(private readonly opts: JwtVerifierOptions) {
    this.hsKey = opts.hsSecret ? new TextEncoder().encode(opts.hsSecret) : null;
    this.jwks = opts.jwksUrl ? jose.createRemoteJWKSet(new URL(opts.jwksUrl), { cacheMaxAge: 10 * 60 * 1000 }) : null;
  }

  async verify(authorization: string | null): Promise<Claims> {
    if (!authorization) throw new ApiError("UNAUTHENTICATED");
    const m = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (!m) throw new ApiError("UNAUTHENTICATED");
    const token = m[1];

    let alg: string | undefined;
    try {
      alg = jose.decodeProtectedHeader(token).alg;
    } catch {
      throw new ApiError("TOKEN_INVALID");
    }

    const verifyOpts: jose.JWTVerifyOptions = {
      audience: "authenticated",
      clockTolerance: this.opts.clockToleranceSec ?? 30,
      ...(this.opts.issuer ? { issuer: this.opts.issuer } : {}),
    };

    let payload: jose.JWTPayload;
    try {
      if (alg === "HS256") {
        if (!this.hsKey) throw new ApiError("TOKEN_INVALID");
        ({ payload } = await jose.jwtVerify(token, this.hsKey, { ...verifyOpts, algorithms: ["HS256"] }));
      } else if (alg === "ES256" || alg === "RS256") {
        if (!this.jwks) throw new ApiError("TOKEN_INVALID");
        ({ payload } = await jose.jwtVerify(token, this.jwks, { ...verifyOpts, algorithms: ["ES256", "RS256"] }));
      } else {
        throw new ApiError("TOKEN_INVALID");
      }
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (err instanceof jose.errors.JWTExpired) throw new ApiError("TOKEN_EXPIRED");
      throw new ApiError("TOKEN_INVALID");
    }

    if (payload.role !== "authenticated" || typeof payload.sub !== "string" || !UUID_RE.test(payload.sub)) {
      throw new ApiError("TOKEN_INVALID");
    }
    if (payload.is_anonymous === true) throw new ApiError("TOKEN_INVALID");

    // Only identity-relevant claims are forwarded to PostgreSQL.
    return {
      sub: payload.sub.toLowerCase(),
      role: "authenticated",
      aud: "authenticated",
      exp: payload.exp,
      session_id: payload.session_id,
    };
  }
}

/** Test/dev helper: mint an HS256 token like Supabase Auth would. Never used in production code paths. */
export async function mintTestToken(secret: string, sub: string, opts: { expiresInSec?: number; issuer?: string } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return await new jose.SignJWT({ role: "authenticated", aal: "aal1", is_anonymous: false, session_id: crypto.randomUUID() })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(sub)
    .setAudience("authenticated")
    .setIssuedAt(now)
    .setExpirationTime(now + (opts.expiresInSec ?? 3600))
    .setIssuer(opts.issuer ?? "conime-local")
    .sign(new TextEncoder().encode(secret));
}
