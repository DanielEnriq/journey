import { devFlags, wait } from '../../../shared/devflags.js';
import { mockLog } from '../../../shared/mock.js';
import { minutesBefore } from '../../../shared/time.js';
import type { Scenario } from '../../room/controller.js';
import type {
  CallDataSource, NewRoom, RoomDataSource, RoomEvent, RoomPreview, RoomSources, RoomWorkContext, RoomWorkstream, WorkCheck,
  WorkstreamDataSource,
} from '../../room/data/sources.js';
import { demoController, onDemoChange, peekDemo, resetDemo } from '../../room/demo.js';
import * as payments from '../../room/mock/payment-reliability.js';
import type { PersonRef, RoomSummary } from '../../room/types.js';
import { classify } from '../../work/status.js';

// The workspace as local mock data: the rooms you made (kept in localStorage, so they survive a
// restart), who is in each room's call, what happened there, and the coding work behind it. The demo
// scenario, loaded from the developer menu, adds four example rooms around Payment Reliability.
// Nothing here talks to a service; every pretend action logs a "[vowe mock]" line.

const KEY = 'vowe.workspace';

interface SavedRoom { id: string; name: string; goal: string; repo: string | null; createdAt: string }
interface Saved {
  /** The loaded demo scenario and when it was loaded; example times count back from then. */
  demo: { scenario: Scenario; at: number } | null;
  rooms: SavedRoom[];
  /** When you last left each room. */
  visits: Record<string, string>;
  /** What you did in each room: created it, started or left a call. */
  events: Record<string, RoomEvent[]>;
  /** Local workstreams you shared with the room. */
  shared: string[];
}

const EMPTY: Saved = { demo: null, rooms: [], visits: {}, events: {}, shared: [] };

function load(): Saved {
  try { return { ...EMPTY, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...EMPTY }; }
}

let saved = load();
/** The room whose call you are in; calls are never restored on relaunch. */
let inCallYou: string | null = null;
const callStarted: Record<string, number> = {};
const listeners = new Set<() => void>();

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch { /* storage may be unavailable */ }
}
function notify() { listeners.forEach((l) => l()); }
function commit(patch: Partial<Saved>) { saved = { ...saved, ...patch }; persist(); notify(); }
onDemoChange(notify);
// A flipped dev flag (slow or failing work context) shows on the next read.
devFlags.subscribe(notify);

const YOU: PersonRef = { name: 'You', initials: 'DE', tone: 'me' };
const JOHN: PersonRef = { name: 'John', initials: 'JM', tone: 'peer' };
const SRIKAR: PersonRef = { name: 'Srikar', initials: 'SR', tone: 'p2' };
const PRIYA: PersonRef = { name: 'Priya', initials: 'PK', tone: 'p3' };
const MEI: PersonRef = { name: 'Mei', initials: 'ML', tone: 'p2' };
const CLAUDE: PersonRef = { name: 'Claude Code', initials: 'CC', tone: 'p3' };

/** Example repositories the room picker offers; nothing is cloned or read. */
export const EXAMPLE_REPOS = ['acme/payments', 'acme/web', 'acme/ledger'];

const now = () => Date.now();
const iso = () => new Date().toISOString();
const ev = (id: string, at: string, text: string, who: PersonRef | null, tone?: RoomEvent['tone']): RoomEvent => ({ id, at, text, who, ...(tone ? { tone } : {}) });

/** The first time a demo state change was seen, so it keeps its time on later reads. */
const firstSeen = new Map<string, string>();
const seen = (key: string) => { if (!firstSeen.has(key)) firstSeen.set(key, iso()); return firstSeen.get(key)!; };

/* ---------- Payment Reliability: its call, its canvas and its story live in the demo controller. ---------- */

function paymentsSources(): RoomSources {
  return { room, call, work, canvas: payments.canvas, intent: payments.intent };
}

function paymentsCtrl() {
  const scenario = saved.demo?.scenario ?? 'live';
  return peekDemo() ?? demoController(paymentsSources(), scenario);
}

