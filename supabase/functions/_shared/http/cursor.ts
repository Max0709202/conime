// Opaque cursors: base64url(JSON {t, i}) produced and consumed by the SQL list functions.
import { decodeBase64Url, encodeBase64Url } from "@std/encoding/base64url";
import { ApiError } from "./errors.ts";

export function encodeCursor(c: { t: string; i: string } | null | undefined): string | null {
  if (!c) return null;
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify({ t: c.t, i: c.i })));
}

export function decodeCursor(raw: string | undefined | null): { t: string; i: string } | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(new TextDecoder().decode(decodeBase64Url(raw)));
    if (typeof obj?.t === "string" && typeof obj?.i === "string" && !Number.isNaN(Date.parse(obj.t))) {
      return { t: obj.t, i: obj.i };
    }
  } catch {
    // fall through
  }
  throw new ApiError("VALIDATION_ERROR", { fields: [{ path: "/cursor", rule: "format", message: "invalid cursor" }] });
}

/** Replaces next_cursor objects returned by SQL with opaque strings. */
export function withOpaqueCursor<T extends { next_cursor?: unknown }>(page: T): T {
  return { ...page, next_cursor: encodeCursor(page.next_cursor as { t: string; i: string } | null) };
}
