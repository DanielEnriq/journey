-- Invitations into a room, and what each room role may do.
--
--   room_invitations   an email invitation (bound to one address, single use) or the room's invite
--                      link (multi-use, optionally limited to one email domain). Both expire. Only a
--                      SHA-256 hash of a link's token is stored; the token itself is returned once,
--                      to the owner who made it. An email invitation is redeemed by the signed-in
--                      person whose verified email it was sent to, so it needs no token at all.
--
-- Everything that changes an invitation goes through the functions below (SECURITY DEFINER), so the
-- rules live in one place: owners invite, make links and withdraw them; anyone signed in can ask
-- what a token or an invitation of theirs is for; accepting one makes you a member (never puts you
-- in the call). Members read the room's invitations; nobody reads token hashes.
--
-- Roles, enforced here and by the LiveKit token services:
--   owner    manages access: invites, links, roles, removing people. A room always keeps one.
--   member   proposes, amends and signs decisions, resolves threads, talks on the call.
--   viewer   reads the record, comments and replies, listens to the call. Can't sign or talk.
--
-- Accepting adds you to the room's workspace as a member if you weren't in it, since room access
-- (private.can_use_room) also requires the workspace. Rooms stay private to their members.
--
-- Errors the functions raise use SQLSTATE VI001 with one of these messages, which the app shows as
-- designed states: not_permitted, invalid_email, rate_limited, invite_not_found, invite_expired,
-- invite_revoked, invite_used, link_revoked, wrong_account, domain_not_allowed.

-- ─── Tables ──────────────────────────────────────────────────────────────────

create type public.invitation_kind as enum ('email', 'link');
create type public.invitation_status as enum ('pending', 'accepted', 'expired', 'revoked');

