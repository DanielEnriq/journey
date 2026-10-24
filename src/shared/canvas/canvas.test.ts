// The semantic canvas engine: commands, the views drawn from a document, proposals, undo, and saving
// under contention. Plain Node against an in-memory store: `pnpm test`. The same engine runs against
// Supabase in src/integrations/supabase/canvas.test.ts.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  applyCommand, buildScene, buildScenes, CANVAS_TOOLS, CanvasError, command, COMMAND_NAMES, dangling, emptyDocument, execute,
  fromToolCall, memoryStore, ORDERS_SYSTEM, parseCommand, parseDocument, parsePresence, PAYMENT_SYSTEM,
  type Actor, type CanvasCommand, type CanvasDocument, type CommandArgs, type CommandName, type CommandResult,
} from './index.js';

const DAN: Actor = { kind: 'human', id: 'u-dan', name: 'Daniel' };
const JOHN: Actor = { kind: 'human', id: 'u-john', name: 'John' };
const VOWE: Actor = { kind: 'agent', id: 'vowe', name: 'Vowe' };
const AT = '2026-10-24T12:00:00.000Z';
let seq = 0;

/** Applies a command to a document, throwing its error as a CanvasError. */
function apply<K extends CommandName>(doc: CanvasDocument, who: Actor, name: K, args: CommandArgs[K]) {
  return applyCommand(doc, command(name, args, `cmd${String(++seq).padStart(4, '0')}`), who, AT);
}
const payment = () => apply(emptyDocument(), DAN, 'load_system', PAYMENT_SYSTEM).doc;
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as CanvasError).code; } return 'ok'; };
const ok = (r: CommandResult) => { assert.ok(r.ok, r.ok ? '' : `${r.error.code}: ${r.error.message}`); return r as Extract<CommandResult, { ok: true }>; };

describe('commands are validated before anything runs', () => {
  test('a well-formed tool call becomes a command', () => {
    const c = fromToolCall('highlight_component', { component: 'payment-worker' }, 'tool_abc123');
    assert.deepEqual(c, { schema: 'vowe.canvas.command/1', id: 'tool_abc123', name: 'highlight_component', args: { components: ['payment-worker'] } });
  });

  for (const [what, raw, path] of [
    ['an unknown command', { name: 'run_js', args: {} }, 'command.name'],
    ['an unknown field', { name: 'add_component', args: { component: { id: 'a', kind: 'service', name: 'A', html: '<b>' } } }, 'args.component'],
    ['an id that isn’t semantic', { name: 'add_component', args: { component: { id: 'Worker 2', kind: 'worker', name: 'W' } } }, 'args.component.id'],
    ['an unknown kind', { name: 'add_component', args: { component: { id: 'w', kind: 'lambda', name: 'W' } } }, 'args.component.kind'],
    ['a self-connection', { name: 'connect_components', args: { from: 'a', to: 'a', kind: 'calls' } }, 'args.to'],
    ['renaming an id', { name: 'update_component', args: { component: 'a', patch: { id: 'b' } } }, 'args.patch.id'],
    ['markup instead of a path', { name: 'draw', args: { view: 'architecture', kind: 'ink', d: '<script>alert(1)</script>' } }, 'args.d'],
    ['a curve the pens never draw', { name: 'draw', args: { view: 'architecture', kind: 'ink', d: 'M0 0 C1 1 2 2 3 3' } }, 'args.d'],
    ['too many copies', { name: 'show_view', args: { view: 'concurrency', instances: 9 } }, 'args.instances'],
    ['an empty proposal', { name: 'propose_change', args: { title: 'x', changes: [] } }, 'args.changes'],
    ['a bad change inside a proposal', { name: 'propose_change', args: { title: 'x', changes: [{ name: 'add_component', args: { component: { id: 'X', kind: 'worker', name: 'X' } } }] } }, 'args.changes[0].args.component.id'],
  ] as const) {
    test(`refuses ${what}`, () => {
      try { parseCommand({ schema: 'vowe.canvas.command/1', id: 'cmd-test', ...raw }); assert.fail('accepted'); }
      catch (e) { assert.equal((e as CanvasError).code, 'invalid'); assert.equal((e as CanvasError).path, path); }
    });
  }

  test('every tool Vowe is offered is a command, and none is a person’s to do', () => {
    for (const t of CANVAS_TOOLS) assert.ok((COMMAND_NAMES as readonly string[]).includes(t.name), t.name);
    const names = CANVAS_TOOLS.map((t) => t.name);
    for (const human of ['accept_proposal', 'reject_proposal', 'keep_view', 'keep_note', 'remove_component']) assert.ok(!names.includes(human as CommandName), human);
  });
});

