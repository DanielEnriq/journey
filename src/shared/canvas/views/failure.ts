import { CanvasError } from '../errors.js';
import type { Component, FlowStep, ViewSpec } from '../model.js';
import { instanceName, labelWidth, nounOf, past, third, timesWord, upperFirst, verbOf } from '../words.js';
import { steady } from './architecture.js';
import {
  callRow, inst, jobLabel, neighboursOf, PART, slot,
  type PartState, type Rect, type Scene, type SceneLabel, type SceneNode, type SceneStep, type SceneWire, type System,
} from './scene.js';

// Failure flow: one job followed through the system as a sequence. The actors stand in a row (the
// queue the focus takes work from, the focus, what it calls), each with a lifeline, and the steps sit on
// the lifeline of whoever does them. What each part draws inside comes from the steps: a crash marks
// the worker's copy, an expired lease marks the job "again" in the queue, and every side effect is one
// more call the provider saw. The design's Failure flow board is this view of the Payment system.

const STRIDE = 320;
const STEP_TOP = 190;
const STEP_GAP = 70;
const WIDTH: Partial<Record<Component['kind'], number>> = { queue: 220, worker: 210, service: 210, external: 230, database: 210 };

export interface Cast { queue: Component; focus: Component; effect: Component; job: Component | undefined; verb: string; past: string }

/** Who takes part in a failure of `focus`: the queue it consumes, and the call it can't take back. */
export function castOf(sys: System, focus: string, subject?: string): Cast {
  const f = sys.get(focus);
  if (!f) throw new CanvasError('not-found', `No component "${focus}" on this canvas`, 'args.focus');
  const queue = sys.queueOf(focus), effectRel = sys.effectOf(focus);
  if (!queue || !effectRel) {
    throw new CanvasError('unsupported', `${f.name} needs to consume a queue and call something before its failures can be drawn as a sequence. Connect it first (connect_components).`, 'args.focus');
  }
  const job = subject ? sys.get(subject) : sys.leasedBy(focus) ?? sys.jobsIn(queue.id)[0];
  if (subject && (!job || job.kind !== 'event')) throw new CanvasError('not-found', `No event "${subject}" to follow`, 'args.subject');
  return { queue, focus: f, effect: sys.get(effectRel.to)!, job, verb: verbOf(effectRel), past: past(effectRel) };
}

const subjectOf = (c: Component, fallback: string) => c.facts?.subject ?? fallback;

/** The happy path: the focus takes the job, makes its call, and acknowledges. */
export function happySteps(c: Cast): FlowStep[] {
  return [lease(c), effect(c, 2), { id: 's3', actor: c.focus.id, op: 'ack', title: 'Acks the job', sub: `${jobLabel(c.job)} is done` }];
}

/**
 * The failure the room asked about, after a given step: the focus crashes (or gives up waiting) after
 * its call landed and before it acknowledged, so the queue hands the job out again and the call is
 * made a second time.
 */
export function failSteps(c: Cast, steps: FlowStep[], after: string | undefined, mode: 'crash' | 'timeout'): FlowStep[] {
  const at = after ? steps.findIndex((s) => s.id === after || s.title.toLowerCase() === after.toLowerCase()) : steps.map((s) => s.op).lastIndexOf('effect');
  if (at < 0) throw new CanvasError(after ? 'not-found' : 'unsupported', after ? `No step "${after}" in this flow` : 'This flow has no call to fail after', 'args.after');
  const kept = steps.slice(0, at + 1).filter((s) => s.op !== 'ack').map((s, i) => ({ ...s, id: `s${i + 1}` }));
  if (mode === 'timeout') {
    const last = kept[kept.length - 1];
    if (last?.op === 'effect') kept[kept.length - 1] = { ...last, sub: 'but its answer is lost' };
  }
  const n = kept.length;
  const job = jobLabel(c.job);
  const out: FlowStep[] = kept.concat([
    mode === 'crash'
      ? { id: `s${n + 1}`, actor: c.focus.id, op: 'crash', title: 'Crashes before ack', sub: 'the ack is never written', tone: 'crash' }
      : { id: `s${n + 1}`, actor: c.focus.id, op: 'timeout', title: 'Times out', sub: `can’t tell if it ${c.past}`, tone: 'crash' },
    c.queue.lease
      ? { id: `s${n + 2}`, actor: c.queue.id, op: 'expire', title: 'Lease runs out', sub: `${job} is visible again` }
      : { id: `s${n + 2}`, actor: c.queue.id, op: 'expire', title: `Hands ${job} out again`, sub: 'nobody acknowledged it' },
    {
      id: `s${n + 3}`, actor: c.effect.id, op: 'effect', tone: 'bad',
      title: `${upperFirst(subjectOf(c.effect, 'request'))} ${c.past} again`, sub: `same ${c.job ? subjectOf(c.job, 'job') : 'job'}, twice`,
    },
  ]);
  return out;
}

