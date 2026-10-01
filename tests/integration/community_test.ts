// Guilds, conversations, messages (text/image), history/reconnect, read state,
// reactions → EXP → level → evolution image, notifications.
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { expectError, expectOk, FIXTURE, type Harness, itest } from "./harness.ts";

const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

async function guildConv(h: Harness, token: string, guildId: string) {
  const g = await h.api("GET", `/v1/guilds/${guildId}`, { token });
  expectOk(g, 200, "GuildDetail");
  return g.json.conversation_id as string;
}

itest("guild list, search, membership filter and detail (G-1, G-2)", async (h) => {
  const t = await h.token(FIXTURE.alice);
  const all = await h.api("GET", "/v1/guilds?limit=3", { token: t });
  expectOk(all, 200, "GuildPage");
  assertEquals(all.json.items.length, 3);
  assert(all.json.next_cursor);
  const page2 = await h.api("GET", `/v1/guilds?limit=3&cursor=${all.json.next_cursor}`, { token: t });
  expectOk(page2, 200, "GuildPage");
  const ids = [...all.json.items, ...page2.json.items].map((g: { id: string }) => g.id);
  assertEquals(new Set(ids).size, ids.length, "pages do not overlap");
  assert(!ids.includes(FIXTURE.draftGuild), "draft guild is not discoverable");

  const search = await h.api("GET", `/v1/guilds?q=${encodeURIComponent("ミステリー")}`, { token: t });
  expectOk(search, 200, "GuildPage");
  assertEquals(search.json.items.map((g: { name: string }) => g.name), ["ミステリー考察部"]);
  const byTag = await h.api("GET", `/v1/guilds?q=${encodeURIComponent("初心者")}`, { token: t });
  assert(byTag.json.items.length >= 2, "tag names are searchable");
  const none = await h.api("GET", `/v1/guilds?q=${encodeURIComponent("%_")}`, { token: t });
  expectOk(none, 200, "GuildPage");
  assertEquals(none.json.items, [], "LIKE wildcards are escaped; empty state");

  const mine = await h.api("GET", "/v1/guilds?membership=joined", { token: t });
  assertEquals(mine.json.items.length, 2);
  assert(mine.json.items.every((g: { is_member: boolean }) => g.is_member));
  const full = (await h.api("GET", `/v1/guilds/${FIXTURE.fullGuild}`, { token: t })).json;
  assertEquals([full.member_count, full.capacity, full.is_full, full.conversation_id], [10, 10, true, null]);
  expectError(await h.api("GET", `/v1/guilds/${FIXTURE.draftGuild}`, { token: t }), 404, "GUILD_NOT_FOUND");
});

itest("joining: no approval, full guild rejected, multiple guilds kept (G-3, G-5)", async (h) => {
  const t = await h.token(FIXTURE.dave);
  const j = await h.api("POST", `/v1/guilds/${FIXTURE.guild3}/join`, { token: t });
  expectOk(j, 201, "JoinGuildResult");
  assertEquals(j.json.membership.role, "member");
  const again = await h.api("POST", `/v1/guilds/${FIXTURE.guild3}/join`, { token: t });
  expectOk(again, 200, "JoinGuildResult");
  assertEquals(again.json.already_member, true);
  expectOk(await h.api("POST", `/v1/guilds/${FIXTURE.guild2}/join`, { token: t }), 201);
  const m = await h.api("GET", "/v1/me/guild-memberships", { token: t });
  expectOk(m, 200, "GuildMembershipList");
  assertEquals(m.json.items.length, 2);
  const full = await h.api("POST", `/v1/guilds/${FIXTURE.fullGuild}/join`, { token: t });
  expectError(full, 409, "GUILD_FULL");
  assertEquals(full.json.error.details, { capacity: 10, member_count: 10 });
  expectError(await h.api("POST", `/v1/guilds/${FIXTURE.draftGuild}/join`, { token: t }), 404, "GUILD_NOT_FOUND");
  // members & announcements are member-only
  expectOk(await h.api("GET", `/v1/guilds/${FIXTURE.guild3}/members?limit=5`, { token: t }), 200, "GuildMemberPage");
  expectOk(await h.api("GET", `/v1/guilds/${FIXTURE.guild3}/announcements`, { token: t }), 200, "AnnouncementPage");
  expectError(await h.api("GET", `/v1/guilds/${FIXTURE.guild1}/members`, { token: t }), 403, "NOT_A_MEMBER");
});

