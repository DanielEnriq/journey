import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { anchorPatch } from './navigation.js';
import { pendingAnchor, requestAnchor, takeAnchor } from '../../../shared/nav.js';

// Where each kind of Inbox item lands in the room's Desk.

describe('anchors', () => {
  const st = { thread: 'old' };
  it('a decision to sign opens Decide on that version', () => {
    const p = anchorPatch({ roomId: 'r', tab: 'decide', inspect: { kind: 'decision', id: 'd1.v2' }, parts: ['api'], label: '' }, st);
    assert.deepEqual(p, { deskOpen: true, tab: 'decide', fsec: 'decide', inspect: { kind: 'decision', id: 'd1.v2' }, thread: 'old', compare: null, flash: 'decision:d1.v2', sel: [{ component: 'api' }] });
  });
  it('a thread to reply to opens Discuss on it', () => {
    const p = anchorPatch({ roomId: 'r', tab: 'discuss', thread: 't1', label: '' }, st);
    assert.equal(p.tab, 'discuss');
    assert.equal(p.thread, 't1');
    assert.equal(p.inspect, null);
    assert.equal(p.flash, 'thread:t1');
    assert.deepEqual(p.sel, []);
  });
  it('a question, scope ask or plan change opens Work on the plan’s section', () => {
    for (const section of ['run', 'plan'] as const) {
      const p = anchorPatch({ roomId: 'r', tab: 'work', inspect: { kind: 'work', id: 'w1', section }, label: '' }, st);
      assert.deepEqual(p.inspect, { kind: 'work', id: 'w1', section });
      assert.equal(p.fsec, 'work');
      assert.equal(p.flash, 'work:w1');
    }
  });
  it('a room-wide item (an invitation, a digest) just opens the room on Discuss', () => {
    const p = anchorPatch({ roomId: 'r', tab: 'discuss', label: '' }, st);
    assert.equal(p.thread, null);
    assert.equal(p.flash, null);
  });
  it('is taken once, and only by its room', () => {
    requestAnchor({ roomId: 'a', tab: 'decide', label: '' });
    const n = pendingAnchor.state.nonce;
    assert.equal(takeAnchor('b'), null);
    assert.equal(takeAnchor('a')?.roomId, 'a');
    assert.equal(takeAnchor('a'), null);
    requestAnchor({ roomId: 'a', tab: 'decide', label: '' });
    assert.equal(pendingAnchor.state.nonce, n + 1);
  });
});
