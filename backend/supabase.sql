-- ═══════════════════════════════════════════════════════════════════════
-- Pure Focus — Supabase schema, CLOUD_VERSION 1
-- Paste the whole file into Supabase › SQL Editor › New query › Run.
-- Safe to run again (idempotent). Needs nothing else deployed: no Edge
-- Functions, no extensions beyond core Postgres (gen_random_uuid is core).
-- Ships in the repos as WEB/backend/supabase.sql and
-- MAC/Sources/PureFocusCore/Resources/Cloud/supabase.sql (byte-identical).
--
-- Grants are explicit because Supabase stopped exposing new public tables
-- and functions to the Data API by default (new projects since 2026-05-30,
-- all projects from 2026-10-30).
-- ═══════════════════════════════════════════════════════════════════════

begin;

-- pf_push and pf_add_friend changed their result columns during design; drop earlier definitions (create or replace cannot).
drop function if exists public.pf_push(jsonb);
drop function if exists public.pf_add_friend(text);

-- ───────────────────────── 1. sync records ─────────────────────────
create table if not exists public.pf_records (
  user_id           uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  -- v1 kinds: task session block feed taskList template templateList category setting calPrefs ack.
  -- The pattern (not a list) lets later features add kinds without a migration; clients ignore unknown kinds.
  kind              text        not null check (kind ~ '^[a-z][A-Za-z]{1,31}$'),
  id                text        not null check (id = lower(id) and char_length(id) between 1 and 200 and position('/' in id) = 0),
  data              jsonb       not null default '{}'::jsonb check (pg_column_size(data) <= 262144),
  updated_at        timestamptz not null,
  deleted           boolean     not null default false,
  device_id         text        not null check (char_length(device_id) between 1 and 64),
  schema            smallint    not null default 1,
  server_updated_at timestamptz not null default clock_timestamp(),
  primary key (user_id, kind, id)
);
create index if not exists pf_records_pull_idx on public.pf_records (user_id, server_updated_at);
alter table public.pf_records enable row level security;

drop policy if exists pf_records_select on public.pf_records;
create policy pf_records_select on public.pf_records
  for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists pf_records_insert on public.pf_records;
create policy pf_records_insert on public.pf_records
  for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists pf_records_update on public.pf_records;
create policy pf_records_update on public.pf_records
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
-- No delete policy: deletes are tombstones (deleted = true). pf_delete_my_data() erases everything.

revoke all on public.pf_records from anon, authenticated;
grant select, insert, update on public.pf_records to authenticated;
grant all on public.pf_records to service_role;

-- Server stamps, clock-skew clamp, tombstone payload wipe.
create or replace function public.pf_records_touch()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.id := lower(new.id);
  new.server_updated_at := clock_timestamp();
  if new.updated_at > now() + interval '5 minutes' then
    new.updated_at := now() + interval '5 minutes';
  end if;
  if new.deleted then
    new.data := '{}'::jsonb;
  end if;
  return new;
end $$;

drop trigger if exists pf_records_touch on public.pf_records;
create trigger pf_records_touch before insert or update on public.pf_records
  for each row execute function public.pf_records_touch();