function paymentsState() {
  const s = paymentsCtrl().state, d = s.dec;
  const qOpen = s.handed && s.question === 'open';
  const needsSign = !s.handed && !d.amending && d.sig.daniel !== d.v;
  return { s, d, qOpen, needsSign };
}

function paymentsChecks(): WorkCheck[] {
  const { s, d } = paymentsState();
  return d.verify.split(';').map((t) => t.trim()).filter(Boolean).map((t) => {
    const timeout = t.includes('timeout');
    const result = timeout ? (s.p >= 4 ? 'pass' : s.p >= 3 ? 'running' : 'not-run') : (s.p >= 3 ? 'pass' : 'not-run');
    return { text: t[0].toUpperCase() + t.slice(1), result };
  });
}

function paymentsEvents(T: number, returning: boolean): RoomEvent[] {
  const { s, d, qOpen } = paymentsState();
  const list: RoomEvent[] = returning ? [
    ev('p-q', minutesBefore(T, 18), 'Claude Code asked the room about refunds, on the provider.', CLAUDE, 'needs'),
    ev('p-checks', minutesBefore(T, 35), '2 of 3 checks pass. Provider timeout is still running.', CLAUDE, 'pass'),
    ev('p-files', minutesBefore(T, 70), 'Claude Code changed 4 files in its own worktree.', CLAUDE),
    ev('p-v3', minutesBefore(T, 170), 'John signed decision v3; it went to Claude Code with all three checks.', JOHN),
  ] : [
    ev('p-sign', minutesBefore(T, 4), 'John signed decision v2: idempotent processing for concurrent workers.', JOHN),
    ev('p-view', minutesBefore(T, 12), 'Vowe drew the Failure flow from job #4182.', null),
    ev('p-note', minutesBefore(T, 26), 'You noted on the worker: a crash after the charge redelivers the job.', YOU),
    ev('p-retry', minutesBefore(T, 40), 'John shared the retry worker stream with the room.', JOHN),
  ];
  // What the room has done in the call since: the newest come first.
  if (s.composed) list.push(ev('p-tmo', seen('tmo'), 'Vowe drew Provider timeout.', null));
  if (s.srikar === 'present') list.push(ev('p-srikar', seen('srikar'), 'Srikar joined the call.', SRIKAR));
  if (!returning && d.sig.daniel === d.v) list.push(ev('p-you' + d.v, seen('sign' + d.v), `You signed decision v${d.v}.`, YOU));
  if (s.handed && !returning) list.push(ev('p-hand', seen('hand'), `Decision v${d.v} went to ${s.handedTo}.`, YOU));
  if (qOpen && !returning) list.push(ev('p-q2', seen('q'), `${s.handedTo} asked the room about refunds, on the provider.`, CLAUDE, 'needs'));
  if (s.question === 'answered') list.push(ev('p-ans', seen('ans'), `The room answered: ${s.qAnswer}`, YOU));
  if (s.handed && s.p >= 4) list.push(ev('p-pass', seen('pass'), 'All checks pass on the idempotency branch.', CLAUDE, 'pass'));
  return list;
}

