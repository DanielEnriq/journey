import type {
  ClaudeCodeBlock, ClaudeCodeMessage, Participant, RoomActivity, RoomAuthor, RoomDecision, RoomDetails, RoomMember, RoomRecord,
  RoomResult, RoomSummary as CloudRoom, WorkContext,
} from '../../../../shared/api.js';
import { account, initials } from '../../../shared/account.js';
import { Store } from '../../../shared/store.js';
import { shortAgo } from '../../../shared/time.js';
import type {
  CallDataSource, NewRoom, RepoChoice, RoomDataSource, RoomEvent, RoomPreview, RoomRecordSource, RoomRecordView,
  RoomWorkContext, Transcript, TranscriptLine, WorkstreamDataSource,
} from '../../room/data/sources.js';
import type { Person as PanelPerson, PersonTone, Stream } from '../../room/panel/types.js';
import type { PersonRef, RoomSummary } from '../../room/types.js';
import { toRoomWorkContext } from '../../work/adapter.js';

// The workspace as it really is: your Supabase rooms and their members, each room's record (threads,
// replies, decisions, signatures, activity), Realtime presence while you are in a room's call, and the
// coding work in your local clone of its repository (WorkContextService and Claude Code transcripts,
// over IPC). Nothing here is invented: what can't be read is reported as unavailable, never filled in.
// Voice isn't part of this build, so a call is presence and the shared canvas only.

const api = () => window.journey;

/** A cloud call that failed, worded for a person. */
export class RoomUnavailable extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

const WORDS: Partial<Record<string, string>> = {
  'not-configured': 'Rooms aren’t set up in this build: Supabase isn’t configured.',
  'signed-out': 'Your cloud session ended. Sign out and in again.',
  network: 'Couldn’t reach Vowe’s cloud. Check your connection and try again.',
  'not-found': 'This room doesn’t exist, or you aren’t a member of it.',
  'permission-denied': 'Only the room’s owner can do that.',
};

async function unwrap<T>(result: Promise<RoomResult<T>>): Promise<T> {
  const r = await result;
  if (r.ok) return r.value;
  throw new RoomUnavailable(r.error.code, WORDS[r.error.code] ?? r.error.message);
}

/* ---------- What is known, kept between reads. ---------- */

interface Known { room: CloudRoom; record: RoomRecord | null; members: RoomMember[] }

export interface RealStatus { state: 'loading' | 'ready' | 'failed'; error: string | null }
export const realStatus = new Store<RealStatus>({ state: 'loading', error: null });

let order: string[] = [];
const known = new Map<string, Known>();
/** Who is connected to a room, while you are (presence only reaches those connected). */
const presence = new Map<string, Participant[]>();
/** The last work context read for a room, for its transcripts and the call's Running list. */
const work = new Map<string, { repositoryId: string; context: WorkContext; room: RoomWorkContext }>();
/** Your cloud user id: learned from a room's members (by email) or from joining a room. */
let selfId: string | null = null;
let workspaceId: string | null = null;
let started = false;

const listeners = new Set<() => void>();
function notify() { listeners.forEach((l) => l()); }

function myEmail() { return account.state.user?.email?.toLowerCase() ?? null; }
function learnSelf(members: RoomMember[]) {
  if (selfId) return;
  const email = myEmail();
  selfId = members.find((m) => m.email.toLowerCase() === email)?.userId ?? null;
}
const isMe = (id: string | null | undefined) => !!id && id === selfId;

/* ---------- People: you, and everyone else in a lasting tone. ---------- */

const TONES: PersonRef['tone'][] = ['peer', 'p2', 'p3'];
const PANEL_TONE: Record<PersonRef['tone'], PersonTone> = { me: 'me', peer: 'peer', p2: 'peer2', p3: 'peer3' };

function me(): PersonRef {
  const u = account.state.user;
  return { name: 'You', initials: initials(u?.name || u?.email || '?') || '?', tone: 'me' };
}

