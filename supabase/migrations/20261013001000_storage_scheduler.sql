-- =============================================================================
-- 1000 Storage（非公開バケット）と定期ジョブ（pg_cron）
-- =============================================================================

-- 非公開バケット。アプリには API が発行する期限付き署名 URL（1時間）だけを渡す（基盤02）
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('character-images', 'character-images', false, 5242880, array['image/png', 'image/jpeg']),
  -- メッセージ画像（第2段階 P2-5）。形式・容量は U-13 の仮置き
  ('message-images', 'message-images', false, 5242880, array['image/png', 'image/jpeg'])
on conflict (id) do nothing;

-- 定期ジョブ：停滞ジョブの failed 化、期限切れ冪等キーの削除、退会者データの物理削除、worker の起動
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net with schema extensions;
  end if;
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('conime-maintenance', '* * * * *', 'select private.run_maintenance()');
    perform cron.schedule('conime-kick-worker', '* * * * *', 'select private.kick_worker()');
  end if;
end $$;
