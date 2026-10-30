import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AGENT } from '../../shared/vowe/model.js';
import { agoOf, toVoweRecord, type RawVoweRecord } from './vowe-map.js';
import { planPatch, requirePlanOp } from './vowe-record.js';

const D = '0f8fad5b-d9cb-469f-a165-70867728950e';
const now = new Date('2026-11-02T12:00:00Z');
const at = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();

const raw = (): RawVoweRecord => ({
  me: 'alice',
  room: { id: 'room', goal: 'Ship checkout', created_by: 'alice', repository: 'acme/checkout', vowe: true, agent_name: 'Nova' },
  members: [
    { user_id: 'alice', role: 'owner', name: 'Alice', email: null, avatar_url: null },
    { user_id: 'bob', role: 'member', name: 'Bob', email: null, avatar_url: null },
    { user_id: 'vic', role: 'viewer', name: 'Vic', email: null, avatar_url: null },
  ],
  threads: [{
    id: 't1', body: 'Why?', created_by: 'bob', created_at: at(30), resolved_at: null, anchor_id: 'l1', anchor_name: 'Decision line',
    anchor_x: null, anchor_y: null, about_kind: 'line', about_parent: `${D}.v2`, quote: 'Retry', waiting_on: null, author_kind: 'human', links: [],
    replies: [{ id: 'c1', thread_id: 't1', body: 'Draft it?', created_by: 'bob', created_at: at(5), author_kind: 'agent', offer: { kind: 'decision', text: 'Draft' }, offer_state: 'open', offer_by: null }],
  }],
  decisions: [{
    id: D, title: 'Retry', version: 2, created_at: at(120), from_thread: null, parts: ['api'],
    versions: [
      { decision_id: D, version: 1, title: 'Retry', verify: 'a; b', proposed_by: 'alice', created_at: at(120), state: 'agreed', revises_version: null, revises_why: null, doc: null, author_kind: 'human',
        lines: [], alternatives: [], reviewers: [], signatures: [{ user_id: 'alice', version: 1, signed_at: at(100) }, { user_id: 'bob', version: 1, signed_at: at(90) }] },
      { decision_id: D, version: 2, title: 'Retry', verify: '', proposed_by: 'bob', created_at: at(10), state: 'review', revises_version: 1, revises_why: 'Too few', doc: null, author_kind: 'agent',
        lines: [{ id: 'l1', position: 0, kind: 'decide', text: 'Retry 5x', created_by: 'bob', author_kind: 'agent', how: 'inferred', basis: 'inferred', evidence: [], was: null, suggest: null, edited_by: null }],
        alternatives: [], reviewers: [{ user_id: 'alice', changes_text: null }, { user_id: 'bob', changes_text: 'Say why' }], signatures: [] },
    ],
  }],
  work: [],
  activity: [
    { id: 'a1', actor_id: 'bob', kind: 'review', subject: 'Retry', version: 2, subject_id: D, created_at: at(9) },
    { id: 'a2', actor_id: 'alice', kind: 'reply', subject: 'mine', version: null, subject_id: 't1', created_at: at(8) },
    { id: 'a3', actor_id: 'bob', kind: 'thread', subject: 'old', version: null, subject_id: 't1', created_at: at(300) },
  ],
  seen_at: at(60),
  done: ['x'],
});

