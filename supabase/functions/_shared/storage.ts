import { env } from "./env.ts";

// Supabase Storage（非公開バケット）。アップロードと署名付き URL の発行は service_role で行い、
// アプリには期限付きの署名付き URL だけを返す（基盤02）
export const CHARACTER_BUCKET = "character-images";
export const SIGNED_URL_SECONDS = 3600;

const authHeaders = () => ({ Authorization: `Bearer ${env.serviceRoleKey}`, apikey: env.serviceRoleKey });
const objectPath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

export async function uploadObject(bucket: string, path: string, bytes: Uint8Array, contentType: string) {
  const res = await fetch(`${env.supabaseUrl}/storage/v1/object/${bucket}/${objectPath(path)}`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": contentType, "x-upsert": "true", "Cache-Control": "no-cache" },
    body: bytes as unknown as BodyInit,
  });
  if (!res.ok) throw new Error(`storage upload failed: ${res.status} ${await res.text()}`);
  await res.body?.cancel();
}

export async function createSignedUrl(
  bucket: string,
  path: string,
  expiresIn = SIGNED_URL_SECONDS,
): Promise<{ url: string; expires_at: string } | null> {
  try {
    const res = await fetch(`${env.supabaseUrl}/storage/v1/object/sign/${bucket}/${objectPath(path)}`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ expiresIn }),
    });
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    const json = await res.json() as { signedURL?: string; signedUrl?: string };
    const signed = json.signedURL ?? json.signedUrl;
    if (!signed) return null;
    const url = signed.startsWith("http") ? signed : `${env.publicSupabaseUrl}/storage/v1${signed}`;
    return { url, expires_at: new Date(Date.now() + expiresIn * 1000).toISOString().replace(/\.\d{3}Z$/, "Z") };
  } catch {
    return null;
  }
}
