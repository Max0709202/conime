import type { Tx } from "../../_shared/db.ts";
import { Hono, z } from "../../_shared/deps.ts";
import { ApiError } from "../../_shared/errors.ts";
import { ok } from "../../_shared/http.ts";
import { readIdempotencyKey, withIdempotency } from "../../_shared/idempotency.ts";
import { type AppEnv, iso, memberTx, parseBody, publicTx, requireUser } from "../context.ts";

export const consents = new Hono<AppEnv>();

interface ConsentItem {
  doc_type: string;
  document_id: string;
  version: number;
  title: string;
  requires_reconsent: boolean;
  status: "granted" | "revoked" | "not_decided" | "reconsent_required";
  consent_id: string | null;
  decided_at: string | null;
}

// 同意の判定（認証01）：最新の有効版に対する最後の記録が granted の場合のみ「同意あり」
export async function consentSummary(tx: Tx) {
  const [row] = await tx`select private.consent_status() as items`;
  const items = (row.items as ConsentItem[]).map((i) => ({ ...i, decided_at: iso(i.decided_at) }));
  return {
    all_granted: items.length > 0 && items.every((i) => i.status === "granted"),
    ai_transfer_granted: items.some((i) => i.doc_type === "ai_transfer" && i.status === "granted"),
    items,
  };
}

// GET /consent-documents/current：最新の同意文書（認証不要）
consents.get("/consent-documents/current", async (c) => {
  const docs = await publicTx((tx) => tx`
    select id, doc_type, version, title, body, requires_reconsent, published_at
    from public.consent_documents
    where is_current
    order by array_position(array['terms', 'privacy', 'ai_transfer'], doc_type)`);
  return c.json(ok(docs.map((d) => ({ ...d, published_at: iso(d.published_at) }))));
});

// GET /me：自分の状態（SC-01 の遷移先判定）
consents.get("/me", async (c) => {
  const data = await memberTx(c, async (tx, user) => {
    const [profile] = await tx`select user_id, display_name, role, status from public.profiles where user_id = ${user.userId}`;
    const summary = await consentSummary(tx);
    const [submission] = await tx`select id, status from public.diagnosis_submissions where user_id = ${user.userId}`;
    const [character] = await tx`select 1 from public.characters where user_id = ${user.userId}`;
    const hasCharacter = Boolean(character);
    let nextAction: string;
    if (submission?.status === "completed") nextAction = hasCharacter ? "ready" : "generating";
    else if (submission?.status === "failed") nextAction = "retry_required";
    else if (submission) nextAction = "generating";
    else if (!summary.all_granted) nextAction = "consent_required";
    else nextAction = "diagnosis_required";
    return {
      user_id: profile.user_id,
      email: user.email,
      display_name: profile.display_name,
      role: profile.role,
      status: profile.status,
      consents: { all_granted: summary.all_granted, ai_transfer_granted: summary.ai_transfer_granted },
      diagnosis: { status: submission?.status ?? "not_submitted", submission_id: submission?.id ?? null },
      has_character: hasCharacter,
      next_action: nextAction,
    };
  });
  return c.json(ok(data));
});

// GET /me/consents：自分の同意状況
consents.get("/me/consents", async (c) => {
  const data = await memberTx(c, (tx) => consentSummary(tx));
  return c.json(ok(data));
});

const ConsentRecordRequest = z.object({
  consents: z.array(z.object({
    document_id: z.string().uuid(),
    decision: z.enum(["granted", "revoked"]),
  })).min(1).max(10),
  app_version: z.string().max(32).optional(),
});

// POST /me/consents：同意・撤回を記録（追記のみ）。最新の有効版の文書だけを受け付ける
consents.post("/me/consents", async (c) => {
  await requireUser(c); // 認証エラー（401）を入力検証（400）より先に返す
  const key = readIdempotencyKey(c.req.header("Idempotency-Key"), false);
  const body = await parseBody(c, ConsentRecordRequest);
  const result = await memberTx(c, (tx, user) =>
    withIdempotency(tx, key, "POST /me/consents", body, async () => {
      const ids = body.consents.map((x) => x.document_id);
      const dup = ids.findIndex((id, i) => ids.indexOf(id) !== i);
      if (dup >= 0) {
        throw new ApiError("VALIDATION_ERROR", "duplicate document_id", [
          { field: `consents[${dup}].document_id`, reason: "duplicate" },
        ]);
      }
      const current = await tx`select id from public.consent_documents where id = any (${ids}::uuid[]) and is_current`;
      const known = new Set(current.map((r) => r.id));
      const missing = body.consents
        .map((x, i) => ({ i, id: x.document_id }))
        .filter((x) => !known.has(x.id));
      if (missing.length > 0) {
        throw new ApiError(
          "VALIDATION_ERROR",
          "document_id is not a current consent document",
          missing.map((m) => ({ field: `consents[${m.i}].document_id`, reason: "not_current_document" })),
        );
      }
      for (const x of body.consents) {
        await tx`
          insert into public.user_consents (user_id, document_id, decision, app_version)
          values (${user.userId}, ${x.document_id}, ${x.decision}, ${body.app_version ?? c.req.header("X-Client-Version")?.slice(0, 32) ?? null})`;
      }
      return { status: 201, body: ok(await consentSummary(tx)) };
    }));
  return c.json(result.body as object, result.status as 201);
});