describe('the payment system draws the design’s boards from meaning alone', () => {
  const doc = payment();

  test('Architecture: the same columns, store and boundary as the design', () => {
    const s = buildScene(doc, 'architecture');
    const rects = Object.fromEntries(s.nodes.map((n) => [n.key, n.rect]));
    assert.deepEqual(rects, {
      'webhook-api': [0, 207, 180, 112], 'retry-queue': [240, 190, 220, 146], 'payment-worker': [520, 190, 210, 146],
      'payment-provider': [790, 190, 190, 146], ledger: [520, 410, 210, 140],
    });
    assert.deepEqual(s.bounds.map((b) => [b.x, b.y, b.w, b.h, b.label]), [[222, 160, 526, 412, 'payments service']]);
    assert.deepEqual(s.viewBox, [980, 580]);
    assert.deepEqual(s.labels.map((l) => l.t), ['enqueue', 'lease', 'charge', 'record']);
    assert.equal(s.nodes.find((n) => n.key === 'retry-queue')!.state.cap, '#4182 leased to worker-1.');
    assert.equal(s.nodes.find((n) => n.key === 'payment-worker')!.state.cap, 'Charges, then acks the job.');
    assert.ok(!s.nodes.some((n) => n.component.startsWith('job-')), 'events are drawn inside their queue, not as parts');
  });

  test('Failure flow: the crash after the charge, before the ack, as five steps', () => {
    let d = apply(doc, DAN, 'show_view', { view: 'failure-flow', focus: 'payment-worker' }).doc;
    d = apply(d, DAN, 'add_failure', { component: 'payment-worker', mode: 'crash' }).doc;
    const s = buildScene(d, 'failure-flow');
    assert.equal(s.question, 'What if the worker crashes after charging?');
    assert.deepEqual(s.nodes.map((n) => [n.key, n.rect]), [['retry-queue', [0, 0, 220, 146]], ['payment-worker', [320, 0, 210, 146]], ['payment-provider', [640, 0, 230, 146]]]);
    assert.deepEqual(s.steps.map((x) => [x.title, x.sub, x.x, x.y, x.tone ?? '']), [
      ['Picks up the retry', 'job #4182, 30s lease', 315, 190, ''],
      ['Card charged', 'provider confirms $48.00', 645, 260, ''],
      ['Crashes before ack', 'the ack is never written', 315, 330, 'crash'],
      ['Lease runs out', '#4182 is visible again', 0, 400, ''],
      ['Card charged again', 'same payment, twice', 645, 470, 'bad'],
    ]);
    assert.equal(s.nodes[2].state.cap, 'The same payment, charged twice.');
    assert.equal(s.nodes[1].state.insts![0].cls, 'inst crashed');
  });

  test('Concurrency: two copies of one component, not two components', () => {
    const d = apply(doc, DAN, 'show_view', { view: 'concurrency', focus: 'payment-worker' }).doc;
    const s = buildScene(d, 'concurrency');
    assert.equal(s.question, 'What if two workers take the same job?');
    assert.deepEqual(s.nodes.map((n) => [n.key, n.component, n.instance, n.rect[0], n.rect[1]]), [
      ['retry-queue', 'retry-queue', 1, 380, 0], ['payment-worker', 'payment-worker', 1, 170, 230],
      ['payment-worker#2', 'payment-worker', 2, 600, 230], ['payment-provider', 'payment-provider', 1, 385, 470],
    ]);
    assert.deepEqual(s.bounds.map((b) => [b.x, b.y, b.w, b.h]), [[150, 205, 680, 195]]);
    assert.equal(Object.keys(d.components).filter((id) => id.startsWith('payment-worker')).length, 1);
    assert.equal(s.nodes[2].state.cap, 'Charges #4182 as well.');
  });

  test('Concurrency with three copies spreads them and says so', () => {
    const d = apply(doc, DAN, 'create_view', { type: 'concurrency', focus: 'payment-worker', instances: 3 }).doc;
    const s = buildScene(d, 'concurrency');
    assert.equal(s.nodes.filter((n) => n.component === 'payment-worker').length, 3);
    assert.equal(s.question, 'What if three workers take the same job?');
    assert.match(s.nodes.at(-1)!.state.cap, /three times/);
  });
});

