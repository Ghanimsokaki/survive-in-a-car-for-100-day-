-- ============================================================================
--  100 DAYS OUTRUN — Supabase schema
--  Run once in Supabase → SQL Editor → New query → Run.
--  Then: Authentication → Providers → Email → turn OFF "Confirm email"
--        (username sign-in maps to <username>@players.outrun.local)
-- ============================================================================

-- ---------------------------------------------------------------- profiles
create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  username     text unique not null check (username ~ '^[a-z0-9_]{3,16}$'),
  display_name text not null default 'SURVIVOR',
  body_color   text not null default '#ffb347',
  car_color    text not null default '#d24a2b',
  best_day     int  not null default 0,
  created_at   timestamptz not null default now()
);

-- survivor customisation (skin/outfit/hair/accessory/height/build), safe to re-run
alter table public.profiles add column if not exists customization jsonb not null default '{}'::jsonb;

alter table public.profiles enable row level security;

drop policy if exists "profiles are readable by signed-in players" on public.profiles;
create policy "profiles are readable by signed-in players"
  on public.profiles for select to authenticated using (true);

drop policy if exists "players insert their own profile" on public.profiles;
create policy "players insert their own profile"
  on public.profiles for insert to authenticated with check (auth.uid() = id);

drop policy if exists "players update their own profile" on public.profiles;
create policy "players update their own profile"
  on public.profiles for update to authenticated
  using (auth.uid() = id) with check (auth.uid() = id);

-- ------------------------------------------------------------- friendships
create table if not exists public.friendships (
  user_id    uuid not null references auth.users (id) on delete cascade,
  friend_id  uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, friend_id),
  check (user_id <> friend_id)
);

alter table public.friendships enable row level security;

drop policy if exists "players read their own friendships" on public.friendships;
create policy "players read their own friendships"
  on public.friendships for select to authenticated
  using (auth.uid() = user_id or auth.uid() = friend_id);

drop policy if exists "players create their own friendships" on public.friendships;
create policy "players create their own friendships"
  on public.friendships for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "players delete their own friendships" on public.friendships;
create policy "players delete their own friendships"
  on public.friendships for delete to authenticated
  using (auth.uid() = user_id or auth.uid() = friend_id);

-- ---------------------------------------------------------------- presence
create table if not exists public.presence (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  room       text,
  day        int,
  status     text default 'lobby',
  updated_at timestamptz not null default now()
);

alter table public.presence enable row level security;

drop policy if exists "presence is readable by signed-in players" on public.presence;
create policy "presence is readable by signed-in players"
  on public.presence for select to authenticated using (true);

drop policy if exists "players write their own presence" on public.presence;
create policy "players write their own presence"
  on public.presence for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "players update their own presence" on public.presence;
create policy "players update their own presence"
  on public.presence for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "players delete their own presence" on public.presence;
create policy "players delete their own presence"
  on public.presence for delete to authenticated using (auth.uid() = user_id);

-- ------------------------------------------------------- friend RPC helpers
-- Two-way friendship in one call; the mirror row can't be written directly
-- because RLS only lets a player insert rows they own.
create or replace function public.add_friend(target_username text)
returns table (id uuid, username text, display_name text)
language plpgsql security definer set search_path = public as $$
declare
  me     uuid := auth.uid();
  target public.profiles;
begin
  if me is null then raise exception 'not signed in'; end if;

  select p.* into target
    from public.profiles p
   where p.username = lower(trim(target_username));

  if target.id is null then raise exception 'no_such_user'; end if;
  if target.id = me then raise exception 'cannot_add_self'; end if;

  insert into public.friendships (user_id, friend_id)
  values (me, target.id), (target.id, me)
  on conflict do nothing;

  return query select target.id, target.username, target.display_name;
end;
$$;