-- Push: last-write-wins on (updated_at, device_id), atomically, ≤ 500 records per call.
-- Returns one row per incoming record with status:
--   'applied' = stored · 'stale' = the server copy is newer (the client fetches it with pf_fetch and applies it)
--   'invalid' = failed validation (bad kind/id/payload); the client parks it and never retries automatically.
-- Invalid rows never abort the batch.
create or replace function public.pf_push(p_records jsonb)
returns table (kind text, id text, status text, server_updated_at timestamptz)
language plpgsql security invoker set search_path = '' as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  if jsonb_typeof(p_records) is distinct from 'array' or jsonb_array_length(p_records) > 500 then
    raise exception 'bad batch' using errcode = '22023';
  end if;
  return query
  with parsed as (
    select x.kind, lower(x.id) as id, coalesce(x.data, '{}'::jsonb) as data, x."updatedAt" as updated_at,
           coalesce(x.deleted, false) as deleted, x."deviceID" as device_id, coalesce(x.schema, 1)::smallint as schema
    from jsonb_to_recordset(p_records)
         as x(kind text, id text, data jsonb, "updatedAt" timestamptz, deleted boolean, "deviceID" text, schema int)
  ), checked as (
    select p.*,
           coalesce(p.kind ~ '^[a-z][A-Za-z]{1,31}$'
                    and char_length(p.id) between 1 and 200 and position('/' in p.id) = 0
                    and p.updated_at is not null
                    and char_length(p.device_id) between 1 and 64
                    and jsonb_typeof(p.data) = 'object'
                    and pg_column_size(p.data) <= 262144, false) as ok
    from parsed p
  ), incoming as (
    select distinct on (c.kind, c.id) c.kind, c.id, c.data, c.updated_at, c.deleted, c.device_id, c.schema
    from checked c
    where c.ok
    order by c.kind, c.id, c.updated_at desc, c.device_id collate "C" desc
  ), up as (
    insert into public.pf_records as r (user_id, kind, id, data, updated_at, deleted, device_id, schema)
    select v_uid, i.kind, i.id, i.data, i.updated_at, i.deleted, i.device_id, i.schema from incoming i
    on conflict (user_id, kind, id) do update
      set data = excluded.data, updated_at = excluded.updated_at, deleted = excluded.deleted,
          device_id = excluded.device_id, schema = excluded.schema
      where (excluded.updated_at, excluded.device_id collate "C") > (r.updated_at, r.device_id collate "C")
    returning r.kind, r.id, r.server_updated_at
  )
  select c.kind, c.id,
         case when not c.ok then 'invalid' when u.id is not null then 'applied' else 'stale' end,
         u.server_updated_at
  from checked c left join up u on u.kind = c.kind and u.id = c.id;
end $$;

-- Fetch specific records (after a 'stale' push). p_keys = [{"kind":"task","id":"…"}, …], ≤ 500 used.
create or replace function public.pf_fetch(p_keys jsonb)
returns table (kind text, id text, data jsonb, updated_at timestamptz, deleted boolean, device_id text,
               schema smallint, server_updated_at timestamptz)
language sql stable security invoker set search_path = '' as $$
  select r.kind, r.id, r.data, r.updated_at, r.deleted, r.device_id, r.schema, r.server_updated_at
  from public.pf_records r
  join (select distinct k.kind, lower(k.id) as id
        from jsonb_to_recordset(case when jsonb_typeof(p_keys) = 'array' then p_keys else '[]'::jsonb end)
             as k(kind text, id text)
        limit 500) q on q.kind = r.kind and q.id = r.id
  where r.user_id = (select auth.uid());
$$;

-- ───────────────────────── 2. profiles ─────────────────────────
create table if not exists public.pf_profiles (
  user_id      uuid        primary key references auth.users (id) on delete cascade,
  display_name text        not null check (char_length(btrim(display_name)) between 1 and 32),
  avatar_hue   smallint    not null default 210 check (avatar_hue between 0 and 359),
  friend_code  text        not null unique check (friend_code ~ '^[0-9A-HJKMNP-TV-Z]{8}$'),
  lb_opt_in    boolean     not null default false,
  tz           text        not null default 'UTC',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
alter table public.pf_profiles enable row level security;
drop policy if exists pf_profiles_select on public.pf_profiles;
create policy pf_profiles_select on public.pf_profiles
  for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.pf_profiles from anon, authenticated;
grant select on public.pf_profiles to authenticated;     -- writes only through the RPCs below
grant all on public.pf_profiles to service_role;

-- ───────────────────────── 3. friendships (both directions stored) ─────────────────────────
create table if not exists public.pf_friendships (
  user_id    uuid        not null references auth.users (id) on delete cascade,
  friend_id  uuid        not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, friend_id),
  check (user_id <> friend_id)
);
alter table public.pf_friendships enable row level security;
drop policy if exists pf_friendships_select on public.pf_friendships;
create policy pf_friendships_select on public.pf_friendships
  for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.pf_friendships from anon, authenticated;
