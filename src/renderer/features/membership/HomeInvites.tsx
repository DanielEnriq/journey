import { h } from '../../vendor/preact.js';
import { useEffect, useState } from '../../vendor/preact-hooks.js';
import type { IncomingInvitation, InviteKey } from '../../../shared/api.js';
import { initials } from '../../shared/account.js';
import { ROLE_LABEL, ago, inviteTokenIn, type InviteSource } from './model.js';
import { Avatar, Icon } from './primitives.js';

/**
 * Home's way into other people's rooms: email invitations waiting for the account you signed in with,
 * and a field to paste a room's invite link. Either opens the invite (InviteLanding); nothing joins a
 * room or its call from here.
 */
export function HomeInvites({ source, onOpen, refreshKey }: { source: InviteSource; onOpen(key: InviteKey): void; refreshKey?: unknown }) {
  const [mine, setMine] = useState<IncomingInvitation[]>([]);
  const [text, setText] = useState('');
  const [bad, setBad] = useState(false);
  useEffect(() => { source.mine().then(setMine, () => setMine([])); }, [source, refreshKey]);
  const redeem = () => {
    const token = inviteTokenIn(text);
    if (!token) { setBad(true); return; }
    setText('');
    onOpen({ token });
  };
  const now = Date.now();
  return (
    <div class="vm-invites-home">
      {mine.length > 0 && <span class="ws-k">Invitations for you</span>}
      {mine.map((i) => (
        <div key={i.id} class="vm-invite-row-home">
          <Avatar user={{ initials: initials(i.inviterName) || '?', tone: 'peer' }} size={24} />
          <span class="vm-row-text">
            <span class="vm-row-name">{i.roomName}</span>
            <span class="vm-row-sub">{i.inviterName} invited you as {ROLE_LABEL[i.role]} · {ago(Date.parse(i.sentAt), now)}</span>
          </span>
          <button type="button" class="vm-btn vm-btn-small vm-btn-primary" onClick={() => onOpen({ invitationId: i.id })}>Open</button>
        </div>
      ))}
      <div class="vm-redeem">
        <div class={`vm-field${bad ? ' vm-field-error' : ''}`}>
          <Icon.link />
          <label class="vm-sr" for="vm-redeem-input">Invite link</label>
          <input id="vm-redeem-input" type="text" autoComplete="off" spellcheck={false} placeholder="Paste an invite link to join a room" value={text}
            onInput={(e) => { setText((e.currentTarget as HTMLInputElement).value); setBad(false); }}
            onKeyDown={(e) => { if (e.key === 'Enter') redeem(); }} />
        </div>
        <button type="button" class="vm-btn" disabled={!text.trim()} onClick={redeem}>Open invite</button>
      </div>
      {bad && <div class="vm-inline-error" role="alert"><b>That isn’t a Vowe invite link.</b> It starts with vowe://join/. Copy it again from the message.</div>}
    </div>
  );
}
