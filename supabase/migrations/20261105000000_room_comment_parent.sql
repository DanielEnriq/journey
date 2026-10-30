-- Replies under replies. A reply may answer another reply in the same thread (`parent_id`), or the thread
-- itself (null, as every reply so far). The composite key keeps a parent in its child's thread, so a reply
-- can't hang under a message from somewhere else; deleting a reply takes its answers with it.
--
-- Additive only: existing replies stay answers to their thread, and nothing else changes.

alter table public.room_comments
  add constraint room_comments_thread_id_key unique (thread_id, id),
  add column parent_id uuid,
  add constraint room_comments_parent_fkey foreign key (thread_id, parent_id)
    references public.room_comments (thread_id, id) on delete cascade,
  add constraint room_comments_not_own_parent check (parent_id is distinct from id);

create index room_comments_parent_idx on public.room_comments (parent_id) where parent_id is not null;

grant insert (parent_id) on public.room_comments to authenticated;