itest("guild chat: send, idempotent retry, history paging, catch-up after reconnect, unread", async (h) => {
  const ta = await h.token(FIXTURE.alice);
  const tb = await h.token(FIXTURE.bob);
  const conv = await guildConv(h, ta, FIXTURE.guild1);
  const before = await h.api("GET", `/v1/conversations/${conv}`, { token: tb });
  expectOk(before, 200, "Conversation");
  const lastSeen = before.json.latest_seq;
  await h.api("POST", `/v1/conversations/${conv}/read`, { token: tb, body: { last_read_seq: lastSeen } });

  // bob "disconnects"; alice sends 3 messages, retrying one of them
  const cmid = crypto.randomUUID();
  const m1 = await h.api("POST", `/v1/conversations/${conv}/messages`, { token: ta, body: { client_message_id: cmid, kind: "text", text: "再接続テスト1" } });
  expectOk(m1, 201, "Message");
  assertEquals(m1.json.client_message_id, cmid);
  assertEquals(m1.json.sender.user_id, FIXTURE.alice);
  const retry = await h.api("POST", `/v1/conversations/${conv}/messages`, { token: ta, body: { client_message_id: cmid, kind: "text", text: "再接続テスト1" } });
  expectOk(retry, 200, "Message");
  assertEquals(retry.json.id, m1.json.id);
  for (const n of [2, 3]) {
    expectOk(await h.api("POST", `/v1/conversations/${conv}/messages`, { token: ta, body: { client_message_id: crypto.randomUUID(), kind: "text", text: `再接続テスト${n}` } }), 201);
  }
  // reconnect: list conversations shows unread, then catch up with after_seq
  const list = await h.api("GET", "/v1/conversations?kind=guild", { token: tb });
  expectOk(list, 200, "ConversationPage");
  const c = list.json.items.find((x: { id: string }) => x.id === conv);
  assertEquals(c.unread_count, 3);
  assertEquals(c.realtime_topic, `conv:${conv}`);
  const catchup = await h.api("GET", `/v1/conversations/${conv}/messages?after_seq=${lastSeen}&limit=2`, { token: tb });
  expectOk(catchup, 200, "MessagePage");
  assertEquals(catchup.json.items.length, 2);
  assertEquals(catchup.json.has_more_newer, true);
  const rest = await h.api("GET", `/v1/conversations/${conv}/messages?after_seq=${catchup.json.items[1].seq}`, { token: tb });
  assertEquals(rest.json.items.map((m: { text: string }) => m.text), ["再接続テスト3"]);
  assertEquals(rest.json.has_more_newer, false);
  const seqs = [...catchup.json.items, ...rest.json.items].map((m: { seq: number }) => m.seq);
  assertEquals(seqs, [lastSeen + 1, lastSeen + 2, lastSeen + 3], "gap-free, ascending, no duplicates");

  // older history paging
  const newest = await h.api("GET", `/v1/conversations/${conv}/messages?limit=10`, { token: tb });
  expectOk(newest, 200, "MessagePage");
  assertEquals(newest.json.has_more_older, true);
  const older = await h.api("GET", `/v1/conversations/${conv}/messages?before_seq=${newest.json.items[0].seq}&limit=10`, { token: tb });
  assert(older.json.items.every((m: { seq: number }) => m.seq < newest.json.items[0].seq));
  expectError(await h.api("GET", `/v1/conversations/${conv}/messages?before_seq=5&after_seq=1`, { token: tb }), 400, "VALIDATION_ERROR");

  const read = await h.api("POST", `/v1/conversations/${conv}/read`, { token: tb, body: { last_read_seq: rest.json.latest_seq } });
  expectOk(read, 200, "ReadMarker");
  assertEquals(read.json.unread_count, 0);

  // non-members cannot read or write
  const td = await h.token(FIXTURE.noDiagnosis);
  expectError(await h.api("GET", `/v1/conversations/${conv}/messages`, { token: td }), 404, "CONVERSATION_NOT_FOUND");
  expectError(await h.api("POST", `/v1/conversations/${conv}/messages`, { token: td, body: { client_message_id: crypto.randomUUID(), kind: "text", text: "x" } }), 404, "CONVERSATION_NOT_FOUND");
  // realtime row was produced for the conversation topic (delivery itself is verified by tests/realtime)
  const rt = await h.sql`select count(*)::int as n from realtime.messages where topic = ${`conv:${conv}`} and payload ->> 'type' = 'message.created' and payload -> 'data' ->> 'id' = ${m1.json.id}`;
  assertEquals(rt[0].n, 1);
});