describe('a different system draws with the same views', () => {
  test('Orders: architecture, failure and concurrency all come from its own names', () => {
    let d = apply(emptyDocument(), DAN, 'load_system', ORDERS_SYSTEM).doc;
    d = apply(d, DAN, 'add_failure', { component: 'email-sender', mode: 'timeout' }).doc;
    d = apply(d, DAN, 'show_view', { view: 'concurrency', focus: 'email-sender' }).doc;
    const scenes = buildScenes(d);
    assert.deepEqual(Object.keys(scenes).sort(), ['architecture', 'concurrency', 'failure-flow']);
    const f = scenes['failure-flow'];
    assert.equal(f.question, 'What if the sender times out after sending?');
    assert.deepEqual(f.steps.map((s) => s.title), ['Picks up the event', 'Receipt sent', 'Times out', 'Hands o-77 out again', 'Receipt sent again']);
    assert.equal(scenes.concurrency.nodes[1].state.insts![0].name, 'sender-1');
    const arch = scenes.architecture;
    const db = arch.nodes.find((n) => n.key === 'orders-db')!, api = arch.nodes.find((n) => n.key === 'orders-api')!;
    assert.equal(db.rect[1], api.rect[1] + api.rect[3] + 74, 'the store sits under whoever writes it');
  });

  test('a view the system can’t support is refused, not invented', () => {
    const d = payment();
    assert.equal(code(() => apply(d, DAN, 'show_view', { view: 'failure-flow', focus: 'ledger' })), 'unsupported');
    assert.equal(code(() => apply(d, DAN, 'create_view', { type: 'concurrency' })), 'invalid');
  });
});

describe('Vowe proposes; people decide', () => {
  test('Vowe’s structural change lands dashed and only a person accepts it', () => {
    const r = apply(payment(), VOWE, 'add_component', { component: { id: 'idempotency-keys', kind: 'database', name: 'Idempotency keys', parent: 'payments-service' } });
    assert.equal(r.result.applied, 'proposed');
    const pid = r.result.changed.proposals[0];
    assert.equal(r.doc.components['idempotency-keys'].status, 'proposed');
    assert.equal(code(() => apply(r.doc, VOWE, 'accept_proposal', { proposal: pid })), 'forbidden');
    const accepted = apply(r.doc, JOHN, 'accept_proposal', { proposal: pid }).doc;
    assert.equal(accepted.components['idempotency-keys'].status, 'agreed');
    assert.equal(accepted.proposals[pid].status, 'accepted');
  });

  test('rejecting a proposed change restores what was there', () => {
    const r = apply(payment(), VOWE, 'update_component', { component: 'payment-worker', patch: { tech: 'retry-worker · keyed' } });
    const pid = r.result.changed.proposals[0];
    const rejected = apply(r.doc, DAN, 'reject_proposal', { proposal: pid }).doc;
    assert.equal(rejected.components['payment-worker'].tech, 'retry-worker');
    assert.equal(rejected.components['payment-worker'].status, 'agreed');
  });

  test('Vowe’s views and notes wait for a person to keep them', () => {
    let r = apply(payment(), VOWE, 'show_view', { view: 'failure-flow', focus: 'payment-worker' });
    assert.equal(r.doc.views['failure-flow'].status, 'proposed');
    assert.equal(buildScene(r.doc, 'failure-flow').proposed, true);
    assert.equal(code(() => apply(r.doc, VOWE, 'keep_view', { view: 'failure-flow' })), 'forbidden');
    r = apply(r.doc, VOWE, 'annotate_component', { component: 'retry-queue', text: 'How do we notice an ack that never arrived?' });
    const note = r.doc.annotations[r.result.changed.annotations[0]];
    assert.ok(note.kind === 'note' && note.status === 'suggested' && note.note === 'question');
    assert.equal(code(() => apply(r.doc, VOWE, 'remove_component', { component: 'ledger' })), 'forbidden');
  });

  test('connections must make sense for what they connect', () => {
    const d = payment();
    assert.equal(code(() => apply(d, DAN, 'connect_components', { from: 'payment-worker', to: 'ledger', kind: 'publishes' })), 'invalid');
    assert.equal(code(() => apply(d, DAN, 'connect_components', { from: 'job-4182', to: 'payment-provider', kind: 'calls' })), 'invalid');
    assert.equal(code(() => apply(d, DAN, 'connect_components', { from: 'payment-worker', to: 'nowhere', kind: 'calls' })), 'not-found');
    assert.equal(code(() => apply(d, DAN, 'add_component', { component: { id: 'ledger', kind: 'database', name: 'Again' } })), 'conflict');
  });
});