create or replace function public.remove_friend(target_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'not signed in'; end if;
  delete from public.friendships f
   where (f.user_id = me and f.friend_id = target_id)
      or (f.user_id = target_id and f.friend_id = me);
end;
$$;

revoke all on function public.add_friend(text) from public;
revoke all on function public.remove_friend(uuid) from public;
grant execute on function public.add_friend(text) to authenticated;
grant execute on function public.remove_friend(uuid) to authenticated;

-- ------------------------------------------------- auto-create the profile
-- Sign-up metadata (username / display_name) is copied into profiles so the
-- client never has to race two writes.
create or replace function public.handle_new_player()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username, display_name)
  values (
    new.id,
    coalesce(
      nullif(regexp_replace(lower(coalesce(new.raw_user_meta_data ->> 'username', '')), '[^a-z0-9_]', '', 'g'), ''),
      'survivor_' || substr(new.id::text, 1, 6)
    ),
    coalesce(nullif(new.raw_user_meta_data ->> 'display_name', ''), new.raw_user_meta_data ->> 'username', 'SURVIVOR')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_player();

-- ------------------------------------------------------------- housekeeping
-- Optional: prune presence rows older than a day (safe to run manually or via cron)
create or replace function public.prune_presence()
returns void language sql security definer set search_path = public as $$
  delete from public.presence where updated_at < now() - interval '1 day';
$$;

-- =====================================================================
-- OWNER / ADMIN LAYER  (account @ghanimz)
-- ---------------------------------------------------------------------
-- The admin console in the game is gated by username on the client, which
-- is only cosmetic. These policies are the real gate: even if someone
-- flips `window.__outrun.admin` in devtools, PostgREST refuses the writes
-- because they are not the owner account.
-- =====================================================================

-- The single owner username. Change it here (and in lib/admin-auth.mjs)
-- if you ever hand the console to somebody else.
create or replace function public.owner_username()
returns text language sql immutable as $$ select 'ghanimz'::text $$;

/** True when the caller is the signed-in owner account. */
create or replace function public.is_owner()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and p.username = public.owner_username()
  );
$$;

grant execute on function public.is_owner() to authenticated, anon;

-- Optional explicit allow-list, for extra owners later.
create table if not exists public.admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security;

drop policy if exists "admins read self" on public.admins;
create policy "admins read self" on public.admins
  for select using (user_id = auth.uid() or public.is_owner());

drop policy if exists "owner writes admins" on public.admins;
create policy "owner writes admins" on public.admins
  for all using (public.is_owner()) with check (public.is_owner());

-- Keep the owner row present so joins never fail.
insert into public.admins (user_id)
select p.id from public.profiles p
 where p.username = public.owner_username()
on conflict (user_id) do nothing;

-- ------------------------------------------------------------------ bans
create table if not exists public.bans (
  username   text primary key,
  reason     text not null default 'banned by owner',
  banned_by  text not null default 'ghanimz',
  created_at timestamptz not null default now()
);
alter table public.bans enable row level security;

-- Everyone may read the list (the lobby needs it to keep banned players out),
-- but the owner is the only account that can insert / delete.
drop policy if exists "bans readable" on public.bans;
create policy "bans readable" on public.bans
  for select using (true);

drop policy if exists "owner writes bans" on public.bans;
create policy "owner writes bans" on public.bans
  for all using (public.is_owner()) with check (public.is_owner());

-- Owner-only RPC used by older clients / scripts.
create or replace function public.ban_player(target_username text, why text default 'banned by owner')
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'not_owner'; end if;
  insert into public.bans (username, reason, banned_by)
  values (lower(trim(target_username)), coalesce(why, 'banned by owner'), public.owner_username())
  on conflict (username) do update set reason = excluded.reason, banned_by = excluded.banned_by;
end;
$$;

grant execute on function public.ban_player(text, text) to authenticated;

-- ============================================================================
-- ARCADE — ratings and run scores for community games
--
-- The games themselves live in the repo (games/<slug>/), so this table set only
-- stores what actually changes at runtime: who rated what, and how everyone's
-- runs went. Guests keep a local copy; signed-in players sync here.
-- ============================================================================

create table if not exists public.game_ratings (
  user_id    uuid not null references auth.users(id) on delete cascade,
  game_id    text not null,
  stars      smallint not null check (stars between 1 and 5),
  updated_at timestamptz not null default now(),
  primary key (user_id, game_id)
);
alter table public.game_ratings enable row level security;

