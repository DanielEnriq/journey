-- The Vowe room's record: what the Desk draws on top of the room record (*_room_record.sql).
--
--   room_threads (+)        what a thread is about (a part, pin, edge, scenario, decision, decision line,
--                           work, plan step, PR or check), the passage it quotes, and who it waits on.
--   thread_links            other subjects one thread also concerns; threads are never copied.
--   room_comments (+)       an agent reply may carry an offer; a person accepts or dismisses it, and that
--                           only records the answer.
--   room_decisions (+)      the thread it came from and the parts it covers.
--   room_decision_versions  (+) each version is a document with its own state: suggested, draft, review,
--                           agreed, superseded, dismissed; the prose (`doc`), and what it revises.
--   decision_lines          typed lines of one version (decide, because, assume, open, scope).
--   decision_alternatives   alternatives considered in one version.
--   decision_reviewers      who is asked to sign one version, and any changes they requested.
--   room_work               work and its plan's working copy (objective, steps, boundaries, doer).
--   plan_versions           snapshots of a plan; an approved one is immutable, enforced here.
--   plan_revisions          suggested changes to a plan (by a person or Vowe), and
--   plan_changes            each change, accepted or rejected on its own.
--   work_log                who changed a plan, newest last.
--   work_questions          a doer's questions and their answers.
--   work_scope_requests     a doer asking for more than was authorized, and the answer.
--   work_findings           what a doer found.
--   work_prs                PRs people track on work (no GitHub sync: what people enter).
--   attention_done          each person's own "done" marks for For you items.
--   workspaces.agent_name   the assistant's displayed name in the workspace ("Vowe" by default).
--   rooms.vowe              whether Vowe is on in the room.
--
-- Every write goes through the SECURITY DEFINER functions below (public.vowe_*), which decide who may do
-- what, set authors, versions and timestamps, log activity and tell the room's channel that the record
-- changed. Clients only read (RLS: the room's members), except their own attention marks.
--
-- Roles (private.vowe_require):
--   comment  owner, member, viewer   threads, replies, links, your own attention marks
--   write    owner, member           decisions and plans, offers, questions, new work, request signatures
--   sign     owner, member           sign a decision version, request changes
--   govern   plan owner or room owner   authorize a plan version, allow scope, resolve work
-- Content Vowe writes is saved from a person's session (as theirs) with author_kind = 'agent', the same
-- arrangement as room_comments.author_kind. Signing, requesting signatures, accepting suggestions,
-- authorizing, allowing scope and resolving refuse actor_kind = 'agent'.
--
-- Errors: SQLSTATE VW404 (not found), VW403 (not permitted), VW409 (conflict: a stale version, or a signed
-- or approved version that can't change), VW422 (invalid input), VW412 (the row moved while main was
-- applying a plan op; main reloads and retries). The message says why.

-- ─── Helpers ─────────────────────────────────────────────────────────────────

create function private.vowe_fail(state text, message text)
returns void language plpgsql set search_path = '' as $$
begin
  raise exception '%', message using errcode = state;
end;
$$;

-- Your role in a room, or a not-found error if you can't use it (rooms are private to their members).
create function private.vowe_require(room uuid, need text)
returns public.room_role language plpgsql security definer set search_path = '' as $$
declare
  r public.room_role := private.room_role_of(room);
begin
  if (select auth.uid()) is null then perform private.vowe_fail('VW403', 'Sign in to use rooms'); end if;
  if r is null then perform private.vowe_fail('VW404', 'No such room, or you are not a member of it'); end if;
  if need in ('write', 'sign') and r::text not in ('owner', 'member') then
    perform private.vowe_fail('VW403', 'Viewers can read and comment, but can''t change the record');
  end if;
  return r;
end;
$$;

create function private.vowe_kind(actor_kind text)
returns text language plpgsql set search_path = '' as $$
begin
  if actor_kind is null or actor_kind not in ('human', 'agent') then
    perform private.vowe_fail('VW422', 'actor_kind must be human or agent');
  end if;
  return actor_kind;
end;
$$;

-- Acts that are always one person's: never Vowe's.
create function private.vowe_person(actor_kind text, what text)
returns void language plpgsql set search_path = '' as $$
begin
  if private.vowe_kind(actor_kind) <> 'human' then
    perform private.vowe_fail('VW403', 'Vowe can''t ' || what || ': that is a person''s call');
  end if;
end;
$$;

create function private.vowe_text(value text, what text, max integer, allow_empty boolean default false)
returns text language plpgsql set search_path = '' as $$
declare
  t text := trim(coalesce(value, ''));
begin
  if t = '' and not allow_empty then perform private.vowe_fail('VW422', what || ' must not be empty'); end if;
  if length(t) > max then perform private.vowe_fail('VW422', what || ' must be at most ' || max || ' characters'); end if;
  return t;
end;
$$;

-- A JSON array of strings (a plan's boundaries, a decision's checks).
create function private.vowe_strings(value jsonb, what text)
returns jsonb language plpgsql set search_path = '' as $$
begin
  if value is null then return '[]'::jsonb; end if;
  if jsonb_typeof(value) <> 'array' or jsonb_array_length(value) > 100
     or exists (select 1 from jsonb_array_elements(value) e where jsonb_typeof(e) <> 'string' or length(e #>> '{}') > 1000) then
    perform private.vowe_fail('VW422', what || ' must be a list of at most 100 texts');
  end if;
  return value;
end;
$$;

-- Tells everyone connected to the room that its record changed (the same event members send each other,
-- RoomEvents['record:changed']). Best effort: a missing Realtime never fails the write.
create function private.vowe_notify(room uuid, what text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform realtime.send(
      jsonb_build_object(
        'id', gen_random_uuid(),
        'type', 'record:changed',
        'payload', jsonb_build_object('what', what),
        'senderId', coalesce((select auth.uid())::text, ''),
        'sentAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ),
      'room-event', 'room:' || room::text, true
    );
  exception when others then null;
  end;
end;
$$;

-- Activity now also says which object it was about, so "since you were here" can open it.
alter table public.room_activity add column subject_id text check (length(subject_id) <= 200);

create function private.vowe_log(room uuid, what public.room_activity_kind, about text, ver integer, sid text)
returns void language sql security definer set search_path = '' as $$
  insert into public.room_activity (room_id, actor_id, kind, subject, version, subject_id)
  values (room, (select auth.uid()), what, left(about, 500), ver, sid);
$$;

-- The existing record triggers, now with the object's id.
create or replace function private.on_thread_created()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.vowe_log(new.room_id, 'thread', new.body, null, new.id::text);
  return new;
end;
$$;

create or replace function private.on_comment_created()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.vowe_log(new.room_id, 'reply', new.body, null, new.thread_id::text);
  return new;
end;
$$;

create or replace function private.on_signed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.vowe_log(
    private.decision_room(new.decision_id), 'signed',
    (select title from public.room_decisions where id = new.decision_id), new.version, new.decision_id::text
  );
  return new;
end;
$$;

-- ─── Threads ─────────────────────────────────────────────────────────────────

alter table public.room_threads
  add column about_kind text not null default 'part'
    check (about_kind in ('part', 'edge', 'scenario', 'decision', 'line', 'work', 'step', 'pr', 'check')),
  -- The decision for a line, the work for a step, the PR for a check.
  add column about_parent text check (length(about_parent) <= 200),
  add column quote text check (length(quote) <= 2000),
  add column waiting_on uuid references public.users (id) on delete set null,
  add column author_kind text not null default 'human' check (author_kind in ('human', 'agent')),
  add constraint room_threads_about_parent check (about_kind not in ('line', 'step', 'check') or about_parent is not null);

create table public.thread_links (
  thread_id uuid not null,
  room_id uuid not null references public.rooms (id) on delete cascade,
  about_kind text not null check (about_kind in ('part', 'edge', 'scenario', 'decision', 'line', 'work', 'step', 'pr', 'check')),
  about_id text not null check (length(about_id) between 1 and 200),
  about_parent text check (length(about_parent) <= 200),
  about_name text not null check (length(about_name) between 1 and 200),
  created_by uuid not null references public.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (thread_id, about_kind, about_id),
  foreign key (thread_id, room_id) references public.room_threads (id, room_id) on delete cascade
);

-- Offers: Vowe proposing to make something from the conversation. Only answers are recorded here.
alter table public.room_comments
  add column offer jsonb check (offer is null or (jsonb_typeof(offer) = 'object'
    and offer ->> 'kind' in ('decision', 'work', 'revision', 'edit') and length(offer ->> 'text') between 1 and 1000)),
  add column offer_state text check (offer_state in ('open', 'accepted', 'dismissed')),
  add column offer_by uuid references public.users (id) on delete set null,
  add column offer_at timestamptz,
  add constraint room_comments_offer_state check ((offer is null) = (offer_state is null));

-- Replying to a thread that waits on you means it no longer does.
create function private.on_comment_answers()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.author_kind = 'human' then
    update public.room_threads set waiting_on = null where id = new.thread_id and waiting_on = new.created_by;
  end if;
  return null;
end;
$$;
create trigger on_comment_answers after insert on public.room_comments
  for each row execute function private.on_comment_answers();

-- ─── Decisions ───────────────────────────────────────────────────────────────

-- A drafted decision may not have its checks yet.
alter table public.room_decisions drop constraint room_decisions_verify_check;
alter table public.room_decisions
  add constraint room_decisions_verify_check check (length(verify) <= 2000),
  add column from_thread uuid references public.room_threads (id) on delete set null,
  add column parts text[] not null default '{}' check (cardinality(parts) <= 100);

create type public.decision_state as enum ('suggested', 'draft', 'review', 'agreed', 'superseded', 'dismissed');

alter table public.room_decision_versions
  add column state public.decision_state not null default 'review',
  add column revises_version integer,
  add column revises_why text check (length(revises_why) <= 2000),
  -- problem, rationale, tradeoffs[], consequences[] (each { text, by: { who, how } }), against[] (evidence ids).
  add column doc jsonb check (doc is null or jsonb_typeof(doc) = 'object'),
  add column author_kind text not null default 'human' check (author_kind in ('human', 'agent'));

-- Versions written before this: earlier ones were replaced; a current one everyone signed is agreed.
update public.room_decision_versions v set state = 'superseded'
from public.room_decisions d where d.id = v.decision_id and v.version < d.version;

create table public.decision_lines (
  id uuid primary key default gen_random_uuid(),
  decision_id uuid not null,
  version integer not null,
  room_id uuid not null references public.rooms (id) on delete cascade,
  position integer not null,
  kind text not null check (kind in ('decide', 'because', 'assume', 'open', 'scope')),
  text text not null check (length(trim(text)) between 1 and 2000),
  created_by uuid not null references public.users (id) on delete cascade,
  author_kind text not null default 'human' check (author_kind in ('human', 'agent')),
  how text not null default 'stated' check (how in ('stated', 'inferred', 'edited', 'observed')),
  basis text check (basis in ('observed', 'inferred', 'hypothetical', 'decided')),
  evidence text[] not null default '{}',
  was text check (length(was) <= 2000),
  -- A suggested edit not yet taken: { text, by (user id or 'vowe'), why }.
  suggest jsonb check (suggest is null or (jsonb_typeof(suggest) = 'object' and length(suggest ->> 'text') between 1 and 2000)),
  edited_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (decision_id, version) references public.room_decision_versions (decision_id, version) on delete cascade
);
create index decision_lines_version_idx on public.decision_lines (decision_id, version, position);

create table public.decision_alternatives (
  id uuid primary key default gen_random_uuid(),
  decision_id uuid not null,
  version integer not null,
  room_id uuid not null references public.rooms (id) on delete cascade,
  position integer not null,
  title text not null check (length(trim(title)) between 1 and 500),
  why text not null default '' check (length(why) <= 2000),
  state text not null default 'open' check (state in ('open', 'set-aside')),
  created_by uuid not null references public.users (id) on delete cascade,
  author_kind text not null default 'human' check (author_kind in ('human', 'agent')),
  created_at timestamptz not null default now(),
  foreign key (decision_id, version) references public.room_decision_versions (decision_id, version) on delete cascade
);

create table public.decision_reviewers (
  decision_id uuid not null,
  version integer not null,
  room_id uuid not null references public.rooms (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  changes_text text check (length(changes_text) <= 2000),
  requested_by uuid references public.users (id) on delete set null,
  requested_at timestamptz not null default now(),
  primary key (decision_id, version, user_id),
  foreign key (decision_id, version) references public.room_decision_versions (decision_id, version) on delete cascade
);

-- Is anyone's signature on this version? Then what it says can't change (amend instead).
create function private.version_signed(decision uuid, ver integer)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.room_signatures where decision_id = decision and version = ver);
$$;

create function private.version_state(decision uuid, ver integer)
returns public.decision_state language sql stable security definer set search_path = '' as $$
  select state from public.room_decision_versions where decision_id = decision and version = ver;
$$;

-- Lines and alternatives of a signed (or agreed, superseded, dismissed) version are frozen, whoever writes.
create function private.guard_decision_content()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  row_decision uuid := case when tg_op = 'DELETE' then old.decision_id else new.decision_id end;
  row_version integer := case when tg_op = 'DELETE' then old.version else new.version end;
  st public.decision_state := private.version_state(row_decision, row_version);
begin
  -- Deleting the decision (or its room) cascades through here once the version is gone.
  if tg_op = 'DELETE' and st is null then return old; end if;
  if private.version_signed(row_decision, row_version) or st not in ('suggested', 'draft', 'review') then
    perform private.vowe_fail('VW409', 'This version is signed or settled; amend the decision to change it');
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
create trigger guard_decision_lines before insert or update or delete on public.decision_lines
  for each row execute function private.guard_decision_content();
create trigger guard_decision_alternatives before insert or update or delete on public.decision_alternatives
  for each row execute function private.guard_decision_content();

-- A version's words (title, checks, prose) can't change once anyone signed it. Its state still moves.
create function private.guard_decision_version()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (new.title is distinct from old.title or new.verify is distinct from old.verify or new.doc is distinct from old.doc
      or new.version <> old.version or new.decision_id <> old.decision_id)
     and private.version_signed(old.decision_id, old.version) then
    perform private.vowe_fail('VW409', 'This version is signed; amend the decision to change it');
  end if;
  return new;
end;
$$;
create trigger guard_decision_version before update on public.room_decision_versions
  for each row execute function private.guard_decision_version();

-- Amending the Vowe way opens the next version as a draft without changing the title or checks; the
-- functions below say so for the one statement that does it. Clients can't set this (no SQL access).
create or replace function private.on_decision_updating()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.room_id = old.room_id;
  new.created_at = old.created_at;
  if new.title is distinct from old.title or new.verify is distinct from old.verify
     or coalesce(current_setting('vowe.amend', true), '') = 'on' then
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

-- The older path (record:amend changes the title or checks) replaces the version at once; the Vowe amend
-- keeps an agreed version agreed until its successor is agreed.
create or replace function private.on_decision_written()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  vowe boolean := coalesce(current_setting('vowe.amend', true), '') = 'on';
begin
  if tg_op = 'INSERT' or new.version <> old.version then
    insert into public.room_decision_versions (decision_id, version, title, verify, proposed_by, state)
    values (new.id, new.version, new.title, new.verify, new.proposed_by, case when vowe then 'draft' else 'review' end::public.decision_state);
    if tg_op = 'UPDATE' then
      update public.room_decision_versions set state = 'superseded'
      where decision_id = new.id and version < new.version
        and (state in ('draft', 'review', 'suggested') or (not vowe and state = 'agreed'));
    end if;
    perform private.vowe_log(
      new.room_id, case when tg_op = 'INSERT' then 'decision' else 'amended' end::public.room_activity_kind,
      new.title, new.version, new.id::text
    );
  end if;
  return new;
end;
$$;

-- Who must sign a version: those asked (decision_reviewers), or, for a decision nobody asked anyone about
-- (the older record:propose path), every owner and member of the room.
create function private.version_approvers(decision uuid, ver integer)
returns setof uuid language sql stable security definer set search_path = '' as $$
  select user_id from public.decision_reviewers where decision_id = decision and version = ver
  union
  select m.user_id from public.room_members m
  where m.room_id = private.decision_room(decision) and m.role::text in ('owner', 'member')
    and not exists (select 1 from public.decision_reviewers where decision_id = decision and version = ver);
$$;

-- A version in review is agreed once every approver has signed it; an agreed predecessor is then superseded.
create function private.on_signed_agree()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  room uuid := private.decision_room(new.decision_id);
begin
  if private.version_state(new.decision_id, new.version) = 'review'
     and not exists (
       select 1 from private.version_approvers(new.decision_id, new.version) a(who)
       where not exists (select 1 from public.room_signatures s where s.decision_id = new.decision_id and s.version = new.version and s.user_id = a.who)
     ) then
    update public.room_decision_versions set state = 'agreed' where decision_id = new.decision_id and version = new.version;
    update public.room_decision_versions set state = 'superseded'
    where decision_id = new.decision_id and version < new.version and state in ('agreed', 'draft', 'review', 'suggested');
    perform private.vowe_log(room, 'agreed', (select title from public.room_decisions where id = new.decision_id), new.version, new.decision_id::text);
  end if;
  return null;
end;
$$;
create trigger on_signed_agree after insert on public.room_signatures
  for each row execute function private.on_signed_agree();

-- Signatures only on a version that asks for them (in review), or one already agreed (a late co-signer).
create policy "room_signatures: only versions in review" on public.room_signatures
  as restrictive for insert to authenticated
  with check (private.version_state(decision_id, version) in ('review', 'agreed'));

-- Current versions that everyone already signed are agreed (rows written before this migration).
update public.room_decision_versions v set state = 'agreed'
from public.room_decisions d
where d.id = v.decision_id and v.version = d.version and v.state = 'review'
  and not exists (
    select 1 from public.room_members m
    where m.room_id = d.room_id and m.role::text in ('owner', 'member')
      and not exists (select 1 from public.room_signatures s where s.decision_id = d.id and s.version = d.version and s.user_id = m.user_id)
  );

-- ─── Work and plans ──────────────────────────────────────────────────────────

create table public.room_work (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  title text not null check (length(trim(title)) between 1 and 500),
  -- The plan's working copy (Work.why / plan / may / mayNot / askWhen / accept), at `version`.
  why text not null default '' check (length(why) <= 4000),
  plan jsonb not null default '[]' check (jsonb_typeof(plan) = 'array'),
  may jsonb not null default '[]' check (jsonb_typeof(may) = 'array'),
  may_not jsonb not null default '[]' check (jsonb_typeof(may_not) = 'array'),
  ask_when jsonb not null default '[]' check (jsonb_typeof(ask_when) = 'array'),
  accept jsonb not null default '[]' check (jsonb_typeof(accept) = 'array'),
  context jsonb not null default '[]' check (jsonb_typeof(context) = 'array'),
  version integer not null default 1,
  -- Bumped on every write, so main can apply a plan op to exactly the row it read.
  rev bigint not null default 0,
  decision_id uuid references public.room_decisions (id) on delete set null,
  decision_version integer,
  thread_id uuid references public.room_threads (id) on delete set null,
  repo text not null default '' check (length(repo) <= 512),
  parts text[] not null default '{}' check (cardinality(parts) <= 100),
  owner_id uuid not null references public.users (id) on delete cascade,
  doer jsonb check (doer is null or (doer ->> 'kind' in ('agent', 'person') and length(doer ->> 'name') between 1 and 100)),
  state text not null default 'draft'
    check (state in ('draft', 'proposed', 'authorized', 'running', 'waiting', 'review', 'resolved', 'closed')),
  depends_on uuid references public.room_work (id) on delete set null,
  blocks uuid references public.room_work (id) on delete set null,
  exec jsonb not null default '{"where": "a worktree", "prs": "per-step"}'
    check (exec ->> 'prs' in ('per-step', 'grouped') and length(exec ->> 'where') between 1 and 200),
  verified_by jsonb check (verified_by is null or jsonb_typeof(verified_by) = 'object'),
  authorized_by uuid references public.users (id) on delete set null,
  authorized_at timestamptz,
  authorized_version integer,
  authorized_scope text,
  resolved_by uuid references public.users (id) on delete set null,
  resolved_at timestamptz,
  created_by uuid not null references public.users (id) on delete cascade,
  author_kind text not null default 'human' check (author_kind in ('human', 'agent')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, room_id)
);
create index room_work_room_idx on public.room_work (room_id, created_at);

create table public.plan_versions (
  work_id uuid not null references public.room_work (id) on delete cascade,
  version integer not null,
  room_id uuid not null references public.rooms (id) on delete cascade,
  -- PlanBody: objective, plan steps, may, mayNot, askWhen, accept.
  body jsonb not null check (jsonb_typeof(body) = 'object'),
  doer jsonb,
  prs text not null default 'per-step',
  shaped_by uuid[] not null default '{}',
  -- { doer, scope, includes[] } once authorized; null while it's a plain snapshot.
  approved jsonb,
  approved_by uuid references public.users (id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (work_id, version),
  check ((approved is null) = (approved_by is null))
);

-- An approved version is what someone authorized: nobody changes or removes it, through any path.
create function private.guard_plan_version()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.approved_by is not null and exists (select 1 from public.room_work where id = old.work_id) then
      perform private.vowe_fail('VW409', 'An approved plan version can''t be removed');
    end if;
    return old;
  end if;
  if old.approved_by is not null then
    perform private.vowe_fail('VW409', 'Plan v' || old.version || ' is approved and frozen; edits open a new draft');
  end if;
  if new.work_id <> old.work_id or new.version <> old.version then
    perform private.vowe_fail('VW409', 'A plan version keeps its place');
  end if;
  return new;
end;
$$;
create trigger guard_plan_version before update or delete on public.plan_versions
  for each row execute function private.guard_plan_version();

create table public.plan_revisions (
  id uuid primary key default gen_random_uuid(),
  work_id uuid not null references public.room_work (id) on delete cascade,
  room_id uuid not null references public.rooms (id) on delete cascade,
  base_version integer not null,
  created_by uuid not null references public.users (id) on delete cascade,
  author_kind text not null default 'human' check (author_kind in ('human', 'agent')),
  why text not null check (length(trim(why)) between 1 and 2000),
  from_thread uuid references public.room_threads (id) on delete set null,
  created_at timestamptz not null default now(),
  closed_at timestamptz
);
create index plan_revisions_work_idx on public.plan_revisions (work_id, created_at);

create table public.plan_changes (
  id uuid primary key default gen_random_uuid(),
  revision_id uuid not null references public.plan_revisions (id) on delete cascade,
  work_id uuid not null references public.room_work (id) on delete cascade,
  room_id uuid not null references public.rooms (id) on delete cascade,
  position integer not null,
  kind text not null check (kind in ('edit', 'add', 'remove', 'move', 'promote', 'bound', 'verify')),
  step text check (length(step) <= 100),
  text text check (length(text) <= 4000),
  -- add: insert after this step; `after_set` without `after` means at the start.
  after text check (length(after) <= 100),
  after_set boolean not null default false,
  list text check (list in ('may', 'mayNot', 'askWhen')),
  title text check (length(title) <= 500),
  note text check (length(note) <= 2000),
  seed jsonb check (seed is null or jsonb_typeof(seed) = 'object'),
  state text not null default 'open' check (state in ('open', 'accepted', 'rejected')),
  decided_by uuid references public.users (id) on delete set null,
  decided_at timestamptz
);
create index plan_changes_revision_idx on public.plan_changes (revision_id, position);

create table public.work_log (
  id bigint generated always as identity primary key,
  work_id uuid not null references public.room_work (id) on delete cascade,
  room_id uuid not null references public.rooms (id) on delete cascade,
  who uuid references public.users (id) on delete set null,
  author_kind text not null default 'human' check (author_kind in ('human', 'agent')),
  text text not null check (length(text) between 1 and 500),
  at timestamptz not null default now()
);
create index work_log_work_idx on public.work_log (work_id, id);

create table public.work_questions (
  id uuid primary key default gen_random_uuid(),
  work_id uuid not null references public.room_work (id) on delete cascade,
  room_id uuid not null references public.rooms (id) on delete cascade,
  text text not null check (length(trim(text)) between 1 and 2000),
  about text not null default '' check (length(about) <= 200),
  step text check (length(step) <= 100),
  for_user uuid not null references public.users (id) on delete cascade,
  options text[] not null default '{}' check (cardinality(options) <= 10),
  answer text check (length(answer) <= 4000),
  answered_by uuid references public.users (id) on delete set null,
  answered_at timestamptz,
  deferred boolean not null default false,
  created_by uuid not null references public.users (id) on delete cascade,
  author_kind text not null default 'human' check (author_kind in ('human', 'agent')),
  created_at timestamptz not null default now()
);

create table public.work_scope_requests (
  id uuid primary key default gen_random_uuid(),
  work_id uuid not null references public.room_work (id) on delete cascade,
  room_id uuid not null references public.rooms (id) on delete cascade,
  text text not null check (length(trim(text)) between 1 and 2000),
  adds text not null check (length(trim(adds)) between 1 and 1000),
  -- Who asks, as the doer is named (e.g. "Claude Code").
  asked_as text not null check (length(trim(asked_as)) between 1 and 100),
  state text not null default 'open' check (state in ('open', 'allowed', 'refused')),
  decided_by uuid references public.users (id) on delete set null,
  decided_at timestamptz,
  created_by uuid not null references public.users (id) on delete cascade,
  author_kind text not null default 'human' check (author_kind in ('human', 'agent')),
  created_at timestamptz not null default now()
);

create table public.work_findings (
  id uuid primary key default gen_random_uuid(),
  work_id uuid not null references public.room_work (id) on delete cascade,
  room_id uuid not null references public.rooms (id) on delete cascade,
  text text not null check (length(trim(text)) between 1 and 4000),
  evidence text[] not null default '{}',
  offer text check (length(offer) <= 1000),
  created_by uuid not null references public.users (id) on delete cascade,
  author_kind text not null default 'human' check (author_kind in ('human', 'agent')),
  created_at timestamptz not null default now()
);

create table public.work_prs (
  id uuid primary key default gen_random_uuid(),
  work_id uuid not null references public.room_work (id) on delete cascade,
  room_id uuid not null references public.rooms (id) on delete cascade,
  num integer not null check (num > 0),
  title text not null check (length(trim(title)) between 1 and 500),
  state text not null check (state in ('draft', 'open', 'review', 'changes', 'merged', 'closed')),
  branch text not null default '' check (length(branch) <= 300),
  url text check (url ~ '^https://' and length(url) <= 1000),
  step text check (length(step) <= 100),
  created_by uuid not null references public.users (id) on delete cascade,
  updated_at timestamptz not null default now(),
  unique (work_id, num)
);

-- ─── Attention, the assistant's name, Vowe on or off ─────────────────────────

create table public.attention_done (
  room_id uuid not null references public.rooms (id) on delete cascade,
  user_id uuid not null default auth.uid() references public.users (id) on delete cascade,
  item_id text not null check (length(item_id) between 1 and 300),
  at timestamptz not null default now(),
  primary key (room_id, user_id, item_id)
);

alter table public.workspaces
  add column agent_name text not null default 'Vowe' check (length(trim(agent_name)) between 1 and 40);

alter table public.rooms add column vowe boolean not null default true;
grant update (vowe) on public.rooms to authenticated; -- owners only ("rooms: owners update")

-- ─── Plan content: what an authorization covers ──────────────────────────────

-- The parts of a plan that an approval freezes: the objective, the steps' ids and words, the boundaries,
-- verification, who does it and how PRs are grouped. Step progress (state, PR links) isn't content.
create function private.plan_content(objective text, steps jsonb, may jsonb, may_not jsonb, ask_when jsonb, accept jsonb, doer jsonb, prs text)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'objective', coalesce(objective, ''),
    'plan', coalesce((select jsonb_agg(jsonb_build_object('id', s ->> 'id', 'text', s ->> 'text', 'promoted', s -> 'promoted') order by n)
                      from jsonb_array_elements(coalesce(steps, '[]')) with ordinality t(s, n)), '[]'),
    'may', coalesce(may, '[]'), 'mayNot', coalesce(may_not, '[]'), 'askWhen', coalesce(ask_when, '[]'), 'accept', coalesce(accept, '[]'),
    'doer', case when doer is null or doer = 'null'::jsonb then null else jsonb_build_object('kind', doer ->> 'kind', 'name', doer ->> 'name') end,
    'prs', coalesce(prs, 'per-step')
  );
$$;

create function private.work_content(w public.room_work)
returns jsonb language sql immutable set search_path = '' as $$
  select private.plan_content(w.why, w.plan, w.may, w.may_not, w.ask_when, w.accept, w.doer, w.exec ->> 'prs');
$$;

create function private.version_content(v public.plan_versions)
returns jsonb language sql immutable set search_path = '' as $$
  select private.plan_content(v.body ->> 'objective', v.body -> 'plan', v.body -> 'may', v.body -> 'mayNot', v.body -> 'askWhen', v.body -> 'accept', v.doer, v.prs);
$$;

create function private.work_body(w public.room_work)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('objective', w.why, 'plan', w.plan, 'may', w.may, 'mayNot', w.may_not, 'askWhen', w.ask_when, 'accept', w.accept);
$$;

create function private.vowe_steps(value jsonb)
returns jsonb language plpgsql set search_path = '' as $$
begin
  if jsonb_typeof(value) <> 'array' or jsonb_array_length(value) > 200
     or exists (
       select 1 from jsonb_array_elements(value) s
       where jsonb_typeof(s) <> 'object'
          or jsonb_typeof(s -> 'id') <> 'string' or length(s ->> 'id') not between 1 and 100
          or jsonb_typeof(s -> 'text') <> 'string' or length(s ->> 'text') > 4000
          or coalesce(s ->> 'state', 'todo') not in ('todo', 'doing', 'done', 'wont')
     )
     or (select count(distinct s ->> 'id') from jsonb_array_elements(value) s) <> jsonb_array_length(value) then
    perform private.vowe_fail('VW422', 'Plan steps must be at most 200, each with a unique id and its text');
  end if;
  return value;
end;
$$;

create function private.vowe_lock_work(work uuid)
returns public.room_work language plpgsql security definer set search_path = '' as $$
declare
  w public.room_work;
begin
  select * into w from public.room_work where id = work for update;
  if w.id is null or private.room_role_of(w.room_id) is null then
    perform private.vowe_fail('VW404', 'No such work in a room of yours');
  end if;
  return w;
end;
$$;

create function private.vowe_append_log(w public.room_work, line text, kind text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  last public.work_log;
begin
  if line is null or trim(line) = '' then return; end if;
  select * into last from public.work_log where work_id = w.id order by id desc limit 1;
  if last.id is not null and last.who = (select auth.uid()) and last.text = left(trim(line), 500) and last.author_kind = kind then return; end if;
  insert into public.work_log (work_id, room_id, who, author_kind, text) values (w.id, w.room_id, (select auth.uid()), kind, left(trim(line), 500));
end;
$$;

-- Applies a change to a plan's working copy. The version is the database's call: an edit that changes
-- what a snapshot at the current version says opens the next version as a draft, whatever was asked;
-- `want_version` = current + 1 opens it explicitly (the 'revise' op), allowed only from a snapshot.
create function private.vowe_apply_plan(work uuid, patch jsonb, want_version integer, line text, kind text)
returns public.room_work language plpgsql security definer set search_path = '' as $$
declare
  w public.room_work;
  before jsonb;
  snap public.plan_versions;
  bad text;
begin
  select * into w from public.room_work where id = work;
  if patch is null then patch := '{}'::jsonb; end if;
  if jsonb_typeof(patch) <> 'object' then perform private.vowe_fail('VW422', 'A plan change must be an object'); end if;
  select k into bad from jsonb_object_keys(patch) k where k not in ('why', 'plan', 'may', 'mayNot', 'askWhen', 'accept', 'doer', 'exec') limit 1;
  if bad is not null then perform private.vowe_fail('VW422', 'A plan change can''t set ' || bad); end if;

  if patch ? 'why' then w.why := private.vowe_text(patch ->> 'why', 'The objective', 4000, true); end if;
  if patch ? 'plan' then w.plan := private.vowe_steps(patch -> 'plan'); end if;
  if patch ? 'may' then w.may := private.vowe_strings(patch -> 'may', 'What it may do'); end if;
  if patch ? 'mayNot' then w.may_not := private.vowe_strings(patch -> 'mayNot', 'What it must not do'); end if;
  if patch ? 'askWhen' then w.ask_when := private.vowe_strings(patch -> 'askWhen', 'When it must ask'); end if;
  if patch ? 'accept' then w.accept := private.vowe_strings(patch -> 'accept', 'Verification'); end if;
  if patch ? 'doer' then
    if patch -> 'doer' = 'null'::jsonb then w.doer := null;
    elsif patch -> 'doer' ->> 'kind' in ('agent', 'person') and length(trim(patch -> 'doer' ->> 'name')) between 1 and 100 then
      w.doer := jsonb_build_object('kind', patch -> 'doer' ->> 'kind', 'name', trim(patch -> 'doer' ->> 'name'));
    else perform private.vowe_fail('VW422', 'Who does it must be an agent or a person, with a name'); end if;
  end if;
  if patch ? 'exec' then
    if patch -> 'exec' ->> 'prs' not in ('per-step', 'grouped') or length(trim(coalesce(patch -> 'exec' ->> 'where', ''))) not between 1 and 200 then
      perform private.vowe_fail('VW422', 'Execution needs where it runs and how PRs are grouped');
    end if;
    w.exec := jsonb_build_object('where', trim(patch -> 'exec' ->> 'where'), 'prs', patch -> 'exec' ->> 'prs');
  end if;

  select * into snap from public.plan_versions where work_id = w.id and version = w.version;
  if snap.work_id is not null then
    if private.work_content(w) is distinct from private.version_content(snap) or want_version = w.version + 1 then
      w.version := w.version + 1;
      perform private.vowe_log(w.room_id, 'plan', w.title, w.version, w.id::text);
    end if;
  end if;

  update public.room_work set
    why = w.why, plan = w.plan, may = w.may, may_not = w.may_not, ask_when = w.ask_when, accept = w.accept,
    doer = w.doer, exec = w.exec, version = w.version, rev = rev + 1, updated_at = now()
  where id = w.id
  returning * into w;
  perform private.vowe_append_log(w, line, kind);
  return w;
end;
$$;

-- Who may authorize, allow scope on, and resolve work: its owner, or the room's owner. Always a person.
create function private.vowe_govern(w public.room_work, actor_kind text, what text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.vowe_person(actor_kind, what);
  perform private.vowe_require(w.room_id, 'sign');
  if w.owner_id <> (select auth.uid()) and private.room_role_of(w.room_id)::text <> 'owner' then
    perform private.vowe_fail('VW403', 'Only the plan''s owner or the room''s owner can ' || what);
  end if;
end;
$$;

-- ─── Writes: threads ─────────────────────────────────────────────────────────

-- A new conversation about something (`about`: { kind, id, name, decision | work | pr }). permission: comment.
create function public.vowe_create_thread(
  room uuid, about jsonb, body text, quote text default null, at_x real default null, at_y real default null,
  waiting_on uuid default null, actor_kind text default 'human'
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  kind text := about ->> 'kind';
  parent text := coalesce(about ->> 'decision', about ->> 'work', about ->> 'pr');
  made uuid;
begin
  perform private.vowe_require(room, 'comment');
  perform private.vowe_kind(actor_kind);
  if jsonb_typeof(about) <> 'object' or kind not in ('part', 'edge', 'scenario', 'decision', 'line', 'work', 'step', 'pr', 'check') then
    perform private.vowe_fail('VW422', 'A thread must be about a part, edge, scenario, decision, line, work, step, PR or check');
  end if;
  if kind in ('line', 'step', 'check') and parent is null then
    perform private.vowe_fail('VW422', 'A ' || kind || ' thread needs what it belongs to');
  end if;
  if waiting_on is not null and not exists (select 1 from public.room_members where room_id = room and user_id = waiting_on) then
    perform private.vowe_fail('VW422', 'Only someone in the room can be asked');
  end if;
  insert into public.room_threads (room_id, kind, anchor_id, anchor_name, anchor_x, anchor_y, body, created_by, about_kind, about_parent, quote, waiting_on, author_kind)
  values (
    room, case when kind = 'scenario' then 'concern' else 'note' end::public.thread_kind,
    private.vowe_text(about ->> 'id', 'What the thread is about', 200), private.vowe_text(about ->> 'name', 'Its name', 200),
    at_x, at_y, private.vowe_text(body, 'Thread text', 4000), (select auth.uid()), kind, parent,
    nullif(private.vowe_text(quote, 'The quoted passage', 2000, true), ''), waiting_on, actor_kind
  ) returning id into made;
  perform private.vowe_notify(room, 'thread');
  return made;
end;
$$;

-- A reply. Only Vowe's replies may carry an offer ({ kind, text, target? }), which starts open.
create function public.vowe_reply(room uuid, thread uuid, body text, actor_kind text default 'human', offer jsonb default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  made uuid;
begin
  perform private.vowe_require(room, 'comment');
  if offer is not null and private.vowe_kind(actor_kind) <> 'agent' then
    perform private.vowe_fail('VW422', 'Only Vowe makes offers in a thread');
  end if;
  if not exists (select 1 from public.room_threads where id = thread and room_id = room) then
    perform private.vowe_fail('VW404', 'No such thread in this room');
  end if;
  insert into public.room_comments (thread_id, room_id, body, created_by, author_kind, offer, offer_state)
  values (thread, room, private.vowe_text(body, 'Reply', 4000), (select auth.uid()), private.vowe_kind(actor_kind),
          case when offer is null then null else jsonb_strip_nulls(jsonb_build_object('kind', offer ->> 'kind', 'text', offer ->> 'text', 'target', offer ->> 'target')) end,
          case when offer is null then null else 'open' end)
  returning id into made;
  perform private.vowe_notify(room, 'reply');
  return made;
end;
$$;

-- Accept or dismiss an offer: records the answer only. permission: write; a person.
create function public.vowe_answer_offer(room uuid, thread uuid, reply uuid, accept boolean, actor_kind text default 'human')
returns void language plpgsql security definer set search_path = '' as $$
declare
  st text;
begin
  perform private.vowe_person(actor_kind, 'answer an offer');
  perform private.vowe_require(room, 'write');
  select offer_state into st from public.room_comments where id = reply and thread_id = thread and room_id = room for update;
  if not found or st is null then perform private.vowe_fail('VW404', 'No such offer in this thread'); end if;
  if st <> 'open' then perform private.vowe_fail('VW409', 'Someone already answered this offer'); end if;
  update public.room_comments set offer_state = case when accept then 'accepted' else 'dismissed' end,
    offer_by = (select auth.uid()), offer_at = now()
  where id = reply;
  perform private.vowe_notify(room, 'reply');
end;
$$;

-- Another subject this conversation concerns. permission: comment.
create function public.vowe_link_thread(room uuid, thread uuid, about jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.vowe_require(room, 'comment');
  if about ->> 'kind' not in ('part', 'edge', 'scenario', 'decision', 'line', 'work', 'step', 'pr', 'check') then
    perform private.vowe_fail('VW422', 'Unknown subject kind');
  end if;
  if not exists (select 1 from public.room_threads where id = thread and room_id = room) then
    perform private.vowe_fail('VW404', 'No such thread in this room');
  end if;
  insert into public.thread_links (thread_id, room_id, about_kind, about_id, about_parent, about_name, created_by)
  values (thread, room, about ->> 'kind', private.vowe_text(about ->> 'id', 'Subject id', 200),
          coalesce(about ->> 'decision', about ->> 'work', about ->> 'pr'), private.vowe_text(about ->> 'name', 'Subject name', 200), (select auth.uid()))
  on conflict do nothing;
  perform private.vowe_notify(room, 'thread');
end;
$$;

-- ─── Writes: decisions ───────────────────────────────────────────────────────

-- The decision version a write names, locked, in a room you can use with `need`.
create function private.vowe_version(decision uuid, ver integer, need text)
returns public.room_decision_versions language plpgsql security definer set search_path = '' as $$
declare
  room uuid := private.decision_room(decision);
  v public.room_decision_versions;
begin
  if room is null or private.room_role_of(room) is null then perform private.vowe_fail('VW404', 'No such decision in a room of yours'); end if;
  perform private.vowe_require(room, need);
  perform 1 from public.room_decisions where id = decision for update;
  select * into v from public.room_decision_versions where decision_id = decision and version = ver for update;
  if v.decision_id is null then perform private.vowe_fail('VW404', 'No such version of this decision'); end if;
  if ver <> private.decision_version(decision) then
    perform private.vowe_fail('VW409', 'v' || ver || ' isn''t the current version any more; read v' || private.decision_version(decision));
  end if;
  return v;
end;
$$;

-- A new decision: a draft from a person, or a suggestion from Vowe. Never in review, never signed.
create function public.vowe_create_decision(
  room uuid, title text, line text default null, from_thread uuid default null, problem text default null, actor_kind text default 'human'
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  kind text := private.vowe_kind(actor_kind);
  me uuid := (select auth.uid());
  made uuid;
begin
  perform private.vowe_require(room, 'write');
  if from_thread is not null and not exists (select 1 from public.room_threads where id = from_thread and room_id = room) then
    perform private.vowe_fail('VW404', 'No such thread in this room');
  end if;
  insert into public.room_decisions (room_id, title, verify, from_thread)
  values (room, private.vowe_text(title, 'Decision', 500), '', from_thread) returning id into made;
  update public.room_decision_versions set
    state = case when kind = 'agent' then 'suggested' else 'draft' end::public.decision_state,
    author_kind = kind,
    doc = jsonb_build_object(
      'problem', jsonb_build_object('text', private.vowe_text(problem, 'The problem', 4000, true),
                                    'by', jsonb_build_object('who', case when kind = 'agent' then 'vowe' else me::text end, 'how', case when kind = 'agent' then 'inferred' else 'stated' end)),
      'tradeoffs', '[]'::jsonb, 'consequences', '[]'::jsonb)
  where decision_id = made and version = 1;
  if nullif(trim(coalesce(line, '')), '') is not null then
    insert into public.decision_lines (decision_id, version, room_id, position, kind, text, created_by, author_kind, how, basis)
    values (made, 1, room, 0, 'decide', private.vowe_text(line, 'The decision line', 2000), me, kind,
            case when kind = 'agent' then 'inferred' else 'stated' end, case when kind = 'agent' then 'inferred' else 'decided' end);
  end if;
  perform private.vowe_notify(room, 'decision');
  return made;
end;
$$;

-- Adds a typed line to a version that isn't signed yet. permission: write (Vowe's lines are inferred).
create function public.vowe_add_line(decision uuid, ver integer, kind text, body text, actor_kind text default 'human')
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v public.room_decision_versions := private.vowe_version(decision, ver, 'write');
  ak text := private.vowe_kind(actor_kind);
  made uuid;
begin
  if kind not in ('decide', 'because', 'assume', 'open', 'scope') then perform private.vowe_fail('VW422', 'Unknown line kind'); end if;
  insert into public.decision_lines (decision_id, version, room_id, position, kind, text, created_by, author_kind, how, basis)
  values (decision, ver, private.decision_room(decision),
          coalesce((select max(position) + 1 from public.decision_lines where decision_id = decision and version = ver), 0),
          kind, private.vowe_text(body, 'Line', 2000), (select auth.uid()), ak,
          case when ak = 'agent' then 'inferred' else 'stated' end, case when ak = 'agent' then 'inferred' else null end)
  returning id into made;
  perform private.vowe_notify(private.decision_room(decision), 'decision');
  return made;
end;
$$;

-- Rewrites a line of the current version. Refused (VW409) once the version has a signature: amend instead.
create function public.vowe_edit_line(decision uuid, ver integer, line uuid, body text, actor_kind text default 'human')
returns void language plpgsql security definer set search_path = '' as $$
declare
  v public.room_decision_versions := private.vowe_version(decision, ver, 'write');
  ak text := private.vowe_kind(actor_kind);
begin
  update public.decision_lines set
    was = coalesce(was, text), text = private.vowe_text(body, 'Line', 2000),
    how = case when ak = 'agent' then 'inferred' else 'edited' end, author_kind = ak,
    edited_by = (select auth.uid()), updated_at = now()
  where id = line and decision_id = decision and version = ver;
  if not found then perform private.vowe_fail('VW404', 'No such line in this version'); end if;
  perform private.vowe_notify(private.decision_room(decision), 'decision');
end;
$$;

-- Suggests a line edit (a person or Vowe); someone takes or rejects it. permission: write.
create function public.vowe_suggest_line(decision uuid, ver integer, line uuid, body text, why text, actor_kind text default 'human')
returns void language plpgsql security definer set search_path = '' as $$
declare
  v public.room_decision_versions := private.vowe_version(decision, ver, 'write');
  ak text := private.vowe_kind(actor_kind);
begin
  update public.decision_lines set suggest = jsonb_build_object(
    'text', private.vowe_text(body, 'Suggested text', 2000),
    'by', case when ak = 'agent' then 'vowe' else (select auth.uid())::text end,
    'why', private.vowe_text(why, 'Why', 2000, true)), updated_at = now()
  where id = line and decision_id = decision and version = ver;
  if not found then perform private.vowe_fail('VW404', 'No such line in this version'); end if;
  perform private.vowe_notify(private.decision_room(decision), 'decision');
end;
$$;

-- Takes or rejects a suggested line edit. permission: write; a person.
create function public.vowe_take_suggestion(decision uuid, ver integer, line uuid, accept boolean, actor_kind text default 'human')
returns void language plpgsql security definer set search_path = '' as $$
declare
  v public.room_decision_versions;
  l public.decision_lines;
begin
  perform private.vowe_person(actor_kind, 'take a suggestion');
  v := private.vowe_version(decision, ver, 'write');
  select * into l from public.decision_lines where id = line and decision_id = decision and version = ver for update;
  if l.id is null or l.suggest is null then perform private.vowe_fail('VW404', 'No suggestion on that line'); end if;
  if accept then
    update public.decision_lines set was = text, text = l.suggest ->> 'text', how = 'edited', author_kind = 'human',
      edited_by = (select auth.uid()), suggest = null, updated_at = now() where id = line;
  else
    update public.decision_lines set suggest = null, updated_at = now() where id = line;
  end if;
  perform private.vowe_notify(private.decision_room(decision), 'decision');
end;
$$;

-- Rewrites the problem or the rationale of the current version (not once it's signed). permission: write.
create function public.vowe_edit_doc(decision uuid, ver integer, field text, body text, actor_kind text default 'human')
returns void language plpgsql security definer set search_path = '' as $$
declare
  v public.room_decision_versions := private.vowe_version(decision, ver, 'write');
  ak text := private.vowe_kind(actor_kind);
  next_doc jsonb := coalesce(v.doc, jsonb_build_object('problem', jsonb_build_object('text', '', 'by', jsonb_build_object('who', (select auth.uid())::text)), 'tradeoffs', '[]'::jsonb, 'consequences', '[]'::jsonb));
begin
  if field not in ('problem', 'rationale') then perform private.vowe_fail('VW422', 'Only the problem or the rationale can be edited here'); end if;
  if v.state not in ('suggested', 'draft', 'review') then perform private.vowe_fail('VW409', 'This version is settled; amend the decision to change it'); end if;
  next_doc := jsonb_set(next_doc, array[field], jsonb_build_object(
    'text', private.vowe_text(body, 'Text', 4000, true),
    'by', jsonb_build_object('who', coalesce(next_doc #>> array[field, 'by', 'who'], case when ak = 'agent' then 'vowe' else (select auth.uid())::text end),
                             'how', case when ak = 'agent' then 'inferred' else 'edited' end)));
  update public.room_decision_versions set doc = next_doc where decision_id = decision and version = ver;
  perform private.vowe_notify(private.decision_room(decision), 'decision');
end;
$$;

-- Moves a draft to review and asks people to sign it: the requester (if they may sign) and everyone in
-- `who`, each an owner or member of the room. `who` may be empty. permission: write; a person.
create function public.vowe_request_signatures(decision uuid, ver integer, who uuid[], actor_kind text default 'human')
returns void language plpgsql security definer set search_path = '' as $$
declare
  v public.room_decision_versions;
  room uuid := private.decision_room(decision);
  me uuid := (select auth.uid());
  person uuid;
begin
  perform private.vowe_person(actor_kind, 'ask for signatures');
  v := private.vowe_version(decision, ver, 'write');
  if v.state not in ('draft', 'review') then
    perform private.vowe_fail(case when v.state = 'suggested' then 'VW422' else 'VW409' end, 'Only a draft or a version in review can be sent for signatures');
  end if;
  if cardinality(coalesce(who, '{}')) > 50 then perform private.vowe_fail('VW422', 'At most 50 signers'); end if;
  foreach person in array coalesce(who, '{}') loop
    if not exists (select 1 from public.room_members where room_id = room and user_id = person and role::text in ('owner', 'member')) then
      perform private.vowe_fail('VW422', 'Only owners and members of the room can sign');
    end if;
  end loop;
  -- Sending a draft names its signers afresh; asking more people while in review adds them.
  if v.state = 'draft' then delete from public.decision_reviewers where decision_id = decision and version = ver; end if;
  insert into public.decision_reviewers (decision_id, version, room_id, user_id, requested_by)
  select decision, ver, room, p, me from unnest(array_append(coalesce(who, '{}'), me)) p
  on conflict do nothing;
  update public.room_decision_versions set state = 'review' where decision_id = decision and version = ver;
  perform private.vowe_log(room, 'review', v.title, ver, decision::text);
  perform private.vowe_notify(room, 'decision');
end;
$$;

-- Signs the current version as you. Agreed once every approver has (on_signed_agree). permission: sign; a person.
create function public.vowe_sign(decision uuid, ver integer, actor_kind text default 'human')
returns void language plpgsql security definer set search_path = '' as $$
declare
  v public.room_decision_versions;
begin
  perform private.vowe_person(actor_kind, 'sign');
  v := private.vowe_version(decision, ver, 'sign');
  if v.state not in ('review', 'agreed') then perform private.vowe_fail('VW422', 'Nobody has asked for signatures on this version yet'); end if;
  update public.decision_reviewers set changes_text = null where decision_id = decision and version = ver and user_id = (select auth.uid());
  insert into public.room_signatures (decision_id, version, user_id) values (decision, ver, (select auth.uid())) on conflict do nothing;
  perform private.vowe_notify(private.decision_room(decision), 'signature');
end;
$$;

-- Leaves the version unsigned by you, with your reason. permission: sign; a person.
create function public.vowe_request_changes(decision uuid, ver integer, body text, actor_kind text default 'human')
returns void language plpgsql security definer set search_path = '' as $$
declare
  v public.room_decision_versions;
  room uuid := private.decision_room(decision);
begin
  perform private.vowe_person(actor_kind, 'request changes');
  v := private.vowe_version(decision, ver, 'sign');
  if v.state <> 'review' then perform private.vowe_fail('VW409', 'Only a version in review takes change requests'); end if;
  insert into public.decision_reviewers (decision_id, version, room_id, user_id, changes_text, requested_by)
  values (decision, ver, room, (select auth.uid()), private.vowe_text(body, 'What to change', 2000), (select auth.uid()))
  on conflict (decision_id, version, user_id) do update set changes_text = excluded.changes_text;
  perform private.vowe_log(room, 'changes', v.title, ver, decision::text);
  perform private.vowe_notify(room, 'decision');
end;
$$;

-- Starts the next version as a draft (a copy of its words, without signatures or signers). An agreed version stays agreed until
-- the new one is agreed; one still in review is superseded now. A draft already open is returned as is.
-- Returns the new (or open) version. permission: write.
create function public.vowe_amend(decision uuid, actor_kind text default 'human')
returns integer language plpgsql security definer set search_path = '' as $$
declare
  room uuid := private.decision_room(decision);
  cur integer;
  v public.room_decision_versions;
  ak text := private.vowe_kind(actor_kind);
  reason text;
begin
  if room is null or private.room_role_of(room) is null then perform private.vowe_fail('VW404', 'No such decision in a room of yours'); end if;
  cur := private.decision_version(decision);
  v := private.vowe_version(decision, cur, 'write');
  if v.state in ('draft', 'suggested') then return cur; end if;
  if v.state = 'dismissed' then perform private.vowe_fail('VW409', 'A dismissed decision can''t be amended; restore it first'); end if;
  select changes_text into reason from public.decision_reviewers where decision_id = decision and version = cur and changes_text is not null limit 1;

  perform set_config('vowe.amend', 'on', true);
  update public.room_decisions set updated_at = now() where id = decision;
  perform set_config('vowe.amend', 'off', true);

  update public.room_decision_versions set doc = v.doc, revises_version = cur, revises_why = coalesce(reason, 'Amended'), author_kind = ak
  where decision_id = decision and version = cur + 1;
  insert into public.decision_lines (decision_id, version, room_id, position, kind, text, created_by, author_kind, how, basis, evidence)
  select decision, cur + 1, room, position, kind, text, created_by, author_kind, how, basis, evidence
  from public.decision_lines where decision_id = decision and version = cur;
  insert into public.decision_alternatives (decision_id, version, room_id, position, title, why, state, created_by, author_kind)
  select decision, cur + 1, room, position, title, why, state, created_by, author_kind
  from public.decision_alternatives where decision_id = decision and version = cur;
  perform private.vowe_notify(room, 'decision');
  return cur + 1;
end;
$$;

-- Dismisses a decision Vowe suggested, or brings it back as a draft. permission: write; a person.
create function public.vowe_set_suggested(decision uuid, ver integer, to_state text, actor_kind text default 'human')
returns void language plpgsql security definer set search_path = '' as $$
declare
  v public.room_decision_versions;
begin
  perform private.vowe_person(actor_kind, 'settle a suggestion');
  v := private.vowe_version(decision, ver, 'write');
  if to_state not in ('dismissed', 'draft') then perform private.vowe_fail('VW422', 'A suggestion is dismissed or becomes a draft'); end if;
  if v.state not in ('suggested', 'dismissed') or (to_state = 'dismissed' and v.state <> 'suggested') then
    perform private.vowe_fail('VW409', 'Only a suggested decision can be dismissed, and only a dismissed one restored');
  end if;
  update public.room_decision_versions set state = to_state::public.decision_state where decision_id = decision and version = ver;
  perform private.vowe_notify(private.decision_room(decision), 'decision');
end;
$$;

-- ─── Writes: work ────────────────────────────────────────────────────────────

-- New work with a draft plan; nobody is authorized and nothing runs. permission: write.
create function public.vowe_create_work(
  room uuid, title text, objective text default '', decision uuid default null, decision_ver integer default null,
  thread uuid default null, actor_kind text default 'human'
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  ak text := private.vowe_kind(actor_kind);
  me uuid := (select auth.uid());
  who text := case when ak = 'agent' then 'vowe' else me::text end;
  made uuid;
  dec_title text;
  w public.room_work;
begin
  perform private.vowe_require(room, 'write');
  if decision is not null then
    select d.title into dec_title from public.room_decisions d where d.id = decision and d.room_id = room;
    if dec_title is null then perform private.vowe_fail('VW404', 'No such decision in this room'); end if;
  end if;
  if thread is not null and not exists (select 1 from public.room_threads where id = thread and room_id = room) then
    perform private.vowe_fail('VW404', 'No such thread in this room');
  end if;
  insert into public.room_work (room_id, title, why, decision_id, decision_version, thread_id, repo, owner_id, created_by, author_kind, plan, may_not, context)
  values (
    room, private.vowe_text(title, 'Title', 500), private.vowe_text(objective, 'The objective', 4000, true), decision,
    case when decision is null then null else coalesce(decision_ver, private.decision_version(decision)) end, thread,
    coalesce((select repository from public.rooms where id = room), ''), me, me, ak,
    jsonb_build_array(jsonb_build_object('id', 's' || replace(gen_random_uuid()::text, '-', ''), 'text', '', 'state', 'todo',
                                         'by', jsonb_build_object('who', who, 'how', case when ak = 'agent' then 'inferred' else 'stated' end))),
    '["Merge, push to main, or change CI"]'::jsonb,
    case when decision is null then '[]'::jsonb
         else jsonb_build_array(jsonb_build_object('id', 'x1', 'kind', 'decision', 'label', dec_title, 'target', decision::text)) end
  ) returning * into w;
  made := w.id;
  perform private.vowe_append_log(w, 'Started the plan', ak);
  perform private.vowe_log(room, 'work', w.title, 1, made::text);
  perform private.vowe_notify(room, 'work');
  return made;
end;
$$;

-- Applies one plan op's result to the working copy. `base` is the version the editor read: anything else
-- is a conflict. `expected_rev` is the row main applied the op to (VW412 if it moved: main reloads and
-- retries). The database decides whether this opens the next draft. permission: write; a person.
create function public.vowe_save_plan(
  work uuid, base integer, expected_rev bigint, patch jsonb, want_version integer default null, line text default null, actor_kind text default 'human'
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  w public.room_work := private.vowe_lock_work(work);
begin
  perform private.vowe_person(actor_kind, 'edit a plan directly; it suggests changes instead');
  perform private.vowe_require(w.room_id, 'write');
  if w.state in ('resolved', 'closed') then perform private.vowe_fail('VW409', 'This work is resolved; its plan doesn''t change'); end if;
  if base <> w.version then perform private.vowe_fail('VW409', 'The plan moved to v' || w.version || ' since you read v' || base); end if;
  if expected_rev is not null and expected_rev <> w.rev then perform private.vowe_fail('VW412', 'The plan changed while it was being saved'); end if;
  w := private.vowe_apply_plan(work, patch, want_version, line, 'human');
  perform private.vowe_notify(w.room_id, 'plan');
  return jsonb_build_object('version', w.version, 'rev', w.rev);
end;
$$;

-- Suggests changes to a plan, as one revision (Vowe's, or a person's). Each change is accepted or rejected
-- on its own later. One open revision at a time. permission: write.
create function public.vowe_suggest_revision(work uuid, base integer, why text, changes jsonb, from_thread uuid default null, actor_kind text default 'human')
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  w public.room_work := private.vowe_lock_work(work);
  ak text := private.vowe_kind(actor_kind);
  made uuid;
  c jsonb;
  n integer := 0;
begin
  perform private.vowe_require(w.room_id, 'write');
  if base <> w.version then perform private.vowe_fail('VW409', 'The plan moved to v' || w.version || ' since v' || base); end if;
  if w.state in ('resolved', 'closed') then perform private.vowe_fail('VW409', 'This work is resolved'); end if;
  if jsonb_typeof(changes) <> 'array' or jsonb_array_length(changes) not between 1 and 50 then
    perform private.vowe_fail('VW422', 'A revision has between 1 and 50 changes');
  end if;
  if exists (select 1 from public.plan_changes c join public.plan_revisions r on r.id = c.revision_id
             where r.work_id = work and r.closed_at is null and c.state = 'open') then
    perform private.vowe_fail('VW409', 'Earlier suggestions on this plan still need a decision');
  end if;
  if from_thread is not null and not exists (select 1 from public.room_threads where id = from_thread and room_id = w.room_id) then
    perform private.vowe_fail('VW404', 'No such thread in this room');
  end if;
  update public.plan_revisions set closed_at = now() where work_id = work and closed_at is null;
  insert into public.plan_revisions (work_id, room_id, base_version, created_by, author_kind, why, from_thread)
  values (work, w.room_id, base, (select auth.uid()), ak, private.vowe_text(why, 'Why', 2000), from_thread) returning id into made;
  for c in select * from jsonb_array_elements(changes) loop
    if c ->> 'kind' not in ('edit', 'add', 'remove', 'move', 'promote', 'bound', 'verify') then perform private.vowe_fail('VW422', 'Unknown change kind'); end if;
    if c ->> 'kind' = 'bound' and coalesce(c ->> 'list', '') not in ('may', 'mayNot', 'askWhen') then perform private.vowe_fail('VW422', 'A boundary change names its list'); end if;
    insert into public.plan_changes (revision_id, work_id, room_id, position, kind, step, text, after, after_set, list, title, note, seed)
    values (made, work, w.room_id, n, c ->> 'kind', c ->> 'step', c ->> 'text', c ->> 'after', c ? 'after', c ->> 'list', c ->> 'title', c ->> 'note',
            case when jsonb_typeof(c -> 'seed') = 'object' then (c -> 'seed') - 'id' end);
    n := n + 1;
  end loop;
  perform private.vowe_notify(w.room_id, 'plan');
  return made;
end;
$$;

-- Accepts or rejects one suggested change, applying `patch` (decide() run by main on the plan it read) to
-- the working copy. Promoting a step creates its work item (`extra`: title, why, plan, may, mayNot, askWhen,
-- accept, parts) with the id main chose (`extra_id`). Once every change is decided the revision closes and
-- its thread is resolved. permission: write; a person.
create function public.vowe_decide_change(
  work uuid, change uuid, accept boolean, base integer, expected_rev bigint, patch jsonb default '{}',
  want_version integer default null, line text default null, extra_id uuid default null, extra jsonb default null, actor_kind text default 'human'
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  w public.room_work := private.vowe_lock_work(work);
  c public.plan_changes;
  rev public.plan_revisions;
  me uuid := (select auth.uid());
begin
  perform private.vowe_person(actor_kind, 'accept or reject suggested changes');
  perform private.vowe_require(w.room_id, 'write');
  select * into c from public.plan_changes where id = change and work_id = work for update;
  if c.id is null then perform private.vowe_fail('VW404', 'No such suggested change'); end if;
  if c.state <> 'open' then perform private.vowe_fail('VW409', 'Someone already decided this change'); end if;
  if base <> w.version then perform private.vowe_fail('VW409', 'The plan moved to v' || w.version || ' since you read v' || base); end if;
  if expected_rev is not null and expected_rev <> w.rev then perform private.vowe_fail('VW412', 'The plan changed while it was being saved'); end if;
  update public.plan_changes set state = case when accept then 'accepted' else 'rejected' end, decided_by = me, decided_at = now() where id = change;

  if accept and c.kind = 'promote' then
    if extra_id is null or jsonb_typeof(extra) <> 'object' then perform private.vowe_fail('VW422', 'Promoting a step needs its new work item'); end if;
    insert into public.room_work (id, room_id, title, why, plan, may, may_not, ask_when, accept, parts, decision_id, decision_version, thread_id,
                                  repo, owner_id, doer, state, blocks, exec, created_by, author_kind, context)
    values (extra_id, w.room_id, private.vowe_text(extra ->> 'title', 'Title', 500), private.vowe_text(extra ->> 'why', 'Why', 4000, true),
            private.vowe_steps(coalesce(extra -> 'plan', '[]')), private.vowe_strings(extra -> 'may', 'What it may do'),
            private.vowe_strings(extra -> 'mayNot', 'What it must not do'), private.vowe_strings(extra -> 'askWhen', 'When it must ask'),
            private.vowe_strings(extra -> 'accept', 'Verification'),
            coalesce((select array_agg(p) from jsonb_array_elements_text(coalesce(extra -> 'parts', '[]')) p), '{}'),
            w.decision_id, w.decision_version, (select from_thread from public.plan_revisions where id = c.revision_id),
            w.repo, w.owner_id, w.doer, 'proposed', w.id, jsonb_build_object('where', w.exec ->> 'where', 'prs', 'per-step'), me, 'human',
            case when jsonb_typeof(extra -> 'context') = 'array' then extra -> 'context' else '[]'::jsonb end);
    -- Its first version is a snapshot of what was proposed.
    insert into public.plan_versions (work_id, version, room_id, body, doer, prs, shaped_by)
    select x.id, 1, x.room_id, private.work_body(x), x.doer, x.exec ->> 'prs', array[me] from public.room_work x where x.id = extra_id;
    update public.room_work set depends_on = extra_id where id = work;
    perform private.vowe_log(w.room_id, 'work', extra ->> 'title', 1, extra_id::text);
  end if;

  w := private.vowe_apply_plan(work, case when accept then patch else '{}'::jsonb end, case when accept then want_version end, case when accept then line end, 'human');

  select * into rev from public.plan_revisions where id = c.revision_id;
  if not exists (select 1 from public.plan_changes where revision_id = rev.id and state = 'open') then
    update public.plan_revisions set closed_at = now() where id = rev.id;
    perform private.vowe_append_log(w, 'Finished reviewing the ' || (select count(*) from public.plan_changes where revision_id = rev.id) || ' suggestions', 'human');
    if rev.from_thread is not null then
      update public.room_threads set resolved_at = now() where id = rev.from_thread and resolved_at is null;
    end if;
  end if;
  perform private.vowe_notify(w.room_id, 'plan');
  return jsonb_build_object('version', w.version, 'rev', w.rev);
end;
$$;

-- Freezes the plan's current version as approved for its doer, and authorizes it. Refuses a stale version,
-- a plan with no doer or with undecided suggestions. Work it depends on that is still only proposed is
-- authorized with it (and named in `includes`). Never starts anything. permission: plan owner or room owner.
create function private.vowe_freeze(w public.room_work, doer_name text, includes text[])
returns void language plpgsql security definer set search_path = '' as $$
declare
  me uuid := (select auth.uid());
  scope text := (select string_agg(x, ' · ') from (
    select regexp_replace(e #>> '{}', '^Edit ', '') x from jsonb_array_elements(w.may) e where (e #>> '{}') ~ '^Edit '
    union all select 'draft PRs') s);
  approval jsonb := jsonb_strip_nulls(jsonb_build_object('doer', doer_name, 'scope', scope, 'includes', to_jsonb(includes)));
  snap public.plan_versions;
begin
  select * into snap from public.plan_versions where work_id = w.id and version = w.version for update;
  if snap.approved_by is not null then return; end if; -- already approved: nothing changes
  if snap.work_id is null then
    insert into public.plan_versions (work_id, version, room_id, body, doer, prs, shaped_by, approved, approved_by, approved_at)
    values (w.id, w.version, w.room_id, private.work_body(w), w.doer, w.exec ->> 'prs',
            coalesce((select array_agg(distinct who) from public.work_log where work_id = w.id and who is not null), '{}'),
            approval, me, now());
  else
    update public.plan_versions set body = private.work_body(w), doer = w.doer, prs = w.exec ->> 'prs', approved = approval, approved_by = me, approved_at = now()
    where work_id = w.id and version = w.version;
  end if;
  update public.room_work set
    state = case when state in ('draft', 'proposed') then 'authorized' else state end,
    authorized_by = me, authorized_at = now(), authorized_version = w.version, authorized_scope = scope, rev = rev + 1, updated_at = now()
  where id = w.id;
  update public.plan_revisions set closed_at = now() where work_id = w.id and closed_at is null;
  perform private.vowe_append_log(w, 'Authorized ' || doer_name || ' to run v' || w.version, 'human');
  perform private.vowe_log(w.room_id, 'authorized', w.title, w.version, w.id::text);
end;
$$;

create function public.vowe_authorize(work uuid, ver integer, actor_kind text default 'human')
returns void language plpgsql security definer set search_path = '' as $$
declare
  w public.room_work := private.vowe_lock_work(work);
  dep public.room_work;
begin
  perform private.vowe_govern(w, actor_kind, 'authorize a plan');
  if ver <> w.version then perform private.vowe_fail('VW409', 'The plan is at v' || w.version || ' now; read it before authorizing'); end if;
  if w.state in ('resolved', 'closed') then perform private.vowe_fail('VW409', 'This work is resolved'); end if;
  if w.doer is null then perform private.vowe_fail('VW422', 'Choose who does it first'); end if;
  if exists (select 1 from public.plan_changes c join public.plan_revisions r on r.id = c.revision_id
             where r.work_id = work and r.closed_at is null and c.state = 'open') then
    perform private.vowe_fail('VW422', 'Suggested changes still need a decision');
  end if;
  select * into dep from public.room_work where id = w.depends_on and state = 'proposed' for update;
  if dep.id is not null and (dep.owner_id = (select auth.uid()) or private.room_role_of(dep.room_id)::text = 'owner') then
    perform private.vowe_freeze(w, w.doer ->> 'name', array[dep.title]);
    perform private.vowe_freeze(dep, w.doer ->> 'name', null);
  else
    perform private.vowe_freeze(w, w.doer ->> 'name', null);
  end if;
  perform private.vowe_notify(w.room_id, 'work');
end;
$$;

-- A doer asks for more than was authorized (Vowe or a person records it). permission: write.
create function public.vowe_request_scope(work uuid, body text, adds text, asked_as text, actor_kind text default 'human')
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  w public.room_work := private.vowe_lock_work(work);
  made uuid;
begin
  perform private.vowe_require(w.room_id, 'write');
  if exists (select 1 from public.work_scope_requests where work_id = work and state = 'open') then
    perform private.vowe_fail('VW409', 'A scope request on this work is still open');
  end if;
  insert into public.work_scope_requests (work_id, room_id, text, adds, asked_as, created_by, author_kind)
  values (work, w.room_id, private.vowe_text(body, 'The request', 2000), private.vowe_text(adds, 'What it adds', 1000),
          private.vowe_text(asked_as, 'Who asks', 100), (select auth.uid()), private.vowe_kind(actor_kind))
  returning id into made;
  perform private.vowe_log(w.room_id, 'scope', adds, null, w.id::text);
  perform private.vowe_notify(w.room_id, 'work');
  return made;
end;
$$;

-- Grants or refuses the open scope request. Granting records who allowed it and adds it to what the plan
-- may do in the working copy, which opens the next draft: the approved version itself never expands.
-- permission: plan owner or room owner.
create function public.vowe_allow_scope(work uuid, allow boolean, actor_kind text default 'human')
returns void language plpgsql security definer set search_path = '' as $$
declare
  w public.room_work := private.vowe_lock_work(work);
  req public.work_scope_requests;
begin
  perform private.vowe_govern(w, actor_kind, 'allow scope');
  select * into req from public.work_scope_requests where work_id = work and state = 'open' for update;
  if req.id is null then perform private.vowe_fail('VW404', 'No scope request is open on this work'); end if;
  update public.work_scope_requests set state = case when allow then 'allowed' else 'refused' end, decided_by = (select auth.uid()), decided_at = now()
  where id = req.id;
  if allow then
    perform private.vowe_apply_plan(work, jsonb_build_object('may', w.may || to_jsonb(req.adds)), null, 'Allowed ' || req.adds, 'human');
  else
    perform private.vowe_append_log(w, 'Refused ' || req.adds, 'human');
  end if;
  perform private.vowe_log(w.room_id, 'scope', (case when allow then 'Allowed ' else 'Refused ' end) || req.adds, null, w.id::text);
  perform private.vowe_notify(w.room_id, 'work');
end;
$$;

-- A doer's question for someone in the room. permission: write.
create function public.vowe_ask_question(work uuid, body text, about text, step text, for_user uuid, options text[] default '{}', actor_kind text default 'human')
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  w public.room_work := private.vowe_lock_work(work);
  made uuid;
begin
  perform private.vowe_require(w.room_id, 'write');
  if not exists (select 1 from public.room_members where room_id = w.room_id and user_id = for_user) then
    perform private.vowe_fail('VW422', 'Only someone in the room can be asked');
  end if;
  insert into public.work_questions (work_id, room_id, text, about, step, for_user, options, created_by, author_kind)
  values (work, w.room_id, private.vowe_text(body, 'The question', 2000), coalesce(about, ''), step, for_user, coalesce(options, '{}'),
          (select auth.uid()), private.vowe_kind(actor_kind))
  returning id into made;
  perform private.vowe_log(w.room_id, 'question', body, null, w.id::text);
  perform private.vowe_notify(w.room_id, 'work');
  return made;
end;
$$;

-- Answers a doer's question. permission: write; a person.
create function public.vowe_answer_question(work uuid, question uuid, body text, actor_kind text default 'human')
returns void language plpgsql security definer set search_path = '' as $$
declare
  w public.room_work := private.vowe_lock_work(work);
begin
  perform private.vowe_person(actor_kind, 'answer for a person');
  perform private.vowe_require(w.room_id, 'write');
  update public.work_questions set answer = private.vowe_text(body, 'The answer', 4000), answered_by = (select auth.uid()), answered_at = now(), deferred = false
  where id = question and work_id = work and answer is null;
  if not found then perform private.vowe_fail('VW409', 'No open question by that id; it may already be answered'); end if;
  perform private.vowe_log(w.room_id, 'question', body, null, w.id::text);
  perform private.vowe_notify(w.room_id, 'work');
end;
$$;

-- Defers a doer's question. permission: write; a person.
create function public.vowe_defer_question(work uuid, question uuid, actor_kind text default 'human')
returns void language plpgsql security definer set search_path = '' as $$
declare
  w public.room_work := private.vowe_lock_work(work);
begin
  perform private.vowe_person(actor_kind, 'defer for a person');
  perform private.vowe_require(w.room_id, 'write');
  update public.work_questions set deferred = true where id = question and work_id = work and answer is null;
  if not found then perform private.vowe_fail('VW409', 'No open question by that id'); end if;
  perform private.vowe_notify(w.room_id, 'work');
end;
$$;

-- What a doer found. permission: write.
create function public.vowe_add_finding(work uuid, body text, evidence text[] default '{}', offer text default null, actor_kind text default 'human')
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  w public.room_work := private.vowe_lock_work(work);
  made uuid;
begin
  perform private.vowe_require(w.room_id, 'write');
  insert into public.work_findings (work_id, room_id, text, evidence, offer, created_by, author_kind)
  values (work, w.room_id, private.vowe_text(body, 'The finding', 4000), coalesce(evidence, '{}'), nullif(trim(coalesce(offer, '')), ''),
          (select auth.uid()), private.vowe_kind(actor_kind))
  returning id into made;
  perform private.vowe_log(w.room_id, 'finding', body, null, w.id::text);
  perform private.vowe_notify(w.room_id, 'work');
  return made;
end;
$$;

-- Tracks a PR on work as a person reports it (there's no GitHub sync). permission: write; a person.
create function public.vowe_track_pr(work uuid, num integer, title text, state text, branch text default '', url text default null, step text default null, actor_kind text default 'human')
returns void language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  w public.room_work := private.vowe_lock_work(work);
begin
  perform private.vowe_person(actor_kind, 'report a PR''s state');
  perform private.vowe_require(w.room_id, 'write');
  if state not in ('draft', 'open', 'review', 'changes', 'merged', 'closed') then perform private.vowe_fail('VW422', 'Unknown PR state'); end if;
  if url is not null and url !~ '^https://' then perform private.vowe_fail('VW422', 'A PR link must be https'); end if;
  insert into public.work_prs (work_id, room_id, num, title, state, branch, url, step, created_by)
  values (work, w.room_id, num, private.vowe_text(title, 'PR title', 500), state, coalesce(branch, ''), url, step, (select auth.uid()))
  on conflict (work_id, num) do update set title = excluded.title, state = excluded.state, branch = excluded.branch,
    url = excluded.url, step = excluded.step, updated_at = now();
  perform private.vowe_notify(w.room_id, 'work');
end;
$$;

-- Resolves work: every PR it tracks must be merged or closed. permission: plan owner or room owner.
create function public.vowe_resolve_work(work uuid, actor_kind text default 'human')
returns void language plpgsql security definer set search_path = '' as $$
declare
  w public.room_work := private.vowe_lock_work(work);
begin
  perform private.vowe_govern(w, actor_kind, 'resolve work');
  if w.state in ('resolved', 'closed') then return; end if;
  if exists (select 1 from public.work_prs where work_id = work and state not in ('merged', 'closed')) then
    perform private.vowe_fail('VW409', 'Every PR this work tracks must be merged or closed first');
  end if;
  update public.room_work set state = 'resolved', resolved_by = (select auth.uid()), resolved_at = now(), rev = rev + 1, updated_at = now() where id = work;
  perform private.vowe_append_log(w, 'Resolved', 'human');
  perform private.vowe_log(w.room_id, 'resolved', w.title, w.version, w.id::text);
  perform private.vowe_notify(w.room_id, 'work');
end;
$$;

-- ─── Writes: attention and settings ──────────────────────────────────────────

-- Your own For you marks. permission: comment.
create function public.vowe_mark_done(room uuid, items text[])
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.vowe_require(room, 'comment');
  if cardinality(coalesce(items, '{}')) > 200 or exists (select 1 from unnest(items) i where length(i) not between 1 and 300) then
    perform private.vowe_fail('VW422', 'At most 200 marks, each up to 300 characters');
  end if;
  insert into public.attention_done (room_id, user_id, item_id)
  select room, (select auth.uid()), i from unnest(coalesce(items, '{}')) i
  on conflict do nothing;
end;
$$;

-- Renames the assistant in the room's workspace ('' → back to 'Vowe'). Room owners and workspace owners;
-- always a person. Returns the name now in use.
create function public.vowe_set_agent_name(room uuid, name text, actor_kind text default 'human')
returns text language plpgsql security definer set search_path = '' as $$
declare
  ws uuid := private.room_workspace(room);
  chosen text := coalesce(nullif(trim(coalesce(name, '')), ''), 'Vowe');
begin
  perform private.vowe_person(actor_kind, 'rename itself');
  perform private.vowe_require(room, 'comment');
  if private.room_role_of(room)::text <> 'owner'
     and not exists (select 1 from public.workspace_members where workspace_id = ws and user_id = (select auth.uid()) and role = 'owner') then
    perform private.vowe_fail('VW403', 'Only an owner can rename the assistant');
  end if;
  if length(chosen) > 40 or chosen ~ '[[:cntrl:]]' then perform private.vowe_fail('VW422', 'The name must be at most 40 characters'); end if;
  update public.workspaces set agent_name = chosen where id = ws;
  perform private.vowe_notify(room, 'settings');
  return chosen;
end;
$$;

-- ─── Reading ─────────────────────────────────────────────────────────────────

-- Everything the Desk draws for one room, as raw rows, read as the caller (SECURITY INVOKER: RLS applies,
-- so a non-member gets nothing). Mapped to a VoweRecord in src/integrations/supabase/vowe-map.ts.
create function public.vowe_record(room uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select case when not exists (select 1 from public.rooms where id = room) then null else jsonb_build_object(
    'me', (select auth.uid()),
    'room', (select jsonb_build_object('id', r.id, 'goal', r.goal, 'created_by', r.created_by, 'repository', r.repository, 'vowe', r.vowe,
                                       'agent_name', (select w.agent_name from public.workspaces w where w.id = r.workspace_id))
             from public.rooms r where r.id = room),
    'members', coalesce((select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'role', m.role, 'name', u.name, 'email', u.email, 'avatar_url', u.avatar_url) order by m.joined_at)
                         from public.room_members m join public.users u on u.id = m.user_id where m.room_id = room), '[]'),
    'threads', coalesce((select jsonb_agg(to_jsonb(t) || jsonb_build_object(
                  'replies', coalesce((select jsonb_agg(to_jsonb(c) order by c.created_at) from public.room_comments c where c.thread_id = t.id), '[]'),
                  'links', coalesce((select jsonb_agg(to_jsonb(l)) from public.thread_links l where l.thread_id = t.id), '[]')) order by t.created_at)
                 from public.room_threads t where t.room_id = room), '[]'),
    'decisions', coalesce((select jsonb_agg(to_jsonb(d) || jsonb_build_object(
                  'versions', coalesce((select jsonb_agg(to_jsonb(v) || jsonb_build_object(
                      'lines', coalesce((select jsonb_agg(to_jsonb(l) order by l.position, l.created_at) from public.decision_lines l where l.decision_id = v.decision_id and l.version = v.version), '[]'),
                      'alternatives', coalesce((select jsonb_agg(to_jsonb(a) order by a.position) from public.decision_alternatives a where a.decision_id = v.decision_id and a.version = v.version), '[]'),
                      'reviewers', coalesce((select jsonb_agg(to_jsonb(x)) from public.decision_reviewers x where x.decision_id = v.decision_id and x.version = v.version), '[]'),
                      'signatures', coalesce((select jsonb_agg(to_jsonb(s)) from public.room_signatures s where s.decision_id = v.decision_id and s.version = v.version), '[]')
                    ) order by v.version) from public.room_decision_versions v where v.decision_id = d.id), '[]')) order by d.created_at)
                 from public.room_decisions d where d.room_id = room), '[]'),
    'work', coalesce((select jsonb_agg(to_jsonb(w) || jsonb_build_object(
                  'versions', coalesce((select jsonb_agg(to_jsonb(v) order by v.version) from public.plan_versions v where v.work_id = w.id), '[]'),
                  'revision', (select to_jsonb(r) || jsonb_build_object('changes', coalesce((select jsonb_agg(to_jsonb(c) order by c.position) from public.plan_changes c where c.revision_id = r.id), '[]'))
                               from public.plan_revisions r where r.work_id = w.id order by r.created_at desc limit 1),
                  'log', coalesce((select jsonb_agg(to_jsonb(l) order by l.id) from public.work_log l where l.work_id = w.id), '[]'),
                  'questions', coalesce((select jsonb_agg(to_jsonb(q) order by q.created_at) from public.work_questions q where q.work_id = w.id), '[]'),
                  'scope', coalesce((select jsonb_agg(to_jsonb(s) order by s.created_at) from public.work_scope_requests s where s.work_id = w.id), '[]'),
                  'findings', coalesce((select jsonb_agg(to_jsonb(f) order by f.created_at) from public.work_findings f where f.work_id = w.id), '[]'),
                  'prs', coalesce((select jsonb_agg(to_jsonb(p) order by p.num) from public.work_prs p where p.work_id = w.id), '[]')) order by w.created_at)
                 from public.room_work w where w.room_id = room), '[]'),
    'activity', coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at desc) from (
                  select * from public.room_activity where room_id = room order by created_at desc limit 50) a), '[]'),
    'seen_at', (select seen_at from public.room_visits where room_id = room and user_id = (select auth.uid())),
    'done', coalesce((select jsonb_agg(item_id) from public.attention_done where room_id = room and user_id = (select auth.uid())), '[]')
  ) end;
$$;

-- ─── Row-level security and grants ───────────────────────────────────────────

alter table public.thread_links enable row level security;
alter table public.decision_lines enable row level security;
alter table public.decision_alternatives enable row level security;
alter table public.decision_reviewers enable row level security;
alter table public.room_work enable row level security;
alter table public.plan_versions enable row level security;
alter table public.plan_revisions enable row level security;
alter table public.plan_changes enable row level security;
alter table public.work_log enable row level security;
alter table public.work_questions enable row level security;
alter table public.work_scope_requests enable row level security;
alter table public.work_findings enable row level security;
alter table public.work_prs enable row level security;
alter table public.attention_done enable row level security;

-- Supabase's default privileges grant everything (truncate included, which RLS doesn't cover); start from
-- nothing. Members read; every write goes through the functions above, except your own attention marks.
revoke all on public.thread_links, public.decision_lines, public.decision_alternatives, public.decision_reviewers,
  public.room_work, public.plan_versions, public.plan_revisions, public.plan_changes, public.work_log,
  public.work_questions, public.work_scope_requests, public.work_findings, public.work_prs, public.attention_done
  from anon, authenticated;
grant select on public.thread_links, public.decision_lines, public.decision_alternatives, public.decision_reviewers,
  public.room_work, public.plan_versions, public.plan_revisions, public.plan_changes, public.work_log,
  public.work_questions, public.work_scope_requests, public.work_findings, public.work_prs, public.attention_done
  to authenticated;
grant insert (room_id, item_id) on public.attention_done to authenticated;

create policy "thread_links: members read" on public.thread_links for select to authenticated using (private.can_use_room(room_id));
create policy "decision_lines: members read" on public.decision_lines for select to authenticated using (private.can_use_room(room_id));
create policy "decision_alternatives: members read" on public.decision_alternatives for select to authenticated using (private.can_use_room(room_id));
create policy "decision_reviewers: members read" on public.decision_reviewers for select to authenticated using (private.can_use_room(room_id));
create policy "room_work: members read" on public.room_work for select to authenticated using (private.can_use_room(room_id));
create policy "plan_versions: members read" on public.plan_versions for select to authenticated using (private.can_use_room(room_id));
create policy "plan_revisions: members read" on public.plan_revisions for select to authenticated using (private.can_use_room(room_id));
create policy "plan_changes: members read" on public.plan_changes for select to authenticated using (private.can_use_room(room_id));
create policy "work_log: members read" on public.work_log for select to authenticated using (private.can_use_room(room_id));
create policy "work_questions: members read" on public.work_questions for select to authenticated using (private.can_use_room(room_id));
create policy "work_scope_requests: members read" on public.work_scope_requests for select to authenticated using (private.can_use_room(room_id));
create policy "work_findings: members read" on public.work_findings for select to authenticated using (private.can_use_room(room_id));
create policy "work_prs: members read" on public.work_prs for select to authenticated using (private.can_use_room(room_id));
create policy "attention_done: your own" on public.attention_done for select to authenticated
  using (user_id = (select auth.uid()) and private.can_use_room(room_id));
create policy "attention_done: mark your own" on public.attention_done for insert to authenticated
  with check (user_id = (select auth.uid()) and private.can_use_room(room_id));

-- Functions: private helpers aren't callable through the API; the public writes are for signed-in people.
revoke execute on all functions in schema private from public;
revoke execute on function
  private.vowe_fail(text, text), private.vowe_require(uuid, text), private.vowe_kind(text), private.vowe_person(text, text),
  private.vowe_text(text, text, integer, boolean), private.vowe_strings(jsonb, text), private.vowe_notify(uuid, text),
  private.vowe_log(uuid, public.room_activity_kind, text, integer, text), private.on_comment_answers(),
  private.version_signed(uuid, integer), private.version_state(uuid, integer), private.guard_decision_content(),
  private.guard_decision_version(), private.version_approvers(uuid, integer), private.on_signed_agree(), private.guard_plan_version(),
  private.plan_content(text, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, text), private.work_content(public.room_work),
  private.version_content(public.plan_versions), private.work_body(public.room_work), private.vowe_steps(jsonb),
  private.vowe_lock_work(uuid), private.vowe_append_log(public.room_work, text, text), private.vowe_apply_plan(uuid, jsonb, integer, text, text),
  private.vowe_govern(public.room_work, text, text), private.vowe_version(uuid, integer, text), private.vowe_freeze(public.room_work, text, text[])
  from authenticated;
-- RLS policies call these as the signed-in user.
grant execute on function private.version_state(uuid, integer) to authenticated;

revoke execute on function
  public.vowe_create_thread(uuid, jsonb, text, text, real, real, uuid, text), public.vowe_reply(uuid, uuid, text, text, jsonb),
  public.vowe_answer_offer(uuid, uuid, uuid, boolean, text), public.vowe_link_thread(uuid, uuid, jsonb),
  public.vowe_create_decision(uuid, text, text, uuid, text, text), public.vowe_add_line(uuid, integer, text, text, text),
  public.vowe_edit_line(uuid, integer, uuid, text, text), public.vowe_suggest_line(uuid, integer, uuid, text, text, text),
  public.vowe_take_suggestion(uuid, integer, uuid, boolean, text), public.vowe_edit_doc(uuid, integer, text, text, text),
  public.vowe_request_signatures(uuid, integer, uuid[], text), public.vowe_sign(uuid, integer, text),
  public.vowe_request_changes(uuid, integer, text, text), public.vowe_amend(uuid, text), public.vowe_set_suggested(uuid, integer, text, text),
  public.vowe_create_work(uuid, text, text, uuid, integer, uuid, text), public.vowe_save_plan(uuid, integer, bigint, jsonb, integer, text, text),
  public.vowe_suggest_revision(uuid, integer, text, jsonb, uuid, text),
  public.vowe_decide_change(uuid, uuid, boolean, integer, bigint, jsonb, integer, text, uuid, jsonb, text),
  public.vowe_authorize(uuid, integer, text), public.vowe_request_scope(uuid, text, text, text, text), public.vowe_allow_scope(uuid, boolean, text),
  public.vowe_ask_question(uuid, text, text, text, uuid, text[], text), public.vowe_answer_question(uuid, uuid, text, text),
  public.vowe_defer_question(uuid, uuid, text), public.vowe_add_finding(uuid, text, text[], text, text),
  public.vowe_track_pr(uuid, integer, text, text, text, text, text, text), public.vowe_resolve_work(uuid, text),
  public.vowe_mark_done(uuid, text[]), public.vowe_set_agent_name(uuid, text, text), public.vowe_record(uuid)
  from public, anon;
grant execute on function
  public.vowe_create_thread(uuid, jsonb, text, text, real, real, uuid, text), public.vowe_reply(uuid, uuid, text, text, jsonb),
  public.vowe_answer_offer(uuid, uuid, uuid, boolean, text), public.vowe_link_thread(uuid, uuid, jsonb),
  public.vowe_create_decision(uuid, text, text, uuid, text, text), public.vowe_add_line(uuid, integer, text, text, text),
  public.vowe_edit_line(uuid, integer, uuid, text, text), public.vowe_suggest_line(uuid, integer, uuid, text, text, text),
  public.vowe_take_suggestion(uuid, integer, uuid, boolean, text), public.vowe_edit_doc(uuid, integer, text, text, text),
  public.vowe_request_signatures(uuid, integer, uuid[], text), public.vowe_sign(uuid, integer, text),
  public.vowe_request_changes(uuid, integer, text, text), public.vowe_amend(uuid, text), public.vowe_set_suggested(uuid, integer, text, text),
  public.vowe_create_work(uuid, text, text, uuid, integer, uuid, text), public.vowe_save_plan(uuid, integer, bigint, jsonb, integer, text, text),
  public.vowe_suggest_revision(uuid, integer, text, jsonb, uuid, text),
  public.vowe_decide_change(uuid, uuid, boolean, integer, bigint, jsonb, integer, text, uuid, jsonb, text),
  public.vowe_authorize(uuid, integer, text), public.vowe_request_scope(uuid, text, text, text, text), public.vowe_allow_scope(uuid, boolean, text),
  public.vowe_ask_question(uuid, text, text, text, uuid, text[], text), public.vowe_answer_question(uuid, uuid, text, text),
  public.vowe_defer_question(uuid, uuid, text), public.vowe_add_finding(uuid, text, text[], text, text),
  public.vowe_track_pr(uuid, integer, text, text, text, text, text, text), public.vowe_resolve_work(uuid, text),
  public.vowe_mark_done(uuid, text[]), public.vowe_set_agent_name(uuid, text, text), public.vowe_record(uuid)
  to authenticated;