grant select on public.pf_friendships to authenticated;
grant all on public.pf_friendships to service_role;

-- ───────────────────────── 4. server-side leaderboard facts (no client access) ─────────────────────────
create table if not exists public.pf_session_facts (
  user_id     uuid        not null references auth.users (id) on delete cascade,
  session_id  text        not null,
  start_at    timestamptz not null,
  end_at      timestamptz not null,
  local_day   date        not null,
  cm          integer     not null,
  qualified   boolean     not null,
  received_at timestamptz not null default now(),
  primary key (user_id, session_id)
);
create index if not exists pf_session_facts_day_idx on public.pf_session_facts (user_id, local_day);
alter table public.pf_session_facts enable row level security;   -- no policies: invisible to clients
revoke all on public.pf_session_facts from anon, authenticated;
grant all on public.pf_session_facts to service_role;

create table if not exists public.pf_week_reports (
  user_id        uuid        not null references auth.users (id) on delete cascade,
  week_start     date        not null check (extract(isodow from week_start) = 1),
  xp             integer     not null check (xp >= 0),
  engine_version smallint    not null,
  updated_at     timestamptz not null default now(),
  primary key (user_id, week_start)
);
alter table public.pf_week_reports enable row level security;   -- no policies
revoke all on public.pf_week_reports from anon, authenticated;
grant all on public.pf_week_reports to service_role;

create table if not exists public.pf_rate_hits (
  user_id uuid        not null references auth.users (id) on delete cascade,
  action  text        not null,
  at      timestamptz not null default now()
);
create index if not exists pf_rate_hits_idx on public.pf_rate_hits (user_id, action, at);
alter table public.pf_rate_hits enable row level security;      -- no policies
revoke all on public.pf_rate_hits from anon, authenticated;
grant all on public.pf_rate_hits to service_role;

-- Mirror of CloudRef.sessionFact (v2-backend-reference.js). Runs as the table owner.
create or replace function public.pf_session_fact()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_start timestamptz; v_end timestamptz; v_min numeric; v_sched numeric;
  v_raw integer; v_cm integer; v_wall integer; v_thr integer; v_tz text;
begin
  if new.kind <> 'session' then
    return null;
  end if;
  if new.deleted or coalesce(new.data ->> 'mode', '') <> 'focus' then
    delete from public.pf_session_facts f where f.user_id = new.user_id and f.session_id = new.id;
    return null;
  end if;
  begin
    v_start := (new.data ->> 'start')::timestamptz;
    v_end   := (new.data ->> 'end')::timestamptz;
    v_min   := greatest(0, coalesce((new.data ->> 'minutes')::numeric, 0));
    v_sched := (new.data ->> 'scheduledMinutes')::numeric;
  exception when others then
    delete from public.pf_session_facts f where f.user_id = new.user_id and f.session_id = new.id;
    return null;
  end;
  if v_start is null or v_end is null or v_end <= v_start or v_end > now() + interval '5 minutes' then
    delete from public.pf_session_facts f where f.user_id = new.user_id and f.session_id = new.id;
    return null;
  end if;
  if v_sched is null or v_sched <= 0 then v_sched := 25; end if;
  v_sched := least(greatest(v_sched, 1), 180);
  v_raw  := floor(v_min * 100 + 0.5);
  v_cm   := least(v_raw, floor((v_sched + 15) * 100 + 0.5)::integer);
  v_wall := floor(extract(epoch from (v_end - v_start)) * 100 / 60 + 0.5)::integer + 100;
  v_cm   := least(v_cm, v_wall);
  v_thr  := floor(greatest(5, least(10, 0.8 * v_sched)) * 100 + 0.5);
  select p.tz into v_tz from public.pf_profiles p where p.user_id = new.user_id;
  v_tz := coalesce(v_tz, 'UTC');
  insert into public.pf_session_facts as f (user_id, session_id, start_at, end_at, local_day, cm, qualified)
  values (new.user_id, new.id, v_start, v_end, (v_start at time zone v_tz)::date, v_cm, v_cm >= v_thr)
  on conflict (user_id, session_id) do update
    set start_at = excluded.start_at, end_at = excluded.end_at, local_day = excluded.local_day,
        cm = excluded.cm, qualified = excluded.qualified;          -- received_at keeps the FIRST receipt
  return null;
