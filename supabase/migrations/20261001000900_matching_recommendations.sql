-- Deterministic, versioned matching (案A, M-3) and anime candidate scoring.
--
-- One scoring implementation: app.rule_score(rules, counts). Both the bulk user/guild
-- queries and the golden-fixture tests (app.score_feature_sets) go through it.
-- Exact matches only: values match when (question_code, match_key) are identical.

-- p_counts: {"Q1": {"n": 2, "values": ["作品A","作品B"]}, ...}
create or replace function app.rule_score(p_rules jsonb, p_counts jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  with s as (
    select i ->> 'question_code' as q,
           i ->> 'label' as label,
           t.ord,
           least(coalesce((p_counts -> (i ->> 'question_code') ->> 'n')::numeric, 0) * (i ->> 'points_per_match')::numeric,
                 (i ->> 'cap')::numeric) as pts,
           coalesce(p_counts -> (i ->> 'question_code') -> 'values', '[]'::jsonb) as vals
    from jsonb_array_elements(p_rules -> 'items') with ordinality as t(i, ord)
  )
  select jsonb_build_object(
    'score', least(coalesce((p_rules ->> 'max')::numeric, 100),
                   coalesce((p_rules ->> 'base')::numeric, 0) + coalesce(sum(pts), 0)),
    'matched_count', count(*) filter (where pts > 0),
    'matched_items', coalesce(jsonb_agg(jsonb_build_object('question_code', q, 'label', label, 'points', pts, 'values', vals)
                                        order by ord) filter (where pts > 0), '[]'::jsonb))
  from s
$$;

-- Golden-test helper: score two feature sets [{question_code, match_key, label}] with a rule set.
create or replace function app.score_feature_sets(p_rules jsonb, p_a jsonb, p_b jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  with a as (select distinct e ->> 'question_code' q, e ->> 'match_key' k from jsonb_array_elements(p_a) e),
       b as (select distinct e ->> 'question_code' q, e ->> 'match_key' k, e ->> 'label' l from jsonb_array_elements(p_b) e),
       m as (select b.q, count(distinct b.k) n, jsonb_agg(distinct b.l) vals from a join b using (q, k) group by b.q)
  select app.rule_score(p_rules, coalesce((select jsonb_object_agg(q, jsonb_build_object('n', n, 'values', vals)) from m), '{}'::jsonb))
$$;

create or replace function app.active_rules(p_kind text) returns app.matching_rule_versions
language sql stable security definer set search_path = '' as $$
  select * from app.matching_rule_versions where kind = p_kind and status = 'active'
$$;

-- Human-readable value of a feature (work title, character name, tag name or option label).
create or replace function app.feature_label(f app.profile_features) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select title from app.anime_works where id = f.work_id),
    (select name from app.anime_characters where id = f.character_id),
    (select name from app.tags where id = f.tag_id),
    (select label_ja from app.question_options where id = f.option_id))
$$;

-- ---------------------------------------------------------------------------
-- User ↔ user (M-2, M-3, 設計05-C)
-- ---------------------------------------------------------------------------
create or replace function app.compute_user_matches(p_viewer uuid, p_limit integer) returns jsonb
language sql stable security definer set search_path = '' as $$
  with r as (select * from app.active_rules('user')),
  codes as (select jsonb_array_elements(r.rules -> 'items') ->> 'question_code' as q from r),
  mine as (
    select f.question_code, f.match_key from app.profile_features f
    where f.user_id = p_viewer and f.resolution <> 'unresolved' and f.question_code in (select q from codes)
  ),
  eligible as (
    select p.id, p.last_active_at from app.profiles p
    join app.user_avatars a on a.user_id = p.id
    where p.status = 'active' and p.id <> p_viewer
      and not app.is_blocked_between(p_viewer, p.id)
  ),
  hits as (
    select f.user_id, f.question_code, count(distinct f.match_key) as n,
           jsonb_agg(distinct app.feature_label(f)) as vals
    from app.profile_features f
    join mine m on m.question_code = f.question_code and m.match_key = f.match_key
    where f.user_id in (select id from eligible) and f.resolution <> 'unresolved'
    group by f.user_id, f.question_code
  ),
  scored as (
    select h.user_id,
           app.rule_score((select rules from r),
                          jsonb_object_agg(h.question_code, jsonb_build_object('n', h.n, 'values', h.vals))) as s
    from hits h group by h.user_id
  ),
  ranked as (
    select s.user_id, s.s, e.last_active_at from scored s join eligible e on e.id = s.user_id
    where (s.s ->> 'matched_count')::integer > 0
      and (s.s ->> 'score')::numeric >= app.setting_int('recommendations.users.min_percent', 50)
    order by (s.s ->> 'score')::numeric desc, (s.s ->> 'matched_count')::integer desc,
             e.last_active_at desc nulls last, s.user_id
    limit p_limit
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'user', app.user_summary_json(x.user_id),
        'compatibility_percent', round((x.s ->> 'score')::numeric)::integer,
        'base_percent', ((select rules from r) ->> 'base')::integer,
        'matched_items', x.s -> 'matched_items')
        order by (x.s ->> 'score')::numeric desc, (x.s ->> 'matched_count')::integer desc,
                 x.last_active_at desc nulls last, x.user_id)
      from ranked x), '[]'::jsonb),
    'rule_version', (select version from r),
    'generated_at', app.ts(now()))