/** Each member keeps one tone, by when they joined the room. */
function peopleOf(members: RoomMember[]) {
  const others = members.filter((m) => !isMe(m.userId)).sort((a, b) => Date.parse(a.joinedAt) - Date.parse(b.joinedAt));
  const tone = new Map(others.map((m, i) => [m.userId, TONES[i % TONES.length]]));
  return (id: string, fallback?: { name: string | null; email: string }): PersonRef => {
    if (isMe(id)) return me();
    const m = members.find((x) => x.userId === id);
    const name = m?.name || fallback?.name || m?.email.split('@')[0] || fallback?.email.split('@')[0] || 'Someone';
    return { name: name.split(/\s+/)[0], initials: initials(name) || '?', tone: tone.get(id) ?? 'peer' };
  };
}

/* ---------- Activity in words. ---------- */

const quote = (s: string | null, n = 80) => !s ? '' : s.length > n ? `“${s.slice(0, n - 1)}…”` : `“${s}”`;

function eventOf(a: RoomActivity, who: (id: string, fallback?: RoomAuthor) => PersonRef): RoomEvent {
  const p = a.actor ? who(a.actor.id, a.actor) : null;
  const name = p ? (p.tone === 'me' ? 'You' : p.name) : 'Someone';
  const text = {
    thread: `${name} started a thread: ${quote(a.subject)}`,
    reply: `${name} replied: ${quote(a.subject)}`,
    decision: `${name} proposed decision v${a.version}: ${quote(a.subject)}`,
    amended: `${name} proposed v${a.version} of ${quote(a.subject)}`,
    signed: `${name} signed decision v${a.version}.`,
    repository: a.subject ? `${name} attached ${a.subject}.` : `${name} detached the repository.`,
    'call-started': `${name} joined the call.`,
    'call-left': `${name} left the call.`,
  }[a.kind];
  return { id: a.id, at: a.createdAt, text, who: p };
}

/** The decision being worked on, and whether it waits on your signature. */
function current(record: RoomRecord | null) {
  const d = record?.decisions[0] ?? null;
  const needsMe = !!d && !!selfId && !d.signatures.some((s) => s.userId === selfId && s.version === d.version);
  return { d, needsMe };
}

function summaryOf(k: Known): RoomSummary {
  const who = peopleOf(k.members);
  const latest = k.record?.activity[0];
  const { d, needsMe } = current(k.record);
  return {
    id: k.room.id,
    name: k.room.name,
    repo: k.room.repository,
    inCall: (presence.get(k.room.id) ?? []).map((p) => who(p.userId, { name: p.name, email: '' })),
    needs: needsMe ? `Decision v${d!.version} needs your signature` : null,
    activity: latest ? eventOf(latest, who).text : 'Room created.',
    activityAt: latest?.createdAt ?? k.room.createdAt,
  };
}

/** Reads a room's record and members, and keeps them. */
async function read(roomId: string, room?: CloudRoom): Promise<Known> {
  const [r, record, members] = await Promise.all([
    room ? Promise.resolve(room) : unwrap(api().rooms.get(roomId)),
    unwrap(api().record.get(roomId)),
    unwrap(api().rooms.members(roomId)),
  ]);
  learnSelf(members);
  const k = { room: r, record, members };
  known.set(roomId, k);
  if (!order.includes(roomId)) order = [roomId, ...order];
  return k;
}

async function refresh() {
  try {
    const rooms = await unwrap(api().rooms.list());
    order = rooms.map((r) => r.id);
    for (const id of [...known.keys()]) if (!order.includes(id)) known.delete(id);
    // The list shows what needs you and what happened last, which only each room's record says.
    await Promise.all(rooms.map((r) => read(r.id, r).catch(() => { known.set(r.id, { room: r, record: null, members: [] }); })));
    realStatus.setState({ state: 'ready', error: null });
  } catch (err) {
    realStatus.setState({ state: 'failed', error: (err as Error).message });
  }
  notify();
}

/** Re-reads one room after it changed, here or for another member. */
async function changed(roomId: string) {
  try { await read(roomId); } catch { /* the next full refresh says why */ }
  notify();
}

/** Tells everyone else connected to the room to re-read its record. Only reaches them while you're connected. */
function broadcast(roomId: string, what: 'thread' | 'reply' | 'decision' | 'signature') {
  if (presence.has(roomId)) api().rooms.send(roomId, 'record:changed', { what }).catch(() => {});
}