end $$;

drop trigger if exists pf_records_session_fact on public.pf_records;
create trigger pf_records_session_fact after insert or update on public.pf_records
  for each row when (new.kind = 'session') execute function public.pf_session_fact();

-- Week stats for one user (mirror of CloudRef.weekStats). Internal: not executable by clients.
create or replace function public.pf_week_stats(p_user uuid, p_week date)
returns table (minutes integer, sessions integer, active_days integer, base_xp integer, xp_ceiling integer)
language sql stable set search_path = '' as $$
  with f as (
    select s.local_day, s.start_at, s.end_at, s.cm, s.qualified,
           max(s.end_at) over (order by s.start_at, s.session_id collate "C"
                               rows between unbounded preceding and 1 preceding) as prev_end
    from public.pf_session_facts s
    where s.user_id = p_user
      and s.local_day between p_week - 1 and p_week + 7
      and s.received_at <= s.end_at + interval '8 days'
  ), ok as (
    select * from f
    where (f.prev_end is null or f.start_at >= f.prev_end - interval '60 seconds')
      and f.local_day >= p_week and f.local_day < p_week + 7
  ), d as (
    select ok.local_day, least(sum(ok.cm), 48000)::integer as cm, (count(*) filter (where ok.qualified))::integer as q
    from ok group by ok.local_day
  ), x as (
    select d.cm, d.q, (least(d.cm, 30000) / 10 + greatest(least(d.cm, 48000) - 30000, 0) / 20) as base from d
  )
  select (coalesce(sum(x.cm), 0) / 100)::integer,
         coalesce(sum(x.q), 0)::integer,
         (count(*) filter (where x.q > 0))::integer,
         coalesce(sum(x.base), 0)::integer,
         coalesce(sum(case when x.cm > 0 then 3 * x.base + 180 * x.q + 1560 else 0 end), 0)::integer
  from x;
$$;

-- ───────────────────────── 4b. AI proxy usage (v2-ai.md §9.3; written only by the Edge Function) ─────────────────────────
create table if not exists public.ai_usage (
  id                 bigint      generated always as identity primary key,
  user_id            uuid        not null references auth.users (id) on delete cascade,
  day                date        not null,
  op                 text        not null,
  model              text        not null,
  input_tokens       integer     not null,
  output_tokens      integer     not null,
  cache_read_tokens  integer     not null default 0,
  cache_write_tokens integer     not null default 0,
  created_at         timestamptz not null default now()
);
create index if not exists ai_usage_user_day on public.ai_usage (user_id, day, op);
alter table public.ai_usage enable row level security;
drop policy if exists ai_usage_select on public.ai_usage;
create policy ai_usage_select on public.ai_usage
  for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.ai_usage from anon, authenticated;
grant select on public.ai_usage to authenticated;
grant all on public.ai_usage to service_role;

-- ───────────────────────── 5. RPCs ─────────────────────────
create or replace function public.pf_schema_version()
returns integer language sql immutable set search_path = '' as $$ select 1 $$;

create or replace function public.pf_new_code()
returns text language plpgsql volatile set search_path = '' as $$
declare
  a constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  b bytea := uuid_send(gen_random_uuid());
  s text := '';
  i integer;
begin
  foreach i in array array[0, 1, 2, 3, 4, 5, 10, 11] loop   -- bytes without UUID version/variant bits
    s := s || substr(a, (get_byte(b, i) % 32) + 1, 1);
  end loop;
  return s;
end $$;