describe('gestures resolve to meaning', () => {
  test('a circle keeps the semantic ids it was drawn around, including which copy', () => {
    let d = apply(payment(), DAN, 'show_view', { view: 'concurrency', focus: 'payment-worker' }).doc;
    const r = apply(d, DAN, 'draw', { view: 'concurrency', kind: 'circle', d: 'M590 220 L820 220 L820 390 Z', refs: [{ component: 'payment-worker', instance: 2 }] });
    d = r.doc;
    assert.equal(r.result.message, 'Circled Payment Worker.');
    assert.deepEqual(d.annotations[r.result.changed.annotations[0]], {
      id: r.result.changed.annotations[0], kind: 'circle', view: 'concurrency', d: 'M590 220 L820 220 L820 390 Z',
      refs: [{ component: 'payment-worker', instance: 2 }], by: DAN, at: AT,
    });
    assert.equal(code(() => apply(d, DAN, 'draw', { view: 'concurrency', kind: 'circle', d: 'M0 0 L1 1', refs: [{ component: 'ghost' }] })), 'not-found');
  });

  test('presence carries a view, a cursor in view coordinates and semantic selections', () => {
    assert.deepEqual(parsePresence({ view: 'concurrency', cursor: { x: 612.4, y: 300 }, selection: [{ component: 'payment-worker', instance: 2 }] }),
      { view: 'concurrency', cursor: { x: 612, y: 300 }, selection: [{ component: 'payment-worker', instance: 2 }], tool: 'select' });
    assert.throws(() => parsePresence({ view: 'concurrency', cursor: null, selection: [], camera: { zoom: 2 } }), /unknown field "camera"/);
  });
});

describe('undo is per person and never loses someone else’s work', () => {
  test('each person undoes their own latest change', () => {
    let d = payment();
    d = apply(d, DAN, 'annotate_component', { component: 'payment-worker', text: 'Crash after charge?' }).doc;
    d = apply(d, JOHN, 'annotate_component', { component: 'retry-queue', text: 'Retries stay reliable.' }).doc;
    const r = apply(d, DAN, 'undo', {});
    const texts = Object.values(r.doc.annotations).map((a) => a.kind === 'note' ? a.text : '');
    assert.deepEqual(texts, ['Retries stay reliable.']);
  });

  test('undo refuses when someone changed the same thing since', () => {
    let d = payment();
    d = apply(d, DAN, 'update_component', { component: 'payment-worker', patch: { note: 'A' } }).doc;
    d = apply(d, JOHN, 'update_component', { component: 'payment-worker', patch: { note: 'B' } }).doc;
    assert.equal(code(() => apply(d, DAN, 'undo', {})), 'conflict');
    assert.equal(apply(d, JOHN, 'undo', {}).doc.components['payment-worker'].note, 'A');
  });

  test('undo refuses to leave someone’s drawing on a view that’s gone', () => {
    let d = apply(payment(), VOWE, 'show_view', { view: 'concurrency', focus: 'payment-worker' }).doc;
    d = apply(d, DAN, 'draw', { view: 'concurrency', kind: 'circle', d: 'M0 0 L10 10', refs: [{ component: 'payment-provider' }] }).doc;
    assert.equal(code(() => apply(d, VOWE, 'undo', {})), 'conflict');
  });

  test('nobody undoes someone else’s change by naming it', () => {
    const r = apply(payment(), DAN, 'highlight_component', { components: ['ledger'] });
    assert.equal(code(() => apply(r.doc, JOHN, 'undo', { command: r.result.command })), 'forbidden');
  });

  test('switching views alone isn’t an undoable change', () => {
    let d = payment();
    d = apply(d, DAN, 'show_view', { view: 'failure-flow', focus: 'payment-worker' }).doc;
    const n = d.history.length;
    d = apply(d, DAN, 'show_view', { view: 'architecture' }).doc;
    assert.equal(d.history.length, n);
    assert.equal(d.activeView, 'architecture');
  });
});

