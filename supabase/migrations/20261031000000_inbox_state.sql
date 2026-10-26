-- Home's Inbox, kept per person on the server so it follows you between machines:
--   inbox_state            your own marks: what you've seen, snoozed, followed, muted, and when you were last here.
--                          Done marks stay in attention_done (per room). The app keeps a local copy for speed and
--                          writes the whole set back; the newest write wins.
--   room_invitations       declining an email invitation sent to you. It's hidden from your Inbox until it's sent
--                          again; the invitation itself stays pending, so its link still works if you change your mind.

-- ─── Your Inbox marks ────────────────────────────────────────────────────────

create table public.inbox_state (
  user_id uuid primary key default auth.uid() references public.users (id) on delete cascade,
  marks jsonb not null default '{}' check (jsonb_typeof(marks) = 'object' and pg_column_size(marks) <= 262144),
  updated_at timestamptz not null default now()
);

alter table public.inbox_state enable row level security;
revoke all on public.inbox_state from anon, authenticated;
grant select on public.inbox_state to authenticated;
grant insert (user_id, marks, updated_at), update (marks, updated_at) on public.inbox_state to authenticated;
create policy "inbox_state: your own, read" on public.inbox_state
  for select to authenticated using (user_id = (select auth.uid()));
create policy "inbox_state: your own, add" on public.inbox_state
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "inbox_state: your own, change" on public.inbox_state
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- ─── Declining an invitation ─────────────────────────────────────────────────

alter table public.room_invitations add column declined_at timestamptz;

-- You decline an email invitation sent to your verified address. Sending it again (which moves sent_at)
-- brings it back.
create function public.decline_room_invitation(invitation uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.room_invitations set declined_at = now()
  where id = invitation and kind = 'email' and status = 'pending' and email = private.verified_email();
  if not found then perform private.invite_error('invite_not_found'); end if;
end;
$$;

-- As before, without the ones you declined since they were last sent.
create or replace function public.my_room_invitations()
returns table (invitation_id uuid, room_id uuid, room_name text, role public.room_role, inviter_name text, sent_at timestamptz, expires_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select i.id, i.room_id, r.name, i.role, coalesce(u.name, split_part(u.email, '@', 1)), i.sent_at, i.expires_at
  from public.room_invitations i
  join public.rooms r on r.id = i.room_id
  join public.users u on u.id = i.invited_by
  where i.kind = 'email' and i.status = 'pending' and i.expires_at > now()
    and i.email = private.verified_email()
    and (i.declined_at is null or i.declined_at < i.sent_at)
    and not exists (select 1 from public.room_members m where m.room_id = i.room_id and m.user_id = (select auth.uid()))
  order by i.sent_at desc;
$$;

revoke execute on function public.decline_room_invitation(uuid) from public, anon;
grant execute on function public.decline_room_invitation(uuid) to authenticated;
