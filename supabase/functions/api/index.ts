// Edge Function：api（アプリ API）。Unity は /functions/v1/api/v1/* と /auth/v1/* だけを呼ぶ（基盤02）
import { app } from "./app.ts";

Deno.serve(app.fetch);
