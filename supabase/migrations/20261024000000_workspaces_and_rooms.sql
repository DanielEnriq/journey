-- Cloud schema: users, workspaces, and rooms, shared between collaborators.
-- Local-only data (sessions, settings, repositories) stays in SQLite; see src/database/.
--
-- Every table has RLS enabled. Access rules:
--   users              you, and anyone you share a workspace with
--   workspaces         members; owners rename/delete. Creating one makes you its owner.
--   workspace_members  members see the roster; owners add/remove/re-role; anyone can leave
--   rooms              workspace members see and create; creator or owner edits/deletes
--   room_members       workspace members see and add workspace members; you can leave,
--                      the room creator or a workspace owner can remove anyone

-- ─── Tables ──────────────────────────────────────────────────────────────────

-- Profile mirror of auth.users, filled by a trigger on sign-up.
create table public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  name text,
  avatar_url text,
  created_at timestamptz not null default now()
);

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  created_by uuid not null default auth.uid() references public.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create type public.workspace_role as enum ('owner', 'member');

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  role public.workspace_role not null default 'member',
  joined_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index workspace_members_user_id_idx on public.workspace_members (user_id);

create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  created_by uuid not null default auth.uid() references public.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index rooms_workspace_id_idx on public.rooms (workspace_id);

create table public.room_members (
  room_id uuid not null references public.rooms (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id)
);
create index room_members_user_id_idx on public.room_members (user_id);

-- ─── Policy helpers ──────────────────────────────────────────────────────────
-- SECURITY DEFINER so policies can look up membership without recursing into
-- workspace_members' own RLS. Kept out of `public` so they aren't exposed as RPCs.

create schema private;
grant usage on schema private to authenticated;

create function private.is_workspace_member(ws uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = ws and user_id = (select auth.uid())
  );
$$;

create function private.is_workspace_owner(ws uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = ws and user_id = (select auth.uid()) and role = 'owner'
  );
$$;

-- True if `target` belongs to workspace `ws`, regardless of who's asking.
create function private.is_member_of(ws uuid, target uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.workspace_members where workspace_id = ws and user_id = target);
$$;

create function private.shares_workspace(other uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.workspace_members mine
    join public.workspace_members theirs using (workspace_id)
    where mine.user_id = (select auth.uid()) and theirs.user_id = other
  );
$$;

create function private.room_workspace(room uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select workspace_id from public.rooms where id = room;
$$;

create function private.room_creator(room uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select created_by from public.rooms where id = room;
$$;

revoke execute on all functions in schema private from public;
grant execute on all functions in schema private to authenticated;

-- ─── Triggers ────────────────────────────────────────────────────────────────

create function private.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.users (id, email, name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture')
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

create function private.add_workspace_owner()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.workspace_members (workspace_id, user_id, role) values (new.id, new.created_by, 'owner');
  return new;
end;
$$;

create trigger on_workspace_created
  after insert on public.workspaces
  for each row execute function private.add_workspace_owner();

-- ─── Row-level security ──────────────────────────────────────────────────────
-- `(select auth.uid())` instead of bare `auth.uid()` lets Postgres evaluate it once per query.

alter table public.users enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.rooms enable row level security;
alter table public.room_members enable row level security;

-- Supabase's default privileges grant everything to anon and authenticated; start from nothing.
-- Signed-in users only, and UPDATE per column so ids, owners, and timestamps can't be rewritten.
revoke all on public.users, public.workspaces, public.workspace_members, public.rooms, public.room_members
  from anon, authenticated;
grant select, update (name, avatar_url) on public.users to authenticated;
grant select, insert, delete, update (name) on public.workspaces to authenticated;
grant select, insert, delete, update (role) on public.workspace_members to authenticated;
grant select, insert, delete, update (name) on public.rooms to authenticated;
grant select, insert, delete on public.room_members to authenticated;

-- users: rows are created by the auth trigger and removed with the auth user.
create policy "users: read self and workspace peers" on public.users
  for select to authenticated
  using (id = (select auth.uid()) or private.shares_workspace(id));
create policy "users: update self" on public.users
  for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- workspaces: the creator check lets INSERT … RETURNING see the row before the owner trigger runs.
create policy "workspaces: read as member" on public.workspaces
  for select to authenticated
  using (created_by = (select auth.uid()) or private.is_workspace_member(id));
create policy "workspaces: create as self" on public.workspaces
  for insert to authenticated
  with check (created_by = (select auth.uid()));
create policy "workspaces: owners update" on public.workspaces
  for update to authenticated
  using (private.is_workspace_owner(id)) with check (private.is_workspace_owner(id));
create policy "workspaces: owners delete" on public.workspaces
  for delete to authenticated
  using (private.is_workspace_owner(id));

-- workspace_members
create policy "workspace_members: read roster" on public.workspace_members
  for select to authenticated
  using (private.is_workspace_member(workspace_id));
create policy "workspace_members: owners add" on public.workspace_members
  for insert to authenticated
  with check (private.is_workspace_owner(workspace_id));
create policy "workspace_members: owners change roles" on public.workspace_members
  for update to authenticated
  using (private.is_workspace_owner(workspace_id)) with check (private.is_workspace_owner(workspace_id));
create policy "workspace_members: owners remove, anyone leaves" on public.workspace_members
  for delete to authenticated
  using (user_id = (select auth.uid()) or private.is_workspace_owner(workspace_id));

-- rooms
create policy "rooms: read as workspace member" on public.rooms
  for select to authenticated
  using (private.is_workspace_member(workspace_id));
create policy "rooms: workspace members create" on public.rooms
  for insert to authenticated
  with check (created_by = (select auth.uid()) and private.is_workspace_member(workspace_id));
create policy "rooms: creator or owner updates" on public.rooms
  for update to authenticated
  using (created_by = (select auth.uid()) or private.is_workspace_owner(workspace_id))
  with check (created_by = (select auth.uid()) or private.is_workspace_owner(workspace_id));
create policy "rooms: creator or owner deletes" on public.rooms
  for delete to authenticated
  using (created_by = (select auth.uid()) or private.is_workspace_owner(workspace_id));

-- room_members: membership can't change in place, so no UPDATE policy.
create policy "room_members: read as workspace member" on public.room_members
  for select to authenticated
  using (private.is_workspace_member(private.room_workspace(room_id)));
create policy "room_members: add workspace members" on public.room_members
  for insert to authenticated
  with check (
    private.is_workspace_member(private.room_workspace(room_id))
    and private.is_member_of(private.room_workspace(room_id), user_id)
  );
create policy "room_members: leave, or creator/owner removes" on public.room_members
  for delete to authenticated
  using (
    user_id = (select auth.uid())
    or private.room_creator(room_id) = (select auth.uid())
    or private.is_workspace_owner(private.room_workspace(room_id))
  );
