// Uploads placeholder images for seeded avatars and chat attachments so that seeded
// signed URLs resolve. Run after `supabase db reset` (local Docker or staging).
//   deno run -A scripts/seed-storage.ts   (env: CONIME_DB_URL/SUPABASE_DB_URL; STORAGE_DRIVER etc. as for the API)
import { buildDeps } from "../supabase/functions/_shared/deps.ts";

const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const deps = buildDeps();
const avatars = await deps.db.sql`select current_image_path as p from app.user_avatars where current_image_path like 'seed/%'`;
for (const a of avatars) await deps.storage.upload("avatars", a.p, PNG, "image/png");
const atts = await deps.db.sql`select bucket, object_path from app.message_attachments where status = 'attached'
  and not exists (select 1 from storage.objects o where o.bucket_id = bucket and o.name = object_path)`;
for (const a of atts) await deps.storage.upload(a.bucket, a.object_path, PNG, "image/png");
console.log(`uploaded ${avatars.length} avatar and ${atts.length} attachment placeholders`);
await deps.db.sql.end();
