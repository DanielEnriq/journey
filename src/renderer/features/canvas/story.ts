import { ARCHITECTURE_VIEW, readSystem, type CanvasDocument, type Scene, type ViewSpec } from '../../../shared/canvas/index.js';

// The instruments' pure logic: how far a Failure flow has played (the scrubber), what each step reveals
// on the parts, two copies' timing on one job, and what the Concurrency instrument asks the engine to
// do. Everything here reads the canvas document and its scenes, never a domain's wording.

/* ---------- Failure flow: the scrubber. ---------- */

/** The step (1-based) at which each thing on the parts first happens; Infinity if it never does. */
export interface RevealGates {
  total: number;
  /** The focus crashes or times out. */
  crashAt: number;
  /** The queue hands the job out again. */
  againAt: number;
  /** Each irreversible call, in order: the first is the one that worked, every later one a repeat. */
  effectAt: number[];
  /** The last step on each component: its caption tells where it ended up, so it waits for that step. */
  lastOn: Record<string, number>;
}

export function revealGates(scene: Pick<Scene, 'steps'> | undefined): RevealGates {
  const steps = scene?.steps ?? [];
  const at = (pred: (s: Scene['steps'][number]) => boolean) => { const i = steps.findIndex(pred); return i < 0 ? Infinity : i + 1; };
  const lastOn: Record<string, number> = {};
  steps.forEach((s, i) => { lastOn[s.component] = i + 1; });
  return {
    total: steps.length,
    crashAt: at((s) => s.op ? s.op === 'crash' || s.op === 'timeout' : s.tone === 'crash'),
    againAt: at((s) => s.op === 'expire'),
    effectAt: steps.flatMap((s, i) => s.op === 'effect' ? [i + 1] : []),
    lastOn,
  };
}

/** How many steps are showing: `reveal` (the scrubber, yours) clamped to the flow. */
export const shownSteps = (reveal: number, total: number) => Math.max(total ? 1 : 0, Math.min(reveal, total));

/** One step back or forward from what's showing, never off the ends. */
export const scrubbed = (reveal: number, total: number, by: number) => total ? Math.max(1, Math.min(total, shownSteps(reveal, total) + by)) : 0;

/** Whether a part's caption has happened yet: on a Failure flow, not before the last step on it. */
export function captionDue(sceneType: Scene['type'] | undefined, gates: RevealGates, component: string, reveal: number): boolean {
  if (sceneType !== 'failure-flow') return true;
  const last = gates.lastOn[component];
  return last === undefined || shownSteps(reveal, gates.total) >= last;
}

/* ---------- Concurrency: two copies on one job. ---------- */

export interface Timing { second: boolean; ackAt: number; secondAt: number; charge2: boolean }

/**
 * Two copies of a worker on one job, given how long the slow call takes and the lease the job is held
 * for (both seconds): when the first copy acks, whether the lease ran out first, and so whether a
 * second copy leases it and repeats the side effect. Pickup is taken as 1s and the ack write as 0.3s.
 */
export function timing(latency: number, lease: number): Timing {
  const ackAt = 1 + latency + 0.3;
  const second = ackAt > lease;
  return { second, ackAt, secondAt: lease, charge2: second };
}

/** Whether a component can run as several copies on one job: it takes work from a queue and calls something. */
export function forkable(doc: CanvasDocument, component: string): boolean {
  const sys = readSystem(doc);
  return !!sys.get(component) && !!sys.queueOf(component) && !!sys.effectOf(component);
}

export const MAX_COPIES = 4;

/** What choosing `n` copies of `focus` does, from the view you're on. */
export type CopiesPlan =
  | { kind: 'show'; view: string }
  /** No Concurrency view about it yet: draw one with `n` copies. */
  | { kind: 'draw'; focus: string; instances: number }
  /** The room's Concurrency view about it, with its copies changed (saved, shared, undoable); `show` if you're elsewhere. */
  | { kind: 'set'; view: string; instances: number; show: boolean };

export function copiesPlan(doc: CanvasDocument, current: ViewSpec | undefined, focus: string, n: number): CopiesPlan | null {
  const count = Math.max(1, Math.min(MAX_COPIES, Math.round(n)));
  if (count === 1) return current?.type === 'concurrency' ? { kind: 'show', view: ARCHITECTURE_VIEW } : null;
  const views = Object.values(doc.views).filter((v) => v.type === 'concurrency' && v.focus === focus);
  const v = current?.type === 'concurrency' && current.focus === focus ? current : views.find((x) => (x.instances ?? 2) === count) ?? views[0];
  if (!v) return { kind: 'draw', focus, instances: count };
  const show = v.id !== current?.id;
  if ((v.instances ?? 2) === count) return show ? { kind: 'show', view: v.id } : null;
  return { kind: 'set', view: v.id, instances: count, show };
}

/** How many copies the view you're on runs of `focus` (1 outside a Concurrency view about it). */
export function copiesOn(current: ViewSpec | undefined, focus: string | undefined): number {
  return current?.type === 'concurrency' && focus && current.focus === focus ? current.instances ?? 2 : 1;
}
