import { devFlags, wait } from '../../../shared/devflags.js';
import { mockLog } from '../../../shared/mock.js';
import { minutesBefore } from '../../../shared/time.js';
import { account, initials } from '../../../shared/account.js';
import type {
  CallDataSource, LocalRepo, RepoChoice, EventKind, RoomDataSource, RoomEvent, RoomPreview, RoomWorkContext, RoomWorkstream, WorkstreamDataSource,
} from '../../room/data/sources.js';
import { workMark } from '../../room/data/sources.js';
import type { PersonRef, RoomSummary, SpaceSummary } from '../../room/types.js';
import { AGENT, type RecordEvent, type VoweRecord } from '../../vowe-room/contracts/model.js';
import { classify } from '../../work/status.js';
import { clearCanvases, demoScene, seedCanvases } from './canvas.js';
import { clearRecords, DEMO_ME, demoRecord, onRecords, seedRecords } from './record.js';

// The demo workspace, as local mock data: the rooms made in the demo (kept in localStorage, so they
// survive a restart), who is in each room's call, what happened there, and the coding work behind it.
// Loading the demo from the developer menu adds four example rooms around Payment Reliability, each with
// a record (./record.ts) and a canvas (./canvas.ts) that the real room and the real Inbox read.
// Only the demo routes (#/demo/…) and the browser preview use it; the app's own rooms never do.
// Nothing here talks to a service; every pretend action logs a "[vowe mock]" line.

const KEY = 'vowe.workspace';

interface SavedRoom { id: string; name: string; goal: string; repo: string | null; createdAt: string; spaceId?: string; keptAt?: string | null }
interface SavedSpace { id: string; name: string; repos: string[]; createdAt: string }
interface Saved {
  /** When the demo was loaded; example times count back from then. */
  demo: { at: number } | null;
  rooms: SavedRoom[];
  /** When you last left each room. */
  visits: Record<string, string>;
  /** What you did in each room: created it, started or left a call. */
  events: Record<string, RoomEvent[]>;
  /** Local workstreams you shared with the room. */
  shared: string[];
  /** Spaces you made in the demo, and the example rooms you kept or let go quick. */
  spaces: SavedSpace[];
  kept: Record<string, string | null>;
}

const EMPTY: Saved = { demo: null, rooms: [], visits: {}, events: {}, shared: [], spaces: [], kept: {} };

/** Calls you started, left or ended, saved before events said so: marked, so they stay out of a room's summary. */
const CALL_TEXT = /^(You started a call|You left the call|Call ended)\b/;