function paymentsWork(T: number, returning: boolean): RoomWorkstream[] {
  const { s, d, qOpen } = paymentsState();
  const stages = payments.script.stages();
  const out: RoomWorkstream[] = [];
  if (s.handed) {
    const observed = stages.slice(0, s.p + 1).map((text, i) => ({ at: returning ? minutesBefore(T, 170 - i * 35) : seen('stage' + i), text })).reverse();
    if (qOpen) observed.unshift({ at: returning ? minutesBefore(T, 18) : seen('q'), text: 'Asked the room about refunds, and paused.' });
    const checks = paymentsChecks();
    const item = {
      id: 'idem', title: 'Idempotent processing', agent: s.handedTo, branch: payments.script.branch(), worktree: '~/code/acme-payments-idempotency',
      lastActivityAt: observed[0].at, lastActivity: observed[0].text, changedFiles: s.p >= 2 ? payments.script.files().length : 0, sessions: 1,
      visibility: 'room' as const, fromDecision: `v${d.v}`, checks, observed, files: s.p >= 2 ? payments.script.files() : [],
      ...(qOpen ? { question: 'The provider won’t take an idempotency key on refunds. Leave refunds out of this change, or check the ledger first?' } : {}),
    };
    out.push({ ...item, status: classify(item) });
  }
  const retry = returning ? {
    lastActivityAt: minutesBefore(T, 95), lastActivity: 'Ran worker.test.ts: 22 of 22 passed.',
    checks: [{ text: 'Retry worker tests', result: 'pass' as const }],
    observed: [{ at: minutesBefore(T, 95), text: 'Ran worker.test.ts: 22 of 22 passed.' }, { at: minutesBefore(T, 130), text: 'Edited payments/retry/worker.ts' }],
  } : {
    lastActivityAt: minutesBefore(T, 3), lastActivity: 'Ran worker.test.ts: 14 of 22 passed.',
    observed: [
      { at: minutesBefore(T, 3), text: 'Ran worker.test.ts: 14 of 22 passed.' }, { at: minutesBefore(T, 9), text: 'Edited payments/retry/worker.ts' },
      { at: minutesBefore(T, 21), text: 'Edited payments/retry/backoff.ts' }, { at: minutesBefore(T, 40), text: 'Session started in the retry-worker worktree.' },
    ],
  };
  const retryItem = { id: 'retry', title: 'Retry worker', agent: 'Claude Code', branch: 'payments/retry-worker', worktree: '~/code/acme-payments-retry', changedFiles: 3, sessions: 1, visibility: 'room' as const, ...retry };
  out.push({ ...retryItem, status: classify(retryItem) });
  const local = {
    id: 'pay-local', title: 'Exploring refund webhooks', agent: 'Claude Code', branch: 'main', worktree: '~/code/acme-payments', changedFiles: 0, sessions: 2,
    visibility: (saved.shared.includes('pay-local') ? 'room' : 'local') as 'room' | 'local',
    lastActivityAt: minutesBefore(T, 130), lastActivity: 'Read payments/refunds/handler.ts',
    observed: [{ at: minutesBefore(T, 130), text: 'Read payments/refunds/handler.ts' }, { at: minutesBefore(T, 142), text: 'Session started in your main worktree.' }],
  };
  out.push({ ...local, status: classify(local) });
  return out;
}

/* ---------- The other example rooms: no canvas, just their call, story and work. ---------- */

interface DemoRoom {
  id: string; name: string; repo: string | null; goal: { text: string; by: PersonRef };
  inCall(): PersonRef[]; events(T: number): RoomEvent[]; work(T: number): RoomWorkstream[]; needs(): string | null;
}

function stream(s: Omit<RoomWorkstream, 'status'>): RoomWorkstream { return { ...s, status: classify(s) }; }