-- Create the caller's profile on first sign-in; refresh the time zone every launch.
create or replace function public.pf_ensure_profile(p_display_name text, p_tz text)
returns setof public.pf_profiles
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_tz text := 'UTC';
  v_name text := left(coalesce(nullif(btrim(p_display_name), ''), 'Focuser'), 32);
  tries integer := 0;
begin
  if v_uid is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if p_tz is not null and exists (select 1 from pg_catalog.pg_timezone_names n where n.name = p_tz) then v_tz := p_tz; end if;
  if not exists (select 1 from public.pf_profiles p where p.user_id = v_uid) then
    loop
      begin
        insert into public.pf_profiles (user_id, display_name, friend_code, tz)
        values (v_uid, v_name, public.pf_new_code(), v_tz);
        exit;
      exception when unique_violation then
        tries := tries + 1;
        if exists (select 1 from public.pf_profiles p where p.user_id = v_uid) then exit; end if;
        if tries > 5 then raise; end if;
      end;
    end loop;
  else
    update public.pf_profiles p set tz = v_tz, updated_at = now() where p.user_id = v_uid and p.tz <> v_tz;
  end if;
  return query select * from public.pf_profiles p where p.user_id = v_uid;
end $$;

create or replace function public.pf_update_profile(p_display_name text default null, p_avatar_hue integer default null,
                                                    p_lb_opt_in boolean default null)
returns setof public.pf_profiles
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not signed in' using errcode = '28000'; end if;
  update public.pf_profiles p set
    display_name = coalesce(left(nullif(btrim(p_display_name), ''), 32), p.display_name),
    avatar_hue   = case when p_avatar_hue is null then p.avatar_hue else least(greatest(p_avatar_hue, 0), 359) end,  -- greatest() ignores NULL
    lb_opt_in    = coalesce(p_lb_opt_in, p.lb_opt_in),
    updated_at   = now()
  where p.user_id = v_uid;
  return query select * from public.pf_profiles p where p.user_id = v_uid;
end $$;

create or replace function public.pf_regenerate_code()
returns text language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_code text; tries integer := 0;
begin
  if v_uid is null then raise exception 'not signed in' using errcode = '28000'; end if;
  loop
    begin
      v_code := public.pf_new_code();
      update public.pf_profiles p set friend_code = v_code, updated_at = now() where p.user_id = v_uid;
      return v_code;
    exception when unique_violation then
      tries := tries + 1;
      if tries > 5 then raise; end if;
    end;
  end loop;
end $$;

-- Add a friend by code. The code holder consented by sharing it; both directions are created.
-- Never raises for user errors: a raise would roll back the rate-limit hit and make guessing free.
-- status: added | already | bad_code | no_such_code | own_code | too_many_friends | rate_limited
create or replace function public.pf_add_friend(p_code text)
returns table (status text, user_id uuid, display_name text, avatar_hue smallint)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_code text := translate(upper(regexp_replace(coalesce(p_code, ''), '[^0-9A-Za-z]', '', 'g')), 'ILO', '110');
  v_friend uuid;
  v_new integer;
begin
  if v_uid is null then raise exception 'not signed in' using errcode = '28000'; end if;
  delete from public.pf_rate_hits h where h.user_id = v_uid and h.at < now() - interval '1 day';
  if (select count(*) from public.pf_rate_hits h where h.user_id = v_uid and h.action = 'add_friend'
        and h.at > now() - interval '1 hour') >= 20 then
    return query select 'rate_limited'::text, null::uuid, null::text, null::smallint; return;
  end if;
  insert into public.pf_rate_hits (user_id, action) values (v_uid, 'add_friend');
  if v_code !~ '^[0-9A-HJKMNP-TV-Z]{8}$' then
    return query select 'bad_code'::text, null::uuid, null::text, null::smallint; return;
  end if;
  select p.user_id into v_friend from public.pf_profiles p where p.friend_code = v_code;
  if v_friend is null then
    return query select 'no_such_code'::text, null::uuid, null::text, null::smallint; return;
  end if;
  if v_friend = v_uid then
    return query select 'own_code'::text, null::uuid, null::text, null::smallint; return;
  end if;
  if not exists (select 1 from public.pf_friendships f where f.user_id = v_uid and f.friend_id = v_friend)
     and (select count(*) from public.pf_friendships f where f.user_id = v_uid) >= 50 then
    return query select 'too_many_friends'::text, null::uuid, null::text, null::smallint; return;
  end if;
  insert into public.pf_friendships (user_id, friend_id) values (v_uid, v_friend), (v_friend, v_uid)
    on conflict do nothing;
  get diagnostics v_new = row_count;
  return query select case when v_new > 0 then 'added' else 'already' end, p.user_id, p.display_name, p.avatar_hue
               from public.pf_profiles p where p.user_id = v_friend;
