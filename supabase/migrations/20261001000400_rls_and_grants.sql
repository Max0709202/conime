-- Row Level Security and least-privilege grants.
--
-- Model:
--   * RLS is enabled on every table in schema app.
--   * authenticated: SELECT only, on the tables listed below, filtered by policies.
--     No INSERT/UPDATE/DELETE grants; mutations go through app.api_* functions.
--   * anon: no table access. Only app.api_get_current_question_set / app.api_client_config.
--   * service_role (worker): full access (BYPASSRLS on Supabase).
--   * SECURITY DEFINER functions are owned by the migration role (table owner) and
--     therefore bypass RLS; each one enforces its own authorization.

-- Membership helpers (SECURITY DEFINER to avoid recursive policy evaluation).
create or replace function app.is_conversation_member(p_conversation_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from app.conversation_members cm
    join app.profiles p on p.id = cm.user_id and p.status = 'active'
    where cm.conversation_id = p_conversation_id and cm.user_id = auth.uid()
  )
$$;

create or replace function app.is_guild_member(p_guild_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from app.guild_members gm
    join app.profiles p on p.id = gm.user_id and p.status = 'active'
    where gm.guild_id = p_guild_id and gm.user_id = auth.uid()
  )
$$;

grant execute on function app.is_conversation_member(uuid), app.is_guild_member(uuid),
  app.current_user_active() to authenticated;

-- ---------------------------------------------------------------------------
-- Enable RLS on every table in schema app
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in select tablename from pg_tables where schemaname = 'app' loop
    execute format('alter table app.%I enable row level security', r.tablename);
  end loop;
end $$;

-- Remove any implicit privileges, then grant explicitly.
revoke all on all tables in schema app from anon, authenticated, public;
revoke all on all sequences in schema app from anon, authenticated, public;
grant all on all tables in schema app to service_role;
grant all on all sequences in schema app to service_role;

-- ---------------------------------------------------------------------------
-- Owner-only tables
-- ---------------------------------------------------------------------------
grant select on app.profiles to authenticated;
create policy profiles_select_own on app.profiles for select to authenticated
  using (id = auth.uid());

grant select on app.consents to authenticated;
create policy consents_select_own on app.consents for select to authenticated
  using (user_id = auth.uid());

grant select on app.account_deletion_requests to authenticated;
create policy deletion_select_own on app.account_deletion_requests for select to authenticated
  using (user_id = auth.uid());

grant select on app.diagnosis_submissions to authenticated;
create policy submissions_select_own on app.diagnosis_submissions for select to authenticated
  using (user_id = auth.uid() and app.current_user_active());

grant select on app.diagnosis_answers to authenticated;
create policy answers_select_own on app.diagnosis_answers for select to authenticated
  using (exists (select 1 from app.diagnosis_submissions s
                 where s.id = submission_id and s.user_id = auth.uid()) and app.current_user_active());

grant select on app.profile_features to authenticated;
create policy features_select_own on app.profile_features for select to authenticated
  using (user_id = auth.uid() and app.current_user_active());

grant select on app.user_avatars to authenticated;
create policy avatars_select_own on app.user_avatars for select to authenticated
  using (user_id = auth.uid() and app.current_user_active());

grant select on app.ai_jobs to authenticated;
create policy ai_jobs_select_own on app.ai_jobs for select to authenticated
  using (user_id = auth.uid() and app.current_user_active());

grant select on app.recommendations to authenticated;
create policy recommendations_select_own on app.recommendations for select to authenticated
  using (user_id = auth.uid() and app.current_user_active());

grant select on app.user_growth to authenticated;
create policy growth_select_own on app.user_growth for select to authenticated
  using (user_id = auth.uid() and app.current_user_active());

grant select on app.exp_ledger to authenticated;
create policy exp_ledger_select_own on app.exp_ledger for select to authenticated
  using (user_id = auth.uid() and app.current_user_active());

grant select on app.notifications to authenticated;
create policy notifications_select_own on app.notifications for select to authenticated
  using (user_id = auth.uid() and app.current_user_active());

grant select on app.navigator_messages to authenticated;
create policy navigator_select_own on app.navigator_messages for select to authenticated
  using (user_id = auth.uid() and app.current_user_active());

-- A blocker sees their own blocks; the blocked user cannot see who blocked them.
grant select on app.blocks to authenticated;
create policy blocks_select_own on app.blocks for select to authenticated
  using (blocker_id = auth.uid() and app.current_user_active());

grant select on app.reports to authenticated;
create policy reports_select_own on app.reports for select to authenticated
  using (reporter_id = auth.uid() and app.current_user_active());