function lease(c: Cast): FlowStep {
  return {
    id: 's1', actor: c.focus.id, op: 'lease', title: `Picks up the ${c.queue.facts?.item ?? 'job'}`,
    sub: `job ${jobLabel(c.job)}` + (c.queue.lease ? `, ${c.queue.lease} lease` : ''),
  };
}

function effect(c: Cast, n: number): FlowStep {
  return {
    id: `s${n}`, actor: c.effect.id, op: 'effect', title: `${upperFirst(subjectOf(c.effect, 'request'))} ${c.past}`,
    sub: `${nounOf(c.effect)} confirms` + (c.job?.amount ? ` ${c.job.amount}` : ''),
  };
}

export function failureScene(spec: ViewSpec, sys: System): Scene {
  const c = castOf(sys, spec.focus!, spec.subject);
  const steps = spec.steps ?? happySteps(c);
  const actors: Component[] = [c.queue, c.focus, c.effect];
  steps.forEach((s) => { const a = sys.get(s.actor); if (a && PART[a.kind] && !actors.includes(a)) actors.push(a); });

  const rects: Record<string, Rect> = {};
  actors.forEach((a, i) => { rects[a.id] = [i * STRIDE, 0, WIDTH[a.kind] ?? 210, 146]; });
  const cx = (id: string) => rects[id][0] + rects[id][2] / 2;
  const end = STEP_TOP + steps.length * STEP_GAP;

  const wires: SceneWire[] = [];
  const labels: SceneLabel[] = [];
  for (let i = 0; i < actors.length - 1; i++) {
    const a = actors[i], b = actors[i + 1], x1 = rects[a.id][0] + rects[a.id][2], x2 = rects[b.id][0];
    wires.push({ c: 'h arrow', x: x1, y: 73, w: x2 - x1, h: 1.35 });
    const r = sys.rels.find((x) => (x.from === a.id && x.to === b.id) || (x.from === b.id && x.to === a.id));
    if (r) { const t = r.label ?? r.kind; labels.push({ t, x: Math.round(x1 + Math.max(2, (x2 - x1 - labelWidth(t)) / 2)), y: 54 }); }
  }
  actors.forEach((a) => wires.push({ c: 'life', x: cx(a.id), y: 146, w: 0, h: end - 146 }));

  const sceneSteps: SceneStep[] = steps.map((s, k) => ({
    id: s.id, n: String(k + 1), title: s.title, sub: s.sub, short: `step ${k + 1}`, tone: s.tone, component: s.actor,
    x: (rects[s.actor] ? cx(s.actor) : cx(c.focus.id)) - 110, y: STEP_TOP + k * STEP_GAP,
  }));

  const nodes: SceneNode[] = actors.map((a) => ({
    key: a.id, component: a.id, instance: 1, kind: PART[a.kind]!.kind, smart: PART[a.kind]!.smart, name: a.name,
    short: a.short ?? 'the ' + a.name.toLowerCase(), tech: a.tech ?? '', rect: rects[a.id], proposed: a.status === 'proposed', delay: 0,
    state: during(a, c, steps, sys),
  }));
  const last = actors[actors.length - 1];
  return {
    view: spec.id, type: 'failure-flow', name: spec.name, question: spec.question, provenance: spec.provenance, parent: spec.parent,
    proposed: spec.status === 'proposed',
    recipe: { arrangement: `Sequence over job ${jobLabel(c.job)}`, blocks: actors.map((a) => blockOf(a, c, steps)) },
    viewBox: [rects[last.id][0] + rects[last.id][2], end + 10], nodes, wires, labels, bounds: [], steps: sceneSteps,
    neighbours: neighboursOf(actors.slice(1).map((a, i) => [actors[i].id, a.id])),
  };
}