create table public.room_invitations (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  kind public.invitation_kind not null,
  -- Email invitations: the address, lowercase. Links: null.
  email text check (email = lower(email) and email ~ '^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]{2,}$'),
  -- Links only: the email domain someone must be signed in with, lowercase.
  domain text check (domain = lower(domain) and domain ~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$'),
  role public.room_role not null default 'member',
  token_hash bytea not null unique,
  -- A link stays `pending` (live) until it expires or is turned off; an email invitation until it's used.
  status public.invitation_status not null default 'pending',
  invited_by uuid not null references public.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  -- When it was last sent (or made): a resend moves this and the expiry, and kills the old token.
  sent_at timestamptz not null default now(),
  expires_at timestamptz not null,
  resends integer not null default 0,
  uses integer not null default 0,
  accepted_at timestamptz,
  accepted_by uuid references public.users (id) on delete set null,
  revoked_at timestamptz,
  check ((kind = 'email') = (email is not null)),
  check (kind = 'link' or domain is null),
  -- A link can't make anyone an owner.
  check (kind = 'email' or role <> 'owner')
);
create index room_invitations_room_idx on public.room_invitations (room_id, sent_at desc);
create unique index room_invitations_one_pending_per_email on public.room_invitations (room_id, email)
  where kind = 'email' and status = 'pending';
create unique index room_invitations_one_live_link on public.room_invitations (room_id)
  where kind = 'link' and status = 'pending';
create index room_invitations_email_idx on public.room_invitations (email) where kind = 'email' and status = 'pending';

-- ─── Helpers ─────────────────────────────────────────────────────────────────

-- Your role in a room, if you can use it (a member, still in its workspace).
create function private.room_role_of(room uuid)
returns public.room_role language sql stable security definer set search_path = '' as $$
  select role from public.room_members
  where room_id = room and user_id = (select auth.uid())
    and private.is_workspace_member(private.room_workspace(room));
$$;

-- Owners and members change the record's decisions; viewers only read and comment.
create function private.can_edit_room(room uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(private.room_role_of(room) in ('owner', 'member'), false);
$$;

-- The signed-in person's email, only if Google (or another provider) verified it.
create function private.verified_email()
returns text language sql stable security definer set search_path = '' as $$
  select lower(email) from auth.users where id = (select auth.uid()) and email_confirmed_at is not null;
$$;

-- 128 random bits, base64url without padding.
create function private.new_invite_token()
returns text language sql volatile set search_path = '' as $$
  select translate(encode(extensions.gen_random_bytes(16), 'base64'), '+/=', '-_');
$$;

create function private.hash_invite_token(token text)
returns bytea language sql immutable set search_path = '' as $$
  select extensions.digest(token, 'sha256');
$$;

-- "john@acme.com" → "j•••@acme.com": shown to whoever holds an invitation before they're a member.
create function private.mask_email(address text)
returns text language sql immutable set search_path = '' as $$
  select left(split_part(address, '@', 1), 1) || '•••@' || split_part(address, '@', 2);
$$;

create function private.invite_error(code text)
returns void language plpgsql set search_path = '' as $$
begin
  raise exception '%', code using errcode = 'VI001';
end;
$$;

-- The invitation a token or an invitation id names. By id only for email invitations, and only to the
-- person they were sent to: anyone else gets nothing, as if it didn't exist.
create function private.find_invitation(token text, invitation uuid)
returns public.room_invitations language sql stable security definer set search_path = '' as $$
  select i.* from public.room_invitations i
  where case
    when token is not null then i.token_hash = private.hash_invite_token(token)
    else i.id = invitation and i.kind = 'email' and i.email = private.verified_email()
  end;
$$;

-- ─── Inviting ────────────────────────────────────────────────────────────────

-- Owners invite people by email. Existing members are skipped; a pending invitation to the same
-- address is sent again (new expiry, the old token dies). At most 50 sends per room per hour.
create function public.invite_to_room(room uuid, emails text[], invite_role public.room_role default 'member')
returns table (invitation_id uuid, invited_email text, resent boolean)
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := (select auth.uid());
  address text;
  existing uuid;
begin
  if me is null or not private.is_room_owner(room) then perform private.invite_error('not_permitted'); end if;
  if emails is null or cardinality(emails) = 0 or cardinality(emails) > 50 then perform private.invite_error('invalid_email'); end if;

  perform 1 from public.rooms where id = room for update; -- one batch per room at a time
  if (select count(*) from public.room_invitations where room_id = room and sent_at > now() - interval '1 hour')
     + cardinality(emails) > 50 then
    perform private.invite_error('rate_limited');
  end if;
  update public.room_invitations set status = 'expired'
  where room_id = room and status = 'pending' and expires_at <= now();

  foreach address in array emails loop
    address := lower(trim(address));
    if address !~ '^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]{2,}$' then perform private.invite_error('invalid_email'); end if;
    continue when exists (
      select 1 from public.room_members rm join public.users u on u.id = rm.user_id
      where rm.room_id = room and lower(u.email) = address
    );
    select i.id into existing from public.room_invitations i
    where i.room_id = room and i.kind = 'email' and i.email = address and i.status = 'pending';
    if found then
      update public.room_invitations set
        role = invite_role, invited_by = me, sent_at = now(), expires_at = now() + interval '7 days',
        resends = resends + 1, token_hash = private.hash_invite_token(private.new_invite_token())
      where id = existing;
      invitation_id := existing; invited_email := address; resent := true;
    else
      insert into public.room_invitations (room_id, kind, email, role, token_hash, invited_by, expires_at)
      values (room, 'email', address, invite_role, private.hash_invite_token(private.new_invite_token()), me, now() + interval '7 days')
      returning id into invitation_id;
      invited_email := address; resent := false;
    end if;
    return next;
  end loop;
end;
$$;

-- Owners make the room's invite link, replacing any live one (so changing a link's settings can never
-- quietly widen a link already shared). Returns the token, once.
create function public.create_room_link(room uuid, link_role public.room_role, valid_for text, only_domain text default null)
returns table (invitation_id uuid, token text, expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := (select auth.uid());
  lifetime interval;
begin
  if me is null or not private.is_room_owner(room) then perform private.invite_error('not_permitted'); end if;
  if link_role not in ('member', 'viewer') then perform private.invite_error('not_permitted'); end if;
  lifetime := case valid_for when '24h' then interval '24 hours' when '7d' then interval '7 days' when '30d' then interval '30 days' end;
  if lifetime is null then raise exception 'valid_for must be 24h, 7d or 30d' using errcode = '22023'; end if;
  only_domain := nullif(lower(trim(only_domain)), '');

  perform 1 from public.rooms where id = room for update;
  update public.room_invitations set status = 'revoked', revoked_at = now()
  where room_id = room and kind = 'link' and status = 'pending';

  token := private.new_invite_token();
  insert into public.room_invitations as i (room_id, kind, domain, role, token_hash, invited_by, expires_at)
  values (room, 'link', only_domain, link_role, private.hash_invite_token(token), me, now() + lifetime)
  returning i.id, i.expires_at into invitation_id, expires_at;
  return next;
end;
$$;

-- Owners withdraw a pending email invitation or turn off the link.
create function public.revoke_room_invitation(invitation uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  room uuid;
begin
  select room_id into room from public.room_invitations where id = invitation;
  if room is null or not private.is_room_owner(room) then perform private.invite_error('not_permitted'); end if;
  update public.room_invitations set status = 'revoked', revoked_at = now()
  where id = invitation and status = 'pending';
end;
$$;

-- ─── Redeeming ───────────────────────────────────────────────────────────────

-- What an invitation (a link's token, or an email invitation of yours by id) would do for you, in the
-- order the app explains it: unknown → already a member → wrong account → withdrawn, used or expired →
-- the link's domain → a preview of the room (its goal and members, never before you're signed in).
create function public.resolve_room_invitation(token text default null, invitation uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := (select auth.uid());
  mine text := private.verified_email();
  inv public.room_invitations;
  r public.rooms;
  invite jsonb;
  fail text;
begin
  if me is null then return jsonb_build_object('kind', 'error', 'error', 'invite_not_found'); end if;
  inv := private.find_invitation(token, invitation);
  if inv.id is null then return jsonb_build_object('kind', 'error', 'error', 'invite_not_found'); end if;
  select * into r from public.rooms where id = inv.room_id;

  invite := jsonb_build_object(
    'id', inv.id,
    'via', inv.kind,
    'roomName', r.name,
    'role', inv.role,
    'boundEmail', case when inv.kind = 'email' then private.mask_email(inv.email) end,
    'domain', inv.domain,
    'inviter', (select jsonb_build_object('id', u.id, 'name', coalesce(u.name, split_part(u.email, '@', 1)), 'avatarUrl', u.avatar_url)
                from public.users u where u.id = inv.invited_by)
  );

  if exists (select 1 from public.room_members where room_id = inv.room_id and user_id = me) then
    return jsonb_build_object('kind', 'already-member', 'roomId', r.id, 'roomName', r.name);
  end if;
  if mine is null or (inv.kind = 'email' and inv.email <> mine) then
    return jsonb_build_object('kind', 'wrong-account', 'invite', invite, 'signedInAs', coalesce(mine, ''));
  end if;

  fail := case
    when inv.status = 'revoked' then case inv.kind when 'link' then 'link_revoked' else 'invite_revoked' end
    when inv.status = 'accepted' then 'invite_used'
    when inv.status = 'expired' or inv.expires_at <= now() then 'invite_expired'
    when inv.kind = 'link' and inv.domain is not null and split_part(mine, '@', 2) <> inv.domain then 'domain_not_allowed'
  end;
  if fail is not null then
    return jsonb_build_object('kind', 'error', 'error', fail, 'invite', invite, 'signedInAs', mine);
  end if;

  return jsonb_build_object(
    'kind', 'preview',
    'invite', invite,
    'room', jsonb_build_object(
      'id', r.id,
      'name', r.name,
      'goal', r.goal,
      'members', coalesce((
        select jsonb_agg(jsonb_build_object('id', u.id, 'name', coalesce(u.name, split_part(u.email, '@', 1)), 'avatarUrl', u.avatar_url) order by rm.joined_at)
        from public.room_members rm join public.users u on u.id = rm.user_id
        where rm.room_id = r.id
      ), '[]'::jsonb)
    )
  );
end;
$$;

-- Accepts an invitation: you become a member of the room with the invitation's role, and nothing else
-- happens (no call). An email invitation then can't be used again; a link counts one more use.
-- Returns the room's id. Already a member: returns it without changing anything.
create function public.accept_room_invitation(token text default null, invitation uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  me uuid := (select auth.uid());
  state jsonb := public.resolve_room_invitation(token, invitation);
  inv public.room_invitations;
begin
  if state ->> 'kind' = 'already-member' then return (state ->> 'roomId')::uuid; end if;
  if state ->> 'kind' = 'wrong-account' then perform private.invite_error('wrong_account'); end if;
  if state ->> 'kind' <> 'preview' then perform private.invite_error(state ->> 'error'); end if;

  select * into inv from public.room_invitations where id = (state -> 'invite' ->> 'id')::uuid for update;
  if inv.status <> 'pending' then perform private.invite_error('invite_used'); end if; -- lost a race

  insert into public.workspace_members (workspace_id, user_id, role)
  values (private.room_workspace(inv.room_id), me, 'member')
  on conflict (workspace_id, user_id) do nothing;
  insert into public.room_members (room_id, user_id, role) values (inv.room_id, me, inv.role)
  on conflict (room_id, user_id) do nothing;

  if inv.kind = 'email' then
    update public.room_invitations set status = 'accepted', accepted_at = now(), accepted_by = me where id = inv.id;
  else
    update public.room_invitations set uses = uses + 1 where id = inv.id;
  end if;
  -- Other pending email invitations to this room for the same address are spent too.
  update public.room_invitations set status = 'accepted', accepted_at = now(), accepted_by = me
  where room_id = inv.room_id and kind = 'email' and status = 'pending' and email = private.verified_email();

  perform private.log_room_activity(inv.room_id, 'joined', (select coalesce(name, email) from public.users where id = me), null);
  return inv.room_id;
end;
$$;

-- Pending email invitations sent to your verified address, newest first: what the app offers you
-- after you sign in, without needing the email itself.
create function public.my_room_invitations()
returns table (invitation_id uuid, room_id uuid, room_name text, role public.room_role, inviter_name text, sent_at timestamptz, expires_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select i.id, i.room_id, r.name, i.role, coalesce(u.name, split_part(u.email, '@', 1)), i.sent_at, i.expires_at
  from public.room_invitations i
  join public.rooms r on r.id = i.room_id
  join public.users u on u.id = i.invited_by
  where i.kind = 'email' and i.status = 'pending' and i.expires_at > now()
    and i.email = private.verified_email()
    and not exists (select 1 from public.room_members m where m.room_id = i.room_id and m.user_id = (select auth.uid()))
  order by i.sent_at desc;
$$;

-- ─── Membership in the room's activity ───────────────────────────────────────

-- Leaving, removal and role changes are part of the room's record. Joining is logged by
-- accept_room_invitation. Skipped when the room itself is being deleted, or an account is.
create function private.on_room_member_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  who text;
begin
  if (select auth.uid()) is null or not exists (select 1 from public.rooms where id = old.room_id) then
    return null;
  end if;
  select coalesce(name, email) into who from public.users where id = old.user_id;
  if tg_op = 'DELETE' then
    perform private.log_room_activity(old.room_id, case when old.user_id = (select auth.uid()) then 'left' else 'removed' end::public.room_activity_kind, who, null);
  elsif new.role is distinct from old.role then
    perform private.log_room_activity(old.room_id, 'role', who || ' · ' || new.role, null);
  end if;
  return null;
end;
$$;

create trigger on_room_member_changed
  after update or delete on public.room_members
  for each row execute function private.on_room_member_changed();

-- ─── What viewers can't do ───────────────────────────────────────────────────

drop policy "room_decisions: members propose" on public.room_decisions;
drop policy "room_decisions: members amend" on public.room_decisions;
drop policy "room_signatures: members sign the current version" on public.room_signatures;
drop policy "room_threads: members resolve" on public.room_threads;

create policy "room_decisions: owners and members propose" on public.room_decisions
  for insert to authenticated with check (private.can_edit_room(room_id));
create policy "room_decisions: owners and members amend" on public.room_decisions
  for update to authenticated using (private.can_edit_room(room_id)) with check (private.can_edit_room(room_id));
create policy "room_signatures: owners and members sign the current version" on public.room_signatures
  for insert to authenticated with check (
    user_id = (select auth.uid())
    and private.can_edit_room(private.decision_room(decision_id))
    and version = private.decision_version(decision_id)
  );
create policy "room_threads: owners and members resolve" on public.room_threads
  for update to authenticated using (private.can_edit_room(room_id)) with check (private.can_edit_room(room_id));

-- ─── Row-level security and grants ───────────────────────────────────────────

alter table public.room_invitations enable row level security;
revoke all on public.room_invitations from anon, authenticated;
-- Everything but the token hash; all writes go through the functions above.
grant select (id, room_id, kind, email, domain, role, status, invited_by, created_at, sent_at, expires_at, resends, uses, accepted_at, accepted_by, revoked_at)
  on public.room_invitations to authenticated;
create policy "room_invitations: members read" on public.room_invitations
  for select to authenticated using (private.can_use_room(room_id));

revoke execute on all functions in schema private from public;
revoke execute on function
  private.room_role_of(uuid), private.verified_email(), private.new_invite_token(), private.hash_invite_token(text),
  private.mask_email(text), private.invite_error(text), private.find_invitation(text, uuid), private.on_room_member_changed()
  from authenticated;
grant execute on function private.can_edit_room(uuid) to authenticated;

revoke execute on function
  public.invite_to_room(uuid, text[], public.room_role), public.create_room_link(uuid, public.room_role, text, text),
  public.revoke_room_invitation(uuid), public.resolve_room_invitation(text, uuid), public.accept_room_invitation(text, uuid),
  public.my_room_invitations()
  from public, anon;
grant execute on function
  public.invite_to_room(uuid, text[], public.room_role), public.create_room_link(uuid, public.room_role, text, text),
  public.revoke_room_invitation(uuid), public.resolve_room_invitation(text, uuid), public.accept_room_invitation(text, uuid),
  public.my_room_invitations()
  to authenticated;
