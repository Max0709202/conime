import { Hono, z } from "../../_shared/deps.ts";
import { ApiError } from "../../_shared/errors.ts";
import { ok } from "../../_shared/http.ts";
import { charLength } from "../../_shared/validation.ts";
import { kickWorker } from "../../_shared/worker_client.ts";
import { type AppEnv, getSetting, memberTx, parseBody, requireUser } from "../context.ts";
import { characterDetail, characterImage } from "./serializers.ts";

export const character = new Hono<AppEnv>();

// GET /me/character：マイキャラ詳細（診断前は 404）
character.get("/me/character", async (c) => {
  const data = await memberTx(c, async (tx, user) => {
    const [ch] = await tx`select * from public.characters where user_id = ${user.userId}`;
    if (!ch) throw new ApiError("NOT_FOUND", "character not found");
    return characterDetail(ch, await getSetting(tx, "growth.max_level", 100));
  });
  return c.json(ok(data));
});

// name 以外の項目（public_code・level 等）は受け取っても無視する（Q-4：キャラIDは変更不可）
const RenameRequest = z.object({ name: z.string() });
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

// PATCH /me/character：キャラ名の変更（1〜20文字・U-07）
character.patch("/me/character", async (c) => {
  await requireUser(c); // 認証エラー（401）を入力検証（400）より先に返す
  const body = await parseBody(c, RenameRequest);
  const name = body.name.trim();
  const data = await memberTx(c, async (tx, user) => {
    const max = await getSetting(tx, "character.name_max_length", 20);
    if (charLength(name) < 1) throw new ApiError("VALIDATION_ERROR", "name is required", [{ field: "name", reason: "required" }]);
    if (charLength(name) > max) {
      throw new ApiError("VALIDATION_ERROR", `name exceeds ${max} characters`, [{ field: "name", reason: "max_length", limit: max }]);
    }
    if (CONTROL.test(name)) {
      throw new ApiError("VALIDATION_ERROR", "name contains control characters", [{ field: "name", reason: "invalid_characters" }]);
    }
    // RLS と列権限により、アプリから更新できるのは本人の name のみ
    const [ch] = await tx`update public.characters set name = ${name} where user_id = ${user.userId} returning *`;
    if (!ch) throw new ApiError("NOT_FOUND", "character not found");
    return characterDetail(ch, await getSetting(tx, "growth.max_level", 100));
  });
  return c.json(ok(data));
});

// GET /me/character/image：現在画像と処理状態（L-3・設計04）
character.get("/me/character/image", async (c) => {
  const data = await memberTx(c, async (tx, user) => {
    const [ch] = await tx`select image_path, image_status, image_stage from public.characters where user_id = ${user.userId}`;
    if (!ch) throw new ApiError("NOT_FOUND", "character not found");
    return characterImage(ch);
  });
  if (data.status === "generating") kickWorker();
  return c.json(ok(data));
});
