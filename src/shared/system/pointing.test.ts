import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAYMENTS_FIXTURE } from './fixtures/index.js';
import { presetViews } from './view.js';
import { correct, pointingContext, toSnapshotSelection } from './pointing.js';

// The labelled payments fixture stands in for a repository here; nothing below claims anything about Journey.
const reg = PAYMENTS_FIXTURE;
const view = presetViews(reg)[0];

test('pointing at an internal part keeps its place in the system and its evidence', () => {
  const ctx = pointingContext(reg, { targets: [{ kind: 'entity', id: 'method:charge-worker/run' }], gesture: 'click', entered: ['component:charge-worker'], view });
  const [r] = ctx.referents;
  assert.equal(r.kind, 'method');
  assert.equal(r.component, 'component:charge-worker');
  assert.deepEqual(r.path.map((p) => p.id).slice(-2), ['component:charge-worker', 'method:charge-worker/run']);
  assert.ok(r.evidenceCount >= 1 && r.evidence.length >= 1);
  assert.deepEqual(ctx.entered, ['component:charge-worker']);
  assert.equal(ctx.fixture, true);
});

test('circling a worker and a queue maps to the room runtime’s circled selection', () => {
  const ctx = pointingContext(reg, {
    targets: [{ kind: 'entity', id: 'component:charge-worker' }, { kind: 'entity', id: 'component:job-queue' }], gesture: 'circle', entered: [], view,
  });
  assert.deepEqual(toSnapshotSelection(ctx, reg), { selected: [], circled: ['component:charge-worker', 'component:job-queue'] });
});

test('a relation names its ends; unknown ids are dropped, not guessed', () => {
  const id = 'component:charge-worker--consumes--component:job-queue';
  const ctx = pointingContext(reg, { targets: [{ kind: 'relation', id }, { kind: 'entity', id: 'component:nope' }], gesture: 'click', entered: ['component:gone'], view });
  assert.equal(ctx.referents.length, 1);
  assert.deepEqual(ctx.referents[0].ends, { from: reg.entities['component:charge-worker'].name, to: reg.entities['component:job-queue'].name });
  assert.deepEqual(ctx.entered, []);
});

test('"no, the other one" swaps in the nearest alternative', () => {
  const ctx = pointingContext(reg, {
    targets: [{ kind: 'entity', id: 'table:payments' }], gesture: 'hover', entered: [], view,
    nearby: [{ kind: 'entity', id: 'table:payments' }, { kind: 'entity', id: 'table:outbox' }, { kind: 'entity', id: 'table:ledger-entries' }],
  });
  assert.deepEqual(ctx.alternatives.map((a) => a.target), [{ kind: 'entity', id: 'table:outbox' }, { kind: 'entity', id: 'table:ledger-entries' }]);
  const fixed = correct(ctx);
  assert.deepEqual(fixed.referents[0].target, { kind: 'entity', id: 'table:outbox' });
  assert.deepEqual(fixed.alternatives.map((a) => a.target), [{ kind: 'entity', id: 'table:payments' }, { kind: 'entity', id: 'table:ledger-entries' }]);
});
