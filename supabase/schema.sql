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
