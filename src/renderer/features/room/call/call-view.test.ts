import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CallPresence } from '../../call/presence.js';
import { callView, listNames, yourState } from './call-view.js';

const call = (o: Partial<CallPresence> = {}): CallPresence => ({
  roomId: 'r1', roomName: 'Billing', link: 'connected', muted: false, vowe: true, agentName: 'Vowe',
  people: [{ name: 'You', initials: 'DE', tone: 'me' }, { name: 'Maya', initials: 'MK', tone: 'peer' }, { name: 'Ade', initials: 'AO', tone: 'p2' }],
  speaking: null, act: { mic() {}, async leave() {} }, ...o,
});
const away = { looking: null, canvasShown: false };

describe('callView', () => {
  it('separates you from the others and keeps keys unique', () => {
    const v = callView(call({ people: [{ name: 'You', initials: 'DE', tone: 'me' }, { name: 'A', initials: 'AA', tone: 'peer' }, { name: 'B', initials: 'AA', tone: 'p2' }] }), away);
    assert.equal(v.me.key, 'me');
    assert.equal(v.others.length, 2);
    assert.notEqual(v.others[0].key, v.others[1].key);
  });
  it('Vowe hears you only when it is in, you are unmuted and the link is live', () => {
    assert.equal(callView(call(), away).hearing, true);
    assert.equal(callView(call({ muted: true }), away).hearing, false);
    assert.equal(callView(call({ micOff: 'Viewers listen' }), away).hearing, false);
    assert.equal(callView(call({ link: 'reconnecting' }), away).hearing, false);
    assert.equal(callView(call({ vowe: false }), away).hearing, false);
  });
  it('micOff counts as muted', () => {
    assert.equal(callView(call({ micOff: 'No voice here' }), away).muted, true);
  });
  it('shows the bar state only in the call room with its canvas on screen', () => {
    assert.equal(callView(call(), { looking: 'r1', canvasShown: true }).barShown, true);
    assert.equal(callView(call(), { looking: 'r1', canvasShown: false }).barShown, false);
    assert.equal(callView(call(), { looking: 'r2', canvasShown: true }).barShown, false);
    assert.equal(callView(call(), { looking: 'r1', canvasShown: false }).here, true);
  });
  it('maps the speaker to a key', () => {
    assert.equal(callView(call({ speaking: 'MK' }), away).speaking, 'MK:1');
    assert.equal(callView(call({ speaking: 'me' }), away).speaking, 'me');
    assert.equal(callView(call({ speaking: 'ZZ' }), away).speaking, null);
  });
  it('reports trouble and rejoin truthfully', () => {
    assert.equal(callView(call({ link: 'reconnecting' }), away).trouble, 'reconnecting');
    assert.equal(callView(call({ link: 'dropped' }), away).canRejoin, false);
    assert.equal(callView(call({ link: 'dropped', act: { mic() {}, async leave() {}, rejoin() {} } }), away).canRejoin, true);
    assert.equal(callView(call({ link: 'leaving' }), away).leaving, true);
    assert.equal(callView(call({ link: 'leaving' }), away).trouble, null);
  });
  it('labels the pill for a screen reader', () => {
    assert.equal(callView(call(), away).label, 'In the Billing call with Maya and Ade and Vowe');
    assert.equal(callView(call({ link: 'dropped' }), away).label, 'The Billing call dropped');
  });
  it('lists names and says what you are', () => {
    assert.equal(listNames(['A', 'B', 'C']), 'A, B and C');
    assert.equal(listNames(['A']), 'A');
    assert.equal(yourState(callView(call({ muted: true }), away)), 'muted');
    assert.equal(yourState(callView(call({ micOff: 'x' }), away)), 'listening');
    assert.equal(yourState(callView(call({ link: 'dropped' }), away)), 'disconnected');
  });
});
