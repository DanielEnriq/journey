import type { CanvasDocument, Component, Relationship, ViewSpec } from '../model.js';

// A Scene is one view of the document laid out in the canvas's existing visual grammar: the same parts,
// wires, labels, boundaries and steps the Payment Reliability design draws (room/canvas/Surface.tsx),
// with what each part draws inside itself. The renderer only maps these onto its components; it never
// decides where anything goes or what it says.

export type Rect = [number, number, number, number];

/** The design's part kinds (shape) and the block each draws inside itself. */
export type PartKind = 'service' | 'queue' | 'external' | 'store';
export type PartSmart = 'endpoint' | 'queue' | 'worker' | 'calls' | 'table';

/** What a part draws inside itself; the same fields the design's Inside component reads. */
export interface PartState {
  slots?: { id: string; cls: string; note: string; leased: boolean; lease: number }[];
  insts?: { name: string; job: string; g: string; cls: string }[];
  calls?: { label: string; amt: string; mark: string; cls: string }[];
  rows?: { a: string; b: string; c: string; cls: string; cCls: string }[];
  cols?: string;
  endpoint?: string;
  cap: string;
  capCls: string;
}

export interface SceneNode {
  /** The visual key: the component's id, or `id#2` for its second copy. */
  key: string;
  component: string;
  instance: number;
  kind: PartKind;
  smart: PartSmart;
  name: string;
  short: string;
  tech: string;
  rect: Rect;
  proposed: boolean;
  /** How long it waits before moving in, so a view assembles in order. */
  delay: number;
  state: PartState;
}

export interface SceneWire { c: string; x: number; y: number; w: number; h: number; d?: number }
export interface SceneLabel { t: string; x: number; y: number }
export interface SceneBound { x: number; y: number; w: number; h: number; label: string; component?: string }
export interface SceneStep { id: string; n: string; title: string; sub: string; short: string; x: number; y: number; tone?: string; component: string }

export interface Scene {
  view: string;
  type: ViewSpec['type'];
  name: string;
  question: string;
  provenance: string;
  parent?: string;
  proposed: boolean;
  recipe: { arrangement: string; blocks: string[] };
  viewBox: [number, number];
  nodes: SceneNode[];
  wires: SceneWire[];
  labels: SceneLabel[];
  bounds: SceneBound[];
  steps: SceneStep[];
  neighbours: Record<string, string[]>;
}

/* ---------- Reading a system: who consumes what, who calls whom. ---------- */

export const PART: Record<string, { kind: PartKind; smart: PartSmart; w: number; h: number } | undefined> = {
  service: { kind: 'service', smart: 'endpoint', w: 210, h: 146 },
  worker: { kind: 'service', smart: 'worker', w: 210, h: 146 },
  queue: { kind: 'queue', smart: 'queue', w: 220, h: 146 },
  database: { kind: 'store', smart: 'table', w: 210, h: 140 },
  external: { kind: 'external', smart: 'calls', w: 190, h: 146 },
};

/** A service that only receives (an endpoint, no running copies) is drawn smaller, as the design does. */
export function size(c: Component): [number, number] {
  const p = PART[c.kind]!;
  return c.kind === 'service' && c.endpoint ? [180, 112] : [p.w, p.h];
}

export interface System {
  doc: CanvasDocument;
  get(id: string): Component | undefined;
  rels: Relationship[];
  /** The queue a component takes its work from. */
  queueOf(id: string): Component | undefined;
  consumeRel(id: string): Relationship | undefined;
  /** The call a component makes that can't be taken back: to an external system first. */
  effectOf(id: string): Relationship | undefined;
  /** The jobs waiting in a queue, in order. */
  jobsIn(queue: string): Component[];
  /** The job a consumer is working on in the steady state. */
  leasedBy(consumer: string): Component | undefined;
}

export function readSystem(doc: CanvasDocument): System {
  const rels = Object.values(doc.relationships);
  const get = (id: string) => doc.components[id];
  const consumeRel = (id: string) => rels.find((r) => r.kind === 'consumes' && r.from === id && get(r.to)?.kind === 'queue');
  const queueOf = (id: string) => { const r = consumeRel(id); return r ? get(r.to) : undefined; };
  const effectOf = (id: string) => {
    const calls = rels.filter((r) => r.kind === 'calls' && r.from === id && get(r.to));
    return calls.find((r) => get(r.to)!.kind === 'external') ?? calls[0];
  };
  const jobsIn = (queue: string) => Object.values(doc.components)
    .filter((c) => c.kind === 'event' && c.parent === queue)
    .sort((a, b) => (a.label ?? a.id).localeCompare(b.label ?? b.id, undefined, { numeric: true }));
  const leasedBy = (consumer: string) => {
    const q = queueOf(consumer);
    return q ? jobsIn(q.id).find((j) => j.state === 'leased') : undefined;
  };
  return { doc, get, rels, queueOf, consumeRel, effectOf, jobsIn, leasedBy };
}

/* ---------- Drawing blocks, the same class names as the design's mock. ---------- */

export const slot = (id: string, cls: string, note: string, lease = 0) => ({ id, cls: 'slot ' + cls, note, leased: cls === 'leased', lease });
export const inst = (name: string, job: string, state: '' | 'crashed' | 'ok') => ({ name, job, g: 'g' + (state ? ' ' + state : ''), cls: 'inst' + (state === 'crashed' ? ' crashed' : '') });
export const callRow = (label: string, amt: string, mark: string, cls = '') => ({ label, amt, mark, cls: 'callr' + (cls ? ' ' + cls : '') });
export const trow = (a: string, b: string, c: string, cls = '', cCls = '') => ({ a, b, c, cls: 'tr' + (cls ? ' ' + cls : ''), cCls });

/** A database's own rows, as the design's table block draws them (three columns). */
export function tableOf(c: Component): Pick<PartState, 'rows' | 'cols'> {
  const rows = (c.rows ?? []).slice(0, 4);
  return { cols: '52px 1fr 1fr', rows: rows.map((r) => trow(r[0] ?? '', r[1] ?? '', r[2] ?? '')) };
}

export const jobLabel = (j: Component | undefined) => j?.label ?? 'the job';

export function neighboursOf(edges: [string, string][]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const add = (a: string, b: string) => { const l = (out[a] ??= []); if (!l.includes(b)) l.push(b); };
  edges.forEach(([a, b]) => { add(a, b); add(b, a); });
  return out;
}
