import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { applyCommand, buildScene, command, emptyDocument, PAYMENT_SYSTEM, type Actor, type CanvasDocument, type CommandArgs, type CommandName, type SceneNode } from '../../../shared/canvas/index.js';
import { anatomyOf, callsAt, captionFor, crashedAt, faceOf, glyphKey, slotsAt } from './faces-model.js';
import { NO_SEMANTICS, type CanvasSemantics, type Moment } from './semantics.js';
import { revealGates } from './story.js';

// The faces, decided without markup: which face a part gets by its smart kind, what it shows at a moment
// of the story, and what opening it shows with and without the room's semantics.

const DAN: Actor = { kind: 'human', id: 'u-dan', name: 'Daniel' };
let n = 0;
const apply = <K extends CommandName>(d: CanvasDocument, name: K, args: CommandArgs[K]) => applyCommand(d, command(name, args, `cmd-face-${++n}`), DAN).doc;
const payment = apply(emptyDocument(), 'load_system', PAYMENT_SYSTEM);
const failDoc = apply(apply(payment, 'show_view', { view: 'failure-flow', focus: 'payment-worker' }), 'add_failure', { component: 'payment-worker', mode: 'crash' });
const fail = buildScene(failDoc, 'failure-flow');
const gates = revealGates(fail);
const node = (key: string) => fail.nodes.find((x) => x.key === key)!;
const at = (view: Moment['view'], reveal: number, latency = 4): Moment => ({ view, reveal, latency });

describe('a face by what the part is', () => {
  test('each smart kind gets its own face; nothing to draw inside gets a plain one', () => {
    const arch = buildScene(payment, 'architecture');
    const faces = Object.fromEntries(arch.nodes.map((x) => [x.component, faceOf(x)]));
    assert.equal(faces['retry-queue'], 'queue');
    assert.equal(faces['payment-worker'], 'worker');
    assert.equal(faces['payment-provider'], 'calls');
    assert.ok(Object.values(faces).includes('table'));
    assert.equal(faceOf({ smart: 'queue', state: { cap: '', capCls: '' } }), 'plain');
    assert.equal(faceOf({ smart: 'endpoint', state: { endpoint: 'POST /x', cap: '', capCls: '' } }), 'endpoint');
  });
  test('the glyph follows the smart kind first, then the shape', () => {
    assert.equal(glyphKey({ smart: 'worker', kind: 'service' }), 'worker');
    assert.equal(glyphKey({ smart: 'endpoint', kind: 'service' }), 'service');
    assert.equal(glyphKey({ smart: 'calls', kind: 'external' }), 'external');
    assert.equal(glyphKey({ smart: 'table', kind: 'store' }), 'store');
  });
});

describe('a Failure flow face shows only what has happened so far', () => {
  test('the job is only leased until the lease runs out', () => {
    const q = node('retry-queue').state;
    assert.ok(slotsAt(q, at('failure-flow', 3), gates, undefined).some((s) => s.note === 'leased' && s.cls === 'slot leased'));
    assert.ok(slotsAt(q, at('failure-flow', 4), gates, undefined).some((s) => s.cls.includes('again')));
  });
  test('the worker crashes at the crash step', () => {
    const cls = node('payment-worker').state.insts![0].cls;
    assert.equal(crashedAt(cls, at('failure-flow', 2), gates), false);
    assert.equal(crashedAt(cls, at('failure-flow', 3), gates), true);
    assert.equal(crashedAt(cls, at('architecture', 1), gates), true);
  });
  test('the repeated call appears at its own step', () => {
    const p = node('payment-provider').state;
    assert.equal(callsAt(p, at('failure-flow', 4), gates, undefined).length, 1);
    assert.equal(callsAt(p, at('failure-flow', 5), gates, undefined).length, 2);
  });
  test('Concurrency without a lease shows what the view drew; with one, what the timing says', () => {
    const conc = buildScene(apply(payment, 'show_view', { view: 'concurrency', focus: 'payment-worker' }), 'concurrency');
    const prov = conc.nodes.find((x) => x.component === 'payment-provider')!.state;
    assert.equal(callsAt(prov, at('concurrency', 0), gates, undefined).length, 2);
    assert.equal(callsAt(prov, at('concurrency', 0, 4), gates, 30).length, 1);
    assert.equal(callsAt(prov, at('concurrency', 0, 40), gates, 30).length, 2);
  });
});

describe('captions and anatomy are truthful without semantics', () => {
  test('a caption is the node’s own unless the room’s semantics tell the moment', () => {
    const w = node('payment-worker');
    assert.deepEqual(captionFor(w, at('failure-flow', 5), NO_SEMANTICS), { text: w.state.cap, tone: 'bad' });
    const told: CanvasSemantics = { ...NO_SEMANTICS, caption: (x: SceneNode) => x.component === 'payment-worker' ? { text: 'told', tone: '' } : undefined };
    assert.deepEqual(captionFor(w, at('failure-flow', 5), told), { text: 'told', tone: '' });
  });

  test('opening a part without semantics shows only the document: its wires, no guarantees, code or evidence', () => {
    const a = anatomyOf(payment, 'payment-worker', NO_SEMANTICS)!;
    assert.equal(a.source, 'document');
    assert.equal(a.code, null);
    assert.equal(a.evidence, null);
    assert.ok(a.ports.length > 0);
    assert.ok(a.ports.every((p) => p.guarantee === undefined));
    const rels = Object.values(payment.relationships).filter((r) => r.from === 'payment-worker' || r.to === 'payment-worker');
    assert.deepEqual(a.ports.map((p) => p.peer).sort(), rels.map((r) => r.from === 'payment-worker' ? r.to : r.from).sort());
    assert.equal(anatomyOf(payment, 'ghost', NO_SEMANTICS), null);
  });

  test('with semantics, the agent’s reading and the evidence it cites', () => {
    const sem: CanvasSemantics = {
      ...NO_SEMANTICS,
      evidence: [{ id: 'E1', label: 'worker.ts', source: 'code', ref: 'src/worker.ts:40', basis: 'observed' }],
      anatomy: { 'payment-worker': { does: 'Charges cards.', ports: [{ dir: 'out', name: 'charge', sig: 'charge(id)', peer: 'payment-provider', guarantee: 'no idempotency key', basis: 'observed', evidence: 'E1' }], code: [{ path: 'src/worker.ts', lines: '1-80', what: 'loop' }], evidence: ['E1', 'missing'] } },
    };
    const a = anatomyOf(payment, 'payment-worker', sem)!;
    assert.equal(a.source, 'semantics');
    assert.equal(a.ports[0].guarantee!.bad, true);
    assert.deepEqual(a.evidence!.map((e) => e.id), ['E1']);
  });
});