let workTimer: ReturnType<typeof setTimeout> | null = null;

/** Starts listening once someone is signed in; safe to call more than once. */
export function startRealWorkspace() {
  if (started || !window.journey) return;
  started = true;
  const j = api();
  j.rooms.onEvent((e) => { if (e.type === 'record:changed') void changed(e.roomId); });
  j.rooms.onPresence(({ roomId, participants }) => { presence.set(roomId, participants); notify(); });
  j.rooms.onStatus(({ roomId, status }) => { if (status === 'left') { presence.delete(roomId); notify(); } });
  // Claude Code's live activity: whatever shows a room's work reads it again, a few seconds at most behind.
  j.claudeCode.onEvent(() => {
    if (workTimer) return;
    workTimer = setTimeout(() => { workTimer = null; notify(); }, 2500);
  });
  account.subscribe(() => {
    const user = account.state.user;
    if (user) void refresh();
    else { known.clear(); order = []; presence.clear(); work.clear(); selfId = null; workspaceId = null; notify(); }
  });
  if (account.state.user) void refresh();
}

/** Rooms are made in a workspace; your first room makes one for you. */
async function ensureWorkspace(): Promise<string> {
  if (workspaceId) return workspaceId;
  const list = await api().workspaces.list();
  workspaceId = (list[0] ?? await api().workspaces.create('Personal')).id;
  return workspaceId;
}

/** Repositories added on this machine, for the room picker. */
export async function localRepos(): Promise<RepoChoice[]> {
  const repos = await api().repos.list();
  return repos.map((r) => ({ id: r.id, label: r.name }));
}

/** The folder picker; null if cancelled. */
export async function addLocalRepo(): Promise<RepoChoice | null> {
  const r = await api().repos.add();
  return r ? { id: r.id, label: r.name } : null;
}

async function attach(roomId: string, repositoryId: string) {
  const details: RoomDetails = await unwrap(api().rooms.attachRepository(roomId, repositoryId));
  work.delete(roomId);
  await read(roomId, details);
  notify();
}

const room: RoomDataSource = {
  list: () => order.map((id) => known.get(id)).filter((k): k is Known => !!k).map(summaryOf),
  subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  me,
  async create({ name, goal, repo }) {
    const ws = await ensureWorkspace();
    const made = await unwrap(api().rooms.create({ workspaceId: ws, name, goal: goal || null }));
    await read(made.id, made);
    if (repo) {
      // The room exists either way; a repository that can't be attached is offered again in its preview.
      try { await attach(made.id, repo); } catch (err) { attachErrors.set(made.id, (err as Error).message); }
    }
    notify();
    return summaryOf(known.get(made.id)!);
  },
  async preview(roomId) {
    const k = await read(roomId);
    const who = peopleOf(k.members);
    const record = k.record!;
    const events = record.activity.map((a) => eventOf(a, who));
    const last = record.lastSeenAt;
    const since = last ? events.filter((e) => e.who?.tone !== 'me' && Date.parse(e.at) > Date.parse(last)) : [];
    const { d, needsMe } = current(record);
    const attention: RoomPreview['attention'] = [];
    if (d && needsMe) {
      const by = who(d.proposedBy.id, d.proposedBy);
      attention.push({
        id: 'sign',
        text: `Decision v${d.version} needs your signature`,
        detail: `${by.tone === 'me' ? 'You' : by.name} proposed: ${d.title} Verify: ${d.verify}. Sign it in the call, where the room can see it.`,
      });
    }
    return {
      room: summaryOf(k),
      goal: k.room.goal ? { text: k.room.goal, by: who(k.room.createdBy) } : null,
      since,
      recent: events.filter((e) => !since.includes(e)).slice(0, 5),
      attention,
      // Canvas views aren't stored yet, so there's never a last view to show.
      lastView: null,
    };
  },
  visited(roomId) {
    api().record.seen(roomId).then(() => changed(roomId), () => {});
  },
  // The scripted canvas's cast; real rooms have members instead.
  people: () => ({}) as ReturnType<RoomDataSource['people']>,
  invite: () => Promise.reject(new Error('Inviting someone isn’t in this build yet.')),
  attach,
  repos: localRepos,
  addRepo: addLocalRepo,
};

