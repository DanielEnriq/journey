import { h } from '../journey.js';
import type { SceneNode } from '../journey.js';
import type { Basis } from '../contracts/model.js';
import type { CanvasSemantics, Caption, Moment } from '../contracts/semantics.js';
export type { Moment } from '../contracts/semantics.js';

// The next renderer's faces. Each kind of engineering object draws what it is, not a label in a box:
// a queue is a lane of jobs with their leases running down, a worker is its running copies, a
// provider is the ledger of calls it received, behind an edge you don't own, a table is its rows.
// The face reads the same Scene node Journey's views lay out; only the drawing is new.

export const BASIS_LABEL: Record<Basis, string> = { observed: 'Observed', inferred: 'Inferred', hypothetical: 'Hypothetical', decided: 'Decided' };

export function BasisGlyph({ b, title }: { b: Basis; title?: string }) {
  return <i class={`nx-basis b-${b}`} title={title ?? BASIS_LABEL[b]} aria-label={BASIS_LABEL[b]}></i>;
}


export interface Timing { second: boolean; ackAt: number; secondAt: number; charge2: boolean }
/** Two copies of a worker on one job: does a second lease happen, and does the side effect repeat? */
export function timing(latency: number, lease: number): Timing {
  const ackAt = 1 + latency + 0.3;
  const second = ackAt > lease;
  return { second, ackAt, secondAt: lease, charge2: second };
}

type Slot = { id: string; cls: string; note: string };
type Inst = { name: string; job: string; g: string; cls: string };
type Call = { label: string; amt: string; mark: string; cls: string };

const KIND_GLYPH: Record<string, h.JSX.Element> = {
  queue: <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="5" width="13" height="6" rx="3" /><path d="M5 5v6M8 5v6M11 5v6" /></svg>,
  worker: <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="12" height="4.5" rx="1.5" /><rect x="2" y="9" width="12" height="4.5" rx="1.5" /></svg>,
  service: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 8h4" /><rect x="6" y="3" width="8" height="10" rx="2" /></svg>,
  external: <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="2" stroke-dasharray="2 2" /><path d="M5 8h6M9 6l2 2-2 2" /></svg>,
  store: <svg viewBox="0 0 16 16" aria-hidden="true"><ellipse cx="8" cy="4" rx="5.5" ry="2" /><path d="M2.5 4v8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2V4M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2" /></svg>,
};

export function glyphFor(n: SceneNode) {
  return n.smart === 'worker' ? KIND_GLYPH.worker : n.smart === 'endpoint' ? KIND_GLYPH.service : KIND_GLYPH[n.kind] ?? KIND_GLYPH.service;
}

/** The body of a face, by what the part is. */
export function Body({ n, m, copy, lease, onLatency }: { n: SceneNode; m: Moment; copy: number; lease?: number; onLatency?(s: number): void }) {
  const st = n.state as { slots?: Slot[]; insts?: Inst[]; calls?: Call[]; rows?: { a: string; b: string; c: string; cls: string; cCls: string }[]; cols?: string; endpoint?: string; cap?: string; capCls?: string };
  const fail = m.view === 'failure-flow', conc = m.view === 'concurrency';
  const t = lease === undefined ? null : timing(m.latency, lease);
  if (n.smart === 'queue') {
    const slots = (st.slots ?? []).map((s) => {
      if (fail && s.cls.includes('again') && m.reveal < 4) return { ...s, cls: 'slot leased', note: 'leased' };
      if (conc && t && s.cls.includes('twice')) return t.second ? s : { ...s, cls: 'slot leased', note: 'leased once' };
      return s;
    });
    return (
      <span class="nx-lane">
        {slots.map((s) => (
          <span key={s.id} class={'nx-job ' + s.cls.replace('slot', '').trim()}>
            <b>{s.id}</b><small>{s.note}</small>
            {s.cls.includes('leased') && <i class="nx-leasebar" style={fail || conc ? 'animation:none;width:62%' : ''}></i>}
          </span>
        ))}
      </span>
    );
  }
  if (n.smart === 'worker') {
    const insts = st.insts ?? [];
    return (
      <span class="nx-insts">
        {insts.map((it) => {
          const crashed = it.cls.includes('crashed') && (!fail || m.reveal >= 3);
          return (
            <span key={it.name} class={'nx-inst' + (crashed ? ' crashed' : '')}>
              <span class="nx-dotg">{crashed ? '×' : ''}</span>
              <span class="nx-iname">{it.name}</span>
              <span class="nx-ijob">{it.job.split(' · ')[0]}</span>
              {conc && t && lease !== undefined ? <Lane copy={copy} t={t} lease={lease} /> : null}
            </span>
          );
        })}
      </span>
    );
  }
  if (n.smart === 'calls') {
    const calls = (st.calls ?? []).filter((c) => !c.cls.includes('dup') || (fail ? m.reveal >= 5 : conc ? !!t?.charge2 : true));
    return (
      <span class="nx-ledger">
        {calls.map((c, i) => <span key={i} class={'nx-call' + (c.cls.includes('dup') ? ' dup' : '')}><span>{c.label}</span><span class="amt">{c.amt}</span><span class="ok">{c.mark}</span></span>)}
        {conc && onLatency && lease !== undefined ? <LatencyDial latency={m.latency} lease={lease} onChange={onLatency} /> : null}
      </span>
    );
  }
  if (n.smart === 'table') {
    return (
      <span class="nx-rows">
        {(st.rows ?? []).map((r, i) => <span key={i} class={'nx-row' + (i === 0 ? ' nx-ishead' : '')}><span>{r.a}</span><span>{r.b}</span><span class={r.cCls}>{r.c}</span></span>)}
      </span>
    );
  }
  if (n.smart === 'endpoint') return <span class="nx-mouth"><b>{st.endpoint}</b></span>;
  return null;
}

