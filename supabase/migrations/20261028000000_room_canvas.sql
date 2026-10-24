-- A room's canvas: its semantic document (components, relationships, the views drawn of them, notes and
-- marks, proposals, the view everyone is on), saved whole with a revision, plus every command that
-- changed it. The document's shape is the app's (src/shared/canvas, schema `vowe.canvas/1`); the
-- database keeps it whole and decides only who may change it and in what order.
--
--   room_canvases     one row per room. Members read it. Nobody writes it directly.
--   room_canvas_ops   one row per saved command, in revision order. Members read it.
--   commit_canvas()   the only way in: saves a document if the canvas is still at the revision the
--                     caller built on, and logs the command. Returns the new revision, or null if
--                     someone saved first (the app re-applies its command to theirs and tries again).
--
-- Who may change a canvas is private.can_edit_canvas: a room owner or member who is still in the
-- room's workspace. It compares the role as text so a later read-only role (a viewer) is refused
-- without this function changing.

-- ─── Tables ──────────────────────────────────────────────────────────────────

create table public.room_canvases (
  room_id uuid primary key references public.rooms (id) on delete cascade,
  revision bigint not null check (revision > 0),
  document jsonb not null check (
    jsonb_typeof(document) = 'object'
    and document ->> 'schema' = 'vowe.canvas/1'
    and pg_column_size(document) <= 1048576
  ),
  updated_by uuid references public.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

create table public.room_canvas_ops (
  room_id uuid not null references public.rooms (id) on delete cascade,
  revision bigint not null,
  command jsonb not null check (
    jsonb_typeof(command) = 'object'
    and command ->> 'schema' = 'vowe.canvas.command/1'
    and pg_column_size(command) <= 262144
  ),
  -- A person at their keyboard, or Vowe acting in that person's app.
  actor_kind text not null check (actor_kind in ('human', 'agent')),
  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (room_id, revision)
);

-- ─── Policy helpers ──────────────────────────────────────────────────────────

create function private.can_edit_canvas(room uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.room_members
    where room_id = room and user_id = (select auth.uid()) and role::text in ('owner', 'member')
  ) and private.is_workspace_member(private.room_workspace(room));
$$;

revoke execute on function private.can_edit_canvas(uuid) from public;
grant execute on function private.can_edit_canvas(uuid) to authenticated;

-- ─── Saving ──────────────────────────────────────────────────────────────────

create function public.commit_canvas(room uuid, base_revision bigint, document jsonb, command jsonb, actor_kind text default 'human')
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  saved bigint;
begin
  if (select auth.uid()) is null then
    raise exception 'sign in to change a canvas' using errcode = '42501';
  end if;
  if not private.can_edit_canvas(room) then
    raise exception 'not allowed to change this room''s canvas' using errcode = '42501';
  end if;

  if base_revision = 0 then
    insert into public.room_canvases (room_id, revision, document, updated_by)
    values (room, 1, document, (select auth.uid()))
    on conflict (room_id) do nothing
    returning revision into saved;
  else
    update public.room_canvases c
    set revision = c.revision + 1, document = commit_canvas.document, updated_by = (select auth.uid()), updated_at = now()
    where c.room_id = room and c.revision = base_revision
    returning c.revision into saved;
  end if;

  if saved is null then
    return null;
  end if;

  insert into public.room_canvas_ops (room_id, revision, command, actor_kind, created_by)
  values (room, saved, command, actor_kind, (select auth.uid()));
  return saved;
end;
$$;

revoke execute on function public.commit_canvas(uuid, bigint, jsonb, jsonb, text) from public, anon;
grant execute on function public.commit_canvas(uuid, bigint, jsonb, jsonb, text) to authenticated;

-- ─── Row-level security ──────────────────────────────────────────────────────

alter table public.room_canvases enable row level security;
alter table public.room_canvas_ops enable row level security;

revoke insert, update, delete on public.room_canvases, public.room_canvas_ops from authenticated, anon;

create policy "room_canvases: members read" on public.room_canvases
  for select to authenticated using (private.can_use_room(room_id));
create policy "room_canvas_ops: members read" on public.room_canvas_ops
  for select to authenticated using (private.can_use_room(room_id));
