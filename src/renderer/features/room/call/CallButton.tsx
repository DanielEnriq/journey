import { h, type ComponentChildren } from '../../../vendor/preact.js';
import { useStore } from '../../../shared/store.js';
import { Icon } from '../../../ui/icons.js';
import { Leave } from '../../../shared/components/icons.js';
import type { CallSession } from '../../call/session.js';
import { listNames, Who } from '../shell.js';
import type { RoomSummary } from '../types.js';

// The call, in the toolbar: the room is always on screen, and the call is something you start, join or leave
// from its band. Outside it: who's talking and a Start Call or Join button. In it: Leave.

const MIC_NOTE = 'Your microphone stays off until you turn it on.';

/** Starts or joins the room's call (Vowe last among who's in it, since it joins every call). */
export function CallButton({ room, session, onJoin, sheet }: { room: RoomSummary; session: CallSession; onJoin(): void; sheet?: ComponentChildren }) {
  const cs = useStore(session.store);
  const connecting = cs.roomId === room.id && cs.status === 'connecting';
  const others = room.inCall.filter((x) => x.tone !== 'me');
  const live = others.length > 0;
  const tip = live ? `Join ${listNames(others.map((x) => x.name))} in the call · ${MIC_NOTE}` : `Start a call · Vowe joins every call. ${MIC_NOTE}`;
  return (
    <div class="tb-call vm-prejoin-anchor">
      {live ? <Who people={others} vowe /> : null}
      <button class={'tb-callbtn labeled' + (live ? ' live' : '')} type="button" disabled={connecting} aria-label={live ? 'Join the call' : 'Start a call'}
        data-tip={sheet || connecting ? undefined : tip} data-tip-end="" aria-expanded={sheet ? true : undefined} onClick={onJoin}>
        {connecting ? <span class="spinlet"></span> : <Icon name="phone" />}
        <span>{connecting ? (live ? 'Joining…' : 'Connecting…') : live ? 'Join' : 'Start Call'}</span>
      </button>
      {sheet && <div class="vm-prejoin-pop">{sheet}</div>}
    </div>
  );
}

/** Ends your part in the call; the room stays on screen. */
export function LeaveButton({ leaving, onLeave }: { leaving: boolean; onLeave(): void }) {
  return (
    <div class="tb-call">
      <button class="tb-callbtn labeled leave" type="button" disabled={leaving} aria-label={leaving ? 'Leaving the call' : 'Leave the call'}
        data-tip={leaving ? undefined : 'Leave the call · the room stays open'} data-tip-end="" onClick={onLeave}>
        {leaving ? <span class="spinlet"></span> : <Leave />}
        <span>{leaving ? 'Leaving…' : 'Leave'}</span>
      </button>
    </div>
  );
}
