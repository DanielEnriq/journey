-- What the room can tell about a session without joining it: which agent runs it, whether it's stopped
-- until someone acts, and when its machine last saw it do anything.
--
--   agent         which coding agent the session belongs to. Fixed once attached, like the session id.
--   waiting       a status: the agent asked for something (Claude Code's Notification hook) and has done
--                 nothing since. waiting_on says what for; it's set exactly when the status is waiting.
--                 Whoever attached the session is who it waits on: it runs on their machine.
--   last_seen_at  the latest event the attaching machine observed. Published alongside the status, so
--                 everyone can tell a quiet session from a fresh one without the machine writing every minute.

alter table public.room_sessions
  add column agent text not null default 'claude-code' check (agent in ('claude-code', 'codex')),
  add column waiting_on text check (waiting_on in ('permission', 'input')),
  add column last_seen_at timestamptz;

alter table public.room_sessions drop constraint room_sessions_status_check;
alter table public.room_sessions
  add constraint room_sessions_status_check check (status in ('active', 'waiting', 'completed', 'attention', 'unknown')),
  add constraint room_sessions_waiting_when_waiting check ((status = 'waiting') = (waiting_on is not null));

grant update (waiting_on, last_seen_at) on public.room_sessions to authenticated;
