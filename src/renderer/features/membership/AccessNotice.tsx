import { Fragment, h, type ComponentChildren } from '../../vendor/preact.js';
import type { AccessLost } from './model.js';
import { ConfirmDialog, Icon } from './primitives.js';

/**
 * Permission denied, inline. Neutral, never amber: being unable to do something is information, not a
 * task. Always says who can help.
 */
export function AccessNotice({ title, body, action, onAction }: {
  title: string;
  body: ComponentChildren;
  action?: string;
  onAction?(): void;
}) {
  return (
    <div class="vm-notice" role="note">
      <span class="vm-notice-ico"><Icon.lock /></span>
      <span class="vm-notice-text"><b>{title}</b><span>{body}</span></span>
      {action && <button type="button" class="vm-btn vm-btn-small" onClick={onAction}>{action}</button>}
    </div>
  );
}

/**
 * The whole room is gone for this person: removed, left, or deleted. Replaces the room, ends any call
 * they were on, and keeps a way back.
 */
export function AccessLostScreen({ lost, roomName, onHome }: { lost: AccessLost; roomName: string; onHome(): void }) {
  const copy = {
    removed: {
      title: `You no longer have access to ${roomName}`,
      body: `${lost.byName ?? 'An owner'} removed you from the room. You were taken off the call and your mic was turned off.`,
    },
    left: {
      title: `You left ${roomName}`,
      body: `It’s gone from your rooms. ${lost.byName ? `${lost.byName} can invite you back` : 'An owner can invite you back'} any time.`,
    },
    room_gone: { title: 'This room no longer exists', body: 'It was deleted, or you no longer have access to it.' },
  }[lost.kind];
  return (
    <div class="vm-gate">
      <div class="vm-gate-card vm-gate-quiet">
        <span class="vm-gate-ico">{lost.kind === 'left' ? <Icon.leave /> : <Icon.lock />}</span>
        <h1 class="vm-gate-title">{copy.title}</h1>
        <p class="vm-gate-body">{copy.body}</p>
        <div class="vm-gate-acts">
          <button type="button" class="vm-btn vm-btn-primary" onClick={onHome}>Go to your rooms</button>
        </div>
      </div>
    </div>
  );
}

/** Leaving is always allowed, except for the last owner, who must hand the room on first. */
export function LeaveRoomDialog({ roomName, lastOwner, inCall, busy, onConfirm, onCancel, onManage }: {
  roomName: string;
  lastOwner: boolean;
  inCall: boolean;
  busy?: boolean;
  onConfirm(): void;
  onCancel(): void;
  onManage(): void;
}) {
  if (lastOwner) {
    return (
      <ConfirmDialog title="Make someone else an owner first"
        body={<>You’re the only owner of {roomName}. A room always needs one, so it isn’t left without anyone who can manage access.</>}
        confirmLabel="Choose an owner" destructive={false} onCancel={onCancel} onConfirm={onManage} />
    );
  }
  return (
    <ConfirmDialog title={`Leave ${roomName}?`}
      body={<>{inCall ? 'You’ll leave the call and ' : 'You’ll '}lose access to the room until someone invites you again. Your comments and signatures stay.</>}
      confirmLabel="Leave room" busy={busy} onCancel={onCancel} onConfirm={onConfirm} />
  );
}
