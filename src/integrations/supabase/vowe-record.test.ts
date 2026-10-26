import { createClient } from '@supabase/supabase-js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { RoomErrorCode } from '../../shared/api.js';
import { decisionVersionId } from '../../shared/vowe/ids.js';
import { AGENT, type VoweRecord } from '../../shared/vowe/model.js';
import type { Cloud } from './index.js';
import { createRoomService, RoomError, type RoomService } from './rooms.js';
import type { Database } from './types.js';
import { createVoweRecordService, toVoweError, type VoweRecordService } from './vowe-record.js';

// The Vowe room's record against a local Supabase stack, as several real signed-in people with different
// roles; skipped without one (same variables as record.test.ts, and the same refusal of anything but localhost).

const url = process.env.ROOMS_TEST_SUPABASE_URL;
const publishableKey = process.env.ROOMS_TEST_SUPABASE_PUBLISHABLE_KEY;
const secretKey = process.env.ROOMS_TEST_SUPABASE_SECRET_KEY;
const local = Boolean(url && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url));
if (url && !local) throw new Error('ROOMS_TEST_SUPABASE_URL must be a local stack (http://127.0.0.1:…), never a hosted project');
const integration = local && publishableKey && secretKey ? {} : { skip: 'set ROOMS_TEST_SUPABASE_* to run against a local stack' };

async function rejectsWith(promise: Promise<unknown>, code: RoomErrorCode, pattern?: RegExp) {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof RoomError, `expected a RoomError, got ${String(err)}`);
    assert.equal(err.code, code, err.message);
    if (pattern) assert.match(err.message, pattern);
    return true;
  });
}

describe('vowe record without a usable session', () => {
  it('reports invalid input before any request', async () => {
    const vowe = createVoweRecordService(() => Promise.reject(new Error('should not be called')));
    const room = randomUUID();
    await rejectsWith(vowe.load('nope'), 'invalid');
    await rejectsWith(vowe.createThread(room, { about: { kind: 'gossip' } as never, body: 'x' }), 'invalid');
    await rejectsWith(vowe.createThread(room, { about: { kind: 'line', id: 'l', name: 'L' } as never, body: 'x' }), 'invalid');
    await rejectsWith(vowe.editLine(room, 'not-a-decision', randomUUID(), 'x'), 'invalid');
    await rejectsWith(vowe.editLine(room, `${randomUUID()}:v2`, randomUUID(), 'x'), 'invalid');
    await rejectsWith(vowe.plan(room, randomUUID(), { op: 'explode' } as never, 1), 'invalid');
    await rejectsWith(vowe.plan(room, randomUUID(), { op: 'objective', text: 'x' }, 0), 'invalid');
    await rejectsWith(vowe.requestSignatures(room, randomUUID(), ['bob']), 'invalid');
    await rejectsWith(vowe.trackPr(room, randomUUID(), { num: 1, title: 'x', state: 'open', url: 'http://x' }), 'invalid');
    await rejectsWith(vowe.suggestRevision(room, randomUUID(), { base: 1, why: 'x', changes: [] }), 'invalid');
    await rejectsWith(vowe.reply(room, randomUUID(), 'x', 'robot' as never), 'invalid');
  });

  it('maps the database’s reasons to room error codes', () => {
    assert.equal(toVoweError({ code: 'VW404', message: 'gone' }).code, 'not-found');
    assert.equal(toVoweError({ code: 'VW403', message: 'no' }).code, 'permission-denied');
    assert.equal(toVoweError({ code: 'VW409', message: 'stale' }).code, 'conflict');
    assert.equal(toVoweError({ code: 'VW422', message: 'bad' }).message, 'bad');
    assert.equal(toVoweError({ code: '42501', message: 'rls' }).code, 'permission-denied');
  });
});

