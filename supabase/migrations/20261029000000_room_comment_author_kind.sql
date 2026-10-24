-- Vowe's replies in a thread. When someone comments, Vowe answers in that thread from the commenter's
-- own app, on their own model sign-in, and the reply is saved as theirs (`created_by`) but marked as
-- Vowe's, so the room shows Vowe's orb rather than their initials. Same arrangement as the canvas's
-- `room_canvas_ops.actor_kind`.
--
-- Additive only: existing replies become 'human', and nothing else changes. A person can mark only
-- their own inserts (the "members reply" policy still requires created_by = auth.uid()).

alter table public.room_comments
  add column author_kind text not null default 'human' check (author_kind in ('human', 'agent'));

grant insert (author_kind) on public.room_comments to authenticated;
