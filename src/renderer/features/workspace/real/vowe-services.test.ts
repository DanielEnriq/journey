import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RoomEvent, RoomResult } from '../../../../shared/api.js';
import { capabilitiesOf } from '../../vowe-room/contracts/services.js';
import { createVoweServices, toNewThread, voidResult } from './vowe-services.js';

const D = '0f8fad5b-d9cb-469f-a165-70867728950e';
const ok = <T>(value: T): Promise<RoomResult<T>> => Promise.resolve({ ok: true, value });

function fake() {
  const calls: unknown[][] = [];
  let listener: ((e: RoomEvent) => void) | null = null;
  const rec = (name: string, value: unknown = undefined) => (...args: unknown[]) => { calls.push([name, ...args]); return ok(value); };
  const journey = {
    vowe: {
      load: rec('load', { agentName: 'Nova' }), thread: rec('thread', { id: 't1' }), answerOffer: rec('answerOffer'), setAgentName: rec('setAgentName', 'Nova'),
      markDone: rec('markDone'),
      decisions: { amend: rec('amend', { id: `${D}.v2` }), requestSignatures: rec('requestSignatures'), editLine: (..._a: unknown[]) => Promise.resolve({ ok: false, error: { code: 'conflict', message: 'signed' } }) },
      work: { plan: rec('plan', { version: 2 }), authorize: rec('authorize') },
    },
    record: { sign: rec('sign', { id: D }), reply: rec('reply', { id: 'c1' }), resolve: rec('resolve') },
    rooms: { send: rec('send'), onEvent: (fn: (e: RoomEvent) => void) => { listener = fn; return () => { listener = null; }; } },
  };
  return { calls, journey, emit: (e: Partial<RoomEvent>) => listener?.(e as RoomEvent) };
}

describe('vowe services over IPC', () => {
  it('offers no runs, GitHub sync or notifications', () => {
    const s = createVoweServices(() => fake().journey as never);
    assert.deepEqual(capabilitiesOf(s), { agentRuns: false, githubSync: false, notifications: false });
    assert.ok(s.settings);
  });

  it('signs through the room record, on the database decision and the version read', async () => {
    const f = fake();
    const s = createVoweServices(() => f.journey as never);
    assert.deepEqual(await s.decisions.sign('room', `${D}.v2`, 2), { ok: true, value: undefined });
    // Journey's sign doesn't notify from the database, so the room is told.
    assert.deepEqual(f.calls.slice(-2), [['sign', 'room', D, 2], ['send', 'room', 'record:changed', { what: 'signature' }]]);
    const bad = await s.decisions.sign('room', 'nope', 1);
    assert.equal(!bad.ok && bad.error.code, 'invalid');
  });

  it('re-reads after its own successful writes, and on the room’s record:changed', async () => {
    const f = fake();
    const s = createVoweServices(() => f.journey as never);
    let reads = 0;
    const off = s.record.subscribe('room', () => reads++);
    await s.work.plan('room', 'w', { op: 'objective', text: 'x' }, 1);
    assert.equal(reads, 1);
    await s.decisions.editLine('room', D, 'l', 'x'); // failed: nothing to re-read for
    assert.equal(reads, 1);
    await s.threads.create('other-room', { about: { kind: 'part', id: 'p', name: 'P' }, body: 'x' });
    assert.equal(reads, 1);
    f.emit({ type: 'record:changed', roomId: 'room', payload: { what: 'plan' } });
    f.emit({ type: 'record:changed', roomId: 'elsewhere', payload: { what: 'plan' } });
    assert.equal(reads, 2);
    off();
    await s.work.authorize('room', 'w', 1);
    assert.equal(reads, 2);
  });

  it('passes amend’s new id and drops a waiting that isn’t a person', async () => {
    const f = fake();
    const s = createVoweServices(() => f.journey as never);
    assert.deepEqual(await s.decisions.amend('room', D), { ok: true, value: { id: `${D}.v2` } });
    assert.deepEqual(toNewThread({ about: { kind: 'part', id: 'p', name: 'P' }, body: 'x', waiting: 'vowe' }), { about: { kind: 'part', id: 'p', name: 'P' }, body: 'x' });
    assert.equal(toNewThread({ about: { kind: 'part', id: 'p', name: 'P' }, body: 'x', waiting: D }).waiting, D);
    assert.deepEqual(voidResult({ ok: true, value: 3 }), { ok: true, value: undefined });
    assert.deepEqual(await s.settings!.agentName('room', 'Nova'), { ok: true, value: undefined });
  });
});
