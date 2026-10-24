// The adapter between Vowe's runtime and the canvas engine (runtime.ts): snapshots the runtime accepts,
// and runtime requests that the real engine runs under its agent rules. No model and no network.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { canvasSnapshotSchema, validateCanvasCommand, type CanvasCommand as VoweRequest, type CanvasSnapshot } from '../../assistant/canvas.js';
import type { AgentEvent } from '../api.js';
import {
  applyCommand, canvasEvents, command, emptyDocument, engineId, PAYMENT_SYSTEM, relationshipKind, snapshotOf, TurnCanvas, viewOf,
  type Actor, type CanvasDocument, type CanvasStep,
} from './index.js';

const DAN: Actor = { kind: 'human', id: 'u-dan', name: 'Daniel' };
const VOWE: Actor = { kind: 'agent', id: 'vowe', name: 'Vowe' };
const AT = '2026-10-24T12:00:00.000Z';

const payment = () => applyCommand(emptyDocument(), command('load_system', PAYMENT_SYSTEM, 'load-0001'), DAN, AT).doc;

/** A request as the runtime emits it: validated against the snapshot, with the envelope it fills in. */
function request(snapshot: CanvasSnapshot, type: VoweRequest['type'], payload: unknown, proposed = new Set<string>()): VoweRequest {
  const v = validateCanvasCommand({ v: 1, id: randomUUID(), roomId: 'room-1', turnId: 'turn-1', requestedBy: DAN.id, reason: 'Shows the room what the answer rests on.', evidence: [], visibility: 'room', type, payload }, snapshot, proposed);
  assert.ok(v.ok, v.ok ? '' : v.errors.join('; '));
  if (v.command.type === 'propose_component') proposed.add(v.command.payload.component.id);
  return v.command;
}

/** Runs steps through the engine as Vowe, as the hub does, and returns the document after them. */
function runAll(doc: CanvasDocument, steps: CanvasStep[]) {
  const results = steps.map((s) => { const out = applyCommand(doc, s.command, VOWE, AT); doc = out.doc; return out.result; });
  return { doc, results };
}

describe('the runtime sees the engine’s canvas', () => {
  test('a document becomes a snapshot the runtime accepts', () => {
    const doc = payment();
    const snap = snapshotOf(doc, { selected: ['payment-worker'], circled: [] });
    assert.ok(canvasSnapshotSchema.safeParse(snap).success, JSON.stringify(canvasSnapshotSchema.safeParse(snap).error?.issues));
    assert.equal(snap.view, 'arch');
    assert.deepEqual(snap.selection, { selected: ['payment-worker'], circled: [] });
    const worker = snap.components.find((c) => c.id === 'payment-worker')!;
    assert.equal(worker.kind, 'service');
    assert.match(worker.tech ?? '', /^worker/, 'the engine’s kind survives in tech');
    assert.equal(snap.components.find((c) => c.id === 'ledger')!.kind, 'store');
    assert.ok(snap.relationships.some((r) => r.from === 'payment-worker' && r.to === 'payment-provider'));
  });

  test('an empty room is a valid snapshot, and stale selections are dropped', () => {
    const snap = snapshotOf(emptyDocument(), { selected: ['gone'], circled: ['gone'] });
    assert.ok(canvasSnapshotSchema.safeParse(snap).success);
    assert.deepEqual(snap.selection, { selected: [], circled: [] });
    assert.deepEqual(snap.views.map((v) => v.id), ['arch']);
  });

  test('the active view and kept views are named the runtime’s way', () => {
    let doc = payment();
    doc = applyCommand(doc, command('create_view', { type: 'failure-flow', focus: 'payment-worker' }, 'view-0001'), DAN, AT).doc;
    const snap = snapshotOf(doc, { selected: [], circled: [] });
    assert.equal(snap.view, 'failure');
    assert.deepEqual(snap.views.map((v) => v.id).sort(), ['arch', 'failure']);
  });
});