-- Reactions: the giver and the recipient (L-4) can see a reaction.
grant select on app.reactions to authenticated;
create policy reactions_select_party on app.reactions for select to authenticated
  using ((giver_id = auth.uid() or recipient_id = auth.uid()) and app.current_user_active());

-- ---------------------------------------------------------------------------
-- Read-only master data for registered users
-- ---------------------------------------------------------------------------
grant select on app.question_sets, app.questions, app.question_options to authenticated;
create policy question_sets_visible on app.question_sets for select to authenticated
  using (status in ('active', 'retired'));
create policy questions_visible on app.questions for select to authenticated
  using (exists (select 1 from app.question_sets s where s.id = question_set_id and s.status in ('active', 'retired')));
create policy question_options_visible on app.question_options for select to authenticated
  using (exists (select 1 from app.questions q join app.question_sets s on s.id = q.question_set_id
                 where q.id = question_id and s.status in ('active', 'retired')));

grant select on app.anime_works, app.anime_characters, app.tags, app.work_tags to authenticated;
create policy anime_works_active on app.anime_works for select to authenticated using (status = 'active');
create policy anime_characters_active on app.anime_characters for select to authenticated using (status = 'active');
create policy tags_all on app.tags for select to authenticated using (true);
create policy work_tags_all on app.work_tags for select to authenticated using (true);

grant select on app.level_rules to authenticated;
create policy level_rules_all on app.level_rules for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- Guilds
-- ---------------------------------------------------------------------------
grant select on app.guilds, app.guild_tags to authenticated;
create policy guilds_published on app.guilds for select to authenticated
  using (app.current_user_active() and (status = 'published' or app.is_guild_member(id)));
create policy guild_tags_visible on app.guild_tags for select to authenticated
  using (exists (select 1 from app.guilds g where g.id = guild_id and (g.status = 'published' or app.is_guild_member(g.id))));

grant select on app.guild_members to authenticated;
create policy guild_members_same_guild on app.guild_members for select to authenticated
  using (app.is_guild_member(guild_id));

grant select on app.guild_announcements to authenticated;
create policy guild_announcements_members on app.guild_announcements for select to authenticated
  using (app.is_guild_member(guild_id));

-- guild_match_traits: internal parameters, service only (no grant).

-- ---------------------------------------------------------------------------
-- Conversations
-- ---------------------------------------------------------------------------
grant select on app.conversations to authenticated;
create policy conversations_members on app.conversations for select to authenticated
  using (app.is_conversation_member(id));

grant select on app.conversation_members to authenticated;
create policy conversation_members_members on app.conversation_members for select to authenticated
  using (app.is_conversation_member(conversation_id));

grant select on app.messages to authenticated;
create policy messages_members on app.messages for select to authenticated
  using (app.is_conversation_member(conversation_id));

grant select on app.message_attachments to authenticated;
create policy attachments_members on app.message_attachments for select to authenticated
  using (app.is_conversation_member(conversation_id) and (status = 'attached' or uploader_id = auth.uid()));

grant select on app.conversation_reads to authenticated;
create policy conversation_reads_own on app.conversation_reads for select to authenticated
  using (user_id = auth.uid() and app.current_user_active());

-- ---------------------------------------------------------------------------
-- Service-only tables (no grants to authenticated / anon):
--   app_settings, audit_logs, idempotency_keys, rate_limit_counters, prompt_versions,
--   ai_runs, matching_rule_versions, moderation_events, guild_match_traits,
--   work_aliases, character_aliases, tag_aliases
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Realtime authorization (private broadcast channels)
--   conv:<uuid>  — members of the conversation
--   user:<uuid>  — that user only
-- No INSERT policy: clients cannot broadcast or use presence.
-- ---------------------------------------------------------------------------
create or replace function app.realtime_topic_allowed(p_topic text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if p_topic is null or auth.uid() is null then
    return false;
  end if;
  if p_topic ~ '^conv:[0-9a-f-]{36}$' then
    v_id := substr(p_topic, 6)::uuid;
    return app.is_conversation_member(v_id);
  elsif p_topic ~ '^user:[0-9a-f-]{36}$' then
    return substr(p_topic, 6)::uuid = auth.uid() and app.current_user_active();
  end if;
  return false;
end;
$$;
grant execute on function app.realtime_topic_allowed(text) to authenticated;

drop policy if exists conime_realtime_receive on realtime.messages;
create policy conime_realtime_receive on realtime.messages for select to authenticated
  using (extension = 'broadcast' and app.realtime_topic_allowed(realtime.topic()));
