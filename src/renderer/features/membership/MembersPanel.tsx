import { h } from '../../vendor/preact.js';
import { useState } from '../../vendor/preact-hooks.js';
import { AccessList } from './AccessList.js';
import { LeaveRoomDialog } from './AccessNotice.js';
import { FailureLine, accessActions } from './ShareDialog.js';
import { can, type InviteStatus, type MembershipSource, type Result, type RoomAccess } from './model.js';
import { Icon } from './primitives.js';

const FILTERS: { key: InviteStatus; label: string }[] = [
  { key: 'pending', label: 'Pending' },
  { key: 'accepted', label: 'Accepted' },
  { key: 'expired', label: 'Expired' },
  { key: 'revoked', label: 'Withdrawn' },
];

/**
 * "People": the room's access, as a drill-in of the right column (or a section of the preview). Who's
 * here and what they can do, invitations by status, and leaving.
 */
export function MembersPanel({ access, source, now, onBack, onInvite, onLeft, onNote }: {
  access: RoomAccess;
  source: MembershipSource;
  now: number;
  /** Absent where the panel isn't a drill-in. */
  onBack?(): void;
  onInvite?(): void;
  /** After you left the room. */
  onLeft(): void;
  onNote(text: string): void;
}) {
  const { roomId, roomName, members, invites, viewerId, users } = access;
  const [filter, setFilter] = useState<InviteStatus>('pending');
  const [leaving, setLeaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<(Result & { ok: false }) | null>(null);
  const me = members.find((m) => m.userId === viewerId);
  const manage = can(me?.role, 'manage_access');
  const inCall = members.filter((m) => m.presence === 'call').length;
  const here = members.filter((m) => m.presence !== 'away').length;
  const lastOwner = me?.role === 'owner' && members.filter((m) => m.role === 'owner').length === 1 && members.length > 1;
  const count = (s: InviteStatus) => invites.filter((i) => i.status === s).length;
  const actions = accessActions(source, roomId, onNote, setFailed);
  const leave = async () => {
    setBusy(true);
    const r = await source.leave(roomId);
    setBusy(false);
    setLeaving(false);
    if (r.ok) onLeft(); else setFailed(r);
  };

  return (
    <div class="vm-panel" aria-label="People in this room">
      <div class="vm-panel-head">
        {onBack && <button type="button" class="vm-icon-btn" aria-label="Back" onClick={onBack}><Icon.back /></button>}
        <span class="vm-panel-title">People</span>
        <span class="vm-panel-sub">
          {members.length} {members.length === 1 ? 'person' : 'people'}
          {here ? ` · ${here} here` : ''}
          {inCall ? ` · ${inCall} on the call` : ''}
        </span>
      </div>

      <section class="vm-psec">
        <div class="vm-sec-head">
          <span>In this room</span>
          {onInvite && can(me?.role, 'invite') && <button type="button" class="vm-link-btn" onClick={onInvite}>Invite</button>}
        </div>
        <AccessList users={users} members={members} invites={invites} viewerId={viewerId} now={now} only="people" {...actions} onLeave={() => setLeaving(true)} />
        {failed && <FailureLine failure={failed} />}
      </section>

      {manage && (
        <section class="vm-psec">
          <div class="vm-sec-head"><span>Invitations</span></div>
          <div class="vm-seg" role="tablist" aria-label="Invitation status">
            {FILTERS.map((f) => (
              <button key={f.key} type="button" role="tab" aria-selected={filter === f.key} class={filter === f.key ? 'vm-on' : ''} onClick={() => setFilter(f.key)}>
                {f.label}
                {count(f.key) > 0 && <span>{count(f.key)}</span>}
              </button>
            ))}
          </div>
          {count(filter)
            ? <AccessList users={users} members={members} invites={invites} viewerId={viewerId} now={now} only="invites" showInvites={[filter]} {...actions} />
            : <p class="vm-empty">No {FILTERS.find((f) => f.key === filter)!.label.toLowerCase()} invitations.</p>}
        </section>
      )}

      <div class="vm-panel-foot">
        <button type="button" class="vm-btn vm-btn-ghost vm-btn-danger-text" onClick={() => setLeaving(true)}><Icon.leave />Leave room</button>
      </div>

      {leaving && (
        <LeaveRoomDialog roomName={roomName} lastOwner={lastOwner} inCall={me?.presence === 'call'} busy={busy}
          onCancel={() => setLeaving(false)} onManage={() => setLeaving(false)} onConfirm={() => void leave()} />
      )}
    </div>
  );
}