describe('runtime requests run on the engine', () => {
  test('pointing and notes run at once, with the request’s id, and Vowe’s note is a suggestion', () => {
    const doc = payment(), snap = snapshotOf(doc, { selected: ['payment-worker'], circled: [] });
    const turn = new TurnCanvas(() => doc);
    const hi = request(snap, 'highlight_component', { componentIds: ['payment-worker'], tone: 'risk' });
    const note = request(snap, 'annotate_component', { componentId: 'payment-worker', kind: 'concern', text: 'A crash after the charge retries the charge.' });
    const a = turn.take(hi), b = turn.take(note);
    assert.ok('run' in a && 'run' in b);
    assert.equal(a.run[0]!.command.id, hi.id);
    const { doc: after, results } = runAll(doc, [...a.run, ...b.run]);
    assert.deepEqual(results.map((r) => r.applied), ['applied', 'applied']);
    assert.deepEqual(after.highlight?.components, ['payment-worker']);
    const n = Object.values(after.annotations)[0]!;
    assert.ok(n.kind === 'note' && n.status === 'suggested' && n.note === 'concern');
    assert.deepEqual(turn.finish(), [], 'nothing structural was asked');
  });

  test('a failure sequence with a crash draws the engine’s failure flow, proposed until kept', () => {
    const doc = payment(), snap = snapshotOf(doc, { selected: ['payment-worker'], circled: [] });
    const req = request(snap, 'show_view', {
      view: 'failure', focus: ['payment-worker'],
      sequence: { actors: ['retry-queue', 'payment-worker', 'payment-provider'], steps: [
        { actor: 'retry-queue', title: 'Hands out the job' },
        { actor: 'payment-worker', title: 'Charges the card' },
        { actor: 'payment-worker', title: 'Crashes before the ack', tone: 'crash' },
        { actor: 'payment-provider', title: 'Charged twice', tone: 'bad' },
      ] },
    });
    const taken = new TurnCanvas(() => doc).take(req);
    assert.ok('run' in taken);
    assert.equal(taken.run[0]!.command.name, 'add_failure');
    const { doc: after, results } = runAll(doc, taken.run);
    assert.equal(results[0]!.applied, 'proposed');
    const view = viewOf(after, after.activeView)!;
    assert.equal(view.type, 'failure-flow');
    assert.equal(view.status, 'proposed');
    assert.ok(view.steps!.some((s) => s.op === 'crash'));
  });

  test('architecture and concurrency are shown; views the room canvas doesn’t draw are declined with a reason', () => {
    const doc = payment(), snap = snapshotOf(doc, { selected: [], circled: [] });
    const turn = new TurnCanvas(() => doc);
    const conc = turn.take(request(snap, 'show_view', { view: 'concurrency', focus: ['payment-worker'] }));
    assert.ok('run' in conc && conc.run[0]!.command.name === 'show_view');
    assert.equal(runAll(doc, conc.run).results[0]!.applied, 'proposed');
    const alt = turn.take(request(snap, 'show_view', { view: 'alternatives' }));
    assert.ok('declined' in alt && /Alternatives/.test(alt.declined));
  });

  test('a turn’s structural requests become one proposal that waits on a person', () => {
    const doc = payment(), snap = snapshotOf(doc, { selected: ['payment-worker'], circled: [] });
    const turn = new TurnCanvas(() => doc);
    const proposed = new Set<string>();
    const add = request(snap, 'propose_component', { component: { id: 'idempotency_store', name: 'Idempotency keys', kind: 'store', tech: 'redis' }, near: 'payment-worker' }, proposed);
    const wire = request(snap, 'connect_components', { from: 'payment-worker', to: 'idempotency_store', label: 'check key' }, proposed);
    const point = request(snap, 'highlight_component', { componentIds: ['idempotency_store'], tone: 'focus' }, proposed);
    for (const r of [add, wire, point]) { const t = turn.take(r); assert.ok('run' in t && t.run.length === 0, 'everything waits for the proposal'); }

    const steps = turn.finish();
    assert.deepEqual(steps.map((s) => s.command.name), ['propose_change', 'highlight_component']);
    assert.deepEqual(steps[0]!.requests, [add.id, wire.id]);
    const { doc: after, results } = runAll(doc, steps);
    assert.deepEqual(results.map((r) => r.applied), ['proposed', 'applied']);
    const store = after.components['idempotency-store']!;
    assert.equal(store.status, 'proposed');
    assert.equal(store.kind, 'database');
    assert.equal(after.relationships['payment-worker--reads_writes--idempotency-store']?.status, 'proposed');
    const proposal = Object.values(after.proposals)[0]!;
    assert.equal(proposal.title, 'Add Idempotency keys');
    assert.equal(proposal.status, 'open');

    // Vowe can't accept its own proposal; a person can.
    assert.throws(() => applyCommand(after, command('accept_proposal', { proposal: proposal.id }, 'accept-0001'), VOWE, AT), /Only a person/);
    const kept = applyCommand(after, command('accept_proposal', { proposal: proposal.id }, 'accept-0002'), DAN, AT).doc;
    assert.equal(kept.components['idempotency-store']!.status, 'agreed');
  });

  test('a cancelled turn proposes nothing', () => {
    const doc = payment(), snap = snapshotOf(doc, { selected: [], circled: [] });
    const turn = new TurnCanvas(() => doc);
    turn.take(request(snap, 'propose_component', { component: { id: 'audit-log', name: 'Audit log', kind: 'store' } }));
    turn.drop();
    assert.deepEqual(turn.finish(), []);
  });

  test('connections the engine can’t draw are declined rather than guessed', () => {
    const doc = payment(), snap = snapshotOf(doc, { selected: [], circled: [] });
    const taken = new TurnCanvas(() => doc).take(request(snap, 'connect_components', { from: 'webhook-api', to: 'payments-service', label: 'lives in' }));
    assert.ok('declined' in taken && /boundary/.test(taken.declined));
  });

  test('an empty room can be sketched from scratch, as one proposal', () => {
    const doc = emptyDocument(), snap = snapshotOf(doc, { selected: [], circled: [] });
    const turn = new TurnCanvas(() => doc);
    const proposed = new Set<string>();
    for (const r of [
      request(snap, 'propose_component', { component: { id: 'checkout-api', name: 'Checkout API', kind: 'service' } }, proposed),
      request(snap, 'propose_component', { component: { id: 'jobs', name: 'Jobs', kind: 'queue' } }, proposed),
      request(snap, 'propose_component', { component: { id: 'charge-worker', name: 'Charge worker', kind: 'service' } }, proposed),
      request(snap, 'connect_components', { from: 'checkout-api', to: 'jobs', label: 'enqueue' }, proposed),
      request(snap, 'connect_components', { from: 'charge-worker', to: 'jobs', label: 'lease' }, proposed),
    ]) turn.take(r);
    const { doc: after, results } = runAll(doc, turn.finish());
    assert.equal(results[0]!.applied, 'proposed');
    assert.equal(after.components['charge-worker']!.kind, 'worker');
    assert.ok(after.relationships['checkout-api--publishes--jobs'] && after.relationships['charge-worker--consumes--jobs']);
  });
});

