// Source: vowe-home-pass2.zip (approved Claude Design package, Pass 2), imports adapted to the vendored Preact.
/**
 * Home's ways into other people's rooms, matching Journey's `HomeInvites`:
 * email invitations for the address you signed in with (`invites.mine()`), and
 * a field that takes a room's invite link. Pasting is the supported path today.
 * The field accepts the `vowe://join/…` link, the link inside a longer message,
 * a `/j/…` link or the bare token. Either one opens the invite; nothing here
 * joins a room or its call.
 */
import { h } from '../../../vendor/preact.js';
import { useState } from '../../../vendor/preact-hooks.js';

import { Avatar, Button } from '../../components.js';
import { Icon } from '../../icons.js';

import { ago, initialsOf } from '../common.js';
import { inviteTokenIn, ROLE_LABEL } from '../../../features/membership/model.js';
import type { IncomingInvitation, InviteKey } from '../../../../shared/api.js';

export function JoinByLink({ onOpen, compact, autoFocus }: { onOpen: (key: InviteKey) => void; compact?: boolean; autoFocus?: boolean }) {
  const [text, setText] = useState('');
  const [bad, setBad] = useState(false);
  const redeem = () => {
    const token = inviteTokenIn(text);
    if (!token) { setBad(true); return; }
    setText('');
    onOpen({ token });
  };
  return (
    <div class={`vh-joinlink${compact ? ' is-compact' : ''}`}>
      <div class="vh-joinlink-row">
        <label class={`v-field vh-joinlink-field${bad ? ' is-error' : ''}`}>
          <Icon name="link" size={14} />
          <span class="v-sr">Invite link</span>
          <input type="text" autoComplete="off" spellcheck={false} autoFocus={autoFocus} placeholder="Paste an invite link to join a room" value={text}
            aria-invalid={bad} aria-describedby={bad ? 'vh-joinlink-err' : undefined}
            onInput={(e) => { setText((e.currentTarget as HTMLInputElement).value); setBad(false); }}
            onKeyDown={(e) => { if (e.key === 'Enter') redeem(); }} />
        </label>
        <Button disabled={!text.trim()} onClick={redeem}>Open invite</Button>
      </div>
      {bad ? (
        <p id="vh-joinlink-err" class="vh-inline-err" role="alert"><b>That isn’t a Vowe invite link.</b> It starts with vowe://join/. Copy it again from the message.</p>
      ) : compact ? null : (
        <p class="vh-hint">Links work on any computer where you’re signed in to Vowe. A link inside a message works too.</p>
      )}
    </div>
  );
}

/** Email invitations sent to the address you signed in with. */
export function InvitationList({ invitations, onOpen, now = Date.now() }: { invitations: IncomingInvitation[]; onOpen: (key: InviteKey) => void; now?: number }) {
  return (
    <div class="vh-needs">
      {invitations.map((i) => (
        <div key={i.id} class="vh-need is-invite vh-enter">
          <Avatar initials={initialsOf(i.inviterName)} tone={2} size={28} />
          <span class="vh-need-main">
            <b>{i.roomName}</b>
            <span>{i.inviterName} invited you as {ROLE_LABEL[i.role]} · {ago(i.sentAt, now)}</span>
          </span>
          <span class="vh-need-acts"><Button size="sm" onClick={() => onOpen({ invitationId: i.id })}>Open</Button></span>
        </div>
      ))}
    </div>
  );
}
