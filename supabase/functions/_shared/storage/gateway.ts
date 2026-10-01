// Storage abstraction. All buckets are private; clients only ever receive
// short-lived signed URLs created here after an authorization check.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Db } from "../db/pool.ts";

export interface SignedUpload {
  url: string;
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface SignedDownload {
  url: string;
  expiresAt: Date;
}

export interface StorageGateway {
  createSignedUploadUrl(bucket: string, path: string, contentType: string, ttlSeconds: number): Promise<SignedUpload>;
  createSignedUrls(bucket: string, paths: string[], ttlSeconds: number): Promise<Map<string, SignedDownload>>;
  download(bucket: string, path: string): Promise<Uint8Array | null>;
  upload(bucket: string, path: string, data: Uint8Array, contentType: string): Promise<void>;
  remove(bucket: string, paths: string[]): Promise<void>;
}

/** Object metadata as recorded by the storage service (size and Content-Type). */
export async function statObject(db: Db, bucket: string, path: string): Promise<{ size: number; mimetype: string } | null> {
  return await db.asService(null, async (tx) => {
    const rows = await tx`select (metadata->>'size')::bigint as size, metadata->>'mimetype' as mimetype
                          from storage.objects where bucket_id = ${bucket} and name = ${path}`;
    return rows.length ? { size: Number(rows[0].size), mimetype: String(rows[0].mimetype ?? "") } : null;
  });
}

// ---------------------------------------------------------------------------
// Supabase Storage
// ---------------------------------------------------------------------------
export class SupabaseStorageGateway implements StorageGateway {
  private readonly client: SupabaseClient;

