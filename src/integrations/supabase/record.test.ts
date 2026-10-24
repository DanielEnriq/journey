import { createClient } from '@supabase/supabase-js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { RoomErrorCode } from '../../shared/api.js';
import type { Cloud } from './index.js';
import { createRoomRecordService, type RoomRecordService } from './record.js';
import { createRoomService, RoomError, type RoomService } from './rooms.js';
import type { Database } from './types.js';

// A room's record against a local Supabase stack, as several real signed-in people; skipped without
// one (same variables as rooms.test.ts, and the same refusal of anything but localhost).

const url = process.env.ROOMS_TEST_SUPABASE_URL;
const publishableKey = process.env.ROOMS_TEST_SUPABASE_PUBLISHABLE_KEY;
const secretKey = process.env.ROOMS_TEST_SUPABASE_SECRET_KEY;
const local = Boolean(url && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url));
if (url && !local) throw new Error('ROOMS_TEST_SUPABASE_URL must be a local stack (http://127.0.0.1:…), never a hosted project');
const integration = local && publishableKey && secretKey ? {} : { skip: 'set ROOMS_TEST_SUPABASE_* to run against a local stack' };

async function rejectsWith(promise: Promise<unknown>, code: RoomErrorCode) {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof RoomError, `expected a RoomError, got ${String(err)}`);
    assert.equal(err.code, code, err.message);
    return true;
  });
}

describe('room record without a usable session', () => {
  it('reports invalid input before any request', async () => {
    const record = createRoomRecordService(() => Promise.reject(new Error('should not be called')));
    await rejectsWith(record.getRecord('nope'), 'invalid');
    await rejectsWith(record.addThread(randomUUID(), { kind: 'gossip' as never, anchor: { id: 'a', name: 'A' }, body: 'x' }), 'invalid');
    await rejectsWith(record.addThread(randomUUID(), { kind: 'note', anchor: { id: 'a', name: 'A' }, body: '   ' }), 'invalid');
    await rejectsWith(record.reply(randomUUID(), randomUUID(), ''), 'invalid');
    await rejectsWith(record.propose(randomUUID(), { title: 'x', verify: '' }), 'invalid');
    await rejectsWith(record.sign(randomUUID(), randomUUID(), 0), 'invalid');
    await rejectsWith(record.logCall(randomUUID(), 'call-ended' as never), 'invalid');
  });
});

