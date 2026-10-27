import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ago, nextAfter, snoozeChoices, step } from './time.js';

const NOW = new Date(2026, 9, 26, 15, 0).toISOString();
const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo, d, h, mi).toISOString();

describe('Inbox time and movement', () => {
  it('says how long ago, briefly, against the view’s now', () => {
    assert.equal(ago(NOW, NOW), 'now');
    assert.equal(ago(at(2026, 9, 26, 14, 19), NOW), '41m');
    assert.equal(ago(at(2026, 9, 26, 10), NOW), '5h');
    assert.equal(ago(at(2026, 9, 26, 1, 5), NOW), '1:05 am');
    assert.equal(ago(at(2026, 9, 25, 9), NOW), 'Yesterday');
    assert.equal(ago(at(2026, 9, 22, 9), NOW), 'Thu');
    assert.equal(ago(at(2026, 9, 2, 9), NOW), 'Oct 2');
    assert.equal(ago('nope', NOW), '');
  });
  it('says how long something has waited', () => {
  });
  it('offers snoozes that end in the future', () => {
    const c = snoozeChoices(NOW);
    assert.equal(c.length, 3);
    for (const x of c) assert.ok(Date.parse(x.until) > Date.parse(NOW), x.label);
    assert.equal(new Date(c[0].until).getHours(), 9);
  });
  it('moves through the list with j and k, and selects a neighbour when one leaves', () => {
    const ids = ['a', 'b', 'c'];
    assert.equal(step(ids, null, 1), 'a');
    assert.equal(step(ids, null, -1), 'c');
    assert.equal(step(ids, 'a', -1), 'a');
    assert.equal(step(ids, 'b', 1), 'c');
    assert.equal(step(ids, 'c', 1), 'c');
    assert.equal(step([], null, 1), null);
    assert.equal(nextAfter(ids, 'b'), 'c');
    assert.equal(nextAfter(ids, 'c'), 'b');
    assert.equal(nextAfter(['a'], 'a'), null);
    assert.equal(nextAfter(ids, 'z'), null);
  });
});