$$;

create or replace function app.api_user_recommendations(p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := app.require_user();
begin
  if not exists (select 1 from app.user_avatars where user_id = v_uid) then
    perform app.raise_api_error('DIAGNOSIS_NOT_COMPLETED', jsonb_build_object('diagnosis', app.diagnosis_state(v_uid)));
  end if;
  return app.compute_user_matches(v_uid,
    least(greatest(coalesce(p_limit, app.setting_int('recommendations.users.limit', 10)), 1), 20));
end;
$$;

-- ---------------------------------------------------------------------------
-- User → guild (M-1): separate formula, operator-defined guild traits
-- ---------------------------------------------------------------------------
create or replace function app.compute_guild_matches(p_viewer uuid, p_limit integer) returns jsonb
language sql stable security definer set search_path = '' as $$
  with r as (select * from app.active_rules('guild')),
  mine as (
    select f.question_code, f.match_key from app.profile_features f
    where f.user_id = p_viewer and f.resolution <> 'unresolved'
  ),
  eligible as (
    select g.id, g.member_count from app.guilds g
    where g.status = 'published'
      and not exists (select 1 from app.guild_members m where m.guild_id = g.id and m.user_id = p_viewer)
  ),
  hits as (
    select t.guild_id, t.question_code, count(distinct t.match_key) as n, jsonb_agg(distinct t.label) as vals
    from app.guild_match_traits t
    join mine m on m.question_code = t.question_code and m.match_key = t.match_key
    where t.guild_id in (select id from eligible)
    group by t.guild_id, t.question_code
  ),
  scored as (
    select h.guild_id,
           app.rule_score((select rules from r),
                          jsonb_object_agg(h.question_code, jsonb_build_object('n', h.n, 'values', h.vals))) as s
    from hits h group by h.guild_id
  ),
  ranked as (
    select s.guild_id, s.s, e.member_count from scored s join eligible e on e.id = s.guild_id
    where (s.s ->> 'score')::numeric > 0
    order by (s.s ->> 'score')::numeric desc, (s.s ->> 'matched_count')::integer desc, e.member_count desc, s.guild_id
    limit p_limit
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'guild', app.guild_summary_json(x.guild_id, p_viewer),
        'score', (x.s ->> 'score')::numeric,
        'matched_items', x.s -> 'matched_items')
        order by (x.s ->> 'score')::numeric desc, (x.s ->> 'matched_count')::integer desc, x.member_count desc, x.guild_id)
      from ranked x), '[]'::jsonb),
    'rule_version', (select version from r),
    'generated_at', app.ts(now()))
$$;

create or replace function app.api_guild_recommendations() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := app.require_user();
begin
  if not exists (select 1 from app.diagnosis_submissions where user_id = v_uid) then
    perform app.raise_api_error('DIAGNOSIS_NOT_COMPLETED', jsonb_build_object('diagnosis', app.diagnosis_state(v_uid)));
  end if;
  return app.compute_guild_matches(v_uid, app.setting_int('recommendations.guilds.limit', 3));
end;
$$;

