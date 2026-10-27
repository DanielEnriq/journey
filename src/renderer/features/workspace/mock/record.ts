import type { RoomResult } from '../../../../shared/api.js';
import { applyOp, approve, decide } from '../../../../shared/vowe/plan.js';
import { minutesBefore } from '../../../shared/time.js';
import { mockLog } from '../../../shared/mock.js';
import { AGENT, type Decision, type Line, type RecordEvent, type Thread, type VoweRecord, type Work } from '../../vowe-room/contracts/model.js';
import type { VoweServices } from '../../vowe-room/contracts/services.js';

// The demo rooms' records: the same VoweRecord a real room's Desk and the Inbox read, kept in this window's
// local storage instead of Supabase. The writes below are the services' contract done in memory (the plan
// edits reuse shared/vowe/plan.ts, as main does), so the demo runs through the real room and the real
// Inbox. Everyone but you is example data; every write logs a "[vowe mock]" line.

/** You, in every demo record. */
export const DEMO_ME = 'you';
const KEY = 'vowe.demo.records';

type Records = Record<string, VoweRecord>;

function read(): Records {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
}

let records: Records = read();
const listeners = new Set<(roomId: string) => void>();

function save(roomId: string) {
  try { localStorage.setItem(KEY, JSON.stringify(records)); } catch { /* storage may be full or off */ }
  listeners.forEach((fn) => fn(roomId));
}