describe('vocabulary', () => {
  test('ids become the engine’s kebab case, or are refused', () => {
    assert.equal(engineId('PaymentWorker'), 'payment-worker');
    assert.equal(engineId('idempotency_store'), 'idempotency-store');
    assert.equal(engineId('ledger'), 'ledger');
    assert.equal(engineId('___'), null);
  });

  test('relationship kinds follow what they connect', () => {
    assert.equal(relationshipKind('service', 'queue', 'enqueue'), 'publishes');
    assert.equal(relationshipKind('worker', 'queue', ''), 'consumes');
    assert.equal(relationshipKind('service', 'queue', 'lease'), 'consumes');
    assert.equal(relationshipKind('worker', 'database'), 'reads_writes');
    assert.equal(relationshipKind('worker', 'external'), 'calls');
    assert.equal(relationshipKind('service', 'boundary'), null);
  });
});

describe('a turn’s events, on a real hub', () => {
  const ROOM = 'room-1';
  async function hubWithPayment() {
    const { createCanvasHub } = await import('../../integrations/supabase/canvas.js');
    const { memoryStore } = await import('./index.js');
    const store = memoryStore({ [ROOM]: { revision: 1, doc: payment() } });
    const hub = createCanvasHub({ store, person: async () => DAN, announce: async () => {} });
    await hub.load(ROOM);
    return { hub, store };
  }
  const settle = () => new Promise((r) => setTimeout(r, 20));
  const reply = { turnId: 'turn-1', conversationId: 'c', roomId: ROOM, text: '', stop: 'answered' } as never;

  test('canvas outcomes arrive before the ending event, which stays last', async () => {
    const { hub, store } = await hubWithPayment();
    const seen: AgentEvent[] = [];
    const on = canvasEvents(hub, ROOM, (e) => seen.push(e));
    const snap = snapshotOf(hub.peek(ROOM)!.doc, { selected: ['payment-worker'], circled: [] });
    const proposed = new Set<string>();
    const add = request(snap, 'propose_component', { component: { id: 'idempotency-store', name: 'Idempotency keys', kind: 'store' } }, proposed);
    const point = request(snap, 'highlight_component', { componentIds: ['payment-worker'], tone: 'risk' }, proposed);
    on({ type: 'canvas.command', turnId: 'turn-1', command: point });
    on({ type: 'canvas.command', turnId: 'turn-1', command: add });
    on({ type: 'text.final', turnId: 'turn-1', text: 'Done.' });
    on({ type: 'turn.completed', turnId: 'turn-1', reply });
    await settle();
    assert.deepEqual(seen.map((e) => e.type), ['canvas.command', 'canvas.command', 'text.final', 'canvas.applied', 'canvas.applied', 'turn.completed']);
    const applied = seen.filter((e): e is Extract<AgentEvent, { type: 'canvas.applied' }> => e.type === 'canvas.applied');
    assert.deepEqual(applied.map((e) => e.result.ok && e.result.applied), ['applied', 'proposed']);
    assert.deepEqual(applied[1]!.requests, [add.id]);
    const saved = store.rooms[ROOM]!;
    assert.equal(saved.revision, 3);
    assert.equal(saved.doc.components['idempotency-store']!.status, 'proposed');
  });

  test('a cancelled turn saves no proposal, and a decline is reported', async () => {
    const { hub, store } = await hubWithPayment();
    const seen: AgentEvent[] = [];
    const on = canvasEvents(hub, ROOM, (e) => seen.push(e));
    const snap = snapshotOf(hub.peek(ROOM)!.doc, { selected: [], circled: [] });
    on({ type: 'canvas.command', turnId: 'turn-1', command: request(snap, 'show_view', { view: 'ui' }) });
    on({ type: 'canvas.command', turnId: 'turn-1', command: request(snap, 'propose_component', { component: { id: 'audit-log', name: 'Audit log', kind: 'store' } }) });
    on({ type: 'turn.cancelled', turnId: 'turn-1', reason: 'interrupted', reply });
    await settle();
    assert.deepEqual(seen.map((e) => e.type), ['canvas.command', 'canvas.applied', 'canvas.command', 'turn.cancelled']);
    const declined = seen[1] as Extract<AgentEvent, { type: 'canvas.applied' }>;
    assert.ok(!declined.result.ok && declined.result.error.code === 'unsupported');
    assert.equal(store.rooms[ROOM]!.revision, 1, 'nothing was saved');
  });
});
