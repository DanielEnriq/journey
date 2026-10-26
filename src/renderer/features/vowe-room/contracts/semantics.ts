import type { SceneNode } from '../journey.js';
import type { Basis, Evidence } from './model.js';

// What the agent has read about the system on the canvas, beyond the canvas document itself: each part's
// interfaces and code, the guarantee each wire carries, the failure scenarios it found, and the evidence
// behind all of it. Journey does not produce this yet (see BACKEND_HANDOFF.md, "Canvas semantics"); the
// renderer draws whatever it is given and draws plain faces when it is given nothing.

export interface Port { dir: 'in' | 'out'; name: string; sig: string; peer: string; guarantee: string; basis: Basis; evidence?: string }

export interface Anatomy {
  does: string;
  ports: Port[];
  state?: { k: string; v: string; basis: Basis }[];
  code: { path: string; lines: string; what: string }[];
  evidence: string[];
}

export interface WireGuarantee { text: string; basis: Basis; tone?: 'bad' | 'good' }

export interface Scenario { id: string; title: string; sub: string; basis: Basis; mode?: 'crash' | 'timeout'; view: 'failure-flow' | 'concurrency' }

/** What a view's story has reached, so a face shows only what has happened so far. */
export interface Moment {
  view: 'architecture' | 'failure-flow' | 'concurrency';
  /** Failure flow: steps shown. */
  reveal: number;
  /** Concurrency: the latency (s) of the slow call under test. */
  latency: number;
}

export interface Caption { text: string; tone: '' | 'bad' | 'good' }

export interface CanvasSemantics {
  /** By component id. */
  anatomy: Readonly<Record<string, Anatomy>>;
  /** By wire verb (the link label). */
  wires: Readonly<Record<string, WireGuarantee>>;
  /** By component id: what could go wrong there, offered on the part. */
  scenarios: Readonly<Record<string, Scenario[]>>;
  /** Everything above cites these by id; the Desk resolves evidence chips against the same list. */
  evidence: readonly Evidence[];
  /** Concurrency: the lease (s) a job is held for. Absent: the concurrency face draws no timeline. */
  lease?: number;
  /** A caption for a face at a moment of a view's story; return undefined to fall back to the node's own. */
  caption?(n: SceneNode, m: Moment, lease: number | undefined): Caption | null | undefined;
}

export const NO_SEMANTICS: CanvasSemantics = { anatomy: {}, wires: {}, scenarios: {}, evidence: [] };
