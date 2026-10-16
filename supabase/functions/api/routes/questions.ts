import { Hono } from "../../_shared/deps.ts";
import { ApiError } from "../../_shared/errors.ts";
import { ok, sha256Hex } from "../../_shared/http.ts";
import { type AppEnv, iso, publicTx } from "../context.ts";

export const questions = new Hono<AppEnv>();

// GET /question-sets/current：公開中の質問定義（Q-1・Q-6・API06）。ETag / If-None-Match で 304
questions.get("/question-sets/current", async (c) => {
  const body = await publicTx(async (tx) => {
    const [set] = await tx`
      select id, version, published_at from public.question_sets where status = 'published' limit 1`;
    if (!set) throw new ApiError("NOT_FOUND", "no published question set");
    const rows = await tx`
      select q.id, q.code, q.sort_order, q.title, q.answer_type, q.is_required, q.constraints, q.usages,
             coalesce(
               json_agg(json_build_object('code', o.code, 'label', o.label) order by o.sort_order)
                 filter (where o.id is not null),
               '[]'::json
             ) as options
      from public.questions q
      left join public.question_options o on o.question_id = q.id
      where q.question_set_id = ${set.id}
      group by q.id
      order by q.sort_order`;
    return ok({
      question_set: { id: set.id, version: set.version, published_at: iso(set.published_at) },
      questions: rows.map((q) => ({
        id: q.id,
        code: q.code,
        order: q.sort_order,
        title: q.title,
        answer_type: q.answer_type,
        required: q.is_required,
        constraints: q.constraints,
        usages: q.usages,
        options: q.options,
      })),
    });
  });

  const etag = `W/"${(await sha256Hex(JSON.stringify(body))).slice(0, 32)}"`;
  c.header("ETag", etag);
  c.header("Cache-Control", "no-cache");
  const inm = c.req.header("If-None-Match");
  if (inm && inm.split(",").map((t) => t.trim()).some((t) => t === etag || t === "*" || `W/${t}` === etag)) {
    return c.body(null, 304);
  }
  return c.json(body);
});
