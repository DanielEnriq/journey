import { Fragment, h } from '../../vendor/preact.js';
import { useEffect, useRef, useState } from '../../vendor/preact-hooks.js';
import { AccessList } from './AccessList.js';
import { AccessNotice } from './AccessNotice.js';
import { InviteByEmail } from './InviteByEmail.js';
import { InviteLinkCard } from './InviteLinkCard.js';
import { ERROR_COPY, can, type MembershipSource, type Result, type RoomAccess } from './model.js';
import { Icon } from './primitives.js';

export interface ShareDialogProps {
  access: RoomAccess;
  source: MembershipSource;
  now: number;
  /** Says what happened, quietly (a copied link, a sent invite). */
  onNote(text: string): void;
  onManage(): void;
  onClose(): void;
}

/** The changes the room's lists make, bound to one room, with failures said once in the toasts. */
export function accessActions(source: MembershipSource, roomId: string, onNote: (text: string) => void, onFailed?: (r: Result & { ok: false }) => void) {
  const tell = (done: string) => (r: Result) => { if (r.ok) onNote(done); else onFailed?.(r); return r; };
  return {
    onChangeRole: (userId: string, role: 'owner' | 'member' | 'viewer') => { void source.changeRole(roomId, userId, role).then(tell('Role changed')); },
    onRemove: (userId: string) => { void source.remove(roomId, userId).then(tell('Removed from the room')); },
    onResend: (id: string) => { void source.resend(roomId, id).then(tell('Invite sent again')); },
    onRevokeInvite: (id: string) => { void source.revokeInvite(roomId, id).then(tell('Invite withdrawn')); },
  };
}

/**
 * The Share popover, opened from the room's chrome band. Inviting by email comes first, then everyone
 * with access, then the link. It says, once and quietly, that joining the room never turns on anyone's mic.
 */
export function ShareDialog({ access, source, now, onNote, onManage, onClose }: ShareDialogProps) {
  const { roomId, roomName, link, users, members, invites, viewerId } = access;
  const [showPast, setShowPast] = useState(false);
  const [failed, setFailed] = useState<(Result & { ok: false }) | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const role = members.find((m) => m.userId === viewerId)?.role;
  const canInvite = can(role, 'invite');
  const canManage = can(role, 'manage_access');

  useEffect(() => {
    const off = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (ref.current && !ref.current.contains(t) && !t.closest('.vm-scrim') && !t.closest('[data-share-anchor]')) onClose();
    };
    document.addEventListener('mousedown', off);
    return () => document.removeEventListener('mousedown', off);
  }, [onClose]);

  const memberEmails = members.map((m) => users[m.userId]?.email.toLowerCase() ?? '');
  const pendingEmails = invites.filter((i) => i.status === 'pending').map((i) => i.email.toLowerCase());
  const past = invites.filter((i) => i.status === 'expired' || i.status === 'revoked').length;
  const actions = accessActions(source, roomId, onNote, setFailed);

  return (
    <div ref={ref} class="vm-share" role="dialog" aria-label={`Share ${roomName}`}
      onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target as HTMLElement).closest('.vm-menu')) onClose(); }}>
      <div class="vm-share-head">
        <span class="vm-share-title">Share <b>{roomName}</b></span>
        <button type="button" class="vm-icon-btn" aria-label="Close" onClick={onClose}><Icon.close /></button>
      </div>

      {canInvite ? (
        <InviteByEmail autoFocus memberEmails={memberEmails} pendingEmails={pendingEmails}
          onSend={async (emails, r) => {
            const res = await source.invite(roomId, emails, r);
            if (res.ok) onNote(emails.length === 1 ? `Invited ${emails[0]}` : `Invited ${emails.length} people`);
            return res;
          }} />
      ) : (
        <AccessNotice title="Only owners can invite people" body={<>Ask {access.ownerName} to add them.</>} />
      )}

      <div class="vm-share-sec">
        <div class="vm-sec-head">
          <span>People with access</span>
          {past > 0 && (
            <button type="button" class="vm-link-btn" onClick={() => setShowPast(!showPast)}>
              {showPast ? 'Hide past invites' : `${past} past ${past === 1 ? 'invite' : 'invites'}`}
            </button>
          )}
        </div>
        <div class="vm-share-list">
          <AccessList users={users} members={members} invites={invites} viewerId={viewerId} now={now}
            showInvites={showPast ? ['pending', 'expired', 'revoked'] : ['pending']} {...actions} onLeave={onManage} />
        </div>
        {failed && <FailureLine failure={failed} />}
      </div>

      <div class="vm-share-sec">
        <div class="vm-sec-head"><span>Invite link</span></div>
        <InviteLinkCard link={link} now={now} suggestedDomain={access.domain} canManage={canManage}
          onCreate={(s) => source.createLink(roomId, s)} onRevoke={() => source.revokeLink(roomId)}
          onCopied={(ok) => onNote(ok ? 'Link copied' : 'Couldn’t copy the link')} />
      </div>

      <div class="vm-share-foot">
        <span class="vm-quiet"><Icon.micOff />Joining the room never turns on anyone’s mic.</span>
        <button type="button" class="vm-link-btn" onClick={onManage}>Manage access</button>
      </div>
    </div>
  );
}


export function FailureLine({ failure }: { failure: Result & { ok: false } }) {
  return <div class="vm-inline-error" role="alert"><b>{ERROR_COPY[failure.error].title}.</b> {failure.detail ?? ERROR_COPY[failure.error].body}</div>;
}

/** The room's Share button in the chrome band. */
export function ShareButton({ open, onClick, label = 'Share' }: { open: boolean; onClick(): void; label?: string }) {
  return <button type="button" data-share-anchor class={`vm-sharebtn${open ? ' vm-on' : ''}`} aria-expanded={open} onClick={onClick}>{label}</button>;
}
