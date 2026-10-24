-- Rooms become private to their members. Until now every member of a workspace could read every
-- room in it and add themselves; from here, room membership is the boundary:
--
--   rooms         members read; room owners rename, re-goal, attach a repository, or delete.
--                 Workspace members create rooms and become their owner.
--   room_members  members see the roster; owners add workspace members and change roles;
--                 anyone leaves; owners remove anyone. A room always keeps an owner.
--
-- A room member must also still belong to the room's workspace (private.can_use_room), so removing
-- someone from a workspace cuts them off from its rooms, their calls, and their Realtime channels.
-- Adding people is limited to existing workspace members: there's no email invitation yet.

-- ─── Columns ─────────────────────────────────────────────────────────────────

create type public.room_role as enum ('owner', 'member');

alter table public.room_members add column role public.room_role not null default 'member';

alter table public.rooms
  -- What the room is for, in the words of whoever set it up.
  add column goal text check (length(trim(goal)) > 0),
  -- Shared repository identity, e.g. `github.com/acme/payments`: host and path of the remote, never a
  -- local checkout path (no leading slash, drive letter, scheme, or credentials). Each member maps it
  -- to their own checkout locally.
  add column repository text check (repository ~ '^[^\s/:@]+(/[^\s/:@]+)+$' and length(repository) <= 512),
  add column updated_at timestamptz not null default now();

-- Existing rooms: their creators become owners (joining them if they'd left), as long as they're
-- still in the workspace. A room whose creator has left the workspace gets its earliest member instead.
insert into public.room_members (room_id, user_id, role)
select r.id, r.created_by, 'owner'
from public.rooms r
join public.workspace_members wm on wm.workspace_id = r.workspace_id and wm.user_id = r.created_by
on conflict (room_id, user_id) do update set role = 'owner';

update public.room_members rm set role = 'owner'
from (
  select distinct on (rm.room_id) rm.room_id, rm.user_id
  from public.room_members rm
  join public.rooms r on r.id = rm.room_id
  join public.workspace_members wm on wm.workspace_id = r.workspace_id and wm.user_id = rm.user_id
  where not exists (select 1 from public.room_members o where o.room_id = rm.room_id and o.role = 'owner')
  order by rm.room_id, rm.joined_at
) first
where rm.room_id = first.room_id and rm.user_id = first.user_id;

-- ─── Policy helpers ──────────────────────────────────────────────────────────

create function private.is_room_owner(room uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.room_members
    where room_id = room and user_id = (select auth.uid()) and role = 'owner'
  ) and private.is_workspace_member(private.room_workspace(room));
$$;

-- True only between a room's insert and its owner trigger, so INSERT … RETURNING can see the new row.
create function private.room_is_new(room uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select not exists (select 1 from public.room_members where room_id = room);
$$;

revoke execute on all functions in schema private from public;
grant execute on function private.is_room_owner(uuid), private.room_is_new(uuid) to authenticated;

-- ─── Triggers ────────────────────────────────────────────────────────────────

create function private.add_room_owner()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.room_members (room_id, user_id, role) values (new.id, new.created_by, 'owner');
  return new;
end;
$$;

create trigger on_room_created
  after insert on public.rooms
  for each row execute function private.add_room_owner();

create function private.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger on_room_updated
  before update on public.rooms
  for each row execute function private.touch_updated_at();

-- Refuses to remove or demote a room's last owner; delete the room instead. Deleting the room itself,
-- or an account (no signed-in user), cascades through here and is let through.
create function private.keep_room_owner()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.role = 'owner'
    and not (tg_op = 'UPDATE' and new.role = 'owner')
    and (select auth.uid()) is not null
  then
    perform 1 from public.rooms where id = old.room_id for update; -- one owner change per room at a time
    if found and not exists (
      select 1 from public.room_members
      where room_id = old.room_id and role = 'owner' and user_id <> old.user_id
    ) then
      raise exception 'A room needs an owner: make someone else its owner first, or delete the room'
        using errcode = 'VR001';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger on_room_member_changing
  before update or delete on public.room_members
  for each row execute function private.keep_room_owner();

-- Trigger functions aren't callable through the API anyway; keep the schema's default of no access.
revoke execute on function private.add_room_owner(), private.touch_updated_at(), private.keep_room_owner()
  from public, authenticated;

-- ─── Row-level security ──────────────────────────────────────────────────────

grant update (goal, repository) on public.rooms to authenticated;
grant update (role) on public.room_members to authenticated;

drop policy "rooms: read as workspace member" on public.rooms;
drop policy "rooms: creator or owner updates" on public.rooms;
drop policy "rooms: creator or owner deletes" on public.rooms;

create policy "rooms: read as member" on public.rooms
  for select to authenticated
  using (
    private.can_use_room(id)
    or (created_by = (select auth.uid()) and private.room_is_new(id))
  );
create policy "rooms: owners update" on public.rooms
  for update to authenticated
  using (private.is_room_owner(id)) with check (private.is_room_owner(id));
create policy "rooms: owners delete" on public.rooms
  for delete to authenticated
  using (private.is_room_owner(id));

drop policy "room_members: read as workspace member" on public.room_members;
drop policy "room_members: add workspace members" on public.room_members;
drop policy "room_members: leave, or creator/owner removes" on public.room_members;

create policy "room_members: read as member" on public.room_members
  for select to authenticated
  using (private.can_use_room(room_id));
create policy "room_members: owners add workspace members" on public.room_members
  for insert to authenticated
  with check (
    private.is_room_owner(room_id)
    and private.is_member_of(private.room_workspace(room_id), user_id)
  );
create policy "room_members: owners change roles" on public.room_members
  for update to authenticated
  using (private.is_room_owner(room_id)) with check (private.is_room_owner(room_id));
create policy "room_members: leave, or owners remove" on public.room_members
  for delete to authenticated
  using (user_id = (select auth.uid()) or private.is_room_owner(room_id));
