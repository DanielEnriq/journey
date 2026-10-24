import { instanceKey, type ViewSpec } from '../model.js';
import { countWord, instanceName, labelWidth, nounOf, plural, third, timesWord, upperFirst } from '../words.js';
import { castOf } from './failure.js';
import { callRow, inst, jobLabel, PART, slot, type Scene, type SceneNode, type SceneWire, type System } from './scene.js';

// Concurrency: several running copies of one component on the same job, forking from the queue that
// handed it out and converging on the call both of them make. The copies are visual instances of one
// semantic component (`payment-worker`, `payment-worker#2`), never separate components. With two
// copies of the Payment worker this is the design's Concurrency board.

const CENTRE = 490;
const ROW = 230;
const W = 210;

export function concurrencyScene(spec: ViewSpec, sys: System): Scene {
  const c = castOf(sys, spec.focus!, spec.subject);
  const n = spec.instances ?? 2;
  const job = jobLabel(c.job);
  const spacing = n <= 2 ? 430 : n === 3 ? 300 : 245;
  const centres = Array.from({ length: n }, (_, i) => CENTRE + (i - (n - 1) / 2) * spacing);
  const left = centres[0], right = centres[n - 1];
  const bottom = ROW + 146;
  const qTop: [number, number, number, number] = [CENTRE - 110, 0, 220, 146];
  const eTop: [number, number, number, number] = [CENTRE - W / 2, 470, W, 146];
  const workers = plural(nounOf(c.focus).split(' ').pop()!);

  const nodes: SceneNode[] = [
    {
      key: c.queue.id, component: c.queue.id, instance: 1, kind: 'queue', smart: 'queue', name: c.queue.name, short: c.queue.short ?? 'the queue',
      tech: c.queue.tech ?? '', rect: qTop, proposed: c.queue.status === 'proposed', delay: 0,
      state: {
        slots: sys.jobsIn(c.queue.id).slice(0, 3).map((j) => j.id === c.job?.id ? slot(job, 'twice', `leased ×${n}`) : j.state === 'done' ? slot(jobLabel(j), 'acked', 'done') : slot(jobLabel(j), 'visible', 'waiting')),
        cap: `${job} is held by ${countWord(n)} ${workers} at once.`, capCls: 'cap bad',
      },
    },
    ...centres.map((x, i): SceneNode => ({
      key: instanceKey(c.focus.id, i + 1), component: c.focus.id, instance: i + 1, kind: PART[c.focus.kind]!.kind, smart: 'worker',
      name: c.focus.name, short: i ? `the ${['second', 'third', 'fourth'][i - 1]} ${nounOf(c.focus)}` : c.focus.short ?? 'the ' + nounOf(c.focus),
      tech: i ? `${c.focus.tech ?? nounOf(c.focus)} · copy ${i + 1}` : c.focus.tech ?? '', rect: [x - W / 2, ROW, W, 146],
      proposed: c.focus.status === 'proposed', delay: i * 140,
      state: {
        insts: [inst(instanceName(c.focus, i + 1), `${job} · lease ${i + 1}`, '')],
        cap: `${upperFirst(third(c.verb))} ${job}${i ? ' as well' : ''}.`, capCls: i ? 'cap bad' : 'cap',
      },
    })),
    {
      key: c.effect.id, component: c.effect.id, instance: 1, kind: PART[c.effect.kind]!.kind, smart: PART[c.effect.kind]!.smart, name: c.effect.name,
      short: c.effect.short ?? 'the ' + nounOf(c.effect), tech: c.effect.tech ?? '', rect: eTop, proposed: c.effect.status === 'proposed', delay: 80,
      state: {
        calls: centres.map((_, i) => callRow(`${c.verb} ${job}`, c.job?.amount ?? '', '✓', i ? 'dup' : '')),
        cap: `The same ${c.job?.facts?.subject ?? 'job'}, ${c.past} ${timesWord(n)}.`, capCls: 'cap bad',
      },
    },
  ];

  const wires: SceneWire[] = [
    { c: 'v', x: CENTRE, y: 146, w: 1.35, h: 44, d: 260 },
    { c: 'h', x: left, y: 190, w: right - left + 1.35, h: 1.35, d: 300 },
    ...centres.map((x) => ({ c: 'v varrow', x, y: 190, w: 1.35, h: ROW - 190, d: 340 })),
    ...centres.map((x, i) => ({ c: 'v hot', x, y: bottom, w: 1.35, h: 44, d: 520 + i * 60 })),
    { c: 'h hot', x: left, y: bottom + 44, w: right - left + 1.35, h: 1.35, d: 520 + n * 50 },
    { c: 'v varrow hot', x: CENTRE, y: bottom + 44, w: 1.35, h: eTop[1] - bottom - 44, d: 560 + n * 50 },
  ];
  const fork = `same job, leased ${timesWord(n)}`, join = `${n === 2 ? 'both' : 'all'} ${c.verb}`;
  const labels = [
    { t: fork, x: Math.round(CENTRE - labelWidth(fork) / 2), y: 181 },
    { t: join, x: Math.round(CENTRE - labelWidth(join) / 2), y: bottom + 35 },
  ];
  const keys = nodes.slice(1, -1).map((x) => x.key);
  const neighbours: Record<string, string[]> = { [c.queue.id]: keys, [c.effect.id]: keys };
  keys.forEach((k) => { neighbours[k] = [c.queue.id, c.effect.id]; });

  return {
    view: spec.id, type: 'concurrency', name: spec.name, question: spec.question, provenance: spec.provenance, parent: spec.parent,
    proposed: spec.status === 'proposed',
    recipe: { arrangement: 'Fork and converge', blocks: [`Queue · ${job} held ${timesWord(n)}`, `Service · ${countWord(n)} copies`, `External · ${countWord(n)} ${c.verb}s`] },
    viewBox: [980, eTop[1] + 150], nodes, wires, labels,
    bounds: [{ x: left - W / 2 - 20, y: ROW - 25, w: right - left + W + 40, h: 146 + 49, label: `${countWord(n)} copies of ${c.focus.short ?? 'the ' + nounOf(c.focus)}`, component: c.focus.id }],
    steps: [], neighbours,
  };
}