itest("image messages: signed upload, verification, member-only signed download", async (h) => {
  const ta = await h.token(FIXTURE.alice);
  const conv = await guildConv(h, ta, FIXTURE.guild1);
  const slot = await h.api("POST", "/v1/attachments/upload-url", { token: ta, body: { conversation_id: conv, mime_type: "image/png", byte_size: PNG.byteLength } });
  expectOk(slot, 201, "UploadUrl");
  const up = await fetch(slot.json.upload.url, { method: "PUT", headers: slot.json.upload.headers, body: PNG });
  assertEquals(up.status, 200, await up.text());
  // the same signed upload URL cannot overwrite the object
  const again = await fetch(slot.json.upload.url, { method: "PUT", headers: slot.json.upload.headers, body: PNG });
  assertEquals(again.status, 409);
  await again.body?.cancel();

  const msg = await h.api("POST", `/v1/conversations/${conv}/messages`, { token: ta, body: { client_message_id: crypto.randomUUID(), kind: "image", attachment_id: slot.json.attachment_id } });
  expectOk(msg, 201, "Message");
  assertEquals(msg.json.attachment.mime_type, "image/png");
  const dl = await fetch(msg.json.attachment.url);
  assertEquals(new Uint8Array(await dl.arrayBuffer()), PNG);
  expectError(await h.api("POST", `/v1/conversations/${conv}/messages`, { token: ta, body: { client_message_id: crypto.randomUUID(), kind: "image", attachment_id: slot.json.attachment_id } }), 409, "ATTACHMENT_ALREADY_USED");

  const tb = await h.token(FIXTURE.bob);
  const d = await h.api("GET", `/v1/attachments/${slot.json.attachment_id}/download-url`, { token: tb });
  expectOk(d, 200, "DownloadUrl");
  assertEquals((await fetch(d.json.url)).status, 200);
  const outsider = await h.token(FIXTURE.dave);
  expectError(await h.api("GET", `/v1/attachments/${slot.json.attachment_id}/download-url`, { token: outsider }), 404, "ATTACHMENT_NOT_FOUND");
  // tampered or expired signatures are refused by storage
  const tampered = d.json.url.replace(/sig=[0-9a-f]{4}/, "sig=0000");
  assertEquals((await fetch(tampered)).status, 403);
  // a modified expiry invalidates the signature; a genuinely expired URL is refused as expired
  assertEquals((await fetch(d.json.url.replace(/exp=\d+/, "exp=1000"))).status, 403);
  const [{ object_path }] = await h.sql`select object_path from app.message_attachments where id = ${slot.json.attachment_id}`;
  const short = (await h.deps.storage.createSignedUrls("chat-attachments", [object_path], 1)).get(object_path)!;
  await new Promise((r) => setTimeout(r, 2100));
  const exp = await fetch(short.url);
  assertEquals(exp.status, 400);
  await exp.body?.cancel();
});

