import { Fragment, h } from '../../vendor/preact.js';
import { useState } from '../../vendor/preact-hooks.js';
import { ROLE_HINT, ROLE_LABEL, ago, can, initialsFromEmail, until, type Invitation, type InviteStatus, type Member, type Role, type User, type UserId } from './model.js';
import { Avatar, ConfirmDialog, Menu, type MenuItem } from './primitives.js';

export interface AccessListProps {
  users: Record<UserId, User>;
  members: Member[];
  invites: Invitation[];
  viewerId: UserId;
  now: number;
  /** Which invitation statuses to list. Accepted invites are members already. */
  showInvites?: InviteStatus[];
  /** Render only part of the list (the members panel splits it into sections). */
  only?: 'people' | 'invites';
  onChangeRole?(userId: UserId, role: Role): void;
  onRemove?(userId: UserId): void;
  onLeave?(): void;
  onResend?(inviteId: string): void;
  onRevokeInvite?(inviteId: string): void;
}

const PRESENCE_LABEL = { call: 'On the call', room: 'In the room', away: '' } as const;

/**
 * Everyone with access, and everyone on the way in: members, then invitations. Owners get a menu per
 * row; others see the same list read-only. A room always keeps an owner, so the last one can't step down.
 */
export function AccessList({
  users, members, invites, viewerId, now, showInvites = ['pending', 'expired', 'revoked'], only,
  onChangeRole, onRemove, onLeave, onResend, onRevokeInvite,
}: AccessListProps) {
  const [removing, setRemoving] = useState<UserId | null>(null);
  const viewerRole = members.find((m) => m.userId === viewerId)?.role;
  const manage = can(viewerRole, 'manage_access');
  const owners = members.filter((m) => m.role === 'owner').length;
  const order = { call: 0, room: 1, away: 2 } as const;
  const sorted = [...members].sort((a, b) =>
    a.userId === viewerId ? -1 : b.userId === viewerId ? 1 : order[a.presence] - order[b.presence] || a.joinedAt - b.joinedAt);
  const people = only !== 'invites';
  const shownInvites = only === 'people' ? [] : invites.filter((i) => showInvites.includes(i.status)).sort((a, b) => b.sentAt - a.sentAt);
  const target = removing ? users[removing] : null;
  const targetMember = removing ? members.find((m) => m.userId === removing) : null;

  return (
    <div class="vm-access">
      {(people ? sorted : []).map((m) => {
        const u = users[m.userId];
        if (!u) return null;
        const me = m.userId === viewerId;
        const lastOwner = m.role === 'owner' && owners === 1;
        const items: MenuItem[] = [];
        if (manage && !me) {
          (['owner', 'member', 'viewer'] as Role[]).forEach((r) =>
            items.push({ key: r, label: ROLE_LABEL[r], hint: ROLE_HINT[r], checked: m.role === r, onSelect: () => onChangeRole?.(m.userId, r) }));
          items.push({ key: 'remove', label: 'Remove from room', destructive: true, separatorBefore: true, onSelect: () => setRemoving(m.userId) });
        }
        if (me) {
          if (manage) {
            (['owner', 'member', 'viewer'] as Role[]).forEach((r) => items.push({
              key: r, label: ROLE_LABEL[r], checked: m.role === r,
              hint: lastOwner && r !== 'owner' ? 'Make someone else an owner first' : ROLE_HINT[r],
              disabled: lastOwner && r !== 'owner', onSelect: () => onChangeRole?.(m.userId, r),
            }));
          }
          items.push({
            key: 'leave', label: 'Leave room', destructive: true, separatorBefore: manage,
            hint: lastOwner && members.length > 1 ? 'Make someone else an owner first' : undefined,
            disabled: lastOwner && members.length > 1, onSelect: () => onLeave?.(),
          });
        }
        return (
          <div key={m.userId} class="vm-row">
            <Avatar user={u} size={28} ring={m.presence === 'call'} speaking={m.speaking} />
            <span class="vm-row-text">
              <span class="vm-row-name">{u.name}{me && <span class="vm-you">You</span>}</span>
              <span class="vm-row-sub">
                {PRESENCE_LABEL[m.presence] ? (
                  <span class={`vm-presence vm-presence-${m.presence}`}><i></i>{PRESENCE_LABEL[m.presence]}{m.presence === 'call' && m.muted ? ' · muted' : ''}</span>
                ) : u.email}
              </span>
            </span>
            {items.length
              ? <Menu label={<span>{ROLE_LABEL[m.role]}</span>} items={items} ariaLabel={`Access for ${u.name}`} />
              : <span class="vm-role-static">{ROLE_LABEL[m.role]}</span>}
          </div>
        );
      })}

      {shownInvites.map((inv) => {
        const by = users[inv.invitedBy];
        const sub = inv.status === 'pending'
          ? `Invited ${ago(inv.sentAt, now)}${by && inv.invitedBy !== viewerId ? ` by ${by.name}` : ''} · expires ${until(inv.expiresAt, now)}`
          : inv.status === 'expired' ? `Invite expired ${ago(inv.expiresAt, now)}`
            : inv.status === 'revoked' ? `Invite withdrawn ${ago(inv.revokedAt ?? inv.sentAt, now)}`
              : `Joined ${ago(inv.acceptedAt ?? inv.sentAt, now)}`;
        const items: MenuItem[] = [];
        if (manage && inv.status === 'pending') {
          items.push({ key: 'resend', label: 'Send again', hint: 'Resets the 7 days', onSelect: () => onResend?.(inv.id) });
          items.push({ key: 'revoke', label: 'Withdraw invite', destructive: true, separatorBefore: true, onSelect: () => onRevokeInvite?.(inv.id) });
        }
        if (manage && (inv.status === 'expired' || inv.status === 'revoked')) items.push({ key: 'resend', label: 'Invite again', onSelect: () => onResend?.(inv.id) });
        return (
          <div key={inv.id} class={`vm-row vm-row-invite vm-inv-${inv.status}`}>
            <Avatar pendingInitials={initialsFromEmail(inv.email)} size={28} />
            <span class="vm-row-text">
              <span class="vm-row-name">{inv.email}</span>
              <span class="vm-row-sub">{sub}</span>
            </span>
            <span class={`vm-status vm-status-${inv.status}`}>
              {inv.status === 'pending' ? 'Pending' : inv.status === 'expired' ? 'Expired' : inv.status === 'revoked' ? 'Withdrawn' : 'Accepted'}
            </span>
            {items.length
              ? <Menu label={<span class="vm-sr">Actions</span>} items={items} buttonClass="vm-menu-btn vm-menu-more" ariaLabel={`Invite actions for ${inv.email}`} />
              : <span class="vm-menu-spacer"></span>}
          </div>
        );
      })}

      {removing && target && (
        <ConfirmDialog
          title={`Remove ${target.name} from this room?`}
          body={<>{target.name} loses access right away{targetMember?.presence === 'call' ? ' and is taken off the call' : ''}. Their comments and signatures stay in the record. You can invite them again later.</>}
          confirmLabel="Remove"
          onCancel={() => setRemoving(null)}
          onConfirm={() => { onRemove?.(removing); setRemoving(null); }} />
      )}
    </div>
  );
}
