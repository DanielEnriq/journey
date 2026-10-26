import { h, Fragment } from '../../../vendor/preact.js';
import { useEffect, useRef, useState } from '../../../vendor/preact-hooks.js';
import { useStore } from '../../../shared/store.js';
import { Avatar } from '../../../ui/components.js';
import { Icon } from '../../../ui/icons.js';
import { callPresence, type CallPresence } from '../../call/presence.js';
import { callView, yourState, type CallPerson, type CallView } from './call-view.js';

// The call, as one small cluster at the right end of the window band, the same everywhere:
//   presence   a live dot, the room's name (only when you look elsewhere), up to three faces, Vowe's mark
//              (hollow while your mic is off, ringed while it hears you); opens the popover
//   mic        one icon; muted is the filled, quiet state; disabled with the reason when it can't be used
//   hang-up    the danger colour, the only red in the window; disabled while leaving
// In the call's own room canvas Journey's CallBar is on screen, so the cluster shows presence only.
// Driven only by `callPresence`: every control acts through `act`, and nothing here keeps mute or link state.

const TONE = { me: 1, peer: 2, p2: 3, p3: 4 } as const;
const Face = ({ p }: { p: CallPerson }) => <Avatar initials={p.initials} tone={TONE[p.tone]} size={20} name={p.name} />;

/** Opens the call's room: the app's router follows the hash. */
export function goToCallRoom(roomId: string) {
  location.hash = '#/room/' + encodeURIComponent(roomId);
}

export interface CallClusterProps {
  /** The room on screen (null on Home and its pages). */
  looking: string | null;
  /** That room's canvas is showing, so its CallBar is too. */
  canvasShown?: boolean;
}

/** The cluster, from `callPresence`; renders nothing when you're in no call. */
export function CallCluster({ looking, canvasShown = false }: CallClusterProps) {
  const { call } = useStore(callPresence);
  useCallKeys();
  if (!call) return null;
  return <Cluster c={call} v={callView(call, { looking, canvasShown })} />;
}

