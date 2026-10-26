import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decisionVersionId, parseDecisionVersionId } from './ids.js';
import type { VoweRecord, Work } from './model.js';
import { applyOp, approve, decide, scopeOf } from './plan.js';

const work = (over: Partial<Work> = {}): Work => ({
  id: 'w1', title: 'Retries', why: 'Stop timeouts', repo: 'acme/checkout', parts: [], owner: 'alice', doer: { kind: 'agent', name: 'Claude Code' },
  state: 'draft', plan: [{ id: 's1', text: 'Wrap the client', by: { who: 'alice' }, state: 'todo' }], may: ['Edit src/payments/**'], mayNot: ['Merge'],
  askWhen: [], accept: [], runs: [], prs: [], context: [], version: 1, versions: [], exec: { where: 'a worktree', prs: 'per-step' }, log: [], ago: 'now',
  ...over,
});
const record = (works: Work[]): VoweRecord => ({ threads: [], decisions: [], work: works, notices: [], call: false, members: [], done: [], vowe: true, agents: [] });
const snapshot = (w: Work): Work => ({ ...w, versions: [{ version: w.version, by: ['alice'], ago: 'now', body: { objective: w.why, plan: w.plan, may: w.may, mayNot: w.mayNot, askWhen: w.askWhen, accept: w.accept } }] });

describe('plan operations', () => {
  it('opens the next draft when who does it or PR grouping changes after a snapshot', () => {
    const w = snapshot(work());
    assert.equal(applyOp(w, { op: 'doer', doer: { kind: 'person', name: 'Bob' } }, 'bob').version, 2);
    assert.equal(applyOp(w, { op: 'prs', prs: 'grouped' }, 'bob').version, 2);
    assert.deepEqual(applyOp(w, { op: 'doer', doer: { kind: 'agent', name: 'Claude Code' } }, 'bob'), {});
    assert.deepEqual(applyOp(w, { op: 'prs', prs: 'per-step' }, 'bob'), {});
  });

  it('never moves the version for step progress', () => {
    const w = snapshot(work());
    assert.equal(applyOp(w, { op: 'state', step: 's1', state: 'done' }, 'bob').version, undefined);
  });

  it('authorizes by freezing the version only: no runs, no invented state', () => {
    const w = work({ state: 'proposed' });
    const out = approve(record([w]), 'w1', 'alice').work!.find((x) => x.id === 'w1')!;
    assert.equal(out.state, 'authorized');
    assert.deepEqual(out.runs, []);
    assert.equal(out.versions[0]!.approved?.by, 'alice');
    assert.equal(out.versions[0]!.approved?.scope, 'src/payments/** · draft PRs');
    assert.equal(out.revision, undefined);
    const running = approve(record([work({ state: 'running' })]), 'w1', 'alice').work![0]!;
    assert.equal(running.state, 'running');
    assert.deepEqual(approve(record([work({ doer: null })]), 'w1', 'alice'), {});
  });

  it('promotes a step with the id it is given and neutral words', () => {
    const w = work({ revision: { id: 'r1', by: 'vowe', why: 'Audit first', base: 1, changes: [{ id: 'c1', kind: 'promote', step: 's1', title: 'Audit log', text: 'Log refunds', seed: { id: 'db-uuid', why: 'Compliance' }, state: 'open' }] } });
    const out = decide(record([w]), 'w1', 'c1', true, 'bob');
    const extra = out.work!.find((x) => x.id === 'db-uuid')!;
    assert.equal(extra.why, 'Compliance');
    assert.equal(extra.state, 'proposed');
    assert.equal(extra.blocks, 'w1');
    assert.match(extra.log[0]!.text, /^Split from Retries, step 1$/);
    assert.equal(out.work!.find((x) => x.id === 'w1')!.dependsOn, 'db-uuid');
    const noSeed = decide(record([work({ revision: { ...w.revision!, changes: [{ ...w.revision!.changes[0]!, seed: undefined }] } })]), 'w1', 'c1', true, 'bob');
    assert.ok(noSeed.work!.some((x) => x.id !== 'w1' && x.id.startsWith('w')));
  });

  it('words an authorization’s scope', () => {
    assert.equal(scopeOf({ may: ['Edit a/**', 'Run tests', 'Edit b.ts'] }), 'a/** · b.ts · draft PRs');
  });
});

describe('decision version ids', () => {
  it('round-trips and refuses anything else', () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    assert.equal(decisionVersionId(id, 1), id);
    assert.equal(decisionVersionId(id, 3), `${id}.v3`);
    assert.deepEqual(parseDecisionVersionId(`${id}.v3`), { decisionId: id, version: 3 });
    assert.deepEqual(parseDecisionVersionId(id), { decisionId: id, version: 1 });
    assert.equal(parseDecisionVersionId(`${id}:v3`), null);
    assert.equal(parseDecisionVersionId('d1'), null);
    assert.equal(parseDecisionVersionId(`${id}.v0`), null);
  });
});
