-- Live rooms over Supabase Realtime: each room is a private channel with topic `room:<room id>`,
-- carrying broadcast (room events) and presence (who's connected). Private channels authorize
-- through RLS on realtime.messages; these policies admit a room's members and nobody else.
--
-- Also turn off Realtime → Settings → "Allow public access" in the hosted project, so a client
-- can't sidestep these policies by joining the same topic as a public channel.

-- The room a `room:<uuid>` topic refers to, or null for any other topic.
create function private.topic_room(topic text)
returns uuid language sql immutable set search_path = '' as $$
  select case
    when topic ~ '^room:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then substr(topic, 6)::uuid
  end;
$$;

-- Room membership alone isn't enough: room_members rows outlive removal from the workspace.
create function private.can_use_room(room uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.room_members
    where room_id = room and user_id = (select auth.uid())
  ) and private.is_workspace_member(private.room_workspace(room));
$$;

revoke execute on all functions in schema private from public;
grant execute on function private.topic_room(text), private.can_use_room(uuid) to authenticated;

create policy "room channels: members receive" on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension in ('broadcast', 'presence')
    and private.can_use_room(private.topic_room((select realtime.topic())))
  );

create policy "room channels: members send" on realtime.messages
  for insert to authenticated
  with check (
    realtime.messages.extension in ('broadcast', 'presence')
    and private.can_use_room(private.topic_room((select realtime.topic())))
  );