/** One copy's own timeline: its lease, and its charge, on a shared 0–60s axis. */
function Lane({ copy, t, lease }: { copy: number; t: Timing; lease: number }) {
  const X = (s: number) => `${Math.min(100, (s / 60) * 100)}%`;
  if (copy === 1) {
    return (
      <span class="nx-tl" aria-label="worker-1 timeline">
        <i class="lease" style={`left:0;width:${X(lease)}`}></i>
        <i class="charge" style={`left:${X(1)};width:${X(t.ackAt - 1.3)}`}></i>
        <i class={'ack' + (t.second ? ' late' : '')} style={`left:${X(t.ackAt)}`}></i>
      </span>
    );
  }
  return t.second ? (
    <span class="nx-tl" aria-label="worker-2 timeline">
      <i class="lease" style={`left:${X(lease)};width:${X(lease)}`}></i>
      <i class="charge bad" style={`left:${X(lease + 1)};width:${X(4)}`}></i>
    </span>
  ) : (
    <span class="nx-tl idle" aria-label="worker-2 timeline"><em>never leased the job: acked at {t.ackAt.toFixed(1)}s</em></span>
  );
}

/** Drag how long the provider takes; the lease line is where it starts to matter. */
function LatencyDial({ latency, lease, onChange }: { latency: number; lease: number; onChange(s: number): void }) {
  const set = (e: PointerEvent, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const v = Math.max(0.5, Math.min(45, ((e.clientX - r.left) / r.width) * 45));
    onChange(Math.round(v * 2) / 2);
  };
  return (
    <span class={'nx-dial' + (latency + 1.3 > lease ? ' over' : '')} onPointerDown={(e) => { e.stopPropagation(); const el = e.currentTarget as HTMLElement; el.setPointerCapture(e.pointerId); set(e, el); }}
      onPointerMove={(e) => { if ((e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) set(e, e.currentTarget as HTMLElement); }}
      role="slider" aria-label="Call latency" aria-valuemin={0.5} aria-valuemax={45} aria-valuenow={latency} tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'ArrowRight') onChange(Math.min(45, latency + 1)); if (e.key === 'ArrowLeft') onChange(Math.max(0.5, latency - 1)); }}>
      <span class="nx-dial-k">call takes</span>
      <span class="nx-dial-track"><i class="leaseline" style={`left:${(lease / 45) * 100}%`}><em>lease</em></i><i class="fill" style={`width:${(latency / 45) * 100}%`}></i><i class="knob" style={`left:${(latency / 45) * 100}%`}></i></span>
      <b>{latency}s</b>
    </span>
  );
}

/** A face's caption under the body: the room's semantics may tell a moment of the story; otherwise the node's own. */
export function caption(n: SceneNode, m: Moment, sem: CanvasSemantics): Caption | null {
  const told = sem.caption?.(n, m, sem.lease);
  if (told !== undefined) return told;
  const st = n.state as { cap?: string; capCls?: string };
  if (!st.cap) return null;
  return { text: st.cap, tone: st.capCls?.includes('bad') ? 'bad' : st.capCls?.includes('good') ? 'good' : '' };
}
