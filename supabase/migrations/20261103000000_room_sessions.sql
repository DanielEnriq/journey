-- The coding sessions a room is about. A Space's repositories hold every Claude Code session anyone ran in
-- them; a room shows only the ones someone attached to it, so two rooms in one Space stop showing the same
-- list. Attaching a session is how it's shared with the room.
--
--   room_sessions  one Claude Code session attached to one room, by its session id and the Space repository
--                  it runs in. Transcripts never leave the machine that ran it: the row carries a title,
--                  the branch, and a few words of status that machine publishes when the status changes,
--                  so everyone in the room sees what it's doing and whose Mac it's on.
--
-- Owners and members attach; viewers only read. Only whoever attached a session publishes its status
-- (it runs on their machine). Whoever attached it, or a room owner, detaches it.

create table public.room_sessions (
  room_id uuid not null references public.rooms (id) on delete cascade,
  -- Claude Code's own session id.
  session_id text not null check (session_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  -- One of the Space's repositories, same shape as workspace_repositories.repository.
  repository text not null check (repository ~ '^[^\s/:@]+(/[^\s/:@]+)+$' and length(repository) <= 512),
  title text not null check (length(title) between 1 and 200),
  branch text check (length(branch) <= 255),
  attached_by uuid default auth.uid() references public.users (id) on delete set null,
  attached_at timestamptz not null default now(),
  -- What the machine running it last saw (features/work/status.ts): never more certain than its evidence.
  status text not null default 'unknown' check (status in ('active', 'completed', 'attention', 'unknown')),
  activity text check (length(activity) <= 300),
  changed_files integer check (changed_files >= 0),
  status_at timestamptz,
  primary key (room_id, session_id)
);
create index room_sessions_by_room on public.room_sessions (room_id, attached_at);

alter table public.room_sessions enable row level security;

create policy "room_sessions: members read" on public.room_sessions
  for select to authenticated using (private.can_use_room(room_id));
create policy "room_sessions: owners and members attach, from the Space's repositories" on public.room_sessions
  for insert to authenticated
  with check (
    private.can_edit_room(room_id) and attached_by = (select auth.uid())
    and exists (
      select 1 from public.workspace_repositories w
      where w.workspace_id = private.room_workspace(room_id) and lower(w.repository) = lower(room_sessions.repository)
    )
  );
create policy "room_sessions: whoever attached it publishes its status" on public.room_sessions
  for update to authenticated
  using (private.can_use_room(room_id) and attached_by = (select auth.uid()))
  with check (private.can_use_room(room_id) and attached_by = (select auth.uid()));
create policy "room_sessions: whoever attached it, or owners, detach" on public.room_sessions
  for delete to authenticated
  using (private.can_use_room(room_id) and (attached_by = (select auth.uid()) or private.is_room_owner(room_id)));

-- What a session is, and whose it is, doesn't change once attached; only what it's doing does.
revoke update on public.room_sessions from authenticated;
grant update (title, branch, status, activity, changed_files, status_at) on public.room_sessions to authenticated;

-- Everyone connected to the room re-reads its sessions when one is attached, changes, or is detached.
create function private.on_room_session_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.vowe_notify(coalesce(new.room_id, old.room_id), 'sessions');
  return null;
end;
$$;
create trigger on_room_session_change after insert or update or delete on public.room_sessions
  for each row execute function private.on_room_session_change();
revoke execute on function private.on_room_session_change() from public, authenticated;
