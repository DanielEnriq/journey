import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nameFromGoal, workMark } from './sources.js';

describe('room sources', () => {
  it('names an untitled room from its goal, cut at a word', () => {
    assert.equal(nameFromGoal('Retries never charge a card twice.'), 'Retries never charge a card twice');
    assert.equal(nameFromGoal('Why does checkout drop the coupon when the cart is refreshed on mobile?'), 'Why does checkout drop the coupon when the cart…');
    assert.equal(nameFromGoal('First line\nsecond'), 'First line');
  });
  it('marks agents waiting over running', () => {
    assert.equal(workMark(['active', 'attention']), 'waiting');
    assert.equal(workMark(['active']), 'running');
    assert.equal(workMark([]), null);
  });
});
