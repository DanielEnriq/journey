import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Decision, RecordEvent, Thread, VoweRecord, Work } from '../vowe-room/contracts/model.js';
import { agentPerson, derive, doneKey, SERVER_DONE_PREFIX, type DeriveInput, type RoomInput } from './derive.js';
import type { InboxMarks } from './model.js';

// The Inbox's rules on Journey's real record shapes: each tier by structure only, the digest, ordering,
// marks, what discharging an obligation does, and who may be asked for what.

const NOW = '2026-11-02T12:00:00.000Z';
const at = (min: number) => new Date(Date.parse(NOW) - min * 60_000).toISOString();
const NO_MARKS: InboxMarks = { seen: {}, done: {}, snoozed: {}, follow: {}, mutedRooms: [] };
const NAMES: Record<string, string> = { me: 'Dee', bob: 'Bob', cat: 'Cat', vowe: 'Vowe' };

function rec(over: Partial<VoweRecord> = {}): VoweRecord {
  return {
    threads: [], decisions: [], work: [], notices: [], call: false, done: [], vowe: true, agents: [],
    members: [{ who: 'me', role: 'member' }, { who: 'bob', role: 'owner' }, { who: 'cat', role: 'member' }],
    times: {}, log: [], ...over,
  };
}
function decision(over: Partial<Decision> = {}): Decision {
  return {
    id: 'd1.v2', title: 'Retry payouts', state: 'review', version: 2, lines: [], verify: [], alternatives: [], parts: ['api'],
    approvers: [{ who: 'me', signed: 1 }, { who: 'bob', signed: 2 }], by: { who: 'bob' }, ago: '', ...over,
  };
}
function thread(over: Partial<Thread> = {}): Thread {
  return {
    id: 't1', about: { kind: 'part', id: 'api', name: 'the API' }, status: 'open',
    replies: [{ id: 't1', by: 'bob', body: 'Can you check the retry window?', ago: '' }], ...over,
  };
}
function work(over: Partial<Work> = {}): Work {
  return {
    id: 'w1', title: 'Payout retries', why: '', repo: 'acme/pay', parts: [], owner: 'me', doer: { kind: 'agent', name: 'Claude Code' }, state: 'draft',
    plan: [{ id: 's1', text: 'Add a key', by: { who: 'me' }, state: 'todo' }, { id: 's2', text: 'Cut over', by: { who: 'me' }, state: 'todo' }],
    may: [], mayNot: [], askWhen: [], accept: [], runs: [], prs: [], context: [], version: 1, versions: [], exec: { where: 'local', prs: 'per-step' }, log: [], ago: '', ...over,
  };
}
const ev = (id: string, kind: string, subject: string | null, by: string | null, min: number, text = 'x', version: number | null = null): RecordEvent => ({ id, by, kind, text, subject, version, at: at(min) });

function input(rooms: RoomInput[], over: Partial<DeriveInput> = {}): DeriveInput {
  return { me: 'me', now: NOW, lastHere: at(60), rooms, invitations: [], marks: NO_MARKS, nameOf: (id) => NAMES[id] ?? 'Someone', ...over };
}
const room = (record: VoweRecord, over: Partial<RoomInput> = {}): RoomInput => ({ id: 'r1', name: 'Payments', record, ...over });