describe('room record (local Supabase)', integration, () => {
  const run = randomUUID().slice(0, 8);
  const password = `pw-${randomUUID()}`;
  const admin = () => createClient<Database>(url!, secretKey!, { auth: { persistSession: false, autoRefreshToken: false } });

  interface Person { id: string; cloud: Cloud; rooms: RoomService; record: RoomRecordService }
  const people: Record<'alice' | 'bob' | 'carol', Person> = {} as never;
  let roomId: string;

  before(async () => {
    for (const name of ['alice', 'bob', 'carol'] as const) {
      const email = `${name}-${run}@record.test`;
      const { data, error } = await admin().auth.admin.createUser({
        email, password, email_confirm: true, user_metadata: { full_name: name[0]!.toUpperCase() + name.slice(1) },
      });
      if (error) throw error;
      const cloud = createClient<Database>(url!, publishableKey!, { auth: { persistSession: false, autoRefreshToken: false } });
      const { error: signInError } = await cloud.auth.signInWithPassword({ email, password });
      if (signInError) throw signInError;
      people[name] = { id: data.user.id, cloud, rooms: createRoomService(async () => cloud), record: createRoomRecordService(async () => cloud) };
    }
    // Alice and Bob share a room; Carol is in the workspace but not the room.
    const { alice, bob, carol } = people;
    const { data: ws, error } = await alice.cloud.from('workspaces').insert({ name: `Record ${run}` }).select().single();
    if (error) throw error;
    const { error: addError } = await alice.cloud.from('workspace_members').insert([
      { workspace_id: ws.id, user_id: bob.id },
      { workspace_id: ws.id, user_id: carol.id },
    ]);
    if (addError) throw addError;
    roomId = (await alice.rooms.createRoom({ workspaceId: ws.id, name: 'Payments', repository: 'github.com/acme/payments' })).id;
    await alice.rooms.addMember(roomId, bob.id);
  });

  after(async () => {
    for (const person of Object.values(people)) await admin().auth.admin.deleteUser(person.id);
  });

  it('keeps threads and replies, with their authors and times, for every member', async () => {
    const { alice, bob } = people;
    const thread = await alice.record.addThread(roomId, {
      kind: 'concern', anchor: { id: 'pin', name: 'Canvas', x: 120, y: 80 }, body: ' A crash after the charge redelivers the job. ',
    });
    assert.equal(thread.body, 'A crash after the charge redelivers the job.');
    assert.equal(thread.author.id, alice.id);
    assert.equal(thread.author.name, 'Alice');
    assert.deepEqual(thread.anchor, { id: 'pin', name: 'Canvas', x: 120, y: 80 });
    assert.ok(Date.parse(thread.createdAt));

    const reply = await bob.record.reply(roomId, thread.id, 'Confirmed in the logs.');
    assert.equal(reply.author.id, bob.id);

    // A fresh read, as after reopening the room.
    const record = await alice.record.getRecord(roomId);
    const read = record.threads.find((t) => t.id === thread.id)!;
    assert.deepEqual(read.replies.map((r) => [r.body, r.author.name]), [['Confirmed in the logs.', 'Bob']]);
    assert.deepEqual(record.activity.slice(0, 2).map((a) => [a.kind, a.actor?.id]), [['reply', bob.id], ['thread', alice.id]]);

    await bob.record.resolve(roomId, thread.id);
    assert.ok(!(await alice.record.getRecord(roomId)).threads.some((t) => t.id === thread.id));
  });

  it('refuses forged authors, and replies to another room’s threads', async () => {
    const { alice, bob } = people;
    const { error } = await bob.cloud.from('room_threads').insert({
      room_id: roomId, anchor_id: 'pin', anchor_name: 'Canvas', body: 'as Alice', created_by: alice.id,
    } as never);
    assert.equal(error?.code, '42501'); // created_by has no client grant

    const other = await alice.rooms.createRoom({ workspaceId: (await alice.rooms.getRoom(roomId)).workspaceId, name: 'Other' });
    const elsewhere = await alice.record.addThread(other.id, { kind: 'note', anchor: { id: 'pin', name: 'Canvas' }, body: 'elsewhere' });
    await rejectsWith(alice.record.reply(roomId, elsewhere.id, 'crossing rooms'), 'not-found');
  });

  it('hides the record from people outside the room', async () => {
    const { carol } = people;
    await rejectsWith(carol.record.getRecord(roomId), 'not-found');
    await rejectsWith(carol.record.addThread(roomId, { kind: 'note', anchor: { id: 'pin', name: 'Canvas' }, body: 'hi' }), 'not-found');
    const { data } = await carol.cloud.from('room_threads').select('id').eq('room_id', roomId);
    assert.deepEqual(data, []);
  });

  it('binds signatures to the current version, which only the database bumps', async () => {
    const { alice, bob } = people;
    const proposed = await alice.record.propose(roomId, { title: 'Use idempotent processing.', verify: 'Concurrent pickup' });
    assert.equal(proposed.version, 1);
    assert.equal(proposed.proposedBy.id, alice.id);

    let d = await alice.record.sign(roomId, proposed.id, 1);
    d = await alice.record.sign(roomId, proposed.id, 1); // twice is a no-op
    assert.deepEqual(d.signatures.map((s) => [s.userId, s.version]), [[alice.id, 1]]);

    d = await bob.record.amend(roomId, proposed.id, { verify: 'Concurrent pickup; worker crash after charge' });
    assert.equal(d.version, 2);
    assert.equal(d.proposedBy.id, bob.id);
    assert.deepEqual(d.history.map((h) => [h.version, h.verify]), [[1, 'Concurrent pickup']]);
    // Alice's v1 signature stays on the record, and no longer counts.
    assert.ok(!d.signatures.some((s) => s.version === d.version));

    await rejectsWith(alice.record.sign(roomId, proposed.id, 1), 'conflict');
    const { error: stale } = await alice.cloud.from('room_signatures').insert({ decision_id: proposed.id, version: 1 });
    assert.equal(stale?.code, '42501');
    const { error: forged } = await alice.cloud.from('room_decisions').update({ version: 9 } as never).eq('id', proposed.id);
    assert.equal(forged?.code, '42501'); // version has no client grant

    d = await bob.record.sign(roomId, proposed.id, 2);
    d = await alice.record.sign(roomId, proposed.id, 2);
    assert.deepEqual(d.signatures.filter((s) => s.version === 2).map((s) => s.userId).sort(), [alice.id, bob.id].sort());

    const unchanged = await alice.record.amend(roomId, proposed.id, { verify: d.verify });
    assert.equal(unchanged.version, 2); // the same words aren't a new version

    const kinds = (await bob.record.getRecord(roomId)).activity.map((a) => a.kind);
    assert.deepEqual(kinds.slice(0, 5), ['signed', 'signed', 'amended', 'signed', 'decision']);
  });

  it('keeps each person’s own last visit, and logs calls only as yourself', async () => {
    const { alice, bob } = people;
    assert.equal((await bob.record.getRecord(roomId)).lastSeenAt, null);
    await bob.record.markSeen(roomId);
    const first = (await bob.record.getRecord(roomId)).lastSeenAt;
    assert.ok(first && Date.parse(first));
    await bob.record.markSeen(roomId);
    assert.ok(Date.parse((await bob.record.getRecord(roomId)).lastSeenAt!) >= Date.parse(first));
    assert.equal((await alice.record.getRecord(roomId)).lastSeenAt, null);

    await alice.record.logCall(roomId, 'call-started');
    const latest = (await bob.record.getRecord(roomId)).activity[0]!;
    assert.deepEqual([latest.kind, latest.actor?.id], ['call-started', alice.id]);
    const { error } = await alice.cloud.from('room_activity').insert({ room_id: roomId, kind: 'signed' });
    assert.equal(error?.code, '42501');
  });
});