const OTHER_ROOMS: DemoRoom[] = [
  {
    id: 'latency', name: 'Checkout latency', repo: 'acme/web', goal: { text: 'Checkout p95 back under 400 ms.', by: PRIYA },
    inCall: () => [PRIYA], needs: () => null,
    events: (T) => [
      ev('l-call', minutesBefore(T, 2), 'Priya started a call.', PRIYA),
      ev('l-bisect', minutesBefore(T, 34), 'Codex narrowed the regression to 6 commits.', null),
      ev('l-goal', minutesBefore(T, 60 * 26), 'Priya set the goal: checkout p95 back under 400 ms.', PRIYA),
    ],
    work: (T) => [stream({
      id: 'bisect', title: 'p95 regression bisect', agent: 'Codex', branch: 'perf/p95-bisect', worktree: '~/code/acme-web-bisect', changedFiles: 0, sessions: 1, visibility: 'room',
      lastActivityAt: minutesBefore(T, 1), lastActivity: 'Ran the checkout benchmark at a3f9c12.',
      observed: [{ at: minutesBefore(T, 1), text: 'Ran the checkout benchmark at a3f9c12.' }, { at: minutesBefore(T, 34), text: 'Narrowed the range to 6 commits.' }],
    })],
  },
  {
    id: 'ledger', name: 'Ledger migration', repo: 'acme/ledger', goal: { text: 'Move the ledger to double-entry without downtime.', by: JOHN },
    inCall: () => [], needs: () => 'Claude Code has a schema question',
    events: (T) => [
      ev('g-q', minutesBefore(T, 50), 'Claude Code asked how reversed entries should be dated.', CLAUDE, 'needs'),
      ev('g-hand', minutesBefore(T, 60 * 5), 'John handed the backfill to Claude Code.', JOHN),
      ev('g-call', minutesBefore(T, 60 * 6), 'Call ended · John and you, 40 min.', null),
    ],
    work: (T) => [
      stream({
        id: 'backfill', title: 'Backfill job', agent: 'Claude Code', branch: 'ledger/backfill', worktree: '~/code/acme-ledger-backfill', changedFiles: 5, sessions: 1, visibility: 'room',
        fromDecision: 'v1', question: 'Should reversed entries keep their original timestamp, or take the time of the reversal?',
        lastActivityAt: minutesBefore(T, 50), lastActivity: 'Asked the room a question, and paused.',
        observed: [{ at: minutesBefore(T, 50), text: 'Asked the room a question, and paused.' }, { at: minutesBefore(T, 75), text: 'Edited ledger/backfill/entries.ts' }],
      }),
      stream({
        id: 'dual-write', title: 'Dual-write shim', agent: 'Claude Code', branch: 'ledger/dual-write', worktree: '~/code/acme-ledger',
        changedFiles: 2, sessions: 1, visibility: saved.shared.includes('dual-write') ? 'room' : 'local',
        lastActivityAt: minutesBefore(T, 60 * 5), lastActivity: 'Edited ledger/write/shim.ts',
        observed: [{ at: minutesBefore(T, 60 * 5), text: 'Edited ledger/write/shim.ts' }],
      }),
    ],
  },
  {
    id: 'webhooks', name: 'Webhook signing', repo: null, goal: { text: 'Every webhook we send is signed and verifiable.', by: MEI },
    inCall: () => [], needs: () => null,
    events: (T) => [ev('w-dec', minutesBefore(T, 60 * 48), 'Mei and you agreed decision v1: sign with HMAC-SHA256.', MEI)],
    work: () => [],
  },
];

/* ---------- Rooms. ---------- */

function demoRoomsAt() {
  const d = saved.demo;
  return d ? { T: d.at, returning: d.scenario === 'returning' } : null;
}

function withYou(id: string, others: PersonRef[]) { return inCallYou === id ? [YOU, ...others] : others; }

function ownEvents(id: string) { return saved.events[id] || []; }

function summaryOf(id: string): RoomSummary | null {
  const demo = demoRoomsAt();
  if (demo && id === 'payments') {
    const { s, d, qOpen, needsSign } = paymentsState();
    const others = demo.returning ? [] : [JOHN, ...(s.srikar === 'present' ? [SRIKAR] : [])];
    const events = paymentsEvents(demo.T, demo.returning).concat(ownEvents(id)).sort(byNewest);
    return {
      id, name: 'Payment Reliability', repo: 'acme/payments', inCall: withYou(id, others), demo: 'payments',
      needs: qOpen ? `${s.handedTo} has a question about refunds` : needsSign && !demo.returning ? `Decision v${d.v} needs your signature` : null,
      activity: events[0]?.text ?? '', activityAt: events[0]?.at ?? null,
    };
  }
  const other = demo ? OTHER_ROOMS.find((r) => r.id === id) : null;
  if (other && demo) {
    const events = other.events(demo.T).concat(ownEvents(id)).sort(byNewest);
    return { id, name: other.name, repo: other.repo, inCall: withYou(id, other.inCall()), needs: other.needs(), activity: events[0]?.text ?? '', activityAt: events[0]?.at ?? null };
  }
  const mine = saved.rooms.find((r) => r.id === id);
  if (!mine) return null;
  const events = ownEvents(id);
  return { id, name: mine.name, repo: mine.repo, inCall: withYou(id, []), needs: null, activity: events[0]?.text ?? 'You created this room.', activityAt: events[0]?.at ?? mine.createdAt };
}