describe('vowe record mapping', () => {
  it('maps threads, offers and Vowe’s authorship', () => {
    const rec = toVoweRecord(raw(), { now });
    const t = rec.threads[0]!;
    assert.deepEqual(t.about, { kind: 'line', id: 'l1', name: 'Decision line', decision: `${D}.v2` });
    assert.equal(t.replies.length, 2);
    assert.equal(t.replies[0]!.fresh, true);
    assert.equal(t.replies[1]!.by, AGENT);
    assert.deepEqual(t.replies[1]!.offer, { kind: 'decision', text: 'Draft', state: 'open' });
    assert.equal(rec.agentName, 'Nova');
    assert.deepEqual(rec.goal, { text: 'Ship checkout', by: 'alice' });
    assert.deepEqual(rec.agents, []);
    assert.deepEqual(rec.notices, []);
  });

  it('keeps which reply a reply answers; a reply to the thread has none', () => {
    const r = raw();
    r.threads[0]!.replies.push({ ...r.threads[0]!.replies[0]!, id: 'c2', author_kind: 'human', offer: null, offer_state: null, parent_id: 'c1' });
    const [, first, second] = toVoweRecord(r, { now }).threads[0]!.replies;
    assert.equal(first!.parent, undefined);
    assert.equal(second!.parent, 'c1');
  });

  it('makes each decision version its own decision, with its approvers', () => {
    const [v1, v2] = toVoweRecord(raw(), { now }).decisions;
    assert.equal(v1!.id, D);
    assert.deepEqual(v1!.verify, ['a', 'b']);
    assert.deepEqual(v1!.approvers, [{ who: 'alice', signed: 1 }, { who: 'bob', signed: 1 }]); // the older path: every signer
    assert.equal(v2!.id, `${D}.v2`);
    assert.deepEqual(v2!.revises, { version: 1, why: 'Too few' });
    assert.deepEqual(v2!.by, { who: AGENT, how: 'inferred' });
    assert.deepEqual(v2!.approvers, [{ who: 'alice', signed: 1 }, { who: 'bob', signed: 1, changes: 'Say why' }]);
    assert.deepEqual(v2!.lines[0]!.by, { who: AGENT, how: 'inferred' });
  });

  it('lists what others did since you were here', () => {
    const since = toVoweRecord(raw(), { now }).since!;
    assert.equal(since.items.length, 1);
    assert.deepEqual(since.items[0]!.to, { tab: 'decide', id: `${D}.v2` });
    assert.equal(since.items[0]!.tone, 'needs');
    assert.equal(toVoweRecord({ ...raw(), seen_at: null }, { now }).since, undefined);
  });

  it('carries real times, the activity log, you and member names (additive, for the Inbox)', () => {
    const rec = toVoweRecord(raw(), { now });
    assert.equal(rec.me, 'alice');
    assert.deepEqual(rec.members[0], { who: 'alice', role: 'owner', name: 'Alice' });
    const t = rec.times!;
    assert.equal(t['t1'], at(30));
    assert.equal(t['t1:t1'], at(30));
    assert.equal(t['t1:c1'], at(5));
    assert.equal(t[D], at(120));
    assert.equal(t[`${D}:signed:bob`], at(90));
    assert.equal(t[`${D}:agreed`], at(90)); // no 'agreed' activity: the last signature agreed it
    assert.equal(t[`${D}.v2`], at(10));
    assert.equal(t[`${D}.v2:review`], at(9));
    assert.equal(t[`${D}.v2:agreed`], undefined);
    assert.deepEqual(rec.log!.map((e) => e.id), ['a2', 'a1', 'a3']); // newest first
    assert.deepEqual(rec.log![1], { id: 'a1', by: 'bob', kind: 'review', text: 'Retry', subject: D, version: 2, at: at(9) });
    assert.equal(toVoweRecord({ ...raw(), me: null }, { now }).me, undefined);
  });

  it('says how long ago', () => {
    assert.equal(agoOf(at(0.5), now), 'now');
    assert.equal(agoOf(at(5), now), '5m');
    assert.equal(agoOf(at(180), now), '3h');
    assert.equal(agoOf(at(60 * 24 * 2), now), '2d');
  });
});

describe('plan ops from IPC', () => {
  it('accepts only known shapes', () => {
    assert.deepEqual(requirePlanOp({ op: 'objective', text: ' x ' }), { op: 'objective', text: 'x' });
    assert.throws(() => requirePlanOp({ op: 'list', list: 'secrets', index: 0, text: 'x' }));
    assert.throws(() => requirePlanOp({ op: 'doer', doer: { kind: 'robot', name: 'x' } }));
    assert.equal(requirePlanOp({ op: 'restore', index: 0, step: { id: 's', text: 't', by: { who: 'mallory' } } }).op, 'restore');
  });

  it('sends only what changed, and authors new steps as you', () => {
    const before = { why: 'a', plan: [{ id: 's1', text: 'x', by: { who: 'alice' }, state: 'todo' as const }], may: [], mayNot: [], askWhen: [], accept: [], doer: null, exec: { where: 'w', prs: 'per-step' as const } };
    const patch = planPatch(before as never, { why: 'a', plan: [...before.plan, { id: 's2', text: 'y', by: { who: 'mallory' }, state: 'todo' }] } as never, 'bob');
    assert.deepEqual(Object.keys(patch), ['plan']);
    assert.deepEqual((patch.plan as { by: unknown }[])[1]!.by, { who: 'bob', how: 'stated' });
  });
});