describe('Needs you', () => {
  it('asks an approver to sign the version they haven’t signed, and nobody else', () => {
    const r = rec({ decisions: [decision()], times: { 'd1.v2': at(50), 'd1.v2:review': at(40), 'd1.v2:signed:bob': at(30) } });
    const v = derive(input([room(r)]));
    assert.equal(v.needs.length, 1);
    const it = v.needs[0];
    assert.equal(it.id, 'sign:r1:d1.v2:v2');
    assert.equal(it.obligation, 'sign');
    assert.equal(it.why, 'Bob asked you to sign v2 · Bob signed');
    assert.equal(it.waitingSince, at(40));
    assert.equal(it.at, at(30));
    assert.deepEqual(it.anchor, { roomId: 'r1', tab: 'decide', inspect: { kind: 'decision', id: 'd1.v2' }, parts: ['api'], label: 'Decide · Retry payouts, v2' });
    // Bob already signed: nothing for him.
    assert.equal(derive(input([room(r)], { me: 'bob' })).needs.length, 0);
    // Someone not asked: nothing.
    assert.equal(derive(input([room(r)], { me: 'cat' })).needs.length, 0);
    // Asked for changes instead: nothing waits on you.
    const changed = rec({ decisions: [decision({ approvers: [{ who: 'me', signed: 1, changes: 'Say why' }, { who: 'bob', signed: 2 }] })] });
    assert.equal(derive(input([room(changed)])).needs.length, 0);
  });

  it('never asks a viewer to sign or authorize (permissions.ts: sign_decision)', () => {
    const r = rec({
      members: [{ who: 'me', role: 'viewer' }, { who: 'bob', role: 'owner' }],
      decisions: [decision()],
      work: [work({ state: 'proposed', versions: [{ version: 1, by: ['me'], ago: '', body: { objective: '', plan: [], may: [], mayNot: [], askWhen: [], accept: [] } }] })],
    });
    assert.equal(derive(input([room(r)])).needs.length, 0);
    assert.equal(derive(input([room(r, { role: 'member' })])).needs.length, 2);
  });

  it('asks you to reply when a thread waits on you and the last word isn’t yours', () => {
    const r = rec({ threads: [thread({ waiting: 'me' })], times: { 't1:t1': at(20) } });
    const [it] = derive(input([room(r)])).needs;
    assert.equal(it.id, 'answer:r1:t1:1');
    assert.equal(it.obligation, 'reply');
    assert.equal(it.why, 'Bob is waiting on your reply');
    assert.deepEqual(it.anchor, { roomId: 'r1', tab: 'discuss', thread: 't1', parts: ['api'], label: 'Discuss · the API' });
    // Not waiting on you, or you spoke last: no obligation.
    assert.equal(derive(input([room(rec({ threads: [thread({ waiting: 'cat' })] }))])).needs.length, 0);
    const replied = rec({ threads: [thread({ waiting: 'me', replies: [...thread().replies, { id: 'c2', by: 'me', body: 'Done', ago: '' }] })], times: { 't1:c2': at(5) } });
    const v = derive(input([room(replied)]));
    assert.equal(v.needs.length, 0);
    assert.deepEqual(v.resolved.map((x) => [x.item.id, x.how]), [['answer:r1:t1:1', 'You replied']]);
  });

  it('asks you to answer an agent’s question for you, and records the answer under Done', () => {
    const q = { id: 'q1', text: 'Leave refunds out?', about: 'provider', step: 's2', for: 'me', options: [] };
    const r = rec({ work: [work({ state: 'waiting', question: q })], times: { 'w1:question': at(30) } });
    const [it] = derive(input([room(r)])).needs;
    assert.equal(it.id, 'q:r1:w1:q1');
    assert.equal(it.obligation, 'answer');
    assert.equal(it.actor, agentPerson('Claude Code'));
    assert.equal(it.blocks, 'Step 2 is paused until you answer');
    assert.deepEqual(it.anchor, { roomId: 'r1', tab: 'work', inspect: { kind: 'work', id: 'w1', section: 'run' }, parts: ['provider'], label: 'Work · Payout retries · the question' });
    assert.equal(derive(input([room(r)], { me: 'bob' })).needs.length, 0);
    const answered = rec({ work: [work({ question: { ...q, answer: { by: 'me', text: 'Yes' } } })], times: { 'w1:question': at(30) } });
    const v = derive(input([room(answered)]));
    assert.equal(v.needs.length, 0);
    assert.deepEqual(v.resolved.map((x) => x.how), ['You answered']);
  });

  it('asks the plan’s owner to review someone else’s suggested changes', () => {
    const revision = { id: 'rv1', by: 'bob', why: 'tighter', base: 1, changes: [{ id: 'c1', kind: 'edit' as const, step: 's1', text: 'Add a key per payout', state: 'open' as const }] };
    const r = rec({ work: [work({ revision })], times: { 'w1:revision': at(15) } });
    const [it] = derive(input([room(r)])).needs;
    assert.equal(it.id, 'rv:r1:w1:rv1');
    assert.equal(it.obligation, 'review');
    assert.equal(it.anchor.inspect?.kind, 'work');
    // Your own suggestions don't need you.
    assert.equal(derive(input([room(rec({ work: [work({ revision: { ...revision, by: 'me' } })] }))])).needs.length, 0);
  });

  it('asks the owner to authorize a proposed plan only once its decision is agreed', () => {
    const versions = [{ version: 1, by: ['me'], ago: '', body: { objective: '', plan: [], may: [], mayNot: [], askWhen: [], accept: [] } }];
    const open = rec({ decisions: [decision({ id: 'd1', version: 1, state: 'review', approvers: [{ who: 'bob', signed: null }] })], work: [work({ state: 'proposed', decision: 'd1', versions })] });
    assert.equal(derive(input([room(open)])).needs.length, 0);
    const agreed = rec({ decisions: [decision({ id: 'd1', version: 1, state: 'agreed', approvers: [{ who: 'bob', signed: 1 }] })], work: [work({ state: 'proposed', decision: 'd1', versions })] });
    const [it] = derive(input([room(agreed)])).needs;
    assert.equal(it.id, 'au:r1:w1:v1');
    assert.equal(it.obligation, 'authorize');
    assert.deepEqual(it.anchor.inspect, { kind: 'work', id: 'w1', section: 'plan' });
  });

  it('asks whoever governs the work to allow or refuse a scope request', () => {
    const r = rec({ work: [work({ state: 'running', owner: 'bob', authorized: { by: 'me', ago: '', scope: '' }, scopeAsk: { text: 'Needs the ledger table', adds: 'ledger', by: 'Claude Code' } })] });
    const [it] = derive(input([room(r)])).needs;
    assert.equal(it.obligation, 'allow');
    assert.ok(it.blocks);
    assert.equal(derive(input([room(r)], { me: 'cat' })).needs.length, 0);
  });

  it('lists invitations', () => {
    const v = derive(input([], { invitations: [{ id: 'i1', roomId: 'r9', roomName: 'Ledger', role: 'member', fromName: 'Bob', at: at(5) }] }));
    assert.equal(v.needs[0].id, 'inv:i1');
    assert.equal(v.needs[0].obligation, 'accept');
    assert.equal(v.needs[0].source, 'access');
    assert.equal(v.needs[0].headline, 'Bob invited you to Ledger');
  });

  it('orders by what’s blocked, then by how long it waited, deterministically', () => {
    const r = rec({
      threads: [thread({ id: 'ta', waiting: 'me' }), thread({ id: 'tb', waiting: 'me', replies: [{ id: 'tb', by: 'cat', body: 'Ok?', ago: '' }] })],
      decisions: [decision()],
      work: [work({ id: 'w2', state: 'waiting', question: { id: 'q', text: 'Which?', about: 'x', step: 's1', for: 'me', options: [] } })],
      times: { 'ta:ta': at(10), 'tb:tb': at(90), 'd1.v2:review': at(50), 'w2:question': at(5) },
    });
    const ids = derive(input([room(r)])).needs.map((i) => i.id);
    assert.deepEqual(ids, ['q:r1:w2:q', 'answer:r1:tb:1', 'sign:r1:d1.v2:v2', 'answer:r1:ta:1']);
    assert.deepEqual(derive(input([room(r)])).needs.map((i) => i.id), ids);
  });
});