/** Why a room's repository couldn't be attached when it was made. */
export const attachErrors = new Map<string, string>();

/* ---------- The call: presence on the room's Realtime channel. No audio in this build. ---------- */

const call: CallDataSource = {
  async join(roomId) {
    const session = await api().rooms.join(roomId);
    selfId = session.selfId;
    presence.set(roomId, session.participants);
    await unwrap(api().record.call(roomId, 'call-started')).catch(() => {});
    await changed(roomId);
  },
  async leave(roomId) {
    await unwrap(api().record.call(roomId, 'call-left')).catch(() => {});
    try { await api().rooms.leave(roomId); } finally {
      presence.delete(roomId);
      await changed(roomId);
    }
  },
  // Nothing to mute or caption: voice isn't connected in this build, and the call bar says so.
  setMuted: () => {},
  setCaptions: () => {},
};

/* ---------- Work: your clone of the room's repository, read on this machine. ---------- */

const workSource: WorkstreamDataSource = {
  async context(roomId) {
    const k = known.get(roomId) ?? await read(roomId);
    const generatedAt = new Date().toISOString();
    const repo = k.room.repository;
    if (!repo) return { repo: null, generatedAt, workstreams: [] };
    const checkout = await unwrap(api().rooms.checkout(roomId));
    if (!checkout) {
      return { repo, generatedAt, workstreams: [], unavailable: `${repo} isn’t added on this machine, so its Claude Code sessions can’t be read here. Add your clone of it.` };
    }
    const context = await api().context.work(checkout.repositoryId);
    const shown = { ...toRoomWorkContext(context), repo };
    work.set(roomId, { repositoryId: checkout.repositoryId, context, room: shown });
    return shown;
  },
  async transcript(roomId, streamId) {
    const w = work.get(roomId);
    const stream = w?.context.workstreams.find((s) => s.id === streamId);
    if (!w || !stream) throw new Error('This workstream isn’t in the room’s work any more.');
    const linked = new Set(stream.sessions.map((s) => s.sessionId));
    const session = w.context.sessions.find((s) => linked.has(s.id));
    if (!session) throw new Error('No Claude Code session is linked to this workstream.');
    const page = await api().claudeCode.messages(w.repositoryId, session.id, { limit: 40 });
    return { title: session.title, total: page.total, lines: page.messages.flatMap(linesOf) } satisfies Transcript;
  },
};

function linesOf(m: ClaudeCodeMessage): TranscriptLine[] {
  return m.blocks.flatMap((b: ClaudeCodeBlock, i): TranscriptLine[] => {
    const id = `${m.uuid}:${i}`;
    if (b.type === 'text' && b.text.trim()) return [{ id, role: m.role, text: b.text + (b.truncated ? ' …' : ''), at: m.timestamp }];
    if (b.type === 'tool_use') return [{ id, role: 'tool', text: `${b.name} ${firstLine(b.input.text)}`, at: m.timestamp }];
    if (b.type === 'tool_result' && b.isError) return [{ id, role: 'tool', text: `Failed: ${firstLine(b.output.text)}`, at: m.timestamp }];
    return [];
  });
}

