-- =============================================================================
-- 0800 ロールと Row Level Security（認証03）
--   全テーブルで RLS を有効化し、テーブル権限は必要最小限だけ付与する。
--   書き込みは原則 API 内の関数（private スキーマ）経由。
--   【全】anon + authenticated / 【会員】authenticated / 【本人】auth.uid() が当該行のユーザー
--   service_role は RLS をバイパス（Edge Function 内部のみ）
-- =============================================================================

-- ---------------------------------------------------------------- RLS 共通関数
create or replace function private.is_admin()
returns boolean
language sql
stable
set search_path = ''
as $$
  -- Auth の app_metadata.role = admin
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false)
$$;

create or replace function private.is_guild_member(p_guild_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.guild_members m
    where m.guild_id = p_guild_id and m.user_id = (select auth.uid())
  )
$$;

-- a と b のどちらか一方がもう一方をブロックしているか（ブロックは相互に表示を制限する・U-14）
create or replace function private.is_blocked(p_a uuid, p_b uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.blocks b
    where (b.blocker_id = p_a and b.blocked_id = p_b)
       or (b.blocker_id = p_b and b.blocked_id = p_a)
  )
$$;

create or replace function private.can_access_conversation(p_conversation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.conversations c
    where c.id = p_conversation_id
      and (
        (c.kind = 'guild' and private.is_guild_member(c.guild_id))
        or (c.kind = 'navigator' and c.owner_id = (select auth.uid()))
        or (
          c.kind = 'dm'
          and exists (
            select 1 from public.conversation_members m
            where m.conversation_id = c.id and m.user_id = (select auth.uid())
          )
          and not exists (
            select 1 from public.conversation_members o
            where o.conversation_id = c.id
              and o.user_id <> (select auth.uid())
              and private.is_blocked((select auth.uid()), o.user_id)
          )
        )
      )
  )
$$;

grant execute on function
  private.is_admin(),
  private.is_guild_member(uuid),
  private.is_blocked(uuid, uuid),
  private.can_access_conversation(uuid)
to anon, authenticated, service_role;

-- ---------------------------------------------------------------- RLS 有効化（全33テーブル）
do $$
declare
  t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
end $$;

-- ---------------------------------------------------------------- テーブル権限
revoke all on all tables in schema public from anon, authenticated;
grant all on all tables in schema public to service_role;

-- 【全】未ログインを含む
grant select on public.question_sets, public.questions, public.question_options, public.consent_documents
  to anon, authenticated;

-- 【会員】参照
grant select on
  public.profiles, public.user_consents, public.account_deletion_requests,
  public.diagnosis_submissions, public.diagnosis_answers, public.answer_entities,
  public.works, public.anime_characters, public.tags, public.work_tags,
  public.ai_profiles, public.characters, public.generation_jobs, public.exp_events, public.level_thresholds,
  public.goodtos,
  public.guilds, public.guild_tags, public.guild_members, public.guild_announcements,
  public.conversations, public.conversation_members, public.messages,
  public.recommendations, public.notifications, public.reports, public.blocks,
  public.app_settings, public.idempotency_keys
to authenticated;

-- 【本人】許可された列だけ更新できる（EXP・レベル等の計算値は更新権限を付与しない：L-1・L-5）
grant update (display_name) on public.profiles to authenticated;
grant update (name) on public.characters to authenticated;
grant update (last_read_at) on public.conversation_members to authenticated;
grant update (read_at) on public.notifications to authenticated;
grant insert (user_id, document_id, decision, app_version) on public.user_consents to authenticated;
grant insert (reporter_id, target_type, target_id, reason_code, detail) on public.reports to authenticated;
grant insert (blocker_id, blocked_id), delete on public.blocks to authenticated;

-- admin（運営）：ギルド・お知らせ・質問セット・同意文書の登録（当面は Supabase Studio）
grant insert, update, delete on
  public.question_sets, public.questions, public.question_options, public.consent_documents,
  public.guilds, public.guild_tags, public.guild_announcements
to authenticated;

-- ---------------------------------------------------------------- 診断定義・同意文書【全】
create policy question_sets_select on public.question_sets for select to anon, authenticated
  using (status = 'published' or (select private.is_admin()));
create policy questions_select on public.questions for select to anon, authenticated
  using (
    exists (select 1 from public.question_sets s where s.id = question_set_id and s.status = 'published')
    or (select private.is_admin())
  );
create policy question_options_select on public.question_options for select to anon, authenticated
  using (
    exists (
      select 1 from public.questions q join public.question_sets s on s.id = q.question_set_id
      where q.id = question_id and s.status = 'published'
    )
    or (select private.is_admin())
  );
create policy consent_documents_select on public.consent_documents for select to anon, authenticated
  using (is_current or (select private.is_admin()));

create policy question_sets_admin on public.question_sets for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy questions_admin on public.questions for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy question_options_admin on public.question_options for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy consent_documents_admin on public.consent_documents for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

-- ---------------------------------------------------------------- アカウント・同意【本人】
create policy profiles_select_own on public.profiles for select to authenticated
  using (user_id = (select auth.uid()));
create policy profiles_update_own on public.profiles for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy user_consents_select_own on public.user_consents for select to authenticated
  using (user_id = (select auth.uid()));
-- 同意できるのは最新の有効版のみ
create policy user_consents_insert_own on public.user_consents for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.consent_documents d where d.id = document_id and d.is_current)
  );

