import type { Basis, Evidence } from '../../../shared/vowe/model.js';
import type { CanvasDocument, PartState, SceneNode } from '../../../shared/canvas/index.js';
import type { CanvasSemantics, Caption, Moment } from './semantics.js';
import { timing, type RevealGates } from './story.js';

// What each face draws, decided without any markup: which face a part gets (by the smart kind its view
// gave it), what its lane, copies and ledger show at this moment of the view's story, its caption, and
// what opening it shows. faces.tsx draws these; nothing here invents a domain's wording. A part's face
// reads only its SceneNode (what Journey's view layouts emit) and, when a room has them, its semantics.

export type FaceKind = 'queue' | 'worker' | 'calls' | 'table' | 'endpoint' | 'plain';

/** The face a part gets: by its smart kind, plain when its view gave it nothing to draw inside. */
export function faceOf(n: Pick<SceneNode, 'smart' | 'state'>): FaceKind {
  const st = n.state;
  if (n.smart === 'queue' && st.slots) return 'queue';
  if (n.smart === 'worker' && st.insts) return 'worker';
  if (n.smart === 'calls' && st.calls) return 'calls';
  if (n.smart === 'table' && st.rows) return 'table';
  if (n.smart === 'endpoint' && st.endpoint) return 'endpoint';
  return 'plain';
}

export type GlyphKey = 'queue' | 'worker' | 'service' | 'external' | 'store';
/** The small glyph by a part's name: what kind of thing it is. */
export function glyphKey(n: Pick<SceneNode, 'smart' | 'kind'>): GlyphKey {
  if (n.smart === 'worker') return 'worker';
  if (n.smart === 'endpoint') return 'service';
  return n.kind === 'queue' || n.kind === 'external' || n.kind === 'store' ? n.kind : 'service';
}

type Slot = NonNullable<PartState['slots']>[number];
type Call = NonNullable<PartState['calls']>[number];
const has = (cls: string, word: string) => cls.split(/\s+/).includes(word);

/**
 * A queue's jobs at this moment: on a Failure flow a job handed out again is still only leased until the
 * scrubber reaches the expiry; on Concurrency a job held twice is held once while the timing says the
 * second lease never happens.
 */
export function slotsAt(st: PartState, m: Moment, gates: RevealGates, lease: number | undefined): Slot[] {
  const t = lease === undefined ? null : timing(m.latency, lease);
  return (st.slots ?? []).map((s) => {
    if (m.view === 'failure-flow' && has(s.cls, 'again') && m.reveal < gates.againAt) return { ...s, cls: 'slot leased', note: 'leased', leased: true };
    if (m.view === 'concurrency' && t && has(s.cls, 'twice') && !t.second) return { ...s, cls: 'slot leased', note: 'leased once', leased: true };
    return s;
  });
}

/** Whether a worker's copy shows as crashed: on a Failure flow, only once the scrubber reaches the crash. */
export const crashedAt = (cls: string, m: Moment, gates: RevealGates) => has(cls, 'crashed') && (m.view !== 'failure-flow' || m.reveal >= gates.crashAt);

/**
 * The calls a provider received by now: the first always; on a Failure flow each repeat once the
 * scrubber reaches its step; on Concurrency a repeat only if the timing says the second copy made it.
 */
export function callsAt(st: PartState, m: Moment, gates: RevealGates, lease: number | undefined): Call[] {
  const t = lease === undefined ? null : timing(m.latency, lease);
  let repeat = 0;
  return (st.calls ?? []).filter((c) => {
    if (!has(c.cls, 'dup')) return true;
    repeat++;
    if (m.view === 'failure-flow') return m.reveal >= (gates.effectAt[repeat] ?? Infinity);
    if (m.view === 'concurrency' && t) return t.charge2;
    return true;
  });
}

/** A face's caption: the room's semantics may tell a moment of the story; otherwise the node's own. */
export function captionFor(n: SceneNode, m: Moment, sem: CanvasSemantics): Caption | null {
  // PASS3_BACKEND: CanvasSemantics.caption tells each moment of a story in the domain's words.
  const told = sem.caption?.(n, m, sem.lease);
  if (told !== undefined) return told;
  const st = n.state as { cap?: string; capCls?: string };
  if (!st.cap) return null;
  return { text: st.cap, tone: st.capCls?.includes('bad') ? 'bad' : st.capCls?.includes('good') ? 'good' : '' };
}

/* ---------- Anatomy: what opening a part shows. ---------- */

export interface AnatomyPort {
  dir: 'in' | 'out';
  /** The verb or signature on it. */
  sig: string;
  /** The component at the other end. */
  peer: string;
  /** What it guarantees and how we know; absent until something has read it. */
  guarantee?: { text: string; basis: Basis; evidence?: string; bad: boolean };
}

export interface AnatomyView {
  /** Where this comes from: the agent's reading of the system, or only the canvas document. */
  source: 'semantics' | 'document';
  /** What it does, in a line; absent when nothing says. */
  does?: string;
  ports: AnatomyPort[];
  state: { k: string; v: string; basis?: Basis }[];
  /** Null: not read yet (or, for a proposed part, not in the code yet). */
  code: { path: string; lines: string; what: string }[] | null;
  evidence: Evidence[] | null;
}

/**
 * What opening `component` shows. With semantics for it, the agent's reading; without, only what the
 * canvas document truthfully says (its kind and tech, its wires and their verbs, its own facts) and
 * nothing about guarantees, code or evidence.
 */
export function anatomyOf(doc: CanvasDocument, component: string, sem: CanvasSemantics): AnatomyView | null {
  const c = doc.components[component];
  if (!c) return null;
  // PASS3_BACKEND: CanvasSemantics.anatomy (ports, guarantees, state, code refs, evidence) per component.
  const a = sem.anatomy[component];
  if (a) {
    return {
      source: 'semantics', does: a.does,
      ports: a.ports.map((p) => ({ dir: p.dir, sig: p.sig, peer: p.peer, guarantee: { text: p.guarantee, basis: p.basis, evidence: p.evidence, bad: p.guarantee.startsWith('no ') || p.guarantee.includes('lost') } })),
      state: (a.state ?? []).map((r) => ({ ...r })),
      code: a.code,
      evidence: a.evidence.flatMap((id) => sem.evidence.filter((e) => e.id === id)),
    };
  }
  const ports: AnatomyPort[] = Object.values(doc.relationships)
    .filter((r) => r.from === component || r.to === component)
    .map((r) => ({ dir: r.to === component ? 'in' : 'out', sig: r.label ?? r.kind.replace('_', '/'), peer: r.from === component ? r.to : r.from }));
  const state: AnatomyView['state'] = [];
  if (c.endpoint) state.push({ k: 'Entry point', v: c.endpoint });
  if (c.lease) state.push({ k: 'Lease', v: c.lease });
  return { source: 'document', does: c.note, ports, state, code: null, evidence: null };
}