const byNewest = (a: RoomEvent, b: RoomEvent) => Date.parse(b.at) - Date.parse(a.at);

function record(roomId: string, text: string) {
  const list = [ev('e' + now(), iso(), text, YOU)].concat(ownEvents(roomId)).slice(0, 20);
  commit({ events: { ...saved.events, [roomId]: list } });
}

const room: RoomDataSource = {
  list() {
    const ids = saved.rooms.slice().reverse().map((r) => r.id).concat(saved.demo ? ['payments', ...OTHER_ROOMS.map((r) => r.id)] : []);
    return ids.map(summaryOf).filter((r): r is RoomSummary => !!r);
  },
  subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  create({ name, goal, repo }) {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'room';
    const id = `${base}-${now().toString(36).slice(-4)}`;
    mockLog('room', `created room "${name}" (stored in localStorage, not shared with anyone)`, { goal, repo });
    saved = { ...saved, rooms: saved.rooms.concat([{ id, name, goal, repo, createdAt: iso() }]) };
    record(id, 'You created this room.');
    return summaryOf(id)!;
  },
  async preview(id) {
    const summary = summaryOf(id);
    if (!summary) throw new Error(`No room ${id}`);
    const demo = demoRoomsAt(), last = saved.visits[id];
    let goal: RoomPreview['goal'] = null, events: RoomEvent[] = ownEvents(id), lastView: RoomPreview['lastView'] = null;
    const attention: RoomPreview['attention'] = [];
    if (demo && id === 'payments') {
      const ctrl = paymentsCtrl(), { s, d, qOpen, needsSign } = paymentsState(), def = ctrl.viewDef();
      goal = { text: payments.intent.goal().text, by: JOHN };
      events = paymentsEvents(demo.T, demo.returning).concat(events);
      const view = ctrl.curView(), opening = view === 'failure';
      lastView = {
        name: def.name, question: def.question, by: opening ? JOHN : YOU,
        at: demo.returning ? minutesBefore(demo.T, 170) : opening ? minutesBefore(demo.T, 12) : seen('view:' + view),
      };
      if (needsSign && !demo.returning) attention.push({ id: 'sign', text: `Decision v${d.v} needs your signature`, detail: 'John signed it: use idempotent processing for concurrent worker execution. Sign it in the call, where the room can see the checks.' });
      if (qOpen) attention.push({ id: 'q', text: `${s.handedTo} is asking about refunds`, detail: 'It paused on the provider: refunds don’t take an idempotency key. The room decides whether they stay out of this change.', streamId: 'idem' });
    } else if (demo && OTHER_ROOMS.some((r) => r.id === id)) {
      const other = OTHER_ROOMS.find((r) => r.id === id)!;
      goal = other.goal;
      events = other.events(demo.T).concat(events);
      for (const w of other.work(demo.T)) if (w.question) attention.push({ id: w.id, text: `${w.agent} is asking about ${w.title.toLowerCase()}`, detail: w.question, streamId: w.id });
    } else {
      const mine = saved.rooms.find((r) => r.id === id);
      if (mine?.goal) goal = { text: mine.goal, by: YOU };
    }
    events.sort(byNewest);
    const since = last ? events.filter((e) => e.who?.tone !== 'me' && Date.parse(e.at) > Date.parse(last)) : [];
    return { room: summary, goal, since, recent: events.filter((e) => !since.includes(e)).slice(0, 5), attention, lastView };
  },
  visited(id) {
    saved = { ...saved, visits: { ...saved.visits, [id]: iso() } };
    persist();
  },
  people: payments.people,
  invite: payments.invite,
};

/* ---------- Calls: temporary, joined on purpose, always muted at first. ---------- */