/** A room's record changed (any room: the workspace's summaries follow them all). */
export function onRecords(fn: (roomId: string) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export const demoRecord = (roomId: string): VoweRecord | null => records[roomId] ?? null;

let n = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}${(n++).toString(36)}`;
const iso = () => new Date().toISOString();
const ok = <T>(value: T): RoomResult<T> => ({ ok: true, value });
const fail = <T>(code: 'not-found' | 'conflict' | 'invalid', message: string): RoomResult<T> => ({ ok: false, error: { code, message } });

/**
 * Runs one write on a room's record: `fn` returns the changed record (or a failure), and the activity
 * line it adds. Nothing is shared with anyone; the console says what was pretended.
 */
function write<T>(roomId: string, what: string, fn: (r: VoweRecord) => { r: VoweRecord; value: T; log?: Omit<RecordEvent, 'id' | 'at' | 'by'> & { by?: string | null } } | RoomResult<never>): RoomResult<T> {
  const r = records[roomId];
  if (!r) return fail('not-found', 'That room isn’t part of the demo');
  const out = fn(r);
  if ('ok' in out) return out;
  const at = iso();
  const log = out.log ? [{ id: uid('e'), at, by: DEMO_ME, ...out.log }, ...(out.r.log ?? [])] : out.r.log;
  records = { ...records, [roomId]: { ...out.r, log } };
  mockLog('record', `${what} in ${roomId} (kept in this window only)`);
  save(roomId);
  return ok(out.value);
}

const stamp = (r: VoweRecord, key: string): Record<string, string> => ({ ...r.times, [key]: iso() });
const withThread = (r: VoweRecord, id: string, f: (t: Thread) => Thread) => r.threads.map((t) => (t.id === id ? f(t) : t));
const withDecision = (r: VoweRecord, id: string, f: (d: Decision) => Decision) => r.decisions.map((d) => (d.id === id ? f(d) : d));
const withWork = (r: VoweRecord, id: string, f: (w: Work) => Work) => r.work.map((w) => (w.id === id ? f(w) : w));
const missing = (what: string) => fail<never>('not-found', `That ${what} isn’t in this room`);

/** A reply in a thread, as you or as the agent. Replying to a thread that waits on you answers it. */
export function demoReply(roomId: string, threadId: string, body: string, by: string = DEMO_ME): RoomResult<void> {
  return write(roomId, by === AGENT ? 'Vowe replied' : 'replied', (r) => {
    const t = r.threads.find((x) => x.id === threadId);
    if (!t) return missing('thread');
    const id = uid('r');
    return {
      r: { ...r, threads: withThread(r, threadId, (x) => ({ ...x, replies: [...x.replies, { id, by, body, ago: 'now' }], waiting: x.waiting === by ? undefined : x.waiting })), times: stamp(r, `${threadId}:${id}`) },
      value: undefined, log: { by, kind: 'reply', text: body, subject: threadId, version: null },
    };
  });
}

const signable = (d: Decision) => d.state === 'review';

export const demoVowe: VoweServices = {
  record: {
    async load(roomId) {
      const r = records[roomId];
      return r ? ok(r) : fail('not-found', 'That room isn’t part of the demo');
    },
    subscribe(roomId, fn) { return onRecords((id) => { if (id === roomId) fn(); }); },
  },
  threads: {
    async create(roomId, t) {
      return write(roomId, 'started a thread', (r) => {
        const id = uid('t');
        const thread: Thread = { id, about: t.about, replies: [{ id, by: DEMO_ME, body: t.body, ago: 'now' }], status: 'open', ...(t.quote ? { quote: t.quote } : {}), ...(t.at ? { at: t.at } : {}), ...(t.waiting ? { waiting: t.waiting } : {}) };
        return { r: { ...r, threads: [...r.threads, thread], times: stamp(r, id) }, value: { id }, log: { kind: 'thread', text: t.body, subject: id, version: null } };
      });
    },
    async reply(roomId, threadId, body) { return demoReply(roomId, threadId, body); },
    async resolve(roomId, threadId) {
      return write(roomId, 'resolved a thread', (r) => r.threads.some((t) => t.id === threadId)
        ? { r: { ...r, threads: withThread(r, threadId, (t) => ({ ...t, status: 'resolved' })) }, value: undefined, log: { kind: 'resolved', text: 'Resolved a thread', subject: threadId, version: null } }
        : missing('thread'));
    },
    async answerOffer(roomId, threadId, replyId, accept) {
      return write(roomId, accept ? 'accepted an offer' : 'dismissed an offer', (r) => ({
        r: { ...r, threads: withThread(r, threadId, (t) => ({ ...t, replies: t.replies.map((p) => (p.id === replyId && p.offer ? { ...p, offer: { ...p.offer, state: accept ? 'accepted' : 'dismissed', by: DEMO_ME } } : p)) })) },
        value: undefined,
      }));
    },
  },
  decisions: {
    async create(roomId, d) {
      return write(roomId, 'drafted a decision', (r) => {
        const id = uid('d');
        const lines: Line[] = d.line ? [{ id: uid('l'), kind: 'decide', text: d.line, by: { who: DEMO_ME, how: 'stated' } }] : [];
        const decision: Decision = {
          id, title: d.title, state: 'draft', version: 1, lines, verify: [], alternatives: [], approvers: [], parts: [], by: { who: DEMO_ME, how: 'stated' }, ago: 'now',
          ...(d.from ? { from: d.from } : {}), ...(d.problem ? { doc: { problem: { text: d.problem, by: { who: DEMO_ME, how: 'stated' } }, tradeoffs: [], consequences: [] } } : {}),
        };
        return { r: { ...r, decisions: [...r.decisions, decision], times: stamp(r, id) }, value: { id }, log: { kind: 'decision', text: d.title, subject: id, version: 1 } };
      });
    },
    async editLine(roomId, id, lineId, text) {
      return write(roomId, 'edited a decision line', (r) => {
        const d = r.decisions.find((x) => x.id === id);
        if (!d) return missing('decision');
        if (d.approvers.some((a) => a.signed === d.version)) return fail('conflict', 'This version has a signature: amend it instead');
        return { r: { ...r, decisions: withDecision(r, id, (x) => ({ ...x, lines: x.lines.map((l) => (l.id === lineId ? { ...l, was: l.text, text, by: { who: DEMO_ME, how: 'edited' } } : l)) })) }, value: undefined };
      });
    },
    async addLine(roomId, id, kind, text) {
      return write(roomId, 'added a decision line', (r) => {
        const d = r.decisions.find((x) => x.id === id);
        if (!d) return missing('decision');
        if (d.approvers.some((a) => a.signed === d.version)) return fail('conflict', 'This version has a signature: amend it instead');
        const lineId = uid('l');
        return { r: { ...r, decisions: withDecision(r, id, (x) => ({ ...x, lines: [...x.lines, { id: lineId, kind, text, by: { who: DEMO_ME, how: 'stated' } }] })) }, value: { id: lineId } };
      });
    },
    async editDoc(roomId, id, field, text) {
      return write(roomId, `edited the decision’s ${field}`, (r) => ({
        r: { ...r, decisions: withDecision(r, id, (d) => {
          const doc = d.doc ?? { problem: { text: '', by: { who: DEMO_ME } }, tradeoffs: [], consequences: [] };
          return { ...d, doc: { ...doc, [field]: { text, by: { who: DEMO_ME, how: 'edited' } } } };
        }) },
        value: undefined,
      }));
    },
    async takeSuggestion(roomId, id, lineId, accept) {
      return write(roomId, accept ? 'took a suggested edit' : 'rejected a suggested edit', (r) => ({
        r: { ...r, decisions: withDecision(r, id, (d) => ({ ...d, lines: d.lines.map((l) => {
          if (l.id !== lineId || !l.suggest) return l;
          const { suggest, ...rest } = l;
          return accept ? { ...rest, was: l.text, text: suggest.text, by: { who: suggest.by, how: 'edited' } } : rest;
        }) })) },
        value: undefined,
      }));
    },
    async requestSignatures(roomId, id, who) {
      return write(roomId, 'asked for signatures', (r) => {
        const d = r.decisions.find((x) => x.id === id);
        if (!d) return missing('decision');
        return {
          r: { ...r, decisions: withDecision(r, id, (x) => ({ ...x, state: 'review', approvers: who.map((p) => x.approvers.find((a) => a.who === p) ?? { who: p, signed: null }) })), times: stamp(r, `${id}:review`) },
          value: undefined, log: { kind: 'review', text: d.title, subject: id, version: d.version },
        };
      });
    },
    async sign(roomId, id, version) {
      return write(roomId, `signed v${version}`, (r) => {
        const d = r.decisions.find((x) => x.id === id);
        if (!d) return missing('decision');
        if (d.version !== version || !signable(d)) return fail('conflict', 'This version changed since you read it');
        const approvers = d.approvers.map((a) => (a.who === DEMO_ME ? { who: a.who, signed: version } : a));
        const agreed = approvers.every((a) => a.signed === version);
        let times = stamp(r, `${id}:signed:${DEMO_ME}`);
        if (agreed) times = { ...times, [`${id}:agreed`]: iso() };
        return {
          r: { ...r, decisions: withDecision(r, id, (x) => ({ ...x, approvers, state: agreed ? 'agreed' : x.state })), times },
          value: undefined, log: { kind: agreed ? 'agreed' : 'signed', text: d.title, subject: id, version },
        };
      });
    },
    async requestChanges(roomId, id, version, text) {
      return write(roomId, `asked for changes to v${version}`, (r) => ({
        r: { ...r, decisions: withDecision(r, id, (d) => ({ ...d, approvers: d.approvers.map((a) => (a.who === DEMO_ME ? { ...a, signed: null, changes: text } : a)) })) },
        value: undefined, log: { kind: 'changes', text, subject: id, version },
      }));
    },
    async amend(roomId, id) {
      return write(roomId, 'started the next version', (r) => {
        const d = r.decisions.find((x) => x.id === id);
        if (!d) return missing('decision');
        const next: Decision = { ...d, state: 'draft', version: d.version + 1, approvers: d.approvers.map((a) => ({ who: a.who, signed: null })), revises: { version: d.version, why: '' }, by: { who: DEMO_ME, how: 'edited' } };
        return { r: { ...r, decisions: withDecision(r, id, () => next) }, value: { id }, log: { kind: 'amended', text: d.title, subject: id, version: next.version } };
      });
    },
    async setSuggested(roomId, id, state) {
      return write(roomId, state === 'dismissed' ? 'dismissed a suggested decision' : 'kept a suggested decision', (r) => ({
        r: { ...r, decisions: withDecision(r, id, (d) => ({ ...d, state })) }, value: undefined,
      }));
    },
  },
  work: {
    async create(roomId, w) {
      return write(roomId, 'drafted a plan', (r) => {
        const id = uid('w');
        const work: Work = {
          id, title: w.title, why: w.objective, repo: '', parts: [], owner: DEMO_ME, doer: null, state: 'draft', plan: [], may: [], mayNot: [], askWhen: [], accept: [],
          runs: [], prs: [], context: [], version: 1, versions: [], exec: { where: 'local', prs: 'per-step' }, log: [{ who: DEMO_ME, text: 'Drafted the plan', ago: 'now' }], ago: 'now',
          ...(w.decision ? { decision: w.decision } : {}), ...(w.thread ? { thread: w.thread } : {}),
        };
        return { r: { ...r, work: [...r.work, work], times: stamp(r, id) }, value: { id }, log: { kind: 'work', text: w.title, subject: id, version: 1 } };
      });
    },
    async plan(roomId, workId, op, base) {
      return write(roomId, `edited a plan (${op.op})`, (r) => {
        const w = r.work.find((x) => x.id === workId);
        if (!w) return missing('plan');
        if (w.version !== base) return fail('conflict', 'Someone changed this plan since you read it');
        return { r: { ...r, work: withWork(r, workId, (x) => ({ ...x, ...applyOp(x, op, DEMO_ME) })), times: stamp(r, `${workId}:plan`) }, value: undefined };
      });
    },
    async decideChange(roomId, workId, changeId, accept) {
      return write(roomId, accept ? 'accepted a suggested change' : 'rejected a suggested change', (r) => ({ r: { ...r, ...decide(r, workId, changeId, accept, DEMO_ME) }, value: undefined }));
    },
    async authorize(roomId, workId, version) {
      return write(roomId, `authorized v${version} (nothing runs: the demo has no agent runner)`, (r) => {
        const w = r.work.find((x) => x.id === workId);
        if (!w) return missing('plan');
        if (!w.doer) return fail('invalid', 'Choose who does it first');
        return { r: { ...r, ...approve(r, workId, DEMO_ME), times: stamp(r, `${workId}:authorized`) }, value: undefined, log: { kind: 'authorized', text: w.title, subject: workId, version } };
      });
    },
    async allowScope(roomId, workId, allow) {
      return write(roomId, allow ? 'allowed a scope request' : 'refused a scope request', (r) => ({
        r: { ...r, work: withWork(r, workId, (w) => ({ ...w, may: allow && w.scopeAsk ? [...w.may, w.scopeAsk.adds] : w.may, scopeAsk: undefined })) }, value: undefined,
        log: { kind: 'scope', text: allow ? 'Allowed the request' : 'Refused the request', subject: workId, version: null },
      }));
    },
    async answer(roomId, workId, questionId, text) {
      return write(roomId, 'answered a question', (r) => {
        const w = r.work.find((x) => x.id === workId);
        if (!w?.question || w.question.id !== questionId) return missing('question');
        return {
          r: { ...r, work: withWork(r, workId, (x) => ({ ...x, state: x.state === 'waiting' ? 'running' : x.state, question: { ...x.question!, answer: { by: DEMO_ME, text } } })) },
          value: undefined, log: { kind: 'question', text, subject: workId, version: null },
        };
      });
    },
    async defer(roomId, workId, questionId) {
      return write(roomId, 'deferred a question', (r) => ({
        r: { ...r, work: withWork(r, workId, (w) => (w.question?.id === questionId ? { ...w, question: { ...w.question, deferred: true } } : w)) }, value: undefined,
      }));
    },
    async resolve(roomId, workId) {
      return write(roomId, 'resolved the work', (r) => ({
        r: { ...r, work: withWork(r, workId, (w) => ({ ...w, state: 'resolved', resolved: { by: DEMO_ME, ago: 'now' } })), times: stamp(r, `${workId}:resolved`) },
        value: undefined, log: { kind: 'resolved', text: 'Resolved the work', subject: workId, version: null },
      }));
    },
  },
  attention: {
    async markDone(roomId, ids) {
      const r = records[roomId];
      if (!r) return fail('not-found', 'That room isn’t part of the demo');
      records = { ...records, [roomId]: { ...r, done: [...new Set([...r.done, ...ids])] } };
      save(roomId);
      return ok(undefined);
    },
  },
  settings: {
    async agentName(roomId, name) {
      return write(roomId, `renamed the assistant to “${name || 'Vowe'}”`, (r) => ({ r: { ...r, agentName: name.trim() || undefined }, value: undefined }));
    },
  },
  runs: null, // the demo, like Journey, has no unattended agent runs
  github: null,
  notifications: null,
};

/* ---------- The example rooms' records. ---------- */

const NO_AGENT = [{ name: 'Claude Code', status: 'not-connected' as const, note: 'The demo has no coding agent connected: its work is example data.' }];

function base(members: VoweRecord['members'], extra: Partial<VoweRecord>): VoweRecord {
  return { threads: [], decisions: [], work: [], notices: [], call: false, members, done: [], vowe: true, agents: NO_AGENT, me: DEMO_ME, times: {}, log: [], ...extra };
}

const event = (id: string, at: string, by: string | null, kind: string, text: string, subject: string | null = null, version: number | null = null): RecordEvent => ({ id, at, by, kind, text, subject, version });

/** Payment Reliability and three rooms around it, with times counted back from `T`. */
export function seedRecords(T: number): void {
  const ago = (min: number) => minutesBefore(T, min);
  const by = (who: string) => ({ who, how: 'stated' as const });

  const payments = base([
    { who: DEMO_ME, role: 'member', name: 'You' }, { who: 'john', role: 'owner', name: 'John' }, { who: 'srikar', role: 'member', name: 'Srikar' },
  ], {
    goal: { text: 'Charge every customer exactly once, even when a worker crashes or two take the same job.', by: 'john' },
    decisions: [{
      id: 'pay-idem', title: 'Idempotent processing for concurrent workers', state: 'review', version: 2,
      lines: [
        { id: 'pl1', kind: 'decide', text: 'Every charge carries an attempt key derived from the retry job; the provider refuses a second charge with the same key.', by: by('john') },
        { id: 'pl2', kind: 'because', text: 'A worker that crashes after charging and before the ack lets the lease run out, and the job is charged again (job #4182).', by: by(DEMO_ME), basis: 'observed' },
        { id: 'pl3', kind: 'assume', text: 'The provider honours idempotency keys on charges for at least 24 hours.', by: { who: AGENT, how: 'inferred' }, basis: 'inferred' },
        { id: 'pl4', kind: 'open', text: 'Refunds: the provider doesn’t take a key on them yet.', by: by('srikar') },
      ],
      verify: ['Two workers take the same job: one charge', 'Worker crashes after the charge: one charge'],
      alternatives: [{ id: 'pa1', title: 'Lock the job while it’s charged', why: 'A lock doesn’t survive the lease running out mid-charge.', state: 'set-aside' }],
      approvers: [{ who: 'john', signed: 2 }, { who: DEMO_ME, signed: null }],
      parts: ['payment-worker', 'retry-queue', 'payment-provider'], by: by('john'), ago: '',
      revises: { version: 1, why: 'v1 locked the job; the Concurrency view showed the lock expiring with the lease.' },
      doc: {
        problem: { text: 'A retry can charge a card twice: the worker charges, crashes before it acknowledges the job, and the job comes back for another worker.', by: by(DEMO_ME) },
        tradeoffs: [{ text: 'One more column on every charge (the attempt key).', by: by('john') }],
        consequences: [{ text: 'Retries become safe to run in parallel.', by: { who: AGENT, how: 'inferred' } }],
      },
    }],
    threads: [
      {
        id: 'pt-worker', about: { kind: 'part', id: 'payment-worker', name: 'Payment Worker' }, status: 'open',
        replies: [
          { id: 'pt-worker', by: DEMO_ME, body: 'A crash after the charge redelivers the job.', ago: '' },
          { id: 'pt-worker-2', by: AGENT, body: 'Right: after 30 seconds the lease runs out and #4182 is visible again, so the next worker charges $48.00 a second time. The Failure flow view walks through it.', ago: '', points: ['payment-worker', 'retry-queue'] },
        ],
      },
      {
        id: 'pt-refunds', about: { kind: 'part', id: 'payment-provider', name: 'Payment Provider' }, status: 'open', waiting: DEMO_ME,
        replies: [{ id: 'pt-refunds', by: 'srikar', body: 'Does the provider honour keys on refunds too, or only on charges? If only charges, do refunds stay out of this change?', ago: '' }],
      },
    ],
    work: [{
      id: 'pay-backoff', title: 'Retry worker backoff', why: 'Back off retries so a provider outage doesn’t flood the queue.', repo: 'acme/payments', parts: ['payment-worker', 'retry-queue'],
      owner: 'john', doer: { kind: 'agent', name: 'Claude Code' }, state: 'running',
      plan: [
        { id: 'pb1', text: 'Add exponential backoff with jitter to the retry worker.', by: by('john'), state: 'done' },
        { id: 'pb2', text: 'Cap retries at 6 and send the rest to the dead-letter queue.', by: by('john'), state: 'doing' },
        { id: 'pb3', text: 'Test a provider outage: the queue stays under 1,000 jobs.', by: { who: AGENT, how: 'inferred' }, state: 'todo' },
      ],
      may: ['payments/retry/**'], mayNot: ['payments/ledger/**'], askWhen: ['A change touches how charges are made'], accept: ['Retry worker tests pass'],
      authorized: { by: 'john', ago: '', scope: 'payments/retry/**' }, runs: [], prs: [], context: [], version: 1,
      versions: [{ version: 1, by: ['john'], ago: '', approved: { by: 'john', ago: '', doer: 'Claude Code', scope: 'payments/retry/**' }, body: { objective: '', plan: [], may: [], mayNot: [], askWhen: [], accept: [] } }],
      exec: { where: 'local', prs: 'per-step' }, log: [{ who: 'john', text: 'Authorized Claude Code to run v1', ago: '' }], ago: '',
    }],
    times: {
      'pay-idem': ago(60), 'pay-idem:review': ago(6), 'pay-idem:signed:john': ago(4),
      'pt-worker': ago(26), 'pt-worker:pt-worker': ago(26), 'pt-worker:pt-worker-2': ago(25),
      'pt-refunds': ago(14), 'pt-refunds:pt-refunds': ago(14),
      'pay-backoff': ago(180), 'pay-backoff:plan': ago(180), 'pay-backoff:authorized': ago(170),
    },
    log: [
      event('pe1', ago(4), 'john', 'signed', 'Idempotent processing for concurrent workers', 'pay-idem', 2),
      event('pe2', ago(6), 'john', 'review', 'Idempotent processing for concurrent workers', 'pay-idem', 2),
      event('pe3', ago(14), 'srikar', 'thread', 'Does the provider honour keys on refunds too?', 'pt-refunds'),
      event('pe4', ago(25), AGENT, 'reply', 'After 30 seconds the lease runs out and #4182 is visible again.', 'pt-worker'),
      event('pe5', ago(26), DEMO_ME, 'thread', 'A crash after the charge redelivers the job.', 'pt-worker'),
      event('pe6', ago(170), 'john', 'authorized', 'Retry worker backoff', 'pay-backoff', 1),
    ],
  });
  payments.work[0].versions[0].body = { objective: payments.work[0].why, plan: payments.work[0].plan, may: payments.work[0].may, mayNot: payments.work[0].mayNot, askWhen: payments.work[0].askWhen, accept: payments.work[0].accept };

  const ledger = base([{ who: DEMO_ME, role: 'member', name: 'You' }, { who: 'john', role: 'owner', name: 'John' }], {
    goal: { text: 'Move the ledger to double-entry without downtime.', by: 'john' },
    decisions: [{
      id: 'led-batches', title: 'Backfill in batches behind a dual-write shim', state: 'agreed', version: 1,
      lines: [{ id: 'll1', kind: 'decide', text: 'Write to both ledgers, then backfill old entries in batches of 10,000.', by: by('john') }],
      verify: ['Totals match between the old and new ledger'], alternatives: [], approvers: [{ who: 'john', signed: 1 }, { who: DEMO_ME, signed: 1 }], parts: [], by: by('john'), ago: '',
    }],
    work: [{
      id: 'led-backfill', title: 'Backfill job', why: 'Every entry since 2024 is in the double-entry ledger, with totals that match.', repo: 'acme/ledger', parts: [],
      owner: 'john', doer: { kind: 'agent', name: 'Claude Code' }, state: 'waiting', decision: 'led-batches',
      plan: [
        { id: 'lb1', text: 'Copy entries in batches of 10,000, oldest first.', by: by('john'), state: 'done' },
        { id: 'lb2', text: 'Write reversed entries as their own lines.', by: by('john'), state: 'doing' },
        { id: 'lb3', text: 'Compare totals per account after each batch.', by: by('john'), state: 'todo' },
      ],
      may: ['ledger/backfill/**'], mayNot: ['ledger/write/**'], askWhen: ['An entry’s date or amount would change'], accept: ['Totals match between the old and new ledger'],
      authorized: { by: 'john', ago: '', scope: 'ledger/backfill/**' },
      question: { id: 'lq1', text: 'Should reversed entries keep their original timestamp, or take the time of the reversal?', about: 'Reversed entries', step: 'lb2', for: DEMO_ME, options: ['Keep the original timestamp', 'Use the time of the reversal'] },
      runs: [], prs: [], context: [], version: 1, versions: [], exec: { where: 'local', prs: 'per-step' }, log: [{ who: 'john', text: 'Authorized Claude Code to run v1', ago: '' }], ago: '',
    }],
    times: { 'led-batches': ago(60 * 26), 'led-batches:agreed': ago(60 * 25), 'led-backfill': ago(60 * 5), 'led-backfill:authorized': ago(60 * 5), 'led-backfill:question': ago(50) },
    log: [
      event('le1', ago(50), null, 'question', 'Claude Code asked how reversed entries should be dated.', 'led-backfill'),
      event('le2', ago(60 * 5), 'john', 'authorized', 'Backfill job', 'led-backfill', 1),
      event('le3', ago(60 * 25), DEMO_ME, 'agreed', 'Backfill in batches behind a dual-write shim', 'led-batches', 1),
    ],
  });

  const latency = base([{ who: DEMO_ME, role: 'member', name: 'You' }, { who: 'priya', role: 'owner', name: 'Priya' }], {
    goal: { text: 'Checkout p95 back under 400 ms.', by: 'priya' }, call: true,
    threads: [{
      id: 'lt-bisect', about: { kind: 'work', id: 'lat-bisect', name: 'p95 regression bisect' }, status: 'open',
      replies: [{ id: 'lt-bisect', by: 'priya', body: 'Codex narrowed it to 6 commits. Joining a call to read them together.', ago: '' }],
    }],
    work: [{
      id: 'lat-bisect', title: 'p95 regression bisect', why: 'Find the commit that pushed checkout p95 over 400 ms.', repo: 'acme/web', parts: [],
      owner: 'priya', doer: { kind: 'agent', name: 'Codex' }, state: 'running',
      plan: [{ id: 'ls1', text: 'Bisect between the last good and first bad release, running the checkout benchmark at each step.', by: by('priya'), state: 'doing' }],
      may: ['read only'], mayNot: ['push'], askWhen: [], accept: ['The first bad commit, with its benchmark'], authorized: { by: 'priya', ago: '', scope: 'read only' },
      runs: [], prs: [], context: [], version: 1, versions: [], exec: { where: 'local', prs: 'grouped' }, log: [], ago: '',
    }],
    times: { 'lt-bisect': ago(34), 'lt-bisect:lt-bisect': ago(34), 'lat-bisect': ago(60 * 3) },
    log: [
      event('la1', ago(2), 'priya', 'call-started', 'Priya started a call.'),
      event('la2', ago(34), 'priya', 'thread', 'Codex narrowed it to 6 commits.', 'lt-bisect'),
    ],
  });

  const webhooks = base([{ who: DEMO_ME, role: 'owner', name: 'You' }, { who: 'mei', role: 'member', name: 'Mei' }], {
    goal: { text: 'Every webhook we send is signed and verifiable.', by: 'mei' },
    decisions: [{
      id: 'wh-hmac', title: 'Sign webhooks with HMAC-SHA256', state: 'agreed', version: 1,
      lines: [{ id: 'wl1', kind: 'decide', text: 'Sign every payload with HMAC-SHA256 and a per-endpoint secret, in a Vowe-Signature header.', by: by('mei') }],
      verify: ['A tampered payload fails verification'], alternatives: [], approvers: [{ who: 'mei', signed: 1 }, { who: DEMO_ME, signed: 1 }], parts: [], by: by('mei'), ago: '',
    }],
    times: { 'wh-hmac': ago(60 * 50), 'wh-hmac:agreed': ago(60 * 48) },
    log: [event('we1', ago(60 * 48), 'mei', 'agreed', 'Sign webhooks with HMAC-SHA256', 'wh-hmac', 1)],
  });

  records = { payments, ledger, latency, webhooks };
  mockLog('record', 'seeded the example rooms’ records');
  Object.keys(records).forEach(save);
}

/** Forgets the example rooms' records. */
export function clearRecords(): void {
  const ids = Object.keys(records);
  records = {};
  ids.forEach(save);
}