describe('vowe record (local Supabase)', integration, () => {
  const run = randomUUID().slice(0, 8);
  const password = `pw-${randomUUID()}`;
  const admin = () => createClient<Database>(url!, secretKey!, { auth: { persistSession: false, autoRefreshToken: false } });

  type Name = 'alice' | 'bob' | 'vic' | 'carol';
  interface Person { id: string; cloud: Cloud; rooms: RoomService; vowe: VoweRecordService }
  const people: Record<Name, Person> = {} as never;
  let roomId: string;
  const load = (who: Name): Promise<VoweRecord> => people[who].vowe.load(roomId);
  const rpc = (who: Name, fn: string, args: Record<string, unknown>) => (people[who].cloud as unknown as { rpc(f: string, a: unknown): Promise<{ error: { code?: string; message: string } | null }> }).rpc(fn, args);

  before(async () => {
    for (const name of ['alice', 'bob', 'vic', 'carol'] as const) {
      const email = `${name}-${run}@vowe.test`;
      const { data, error } = await admin().auth.admin.createUser({
        email, password, email_confirm: true, user_metadata: { full_name: name[0]!.toUpperCase() + name.slice(1) },
      });
      if (error) throw error;
      const cloud = createClient<Database>(url!, publishableKey!, { auth: { persistSession: false, autoRefreshToken: false } });
      const { error: signInError } = await cloud.auth.signInWithPassword({ email, password });
      if (signInError) throw signInError;
      people[name] = { id: data.user.id, cloud, rooms: createRoomService(async () => cloud), vowe: createVoweRecordService(async () => cloud) };
    }
    // Alice owns the room, Bob is a member, Vic a viewer; Carol is in the workspace but not the room.
    const { alice, bob, vic, carol } = people;
    const { data: ws, error } = await alice.cloud.from('workspaces').insert({ name: `Vowe ${run}` }).select().single();
    if (error) throw error;
    const { error: addError } = await alice.cloud.from('workspace_members').insert([
      { workspace_id: ws.id, user_id: bob.id }, { workspace_id: ws.id, user_id: vic.id }, { workspace_id: ws.id, user_id: carol.id },
    ]);
    if (addError) throw addError;
    roomId = (await alice.rooms.createRoom({ workspaceId: ws.id, name: 'Checkout', repository: 'github.com/acme/checkout' })).id;
    await alice.rooms.addMember(roomId, bob.id);
    await alice.rooms.addMember(roomId, vic.id, 'viewer');
  });

  after(async () => {
    for (const person of Object.values(people)) await admin().auth.admin.deleteUser(person.id);
  });

  it('is invisible to non-members, readable by every member', async () => {
    await rejectsWith(load('carol'), 'not-found');
    await rejectsWith(people.carol.vowe.createThread(roomId, { about: { kind: 'part', id: 'api', name: 'API' }, body: 'Hello?' }), 'not-found');
    await rejectsWith(people.carol.vowe.markDone(roomId, ['x']), 'not-found');
    const rec = await load('vic');
    assert.equal(rec.vowe, true);
    assert.equal(rec.agentName, 'Vowe');
    assert.deepEqual(rec.members.map((m) => m.role).sort(), ['member', 'owner', 'viewer']);
  });

  it('lets viewers comment but not change the record', async () => {
    const { id } = await people.vic.vowe.createThread(roomId, {
      about: { kind: 'step', id: 's1', work: 'w1', name: 'Plan · step 1' }, body: 'Why this order?', quote: 'Run the migration first', waiting: people.alice.id,
    });
    await people.vic.vowe.reply(roomId, id, 'Following up');
    let t = (await load('alice')).threads.find((x) => x.id === id)!;
    assert.deepEqual(t.about, { kind: 'step', id: 's1', work: 'w1', name: 'Plan · step 1' });
    assert.equal(t.quote, 'Run the migration first');
    assert.equal(t.waiting, people.alice.id);
    assert.equal(t.replies.length, 2);
    // Alice answering clears "waiting on Alice".
    await people.alice.vowe.reply(roomId, id, 'Because of the lock');
    t = (await load('alice')).threads.find((x) => x.id === id)!;
    assert.equal(t.waiting, undefined);

    await rejectsWith(people.vic.vowe.createDecision(roomId, { title: 'Use Postgres' }), 'permission-denied');
    await rejectsWith(people.vic.vowe.createWork(roomId, { title: 'Ship it', objective: '' }), 'permission-denied');
    await rejectsWith(people.vic.vowe.setAgentName(roomId, 'Nova'), 'permission-denied');
  });

  it('takes offers only from Vowe, and records the answer only', async () => {
    const { id: thread } = await people.bob.vowe.createThread(roomId, { about: { kind: 'part', id: 'queue', name: 'Queue' }, body: 'Retries?' });
    await rejectsWith(people.bob.vowe.reply(roomId, thread, 'Make a decision', 'human', { kind: 'decision', text: 'Draft it' }), 'invalid');
    const { id: reply } = await people.bob.vowe.reply(roomId, thread, 'This sounds like a decision.', 'agent', { kind: 'decision', text: 'Draft “Retry with backoff”' });
    await rejectsWith(people.vic.vowe.answerOffer(roomId, thread, reply, true), 'permission-denied');
    await people.alice.vowe.answerOffer(roomId, thread, reply, true);
    await rejectsWith(people.bob.vowe.answerOffer(roomId, thread, reply, false), 'conflict');
    const r = (await load('bob')).threads.find((x) => x.id === thread)!.replies.find((x) => x.id === reply)!;
    assert.equal(r.by, AGENT);
    assert.deepEqual(r.offer, { kind: 'decision', text: 'Draft “Retry with backoff”', state: 'accepted', by: people.alice.id });
  });

  it('drafts, asks for signatures, agrees, and freezes signed versions', async () => {
    const { alice, bob } = people;
    const { id } = await alice.vowe.createDecision(roomId, { title: 'Retry with backoff', line: 'Retry three times', problem: 'Payments time out' });
    let d = (await load('alice')).decisions.find((x) => x.id === id)!;
    assert.equal(d.state, 'draft');
    assert.equal(d.version, 1);
    assert.equal(d.doc?.problem.text, 'Payments time out');
    const line = d.lines[0]!;
    assert.deepEqual(line.by, { who: alice.id, how: 'stated' });

    await bob.vowe.editLine(roomId, id, line.id, 'Retry three times with jitter');
    await rejectsWith(people.vic.vowe.editLine(roomId, id, line.id, 'no'), 'permission-denied');
    await rejectsWith(alice.vowe.sign(roomId, id, 1), 'invalid'); // nobody asked yet
    await rejectsWith(alice.vowe.requestSignatures(roomId, id, [people.vic.id]), 'invalid'); // viewers don't sign
    await rejectsWith(alice.vowe.requestSignatures(roomId, id, [people.carol.id]), 'invalid'); // not in the room
    await rejectsWith(alice.vowe.requestSignatures(roomId, id, [bob.id]).then(() => rpc('alice', 'vowe_request_signatures', { decision: id, ver: 1, who: [], actor_kind: 'agent' })).then(({ error }) => { if (error) throw toVoweError(error); }), 'permission-denied');

    d = (await load('bob')).decisions.find((x) => x.id === id)!;
    assert.equal(d.state, 'review');
    assert.deepEqual(d.approvers.map((a) => a.who).sort(), [alice.id, bob.id].sort()); // the requester signs too
    await alice.vowe.sign(roomId, id, 1);
    assert.equal((await load('bob')).decisions.find((x) => x.id === id)!.state, 'review');
    // Vowe never signs, whoever's session asks.
    const { error } = await rpc('bob', 'vowe_sign', { decision: id, ver: 1, actor_kind: 'agent' });
    assert.equal(error?.code, 'VW403');
    await bob.vowe.sign(roomId, id, 1);
    d = (await load('bob')).decisions.find((x) => x.id === id)!;
    assert.equal(d.state, 'agreed');
    assert.ok(d.approvers.every((a) => a.signed === 1));

    // Signed words don't change: not through the API, not through the table.
    await rejectsWith(bob.vowe.editLine(roomId, id, line.id, 'Retry forever'), 'conflict');
    await rejectsWith(bob.vowe.editDoc(roomId, id, 'problem', 'Something else'), 'conflict');
    const direct = await admin().from('decision_lines' as never).update({ text: 'sneaky' } as never).eq('id' as never, line.id as never);
    assert.equal(direct.error?.code, 'VW409');

    // Amending opens v2 as a draft; v1 stays agreed until v2 is.
    const amended = await bob.vowe.amend(roomId, id);
    assert.equal(amended.version, 2);
    const v2 = decisionVersionId(id, 2);
    let rec = await load('alice');
    assert.equal(rec.decisions.find((x) => x.id === id)!.state, 'agreed');
    const draft = rec.decisions.find((x) => x.id === v2)!;
    assert.equal(draft.state, 'draft');
    assert.equal(draft.revises?.version, 1);
    assert.equal(draft.lines[0]!.text, 'Retry three times with jitter');
    assert.notEqual(draft.lines[0]!.id, line.id);
    await rejectsWith(bob.vowe.editLine(roomId, id, line.id, 'stale'), 'conflict'); // v1 is no longer current
    await bob.vowe.editLine(roomId, v2, draft.lines[0]!.id, 'Retry five times with jitter');

    // Asking nobody else: the requester alone signs, so one person can still agree.
    await alice.vowe.requestSignatures(roomId, v2, []);
    rec = await load('alice');
    assert.deepEqual(rec.decisions.find((x) => x.id === v2)!.approvers.map((a) => a.who), [alice.id]);
    await alice.vowe.sign(roomId, v2, 2);
    rec = await load('alice');
    assert.equal(rec.decisions.find((x) => x.id === v2)!.state, 'agreed');
    assert.equal(rec.decisions.find((x) => x.id === id)!.state, 'superseded');
  });

  it('keeps Vowe’s suggestions distinguishable, and lets people dismiss them', async () => {
    const { id } = await people.bob.vowe.createDecision(roomId, { title: 'Cache sessions', line: 'Use Redis' }, 'agent');
    let d = (await load('alice')).decisions.find((x) => x.id === id)!;
    assert.equal(d.state, 'suggested');
    assert.deepEqual(d.by, { who: AGENT, how: 'inferred' });
    assert.deepEqual(d.lines[0]!.by, { who: AGENT, how: 'inferred' });
    await rejectsWith(people.alice.vowe.requestSignatures(roomId, id, []), 'invalid');
    await people.bob.vowe.suggestLine(roomId, id, d.lines[0]!.id, 'Use Redis with a TTL', 'Sessions expire', 'agent');
    await people.alice.vowe.takeSuggestion(roomId, id, d.lines[0]!.id, true);
    d = (await load('alice')).decisions.find((x) => x.id === id)!;
    assert.equal(d.lines[0]!.text, 'Use Redis with a TTL');
    assert.equal(d.lines[0]!.was, 'Use Redis');
    await people.alice.vowe.setSuggested(roomId, id, 'dismissed');
    assert.equal((await load('alice')).decisions.find((x) => x.id === id)!.state, 'dismissed');
  });

  it('versions plans: edits, conflicts, authorization and frozen approvals', async () => {
    const { alice, bob } = people;
    const { id } = await alice.vowe.createWork(roomId, { title: 'Add retries', objective: 'Stop timeouts failing payments' });
    let w = (await load('bob')).work.find((x) => x.id === id)!;
    assert.equal(w.state, 'draft');
    assert.equal(w.version, 1);
    assert.equal(w.owner, alice.id);
    assert.deepEqual(w.runs, []);

    await bob.vowe.plan(roomId, id, { op: 'edit', step: w.plan[0]!.id, text: 'Wrap the client in a retry' }, 1);
    await bob.vowe.plan(roomId, id, { op: 'add', after: w.plan[0]!.id, text: 'Add a test' }, 1);
    await bob.vowe.plan(roomId, id, { op: 'list', list: 'may', index: 0, text: 'Edit src/payments/**' }, 1);
    await rejectsWith(people.vic.vowe.plan(roomId, id, { op: 'objective', text: 'no' }, 1), 'permission-denied');
    await rejectsWith(bob.vowe.plan(roomId, id, { op: 'objective', text: 'stale' }, 2), 'conflict');
    await rejectsWith(alice.vowe.authorize(roomId, id, 1), 'invalid'); // nobody chosen to do it
    await bob.vowe.plan(roomId, id, { op: 'doer', doer: { kind: 'agent', name: 'Claude Code' } }, 1);
    w = (await load('bob')).work.find((x) => x.id === id)!;
    assert.equal(w.plan.length, 2);
    assert.equal(w.plan[1]!.by.who, bob.id);
    assert.equal(w.log.at(-1)!.text, 'Chose Claude Code to do it');

    // Only the plan's owner or the room's owner authorizes; Vowe never does.
    await rejectsWith(bob.vowe.authorize(roomId, id, 1), 'permission-denied');
    const agentTry = await rpc('alice', 'vowe_authorize', { work: id, ver: 1, actor_kind: 'agent' });
    assert.equal(agentTry.error?.code, 'VW403');
    await alice.vowe.authorize(roomId, id, 1);
    w = (await load('bob')).work.find((x) => x.id === id)!;
    assert.equal(w.state, 'authorized');
    assert.equal(w.versions.length, 1);
    assert.equal(w.versions[0]!.approved?.by, alice.id);
    assert.equal(w.versions[0]!.approved?.doer, 'Claude Code');
    assert.equal(w.versions[0]!.approved?.scope, 'src/payments/** · draft PRs');
    assert.equal(w.versions[0]!.body.plan[0]!.text, 'Wrap the client in a retry');
    assert.deepEqual(w.runs, []); // authorizing starts nothing

    // The next edit opens v2; v1 stays as approved.
    await bob.vowe.plan(roomId, id, { op: 'edit', step: w.plan[0]!.id, text: 'Wrap the client in a retry with backoff' }, 1);
    w = (await load('bob')).work.find((x) => x.id === id)!;
    assert.equal(w.version, 2);
    assert.equal(w.versions[0]!.body.plan[0]!.text, 'Wrap the client in a retry');
    await rejectsWith(alice.vowe.authorize(roomId, id, 1), 'conflict'); // v1 is no longer what's being edited
    // Progress isn't content: marking a step done doesn't open another version.
    await bob.vowe.plan(roomId, id, { op: 'state', step: w.plan[0]!.id, state: 'done' }, 2);
    assert.equal((await load('bob')).work.find((x) => x.id === id)!.version, 2);
    // Doer changes are content: on an approved snapshot they open the next draft.
    await alice.vowe.authorize(roomId, id, 2);
    await bob.vowe.plan(roomId, id, { op: 'prs', prs: 'grouped' }, 2);
    assert.equal((await load('bob')).work.find((x) => x.id === id)!.version, 3);

    // Approved versions can't be changed or removed, even bypassing the API.
    const { error: asMember } = await alice.cloud.from('plan_versions' as never).update({ body: {} } as never).eq('work_id' as never, id as never);
    assert.equal(asMember?.code, '42501');
    const { error: asAdmin } = await admin().from('plan_versions' as never).update({ body: {} } as never).eq('work_id' as never, id as never).eq('version' as never, 1 as never);
    assert.equal(asAdmin?.code, 'VW409');
    const { error: deleting } = await admin().from('plan_versions' as never).delete().eq('work_id' as never, id as never).eq('version' as never, 1 as never);
    assert.equal(deleting?.code, 'VW409');
  });

  it('reviews suggested changes one by one, promoting a step to its own work', async () => {
    const { alice, bob } = people;
    const { id } = await alice.vowe.createWork(roomId, { title: 'Refunds', objective: 'Let support refund' });
    let w = (await load('bob')).work.find((x) => x.id === id)!;
    await bob.vowe.plan(roomId, id, { op: 'edit', step: w.plan[0]!.id, text: 'Add the refund endpoint' }, 1);
    await bob.vowe.plan(roomId, id, { op: 'doer', doer: { kind: 'person', name: 'Bob' } }, 1);
    w = (await load('bob')).work.find((x) => x.id === id)!;
    await bob.vowe.suggestRevision(roomId, id, {
      base: 1, why: 'Audit first', changes: [
        { kind: 'edit', step: w.plan[0]!.id, text: 'Add the refund endpoint behind a flag' },
        { kind: 'promote', step: w.plan[0]!.id, title: 'Audit log', text: 'Write refunds to the audit log', seed: { id: 'attacker-chosen', why: 'Compliance' } },
        { kind: 'verify', text: 'Refund test passes' },
      ],
    }, 'agent');
    await rejectsWith(alice.vowe.suggestRevision(roomId, id, { base: 1, why: 'More', changes: [{ kind: 'verify', text: 'x' }] }), 'conflict'); // one open set at a time
    w = (await load('bob')).work.find((x) => x.id === id)!;
    assert.equal(w.revision?.by, AGENT);
    const [edit, promote, verify] = w.revision!.changes;
    await rejectsWith(alice.vowe.authorize(roomId, id, 1), 'invalid'); // undecided suggestions

    await bob.vowe.decideChange(roomId, id, edit!.id, true);
    await bob.vowe.decideChange(roomId, id, promote!.id, true);
    await rejectsWith(bob.vowe.decideChange(roomId, id, promote!.id, true), 'conflict');
    await bob.vowe.decideChange(roomId, id, verify!.id, false);
    const rec = await load('bob');
    w = rec.work.find((x) => x.id === id)!;
    assert.equal(w.plan.find((s) => !s.promoted)!.text, 'Add the refund endpoint behind a flag');
    assert.deepEqual(w.accept, []);
    const dep = rec.work.find((x) => x.id === w.dependsOn)!;
    assert.ok(dep, 'the promoted step is its own work');
    assert.notEqual(dep.id, 'attacker-chosen');
    assert.match(dep.id, /^[0-9a-f-]{36}$/);
    assert.equal(dep.state, 'proposed');
    assert.equal(dep.blocks, id);
    assert.equal(dep.why, 'Compliance');
    assert.ok(w.revision!.changes.every((c) => c.state !== 'open'));

    // Authorizing the plan authorizes the proposed work it depends on, and names it.
    await alice.vowe.authorize(roomId, id, w.version);
    const after = await load('bob');
    assert.deepEqual(after.work.find((x) => x.id === id)!.versions.at(-1)!.approved?.includes, ['Audit log']);
    assert.equal(after.work.find((x) => x.id === dep.id)!.state, 'authorized');
  });

  it('asks before widening scope, records questions and findings, and resolves only when PRs are done', async () => {
    const { alice, bob } = people;
    const { id } = await bob.vowe.createWork(roomId, { title: 'Webhooks', objective: 'Retry webhooks' });
    await bob.vowe.requestScope(roomId, id, { text: 'Needs a migration', adds: 'Edit db/migrations/**', by: 'Claude Code' }, 'agent');
    let w = (await load('alice')).work.find((x) => x.id === id)!;
    assert.deepEqual(w.scopeAsk, { text: 'Needs a migration', adds: 'Edit db/migrations/**', by: 'Claude Code' });
    await rejectsWith(people.vic.vowe.allowScope(roomId, id, true), 'permission-denied');
    await alice.vowe.allowScope(roomId, id, true); // the room's owner, not the plan's
    w = (await load('alice')).work.find((x) => x.id === id)!;
    assert.equal(w.scopeAsk, undefined);
    assert.ok(w.may.includes('Edit db/migrations/**'));

    const { id: q } = await bob.vowe.ask(roomId, id, { text: 'Keep the old endpoint?', for: alice.id, options: ['Yes', 'No'] }, 'agent');
    await alice.vowe.answer(roomId, id, q, 'Yes, for a month');
    await rejectsWith(alice.vowe.answer(roomId, id, q, 'Again'), 'conflict');
    await bob.vowe.addFinding(roomId, id, { text: 'Two handlers swallow errors', evidence: ['src/hooks.ts:40'] }, 'agent');
    w = (await load('alice')).work.find((x) => x.id === id)!;
    assert.deepEqual(w.question?.answer, { by: alice.id, text: 'Yes, for a month' });
    assert.equal(w.finding?.by, AGENT);

    await bob.vowe.trackPr(roomId, id, { num: 12, title: 'Retry webhooks', state: 'open', branch: 'retry', url: 'https://github.com/acme/checkout/pull/12' });
    await rejectsWith(bob.vowe.trackPr(roomId, id, { num: 13, title: 'x', state: 'open' }).then(() => rpc('bob', 'vowe_track_pr', { work: id, num: 14, title: 'x', state: 'merged', actor_kind: 'agent' })).then(({ error }) => { if (error) throw toVoweError(error); }), 'permission-denied');
    await rejectsWith(people.vic.vowe.resolve(roomId, id), 'permission-denied');
    await rejectsWith(bob.vowe.resolve(roomId, id), 'conflict', /merged or closed/);
    await bob.vowe.trackPr(roomId, id, { num: 12, title: 'Retry webhooks', state: 'merged', branch: 'retry' });
    await bob.vowe.trackPr(roomId, id, { num: 13, title: 'x', state: 'closed' });
    await bob.vowe.resolve(roomId, id);
    w = (await load('alice')).work.find((x) => x.id === id)!;
    assert.equal(w.state, 'resolved');
    assert.equal(w.resolved?.by, bob.id);
    assert.equal(w.prs.length, 2);
  });

  it('keeps each person’s attention marks their own', async () => {
    await people.alice.vowe.markDone(roomId, ['d:x:1', 'd:x:1', 't:y']);
    await people.vic.vowe.markDone(roomId, ['t:z']);
    assert.deepEqual((await load('alice')).done.sort(), ['d:x:1', 't:y']);
    assert.deepEqual((await load('bob')).done, []);
    assert.deepEqual((await load('vic')).done, ['t:z']);
    const { error } = await people.bob.cloud.from('attention_done' as never).insert({ room_id: roomId, item_id: 'forged', user_id: people.alice.id } as never);
    assert.ok(error, 'nobody marks for someone else');
  });

  it('lets only owners rename the assistant', async () => {
    await rejectsWith(people.bob.vowe.setAgentName(roomId, 'Nova'), 'permission-denied');
    assert.equal(await people.alice.vowe.setAgentName(roomId, '  Nova '), 'Nova');
    assert.equal((await load('vic')).agentName, 'Nova');
    const { error } = await rpc('alice', 'vowe_set_agent_name', { room: roomId, name: 'Me', actor_kind: 'agent' });
    assert.equal(error?.code, 'VW403');
    assert.equal(await people.alice.vowe.setAgentName(roomId, ''), 'Vowe');
  });
});