itest("image upload rejections: MIME, size, fake content, missing upload, other users' uploads", async (h) => {
  const ta = await h.token(FIXTURE.alice);
  const conv = await guildConv(h, ta, FIXTURE.guild1);
  expectError(await h.api("POST", "/v1/attachments/upload-url", { token: ta, body: { conversation_id: conv, mime_type: "image/gif", byte_size: 10 } }), 415, "ATTACHMENT_TYPE_NOT_ALLOWED");
  expectError(await h.api("POST", "/v1/attachments/upload-url", { token: ta, body: { conversation_id: conv, mime_type: "image/png", byte_size: 50_000_000 } }), 413, "ATTACHMENT_TOO_LARGE");

  // declared PNG, uploaded bytes are not an image
  const s1 = await h.api("POST", "/v1/attachments/upload-url", { token: ta, body: { conversation_id: conv, mime_type: "image/png", byte_size: 9 } });
  await (await fetch(s1.json.upload.url, { method: "PUT", headers: s1.json.upload.headers, body: new TextEncoder().encode("<script>x") })).body?.cancel();
  expectError(await h.api("POST", `/v1/conversations/${conv}/messages`, { token: ta, body: { client_message_id: crypto.randomUUID(), kind: "image", attachment_id: s1.json.attachment_id } }), 422, "ATTACHMENT_CONTENT_MISMATCH");

  // storage enforces the bucket limit even if the client lied about the size
  const s2 = await h.api("POST", "/v1/attachments/upload-url", { token: ta, body: { conversation_id: conv, mime_type: "image/png", byte_size: 100 } });
  const big = new Uint8Array(10_485_761);
  big.set(PNG);
  const r2 = await fetch(s2.json.upload.url, { method: "PUT", headers: s2.json.upload.headers, body: big });
  assertEquals(r2.status, 413);
  await r2.body?.cancel();
  expectError(await h.api("POST", `/v1/conversations/${conv}/messages`, { token: ta, body: { client_message_id: crypto.randomUUID(), kind: "image", attachment_id: s2.json.attachment_id } }), 409, "ATTACHMENT_NOT_UPLOADED");

  // wrong Content-Type on upload is refused by storage
  const s3 = await h.api("POST", "/v1/attachments/upload-url", { token: ta, body: { conversation_id: conv, mime_type: "image/png", byte_size: PNG.byteLength } });
  const r3 = await fetch(s3.json.upload.url, { method: "PUT", headers: { "content-type": "text/html" }, body: PNG });
  assertEquals(r3.status, 415);
  await r3.body?.cancel();

  // someone else's attachment cannot be referenced
  const tb = await h.token(FIXTURE.bob);
  expectError(await h.api("POST", `/v1/conversations/${conv}/messages`, { token: tb, body: { client_message_id: crypto.randomUUID(), kind: "image", attachment_id: s3.json.attachment_id } }), 404, "ATTACHMENT_NOT_FOUND");

  // expired upload slot
  await h.sql`update app.message_attachments set created_at = now() - interval '1 hour' where id = ${s3.json.attachment_id}`;
  expectError(await h.api("POST", `/v1/conversations/${conv}/messages`, { token: ta, body: { client_message_id: crypto.randomUUID(), kind: "image", attachment_id: s3.json.attachment_id } }), 404, "ATTACHMENT_NOT_FOUND");

  // orphan cleanup removes stale, unattached uploads
  await h.sql`update app.message_attachments set created_at = now() - interval '2 days' where id = ${s1.json.attachment_id}`;
  const m = await h.maintenance();
  assert(Number(m.orphan_attachments) >= 1);
  const [{ status }] = await h.sql`select status from app.message_attachments where id = ${s1.json.attachment_id}`;
  assertEquals(status, "deleted");
});

itest("DMs: open/reuse, unread badge, blocked threads stay readable but cannot send (C-4, S-2)", async (h) => {
  const ta = await h.token(FIXTURE.alice);
  const tb = await h.token(FIXTURE.bob);
  const dm = await h.api("POST", "/v1/dm-threads", { token: ta, body: { peer_user_id: FIXTURE.bob } });
  expectOk(dm, 200, "Conversation"); // seeded thread is reused
  assertEquals(dm.json.peer.user_id, FIXTURE.bob);
  expectOk(await h.api("POST", `/v1/conversations/${dm.json.id}/messages`, { token: ta, body: { client_message_id: crypto.randomUUID(), kind: "text", text: "元気？" } }), 201);
  const bobList = await h.api("GET", "/v1/conversations?kind=dm", { token: tb });
  const thread = bobList.json.items.find((c: { id: string }) => c.id === dm.json.id);
  assert(thread.unread_count >= 1);
  assertEquals(thread.last_message.text, "元気？");
  const notes = await h.api("GET", "/v1/notifications?unread_only=true", { token: tb });
  expectOk(notes, 200, "NotificationPage");
  assert(notes.json.items.some((n: { type: string; data: { conversation_id: string } }) => n.type === "dm_received" && n.data.conversation_id === dm.json.id));

  // alice blocked erin (seed): thread readable, sending refused in both directions
  const te = await h.token(FIXTURE.erin);
  const blocked = await h.api("POST", "/v1/dm-threads", { token: te, body: { peer_user_id: FIXTURE.alice } });
  expectOk(blocked, 200, "Conversation");
  assertEquals([blocked.json.can_send, blocked.json.cannot_send_reason], [false, "blocked"]);
  expectOk(await h.api("GET", `/v1/conversations/${blocked.json.id}/messages`, { token: te }), 200, "MessagePage");
  expectError(await h.api("POST", `/v1/conversations/${blocked.json.id}/messages`, { token: te, body: { client_message_id: crypto.randomUUID(), kind: "text", text: "x" } }), 403, "BLOCKED");
  expectError(await h.api("POST", `/v1/conversations/${blocked.json.id}/messages`, { token: ta, body: { client_message_id: crypto.randomUUID(), kind: "text", text: "x" } }), 403, "BLOCKED");
  // frank blocked alice: no new thread either way
  expectError(await h.api("POST", "/v1/dm-threads", { token: ta, body: { peer_user_id: FIXTURE.frank } }), 403, "BLOCKED");
  expectError(await h.api("POST", "/v1/dm-threads", { token: ta, body: { peer_user_id: FIXTURE.alice } }), 400, "CANNOT_MESSAGE_SELF");
  expectError(await h.api("POST", "/v1/dm-threads", { token: ta, body: { peer_user_id: crypto.randomUUID() } }), 404, "USER_NOT_FOUND");
});

