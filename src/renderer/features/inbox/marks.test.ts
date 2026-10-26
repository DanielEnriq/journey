import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EMPTY_MARKS, MarksStore, marksKey, parseMarks, serializeMarks, type RemoteMarks, type StorageLike } from './marks.js';

const NOW = '2026-11-02T12:00:00.000Z';
const at = (days: number) => new Date(Date.parse(NOW) - days * 86_400_000).toISOString();

function memory(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
}

describe('Inbox marks (local)', () => {
  it('round-trips through storage, per person', () => {
    const s = memory();
    const a = new MarksStore('alice', s, () => NOW);
    a.seen('i1', 2);
    a.done('i2@x');
    a.snooze('i3', at(-1), 'Tomorrow');
    a.follow('t1', true);
    a.mute('r1', true);
    a.decline('inv1');
    a.touch();
    const back = new MarksStore('alice', s, () => NOW).marks;
    assert.deepEqual(back.seen, { i1: 2 });
    assert.deepEqual(back.done, { 'i2@x': NOW });
    assert.deepEqual(back.snoozed, { i3: { until: at(-1), label: 'Tomorrow' } });
    assert.deepEqual(back.follow, { t1: true });
    assert.deepEqual(back.mutedRooms, ['r1']);
    assert.deepEqual(back.declined, ['inv1']);
    assert.ok(s.data.has(marksKey('alice')));
    assert.deepEqual(new MarksStore('bob', s, () => NOW).marks, EMPTY_MARKS);
  });

  it('undoes, unsnoozes, unfollows and unmutes', () => {
    const m = new MarksStore('a', memory(), () => NOW);
    m.done('k'); m.undone('k');
    m.snooze('i', at(-1), 'Later'); m.unsnooze('i');
    m.follow('t', true); m.follow('t', false);
    m.mute('r', true); m.mute('r', false);
    assert.deepEqual(m.marks.done, {});
    assert.deepEqual(m.marks.snoozed, {});
    assert.deepEqual(m.marks.follow, { t: false }); // an explicit unfollow is kept: it suppresses Following
    assert.deepEqual(m.marks.mutedRooms, []);
  });

  it('knows when you were last here (the previous session’s last activity)', () => {
    const s = memory();
    const first = new MarksStore('a', s, () => at(2));
    assert.equal(first.lastHere, null);
    first.touch();
    assert.equal(new MarksStore('a', s, () => NOW).lastHere, at(2));
  });

  it('drops old and malformed marks, and other versions', () => {
    const raw = serializeMarks({ ...EMPTY_MARKS, done: { old: at(40), fresh: at(1) }, snoozed: { gone: { until: at(10), label: 'x' }, soon: { until: at(-1), label: 'y' } } });
    const m = parseMarks(raw, NOW);
    assert.deepEqual(Object.keys(m.done), ['fresh']);
    assert.deepEqual(Object.keys(m.snoozed), ['soon']);
    assert.deepEqual(parseMarks('{nope', NOW), EMPTY_MARKS);
    assert.deepEqual(parseMarks(JSON.stringify({ v: 99, seen: { a: 1 } }), NOW), EMPTY_MARKS);
    assert.deepEqual(parseMarks(JSON.stringify({ v: 1, seen: { a: 'x', b: 2 }, mutedRooms: [1, 'r'] }), NOW).seen, { b: 2 });
  });

  it('keeps working when storage throws', () => {
    const bad: StorageLike = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('full'); } };
    const m = new MarksStore('a', bad, () => NOW);
    m.seen('i', 1);
    assert.deepEqual(m.marks.seen, { i: 1 });
    const none = new MarksStore('a', null, () => NOW);
    none.mute('r', true);
    assert.deepEqual(none.marks.mutedRooms, ['r']);
  });
});

describe('Inbox marks (your account)', () => {
  const remote = (row: { marks: unknown; updatedAt: string } | null, fail?: string) => {
    const saved: unknown[] = [];
    const r: RemoteMarks & { saved: unknown[] } = {
      saved,
      get: async () => { if (fail) throw new Error(fail); return row; },
      save: async (m) => { if (fail) throw new Error(fail); saved.push(m); return NOW; },
    };
    return r;
  };

  it('takes your account’s copy when it is newer than this machine’s', async () => {
    const s = memory();
    const old = new MarksStore('a', s, () => at(3));
    old.mute('r-old', true);
    const acct = remote({ marks: { v: 1, mutedRooms: ['r-new'], follow: { t: true }, lastActive: at(1), updatedAt: at(1) }, updatedAt: at(1) });
    const m = new MarksStore('a', s, () => NOW, acct);
    await m.sync();
    assert.deepEqual(m.marks.mutedRooms, ['r-new']);
    assert.deepEqual(m.marks.follow, { t: true });
    assert.equal(m.lastHere, at(1));
    assert.deepEqual(m.kept.state.kept, { on: 'account' });
    assert.deepEqual(parseMarks(s.data.get(marksKey('a'))!, NOW).mutedRooms, ['r-new']);
    assert.equal(acct.saved.length, 0);
  });

  it('sends this machine’s copy when it is newer, or the account has none', async () => {
    const s = memory();
    new MarksStore('a', s, () => NOW).mute('r1', true);
    const acct = remote(null);
    const m = new MarksStore('a', s, () => NOW, acct);
    await m.sync();
    assert.deepEqual((acct.saved[0] as { mutedRooms: string[] }).mutedRooms, ['r1']);
    assert.deepEqual(m.kept.state.kept, { on: 'account' });
  });

  it('writes changes back, and only after the account has been read', async () => {
    const acct = remote(null);
    const m = new MarksStore('a', memory(), () => NOW, acct);
    m.follow('t', true);
    await m.flush();
    assert.equal(acct.saved.length, 0); // not read yet: never overwrite the account blind
    await m.sync();
    m.follow('t2', true);
    await m.flush();
    assert.deepEqual((acct.saved.at(-1) as { follow: Record<string, boolean> }).follow, { t: true, t2: true });
  });

  it('keeps working on this machine, and says why, when the account can’t be reached', async () => {
    const m = new MarksStore('a', memory(), () => NOW, remote(null, 'This database doesn’t keep Inbox marks yet'));
    await m.sync();
    m.mute('r', true);
    assert.deepEqual(m.marks.mutedRooms, ['r']);
    assert.deepEqual(m.kept.state.kept, { on: 'device', reason: 'This database doesn’t keep Inbox marks yet' });
  });
});