function Cluster({ c, v }: { c: CallPresence; v: CallView }) {
  const [open, setOpen] = useState(false);
  const pill = useRef<HTMLButtonElement>(null);
  const tip = v.here ? v.label : `${v.label} · ⌘⇧C to go back`;
  return (
    <div class={'vc-call' + (v.trouble ? ` is-${v.trouble}` : '')} role="group" aria-label="Your call">
      <button ref={pill} type="button" class="vc-pill" aria-haspopup="dialog" aria-expanded={open} aria-label={`${v.label}. Show the call`} data-tip={tip} data-tip-end="" onClick={() => setOpen(!open)}>
        <span class={'vc-live' + (v.trouble ? ' is-off' : '')} aria-hidden="true" />
        {v.trouble ? <span class="vc-trouble">{v.trouble === 'dropped' ? 'Call dropped' : v.trouble === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}</span> : null}
        {!v.here ? <span class="vc-room">{v.roomName}</span> : null}
        {v.others.length ? <span class="v-avstack vc-faces" aria-hidden="true">{v.others.slice(0, 3).map((p) => <Face key={p.key} p={p} />)}</span> : null}
        {v.others.length > 3 ? <span class="vc-more" aria-hidden="true">+{v.others.length - 3}</span> : null}
        {v.vowe ? <span class={'vc-vmark' + (v.hearing ? ' is-hearing' : ' is-deaf')} aria-hidden="true" /> : null}
      </button>
      {v.canRejoin ? <button type="button" class="v-btn v-btn-sm vc-rejoin" onClick={() => c.act.rejoin?.()}>Rejoin</button> : null}
      {!v.barShown ? (
        <>
          <button type="button" class="v-iconbtn vc-mic" aria-pressed={v.muted} disabled={!!v.micOff || v.trouble === 'dropped' || v.leaving}
            aria-label={v.micOff ? `Mic off: ${v.micOff}` : v.muted ? 'Unmute' : 'Mute'} data-tip={v.micOff ?? `${v.muted ? 'Unmute' : 'Mute'} · ⌘⇧M`} data-tip-end="" onClick={() => c.act.mic()}>
            <Icon name={v.muted ? 'mic-off' : 'mic'} />
            {!v.muted && v.speaking === 'me' ? <span class="vc-lvl" aria-hidden="true"><i /><i /><i /></span> : null}
          </button>
          <button type="button" class="v-iconbtn vc-hang" aria-label="Leave the call" data-tip={v.leaving ? 'Leaving…' : 'Leave the call'} data-tip-end="" disabled={v.leaving} onClick={() => void c.act.leave()}>
            <Icon name="call-end" />
          </button>
        </>
      ) : null}
      {open ? <CallPop c={c} v={v} pill={pill} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

function CallPop({ c, v, pill, onClose }: { c: CallPresence; v: CallView; pill: { current: HTMLButtonElement | null }; onClose(): void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('button')?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); pill.current?.focus(); } };
    const down = (e: PointerEvent) => { const t = e.target as Node; if (box.current && !box.current.contains(t) && !pill.current?.contains(t)) onClose(); };
    addEventListener('keydown', key, true);
    addEventListener('pointerdown', down);
    return () => { removeEventListener('keydown', key, true); removeEventListener('pointerdown', down); };
  }, []);
  // Focus that would be lost with the popover goes back to the pill.
  const close = () => { const inside = box.current?.contains(document.activeElement); onClose(); if (inside) pill.current?.focus(); };
  return (
    <div class="vc-pop" role="dialog" aria-label="The call" ref={box}>
      <h4>{v.roomName}</h4>
      <div class="vc-s">
        {v.trouble === 'dropped' ? 'The connection dropped. Nobody hears you until you rejoin.'
          : v.trouble === 'reconnecting' ? 'Reconnecting. You stay in the call while it does.'
          : v.here ? 'You’re here, in this room’s call' : 'You’re in this call while you look elsewhere'}
      </div>
      <ul>
        <li><Face p={v.me} /><span>You</span><span class="vc-ps">{yourState(v)}</span></li>
        {v.others.map((p) => <li key={p.key}><Face p={p} /><span>{p.name}</span><span class="vc-ps">{v.speaking === p.key ? 'speaking' : 'in the call'}</span></li>)}
        {v.vowe ? <li><span class={'vc-vmark' + (v.hearing ? ' is-hearing' : ' is-deaf')} aria-hidden="true" /><span>{v.agentName}</span><span class="vc-ps">{v.hearing ? 'hears you' : 'can’t hear you'}</span></li> : null}
      </ul>
      <p class="vc-s vc-note">{v.voweLine}.</p>
      <div class="vc-acts">
        {!v.here ? <button type="button" class="v-btn v-btn-ink" onClick={() => { onClose(); goToCallRoom(v.roomId); }}>Go to the room</button> : null}
        {v.canRejoin ? <button type="button" class="v-btn" onClick={() => { c.act.rejoin?.(); }}>Rejoin</button> : null}
        {!v.micOff && v.trouble !== 'dropped' ? <button type="button" class="v-btn" onClick={() => c.act.mic()}>{v.muted ? 'Unmute' : 'Mute'}</button> : null}
        <button type="button" class="v-btn v-btn-quiet vc-leave" disabled={v.leaving} onClick={() => { close(); void c.act.leave(); }}>{v.leaving ? 'Leaving…' : 'Leave call'}</button>
      </div>
    </div>
  );
}

/* ⌘⇧M toggles your mic and ⌘⇧C goes to the call's room, from anywhere a cluster is mounted. Several clusters
   can be mounted at once (a kept-alive room's band and the screen's), so one listener serves them all. */
let keyUsers = 0;
function onCallKey(e: KeyboardEvent) {
  if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey) return;
  const call = callPresence.state.call;
  if (!call) return;
  const k = e.key.toLowerCase();
  if (k === 'm' && !call.micOff && call.link !== 'dropped' && call.link !== 'leaving') { e.preventDefault(); call.act.mic(); }
  else if (k === 'c') { e.preventDefault(); goToCallRoom(call.roomId); }
}
function useCallKeys() {
  useEffect(() => {
    if (keyUsers++ === 0) addEventListener('keydown', onCallKey);
    return () => { if (--keyUsers === 0) removeEventListener('keydown', onCallKey); };
  }, []);
}