itest("グッと → EXP → Lv5 → one evolution image job → new current image (L-1…L-5)", async (h) => {
  const ta = await h.token(FIXTURE.alice);
  const tb = await h.token(FIXTURE.bob);
  const growth0 = await h.api("GET", "/v1/me/growth", { token: ta });
  expectOk(growth0, 200, "Growth");
  assertEquals([growth0.json.level, growth0.json.total_exp, growth0.json.exp_to_next_level, growth0.json.next_evolution_level], [4, 270, 10, 5]);
  const char0 = (await h.api("GET", "/v1/me/character", { token: ta })).json;

  const conv = await guildConv(h, ta, FIXTURE.guild1);
  const msg = await h.api("POST", `/v1/conversations/${conv}/messages`, { token: ta, body: { client_message_id: crypto.randomUUID(), kind: "text", text: "グッとください" } });
  const r = await h.api("POST", "/v1/reactions", { token: tb, body: { target_type: "message", target_id: msg.json.id } });
  expectOk(r, 201, "ReactionResult");
  assertEquals(r.json.reaction_count, 1);
  const dup = await h.api("POST", "/v1/reactions", { token: tb, body: { target_type: "message", target_id: msg.json.id } });
  expectError(dup, 409, "ALREADY_REACTED");
  assertEquals(dup.json.error.details.reaction_count, 1);
  expectError(await h.api("POST", "/v1/reactions", { token: ta, body: { target_type: "message", target_id: msg.json.id } }), 400, "CANNOT_REACT_TO_SELF");
  expectError(await h.api("POST", "/v1/reactions", { token: tb, body: { target_type: "message", target_id: crypto.randomUUID() } }), 404, "REACTION_TARGET_NOT_FOUND");

  const growth1 = (await h.api("GET", "/v1/me/growth", { token: ta })).json;
  assertEquals([growth1.level, growth1.total_exp, growth1.gut_points >= 1, growth1.image_status], [5, 280, true, "ready"]);
  assertEquals(growth1.next_evolution_level, 10);

  const received = await h.api("GET", "/v1/me/reactions/received?limit=5", { token: ta });
  expectOk(received, 200, "ReceivedReactionPage");
  assertEquals(received.json.items[0].giver.user_id, FIXTURE.bob);

  const [{ jobs }] = await h.sql`select count(*)::int as jobs from app.ai_jobs where user_id = ${FIXTURE.alice} and kind = 'evolution_image'`;
  assertEquals(jobs, 1);
  await h.worker();
  const char1 = (await h.api("GET", "/v1/me/character", { token: ta })).json;
  assertEquals([char1.image.status, char1.image.stage_level, char1.level], ["ready", 5, 5]);
  assertNotEquals(char1.image.url?.split("?")[0], char0.image.url?.split("?")[0], "current image replaced");
  assertEquals(char1.character_id, char0.character_id);
  const objs = await h.sql`select name from storage.objects where bucket_id = 'avatars' and name like ${`${FIXTURE.alice}/%`}`;
  assertEquals(objs.length, 1, "only the current image is retained");

  const notes = await h.api("GET", "/v1/notifications?limit=50", { token: ta });
  const types = notes.json.items.map((n: { type: string }) => n.type);
  assert(types.includes("reaction_received") && types.includes("level_up") && types.includes("character_evolved"), types.join());
  const markAll = await h.api("POST", "/v1/notifications/read", { token: ta, body: { all: true } });
  expectOk(markAll, 200, "MarkNotificationsReadResult");
  assertEquals(markAll.json.unread_count, 0);
  expectError(await h.api("POST", "/v1/notifications/read", { token: ta, body: {} }), 400, "VALIDATION_ERROR");
});

itest("message pagination across the retention window (C-5)", async (h) => {
  await h.sql`update app.app_settings set value = '5' where key = 'chat.history.guild_max_messages'`;
  try {
    const t = await h.token(FIXTURE.carol);
    const conv = await guildConv(h, t, FIXTURE.guild2);
    const page = await h.api("GET", `/v1/conversations/${conv}/messages?limit=100`, { token: t });
    expectOk(page, 200, "MessagePage");
    assertEquals(page.json.items.length, 5);
    assertEquals(page.json.has_more_older, false, "nothing older than the retention window is returned");
  } finally {
    await h.sql`update app.app_settings set value = '1000' where key = 'chat.history.guild_max_messages'`;
  }
});