create policy account_deletion_requests_select_own on public.account_deletion_requests for select to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------- 診断・生成【本人】書き込みは API の関数のみ
create policy diagnosis_submissions_select_own on public.diagnosis_submissions for select to authenticated
  using (user_id = (select auth.uid()));
create policy diagnosis_answers_select_own on public.diagnosis_answers for select to authenticated
  using (user_id = (select auth.uid()));
create policy answer_entities_select_own on public.answer_entities for select to authenticated
  using (user_id = (select auth.uid()));
create policy ai_profiles_select_own on public.ai_profiles for select to authenticated
  using (user_id = (select auth.uid()));

create policy characters_select_own on public.characters for select to authenticated
  using (user_id = (select auth.uid()));
create policy characters_update_own on public.characters for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy generation_jobs_select_own on public.generation_jobs for select to authenticated
  using (user_id = (select auth.uid()));
create policy exp_events_select_own on public.exp_events for select to authenticated
  using (user_id = (select auth.uid()));
create policy idempotency_keys_select_own on public.idempotency_keys for select to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------- マスタ・設定【会員】
create policy works_select on public.works for select to authenticated
  using (is_active or (select private.is_admin()));
create policy anime_characters_select on public.anime_characters for select to authenticated using (true);
create policy tags_select on public.tags for select to authenticated using (true);
create policy work_tags_select on public.work_tags for select to authenticated using (true);
create policy level_thresholds_select on public.level_thresholds for select to authenticated using (true);
-- 設定は公開キーのみ（配点 matching.* 等は非公開）
create policy app_settings_select_public on public.app_settings for select to authenticated
  using (split_part(key, '.', 1) in ('diagnosis', 'character', 'guild', 'history', 'navigator', 'growth', 'recommendation'));

-- ---------------------------------------------------------------- グッと【会員】贈り主または受取人
create policy goodtos_select_party on public.goodtos for select to authenticated
  using (giver_id = (select auth.uid()) or receiver_id = (select auth.uid()));

-- ---------------------------------------------------------------- ギルド【会員】published のみ
create policy guilds_select on public.guilds for select to authenticated
  using (status = 'published' or (select private.is_admin()));
create policy guild_tags_select on public.guild_tags for select to authenticated
  using (exists (select 1 from public.guilds g where g.id = guild_id and (g.status = 'published' or (select private.is_admin()))));
create policy guild_announcements_select on public.guild_announcements for select to authenticated
  using (exists (select 1 from public.guilds g where g.id = guild_id and (g.status = 'published' or (select private.is_admin()))));

create policy guilds_admin on public.guilds for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy guild_tags_admin on public.guild_tags for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy guild_announcements_admin on public.guild_announcements for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

-- 同じギルドのメンバーと本人の所属（参加は参加関数のみ）
create policy guild_members_select on public.guild_members for select to authenticated
  using (user_id = (select auth.uid()) or private.is_guild_member(guild_id));

-- ---------------------------------------------------------------- 会話・メッセージ【会員】参加者のみ（ブロック除外）
create policy conversations_select on public.conversations for select to authenticated
  using (private.can_access_conversation(id));
create policy conversation_members_select on public.conversation_members for select to authenticated
  using (private.can_access_conversation(conversation_id));
create policy conversation_members_update_own on public.conversation_members for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy messages_select on public.messages for select to authenticated
  using (
    deleted_at is null
    and private.can_access_conversation(conversation_id)
    and (sender_id is null or not private.is_blocked((select auth.uid()), sender_id))
  );

-- ---------------------------------------------------------------- 推薦・通知【本人】
create policy recommendations_select_own on public.recommendations for select to authenticated
  using (user_id = (select auth.uid()));
create policy notifications_select_own on public.notifications for select to authenticated
  using (user_id = (select auth.uid()));
create policy notifications_update_own on public.notifications for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- ---------------------------------------------------------------- 安心安全【本人】
create policy reports_select_own on public.reports for select to authenticated
  using (reporter_id = (select auth.uid()) or (select private.is_admin()));
create policy reports_insert_own on public.reports for insert to authenticated
  with check (reporter_id = (select auth.uid()));

create policy blocks_select_own on public.blocks for select to authenticated
  using (blocker_id = (select auth.uid()));
create policy blocks_insert_own on public.blocks for insert to authenticated
  with check (blocker_id = (select auth.uid()));
create policy blocks_delete_own on public.blocks for delete to authenticated
  using (blocker_id = (select auth.uid()));

-- ---------------------------------------------------------------- 他人の公開情報（公開ビュー）
-- 本人以外には公開列だけを見せる。退会者・ブロック関係のユーザーは除外する
create view public.public_profiles
with (security_barrier = true)
as
  select p.user_id, p.display_name
  from public.profiles p
  where p.status = 'active'
    and (select auth.uid()) is not null
    and not private.is_blocked((select auth.uid()), p.user_id);
comment on view public.public_profiles is '他ユーザーの公開プロフィール（認証03）';

create view public.public_characters
with (security_barrier = true)
as
  select c.user_id, c.public_code, c.name, c.species, c.class, c.attribute, c.rarity, c.title,
         c.level, c.image_status, c.image_stage
  from public.characters c
  join public.profiles p on p.user_id = c.user_id
  where p.status = 'active'
    and (select auth.uid()) is not null
    and not private.is_blocked((select auth.uid()), c.user_id);
comment on view public.public_characters is '他ユーザーのキャラ公開情報（認証03）';

revoke all on public.public_profiles, public.public_characters from anon, authenticated;
grant select on public.public_profiles, public.public_characters to authenticated, service_role;
