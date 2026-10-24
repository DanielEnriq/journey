import { h } from '../../vendor/preact.js';
import { useEffect, useReducer, useState } from '../../vendor/preact-hooks.js';
import type { CallService, CallSnapshot } from '../../calls/service.js';
import { AccessList } from './AccessList.js';
import { LeaveRoomDialog } from './AccessNotice.js';
import { FailureLine, ShareButton, ShareDialog, accessActions } from './ShareDialog.js';
import { can, type MembershipSource, type Result, type RoomAccess } from './model.js';

// How the room screens hold membership: the room's access kept current, a clock for "2m ago", the Share
// button with its popover, the preview's People section, and the voice call's state.

/** The room's access, read when it opens and kept current; null until it has been read. */
export function useAccess(source: MembershipSource | undefined, roomId: string): RoomAccess | null {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!source) return;
    void source.load(roomId);
    return source.subscribe(() => bump(0));
  }, [source, roomId]);
  return source?.access(roomId) ?? null;
}

export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), everyMs); return () => clearInterval(t); }, [everyMs]);
  return now;
}

/** The call as LiveKit has it: status, who's speaking, your mic. Idle where there is no voice. */
export function useVoice(voice: CallService | null | undefined): CallSnapshot | null {
  const [snap, setSnap] = useState<CallSnapshot | null>(voice?.snapshot ?? null);
  useEffect(() => voice ? voice.onChange(setSnap) : undefined, [voice]);
  return snap;
}

/** Share, in the chrome band: the button and its popover. */
export function ShareControl({ source, access, open, setOpen, onManage, onNote }: {
  source: MembershipSource;
  access: RoomAccess;
  open: boolean;
  setOpen(open: boolean): void;
  onManage(): void;
  onNote(text: string): void;
}) {
  const now = useNow();
  return (
    <div class="vm-share-anchor">
      <ShareButton open={open} onClick={() => setOpen(!open)} />
      {open && <ShareDialog access={access} source={source} now={now} onNote={onNote} onClose={() => setOpen(false)} onManage={() => { setOpen(false); onManage(); }} />}
    </div>
  );
}

/** The preview's People: who's in the room and where they are; owners manage from the same rows. */
export function PeopleSection({ source, access, onInvite, onLeft, onNote }: {
  source: MembershipSource;
  access: RoomAccess;
  onInvite(): void;
  onLeft(): void;
  onNote(text: string): void;
}) {
  const now = useNow();
  const [leaving, setLeaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<(Result & { ok: false }) | null>(null);
  const { members, viewerId, roomId } = access;
  const me = members.find((m) => m.userId === viewerId);
  const here = members.filter((m) => m.presence !== 'away').length;
  const onCall = members.filter((m) => m.presence === 'call').length;
  const lastOwner = me?.role === 'owner' && members.filter((m) => m.role === 'owner').length === 1 && members.length > 1;
  const leave = async () => {
    setBusy(true);
    const r = await source.leave(roomId);
    setBusy(false);
    setLeaving(false);
    if (r.ok) onLeft(); else setFailed(r);
  };
  return (
    <div class="rsec vm-lobby-people">
      <span class="rk">People <span>{members.length}</span>
        <span class="vm-quiet" style="margin-left:auto;font-weight:400">{[here && `${here} here`, onCall && `${onCall} on the call`].filter(Boolean).join(' · ')}</span>
      </span>
      <AccessList users={access.users} members={members} invites={access.invites} viewerId={viewerId} now={now} only="people"
        {...accessActions(source, roomId, onNote, setFailed)} onLeave={() => setLeaving(true)} />
      {failed && <FailureLine failure={failed} />}
      {can(me?.role, 'invite') && <button type="button" class="vm-link-btn" style="align-self:flex-start" onClick={onInvite}>Invite people</button>}
      {leaving && (
        <LeaveRoomDialog roomName={access.roomName} lastOwner={lastOwner} inCall={me?.presence === 'call'} busy={busy}
          onCancel={() => setLeaving(false)} onManage={() => setLeaving(false)} onConfirm={() => void leave()} />
      )}
    </div>
  );
}
