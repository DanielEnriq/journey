-- A third room role, and membership in the room's activity. On their own because a new enum value
-- can't be used in the transaction that adds it; the next migration (*_room_invitations.sql) uses them.
--
--   viewer   watches, comments and listens to the call, but doesn't change the room's decisions or
--            talk on its call. Enforced by RLS (next migration) and by the LiveKit token services.
--   joined / left / removed / role   who came into the room, who went, and role changes.

alter type public.room_role add value if not exists 'viewer';

alter type public.room_activity_kind add value if not exists 'joined';
alter type public.room_activity_kind add value if not exists 'left';
alter type public.room_activity_kind add value if not exists 'removed';
alter type public.room_activity_kind add value if not exists 'role';