function load(): Saved {
  let out: Saved;
  try { out = { ...EMPTY, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...EMPTY }; }
  for (const id in out.events) out.events[id] = out.events[id].map((e) => (!e.presence && CALL_TEXT.test(e.text) ? { ...e, presence: true as const } : e));
  return out;
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
// A write to a room's record changes its summary (what needs you, its last activity).
onRecords(notify);
// A flipped dev flag (slow or failing work context) shows on the next read.
devFlags.subscribe(notify);

/** You, by the signed-in account's initials; the demo's cast plays everyone else. */
const you = (): PersonRef => ({ name: 'You', initials: initials(account.state.user?.name || account.state.user?.email || 'You'), tone: 'me' });
const CAST: Record<string, PersonRef> = {
  john: { name: 'John', initials: 'JM', tone: 'peer' },
  srikar: { name: 'Srikar', initials: 'SR', tone: 'p2' },
  priya: { name: 'Priya', initials: 'PK', tone: 'p3' },
  mei: { name: 'Mei', initials: 'ML', tone: 'p2' },
};
const personRef = (who: string | null): PersonRef | null => (!who || who === AGENT ? null : who === DEMO_ME ? you() : CAST[who] ?? null);
const nameOf = (who: string | null) => (who === DEMO_ME ? 'You' : who === AGENT ? 'Vowe' : who ? CAST[who]?.name ?? 'Someone' : '');

/** Example repositories the demo's room picker offers; nothing is cloned or read. */
export const EXAMPLE_REPOS: RepoChoice[] = ['acme/payments', 'acme/web', 'acme/ledger'].map((r) => ({ id: r, label: r }));

/** What the demo's "On this Mac" lists: the examples, two more, and a folder with no remote to share. */
const EXAMPLE_LOCAL: LocalRepo[] = [
  ...['payments', 'web', 'ledger', 'infra', 'design-system'].map((n) => ({ id: `acme/${n}`, label: n, identity: `github.com/acme/${n}` })),
  { id: 'scratch', label: 'scratch', identity: null },
];

/** The example Spaces, shown once the demo is loaded; your own come after them. */
const DEMO_SPACES: SavedSpace[] = [
  { id: 'demo-payments', name: 'Payments', repos: ['github.com/acme/payments', 'github.com/acme/ledger'], createdAt: '' },
  { id: 'demo-storefront', name: 'Storefront', repos: ['github.com/acme/web'], createdAt: '' },
];
const DEMO_ROOM_SPACE: Record<string, string> = { payments: 'demo-payments', ledger: 'demo-payments', webhooks: 'demo-payments', latency: 'demo-storefront' };

/** Quick example rooms: one from this afternoon, one gone quiet two days ago (it shows under Earlier). */
const DEMO_QUICK = [
  { id: 'flaky', name: 'Why is the retry test flaky?', spaceId: 'demo-payments', repo: 'acme/payments', minutes: 95, activity: 'Priya pointed at the clock in retry_test.go.' },
  { id: 'refunds', name: 'Refund path walk-through', spaceId: 'demo-payments', repo: 'acme/ledger', minutes: 60 * 50, activity: 'You traced refunds through the ledger.' },
  { id: 'fonts', name: 'Font loading on checkout', spaceId: 'demo-storefront', repo: 'acme/web', minutes: 60 * 30, activity: 'Mo compared the two preload strategies.' },
];

/** Your own rooms with no Space go in this one, made when the first is. */
const PERSONAL = 'demo-personal';

const now = () => Date.now();
const iso = () => new Date().toISOString();
const ev = (id: string, at: string, text: string, who: PersonRef | null, tone?: RoomEvent['tone'], presence?: boolean, kind?: EventKind): RoomEvent => ({ id, at, text, who, ...(kind ? { kind } : {}), ...(tone ? { tone } : {}), ...(presence ? { presence: true as const } : {}) });
/** What last changed in a room, for its one-line summary: comings and goings in its call don't count. */
const changed = (events: RoomEvent[]) => events.find((e) => !e.presence)?.text ?? '';
const byNewest = (a: RoomEvent, b: RoomEvent) => Date.parse(b.at) - Date.parse(a.at);

/* ---------- The example rooms: what they are, and the coding work behind them. ---------- */

interface DemoRoom { id: string; name: string; repo: string | null; inCall(): PersonRef[]; work(T: number): RoomWorkstream[] }

function stream(s: Omit<RoomWorkstream, 'status'>): RoomWorkstream { return { ...s, status: classify(s) }; }
const visibility = (id: string) => (saved.shared.includes(id) ? 'room' : 'local') as 'room' | 'local';

const DEMO_ROOMS: DemoRoom[] = [
  {
    id: 'payments', name: 'Payment Reliability', repo: 'acme/payments', inCall: () => [],
    work: (T) => [
      stream({
        id: 'retry', title: 'Retry worker backoff', agent: 'Claude Code', branch: 'payments/retry-worker', worktree: '~/code/acme-payments-retry', changedFiles: 3, sessions: 1, visibility: 'room',
        lastActivityAt: minutesBefore(T, 3), lastActivity: 'Ran worker.test.ts: 14 passed.',
        checks: [{ text: 'worker.test.ts', result: 'pass' }, { text: 'backoff.test.ts', result: 'pass' }, { text: 'Typecheck', result: 'pass' }, { text: 'Lint', result: 'running' }],
        files: [{ path: 'payments/retry/worker.ts', a: '88', d: '21' }, { path: 'payments/retry/backoff.ts', a: '46', d: '17' }, { path: 'payments/retry/worker.test.ts', a: '8', d: '0' }],
        observed: [
          { at: minutesBefore(T, 3), text: 'Ran worker.test.ts: 14 passed.' }, { at: minutesBefore(T, 9), text: 'Edited payments/retry/worker.ts' },
          { at: minutesBefore(T, 21), text: 'Edited payments/retry/backoff.ts' }, { at: minutesBefore(T, 40), text: 'Session started in the retry-worker worktree.' },
        ],
      }),
      stream({
        id: 'pay-local', title: 'Exploring refund webhooks', agent: 'Claude Code', branch: 'main', worktree: '~/code/acme-payments', changedFiles: 0, sessions: 2, visibility: visibility('pay-local'),
        lastActivityAt: minutesBefore(T, 130), lastActivity: 'Read payments/refunds/handler.ts',
        observed: [{ at: minutesBefore(T, 130), text: 'Read payments/refunds/handler.ts' }, { at: minutesBefore(T, 142), text: 'Session started in your main worktree.' }],
      }),
    ],
  },
  {
    id: 'latency', name: 'Checkout latency', repo: 'acme/web', inCall: () => [CAST.priya],
    work: (T) => [stream({
      id: 'bisect', title: 'p95 regression bisect', agent: 'Codex', branch: 'perf/p95-bisect', worktree: '~/code/acme-web-bisect', changedFiles: 0, sessions: 1, visibility: 'room',
      lastActivityAt: minutesBefore(T, 1), lastActivity: 'Ran the checkout benchmark at a3f9c12.',
      checks: [{ text: 'Checkout benchmark at a3f9c12', result: 'running' }, { text: 'Checkout benchmark at 7e21b04', result: 'fail' }, { text: 'Checkout benchmark at 51c0d9e', result: 'pass' }],
      observed: [{ at: minutesBefore(T, 1), text: 'Ran the checkout benchmark at a3f9c12.' }, { at: minutesBefore(T, 34), text: 'Narrowed the range to 6 commits.' }],
    })],
  },
  {
    id: 'ledger', name: 'Ledger migration', repo: 'acme/ledger', inCall: () => [],
    work: (T) => [
      stream({
        id: 'backfill', title: 'Backfill job', agent: 'Claude Code', branch: 'ledger/backfill', worktree: '~/code/acme-ledger-backfill', changedFiles: 5, sessions: 1, visibility: 'room',
        fromDecision: 'v1', question: 'Should reversed entries keep their original timestamp, or take the time of the reversal?',
        lastActivityAt: minutesBefore(T, 50), lastActivity: 'Asked the room a question, and paused.',
        checks: [{ text: 'entries.test.ts', result: 'pass' }, { text: 'reversals.test.ts', result: 'fail' }, { text: 'Typecheck', result: 'pass' }],
        observed: [{ at: minutesBefore(T, 50), text: 'Asked the room a question, and paused.' }, { at: minutesBefore(T, 75), text: 'Edited ledger/backfill/entries.ts' }],
      }),
      stream({
        id: 'dual-write', title: 'Dual-write shim', agent: 'Claude Code', branch: 'ledger/dual-write', worktree: '~/code/acme-ledger', changedFiles: 2, sessions: 1, visibility: visibility('dual-write'),
        lastActivityAt: minutesBefore(T, 60 * 5), lastActivity: 'Edited ledger/write/shim.ts', observed: [{ at: minutesBefore(T, 60 * 5), text: 'Edited ledger/write/shim.ts' }],
      }),
    ],
  },
  { id: 'webhooks', name: 'Webhook signing', repo: null, inCall: () => [], work: () => [] },
];

/* ---------- What a record says, in the words the room list and preview use. ---------- */

const VERB: Record<string, string> = {
  thread: 'started a thread', reply: 'replied', decision: 'drafted', review: 'asked for signatures on', signed: 'signed', agreed: 'agreed',
  amended: 'started a new version of', changes: 'asked for changes', work: 'drafted the plan', authorized: 'authorized', resolved: 'resolved',
};

function sentence(e: RecordEvent): string {
  if (!e.by || !VERB[e.kind]) return e.text;
  const v = e.version ? ` v${e.version}` : '';
  return e.kind === 'thread' || e.kind === 'reply' || e.kind === 'changes' ? `${nameOf(e.by)} ${VERB[e.kind]}: ${e.text}` : `${nameOf(e.by)} ${VERB[e.kind]} ${e.text}${v}.`;
}

/** What waits on you in a record: a signature, a coding agent's question, a thread asked of you. */
function attentionOf(r: VoweRecord): RoomPreview['attention'] {
  const out: RoomPreview['attention'] = [];
  for (const d of r.decisions) {
    const mine = d.approvers.find((a) => a.who === DEMO_ME);
    if (d.state === 'review' && mine && mine.signed !== d.version) {
      const signed = d.approvers.filter((a) => a.signed === d.version && a.who !== DEMO_ME).map((a) => nameOf(a.who));
      out.push({ id: `sign:${d.id}`, text: `Decision v${d.version} needs your signature`, detail: `${signed.length ? `${signed.join(' and ')} signed it: ` : ''}${d.title.toLowerCase()}.` });
    }
  }
  for (const w of r.work) {
    if (w.question && w.question.for === DEMO_ME && !w.question.answer && !w.question.deferred) {
      out.push({ id: `q:${w.id}`, text: `${w.doer?.name ?? 'The agent'} has a question`, detail: w.question.text });
    }
  }
  for (const t of r.threads) {
    if (t.status === 'open' && t.waiting === DEMO_ME) {
      const first = t.replies[0];
      out.push({ id: `t:${t.id}`, text: `${nameOf(first?.by ?? null)} is waiting on your reply`, detail: first?.body ?? '' });
    }
  }
  return out;
}

/** A record's kinds of event, as the room's lists draw them. */
const KIND: Record<string, EventKind> = {
  thread: 'thread', changes: 'thread', reply: 'reply', decision: 'decision', review: 'decision', amended: 'decision',
  signed: 'signed', agreed: 'signed', authorized: 'signed', work: 'work', resolved: 'resolved', question: 'question',
};

function recordEvents(r: VoweRecord): RoomEvent[] {
  return (r.log ?? []).map((e) => ev(e.id, e.at, sentence(e), personRef(e.by), e.kind === 'question' ? 'needs' : undefined, /^call-/.test(e.kind), /^call-/.test(e.kind) ? 'call' : KIND[e.kind]));
}

/* ---------- Rooms. ---------- */

function withYou(id: string, others: PersonRef[]) { return inCallYou === id ? [you(), ...others] : others; }

// Events saved before they had a kind: a call's comings and goings are the only presence events kept here.
function ownEvents(id: string) { return (saved.events[id] || []).map((e) => (e.kind ? e : { ...e, kind: e.presence ? 'call' as const : 'room' as const })); }

function summaryOf(id: string): RoomSummary | null {
  const example = saved.demo ? DEMO_ROOMS.find((r) => r.id === id) : null;
  const rec = example ? demoRecord(id) : null;
  if (example && rec) {
    const events = recordEvents(rec).concat(ownEvents(id)).sort(byNewest);
    const role = rec.members.find((m) => m.who === DEMO_ME)?.role ?? 'member';
    return {
      id, name: example.name, repo: example.repo, inCall: withYou(id, example.inCall()), role,
      spaceId: DEMO_ROOM_SPACE[id], work: workMark(example.work(saved.demo!.at).map((w) => w.status)), keptAt: id in saved.kept ? saved.kept[id] : saved.demo ? new Date(saved.demo.at).toISOString() : null,
      needs: attentionOf(rec)[0]?.text ?? null, activity: changed(events), activityAt: events[0]?.at ?? null,
    };
  }
  const quick = saved.demo ? DEMO_QUICK.find((r) => r.id === id) : null;
  if (quick && saved.demo) {
    const events = ownEvents(id);
    return {
      id, name: quick.name, repo: quick.repo, spaceId: quick.spaceId, keptAt: saved.kept[id] ?? null, inCall: withYou(id, []), role: 'owner', needs: null,
      activity: changed(events) || quick.activity, activityAt: events[0]?.at ?? minutesBefore(saved.demo.at, quick.minutes),
    };
  }
  const mine = saved.rooms.find((r) => r.id === id);
  if (!mine) return null;
  const events = ownEvents(id);
  // Rooms saved before quick rooms existed have no keptAt: they were made to last.
  return {
    id, name: mine.name, repo: mine.repo, spaceId: mine.spaceId ?? PERSONAL,
    keptAt: id in saved.kept ? saved.kept[id] : mine.keptAt === undefined ? mine.createdAt : mine.keptAt,
    inCall: withYou(id, []), role: 'owner', needs: null, activity: changed(events), activityAt: events[0]?.at ?? mine.createdAt,
  };
}

function record(roomId: string, text: string, kind: EventKind, presence = false) {
  const list = [ev('e' + now(), iso(), text, you(), undefined, presence, kind)].concat(ownEvents(roomId)).slice(0, 20);
  commit({ events: { ...saved.events, [roomId]: list } });
}

const room: RoomDataSource = {
  list() {
    const ids = saved.rooms.slice().reverse().map((r) => r.id).concat(saved.demo ? [...DEMO_ROOMS, ...DEMO_QUICK].map((r) => r.id) : []);
    return ids.map(summaryOf).filter((r): r is RoomSummary => !!r);
  },
  subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  me: you,
  async create({ name, goal, repo, spaceId }) {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'room';
    const id = `${base}-${now().toString(36).slice(-4)}`;
    mockLog('room', `created room "${name}" (stored in localStorage, not shared with anyone)`, { goal, repo, spaceId });
    // New rooms start quick, as they do for real: they're kept once someone keeps them.
    saved = { ...saved, rooms: saved.rooms.concat([{ id, name, goal, repo, createdAt: iso(), spaceId: spaceId ?? PERSONAL, keptAt: null }]) };
    record(id, 'You created this room.', 'room');
    return summaryOf(id)!;
  },
  async preview(id) {
    const summary = summaryOf(id);
    if (!summary) throw new Error(`No room ${id}`);
    const rec = saved.demo ? demoRecord(id) : null;
    const last = saved.visits[id];
    let goal: RoomPreview['goal'] = null, events: RoomEvent[] = ownEvents(id), lastView: RoomPreview['lastView'] = null;
    let attention: RoomPreview['attention'] = [];
    if (rec) {
      if (rec.goal) goal = { text: rec.goal.text, by: personRef(rec.goal.by) ?? you() };
      events = recordEvents(rec).concat(events);
      attention = attentionOf(rec);
      const shown = await demoScene(id);
      if (shown) lastView = { name: shown.scene.name, question: shown.scene.question, at: shown.at, by: personRef(shown.by), scene: shown.scene };
    } else {
      const mine = saved.rooms.find((r) => r.id === id);
      if (mine?.goal) goal = { text: mine.goal, by: you() };
    }
    events.sort(byNewest);
    const since = last ? events.filter((e) => e.who?.tone !== 'me' && Date.parse(e.at) > Date.parse(last)) : [];
    return { room: summary, goal, since, recent: events.filter((e) => !since.includes(e)).slice(0, 5), attention, seenAt: last ?? null, lastView };
  },
  visited(id) {
    saved = { ...saved, visits: { ...saved.visits, [id]: iso() } };
    persist();
  },
  async update(id, { name, goal }) {
    if (!saved.rooms.some((r) => r.id === id)) throw new Error('The example rooms keep their names');
    mockLog('room', `updated room ${id} (stored in localStorage)`, { name, goal });
    commit({ rooms: saved.rooms.map((r) => (r.id === id ? { ...r, ...(name !== undefined ? { name } : {}), ...(goal !== undefined ? { goal } : {}) } : r)) });
  },
  async keep(id, keep) {
    commit({ kept: { ...saved.kept, [id]: keep ? summaryOf(id)?.keptAt ?? iso() : null } });
  },
  spaces() {
    const mine = saved.spaces.slice();
    if (!mine.some((s) => s.id === PERSONAL) && saved.rooms.some((r) => (r.spaceId ?? PERSONAL) === PERSONAL)) mine.unshift({ id: PERSONAL, name: 'Personal', repos: [], createdAt: '' });
    // An example Space you renamed or linked a repository to is saved under its own id, in its own place.
    const examples = saved.demo ? DEMO_SPACES.map((d) => mine.find((s) => s.id === d.id) ?? d) : [];
    const own = mine.filter((s) => !DEMO_SPACES.some((d) => d.id === s.id));
    return [...examples, ...own].map((s): SpaceSummary => ({ id: s.id, name: s.name, repos: s.repos, role: 'owner' }));
  },
  async localRepos() { await wait(120); return EXAMPLE_LOCAL; },
  async createSpace({ name, repos }) {
    const id = `space-${now().toString(36)}`;
    const identities = repos.map((r) => EXAMPLE_LOCAL.find((l) => l.id === r)?.identity).filter((r): r is string => !!r);
    mockLog('room', `made Space "${name}" (stored in localStorage)`, { repos: identities });
    commit({ spaces: saved.spaces.concat([{ id, name, repos: identities, createdAt: iso() }]) });
    return { id, name, repos: identities, role: 'owner' };
  },
  async renameSpace(id, name) {
    const known = saved.spaces.some((s) => s.id === id);
    commit({ spaces: known ? saved.spaces.map((s) => (s.id === id ? { ...s, name } : s)) : saved.spaces.concat([{ ...(DEMO_SPACES.find((s) => s.id === id) ?? { id, repos: [], createdAt: '' }), name }]) });
  },
  async linkRepo(spaceId, repoId) {
    const identity = EXAMPLE_LOCAL.find((l) => l.id === repoId)?.identity;
    if (!identity) throw new Error(`${repoId} has no shareable origin remote`);
    const base = room.spaces!().find((s) => s.id === spaceId);
    if (!base) throw new Error('No such Space');
    // In its place, so linking doesn't move the Space in the sidebar.
    const next = { id: spaceId, name: base.name, repos: [...new Set([...base.repos, identity])], createdAt: iso() };
    commit({ spaces: saved.spaces.some((s) => s.id === spaceId) ? saved.spaces.map((s) => (s.id === spaceId ? next : s)) : saved.spaces.concat([next]) });
  },
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
    if (started) { callStarted[roomId] = now(); record(roomId, 'You started a call.', 'call', true); } else notify();
  },
  async leave(roomId) {
    mockLog('call', `left the call in ${roomId}`);
    if (devFlags.state.slowCall) await wait(900);
    inCallYou = null;
    const others = summaryOf(roomId)?.inCall.length ?? 0;
    const min = callStarted[roomId] ? Math.max(1, Math.round((now() - callStarted[roomId]) / 60_000)) : 0;
    delete callStarted[roomId];
    if (others) record(roomId, 'You left the call.', 'call', true);
    else record(roomId, min ? `Call ended · ${min} min.` : 'Call ended.', 'call', true);
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
    const summary = summaryOf(roomId);
    const workstreams = saved.demo ? DEMO_ROOMS.find((r) => r.id === roomId)?.work(saved.demo.at) ?? [] : [];
    mockLog('work', `context for ${roomId}: ${workstreams.length} example workstreams; no repository, worktree or session was read`);
    const ctx: RoomWorkContext = { repo: summary?.repo ?? null, generatedAt: iso(), workstreams: summary?.repo ? workstreams : [] };
    return ctx;
  },
  async share(roomId, streamId) {
    mockLog('work', `shared ${streamId} with ${roomId} (local only: no one else sees it)`);
    if (!saved.shared.includes(streamId)) commit({ shared: saved.shared.concat([streamId]) });
  },
};

/* ---------- What the app and the developer menu use. ---------- */

export const workspace = { room, call, work };

export const demoLoaded = () => !!saved.demo;

/** Loads the example rooms: their records, Payment Reliability's canvas, and fresh visits. */
export async function loadDemo(): Promise<void> {
  mockLog('workspace', 'loaded the Payment Reliability demo');
  inCallYou = null;
  const at = now();
  const visits = { ...saved.visits }, events = { ...saved.events };
  DEMO_ROOMS.forEach((r) => { delete visits[r.id]; delete events[r.id]; });
  seedRecords(at);
  await seedCanvases();
  commit({ demo: { at }, visits, events, shared: [] });
}

export function clearDemo() {
  inCallYou = null;
  clearRecords();
  clearCanvases();
  commit({ demo: null });
}

export function resetWorkspace() {
  clearDemo();
  saved = { ...EMPTY };
  persist();
  notify();
}
