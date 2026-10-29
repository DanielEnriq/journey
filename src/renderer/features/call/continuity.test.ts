import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { callLayout, callLink, joinPlan } from './continuity.js';

describe('call continuity', () => {
  it('keeps the call’s room mounted while you go Home or to another room', () => {
    const call = { roomId: 'a', status: 'connected' as const };
    assert.deepEqual(callLayout(call, 'a'), { keep: 'a', visible: true });
    assert.deepEqual(callLayout(call, null), { keep: 'a', visible: false }); // Home
    assert.deepEqual(callLayout(call, 'b'), { keep: 'a', visible: false }); // another room
    assert.deepEqual(callLayout({ roomId: 'a', status: 'dropped' }, null), { keep: 'a', visible: false }); // dropped: still yours to rejoin
    assert.deepEqual(callLayout({ roomId: 'a', status: 'leaving' }, null), { keep: 'a', visible: false });
  });

  it('keeps nothing when there is no call, or it is still being joined from its preview', () => {
    assert.deepEqual(callLayout({ roomId: null, status: 'idle' }, 'a'), { keep: null, visible: false });
    assert.deepEqual(callLayout({ roomId: 'a', status: 'connecting' }, 'a'), { keep: null, visible: false });
    assert.deepEqual(callLayout({ roomId: 'a', status: 'failed' }, 'a'), { keep: null, visible: false });
  });

  it('asks before joining another room’s call', () => {
    assert.equal(joinPlan({ roomId: null, status: 'idle' }, 'b'), 'join');
    assert.equal(joinPlan({ roomId: 'a', status: 'connected' }, 'a'), 'join');
    assert.equal(joinPlan({ roomId: 'a', status: 'connected' }, 'b'), 'switch');
    assert.equal(joinPlan({ roomId: 'a', status: 'dropped' }, 'b'), 'switch');
    assert.equal(joinPlan({ roomId: 'a', status: 'connecting' }, 'b'), 'busy');
    assert.equal(joinPlan({ roomId: 'a', status: 'failed' }, 'b'), 'join');
  });

  it('reads the link from the session and the voice connection', () => {
    assert.equal(callLink('idle', null), null);
    assert.equal(callLink('connecting', null), 'connecting');
    assert.equal(callLink('connected', null), 'connected'); // no voice link (yet)
    assert.equal(callLink('connected', 'reconnecting'), 'reconnecting');
    assert.equal(callLink('connected', 'dropped'), 'dropped');
    assert.equal(callLink('connected', 'connecting'), 'connecting');
    assert.equal(callLink('dropped', 'connected'), 'dropped');
    assert.equal(callLink('leaving', 'connected'), 'leaving');
  });
});
