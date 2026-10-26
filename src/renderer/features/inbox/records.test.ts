import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RoomResult } from '../../../shared/api.js';
import type { Decision, Thread, VoweRecord, Work } from '../vowe-room/contracts/model.js';
import type { RoomSummary } from '../room/types.js';
import { createInboxSource, type InboxDeps } from './records.js';

// The records loader and InboxSource over fake room services: what it reads, what it publishes, and
// that every act goes to the room's own service with the right arguments.

const NOW = '2026-11-02T12:00:00.000Z';
const at = (min: number) => new Date(Date.parse(NOW) - min * 60_000).toISOString();
const ok = <T>(value: T): RoomResult<T> => ({ ok: true, value });

function rec(over: Partial<VoweRecord> = {}): VoweRecord {
  return {
    threads: [], decisions: [], work: [], notices: [], call: false, done: [], vowe: true, agents: [], me: 'me',
    members: [{ who: 'me', role: 'member', name: 'Dee' }, { who: 'bob', role: 'owner', name: 'Bob' }], times: {}, log: [], ...over,
  };
}
const decision: Decision = {
  id: 'd1.v2', title: 'Retry payouts', state: 'review', version: 2, lines: [], verify: [], alternatives: [], parts: [],
  approvers: [{ who: 'me', signed: 1 }, { who: 'bob', signed: 2 }], by: { who: 'bob' }, ago: '',
};
const thread: Thread = { id: 't1', about: { kind: 'part', id: 'api', name: 'API' }, status: 'open', waiting: 'me', replies: [{ id: 't1', by: 'bob', body: 'Check?', ago: '' }] };
const work = (over: Partial<Work> = {}): Work => ({
  id: 'w1', title: 'Payout retries', why: '', repo: 'acme/pay', parts: [], owner: 'bob', doer: { kind: 'agent', name: 'Claude Code' }, state: 'running',
  plan: [], may: [], mayNot: [], askWhen: [], accept: [], runs: [], prs: [], context: [], version: 3, versions: [], exec: { where: 'local', prs: 'per-step' }, log: [], ago: '', ...over,
});
const summary = (id: string, name: string): RoomSummary => ({ id, name, repo: null, inCall: [], needs: null, activity: '', activityAt: null, role: 'member' } as RoomSummary);

function harness(records: Record<string, VoweRecord | Error>, over: Partial<InboxDeps> = {}) {
  const calls: unknown[][] = [];
  const listeners = new Map<string, () => void>();
  let rooms = Object.keys(records).map((id) => summary(id, id.toUpperCase()));
  let roomsFn: (() => void) | null = null;
  let loads = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const call = (name: string) => async (...args: unknown[]) => { calls.push([name, ...args]); return ok(null); };
  const deps: InboxDeps = {
    services: {
      record: {
        async load(id) {
          loads++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 1));
          inFlight--;
          const r = records[id];
          if (r instanceof Error) return { ok: false, error: { code: 'network', message: r.message } } as unknown as RoomResult<VoweRecord>;
          return ok(r!);
        },
        subscribe(id, fn) { listeners.set(id, fn); return () => listeners.delete(id); },
      },
      threads: { reply: call('reply') } as never,
      decisions: { sign: call('sign'), requestChanges: call('requestChanges') } as never,
      work: { answer: call('answer'), authorize: call('authorize'), allowScope: call('allowScope') } as never,
      attention: { markDone: call('markDone') } as never,
    },
    rooms: { list: () => rooms, subscribe: (fn) => { roomsFn = fn; return () => { roomsFn = null; }; } },
    invites: {
      mine: async () => [{ id: 'inv1', roomId: 'r9', roomName: 'Growth', role: 'member', inviterName: 'Cat', sentAt: at(5) }] as never,
      accept: async (key) => { calls.push(['accept', key]); return 'r9'; },
    },
    me: () => 'me',
    storage: null,
    now: () => new Date(NOW),
    undoMs: 20,
    ...over,
  };
  const src = createInboxSource(deps);
  return {
    src, calls, listeners,
    get loads() { return loads; },
    get maxInFlight() { return maxInFlight; },
    setRooms(ids: string[]) { rooms = ids.map((id) => summary(id, id.toUpperCase())); roomsFn?.(); },
    settle: async () => { await src.idle(); await new Promise((r) => setTimeout(r, 5)); },
  };
}