const call: CallDataSource = {
  async join(roomId) {
    const f = devFlags.state;
    mockLog('call', `join ${roomId}: no audio connects; you join muted${f.slowCall ? ' (slow connection, dev flag)' : ''}`);
    if (f.slowCall) await wait(1600);
    if (f.failCall) throw new Error('Couldn’t reach the call. Nothing was joined.');
    const started = !summaryOf(roomId)?.inCall.length;
    inCallYou = roomId;
    if (started) { callStarted[roomId] = now(); record(roomId, 'You started a call.'); } else notify();
  },
  async leave(roomId) {
    mockLog('call', `left the call in ${roomId}`);
    if (devFlags.state.slowCall) await wait(900);
    inCallYou = null;
    const others = summaryOf(roomId)?.inCall.length ?? 0;
    const min = callStarted[roomId] ? Math.max(1, Math.round((now() - callStarted[roomId]) / 60_000)) : 0;
    delete callStarted[roomId];
    if (others) record(roomId, 'You left the call.');
    else record(roomId, min ? `Call ended · ${min} min.` : 'Call ended.');
  },
  setMuted: (muted) => mockLog('call', muted ? 'microphone muted' : 'microphone on (simulated: nothing is recorded)'),
  setCaptions: (on) => mockLog('call', on ? 'captions on' : 'captions off'),
};

/* ---------- Work context. ---------- */

const work: WorkstreamDataSource = {
  async context(roomId) {
    const f = devFlags.state;
    if (f.slowWork) await wait(1800);
    if (f.failWork) throw new Error('Work context unavailable (dev flag)');
    const summary = summaryOf(roomId), demo = demoRoomsAt();
    let workstreams: RoomWorkstream[] = [];
    if (demo && roomId === 'payments') workstreams = paymentsWork(demo.T, demo.returning);
    else if (demo) workstreams = OTHER_ROOMS.find((r) => r.id === roomId)?.work(demo.T) ?? [];
    mockLog('work', `context for ${roomId}: ${workstreams.length} example workstreams; no repository, worktree or session was read`);
    const ctx: RoomWorkContext = { repo: summary?.repo ?? null, generatedAt: iso(), workstreams: summary?.repo ? workstreams : [] };
    return ctx;
  },
  async share(roomId, streamId) {
    mockLog('work', `shared ${streamId} with ${roomId} (local only: no one else sees it)`);
    if (!saved.shared.includes(streamId)) commit({ shared: saved.shared.concat([streamId]) });
  },
  ...payments.script,
};

/* ---------- What the app and the developer menu use. ---------- */

export const workspace = { room, call, work };

/** The canvas sources for a room's call; only Payment Reliability has a scripted canvas. */
export function callSources(roomId: string): RoomSources | null {
  return saved.demo && roomId === 'payments' ? paymentsSources() : null;
}

export function demoCanvas() {
  return saved.demo ? paymentsCtrl() : null;
}

export const demoScenario = () => saved.demo?.scenario ?? null;

/** Loads the example rooms; "returning" moves your last visit to before what happened since. */
export function loadDemo(scenario: Scenario) {
  mockLog('workspace', `loaded the Payment Reliability demo (${scenario})`);
  resetDemo();
  firstSeen.clear();
  inCallYou = null;
  const at = now();
  const visits = { ...saved.visits };
  OTHER_ROOMS.concat([{ id: 'payments' } as DemoRoom]).forEach((r) => { delete visits[r.id]; });
  if (scenario === 'returning') { visits.payments = minutesBefore(at, 240); visits.ledger = minutesBefore(at, 60 * 4); }
  const events = { ...saved.events };
  ['payments', ...OTHER_ROOMS.map((r) => r.id)].forEach((id) => { delete events[id]; });
  commit({ demo: { scenario, at }, visits, events, shared: [] });
  paymentsCtrl();
}

export function clearDemo() {
  resetDemo();
  inCallYou = null;
  commit({ demo: null });
}

export function resetWorkspace() {
  resetDemo();
  inCallYou = null;
  saved = { ...EMPTY };
  persist();
  notify();
}