/** What a part draws while the flow plays out, read from the steps. */
function during(a: Component, c: Cast, steps: FlowStep[], sys: System): PartState {
  const job = jobLabel(c.job);
  const crashed = steps.some((s) => s.actor === c.focus.id && (s.op === 'crash' || s.op === 'timeout'));
  const again = steps.some((s) => s.actor === c.queue.id && s.op === 'expire');
  const effects = steps.filter((s) => s.actor === c.effect.id && s.op === 'effect').length;
  if (a.id === c.queue.id) {
    const slots = sys.jobsIn(a.id).slice(0, 3).map((j) => j.id === c.job?.id
      ? (again ? slot(job, 'again', 'again') : slot(job, 'leased', instanceName(c.focus, 1), 62))
      : j.state === 'done' ? slot(jobLabel(j), 'acked', 'done') : slot(jobLabel(j), 'visible', 'waiting'));
    return again
      ? { slots, cap: `No ack before the lease ran out, so ${job} goes out again.`, capCls: 'cap bad' }
      : { slots, cap: `${job} leased to ${instanceName(c.focus, 1)}.`, capCls: 'cap' };
  }
  if (a.id === c.focus.id) {
    const timedOut = steps.some((s) => s.actor === a.id && s.op === 'timeout');
    return {
      insts: [inst(instanceName(a, 1), job + (timedOut ? ' · waiting' : ''), crashed && !timedOut ? 'crashed' : '')],
      cap: timedOut ? `Gave up waiting. Did the ${c.verb} land?` : crashed ? `${upperFirst(c.verb)} went through; the ack never did.` : `${upperFirst(third(c.verb))}, then acks the job.`,
      capCls: crashed ? 'cap bad' : 'cap',
    };
  }
  if (a.id === c.effect.id) {
    const amt = c.job?.amount ?? '';
    const calls = Array.from({ length: Math.max(1, effects) }, (_, i) => callRow(`${c.verb} ${job}`, amt, '✓', i ? 'dup' : ''));
    return effects > 1
      ? { calls, cap: `The same ${c.job ? subjectOf(c.job, 'job') : 'job'}, ${c.past} ${timesWord(effects)}.`, capCls: 'cap bad' }
      : { calls, cap: `${upperFirst(c.past)} once.`, capCls: 'cap' };
  }
  return steady(a, sys);
}

function blockOf(a: Component, c: Cast, steps: FlowStep[]): string {
  const job = jobLabel(c.job);
  if (a.id === c.queue.id) return steps.some((s) => s.op === 'expire') ? `Queue · ${job} handed out again` : `Queue · ${job} leased`;
  if (a.id === c.focus.id) return steps.some((s) => s.op === 'crash') ? `Service · ${instanceName(a, 1)} crashed` : `Service · ${instanceName(a, 1)}`;
  if (a.id === c.effect.id) {
    const n = steps.filter((s) => s.actor === a.id && s.op === 'effect').length;
    return `External · ${n === 1 ? 'one' : n === 2 ? 'two' : String(n)} ${n === 1 ? c.verb : c.verb + 's'}`;
  }
  return `${upperFirst(a.kind)} · ${a.name}`;
}