describe('Inbox source (records loader)', () => {
  it('reads every room, a few at a time, and publishes Needs you with its count', async () => {
    const recs: Record<string, VoweRecord> = {};
    for (let i = 0; i < 9; i++) recs[`r${i}`] = rec(i === 0 ? { decisions: [decision], threads: [thread] } : {});
    const h = harness(recs, { concurrency: 3 });
    await h.settle();
    const s = h.src.store.state;
    assert.equal(s.status, 'ready');
    assert.equal(h.maxInFlight, 3);
    assert.equal(h.loads, 9);
    assert.equal(s.me, 'me');
    assert.equal(s.needsCount, s.view.needs.length);
    assert.deepEqual(s.view.needs.map((i) => i.obligation).sort(), ['accept', 'reply', 'sign']);
    assert.deepEqual(s.unavailable, ['runner', 'github']);
    assert.equal(s.people.me!.tone, 'me');
    assert.equal(s.people.bob!.name, 'Bob');
    h.src.dispose();
  });

  it('re-reads a room on record:changed and follows your rooms', async () => {
    const h = harness({ r1: rec() });
    await h.settle();
    const before = h.loads;
    h.listeners.get('r1')!();
    await h.settle();
    assert.equal(h.loads, before + 1);
    h.setRooms([]);
    await h.settle();
    assert.equal(h.listeners.size, 0);
    assert.equal(h.src.store.state.view.needs.filter((i) => i.room.id === 'r1').length, 0);
    h.src.dispose();
  });

  it('says what failed without hiding the rooms that loaded', async () => {
    const h = harness({ r1: rec({ decisions: [decision] }), r2: new Error('offline') });
    await h.settle();
    const s = h.src.store.state;
    assert.equal(s.status, 'ready');
    assert.match(s.error!, /R2.*offline/);
    assert.ok(s.view.needs.some((i) => i.obligation === 'sign'));
    const all = harness({ r1: new Error('offline') }, { invites: null });
    await all.settle();
    assert.equal(all.src.store.state.status, 'failed');
    h.src.dispose(); all.src.dispose();
  });

  it('signs the item’s version, replies to the thread, and answers through the room services', async () => {
    const h = harness({ r1: rec({ decisions: [decision], threads: [thread] }) });
    await h.settle();
    const needs = h.src.store.state.view.needs;
    await h.src.sign(needs.find((i) => i.obligation === 'sign')!);
    await h.src.reply(needs.find((i) => i.obligation === 'reply')!, ' On it ');
    await h.src.answer(needs.find((i) => i.obligation === 'reply')!, 'Yes');
    assert.deepEqual(h.calls.slice(0, 3), [['sign', 'r1', 'd1.v2', 2], ['reply', 'r1', 't1', 'On it'], ['reply', 'r1', 't1', 'Yes']]);
    await assert.rejects(h.src.reply(needs[0]!, '  '));
    h.src.dispose();
  });

  it('answers questions, authorizes and allows scope on the plan', async () => {
    const r = rec({
      members: [{ who: 'me', role: 'owner' }],
      work: [work({ owner: 'me', question: { id: 'q1', text: 'Which key?', about: 'step', for: 'me', options: [] }, scopeAsk: { text: 'Needs the db', adds: 'touch db', by: 'Claude Code' } })],
    });
    const h = harness({ r1: r });
    await h.settle();
    const needs = h.src.store.state.view.needs;
    const q = needs.find((i) => i.obligation === 'answer');
    const allow = needs.find((i) => i.obligation === 'allow');
    assert.ok(q && allow, needs.map((i) => i.id).join());
    await h.src.answer(q, 'The idempotency key');
    await h.src.allowScope(allow, true);
    await h.src.authorize(allow);
    assert.deepEqual(h.calls, [['answer', 'r1', 'w1', 'q1', 'The idempotency key'], ['allowScope', 'r1', 'w1', true], ['authorize', 'r1', 'w1', 3]]);
    h.src.dispose();
  });

  it('accepts invitations on the server and declines them here', async () => {
    const h = harness({ r1: rec() });
    await h.settle();
    const inv = h.src.store.state.view.needs.find((i) => i.obligation === 'accept')!;
    assert.equal(await h.src.acceptInvitation(inv, true), 'r9');
    assert.deepEqual(h.calls.at(-1), ['accept', { invitationId: 'inv1' }]);
    const h2 = harness({ r1: rec() });
    await h2.settle();
    const inv2 = h2.src.store.state.view.needs.find((i) => i.obligation === 'accept')!;
    assert.equal(await h2.src.acceptInvitation(inv2, false), null);
    assert.equal(h2.src.store.state.view.needs.some((i) => i.obligation === 'accept'), false);
    h.src.dispose(); h2.src.dispose();
  });

  it('writes Done to the server after the undo window, and not at all if undone', async () => {
    const r = rec({ log: [{ id: 'e1', by: 'bob', kind: 'thread', text: 'New idea', subject: 't9', version: null, at: at(3) }] });
    const h = harness({ r1: r });
    await h.settle();
    const act = h.src.store.state.view.activity[0]!;
    assert.ok(act);
    const undo = h.src.done(act);
    assert.equal(h.src.store.state.view.activity.length, 0);
    undo();
    assert.equal(h.src.store.state.view.activity.length, 1);
    await new Promise((res) => setTimeout(res, 40));
    assert.equal(h.calls.filter((c) => c[0] === 'markDone').length, 0);
    h.src.done(h.src.store.state.view.activity[0]!);
    await new Promise((res) => setTimeout(res, 40));
    const marks = h.calls.filter((c) => c[0] === 'markDone');
    assert.equal(marks.length, 1);
    assert.equal(marks[0]![1], 'r1');
    assert.match((marks[0]![2] as string[])[0]!, /^inbox:act:r1:/);
    // Needs you can't be marked done: only discharging it clears it.
    const sign = harness({ r1: rec({ decisions: [decision] }) });
    await sign.settle();
    sign.src.done(sign.src.store.state.view.needs[0]!);
    assert.equal(sign.src.store.state.view.needs.length, 2);
    h.src.dispose(); sign.src.dispose();
  });

  it('counts what’s new on an item until you open it; Needs you never counts as unread', async () => {
    const r = rec({ decisions: [decision], log: [{ id: 'e1', by: 'bob', kind: 'thread', text: 'New idea', subject: 't9', version: null, at: at(3) }] });
    const h = harness({ r1: r }, { invites: null });
    await h.settle();
    const act = h.src.store.state.view.activity[0]!;
    assert.equal(act.unseen, 1);
    assert.equal(h.src.store.state.view.needs[0]!.unseen, 0);
    h.src.seen(act);
    assert.equal(h.src.store.state.view.activity[0]!.unseen, 0);
    assert.equal(h.src.store.state.needsCount, 1);
    h.src.dispose();
  });
});
