import { h } from '../../../vendor/preact.js';
import { Captions, Leave, Mic } from '../../../shared/components/icons.js';
import type { Chime } from '../types.js';

// The call, docked under the canvas: Vowe's orb (and how it takes part), the mic, captions, leave.
// Only ever about the call; whoever renders it supplies the state.

const CHIMES: { id: Chime; title: string; sub: string }[] = [
  { id: 'pauses', title: 'Chime in at pauses', sub: 'Says what it has once nobody is talking.' },
  { id: 'asked', title: 'Only when asked', sub: 'Pins what it has to the canvas and waits.' },
];

export interface CallControls {
  voweCls: string;
  agentLabel: string;
  partOpen: boolean;
  chime: Chime;
  togglePart(): void;
  pickChime(c: Chime): void;
  micCls: string;
  micLabel: string;
  muted: boolean;
  micDown(): void;
  micUp(): void;
  cc: boolean;
  ccCls: string;
  toggleCc(): void;
  /** No voice in this call: Vowe, the mic and captions are off, and say why. */
  voiceOff?: string;
  /** Vowe and captions aren't in this call (people still talk): they're off, and say why. */
  agentOff?: string;
  /** Vowe can't speak in this call but can be asked by text: the orb opens the ask instead of being off. */
  askByText?(): void;
  /** The orb brings your Vowe into the call, or takes it out (its state is in voweCls and agentLabel). */
  toggleVowe?(): void;
  /** Your Vowe is in the call. */
  voweOn?: boolean;
  /** Your mic can't be used here (a viewer only listens): it's off, and says why. */
  micOff?: string;
  /** A real call's mic: a click (or Enter or Space) turns it on or off, instead of the demo's hold-to-talk. */
  micToggle?(): void;
  /** Disconnecting: the bar stays, but leave can't be pressed twice. */
  leaving: boolean;
  leave(): void;
}

export function CallBar({ c }: { c: CallControls }) {
  const agentOff = c.voiceOff ?? c.agentOff, micOff = c.voiceOff ?? c.micOff;
  return (
    <div class={'call' + (c.leaving ? ' leaving' : '')} role="group" aria-label="Call">
      {c.toggleVowe && !agentOff
        ? <button class={c.voweCls} type="button" aria-pressed={!!c.voweOn} aria-label={`Vowe · ${c.agentLabel}`}
            title={c.voweOn ? `Vowe · ${c.agentLabel} · click to take Vowe out of the call` : `Bring Vowe into the call · ${c.agentLabel}`} onClick={c.toggleVowe}><span class="orb"></span></button>
        : agentOff && c.askByText
        ? <button class={c.voweCls} type="button" aria-label="Ask Vowe" title={`Ask Vowe by text · ${agentOff}`} onClick={c.askByText}><span class="orb"></span></button>
        : <button class={c.voweCls} type="button" aria-expanded={c.partOpen} aria-label={`Vowe · ${c.agentLabel}`} title={agentOff ?? `Vowe · ${c.agentLabel}`} disabled={!!agentOff} onClick={c.togglePart}><span class="orb"></span></button>}
      {c.partOpen && (
        <div class="part-pop" role="group" aria-label="How Vowe takes part">
          {CHIMES.map((o) => (
            <button key={o.id} class={'opt' + (c.chime === o.id ? ' on' : '')} type="button" aria-pressed={c.chime === o.id} onClick={() => c.pickChime(o.id)}><b>{o.title}</b><span>{o.sub}</span></button>
          ))}
        </div>
      )}
      <span class="sep"></span>
      {c.micToggle ? (
        <button class={c.micCls} type="button" aria-label={c.micLabel} aria-pressed={!c.muted} title={micOff ?? c.micLabel} disabled={!!micOff} onClick={c.micToggle}>
          <Mic muted={c.muted} />
        </button>
      ) : (
        <button class={c.micCls} type="button" aria-label={c.micLabel} title={micOff ?? `${c.micLabel} · hold to talk over Vowe`} disabled={!!micOff}
          onPointerDown={c.micDown} onPointerUp={c.micUp} onPointerLeave={c.micUp}>
          <Mic muted={c.muted} />
        </button>
      )}
      <button class={c.ccCls} type="button" aria-pressed={c.cc} aria-label="Captions" title={agentOff ?? 'Captions'} disabled={!!agentOff} onClick={c.toggleCc}><Captions /></button>
      <span class="sep"></span>
      <button class="cbtn leave" type="button" aria-label={c.leaving ? 'Leaving the call' : 'Leave call'} title={c.leaving ? 'Leaving…' : 'Leave call'} disabled={c.leaving} onClick={c.leave}><Leave /></button>
    </div>
  );
}
