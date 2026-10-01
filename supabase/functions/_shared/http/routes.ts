// /v1 routes. Each handler validates input, calls exactly one authoritative
// app.api_* function per mutation, and shapes the response per openapi.yaml.
import { Hono } from "hono";
import { ApiError } from "./errors.ts";
import { createBaseApp, type Deps, RouteKit } from "./app.ts";
import { decodeCursor, withOpaqueCursor } from "./cursor.ts";
import { parseEnumParam, parseIntParam, parseUuidParam } from "./validate.ts";
import { type MasterQuestion, type SubmittedAnswer, validateDiagnosisAnswers } from "../domain/diagnosis.ts";
import { cleanUserText, normalizeName } from "../domain/normalize.ts";
import { mimeMatches, sniffImageMime } from "../domain/image.ts";
import { statObject } from "../storage/gateway.ts";

type J = Record<string, unknown>;

export function createApp(deps: Deps) {
  const app = createBaseApp(deps);
  const kit = new RouteKit(deps);
  const v1 = new Hono<{ Variables: { requestId: string; userId: string; started: number } }>();
  const limit = (q: string | undefined, def = 20) => parseIntParam("limit", q, 1, 100) ?? def;
  const cursor = (q: string | undefined) => {
    return decodeCursor(q);
  };

  // ------------------------------------------------------------------ system
  v1.get("/health", kit.route({ auth: "none", rateScope: "question_set" }, async () => {
    if (!(await deps.db.ping())) throw new ApiError("SERVICE_UNAVAILABLE");
    return { body: { status: "ok", api_version: deps.config.apiVersion, time: new Date().toISOString() } };
  }));

  v1.get("/app-config", kit.route({ auth: "none", rateScope: "question_set" }, async (ctx) => {
    const cfg = await kit.call<J>(ctx, "api_client_config");
    return { body: { api_version: deps.config.apiVersion, ...cfg } };
  }));

  v1.get("/question-sets/current", kit.route({ auth: "none", rateScope: "question_set" }, async (ctx) => {
    const qs = await kit.call<J | null>(ctx, "api_get_current_question_set");
    if (!qs) throw new ApiError("SERVICE_UNAVAILABLE", { reason: "no active question set" });
    return { body: qs };
  }));

  // ------------------------------------------------------------------ account & consent
  v1.get("/me", kit.route({ auth: "allow_deleted" }, async (ctx) => ({ body: await kit.call(ctx, "api_me") })));

  v1.get("/consents", kit.route({}, async (ctx) => ({ body: await kit.call(ctx, "api_consent_status") })));

  v1.post("/consents", kit.route({ rateScope: "consent", bodySchema: "ConsentRequest", idempotent: true }, async (ctx) => {
    const b = ctx.body as { consent_type: string; consent_version: string; accepted: boolean };
    return { body: await kit.call(ctx, "api_record_consent", [b.consent_type, b.consent_version, b.accepted]) };
  }));

  v1.get("/account/deletion", kit.route({ auth: "allow_deleted" }, async (ctx) => ({
    body: await kit.call(ctx, "api_account_deletion_status"),
  })));

  v1.post("/account/deletion", kit.route({ auth: "allow_deleted", bodySchema: "AccountDeletionRequest", idempotent: true }, async (ctx) => {
    const b = ctx.body as { reason?: string };
    const status = await kit.call<J>(ctx, "api_request_account_deletion", [b.reason ?? null]);
    // Revoke sign-in now; data processing runs in the worker (AC-3).
    await deps.authAdmin.banUser(ctx.userId).catch((err) =>
      console.error(JSON.stringify({ level: "error", msg: "auth ban failed", request_id: ctx.requestId, error: String(err) })));
    deps.wakeWorker?.();
    return { status: 202, body: status };
  }));

  // ------------------------------------------------------------------ diagnosis
  v1.post("/diagnosis/submissions", kit.route({ rateScope: "diagnosis_submit", bodySchema: "DiagnosisSubmissionRequest", idempotent: true }, async (ctx) => {
    const b = ctx.body as { client_request_id: string; question_set_version: string; consent_version: string; answers: SubmittedAnswer[] };
    const master = await kit.call<{ status: string; questions: MasterQuestion[] } | null>(ctx, "api_question_master", [b.question_set_version]);
    let answers: unknown = b.answers;
    if (master && master.status === "active") {
      const v = validateDiagnosisAnswers(master.questions, b.answers);
      if (v.errors.length) throw new ApiError("VALIDATION_ERROR", { fields: v.errors });
      answers = v.answers;
    }
    const res = await kit.call<J>(ctx, "api_submit_diagnosis", [
      b.client_request_id, b.question_set_version, b.consent_version, answers,
    ]);
    const { replay, ...body } = res;
    if (!replay) deps.wakeWorker?.();
    return { status: replay ? 200 : 202, body };
  }));

  v1.get("/diagnosis/submissions/current", kit.route({}, async (ctx) => ({ body: await kit.call(ctx, "api_current_submission") })));

  v1.get("/generation-jobs/:job_id", kit.route({}, async (ctx) => ({
    body: await kit.call(ctx, "api_get_job", [parseUuidParam("job_id", ctx.c.req.param("job_id"))]),
  })));

  v1.post("/generation-jobs/:job_id/retry", kit.route({ rateScope: "job_retry", idempotent: true }, async (ctx) => {
    const job = await kit.call(ctx, "api_retry_job", [parseUuidParam("job_id", ctx.c.req.param("job_id"))]);
    deps.wakeWorker?.();
    return { status: 202, body: job };
  }));

  // ------------------------------------------------------------------ profile & growth
  v1.get("/me/profile", kit.route({}, async (ctx) => ({ body: await kit.call(ctx, "api_my_profile") })));
  v1.get("/me/character", kit.route({}, async (ctx) => ({ body: await kit.call(ctx, "api_my_character") })));
  v1.patch("/me/character", kit.route({ rateScope: "character_name", bodySchema: "CharacterNameRequest", idempotent: true }, async (ctx) => {
    const name = normalizeName((ctx.body as { name: string }).name);
    return { body: await kit.call(ctx, "api_rename_character", [name]) };
  }));
  v1.get("/me/growth", kit.route({}, async (ctx) => ({ body: await kit.call(ctx, "api_growth") })));
  v1.get("/me/reactions/received", kit.route({}, async (ctx) => ({
    body: withOpaqueCursor(await kit.call(ctx, "api_received_reactions", [cursor(ctx.c.req.query("cursor")), limit(ctx.c.req.query("limit"))])),
  })));
  v1.get("/users/:user_id", kit.route({}, async (ctx) => ({
    body: await kit.call(ctx, "api_public_profile", [parseUuidParam("user_id", ctx.c.req.param("user_id"))]),
  })));

  // ------------------------------------------------------------------ recommendations
  v1.get("/recommendations/users", kit.route({}, async (ctx) => {
    const n = parseIntParam("limit", ctx.c.req.query("limit"), 1, 20);
    return { body: await kit.call(ctx, "api_user_recommendations", [n]) };
  }));
  v1.get("/recommendations/guilds", kit.route({}, async (ctx) => ({ body: await kit.call(ctx, "api_guild_recommendations") })));
  v1.get("/recommendations/anime", kit.route({}, async (ctx) => ({ body: await kit.call(ctx, "api_anime_recommendations") })));

  // ------------------------------------------------------------------ guilds
  v1.get("/guilds", kit.route({}, async (ctx) => {
    const q = ctx.c.req.query("q");
    if (q && [...q].length > 50) {
      throw new ApiError("VALIDATION_ERROR", { fields: [{ path: "/q", rule: "maxLength", message: "max 50 characters" }] });
    }
    const tag = ctx.c.req.query("tag_id");
    const membership = parseEnumParam("membership", ctx.c.req.query("membership"), ["all", "joined", "not_joined"] as const);
    return {
      body: withOpaqueCursor(await kit.call(ctx, "api_list_guilds", [
        q ?? null, tag ? parseUuidParam("tag_id", tag) : null, membership ?? "all",
        cursor(ctx.c.req.query("cursor")), limit(ctx.c.req.query("limit")),
      ])),
    };
  }));
  v1.get("/guilds/:guild_id", kit.route({}, async (ctx) => ({
    body: await kit.call(ctx, "api_guild_detail", [parseUuidParam("guild_id", ctx.c.req.param("guild_id"))]),
  })));
  v1.post("/guilds/:guild_id/join", kit.route({ rateScope: "guild_join", idempotent: true }, async (ctx) => {
    const res = await kit.call<J>(ctx, "api_join_guild", [parseUuidParam("guild_id", ctx.c.req.param("guild_id"))]);
    return { status: res.already_member ? 200 : 201, body: res };
  }));
  v1.get("/guilds/:guild_id/members", kit.route({}, async (ctx) => ({
    body: withOpaqueCursor(await kit.call(ctx, "api_guild_members", [
      parseUuidParam("guild_id", ctx.c.req.param("guild_id")), cursor(ctx.c.req.query("cursor")), limit(ctx.c.req.query("limit")),
    ])),
  })));
  v1.get("/guilds/:guild_id/announcements", kit.route({}, async (ctx) => ({
    body: withOpaqueCursor(await kit.call(ctx, "api_guild_announcements", [
      parseUuidParam("guild_id", ctx.c.req.param("guild_id")), cursor(ctx.c.req.query("cursor")), limit(ctx.c.req.query("limit")),
    ])),
  })));
  v1.get("/me/guild-memberships", kit.route({}, async (ctx) => ({ body: await kit.call(ctx, "api_my_memberships") })));

  // ------------------------------------------------------------------ conversations
  v1.get("/conversations", kit.route({}, async (ctx) => {
    const kind = parseEnumParam("kind", ctx.c.req.query("kind"), ["guild", "dm"] as const);
    return {
      body: withOpaqueCursor(await kit.call(ctx, "api_list_conversations", [kind, cursor(ctx.c.req.query("cursor")), limit(ctx.c.req.query("limit"))])),
    };
  }));
  v1.get("/conversations/:conversation_id", kit.route({}, async (ctx) => ({
    body: await kit.call(ctx, "api_get_conversation", [parseUuidParam("conversation_id", ctx.c.req.param("conversation_id"))]),
  })));
  v1.get("/conversations/:conversation_id/messages", kit.route({}, async (ctx) => {
    const before = parseIntParam("before_seq", ctx.c.req.query("before_seq"), 1, Number.MAX_SAFE_INTEGER);
    const after = parseIntParam("after_seq", ctx.c.req.query("after_seq"), 0, Number.MAX_SAFE_INTEGER);
    if (before !== null && after !== null) {
      throw new ApiError("VALIDATION_ERROR", { fields: [{ path: "/", rule: "oneOf", message: "use before_seq or after_seq, not both" }] });
    }
    return {
      body: await kit.call(ctx, "api_list_messages", [
        parseUuidParam("conversation_id", ctx.c.req.param("conversation_id")), before, after,
        parseIntParam("limit", ctx.c.req.query("limit"), 1, 100) ?? 50,
      ]),
    };
  }));
  v1.post("/conversations/:conversation_id/messages", kit.route({ rateScope: "message_send", bodySchema: "SendMessageRequest", idempotent: true }, async (ctx) => {
    const conv = parseUuidParam("conversation_id", ctx.c.req.param("conversation_id"));
    const b = ctx.body as { client_message_id: string; kind: "text" | "image"; text?: string; attachment_id?: string };
    const text = b.text === undefined ? null : cleanUserText(b.text);
    if (b.kind === "image" && b.attachment_id) await verifyAttachment(deps, kit, ctx, conv, b.attachment_id);
    const res = await kit.call<{ replay: boolean; message: J }>(ctx, "api_send_message", [
      conv, b.client_message_id, b.kind, text, b.attachment_id ?? null,
    ]);
    return { status: res.replay ? 200 : 201, body: res.message };
  }));
  v1.post("/conversations/:conversation_id/read", kit.route({ bodySchema: "ReadMarkerRequest" }, async (ctx) => ({
    body: await kit.call(ctx, "api_mark_read", [
      parseUuidParam("conversation_id", ctx.c.req.param("conversation_id")), (ctx.body as { last_read_seq: number }).last_read_seq,
    ]),
  })));
  v1.post("/dm-threads", kit.route({ rateScope: "dm_open", bodySchema: "OpenDmRequest", idempotent: true }, async (ctx) => {
    const res = await kit.call<{ created: boolean; conversation: J }>(ctx, "api_open_dm", [(ctx.body as { peer_user_id: string }).peer_user_id]);
    return { status: res.created ? 201 : 200, body: res.conversation };
  }));

  // ------------------------------------------------------------------ attachments
  v1.post("/attachments/upload-url", kit.route({ rateScope: "upload_url", bodySchema: "UploadUrlRequest", idempotent: true }, async (ctx) => {
    const b = ctx.body as { conversation_id: string; mime_type: string; byte_size: number };
    const slot = await kit.call<{ attachment_id: string; bucket: string; object_path: string; mime_type: string; max_bytes: number; ttl_seconds: number }>(
      ctx, "api_create_upload_slot", [b.conversation_id, b.mime_type, b.byte_size]);
    const up = await deps.storage.createSignedUploadUrl(slot.bucket, slot.object_path, slot.mime_type, slot.ttl_seconds);
    return {
      status: 201,
      body: {
        attachment_id: slot.attachment_id,
        max_bytes: slot.max_bytes,
        upload: { method: "PUT", url: up.url, headers: up.headers, expires_at: up.expiresAt.toISOString() },
      },
    };
  }));
  v1.get("/attachments/:attachment_id/download-url", kit.route({}, async (ctx) => {
    const a = await kit.call<{ attachment_id: string; bucket: string; object_path: string; mime_type: string; byte_size: number; ttl_seconds: number }>(
      ctx, "api_attachment_download", [parseUuidParam("attachment_id", ctx.c.req.param("attachment_id"))]);
    const signed = (await deps.storage.createSignedUrls(a.bucket, [a.object_path], a.ttl_seconds)).get(a.object_path);
    if (!signed) throw new ApiError("ATTACHMENT_NOT_FOUND");
    return { body: { attachment_id: a.attachment_id, url: signed.url, expires_at: signed.expiresAt.toISOString(), mime_type: a.mime_type, byte_size: a.byte_size } };
  }));

  // ------------------------------------------------------------------ reactions
  v1.post("/reactions", kit.route({ rateScope: "reaction", bodySchema: "ReactionRequest", idempotent: true }, async (ctx) => {
    const b = ctx.body as { target_type: string; target_id: string };
    return { status: 201, body: await kit.call(ctx, "api_give_reaction", [b.target_type, b.target_id]) };
  }));

  // ------------------------------------------------------------------ notifications
  v1.get("/notifications", kit.route({}, async (ctx) => {
    const unread = parseEnumParam("unread_only", ctx.c.req.query("unread_only"), ["true", "false"] as const) === "true";
    return {
      body: withOpaqueCursor(await kit.call(ctx, "api_list_notifications", [unread, cursor(ctx.c.req.query("cursor")), limit(ctx.c.req.query("limit"))])),
    };
  }));
  v1.post("/notifications/read", kit.route({ bodySchema: "MarkNotificationsReadRequest" }, async (ctx) => {
    const b = ctx.body as { notification_ids?: string[]; all?: boolean };
    return { body: await kit.call(ctx, "api_mark_notifications_read", [b.notification_ids ?? null, b.all ?? false]) };
  }));

  // ------------------------------------------------------------------ navigator
  v1.get("/navigator/messages", kit.route({}, async (ctx) => ({
    body: withOpaqueCursor(await kit.call(ctx, "api_navigator_history", [cursor(ctx.c.req.query("cursor")), limit(ctx.c.req.query("limit"))])),
  })));
  v1.post("/navigator/messages", kit.route({ bodySchema: "NavigatorSendRequest", idempotent: true }, async (ctx) => {
    const b = ctx.body as { client_message_id: string; text: string };
    return { body: await navigatorExchange(deps, kit, ctx, b.client_message_id, cleanUserText(b.text)) };
  }));

  // ------------------------------------------------------------------ safety
  v1.get("/blocks", kit.route({}, async (ctx) => ({
    body: withOpaqueCursor(await kit.call(ctx, "api_list_blocks", [cursor(ctx.c.req.query("cursor")), limit(ctx.c.req.query("limit"))])),
  })));
  v1.post("/blocks", kit.route({ rateScope: "block", bodySchema: "BlockRequest", idempotent: true }, async (ctx) => {
    const res = await kit.call<{ created: boolean; block: J }>(ctx, "api_block", [(ctx.body as { user_id: string }).user_id]);
    return { status: res.created ? 201 : 200, body: res.block };
  }));
  v1.delete("/blocks/:user_id", kit.route({ rateScope: "block" }, async (ctx) => {
    await kit.call(ctx, "api_unblock", [parseUuidParam("user_id", ctx.c.req.param("user_id"))]);
    return { status: 204 };
  }));
  v1.post("/reports", kit.route({ rateScope: "report", bodySchema: "ReportRequest", idempotent: true }, async (ctx) => {
    const b = ctx.body as { target_type: string; target_id: string; reason_code: string; comment?: string };
    return { status: 202, body: await kit.call(ctx, "api_create_report", [b.target_type, b.target_id, b.reason_code, b.comment ?? null]) };
  }));

  app.route("/v1", v1);
  app.route("/api/v1", v1); // Supabase Edge Functions receive /api/v1/... (function name prefix)
  return app;
}