end $$;

-- Everyone the caller is friends with (for the "Manage friends" list), opted in or not.
create or replace function public.pf_friends()
returns table (user_id uuid, display_name text, avatar_hue smallint, lb_opt_in boolean, since timestamptz)
language sql stable security definer set search_path = '' as $$
  select p.user_id, p.display_name, p.avatar_hue, p.lb_opt_in, f.created_at
  from public.pf_friendships f join public.pf_profiles p on p.user_id = f.friend_id
  where f.user_id = (select auth.uid())
  order by p.display_name;
$$;

create or replace function public.pf_remove_friend(p_friend uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not signed in' using errcode = '28000'; end if;
  delete from public.pf_friendships f
  where (f.user_id = v_uid and f.friend_id = p_friend) or (f.user_id = p_friend and f.friend_id = v_uid);
end $$;

-- The client reports its engine week XP (Engagement.compute). The board shows least(reported, ceiling).
create or replace function public.pf_report_week(p_week date, p_xp integer, p_engine integer)
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if p_week is null or extract(isodow from p_week) <> 1 or p_week > current_date + 1 or p_week < current_date - 21 then
    raise exception 'bad_week' using errcode = 'P0001';
  end if;
  insert into public.pf_week_reports as w (user_id, week_start, xp, engine_version, updated_at)
  values (v_uid, p_week, least(greatest(coalesce(p_xp, 0), 0), 1000000), coalesce(p_engine, 1)::smallint, now())
  on conflict (user_id, week_start) do update
    set xp = excluded.xp, engine_version = excluded.engine_version, updated_at = now();
end $$;

-- Friends board for a week (default: the caller's current Monday). Reciprocal: friends are only
-- listed when the caller has opted in, and only friends who opted in are listed.
create or replace function public.pf_leaderboard(p_week date default null)
returns table (user_id uuid, display_name text, avatar_hue smallint, is_me boolean, week_start date,
               minutes integer, sessions integer, active_days integer, xp integer, xp_ceiling integer,
               last_week_minutes integer, hidden_friends integer)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_opt boolean;
  v_tz text;
  v_week date;
  v_hidden integer;
begin
  if v_uid is null then raise exception 'not signed in' using errcode = '28000'; end if;
  select p.lb_opt_in, p.tz into v_opt, v_tz from public.pf_profiles p where p.user_id = v_uid;
  v_week := coalesce(p_week, date_trunc('week', now() at time zone coalesce(v_tz, 'UTC'))::date);
  select count(*) into v_hidden from public.pf_friendships f join public.pf_profiles p on p.user_id = f.friend_id
  where f.user_id = v_uid and (not p.lb_opt_in or not coalesce(v_opt, false));
  return query
  with members as (
    select v_uid as uid
    union
    select f.friend_id from public.pf_friendships f join public.pf_profiles p on p.user_id = f.friend_id
    where f.user_id = v_uid and p.lb_opt_in and coalesce(v_opt, false)
  )
  select m.uid, p.display_name, p.avatar_hue, m.uid = v_uid, v_week,
         w.minutes, w.sessions, w.active_days,
         least(coalesce(r.xp, w.base_xp), w.xp_ceiling)::integer, w.xp_ceiling,
         lw.minutes, v_hidden
  from members m
  join public.pf_profiles p on p.user_id = m.uid
  cross join lateral public.pf_week_stats(m.uid, v_week) w
  cross join lateral public.pf_week_stats(m.uid, v_week - 7) lw
  left join public.pf_week_reports r on r.user_id = m.uid and r.week_start = v_week
  order by w.minutes desc, p.display_name;
end $$;

-- Erase every row this user owns (records, facts, friends, profile). The sign-in itself is removed
-- by pf_delete_my_account() when the project allows it, else in Authentication › Users.
create or replace function public.pf_delete_my_data()
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not signed in' using errcode = '28000'; end if;
  delete from public.pf_records r where r.user_id = v_uid;
  delete from public.pf_session_facts s where s.user_id = v_uid;
  delete from public.pf_week_reports w where w.user_id = v_uid;
  delete from public.pf_friendships f where f.user_id = v_uid or f.friend_id = v_uid;
  delete from public.pf_rate_hits h where h.user_id = v_uid;
  delete from public.ai_usage a where a.user_id = v_uid;
  delete from public.pf_profiles p where p.user_id = v_uid;
end $$;

create or replace function public.pf_delete_my_account()
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not signed in' using errcode = '28000'; end if;
  perform public.pf_delete_my_data();
  begin
    delete from auth.users u where u.id = v_uid;
    return true;
  exception when insufficient_privilege then
    return false;
  end;
end $$;

-- ───────────────────────── 6. function privileges ─────────────────────────
revoke execute on function public.pf_records_touch() from public, anon, authenticated;
revoke execute on function public.pf_session_fact() from public, anon, authenticated;
revoke execute on function public.pf_week_stats(uuid, date) from public, anon, authenticated;
revoke execute on function public.pf_new_code() from public, anon, authenticated;
revoke execute on function public.pf_push(jsonb) from public, anon;
revoke execute on function public.pf_fetch(jsonb) from public, anon;
revoke execute on function public.pf_ensure_profile(text, text) from public, anon;
revoke execute on function public.pf_update_profile(text, integer, boolean) from public, anon;
revoke execute on function public.pf_regenerate_code() from public, anon;
revoke execute on function public.pf_add_friend(text) from public, anon;
revoke execute on function public.pf_friends() from public, anon;
revoke execute on function public.pf_remove_friend(uuid) from public, anon;
revoke execute on function public.pf_report_week(date, integer, integer) from public, anon;
revoke execute on function public.pf_leaderboard(date) from public, anon;
revoke execute on function public.pf_delete_my_data() from public, anon;
revoke execute on function public.pf_delete_my_account() from public, anon;

grant execute on function public.pf_schema_version() to anon, authenticated;
grant execute on function public.pf_push(jsonb) to authenticated;
grant execute on function public.pf_fetch(jsonb) to authenticated;
grant execute on function public.pf_ensure_profile(text, text) to authenticated;
grant execute on function public.pf_update_profile(text, integer, boolean) to authenticated;
grant execute on function public.pf_regenerate_code() to authenticated;
grant execute on function public.pf_add_friend(text) to authenticated;
grant execute on function public.pf_friends() to authenticated;
grant execute on function public.pf_remove_friend(uuid) to authenticated;
grant execute on function public.pf_report_week(date, integer, integer) to authenticated;
grant execute on function public.pf_leaderboard(date) to authenticated;
grant execute on function public.pf_delete_my_data() to authenticated;
grant execute on function public.pf_delete_my_account() to authenticated;

commit;

-- ───────────────────────── 7. optional housekeeping (run separately) ─────────────────────────
-- Purge tombstones older than 180 days once a day. Needs Integrations › Cron (pg_cron) enabled.
-- select cron.schedule('pf-purge-tombstones', '17 4 * * *',
--   $$ delete from public.pf_records where deleted and server_updated_at < now() - interval '180 days' $$);
