-- A Space (a workspace) links its repositories once, and every room in it can use all of them. Until
-- now each room named one repository of its own; work routinely spans several, and a room shouldn't
-- have to be set up before anyone can talk in it.
--
--   workspace_repositories  the Space's repositories, by shared identity (never a local path). Members
--                           read and link them; whoever linked one, or a Space owner, unlinks it.
--   rooms.kept_at           when the room was kept. A room starts quick: somewhere to look at the code
--                           or think something through. It's kept once it holds work (a decision or a
--                           plan) or someone keeps it; a quick room that goes quiet falls out of the
--                           sidebar into Earlier. Nothing is deleted either way.
--
-- rooms.repository stays for now, read as the room's first repository, so clients that still read it
-- keep working; a later migration drops it.

-- ─── The Space's repositories ────────────────────────────────────────────────

create table public.workspace_repositories (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- Same shape as rooms.repository: host and path of the remote, e.g. `github.com/acme/payments`.
  repository text not null check (repository ~ '^[^\s/:@]+(/[^\s/:@]+)+$' and length(repository) <= 512),
  added_by uuid default auth.uid() references public.users (id) on delete set null,
  added_at timestamptz not null default now(),
  primary key (workspace_id, repository)
);
-- Hosts are lowercased by the client but paths keep their case; one repository is one row either way.
create unique index workspace_repositories_one_each on public.workspace_repositories (workspace_id, lower(repository));

alter table public.workspace_repositories enable row level security;

create policy "workspace_repositories: members read" on public.workspace_repositories
  for select to authenticated using (private.is_workspace_member(workspace_id));
create policy "workspace_repositories: members link" on public.workspace_repositories
  for insert to authenticated
  with check (private.is_workspace_member(workspace_id) and added_by = (select auth.uid()));
create policy "workspace_repositories: whoever linked it, or owners, unlink" on public.workspace_repositories
  for delete to authenticated
  using (private.is_workspace_member(workspace_id)
    and (added_by = (select auth.uid()) or private.is_workspace_owner(workspace_id)));

-- Every repository a room already names becomes its Space's, linked by whoever made the earliest room.
insert into public.workspace_repositories (workspace_id, repository, added_by, added_at)
select distinct on (r.workspace_id, lower(r.repository)) r.workspace_id, r.repository, r.created_by, r.created_at
from public.rooms r
where r.repository is not null
order by r.workspace_id, lower(r.repository), r.created_at;

-- ─── Quick and kept rooms ────────────────────────────────────────────────────

alter table public.rooms add column kept_at timestamptz;

-- Rooms made before this all count as kept: they were made to last. Without bumping updated_at, so the
-- sidebar's order doesn't change.
alter table public.rooms disable trigger on_room_updated;
update public.rooms set kept_at = created_at;
alter table public.rooms enable trigger on_room_updated;

-- Keeps a room, or lets it be quick again. Owners and members; viewers only read.
create function public.keep_room(room uuid, keep boolean)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare
  kept timestamptz;
begin
  if not private.can_edit_room(room) then
    raise exception 'Only the room''s owners and members can keep it' using errcode = '42501';
  end if;
  update public.rooms
  set kept_at = case when keep then coalesce(kept_at, now()) end
  where id = room
  returning kept_at into kept;
  return kept;
end;
$$;
revoke execute on function public.keep_room(uuid, boolean) from public, anon;
grant execute on function public.keep_room(uuid, boolean) to authenticated;

-- A decision or a plan is work worth keeping: the room keeps itself.
create function private.keep_room_with_work()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.rooms set kept_at = now() where id = new.room_id and kept_at is null;
  return new;
end;
$$;
create trigger keep_room_on_decision after insert on public.room_decisions
  for each row execute function private.keep_room_with_work();
create trigger keep_room_on_work after insert on public.room_work
  for each row execute function private.keep_room_with_work();

revoke execute on function private.keep_room_with_work() from public, authenticated;
