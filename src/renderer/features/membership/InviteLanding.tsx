import { Fragment, h } from '../../vendor/preact.js';
import type { InviteContext, InvitePerson } from '../../../shared/api.js';
import { initials } from '../../shared/account.js';
import { ERROR_COPY, ROLE_HINT, ROLE_LABEL, joinNames, type MembershipError } from './model.js';
import { Avatar, Icon, Spinner } from './primitives.js';

/**
 * What an invite looks like once you're signed in: whether it's for this account, a preview of the room,
 * and joining it. Joining the room is all this does. The call is a separate, later choice, and nothing
 * here asks for or opens the microphone. (Signing in itself is the app's sign-in screen.)
 */
export type LandingState =
  | { kind: 'checking' }
  | { kind: 'wrong-account'; invite: InviteContext; signedInAs: string }
  | { kind: 'preview'; invite: InviteContext; room: { id: string; name: string; goal: string | null; members: InvitePerson[] }; joining?: boolean }
  | { kind: 'already-member'; roomId: string; roomName: string }
  | { kind: 'error'; error: MembershipError; invite?: InviteContext; signedInAs?: string };

interface Props {
  state: LandingState;
  onSwitchAccount(): void;
  onJoinRoom(): void;
  onNotNow(): void;
  onOpenRoom(roomId: string): void;
  onRetry(): void;
  onHome(): void;
}

const avatarOf = (p: InvitePerson, tone: 'peer' | 'peer2' | 'peer3' = 'peer') => ({ initials: initials(p.name) || '?', tone });
const TONES = ['peer', 'peer2', 'peer3'] as const;

export function InviteLanding(props: Props) {
  const { state } = props;
  const invite = 'invite' in state ? state.invite : undefined;
  return (
    <div class="vm-gate">
      <div class="vm-gate-glow" aria-hidden="true"></div>
      <div class="vm-gate-card">
        {state.kind === 'checking' && <div class="vm-waitrow"><Spinner /><span>Checking the invite…</span></div>}
        {invite && <InviteHeader invite={invite} showRole={state.kind === 'preview'} />}
        {state.kind === 'already-member' && (
          <>
            <h1 class="vm-gate-room">{state.roomName}</h1>
            <p class="vm-gate-body">You’re already in this room.</p>
            <p class="vm-gate-fine vm-mic-line"><Icon.micOff />Opening the room doesn’t join the call.</p>
            <div class="vm-gate-acts">
              <button type="button" class="vm-btn vm-btn-primary vm-btn-wide" onClick={() => props.onOpenRoom(state.roomId)}>Open room</button>
            </div>
          </>
        )}
        {state.kind === 'wrong-account' && (
          <div class="vm-gate-problem">
            <b>{ERROR_COPY.wrong_account.title}</b>
            <span>
              You’re signed in as <span class="vm-mono-inline">{state.signedInAs}</span>.{' '}
              {state.invite.via === 'email'
                ? <>It was sent to <span class="vm-mono-inline">{state.invite.boundEmail}</span>.</>
                : <>This link only works for <span class="vm-mono-inline">@{state.invite.domain}</span> accounts.</>}
            </span>
            <div class="vm-gate-acts">
              <button type="button" class="vm-btn" onClick={props.onHome}>Go to your rooms</button>
              <button type="button" class="vm-btn vm-btn-primary" onClick={props.onSwitchAccount}>Switch account</button>
            </div>
          </div>
        )}
        {state.kind === 'preview' && <Preview state={state} onJoin={props.onJoinRoom} onNotNow={props.onNotNow} />}
        {state.kind === 'error' && <ErrorBody {...props} state={state} />}
      </div>
    </div>
  );
}

function InviteHeader({ invite, showRole }: { invite: InviteContext; showRole: boolean }) {
  return (
    <div class="vm-gate-head">
      <span class="vm-gate-from">
        <Avatar user={avatarOf(invite.inviter)} size={20} />
        {invite.inviter.name} {invite.via === 'email' ? 'invited you to' : 'shared a link to'}
      </span>
      <h1 class="vm-gate-room">{invite.roomName}</h1>
      {showRole && <span class="vm-gate-role">Joining as <b>{ROLE_LABEL[invite.role]}</b> · {ROLE_HINT[invite.role].toLowerCase()}</span>}
    </div>
  );
}

function Preview({ state, onJoin, onNotNow }: { state: Extract<LandingState, { kind: 'preview' }>; onJoin(): void; onNotNow(): void }) {
  const { room } = state;
  return (
    <>
      <div class="vm-preview">
        {room.goal && <p class="vm-preview-goal">{room.goal}</p>}
        <div class="vm-preview-row">
          <span class="vm-avstack">
            {room.members.slice(0, 4).map((u, i) => <Avatar key={u.id} user={avatarOf(u, TONES[i % TONES.length])} size={24} title={u.name} />)}
          </span>
          <span class="vm-preview-who">
            {joinNames(room.members.slice(0, 2).map((u) => u.name))}
            {room.members.length > 2 ? ` and ${room.members.length - 2} more` : ''}
          </span>
        </div>
      </div>
      <div class="vm-gate-acts">
        <button type="button" class="vm-btn vm-btn-ghost" onClick={onNotNow}>Not now</button>
        <button type="button" class="vm-btn vm-btn-primary vm-btn-wide" onClick={onJoin} disabled={state.joining}>
          {state.joining && <Spinner />}
          {state.joining ? 'Joining' : 'Join room'}
        </button>
      </div>
      <p class="vm-gate-fine vm-mic-line"><Icon.micOff />You’ll join the room, not the call. Your mic stays off until you choose to talk.</p>
    </>
  );
}

function ErrorBody({ state, onRetry, onHome, onSwitchAccount }: Props & { state: Extract<LandingState, { kind: 'error' }> }) {
  const copy = ERROR_COPY[state.error];
  const inviter = state.invite?.inviter.name;
  return (
    <div class="vm-gate-problem">
      <b>{copy.title}</b>
      <span>
        {state.error === 'domain_not_allowed' && state.signedInAs ? (
          <>You’re signed in as <span class="vm-mono-inline">{state.signedInAs}</span>. This link only works for <span class="vm-mono-inline">@{state.invite?.domain}</span> accounts.</>
        ) : inviter && state.error !== 'network' ? copy.body.replace(/whoever sent it|the person who sent it|the room’s owner/i, inviter) : copy.body}
      </span>
      <div class="vm-gate-acts">
        {state.error === 'domain_not_allowed'
          ? <button type="button" class="vm-btn vm-btn-ghost" onClick={onSwitchAccount}>Switch account</button>
          : <button type="button" class="vm-btn vm-btn-ghost" onClick={onHome}>Go to your rooms</button>}
        {state.error === 'network' && <button type="button" class="vm-btn vm-btn-primary" onClick={onRetry}>Try again</button>}
      </div>
    </div>
  );
}