describe('Following', () => {
  it('shows a thread you took part in when someone else moved it, and not your own moves', () => {
    const replies = [{ id: 't1', by: 'bob', body: 'Why?', ago: '' }, { id: 'c1', by: 'me', body: 'Because', ago: '' }, { id: 'c2', by: 'cat', body: 'Hm', ago: '' }];
    const r = rec({ threads: [thread({ replies })], times: { 't1:c2': at(30) } });
    const [it] = derive(input([room(r)])).following;
    assert.equal(it.id, 'thread:r1:t1');
    assert.equal(it.why, 'You took part');
    assert.equal(it.unseen, 1);
    assert.equal(derive(input([room(rec({ threads: [thread({ replies: replies.slice(0, 2) })], times: { 't1:c1': at(5) } }))])).following.length, 0);
    // Unfollowed: gone. Never took part and not following: not Following.
    assert.equal(derive(input([room(r)], { marks: { ...NO_MARKS, follow: { t1: false } } })).following.length, 0);
    assert.equal(derive(input([room(rec({ threads: [thread()], times: { 't1:t1': at(5) } }))])).following.length, 0);
    assert.equal(derive(input([room(rec({ threads: [thread()], times: { 't1:t1': at(5) } }))], { marks: { ...NO_MARKS, follow: { t1: true } } })).following.length, 1);
  });

  it('raises a challenge to a line you signed above the rest', () => {
    const d = decision({ id: 'd1', version: 1, state: 'agreed', approvers: [{ who: 'me', signed: 1 }, { who: 'bob', signed: 1 }] });
    const line = thread({ id: 'tl', about: { kind: 'line', id: 'l1', decision: 'd1', name: 'Retry 5x' }, replies: [{ id: 'tl', by: 'cat', body: 'This breaks idempotency', ago: '' }] });
    const chat = thread({ id: 'tc', replies: [{ id: 'tc', by: 'me', body: 'a', ago: '' }, { id: 'x', by: 'bob', body: 'b', ago: '' }] });
    const r = rec({ decisions: [d], threads: [chat, line], times: { 'tl:tl': at(50), 'tc:x': at(5), 'd1:agreed': at(500), 'd1:signed:bob': at(500), 'd1:signed:me': at(600) } });
    const f = derive(input([room(r)])).following;
    assert.equal(f[0].id, 'thread:r1:tl');
    assert.equal(f[0].raised, 'Challenges a decision you signed');
    assert.deepEqual(f[0].anchor.inspect, { kind: 'decision', id: 'd1', line: 'l1' });
    assert.equal(f[1].id, 'thread:r1:tc');
    assert.equal(f[2].id, 'agreed:r1:d1');
  });

  it('says a decision you’re on was agreed by someone else’s signature, not your own', () => {
    const d = decision({ id: 'd1', version: 1, state: 'agreed', approvers: [{ who: 'me', signed: 1 }, { who: 'bob', signed: 1 }] });
    const theirs = rec({ decisions: [d], times: { 'd1:agreed': at(10), 'd1:signed:me': at(100), 'd1:signed:bob': at(10) } });
    assert.equal(derive(input([room(theirs)])).following[0].id, 'agreed:r1:d1');
    const mine = rec({ decisions: [d], times: { 'd1:agreed': at(10), 'd1:signed:me': at(10), 'd1:signed:bob': at(100) } });
    assert.equal(derive(input([room(mine)])).following.length, 0);
  });

  it('shows a new revision of a plan you authorized but don’t own', () => {
    const revision = { id: 'rv1', by: 'bob', why: '', base: 1, changes: [{ id: 'c1', kind: 'add' as const, text: 'Backfill', state: 'open' as const }] };
    const r = rec({ work: [work({ owner: 'bob', authorized: { by: 'me', ago: '', scope: '' }, revision })], times: { 'w1:revision': at(20) } });
    const v = derive(input([room(r)]));
    assert.equal(v.needs.length, 0);
    assert.equal(v.following[0].id, 'rvf:r1:w1:rv1');
    assert.equal(v.following[0].raised, 'Changes a plan you authorized');
  });

  it('lets old Following items go on their own', () => {
    const replies = [{ id: 't1', by: 'me', body: 'a', ago: '' }, { id: 'c2', by: 'cat', body: 'b', ago: '' }];
    const r = rec({ threads: [thread({ replies })], times: { 't1:c2': at(60 * 24 * 20) } });
    assert.equal(derive(input([room(r)])).following.length, 0);
  });
});