function firstLine(s: string) {
  const line = s.replace(/^[{\s]+/, '').split('\n')[0] ?? '';
  return line.length > 120 ? line.slice(0, 119) + '…' : line;
}

/* ---------- The record in the call: the right column and the canvas's pins. ---------- */

const STREAM_STATE = { active: 'running', attention: 'needs', completed: 'done' } as const;

function decisionOf(d: RoomDecision, members: RoomMember[]) {
  const best = (userId: string) => {
    const mine = d.signatures.filter((s) => s.userId === userId).map((s) => s.version);
    return mine.length ? Math.max(...mine) : null;
  };
  const approvers = members.map((m) => ({ personId: m.userId, signedVersion: best(m.userId) }));
  return {
    id: d.id,
    version: d.version,
    title: d.title,
    verify: d.verify,
    proposedBy: d.proposedBy.id,
    proposedAgo: shortAgo(d.updatedAt),
    approvers,
    status: approvers.every((a) => a.signedVersion === d.version) ? 'agreed' as const : 'proposed' as const,
    earlierVersions: d.history.length,
  };
}

const record: RoomRecordSource = {
  async load(roomId) {
    const k = await read(roomId);
    const rec = k.record!;
    const who = peopleOf(k.members);
    const people: Record<string, PanelPerson> = {};
    const add = (id: string, fallback?: RoomAuthor) => {
      if (people[id]) return;
      const p = who(id, fallback);
      people[id] = { id, name: p.tone === 'me' ? 'You' : p.name, initials: p.initials, kind: 'human', tone: PANEL_TONE[p.tone] };
    };
    k.members.forEach((m) => add(m.userId));
    rec.threads.forEach((t) => { add(t.author.id, t.author); t.replies.forEach((r) => add(r.author.id, r.author)); });
    const d = rec.decisions[0];
    if (d) add(d.proposedBy.id, d.proposedBy);
    const meId = selfId ?? 'you';
    add(meId);
    // Only work with recent evidence is "running"; anything quiet stays in the preview's Work list.
    const ctx = work.get(roomId)?.room ?? await workSource.context(roomId).catch(() => null);
    const streams: Stream[] = (ctx?.workstreams ?? []).flatMap((w): Stream[] => w.status === 'unknown' ? [] : [{
      id: w.id, title: w.title, agent: w.agent, meta: [w.branch ?? 'detached', w.changedFiles !== null ? `${w.changedFiles} changed` : null].filter(Boolean).join(' · '),
      state: STREAM_STATE[w.status], line: w.lastActivity ?? undefined,
    }]);
    const here = presence.get(roomId)?.length ?? 0;
    const view: RoomRecordView = {
      panel: {
        people,
        meId,
        subtitle: here ? `${here} here` : undefined,
        goal: k.room.goal ? { text: k.room.goal, by: k.room.createdBy } : undefined,
        decision: d ? decisionOf(d, k.members) : undefined,
        threads: rec.threads.map((t) => ({
          id: t.id,
          kind: t.kind,
          anchor: { id: t.anchor.id === 'pin' ? `pin:${t.id}` : t.anchor.id, name: t.anchor.name },
          root: { id: `${t.id}-root`, authorId: t.author.id, body: t.body, ago: shortAgo(t.createdAt) },
          replies: t.replies.map((r) => ({ id: r.id, authorId: r.author.id, body: r.body, ago: shortAgo(r.createdAt), fresh: Date.now() - Date.parse(r.createdAt) < 4000 })),
        })),
        streams,
      },
      pins: rec.threads.flatMap((t) => t.anchor.id === 'pin' && t.anchor.x !== null && t.anchor.y !== null
        ? [{ threadId: t.id, x: t.anchor.x, y: t.anchor.y, body: t.body, author: who(t.author.id, t.author) }] : []),
      decision: d ? { id: d.id, title: d.title, verify: d.verify } : null,
    };
    return view;
  },
  subscribe: (_roomId, listener) => room.subscribe(listener),
  async pin(roomId, at, body) {
    await unwrap(api().record.addThread(roomId, { kind: 'note', anchor: { id: 'pin', name: 'Canvas', x: Math.round(at.x), y: Math.round(at.y) }, body }));
    broadcast(roomId, 'thread');
    await changed(roomId);
  },
  async reply(roomId, threadId, body) {
    await unwrap(api().record.reply(roomId, threadId, body));
    broadcast(roomId, 'reply');
    await changed(roomId);
  },
  async sign(roomId, decisionId, version) {
    await unwrap(api().record.sign(roomId, decisionId, version));
    broadcast(roomId, 'signature');
    await changed(roomId);
  },
  async propose(roomId, d) {
    await unwrap(api().record.propose(roomId, d));
    broadcast(roomId, 'decision');
    await changed(roomId);
  },
  async amend(roomId, decisionId, change) {
    await unwrap(api().record.amend(roomId, decisionId, change));
    broadcast(roomId, 'decision');
    await changed(roomId);
  },
};

export const realWorkspace = { room, call, work: workSource, record };
export type RealWorkspace = typeof realWorkspace;