describe('removing things cascades to what depended on them', () => {
  test('removing a worker removes its connections, views and notes', () => {
    let d = apply(payment(), DAN, 'show_view', { view: 'failure-flow', focus: 'payment-worker' }).doc;
    d = apply(d, DAN, 'annotate_component', { component: 'payment-worker', text: 'x' }).doc;
    d = apply(d, DAN, 'remove_component', { component: 'payment-worker' }).doc;
    assert.equal(dangling(d), null);
    assert.ok(!Object.values(d.relationships).some((r) => r.from === 'payment-worker'));
    assert.equal(d.views['failure-flow'], undefined);
    assert.equal(d.activeView, 'architecture');
    assert.deepEqual(parseDocument(JSON.parse(JSON.stringify(d))), d);
  });
});

describe('saving under contention', () => {
  const cmd = (name: CommandName, args: unknown, id: string) => ({ schema: 'vowe.canvas.command/1', id, name, args }) as CanvasCommand;

  test('a command that lost the race is applied again to what won', async () => {
    const store = memoryStore();
    await execute(store, 'r', cmd('load_system', PAYMENT_SYSTEM, 'cmd-load'), DAN);
    // John's note lands between Daniel's read and Daniel's save.
    const racing = { ...store, async load(room: string) {
      const c = await store.load(room);
      if (c.revision === 1) await execute(store, 'r', cmd('annotate_component', { component: 'retry-queue', text: 'Retries stay reliable.' }, 'cmd-john'), JOHN);
      return c;
    } };
    const { result, canvas } = await execute(racing, 'r', cmd('add_failure', { component: 'payment-worker', mode: 'crash' }, 'cmd-fail'), DAN);
    assert.equal(ok(result).revision, 3);
    assert.equal(canvas.revision, 3);
    assert.equal(Object.keys(store.rooms.r.doc.annotations).length, 1, 'John’s note survived');
    assert.equal(store.rooms.r.doc.views['failure-flow'].steps!.length, 5);
  });

  test('a canvas that never settles gives up with `busy` and saves nothing', async () => {
    const store = memoryStore();
    const never = { ...store, commit: async () => null };
    const { result } = await execute(never, 'r', cmd('add_component', { component: { id: 'a', kind: 'service', name: 'A' } }, 'cmd-busy'), DAN);
    assert.equal(result.ok ? 'ok' : result.error.code, 'busy');
    assert.equal(store.rooms.r, undefined);
  });

  test('a no-op isn’t saved', async () => {
    const store = memoryStore();
    await execute(store, 'r', cmd('load_system', PAYMENT_SYSTEM, 'cmd-load'), DAN);
    const { result } = await execute(store, 'r', cmd('show_view', { view: 'architecture' }, 'cmd-noop'), DAN);
    assert.equal(ok(result).applied, 'noop');
    assert.equal(store.rooms.r.revision, 1);
  });

  test('applying the same command to the same document gives the same document', () => {
    const c = command('add_failure', { component: 'payment-worker', mode: 'crash' }, 'cmd-same');
    const base = payment();
    assert.deepEqual(applyCommand(base, c, DAN, AT).doc, applyCommand(base, c, DAN, AT).doc);
  });

  test('an invalid command reports where it was wrong and saves nothing', async () => {
    const store = memoryStore();
    const { result } = await execute(store, 'r', { schema: 'vowe.canvas.command/1', id: 'cmd-bad', name: 'add_component', args: { component: { id: 'x', kind: 'nope', name: 'X' } } }, DAN);
    assert.deepEqual(result.ok ? null : result.error, { code: 'invalid', message: 'args.component.kind: must be one of service, worker, queue, database, external, event, boundary', path: 'args.component.kind' });
  });
});

describe('stored documents are checked before use', () => {
  test('a missing document is an empty canvas', () => assert.deepEqual(parseDocument(null), emptyDocument()));
  test('a document from another schema is refused', () => assert.equal(code(() => parseDocument({ ...emptyDocument(), schema: 'vowe.canvas/9' })), 'invalid'));
  test('a dangling relationship is refused', () => {
    const d = payment();
    delete (d.components as Record<string, unknown>)['payment-provider'];
    assert.equal(code(() => parseDocument(d)), 'invalid');
  });
});
