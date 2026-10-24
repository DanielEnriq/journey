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
  /** Disconnecting: the bar stays, but leave can't be pressed twice. */
  leaving: boolean;
  leave(): void;
}

export function CallBar({ c }: { c: CallControls }) {
  return (
    <div class={'call' + (c.leaving ? ' leaving' : '')} role="group" aria-label="Call">
      <button class={c.voweCls} type="button" aria-expanded={c.partOpen} aria-label={`Vowe · ${c.agentLabel}`} title={c.voiceOff ?? `Vowe · ${c.agentLabel}`} disabled={!!c.voiceOff} onClick={c.togglePart}><span class="orb"></span></button>
      {c.partOpen && (
        <div class="part-pop" role="group" aria-label="How Vowe takes part">
          {CHIMES.map((o) => (
            <button key={o.id} class={'opt' + (c.chime === o.id ? ' on' : '')} type="button" aria-pressed={c.chime === o.id} onClick={() => c.pickChime(o.id)}><b>{o.title}</b><span>{o.sub}</span></button>
          ))}
        </div>
      )}
      <span class="sep"></span>
      <button class={c.micCls} type="button" aria-label={c.micLabel} title={c.voiceOff ?? `${c.micLabel} · hold to talk over Vowe`} disabled={!!c.voiceOff}
        onPointerDown={c.micDown} onPointerUp={c.micUp} onPointerLeave={c.micUp}>
        <Mic muted={c.muted} />
      </button>
      <button class={c.ccCls} type="button" aria-pressed={c.cc} aria-label="Captions" title={c.voiceOff ?? 'Captions'} disabled={!!c.voiceOff} onClick={c.toggleCc}><Captions /></button>
      <span class="sep"></span>
      <button class="cbtn leave" type="button" aria-label={c.leaving ? 'Leaving the call' : 'Leave call'} title={c.leaving ? 'Leaving…' : 'Leave call'} disabled={c.leaving} onClick={c.leave}><Leave /></button>
    </div>
  );
}
