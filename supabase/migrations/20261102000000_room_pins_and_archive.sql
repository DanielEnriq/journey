-- Where a room sits in your own sidebar: pinned to the top, or archived out of it. Both are yours alone,
-- kept on your membership, so pinning or archiving a room never moves it for anyone else in it.
--
--   room_members.pin_order    where the room sits among your pinned rooms, smallest first; null when it
--                             isn't pinned. Fractional, so a room dropped between two others takes the
--                             number between theirs and nothing else is renumbered.
--   room_members.archived_at  when you archived it; null while it's in your sidebar. Archiving unpins it.
--                             The room and its history stay as they were, and unarchiving brings it back.
--
-- Members can't update their own rows directly (membership has no UPDATE policy for them), so each change
-- goes through a function that only touches the caller's own row and those two columns.

alter table public.room_members
  add column pin_order double precision,
  add column archived_at timestamptz,
  add constraint room_members_pin_order_finite check (pin_order is null or pin_order between -1e15 and 1e15),
  add constraint room_members_pinned_not_archived check (pin_order is null or archived_at is null);

-- Pins a room at `pin_order` among yours, moves it there if it's pinned already, or unpins it (null).
-- Pinning a quick room also keeps it, where you can keep it: a room you pinned shouldn't fold into Earlier.
create function public.pin_room(room uuid, pin_order double precision)
returns double precision language plpgsql security definer set search_path = '' as $$
declare
  placed double precision;
begin
  update public.room_members m
  set pin_order = pin_room.pin_order,
      archived_at = case when pin_room.pin_order is null then m.archived_at end
  where m.room_id = room and m.user_id = (select auth.uid())
  returning m.pin_order into placed;
  if not found then
    raise exception 'No such room, or you are not a member of it' using errcode = 'P0002';
  end if;
  if pin_order is not null and private.can_edit_room(room) then
    update public.rooms set kept_at = now() where id = room and kept_at is null;
  end if;
  return placed;
end;
$$;
revoke execute on function public.pin_room(uuid, double precision) from public, anon;
grant execute on function public.pin_room(uuid, double precision) to authenticated;

-- Archives a room out of your sidebar (unpinning it), or brings it back. Anyone in the room, viewers too.
create function public.archive_room(room uuid, archive boolean)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare
  archived timestamptz;
begin
  update public.room_members m
  set archived_at = case when archive then coalesce(m.archived_at, now()) end,
      pin_order = case when archive then null else m.pin_order end
  where m.room_id = room and m.user_id = (select auth.uid())
  returning m.archived_at into archived;
  if not found then
    raise exception 'No such room, or you are not a member of it' using errcode = 'P0002';
  end if;
  return archived;
end;
$$;
revoke execute on function public.archive_room(uuid, boolean) from public, anon;
grant execute on function public.archive_room(uuid, boolean) to authenticated;
