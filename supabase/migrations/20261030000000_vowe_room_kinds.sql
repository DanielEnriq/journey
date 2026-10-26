-- New kinds of room activity for the Vowe room's record (*_vowe_room_work.sql). On their own because a
-- new enum value can't be used in the transaction that adds it.
--
--   review      someone asked for signatures on a decision version
--   agreed      every requested signer signed a decision version
--   changes     a signer requested changes to a decision version
--   work        new work (a plan) was started
--   plan        a plan opened a new draft version after an approved one
--   authorized  a person authorized a plan version (it is frozen from then on)
--   scope       a doer asked for, or a person allowed or refused, more scope
--   question    a doer asked a question, or a person answered one
--   finding     a doer reported a finding
--   resolved    a person resolved work

alter type public.room_activity_kind add value if not exists 'review';
alter type public.room_activity_kind add value if not exists 'agreed';
alter type public.room_activity_kind add value if not exists 'changes';
alter type public.room_activity_kind add value if not exists 'work';
alter type public.room_activity_kind add value if not exists 'plan';
alter type public.room_activity_kind add value if not exists 'authorized';
alter type public.room_activity_kind add value if not exists 'scope';
alter type public.room_activity_kind add value if not exists 'question';
alter type public.room_activity_kind add value if not exists 'finding';
alter type public.room_activity_kind add value if not exists 'resolved';
