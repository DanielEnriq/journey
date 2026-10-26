import type { RoomResult } from '../../../shared/api.js';
import type { Decision, RecordEvent, VoweRecord, Work } from '../vowe-room/contracts/model.js';
import type { RoomPreview } from '../room/data/sources.js';
import { demoCanvas, workspace as demoWorkspace } from '../workspace/mock/workspace.js';
import { createInboxSource, type InboxController, type InboxDeps } from './records.js';

// The Inbox over the example workspace. The demo has no room records, so this builds the few things it
// really has into record shape (the payments decision waiting on your signature, the agents' questions,
// each room's example events) and runs the same derive over them. Signing and answering in Payment
// Reliability go to its scripted room; anything else says it's example data. Marks stay on this machine.

const ME = 'you';
const DEMO_DECISION = 'payments-decision';
const fail = <T>(message: string): RoomResult<T> => ({ ok: false, error: { code: 'invalid', message } });
const ok = <T>(value: T): RoomResult<T> => ({ ok: true, value });
const EXAMPLE = 'This is example data: open the room to do that.';
const personId = (name: string) => `demo:${name.toLowerCase().replace(/\s+/g, '-')}`;

function recordOf(roomId: string, p: RoomPreview): VoweRecord {
  const names = new Map<string, string>();
  const log: RecordEvent[] = [...p.since, ...p.recent].map((e) => {
    const by = !e.who ? null : e.who.tone === 'me' ? ME : personId(e.who.name);
    if (by && by !== ME) names.set(by, e.who!.name);
    return { id: e.id, by, kind: 'note', text: e.text, subject: null, version: null, at: e.at };
  }).sort((a, b) => (a.at < b.at ? 1 : -1));
  const decisions: Decision[] = [];
  const work: Work[] = [];
  const ctrl = roomId === 'payments' ? demoCanvas() : null;
  for (const a of p.attention) {
    if (a.id === 'sign' && ctrl) {
      const d = ctrl.store.state.dec;
      names.set('demo:john', 'John');
      decisions.push({
        id: d.v === 1 ? DEMO_DECISION : `${DEMO_DECISION}.v${d.v}`, title: a.detail?.split(': ')[1]?.replace(/\.\s.*$/, '') || a.text,
        state: 'review', version: d.v, lines: [], verify: d.verify.split(';').map((s) => s.trim()).filter(Boolean), alternatives: [], parts: [],
        approvers: [{ who: ME, signed: d.sig.daniel }, { who: 'demo:john', signed: d.sig.john }], by: { who: 'demo:john' }, ago: '',
      });
    } else if (a.streamId) {
      const agent = a.text.split(' is asking')[0] || 'The agent';
      work.push({
        id: a.streamId, title: a.text.replace(/^.* is asking about /, '').replace(/^./, (c: string) => c.toUpperCase()), why: '', repo: p.room.repo ?? '', parts: [],
        owner: ME, doer: { kind: 'agent', name: agent }, state: 'running', plan: [], may: [], mayNot: [], askWhen: [], accept: [], runs: [], prs: [], context: [],
        version: 1, versions: [], exec: { where: 'local', prs: 'per-step' }, log: [], ago: '',
        question: { id: `q:${a.id}`, text: a.detail ?? a.text, about: '', for: ME, options: [] },
      });
    }
  }
  return {
    threads: [], decisions, work, notices: [], call: p.room.inCall.length > 0, done: [], vowe: true, agents: [], me: ME,
    members: [{ who: ME, role: 'member', name: 'You' }, ...[...names].map(([who, name]) => ({ who, role: 'member' as const, name }))],
    times: {}, log,
  };
}

export function createDemoInbox(storage: InboxDeps['storage']): InboxController {
  const services: InboxDeps['services'] = {
    record: {
      async load(roomId) {
        try { return ok(recordOf(roomId, await demoWorkspace.room.preview(roomId))); } catch (err) { return fail((err as Error).message); }
      },
      subscribe(roomId, fn) {
        const offRoom = demoWorkspace.room.subscribe(fn);
        const ctrl = roomId === 'payments' ? demoCanvas() : null;
        const offCtrl = ctrl ? ctrl.store.subscribe(fn) : () => {};
        return () => { offRoom(); offCtrl(); };
      },
    },
    decisions: {
      async sign(roomId: string) {
        const ctrl = roomId === 'payments' ? demoCanvas() : null;
        if (!ctrl) return fail(EXAMPLE);
        ctrl.signDec();
        return ok(undefined);
      },
      async requestChanges() { return fail(EXAMPLE); },
    } as unknown as InboxDeps['services']['decisions'],
    work: {
      async answer(roomId: string, _workId: string, _q: string, text: string) {
        const ctrl = roomId === 'payments' ? demoCanvas() : null;
        if (!ctrl) return fail(EXAMPLE);
        ctrl.answer(text);
        return ok(undefined);
      },
      async authorize() { return fail(EXAMPLE); },
      async allowScope() { return fail(EXAMPLE); },
    } as unknown as InboxDeps['services']['work'],
    threads: { async reply() { return fail(EXAMPLE); } } as unknown as InboxDeps['services']['threads'],
    attention: { async markDone() { return ok(undefined); } } as unknown as InboxDeps['services']['attention'],
  };
  return createInboxSource({
    services,
    rooms: demoWorkspace.room,
    invites: null,
    me: () => ME,
    storage,
    // The example workspace has no record of runs, PRs or invitations to you.
    unavailable: ['runner', 'github'],
  });
}
