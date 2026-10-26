import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { applyCommand, buildScene, command, emptyDocument, ORDERS_SYSTEM, PAYMENT_SYSTEM, viewOf, type Actor, type CanvasDocument, type CommandArgs, type CommandName } from '../../../shared/canvas/index.js';
import { captionDue, copiesOn, copiesPlan, forkable, revealGates, scrubbed, shownSteps, timing } from './story.js';

// The instruments' logic: the Failure flow scrubber, two copies' timing, and the Concurrency instrument.

const DAN: Actor = { kind: 'human', id: 'u-dan', name: 'Daniel' };
let n = 0;
const apply = <K extends CommandName>(d: CanvasDocument, name: K, args: CommandArgs[K]) => applyCommand(d, command(name, args, `cmd-story-${++n}`), DAN).doc;
const payment = apply(emptyDocument(), 'load_system', PAYMENT_SYSTEM);
const failure = apply(apply(payment, 'show_view', { view: 'failure-flow', focus: 'payment-worker' }), 'add_failure', { component: 'payment-worker', mode: 'crash' });

describe('the Failure flow scrubber', () => {
  const scene = buildScene(failure, 'failure-flow');
  const g = revealGates(scene);
  test('each thing on the parts waits for the step that does it', () => {
    assert.equal(g.total, 5);
    assert.equal(g.crashAt, 3);
    assert.equal(g.againAt, 4);
    assert.deepEqual(g.effectAt, [2, 5]);
    assert.deepEqual(g.lastOn, { 'payment-worker': 3, 'retry-queue': 4, 'payment-provider': 5 });
  });
  test('a happy path never crashes or hands the job out again', () => {
    const happy = revealGates(buildScene(apply(payment, 'show_view', { view: 'failure-flow', focus: 'payment-worker' }), 'failure-flow'));
    assert.equal(happy.crashAt, Infinity);
    assert.equal(happy.againAt, Infinity);
    assert.deepEqual(happy.effectAt, [2]);
  });
  test('scrubbing stays on the flow', () => {
    assert.equal(shownSteps(99, 5), 5);
    assert.equal(shownSteps(0, 5), 1);
    assert.equal(shownSteps(3, 0), 0);
    assert.equal(scrubbed(99, 5, 1), 5);
    assert.equal(scrubbed(99, 5, -1), 4);
    assert.equal(scrubbed(1, 5, -1), 1);
    assert.equal(scrubbed(2, 0, 1), 0);
  });
  test('a part’s caption waits for its last step; other views always show it', () => {
    assert.equal(captionDue('failure-flow', g, 'retry-queue', 3), false);
    assert.equal(captionDue('failure-flow', g, 'retry-queue', 4), true);
    assert.equal(captionDue('failure-flow', g, 'nobody', 1), true);
    assert.equal(captionDue('architecture', g, 'retry-queue', 1), true);
  });
});

describe('two copies on one job', () => {
  test('a second lease happens only when the first ack lands after the lease ran out', () => {
    assert.deepEqual(timing(4, 30), { second: false, ackAt: 5.3, secondAt: 30, charge2: false });
    assert.equal(timing(29, 30).second, true);
    assert.equal(timing(28.7, 30).second, false);
  });
});

describe('the Concurrency instrument', () => {
  test('only a part that takes work from a queue and calls something can fork', () => {
    assert.equal(forkable(payment, 'payment-worker'), true);
    assert.equal(forkable(payment, 'payment-provider'), false);
    assert.equal(forkable(payment, 'ghost'), false);
    const orders = apply(emptyDocument(), 'load_system', ORDERS_SYSTEM);
    assert.equal(forkable(orders, 'email-sender'), true);
  });

  test('from Architecture: draws the view the first time, then shows and changes the one the room has', () => {
    const arch = viewOf(payment, 'architecture');
    assert.equal(copiesPlan(payment, arch, 'payment-worker', 1), null);
    assert.deepEqual(copiesPlan(payment, arch, 'payment-worker', 2), { kind: 'draw', focus: 'payment-worker', instances: 2 });
    const withConc = apply(payment, 'show_view', { view: 'concurrency', focus: 'payment-worker' });
    assert.deepEqual(copiesPlan(withConc, arch, 'payment-worker', 2), { kind: 'show', view: 'concurrency' });
    assert.deepEqual(copiesPlan(withConc, arch, 'payment-worker', 3), { kind: 'set', view: 'concurrency', instances: 3, show: true });
  });

  test('on the Concurrency view: changes its copies in place, and one copy goes back to Architecture', () => {
    const d = apply(payment, 'show_view', { view: 'concurrency', focus: 'payment-worker' });
    const conc = viewOf(d, 'concurrency');
    assert.equal(copiesOn(conc, 'payment-worker'), 2);
    assert.equal(copiesOn(viewOf(d, 'architecture'), 'payment-worker'), 1);
    assert.deepEqual(copiesPlan(d, conc, 'payment-worker', 4), { kind: 'set', view: 'concurrency', instances: 4, show: false });
    assert.equal(copiesPlan(d, conc, 'payment-worker', 2), null);
    assert.deepEqual(copiesPlan(d, conc, 'payment-worker', 1), { kind: 'show', view: 'architecture' });
    assert.deepEqual(copiesPlan(d, conc, 'payment-worker', 9), { kind: 'set', view: 'concurrency', instances: 4, show: false });
  });

  test('the plan, run as commands, changes the shared document', () => {
    let d = apply(payment, 'show_view', { view: 'concurrency', focus: 'payment-worker' });
    const plan = copiesPlan(d, viewOf(d, 'concurrency'), 'payment-worker', 3);
    assert.ok(plan && plan.kind === 'set');
    d = apply(d, 'set_instances', { view: plan.view, instances: plan.instances });
    assert.equal(buildScene(d, 'concurrency').nodes.filter((x) => x.component === 'payment-worker').length, 3);
  });
});