describe('Activity', () => {
  it('digests every event on one subject into one row, with counts, and leaves out your own', () => {
    const log = [
      ev('a1', 'reply', 't9', 'bob', 5), ev('a2', 'reply', 't9', 'cat', 6), ev('a3', 'reply', 't9', 'bob', 7), ev('a4', 'thread', 't9', 'bob', 8, 'Rate limits'),
      ev('a5', 'reply', 't9', 'me', 4), ev('a6', 'call-started', null, 'cat', 3),
      ev('a7', 'signed', 'd7', 'bob', 2, 'Use HMAC', 1), ev('a8', 'review', 'd7', 'cat', 9, 'Use HMAC', 1),
    ];
    const r = rec({ log, threads: [thread({ id: 't9', title: 'Rate limits' })] });
    const a = derive(input([room(r)])).activity;
    assert.deepEqual(a.map((i) => i.id), ['act:r1:decision:d7', 'act:r1:room:r1', 'act:r1:thread:t9']);
    const t = a[2];
    assert.equal(t.events.length, 4);
    assert.deepEqual(t.digest, [{ label: 'replies', n: 3 }, { label: 'thread started', n: 1 }]);
    assert.equal(t.headline, 'Rate limits: 3 replies, 1 thread started');
    assert.equal(t.anchor.thread, 't9');
    assert.equal(a[0].anchor.tab, 'decide');
  });

  it('doesn’t repeat a subject that is already in Needs you or Following, and respects muted rooms', () => {
    const r = rec({ decisions: [decision()], log: [ev('a1', 'review', 'd1', 'bob', 5, 'Retry payouts', 2), ev('a2', 'reply', 'tz', 'bob', 5)] });
    const v = derive(input([room(r)]));
    assert.deepEqual(v.activity.map((i) => i.id), ['act:r1:thread:tz']);
    assert.equal(derive(input([room(r)], { marks: { ...NO_MARKS, mutedRooms: ['r1'] } })).activity.length, 0);
  });

  it('never produces runner or GitHub items', () => {
    const r = rec({ log: [ev('a1', 'reply', 't1', 'bob', 5)], work: [work({ runs: [{ id: 'run', agent: 'x', where: '', state: 'running', plan: 1, events: [{ text: 'edit', ago: '' }] }] })] });
    const v = derive(input([room(r)]));
    for (const i of [...v.needs, ...v.following, ...v.activity]) assert.ok(i.source === 'record' || i.source === 'access');
  });
});