  constructor(supabaseUrl: string, serviceRoleKey: string) {
    this.client = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  async createSignedUploadUrl(bucket: string, path: string, contentType: string, ttlSeconds: number): Promise<SignedUpload> {
    const { data, error } = await this.client.storage.from(bucket).createSignedUploadUrl(path, { upsert: false });
    if (error || !data) throw new Error(`createSignedUploadUrl failed: ${error?.message}`);
    // Supabase signed upload URLs are valid for 2 h; the API additionally enforces ttlSeconds
    // when the attachment is used (see app.api_send_message / attachments route).
    return {
      url: data.signedUrl,
      headers: { "content-type": contentType, "x-upsert": "false" },
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
    };
  }

  async createSignedUrls(bucket: string, paths: string[], ttlSeconds: number): Promise<Map<string, SignedDownload>> {
    const out = new Map<string, SignedDownload>();
    if (paths.length === 0) return out;
    const { data, error } = await this.client.storage.from(bucket).createSignedUrls(paths, ttlSeconds);
    if (error || !data) throw new Error(`createSignedUrls failed: ${error?.message}`);
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    for (const d of data) if (d.signedUrl && d.path) out.set(d.path, { url: d.signedUrl, expiresAt });
    return out;
  }

  async download(bucket: string, path: string): Promise<Uint8Array | null> {
    const { data, error } = await this.client.storage.from(bucket).download(path);
    if (error || !data) return null;
    return new Uint8Array(await data.arrayBuffer());
  }

  async upload(bucket: string, path: string, data: Uint8Array, contentType: string): Promise<void> {
    const { error } = await this.client.storage.from(bucket).upload(path, data, { contentType, upsert: true });
    if (error) throw new Error(`upload failed: ${error.message}`);
  }

  async remove(bucket: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    const { error } = await this.client.storage.from(bucket).remove(paths);
    if (error) throw new Error(`remove failed: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Local filesystem emulator (Linux development and tests without Docker).
// Signed URLs point at the dev server (/__storage/...), which enforces the
// bucket's file_size_limit and allowed_mime_types like Supabase Storage and
// records storage.objects metadata.
// ---------------------------------------------------------------------------
async function hmac(key: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

export class LocalStorageGateway implements StorageGateway {
  constructor(private readonly db: Db, private readonly dir: string, private readonly baseUrl: string, private readonly key: string) {}

  private file(bucket: string, path: string) {
    if (path.includes("..") || path.startsWith("/")) throw new Error("invalid path");
    return `${this.dir}/${bucket}/${path}`;
  }

  private async sign(op: "upload" | "download", bucket: string, path: string, ttlSeconds: number) {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const sig = await hmac(this.key, `${op}:${bucket}/${path}:${exp}`);
    const url = `${this.baseUrl}/__storage/${op}/${bucket}/${path.split("/").map(encodeURIComponent).join("/")}?exp=${exp}&sig=${sig}`;
    return { url, expiresAt: new Date(exp * 1000) };
  }

  async createSignedUploadUrl(bucket: string, path: string, contentType: string, ttlSeconds: number): Promise<SignedUpload> {
    const s = await this.sign("upload", bucket, path, ttlSeconds);
    return { ...s, headers: { "content-type": contentType, "x-upsert": "false" } };
  }

  async createSignedUrls(bucket: string, paths: string[], ttlSeconds: number): Promise<Map<string, SignedDownload>> {
    const out = new Map<string, SignedDownload>();
    for (const p of paths) out.set(p, await this.sign("download", bucket, p, ttlSeconds));
    return out;
  }

  async download(bucket: string, path: string): Promise<Uint8Array | null> {
    try {
      return await Deno.readFile(this.file(bucket, path));
    } catch {
      return null;
    }
  }

  async upload(bucket: string, path: string, data: Uint8Array, contentType: string): Promise<void> {
    const f = this.file(bucket, path);
    await Deno.mkdir(f.substring(0, f.lastIndexOf("/")), { recursive: true });
    await Deno.writeFile(f, data);
    await this.db.asService(null, async (tx) => {
      await tx`insert into storage.objects (bucket_id, name, metadata)
               values (${bucket}, ${path}, ${tx.json({ size: data.byteLength, mimetype: contentType })})
               on conflict (bucket_id, name) do update set metadata = excluded.metadata, updated_at = now()`;
    });
  }

  async remove(bucket: string, paths: string[]): Promise<void> {
    for (const p of paths) {
      await Deno.remove(this.file(bucket, p)).catch(() => {});
      await this.db.asService(null, (tx) => tx`delete from storage.objects where bucket_id = ${bucket} and name = ${p}`);
    }
  }

  /** Handles /__storage/{upload|download}/{bucket}/{path} on the local dev server. */
  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const m = /^\/__storage\/(upload|download)\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (!m) return new Response("not found", { status: 404 });
    const [, op, bucket, encPath] = m;
    const path = encPath.split("/").map(decodeURIComponent).join("/");
    const exp = Number(url.searchParams.get("exp"));
    const sig = url.searchParams.get("sig") ?? "";
    const expected = await hmac(this.key, `${op}:${bucket}/${path}:${exp}`);
    if (sig !== expected) return json(403, { error: "InvalidSignature", message: "invalid signature" });
    if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return json(400, { error: "InvalidJWT", message: "\"exp\" claim timestamp check failed" });

    if (op === "download") {
      if (req.method !== "GET") return json(405, { error: "MethodNotAllowed" });
      const data = await this.download(bucket, path);
      if (!data) return json(404, { error: "not_found", message: "Object not found" });
      const meta = await statObject(this.db, bucket, path);
      return new Response(data as unknown as BodyInit, { headers: { "content-type": meta?.mimetype ?? "application/octet-stream" } });
    }

    if (req.method !== "PUT" && req.method !== "POST") return json(405, { error: "MethodNotAllowed" });
    const contentType = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const bucketRow = await this.db.asService(null, (tx) =>
      tx`select file_size_limit, allowed_mime_types from storage.buckets where id = ${bucket}`);
    if (!bucketRow.length) return json(404, { error: "Bucket not found" });
    const allowed = bucketRow[0].allowed_mime_types as string[] | null;
    if (allowed && !allowed.includes(contentType)) {
      return json(415, { error: "invalid_mime_type", message: `mime type ${contentType} is not supported` });
    }
    const body = new Uint8Array(await req.arrayBuffer());
    const limit = bucketRow[0].file_size_limit ? Number(bucketRow[0].file_size_limit) : null;
    if (limit !== null && body.byteLength > limit) {
      return json(413, { error: "Payload too large", message: "The object exceeded the maximum allowed size" });
    }
    const existing = await statObject(this.db, bucket, path);
    if (existing && req.headers.get("x-upsert") !== "true") return json(409, { error: "Duplicate", message: "The resource already exists" });
    await this.upload(bucket, path, body, contentType);
    return json(200, { Key: `${bucket}/${path}` });
  }
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
