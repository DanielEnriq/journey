import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RoomResult } from '../../../../shared/api.js';
import type { RoomAccess } from '../../membership/model.js';
import { Store } from '../../../shared/store.js';
import type { VoweRecord, Work } from '../contracts/model.js';
import type { VoweServices } from '../contracts/services.js';
import { names } from '../state/directory.js';
import { makeUi } from '../state/ui.js';
import { createDeskActions } from './actions.js';
import { directoryOf, EMPTY_RECORD, mentionsAgent } from './people.js';

// The real room's host: who the Desk can name, when Vowe is asked into a thread, and how the Desk's actions
// treat the services' answers (optimistic plan edits that roll back, nothing that pretends to run).

const ok = <T>(value: T): Promise<RoomResult<T>> => Promise.resolve({ ok: true, value });
const fails = (code: 'conflict' | 'not-configured' | 'permission-denied'): Promise<RoomResult<never>> => Promise.resolve({ ok: false, error: { code, message: '' } });
const tick = () => new Promise((r) => setTimeout(r, 0));

function work(over: Partial<Work> = {}): Work {
  return {
    id: 'w1', title: 'Retry payouts', why: 'Payouts retry safely', repo: 'acme/pay', parts: [], owner: 'me', doer: { kind: 'agent', name: 'Claude Code' },
    state: 'draft', plan: [{ id: 's1', text: 'Add an idempotency key.', by: { who: 'me' }, state: 'todo' }], may: [], mayNot: [], askWhen: [], accept: [],
    runs: [], prs: [], context: [], version: 1, versions: [], exec: { where: 'local', prs: 'per-step' }, log: [], ago: 'now', ...over,
  };
}

function services(over: { plan?: VoweServices['work']['plan']; authorize?: VoweServices['work']['authorize'] } = {}, rec: () => VoweRecord = () => EMPTY_RECORD) {
  const calls: string[] = [];
  const s: VoweServices = {
    record: { load: async () => { calls.push('load'); return ok(rec()); }, subscribe: () => () => {} },
    threads: { create: () => ok({ id: 't1' }), reply: () => ok(undefined), resolve: () => ok(undefined), answerOffer: () => ok(undefined) },
    decisions: {
      create: () => ok({ id: 'd1' }), editLine: () => ok(undefined), addLine: () => ok({ id: 'l1' }), editDoc: () => ok(undefined), takeSuggestion: () => ok(undefined), requestSignatures: () => ok(undefined),
      sign: () => ok(undefined), requestChanges: () => ok(undefined), amend: () => ok({ id: 'd2' }), setSuggested: () => ok(undefined),
    },
    work: {
      create: () => ok({ id: 'w2' }), plan: over.plan ?? (() => ok(undefined)), decideChange: () => ok(undefined), authorize: over.authorize ?? (() => ok(undefined)),
      allowScope: () => ok(undefined), answer: () => ok(undefined), defer: () => ok(undefined), resolve: () => ok(undefined),
    },
    attention: { markDone: () => ok(undefined) },
    settings: null, runs: null, github: null, notifications: null,
  };
  return { s, calls };
}

function host(s: VoweServices, rec: VoweRecord, opened: string[] = []) {
  const ui = makeUi();
  const record = new Store<VoweRecord>(rec);
  const act = createDeskActions({
    roomId: 'r1', ui, record, services: s, names: names({ me: 'me', people: {}, agentName: 'Vowe' }), light: () => {},
    invite: () => {}, openExternal: (url) => opened.push(url), selection: () => null,
  });
  return { ui, record, act };
}

describe('directory', () => {
  const access = { users: { me: { id: 'me', name: 'Dana', email: 'd@x', initials: 'DA', tone: 'me' }, u2: { id: 'u2', name: 'Lee', email: 'l@x', initials: 'LE', tone: 'peer4' } } } as unknown as RoomAccess;
  it('names members and the agent by its workspace name', () => {
    const d = directoryOf('me', access, 'Kit');
    assert.equal(d.people.me.tone, 'me');
    assert.equal(d.people.u2.tone, 'peer3');
    assert.equal(d.people.vowe.kind, 'agent');
    assert.equal(names(d).nameOf('vowe'), 'Kit');
  });
  it('falls back to Vowe when the name is blank or missing', () => {
    assert.equal(directoryOf('me', null, '  ').agentName, 'Vowe');
    assert.equal(directoryOf('me', null, undefined).agentName, 'Vowe');
  });
});

describe('mentions', () => {
  it('asks the agent in by its current name or as Vowe', () => {
    assert.ok(mentionsAgent('@Kit can you check this?', 'Kit'));
    assert.ok(mentionsAgent('what do you think (@vowe)', 'Kit'));
    assert.ok(!mentionsAgent('mail ops@vowe.dev about it', 'Vowe'));
    assert.ok(!mentionsAgent('Vowe could help', 'Vowe'));
    assert.ok(mentionsAgent('@C++ helper?', 'C++'));
  });
});

describe('desk actions', () => {
  it('applies a plan edit at once and rolls it back on a conflict, then re-reads', async () => {
    const rec = { ...EMPTY_RECORD, work: [work()] };
    const { s, calls } = services({ plan: () => fails('conflict') }, () => rec);
    const h = host(s, rec);
    h.act.editStep('w1', 's1', 'Add an idempotency key per payout.');
    assert.equal(h.record.state.work[0].plan[0].text, 'Add an idempotency key per payout.');
    await tick(); await tick();
    assert.equal(h.record.state.work[0].plan[0].text, 'Add an idempotency key.');
    assert.match(h.ui.state.toast!.text, /Someone changed this/);
    assert.ok(calls.includes('load'));
  });

  it('authorizes the version it read and says nothing runs without a runner', async () => {
    const rec = { ...EMPTY_RECORD, work: [work({ version: 3 })] };
    let asked = 0;
    const { s } = services({ authorize: (_r, _w, v) => { asked = v; return ok(undefined); } }, () => rec);
    const h = host(s, rec);
    h.act.authorize('w1');
    await tick(); await tick();
    assert.equal(asked, 3);
    assert.match(h.ui.state.toast!.text, /Nothing runs by itself/);
  });

  it('opens only https links', () => {
    const opened: string[] = [];
    const h = host(services().s, EMPTY_RECORD, opened);
    h.act.openExternal('http://example.com');
    h.act.openExternal('javascript:alert(1)');
    h.act.openExternal('https://github.com/acme/pay/pull/4');
    assert.deepEqual(opened, ['https://github.com/acme/pay/pull/4']);
  });

  it('says renaming the assistant is unavailable without a settings service', () => {
    const h = host(services().s, EMPTY_RECORD);
    h.act.renameAgent('Kit');
    assert.match(h.ui.state.toast!.text, /isn’t available/);
  });
});