-- ---------------------------------------------------------------------------
-- User → anime candidates (概要8 アニメ(仮)). Deterministic scoring; the worker
-- passes only these candidates to AI and validates the returned IDs against them.
-- ---------------------------------------------------------------------------
create or replace function app.svc_anime_candidates(p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  with r as (select * from app.active_rules('anime')),
  item as (
    select i ->> 'key' as key, i ->> 'label' as label,
           (i ->> 'points_per_match')::numeric as ppm, (i ->> 'cap')::numeric as cap
    from r, jsonb_array_elements(r.rules -> 'items') i
  ),
  viewed as (
    select f.work_id from app.profile_features f, r
    where f.user_id = p_user and f.work_id is not null
      and f.question_code in (select jsonb_array_elements_text(r.rules -> 'exclude' -> 'viewed_question_codes'))
  ),
  disliked as (
    select f.tag_id from app.profile_features f, r
    where f.user_id = p_user and f.tag_id is not null
      and f.question_code in (select jsonb_array_elements_text(r.rules -> 'exclude' -> 'disliked_genre_question_codes'))
  ),
  pref as (
    -- favourite_genre: genres of the user's favourite works (Q1)
    select 'favorite_genre' as key, wt.tag_id
    from app.profile_features f
    join app.work_tags wt on wt.work_id = f.work_id
    join app.tags t on t.id = wt.tag_id and t.kind = 'genre'
    where f.user_id = p_user and f.question_code = 'Q1'
    union
    -- world_setting: world-setting tags the user wants to play in (Q11)
    select 'world_setting', f.tag_id from app.profile_features f
    where f.user_id = p_user and f.question_code = 'Q11' and f.tag_id is not null
    union
    -- development_genre: genres mapped from the Q15 option (概要8)
    select 'development_genre', t.id
    from app.profile_features f
    join app.question_options o on o.id = f.option_id
    cross join lateral jsonb_array_elements_text(coalesce(o.attributes -> 'genre_codes', '[]'::jsonb)) gc
    join app.tags t on t.kind = 'genre' and t.code = gc
    where f.user_id = p_user and f.question_code = 'Q15'
  ),
  cand as (
    select w.id, w.title from app.anime_works w
    where w.status = 'active'
      and w.id not in (select work_id from viewed)
      and not exists (select 1 from app.work_tags wt where wt.work_id = w.id and wt.tag_id in (select tag_id from disliked))
  ),
  hits as (
    select c.id as work_id, p.key, count(distinct p.tag_id) as n, jsonb_agg(distinct t.name) as vals
    from cand c
    join app.work_tags wt on wt.work_id = c.id
    join pref p on p.tag_id = wt.tag_id
    join app.tags t on t.id = wt.tag_id
    group by c.id, p.key
  ),
  scored as (
    select c.id, c.title,
           least(coalesce((select (rules ->> 'max')::numeric from r), 100),
                 coalesce(sum(least(h.n * i.ppm, i.cap)), 0)) as score,
           coalesce(jsonb_agg(jsonb_build_object('key', i.key, 'label', i.label, 'points', least(h.n * i.ppm, i.cap), 'values', h.vals))
                    filter (where h.work_id is not null), '[]'::jsonb) as matched
    from cand c
    left join hits h on h.work_id = c.id
    left join item i on i.key = h.key
    group by c.id, c.title
  )
  select jsonb_build_object(
    'rule_version', (select version from r),
    'result_limit', (select (rules ->> 'result_limit')::integer from r),
    'candidates', coalesce((
      select jsonb_agg(jsonb_build_object(
               'work_id', s.id, 'title', s.title, 'score', s.score, 'matched', s.matched,
               'genres', coalesce((select jsonb_agg(t.name order by t.name) from app.work_tags wt
                                   join app.tags t on t.id = wt.tag_id and t.kind = 'genre' where wt.work_id = s.id), '[]'::jsonb),
               'summary', (select left(summary, 200) from app.anime_works where id = s.id))
             order by s.score desc, s.title, s.id)
      from (select * from scored order by score desc, title, id
            limit (select (rules ->> 'candidate_limit')::integer from r)) s), '[]'::jsonb))
$$;

create or replace function app.api_anime_recommendations() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := app.require_user();
  v_diag jsonb := app.diagnosis_state(v_uid);
  v_items jsonb;
begin
  select jsonb_agg(jsonb_build_object(
           'rank', r.rank,
           'work', jsonb_build_object('id', w.id, 'title', w.title,
                     'genres', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name) order by t.name)
                                         from app.work_tags wt join app.tags t on t.id = wt.tag_id and t.kind = 'genre'
                                         where wt.work_id = w.id), '[]'::jsonb)),
           'reason', r.reason, 'reason_source', r.reason_source, 'score', r.score) order by r.rank)
    into v_items
  from app.recommendations r join app.anime_works w on w.id = r.work_id
  where r.user_id = v_uid and r.kind = 'anime';

  return jsonb_build_object(
    'status', case
      when v_items is not null then 'ready'
      when v_diag ->> 'status' = 'completed' then 'ready'
      when v_diag ->> 'status' = 'processing' then 'pending'
      else 'not_available' end,
    'items', coalesce(v_items, '[]'::jsonb),
    'rule_version', (select rule_version from app.recommendations where user_id = v_uid and kind = 'anime' limit 1),
    'generated_at', app.ts((select max(created_at) from app.recommendations where user_id = v_uid and kind = 'anime')));
end;
$$;