-- aggregates are public; individual votes are only exposed as a score
drop policy if exists "ratings readable" on public.game_ratings;
create policy "ratings readable" on public.game_ratings
  for select using (true);

drop policy if exists "players rate as themselves" on public.game_ratings;
create policy "players rate as themselves" on public.game_ratings
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "players update their own rating" on public.game_ratings;
create policy "players update their own rating" on public.game_ratings
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table if not exists public.game_runs (
  id         bigserial primary key,
  user_id    uuid references auth.users(id) on delete set null,
  game_id    text not null,
  score      integer not null default 0 check (score >= 0),
  day        integer not null default 0,
  seconds    integer not null default 0,
  won        boolean not null default false,
  meta       text not null default '',
  created_at timestamptz not null default now()
);
alter table public.game_runs enable row level security;
create index if not exists game_runs_score_idx on public.game_runs (game_id, score desc);
create index if not exists game_runs_recent_idx on public.game_runs (created_at desc);

drop policy if exists "runs are readable" on public.game_runs;
create policy "runs are readable" on public.game_runs
  for select using (true);

drop policy if exists "players submit their own runs" on public.game_runs;
create policy "players submit their own runs" on public.game_runs
  for insert to authenticated with check (auth.uid() = user_id);

-- anonymous plays are still counted (guests), but never attached to an account
drop policy if exists "guests submit runs" on public.game_runs;
create policy "guests submit runs" on public.game_runs
  for insert to anon with check (user_id is null);

drop policy if exists "owner prunes runs" on public.game_runs;
create policy "owner prunes runs" on public.game_runs
  for delete using (public.is_owner());

-- one row per game: average rating, vote count and play count, so the arcade
-- can paint 20 cards from a single cheap select
create or replace view public.game_stats as
select
  g.game_id,
  coalesce(round(avg(g.stars)::numeric, 2), 0) as avg_stars,
  count(g.*) as votes,
  coalesce((select count(*) from public.game_runs r where r.game_id = g.game_id), 0) as plays
from public.game_ratings g
group by g.game_id;

grant select on public.game_stats to anon, authenticated;
grant select, insert, update on public.game_ratings to authenticated;
grant select on public.game_ratings to anon;
grant select, insert on public.game_runs to anon, authenticated;
grant usage, select on sequence public.game_runs_id_seq to anon, authenticated;

-- ---------------------------------------------------------------------------
-- ROOM RELAY (multiplayer lobby messages)
--
-- The polling relay keeps the last few seconds of a room in Postgres when
-- Supabase is configured. That is what makes two players visible to each other
-- on a serverless host: a lambda's memory is per-instance and dies on a cold
-- start, so the old in-memory relay only worked by luck.
--
-- A room code is not a secret and these rows expire within minutes, so the
-- policies are deliberately open: anyone may read a room and add to it, and
-- anyone may delete rows that are already older than two minutes (which is how
-- the relay sweeps itself without a cron job). Nothing here can read or write
-- accounts, profiles or runs.
-- ---------------------------------------------------------------------------
create table if not exists public.room_messages (
  id         bigserial primary key,
  room       text not null,
  author     text not null default 'anon',
  payload    jsonb not null,
  ts         timestamptz not null default now()
);

alter table public.room_messages enable row level security;
create index if not exists room_messages_room_ts_idx on public.room_messages (room, ts desc);

drop policy if exists "rooms are readable" on public.room_messages;
create policy "rooms are readable" on public.room_messages
  for select using (true);

drop policy if exists "anyone can speak" on public.room_messages;
create policy "anyone can speak" on public.room_messages
  for insert with check (
    length(room) between 1 and 24
    and length(author) <= 32
    and author <> ''
  );

-- housekeeping only: a client may sweep rows the relay would have dropped anyway
drop policy if exists "stale rows can be swept" on public.room_messages;
create policy "stale rows can be swept" on public.room_messages
  for delete using (ts < now() - interval '2 minutes');

grant select, insert, delete on public.room_messages to anon, authenticated;
grant usage, select on sequence public.room_messages_id_seq to anon, authenticated;