// ---------------------------------------------------------------------------
// Attachment verification before an image message is sent: object exists, size
// within the limit, and the file signature matches the declared image type.
// ---------------------------------------------------------------------------
async function verifyAttachment(deps: Deps, kit: RouteKit, ctx: Parameters<Parameters<RouteKit["route"]>[1]>[0], conv: string, attachmentId: string) {
  const a = await kit.call<{ status: string; bucket: string; object_path: string; declared_mime: string; max_bytes: number; expired: boolean }>(
    ctx, "api_attachment_for_send", [attachmentId, conv]);
  if (a.status !== "pending") return; // ready/attached handled by api_send_message
  if (a.expired) throw new ApiError("ATTACHMENT_NOT_FOUND", { reason: "upload_slot_expired" });
  const stat = await statObject(deps.db, a.bucket, a.object_path);
  if (!stat) throw new ApiError("ATTACHMENT_NOT_UPLOADED");
  if (stat.size > a.max_bytes) {
    await deps.storage.remove(a.bucket, [a.object_path]);
    throw new ApiError("ATTACHMENT_TOO_LARGE", { max_bytes: a.max_bytes });
  }
  const bytes = await deps.storage.download(a.bucket, a.object_path);
  if (!bytes) throw new ApiError("ATTACHMENT_NOT_UPLOADED");
  const detected = sniffImageMime(bytes.subarray(0, 32));
  if (!mimeMatches(a.declared_mime, detected)) {
    await deps.storage.remove(a.bucket, [a.object_path]);
    throw new ApiError("ATTACHMENT_CONTENT_MISMATCH", { declared: a.declared_mime, detected });
  }
  await deps.db.callService(ctx.requestId, "svc_mark_attachment_ready", [attachmentId, detected, bytes.byteLength]);
}

