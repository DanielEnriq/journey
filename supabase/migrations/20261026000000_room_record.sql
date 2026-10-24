-- A room's record: threads pinned to what the room is looking at and their replies, the room's
-- decisions with their versions and signatures, what happened in the room, and when each person last
-- looked. Everything here is readable and writable by the room's members only (private.can_use_room),
-- and anything that has to be trustworthy is decided here rather than by the client:
--
--   room_threads            members start threads; the author is always the signed-in user.
--   room_comments           members reply; a reply belongs to its thread's room (composite key).
--   room_decisions          members propose and amend. Changing the title or checks makes a new
--                           version (a trigger bumps it; clients can't set it), so signatures on the
--                           old version stop counting without being deleted.
--   room_decision_versions  every version as written, kept by the trigger.
--   room_signatures         a member signs the current version, as themselves, once.
--   room_activity           written by triggers on the tables above, plus calls a member reports
--                           (started or left). Members read it; nobody edits it.
--   room_visits             each member's own "last looked" marker.

-- ─── Threads ─────────────────────────────────────────────────────────────────

create type public.thread_kind as enum ('note', 'concern', 'avoid', 'constraint', 'question', 'goal');

create table public.room_threads (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  kind public.thread_kind not null default 'note',
  -- What it's pinned to: a canvas part (its id and name), or a point on the canvas (`pin`, with x/y).
  anchor_id text not null check (length(anchor_id) between 1 and 200),
  anchor_name text not null check (length(trim(anchor_name)) between 1 and 200),
  anchor_x real,
  anchor_y real,
  body text not null check (length(trim(body)) between 1 and 4000),
  created_by uuid not null default auth.uid() references public.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (id, room_id)
);
create index room_threads_room_idx on public.room_threads (room_id, created_at);

create table public.room_comments (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null,
  room_id uuid not null references public.rooms (id) on delete cascade,
  body text not null check (length(trim(body)) between 1 and 4000),
  created_by uuid not null default auth.uid() references public.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  foreign key (thread_id, room_id) references public.room_threads (id, room_id) on delete cascade
);
create index room_comments_thread_idx on public.room_comments (thread_id, created_at);

-- ─── Decisions ───────────────────────────────────────────────────────────────

create table public.room_decisions (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  title text not null check (length(trim(title)) between 1 and 500),
  -- The checks the decision commits to, `;`-separated, as written.
  verify text not null check (length(trim(verify)) between 1 and 2000),
  version integer not null default 1,
  -- Who wrote the current version.
  proposed_by uuid not null default auth.uid() references public.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index room_decisions_room_idx on public.room_decisions (room_id, created_at);

create table public.room_decision_versions (
  decision_id uuid not null references public.room_decisions (id) on delete cascade,
  version integer not null,
  title text not null,
  verify text not null,
  proposed_by uuid not null references public.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (decision_id, version)
);

create table public.room_signatures (
  decision_id uuid not null references public.room_decisions (id) on delete cascade,
  version integer not null,
  user_id uuid not null default auth.uid() references public.users (id) on delete cascade,
  signed_at timestamptz not null default now(),
  primary key (decision_id, user_id, version),
  foreign key (decision_id, version) references public.room_decision_versions (decision_id, version) on delete cascade
);

-- ─── Activity and visits ─────────────────────────────────────────────────────

create type public.room_activity_kind as enum (
  'thread', 'reply', 'decision', 'amended', 'signed', 'repository', 'call-started', 'call-left'
);

create table public.room_activity (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  actor_id uuid references public.users (id) on delete set null,
  kind public.room_activity_kind not null,
  -- What it was about, in the words it was written with (a thread's text, a decision's title, a repository).
  subject text check (length(subject) <= 500),
  version integer,
  created_at timestamptz not null default now()
);
create index room_activity_room_idx on public.room_activity (room_id, created_at desc);

create table public.room_visits (
  room_id uuid not null references public.rooms (id) on delete cascade,
  user_id uuid not null default auth.uid() references public.users (id) on delete cascade,
  seen_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

-- ─── Policy helpers ──────────────────────────────────────────────────────────

create function private.decision_room(decision uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select room_id from public.room_decisions where id = decision;
$$;

create function private.decision_version(decision uuid)
returns integer language sql stable security definer set search_path = '' as $$
  select version from public.room_decisions where id = decision;
$$;

revoke execute on all functions in schema private from public;
grant execute on function private.decision_room(uuid), private.decision_version(uuid) to authenticated;

-- ─── Triggers ────────────────────────────────────────────────────────────────

create function private.log_room_activity(room uuid, what public.room_activity_kind, about text, ver integer)
returns void language sql security definer set search_path = '' as $$
  insert into public.room_activity (room_id, actor_id, kind, subject, version)
  values (room, (select auth.uid()), what, left(about, 500), ver);
$$;

create function private.on_thread_created()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.log_room_activity(new.room_id, 'thread', new.body, null);
  return new;
end;
$$;
create trigger on_thread_created after insert on public.room_threads
  for each row execute function private.on_thread_created();

create function private.on_comment_created()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.log_room_activity(new.room_id, 'reply', new.body, null);
  return new;
end;
$$;
create trigger on_comment_created after insert on public.room_comments
  for each row execute function private.on_comment_created();

-- A new decision starts at version 1, written by whoever proposed it.
create function private.on_decision_inserting()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.version = 1;
  new.proposed_by = (select auth.uid());
  new.created_at = now();
  new.updated_at = now();
  return new;
end;
$$;
create trigger on_decision_inserting before insert on public.room_decisions
  for each row execute function private.on_decision_inserting();

-- Changing what a decision says makes it a new version; anything else keeps the version it had.
create function private.on_decision_updating()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.room_id = old.room_id;
  new.created_at = old.created_at;
  if new.title is distinct from old.title or new.verify is distinct from old.verify then
    new.version = old.version + 1;
    new.proposed_by = (select auth.uid());
    new.updated_at = now();
  else
    new.version = old.version;
    new.proposed_by = old.proposed_by;
    new.updated_at = old.updated_at;
  end if;
  return new;
end;
$$;
create trigger on_decision_updating before update on public.room_decisions
  for each row execute function private.on_decision_updating();

create function private.on_decision_written()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' or new.version <> old.version then
    insert into public.room_decision_versions (decision_id, version, title, verify, proposed_by)
    values (new.id, new.version, new.title, new.verify, new.proposed_by);
    perform private.log_room_activity(
      new.room_id, case when tg_op = 'INSERT' then 'decision' else 'amended' end::public.room_activity_kind, new.title, new.version
    );
  end if;
  return new;
end;
$$;
create trigger on_decision_written after insert or update on public.room_decisions
  for each row execute function private.on_decision_written();

create function private.on_signed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.log_room_activity(
    private.decision_room(new.decision_id),
    'signed',
    (select title from public.room_decisions where id = new.decision_id),
    new.version
  );
  return new;
end;
$$;
create trigger on_signed after insert on public.room_signatures
  for each row execute function private.on_signed();

create function private.on_room_repository_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.repository is distinct from old.repository and new.repository is not null then
    perform private.log_room_activity(new.id, 'repository', new.repository, null);
  end if;
  return new;
end;
$$;
create trigger on_room_repository_changed after update on public.rooms
  for each row execute function private.on_room_repository_changed();

-- Activity bumps the room, so the most recently changed rooms list first.
create function private.on_room_activity()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.rooms set updated_at = now() where id = new.room_id;
  return new;
end;
$$;
create trigger on_room_activity after insert on public.room_activity
  for each row execute function private.on_room_activity();

revoke execute on function
  private.log_room_activity(uuid, public.room_activity_kind, text, integer),
  private.on_thread_created(), private.on_comment_created(), private.on_decision_inserting(),
  private.on_decision_updating(), private.on_decision_written(), private.on_signed(),
  private.on_room_repository_changed(), private.on_room_activity()
  from public, authenticated;

-- ─── Row-level security ──────────────────────────────────────────────────────

alter table public.room_threads enable row level security;
alter table public.room_comments enable row level security;
alter table public.room_decisions enable row level security;
alter table public.room_decision_versions enable row level security;
alter table public.room_signatures enable row level security;
alter table public.room_activity enable row level security;
alter table public.room_visits enable row level security;

-- Clients write only these columns; ids, authors, versions and timestamps come from defaults and triggers.
revoke insert, update on public.room_threads, public.room_comments, public.room_decisions,
  public.room_decision_versions, public.room_signatures, public.room_activity, public.room_visits
  from authenticated, anon;
grant insert (room_id, kind, anchor_id, anchor_name, anchor_x, anchor_y, body) on public.room_threads to authenticated;
grant update (resolved_at) on public.room_threads to authenticated;
grant insert (thread_id, room_id, body) on public.room_comments to authenticated;
grant insert (room_id, title, verify) on public.room_decisions to authenticated;
grant update (title, verify) on public.room_decisions to authenticated;
grant insert (decision_id, version) on public.room_signatures to authenticated;
grant insert (room_id, kind) on public.room_activity to authenticated;
-- An upsert sets every column it sends, so room_id needs the update grant too; the policy keeps it yours.
grant insert (room_id, seen_at), update (room_id, seen_at) on public.room_visits to authenticated;

create policy "room_threads: members read" on public.room_threads
  for select to authenticated using (private.can_use_room(room_id));
create policy "room_threads: members start" on public.room_threads
  for insert to authenticated with check (private.can_use_room(room_id) and created_by = (select auth.uid()));
create policy "room_threads: members resolve" on public.room_threads
  for update to authenticated using (private.can_use_room(room_id)) with check (private.can_use_room(room_id));

create policy "room_comments: members read" on public.room_comments
  for select to authenticated using (private.can_use_room(room_id));
create policy "room_comments: members reply" on public.room_comments
  for insert to authenticated with check (private.can_use_room(room_id) and created_by = (select auth.uid()));

create policy "room_decisions: members read" on public.room_decisions
  for select to authenticated using (private.can_use_room(room_id));
create policy "room_decisions: members propose" on public.room_decisions
  for insert to authenticated with check (private.can_use_room(room_id));
create policy "room_decisions: members amend" on public.room_decisions
  for update to authenticated using (private.can_use_room(room_id)) with check (private.can_use_room(room_id));

create policy "room_decision_versions: members read" on public.room_decision_versions
  for select to authenticated using (private.can_use_room(private.decision_room(decision_id)));

-- Only the current version can be signed, and only as yourself. Old signatures stay, and simply stop
-- matching the decision's version once it is amended.
create policy "room_signatures: members read" on public.room_signatures
  for select to authenticated using (private.can_use_room(private.decision_room(decision_id)));
create policy "room_signatures: members sign the current version" on public.room_signatures
  for insert to authenticated with check (
    user_id = (select auth.uid())
    and private.can_use_room(private.decision_room(decision_id))
    and version = private.decision_version(decision_id)
  );

create policy "room_activity: members read" on public.room_activity
  for select to authenticated using (private.can_use_room(room_id));
-- The only activity a client reports itself: its own call joins and leaves.
create policy "room_activity: members report calls" on public.room_activity
  for insert to authenticated with check (
    private.can_use_room(room_id) and actor_id = (select auth.uid()) and kind in ('call-started', 'call-left')
  );
-- actor_id has no client grant, so the default must fill it.
alter table public.room_activity alter column actor_id set default auth.uid();

create policy "room_visits: your own" on public.room_visits
  for select to authenticated using (user_id = (select auth.uid()) and private.can_use_room(room_id));
create policy "room_visits: mark your own" on public.room_visits
  for insert to authenticated with check (user_id = (select auth.uid()) and private.can_use_room(room_id));
create policy "room_visits: move your own" on public.room_visits
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and private.can_use_room(room_id));