describe('marks', () => {
  const replies = [{ id: 't1', by: 'me', body: 'a', ago: '' }, { id: 'c2', by: 'cat', body: 'b', ago: '' }];
  const base = rec({ threads: [thread({ replies })], times: { 't1:c2': at(30) } });

  it('done hides a Following item until something new happens, locally or from the server', () => {
    const item = derive(input([room(base)])).following[0];
    assert.equal(derive(input([room(base)], { marks: { ...NO_MARKS, done: { [doneKey(item)]: NOW } } })).following.length, 0);
    assert.equal(derive(input([room(base)], { serverDone: [SERVER_DONE_PREFIX + doneKey(item)] })).following.length, 0);
    const moved = rec({ threads: [thread({ replies: [...replies, { id: 'c3', by: 'bob', body: 'c', ago: '' }] })], times: { 't1:c2': at(30), 't1:c3': at(1) } });
    assert.equal(derive(input([room(moved)], { marks: { ...NO_MARKS, done: { [doneKey(item)]: NOW } } })).following.length, 1);
  });

  it('done never hides Needs you', () => {
    const r = rec({ decisions: [decision()] });
    const item = derive(input([room(r)])).needs[0];
    assert.equal(derive(input([room(r)], { marks: { ...NO_MARKS, done: { [doneKey(item)]: NOW } } })).needs.length, 1);
  });

  it('snooze moves an item aside until it expires', () => {
    const r = rec({ decisions: [decision()] });
    const id = 'sign:r1:d1.v2:v2';
    const snoozed = derive(input([room(r)], { marks: { ...NO_MARKS, snoozed: { [id]: { until: at(-60), label: 'in an hour' } } } }));
    assert.equal(snoozed.needs.length, 0);
    assert.deepEqual(snoozed.snoozed.map((i) => i.id), [id]);
    const expired = derive(input([room(r)], { marks: { ...NO_MARKS, snoozed: { [id]: { until: at(1), label: 'earlier' } } } }));
    assert.equal(expired.needs.length, 1);
    assert.equal(expired.snoozed.length, 0);
  });

  it('counts unseen events from what you’ve seen', () => {
    const three = rec({ threads: [thread({ replies: [...replies, { id: 'c3', by: 'bob', body: 'c', ago: '' }, { id: 'c4', by: 'bob', body: 'd', ago: '' }] })], times: { 't1:c4': at(1) } });
    assert.equal(derive(input([room(three)])).following[0].unseen, 3);
    assert.equal(derive(input([room(three)], { marks: { ...NO_MARKS, seen: { 'thread:r1:t1': 2 } } })).following[0].unseen, 1);
    assert.equal(derive(input([room(three)], { marks: { ...NO_MARKS, seen: { 'thread:r1:t1': 3 } } })).following[0].unseen, 0);
  });
});