// ---------------------------------------------------------------------------
// Navigator (N-1, N-2): consent + quota → moderation → store input → AI → store reply.
// AI failures produce the configured fallback message, never an error.
// ---------------------------------------------------------------------------
async function navigatorExchange(deps: Deps, kit: RouteKit, ctx: Parameters<Parameters<RouteKit["route"]>[1]>[0], clientMessageId: string, text: string) {
  const pre = await kit.call<{ replay: J | null }>(ctx, "api_navigator_precheck", [clientMessageId]);
  if (pre.replay) return pre.replay;

  const mod = await deps.ai.moderate({ userId: ctx.userId, requestId: ctx.requestId }, text);
  const moderation = mod ? { provider: deps.ai.provider.name, model: mod.model, flagged: mod.flagged, categories: mod.categories } : null;
  const begin = await kit.call<{ user_message_id: string; context: J }>(ctx, "api_navigator_begin", [clientMessageId, text, moderation]);

  const fallback = await kit.settings.get("navigator.fallback_message", "ごめんなさい、いまはうまく答えられませんでした。");
  let reply = fallback;
  let suggestions: string[] = await kit.settings.get("navigator.default_suggestions", []);
  let isFallback = true;
  let runId: string | null = null;
  let replyModeration: unknown = null;
  try {
    const r = await deps.ai.json<{ reply: string; suggestions: string[] }>({ userId: ctx.userId, requestId: ctx.requestId }, "navigator", {
      message: text, ...begin.context,
    });
    runId = r.runId;
    const out = cleanUserText(r.output.reply).slice(0, 400);
    const sugg = r.output.suggestions.map((s) => cleanUserText(s).slice(0, 30)).filter((s) => s.length > 0).slice(0, 3);
    const outMod = await deps.ai.moderate({ userId: ctx.userId, requestId: ctx.requestId }, out);
    replyModeration = outMod;
    if (out.length > 0 && !outMod?.flagged) {
      reply = out;
      suggestions = sugg;
      isFallback = false;
    }
  } catch (err) {
    console.warn(JSON.stringify({ level: "warn", msg: "navigator fallback", request_id: ctx.requestId, error: String((err as Error).message ?? err).slice(0, 200) }));
  }
  return await deps.db.callService(ctx.requestId, "svc_navigator_complete", [
    begin.user_message_id, reply, suggestions, isFallback, runId, replyModeration ?? null,
  ]);
}
