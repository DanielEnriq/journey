// Source: vowe-home-pass2.zip (approved Claude Design package, Pass 2), imports adapted to the vendored Preact.
/**
 * An invite, once it's opened from Home: checked against the account you're
 * signed in with, previewed, then joined. It renders Journey's `LandingState`
 * (resolved by `invites.resolve`, accepted by `invites.accept`).
 *
 * Joining the room is all this does. The call is a separate, later choice.
 * "Switch account" signs out, as it does in Journey.
 */
import { Fragment, h } from '../../../vendor/preact.js';
import { Avatar, AvatarStack, Button, FaultNotice, Spinner } from '../../components.js';
import { Icon } from '../../icons.js';

import { initialsOf } from '../common.js';
import { ERROR_COPY, joinNames, ROLE_HINT, ROLE_LABEL, type LandingState } from '../../../features/membership/model.js';
import type { IncomingInvitation, InviteContext, InviteKey } from '../../../../shared/api.js';
import { InvitationList, JoinByLink } from './JoinByLink.js';

export interface InviteGateProps {
  state: LandingState;
  onJoinRoom: () => void;
  onNotNow: () => void;
  onOpenRoom: (roomId: string) => void;
  onRetry: () => void;
  onHome: () => void;
  onSwitchAccount: () => void;
}

export function InviteGate(p: InviteGateProps) {
  const { state } = p;
  const invite = 'invite' in state ? state.invite : undefined;
  return (
    <div class="vh-gate v-grain">
      <div class="vh-invite-card vh-gate-card" aria-live="polite">
        {state.kind === 'checking' ? <div class="vh-invite-row"><Spinner />Checking the invite…</div> : null}
        {invite ? <Head invite={invite} showRole={state.kind === 'preview'} /> : null}

        {state.kind === 'already-member' ? (
          <>
            <h3>{state.roomName}</h3>
            <p class="vh-gate-body">You’re already in this room.</p>
            <div class="vh-gate-acts"><Button variant="ink" onClick={() => p.onOpenRoom(state.roomId)}>Open room</Button></div>
            <span class="vh-hint"><Icon name="mic-off" size={14} /> Opening the room doesn’t join the call.</span>
          </>
        ) : null}

        {state.kind === 'preview' ? (
          <>
            {state.room.goal ? <p class="vh-gate-goal">{state.room.goal}</p> : null}
            {state.room.members.length ? (
              <div class="vh-invite-row">
                <AvatarStack size={24} people={state.room.members.slice(0, 4).map((m, i) => ({ initials: initialsOf(m.name), tone: ((i % 4) + 2) as 2 | 3 | 4 | 5, name: m.name }))} />
                {joinNames(state.room.members.slice(0, 2).map((m) => m.name))}{state.room.members.length > 2 ? ` and ${state.room.members.length - 2} more` : ''}
              </div>
            ) : null}
            <div class="vh-gate-acts">
              <Button variant="quiet" onClick={p.onNotNow}>Not now</Button>
              <Button variant="ink" loading={state.joining} onClick={p.onJoinRoom}>{state.joining ? 'Joining' : 'Join room'}</Button>
            </div>
            <span class="vh-hint"><Icon name="mic-off" size={14} /> You’ll join the room, not the call. Your mic stays off until you choose to talk.</span>
          </>
        ) : null}

        {state.kind === 'wrong-account' ? (
          <>
            <FaultNotice title={ERROR_COPY.wrong_account.title}>
              You’re signed in as <span class="vh-mono">{state.signedInAs}</span>.{' '}
              {state.invite.via === 'email' ? <>It was sent to <span class="vh-mono">{state.invite.boundEmail}</span>.</> : <>This link only works for <span class="vh-mono">@{state.invite.domain}</span> accounts.</>}
            </FaultNotice>
            <div class="vh-gate-acts">
              <Button variant="quiet" onClick={p.onHome}>Go to your rooms</Button>
              <Button onClick={p.onSwitchAccount}>Switch account</Button>
            </div>
          </>
        ) : null}

        {state.kind === 'error' ? <ErrorBody {...p} state={state} /> : null}
      </div>
    </div>
  );
}

function Head({ invite, showRole }: { invite: InviteContext; showRole: boolean }) {
  return (
    <div class="vh-gate-head">
      <span class="vh-invite-row"><Avatar initials={initialsOf(invite.inviter.name)} tone={2} size={20} />{invite.inviter.name} {invite.via === 'email' ? 'invited you to' : 'shared a link to'}</span>
      <h3>{invite.roomName}</h3>
      {showRole ? <span class="v-meta">Joining as <b>{ROLE_LABEL[invite.role]}</b> · {ROLE_HINT[invite.role].toLowerCase()}</span> : null}
    </div>
  );
}

function ErrorBody({ state, onRetry, onHome, onSwitchAccount }: InviteGateProps & { state: Extract<LandingState, { kind: 'error' }> }) {
  const copy = ERROR_COPY[state.error];
  const inviter = state.invite?.inviter.name;
  const body = state.error === 'domain_not_allowed' && state.signedInAs
    ? `You’re signed in as ${state.signedInAs}. This link only works for @${state.invite?.domain} accounts.`
    : inviter && state.error !== 'network' ? copy.body.replace(/whoever sent it|the person who sent it|the room’s owner/i, inviter) : copy.body;
  return (
    <>
      <FaultNotice title={copy.title}>{body}</FaultNotice>
      <div class="vh-gate-acts">
        {state.error === 'domain_not_allowed'
          ? <Button variant="quiet" onClick={onSwitchAccount}>Switch account</Button>
          : <Button variant="quiet" onClick={onHome}>Go to your rooms</Button>}
        {state.error === 'network' ? <Button onClick={onRetry}>Try again</Button> : null}
      </div>
    </>
  );
}

/** The Invitations page: what's waiting for your address, and the link field (not in the demo, which has no `onOpen`). */
export function InvitationsIndex({ invitations, onOpen, now }: { invitations: IncomingInvitation[] | null; onOpen?: (key: InviteKey) => void; now?: number }) {
  return (
    <div class="vh-page vh-enter">
      <header class="vh-index-head"><div><div class="vh-eyebrow">Invitations</div><h1>Invitations</h1></div></header>
      <div class="vh-inv-grid">
        <section>
          <div class="vh-sec-h"><span class="v-label">For you</span></div>
          {invitations === null ? <div class="vh-invite-row"><Spinner />Looking for invitations…</div>
            : invitations.length && onOpen ? <InvitationList invitations={invitations} onOpen={onOpen} now={now} />
            : <p class="vh-empty">No invitations waiting. Email invitations sent to the address you sign in with show up here. Someone who shared a link can send it to you directly.</p>}
        </section>
        <section>
          <div class="vh-sec-h"><span class="v-label">Have a link?</span></div>
          {onOpen ? <JoinByLink onOpen={onOpen} /> : <p class="vh-empty">Invite links open in your own rooms, not in the demo.</p>}
        </section>
      </div>
    </div>
  );
}