describe('discharge and resolved', () => {
  it('signing removes the sign item and records it under Done, from the record alone', () => {
    const before = rec({ decisions: [decision()], times: { 'd1.v2:review': at(40) } });
    assert.equal(derive(input([room(before)])).needs.length, 1);
    const after = rec({ decisions: [decision({ approvers: [{ who: 'me', signed: 2 }, { who: 'bob', signed: 2 }] })], times: { 'd1.v2:review': at(40), 'd1.v2:signed:me': at(1) } });
    const v = derive(input([room(after)]));
    assert.equal(v.needs.length, 0);
    assert.deepEqual(v.resolved.map((x) => [x.item.id, x.how, x.at]), [['sign:r1:d1.v2:v2', 'You signed v2', at(1)]]);
    // Long ago: not "today".
    const old = rec({ decisions: [decision({ approvers: [{ who: 'me', signed: 2 }] })], times: { 'd1.v2:signed:me': at(60 * 30) } });
    assert.equal(derive(input([room(old)])).resolved.length, 0);
  });
});

describe('away summary', () => {
  it('summarizes when you were away long enough, and not otherwise', () => {
    const r = rec({ decisions: [decision()] });
    assert.equal(derive(input([room(r)])).away, null);
    const away = derive(input([room(r)], { lastHere: at(60 * 20) })).away!;
    assert.equal(away.since, at(60 * 20));
    assert.equal(away.summary, '1 thing needs you');
    assert.match(away.label, /^Since /);
  });
});

describe('Activity from written-out events (the example workspace)', () => {
  it('shows a note verbatim, about the room, and digests several', () => {
    const r = rec({ log: [ev('n2', 'note', null, 'bob', 2, 'Bob pinned the failure view.'), ev('n1', 'note', null, 'cat', 5, 'Cat joined the call.')] });
    const [a] = derive(input([room(r)])).activity;
    assert.equal(a!.subject.kind, 'room');
    assert.equal(a!.events[0]!.text, 'Bob pinned the failure view.');
    assert.equal(a!.headline, 'Payments: 2 updates');
  });
});
