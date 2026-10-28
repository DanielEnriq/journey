import { buildScene, type Scene } from '../../../../shared/canvas/index.js';
import type {
  ClaudeCodeBlock, ClaudeCodeMessage, Participant, Repository, RoomActivity, RoomAuthor, RoomCanvas, RoomCheckout, RoomDecision, RoomDetails,
  RoomFailure, RoomInvitation, RoomMember, RoomRecord, RoomResult, RoomRole, RoomSummary as CloudRoom, WorkContext,
} from '../../../../shared/api.js';
import { CallService } from '../../../calls/service.js';
import { account, initials } from '../../../shared/account.js';
import { Store } from '../../../shared/store.js';
import { shortAgo } from '../../../shared/time.js';
import type {
  CallDataSource, LocalRepo, NewRoom, RepoChoice, EventKind, RoomDataSource, RoomEvent, RoomPreview, RoomRecordSource, RoomRecordView,
  RoomWorkContext, Transcript, TranscriptLine, WorkstreamDataSource,
} from '../../room/data/sources.js';
import { workMark } from '../../room/data/sources.js';
import type { Person as PanelPerson, PersonTone, Stream } from '../../room/panel/types.js';
import type { PersonRef, RoomSummary, SpaceSummary } from '../../room/types.js';
import { toRoomWorkContext } from '../../work/adapter.js';
import { createVoweServices } from './vowe-services.js';
import type {
  AccessLost, InviteLink, InviteSource, Invitation, LinkExpiry, Member, MembershipError, MembershipSource, Result, RoomAccess, User,
} from '../../membership/model.js';

// The workspace as it really is: your Supabase rooms, their members and invitations, each room's record
// (threads, replies, decisions, signatures, activity), Realtime presence while you have a room open, its
// LiveKit voice call, and the coding work in your local clone of its repository (WorkContextService and
// Claude Code transcripts, over IPC). Nothing here is invented: what can't be read is reported as
// unavailable, never filled in.
//
// Three kinds of "here", kept apart: a room's members (the database), who has it open (Realtime presence),
// and who is in its call (each client announces that in its presence, from its LiveKit connection).
// Opening a room never joins its call, and joining the call never opens the mic.

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
  'permission-denied': 'Your role in this room can’t do that. Ask an owner.',
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
/** Who has a room open, while you do (presence only reaches those connected), and whether each is in its call. */
const presence = new Map<string, Participant[]>();
/** Each room's invitations, read with its members when its access is shown. */
const invitations = new Map<string, RoomInvitation[]>();
/** Links made in this window, by invitation id: the only place a link's token is ever held. Never stored or logged. */
const linkUrls = new Map<string, string>();
/** Rooms you lost access to while you had them open. */
const lostRooms = new Map<string, AccessLost>();
/** The last work context read for a room, for its transcripts and the call's Running list. */
const work = new Map<string, { contexts: { repository: string; repositoryId: string; context: WorkContext }[]; room: RoomWorkContext }>();
/** Each Space's repositories, by workspace id: every room in a Space can use all of them. */
const spaceRepos = new Map<string, string[]>();
/** Your Spaces (workspaces), the ones you made first. */
let spaceList: { id: string; name: string; createdBy: string }[] = [];
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
/** Your cloud user id, once known; the canvas uses it to tell your marks from others'. */
export const selfCloudId = () => selfId;

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

const EVENT_KIND: Record<RoomActivity['kind'], EventKind> = {
  thread: 'thread', reply: 'reply', decision: 'decision', amended: 'decision', signed: 'signed', repository: 'repo',
  'call-started': 'call', 'call-left': 'call', joined: 'people', left: 'people', removed: 'people', role: 'people',
};

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
    joined: `${name} joined the room.`,
    left: `${name} left the room.`,
    removed: `${name} removed ${a.subject ?? 'someone'} from the room.`,
    role: `${name} changed ${(a.subject ?? '').replace(' · ', '’s role to ')}.`,
  }[a.kind];
  return { id: a.id, kind: EVENT_KIND[a.kind], at: a.createdAt, text, who: p, ...(a.kind === 'call-started' || a.kind === 'call-left' ? { presence: true as const } : {}) };
}

/** The decision being worked on, and whether it waits on your signature (never a viewer's: they can't sign). */
function current(record: RoomRecord | null, role?: RoomRole) {
  const d = record?.decisions[0] ?? null;
  const needsMe = !!d && !!selfId && role !== 'viewer' && !d.signatures.some((s) => s.userId === selfId && s.version === d.version);
  return { d, needsMe };
}

function summaryOf(k: Known): RoomSummary {
  const who = peopleOf(k.members);
  const latest = k.record?.activity[0];
  // The line says what last changed in the room; comings and goings in its call don't count (who's in it shows live).
  const changed = k.record?.activity.find((a) => a.kind !== 'call-started' && a.kind !== 'call-left');
  const { d, needsMe } = current(k.record, k.room.role);
  return {
    id: k.room.id,
    name: k.room.name,
    spaceId: k.room.workspaceId,
    repo: reposOf(k.room)[0] ?? null,
    repos: reposOf(k.room),
    keptAt: k.room.keptAt,
    // Known once the room's work has been read on this machine (opening it, or the Inbox reading it).
    work: work.has(k.room.id) ? workMark(work.get(k.room.id)!.room.workstreams.map((w) => w.status)) : undefined,
    inCall: (presence.get(k.room.id) ?? []).filter((p) => p.call).map((p) => who(p.userId, { name: p.name, email: '' })),
    here: (presence.get(k.room.id) ?? []).map((p) => who(p.userId, { name: p.name, email: '' })),
    role: k.room.role,
    needs: needsMe ? `Decision v${d!.version} needs your signature` : null,
    activity: changed ? eventOf(changed, who).text : '',
    activityAt: latest?.createdAt ?? k.room.createdAt,
  };
}

/** The repositories a room can use: its Space's, its own first (rooms made before Spaces each named one). */
function reposOf(room: CloudRoom): string[] {
  const linked = spaceRepos.get(room.workspaceId) ?? [];
  const own = room.repository;
  if (!own) return linked;
  return [own, ...linked.filter((r) => r.toLowerCase() !== own.toLowerCase())];
}

/** Reads the Space's repositories again. A Space that can't be read keeps what was last known. */
async function readSpaceRepos(workspaceId: string) {
  const linked = await unwrap(api().workspaces.repositories(workspaceId)).catch(() => null);
  if (linked) spaceRepos.set(workspaceId, linked.map((r) => r.repository));
}

/** Reads your Spaces and their repositories; `also` are Spaces your rooms are in, in case the list missed one. */
async function readSpaces(also: string[] = []) {
  const list = await api().workspaces.list().catch(() => null);
  if (list) spaceList = list.map((w) => ({ id: w.id, name: w.name, createdBy: w.created_by }));
  await Promise.all([...new Set([...spaceList.map((w) => w.id), ...also])].map(readSpaceRepos));
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

/** Reads the rooms list again (after "Couldn’t read your rooms"). */

async function refresh() {
  if (!account.state.user) return;
  try {
    const rooms = await unwrap(api().rooms.list());
    order = rooms.map((r) => r.id);
    for (const id of [...known.keys()]) if (!order.includes(id)) known.delete(id);
    await readSpaces(rooms.map((r) => r.workspaceId));
    // The list shows what needs you and what happened last, which only each room's record says.
    await Promise.all(rooms.map((r) => read(r.id, r).catch(() => { known.set(r.id, { room: r, record: null, members: [] }); })));
    realStatus.setState({ state: 'ready', error: null });
  } catch (err) {
    realStatus.setState({ state: 'failed', error: (err as Error).message });
  }
  notify();
}

/**
 * Someone else adding you to a room (or removing you) reaches no channel you're in, so the list is checked
 * again when the window comes back and every minute while it's on screen. Only a changed list reads records.
 */
async function recheckList() {
  if (!account.state.user || realStatus.state.state !== 'ready') return;
  const rooms = await unwrap(api().rooms.list()).catch(() => null);
  if (!rooms) return;
  const ids = rooms.map((r) => r.id);
  if (ids.length !== order.length || ids.some((id) => !order.includes(id))) await refresh();
}
const RECHECK_MS = 60_000;

/** The view the room's canvas was last left on, as a still for the preview; null before anything is drawn. */
async function lastViewOf(roomId: string, who: ReturnType<typeof peopleOf>): Promise<RoomPreview['lastView']> {
  const r = await roomScene(roomId).catch(() => null);
  if (!r?.scene) return null;
  const last = r.doc.history.at(-1), scene = r.scene;
  return { name: scene.name, question: scene.question, at: last?.at ?? new Date().toISOString(), by: last && last.by.kind === 'human' ? who(last.by.id) : null, scene };
}

/**
 * The room's canvas as it was last left: its active view's scene, or null before anything is drawn (or
 * when the view can't be built). Rejects when the canvas can't be read at all.
 */
export async function roomScene(roomId: string): Promise<{ doc: RoomCanvas['doc']; scene: Scene | null }> {
  const r = await api().canvas.load(roomId);
  if (!r.ok) throw new RoomUnavailable(r.error.code, WORDS[r.error.code] ?? r.error.message);
  const doc = r.value.doc;
  if (!Object.keys(doc.components).length) return { doc, scene: null };
  try { return { doc, scene: buildScene(doc, doc.activeView) }; } catch { return { doc, scene: null }; }
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

/** Tells everyone else in the room that its people changed. `userId` is who it's about, when it's a person. */
function broadcastMembers(roomId: string, what: 'joined' | 'left' | 'removed' | 'role' | 'invitation', userId: string | null = null) {
  if (presence.has(roomId)) return api().rooms.send(roomId, 'members:changed', { what, userId }).then(() => {}, () => {});
  return Promise.resolve();
}

/* ---------- Having a room open: its Realtime channel, apart from its call. ---------- */

/** One open or close at a time per room, so a quick close-and-reopen can't leave the channel in the wrong state. */
const roomQueue = new Map<string, Promise<unknown>>();
const opened = new Map<string, number>();

function queued<T>(roomId: string, run: () => Promise<T>): Promise<T> {
  const next = (roomQueue.get(roomId) ?? Promise.resolve()).catch(() => {}).then(run);
  roomQueue.set(roomId, next);
  return next;
}

/** Connects to the room's channel, so its members see you there and you see them. Never joins the call. */
function enterRoom(roomId: string): Promise<void> {
  opened.set(roomId, (opened.get(roomId) ?? 0) + 1);
  return queued(roomId, async () => {
    if (!opened.get(roomId) || presence.has(roomId)) return;
    const session = await api().rooms.join(roomId);
    selfId = session.selfId;
    presence.set(roomId, session.participants);
    notify();
  });
}

function exitRoom(roomId: string): Promise<void> {
  const n = Math.max(0, (opened.get(roomId) ?? 0) - 1);
  if (n) opened.set(roomId, n); else opened.delete(roomId);
  return queued(roomId, async () => {
    if (opened.get(roomId) || voice()?.snapshot.roomId === roomId) return;
    try { await api().rooms.leave(roomId); } finally { presence.delete(roomId); notify(); }
  });
}

/** Someone you don't know yet has the room open: they just accepted an invitation. */
function newcomers(roomId: string, participants: Participant[]) {
  const members = known.get(roomId)?.members;
  if (members && participants.some((p) => !members.some((m) => m.userId === p.userId))) void loadAccess(roomId);
}

/** You may have lost the room: check with the database, never just the (self-reported) event. */
async function checkAccess(roomId: string, byId: string | null, kind: AccessLost['kind'] = 'removed') {
  const r = await api().rooms.get(roomId);
  if (r.ok) { void loadAccess(roomId); return; }
  if (r.error.code !== 'not-found') return;
  const by = byId ? known.get(roomId)?.members.find((m) => m.userId === byId) : undefined;
  lose(roomId, { kind, byName: by ? (by.name || by.email.split('@')[0]).split(/\s+/)[0] : undefined });
}

/** Tears a room down here: off its call, off its channel, out of the list. */
function lose(roomId: string, why: AccessLost) {
  lostRooms.set(roomId, { roomName: known.get(roomId)?.room.name, ...why });
  if (voice()?.snapshot.roomId === roomId) void voice()!.leave();
  opened.delete(roomId);
  void queued(roomId, () => api().rooms.leave(roomId)).catch(() => {});
  presence.delete(roomId);
  known.delete(roomId);
  invitations.delete(roomId);
  order = order.filter((id) => id !== roomId);
  notify();
}

let workTimer: ReturnType<typeof setTimeout> | null = null;

/** Starts listening once someone is signed in; safe to call more than once. */
export function startRealWorkspace() {
  if (started) return;
  started = true;
  const j = api();
  j.rooms.onEvent((e) => {
    if (e.type === 'record:changed') void changed(e.roomId);
    if (e.type === 'members:changed') {
      const { what, userId } = e.payload as { what: string; userId: string | null };
      if (userId && isMe(userId) && what === 'removed') void checkAccess(e.roomId, e.senderId);
      else void loadAccess(e.roomId).then(() => changed(e.roomId));
    }
  });
  j.rooms.onPresence(({ roomId, participants }) => { presence.set(roomId, participants); newcomers(roomId, participants); notify(); });
  // The server closed the channel: most often because you're no longer a member.
  j.rooms.onStatus(({ roomId, status }) => { if (status === 'left') { presence.delete(roomId); notify(); void checkAccess(roomId, null); } });
  j.canvas.onChanged(() => notify());
  startVoice();
  // Claude Code's live activity: whatever shows a room's work reads it again, a few seconds at most behind.
  j.claudeCode.onEvent(() => {
    if (workTimer) return;
    workTimer = setTimeout(() => { workTimer = null; notify(); }, 2500);
  });
  account.subscribe(() => {
    const user = account.state.user;
    if (user) void refresh();
    else {
      void voice()?.leave();
      known.clear(); order = []; presence.clear(); work.clear(); invitations.clear(); linkUrls.clear(); lostRooms.clear(); opened.clear();
      selfId = null; workspaceId = null; notify();
    }
  });
  if (account.state.user) void refresh();
  window.addEventListener('focus', () => { void recheckList(); });
  setInterval(() => { if (document.visibilityState === 'visible') void recheckList(); }, RECHECK_MS);
}

/** Rooms are made in a workspace; your first room makes one for you. */
async function ensureWorkspace(): Promise<string> {
  if (workspaceId) return workspaceId;
  const list = await api().workspaces.list();
  // Your own workspaces are listed first, so new rooms go in yours rather than one you were invited into.
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
  await readSpaceRepos(details.workspaceId);
  await read(roomId, details);
  notify();
}

const room: RoomDataSource = {
  list: () => order.map((id) => known.get(id)).filter((k): k is Known => !!k).map(summaryOf),
  subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  me,
  async create({ name, goal, repo, spaceId }) {
    const ws = spaceId ?? await ensureWorkspace();
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
    const { d, needsMe } = current(record, k.room.role);
    const attention: RoomPreview['attention'] = [];
    if (d && needsMe) {
      const by = who(d.proposedBy.id, d.proposedBy);
      attention.push({
        id: 'sign',
        text: `Decision v${d.version} needs your signature`,
        detail: `${by.tone === 'me' ? 'You' : by.name} proposed: ${d.title}.${d.verify.trim() ? ` Verify: ${d.verify.trim()}.` : ''} Sign it in the call, where the room can see it.`,
      });
    }
    return {
      room: summaryOf(k),
      goal: k.room.goal ? { text: k.room.goal, by: who(k.room.createdBy) } : null,
      since,
      recent: events.filter((e) => !since.includes(e)).slice(0, 5),
      attention,
      seenAt: last ?? null,
      lastView: await lastViewOf(roomId, who),
    };
  },
  visited(roomId) {
    api().record.seen(roomId).then(() => changed(roomId), () => {});
  },
  enter: enterRoom,
  exit: exitRoom,
  // The scripted canvas's cast; real rooms have members instead.
  attach,
  repos: localRepos,
  addRepo: addLocalRepo,
  async update(roomId, patch) {
    const details = await unwrap(api().rooms.update(roomId, patch));
    const k = known.get(roomId);
    if (k) k.room = { ...k.room, name: details.name, goal: details.goal };
    notify();
  },
  async keep(roomId, keep) {
    const details = await unwrap(api().rooms.keep(roomId, keep));
    const k = known.get(roomId);
    if (k) k.room = { ...k.room, keptAt: details.keptAt };
    notify();
  },
  spaces: () => spaceList.map((w): SpaceSummary => ({
    id: w.id, name: w.name, repos: spaceRepos.get(w.id) ?? [], role: isMe(w.createdBy) ? 'owner' : 'member',
  })),
  async localRepos() {
    const [repos, ids] = await Promise.all([api().repos.list(), api().repos.identities()]);
    const identity = new Map(ids.map((r) => [r.id, r.identity]));
    return repos.map((r): LocalRepo => ({ id: r.id, label: r.name, identity: identity.get(r.id) ?? null }));
  },
  async createSpace({ name, repos }) {
    const made = await api().workspaces.create(name);
    if (!workspaceId) workspaceId = made.id;
    // A repository that can't be linked (no shareable remote) leaves the Space made, with the rest linked.
    const failed: string[] = [];
    for (const id of repos) await unwrap(api().workspaces.link(made.id, id)).catch((err: Error) => failed.push(err.message));
    await readSpaces();
    notify();
    if (failed.length) console.warn('[spaces] some repositories weren’t linked', failed);
    return room.spaces!().find((w) => w.id === made.id) ?? { id: made.id, name: made.name, repos: [], role: 'owner' };
  },
  async renameSpace(spaceId, name) {
    await unwrap(api().workspaces.rename(spaceId, name));
    spaceList = spaceList.map((w) => (w.id === spaceId ? { ...w, name } : w));
    notify();
  },
  async linkRepo(spaceId, repoId) {
    await unwrap(api().workspaces.link(spaceId, repoId));
    await readSpaceRepos(spaceId);
    work.clear();
    notify();
  },
  async unlinkRepo(spaceId, repository) {
    await unwrap(api().workspaces.unlink(spaceId, repository));
    await readSpaceRepos(spaceId);
    work.clear();
    notify();
  },
};

/** Why a room's repository couldn't be attached when it was made. */
export const attachErrors = new Map<string, string>();

/* ---------- The call: LiveKit audio, announced in the room's presence. ---------- */

let callService: CallService | null = null;
/** The voice call, one at a time across rooms. Null in the browser preview, which has no main process. */
export function voice(): CallService | null {
  if (!callService && window.journey) callService = new CallService(window.journey.calls);
  return callService;
}

/** What the app does when the call ends without you asking: set by app.tsx (the call session). */
export const callEnded: { dropped(roomId: string): void; ended(roomId: string): void } = { dropped: () => {}, ended: () => {} };

let announced: { roomId: string; muted: boolean } | null = null;
function startVoice() {
  const v = voice();
  if (!v) return;
  // Your presence says whether you're on the call, and muted, from the call itself.
  v.onChange((snap) => {
    const on = snap.roomId && (snap.status === 'connected' || snap.status === 'reconnecting') ? { roomId: snap.roomId, muted: !snap.micEnabled } : null;
    if (on && (!announced || announced.roomId !== on.roomId || announced.muted !== on.muted)) {
      if (announced && announced.roomId !== on.roomId) void api().rooms.setCall(announced.roomId, null);
      announced = on;
      void api().rooms.setCall(on.roomId, { muted: on.muted });
    } else if (!on && announced) {
      void api().rooms.setCall(announced.roomId, null);
      announced = null;
    }
    notify();
  });
  v.onEvent((e) => {
    if (e.type === 'dropped') callEnded.dropped(e.roomId);
    // Taken off the call by the room (removed, or the call closed): see whether you still have the room.
    if (e.type === 'ended' && e.reason) { callEnded.ended(e.roomId); void checkAccess(e.roomId, null); }
  });
}

const call: CallDataSource = {
  async join(roomId) {
    const v = voice();
    if (!v) throw new Error('Calls need the app.');
    await enterRoom(roomId);
    await v.join(roomId);
    await unwrap(api().record.call(roomId, 'call-started')).catch(() => {});
    await changed(roomId);
  },
  async leave(roomId) {
    // Leaving the call keeps the room open: only its channel's call flag changes.
    await voice()?.leave();
    await unwrap(api().record.call(roomId, 'call-left')).catch(() => {});
    await exitRoom(roomId);
    await changed(roomId);
  },
  setMuted: (muted) => { void voice()?.setMicrophoneEnabled(!muted).catch(() => {}); },
  // Captions aren't connected in this build; the call bar says so.
  setCaptions: () => {},
};

/* ---------- Work: your clone of the room's repository, read on this machine. ---------- */

const workSource: WorkstreamDataSource = {
  async context(roomId) {
    const generatedAt = new Date().toISOString();
    const checkouts = await unwrap(api().rooms.checkouts(roomId));
    const repos = checkouts.map((c) => ({ repo: c.repository, here: c.repositoryId !== null }));
    const repo = checkouts[0]?.repository ?? null;
    if (!repo) return { repo: null, repos, generatedAt, workstreams: [] };
    const here = checkouts.filter((c): c is typeof c & { repositoryId: string } => c.repositoryId !== null);
    if (!here.length) {
      const which = checkouts.length === 1 ? `${repo} isn’t` : 'None of this Space’s repositories are';
      return { repo, repos, generatedAt, workstreams: [], unavailable: `${which} added on this machine, so their Claude Code sessions can’t be read here. Add your clone.` };
    }
    // One repository that can't be read leaves the others' work showing.
    const contexts = (await Promise.all(here.map(async (c) => {
      const context = await api().context.work(c.repositoryId).catch(() => null);
      return context && { repository: c.repository, repositoryId: c.repositoryId, context };
    }))).filter((c) => c !== null);
    const workstreams = contexts
      .flatMap(({ repository, context }) => toRoomWorkContext(context).workstreams.map((w) => ({ ...w, repo: repository })))
      .sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
    const shown: RoomWorkContext = { repo, repos, generatedAt, workstreams };
    work.set(roomId, { contexts, room: shown });
    return shown;
  },
  async transcript(roomId, streamId) {
    const found = work.get(roomId)?.contexts
      .map((c) => ({ ...c, stream: c.context.workstreams.find((s) => s.id === streamId) }))
      .find((c) => c.stream);
    if (!found?.stream) throw new Error('This workstream isn’t in the room’s work any more.');
    const linked = new Set(found.stream.sessions.map((s) => s.sessionId));
    const session = found.context.sessions.find((s) => linked.has(s.id));
    if (!session) throw new Error('No Claude Code session is linked to this workstream.');
    const page = await api().claudeCode.messages(found.repositoryId, session.id, { limit: 40 });
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
  // Viewers can't sign, so a decision is agreed once its owners and members have.
  const approvers = members.filter((m) => m.role !== 'viewer').map((m) => ({ personId: m.userId, signedVersion: best(m.userId) }));
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

/** Vowe in the panel: its replies show its orb, whoever's app wrote them. */
export const VOWE: PanelPerson = { id: 'vowe', name: 'Vowe', initials: 'V', kind: 'agent' };

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
    if (rec.threads.some((t) => t.replies.some((r) => r.authorKind === 'agent'))) people[VOWE.id] = VOWE;
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
    const calling = presence.get(roomId)?.filter((p) => p.call).length ?? 0;
    const view: RoomRecordView = {
      panel: {
        people,
        meId,
        subtitle: here ? `${here} here${calling ? ` · ${calling} on the call` : ''}` : undefined,
        goal: k.room.goal ? { text: k.room.goal, by: k.room.createdBy } : undefined,
        decision: d ? decisionOf(d, k.members) : undefined,
        threads: rec.threads.map((t) => ({
          id: t.id,
          kind: t.kind,
          anchor: { id: t.anchor.id === 'pin' ? `pin:${t.id}` : t.anchor.id, name: t.anchor.name },
          root: { id: `${t.id}-root`, authorId: t.author.id, body: t.body, ago: shortAgo(t.createdAt) },
          replies: t.replies.map((r) => ({ id: r.id, authorId: r.authorKind === 'agent' ? VOWE.id : r.author.id, body: r.body, ago: shortAgo(r.createdAt), fresh: Date.now() - Date.parse(r.createdAt) < 4000 })),
        })),
        streams,
      },
      pins: rec.threads.flatMap((t) => t.anchor.x !== null && t.anchor.y !== null
        ? [{ threadId: t.id, anchor: t.anchor.id === 'pin' ? `pin:${t.id}` : t.anchor.id, x: t.anchor.x, y: t.anchor.y, body: t.body, author: who(t.author.id, t.author) }] : []),
      decision: d ? { id: d.id, title: d.title, verify: d.verify } : null,
    };
    return view;
  },
  subscribe: (_roomId, listener) => room.subscribe(listener),
  async pin(roomId, at, body, on) {
    const anchor = on ? { id: on.component, name: on.name } : { id: 'pin', name: 'Canvas' };
    const thread = await unwrap(api().record.addThread(roomId, { kind: 'note', anchor: { ...anchor, x: Math.round(at.x), y: Math.round(at.y) }, body }));
    broadcast(roomId, 'thread');
    await changed(roomId);
    return thread.id;
  },
  async resolve(roomId, threadId) {
    await unwrap(api().record.resolve(roomId, threadId));
    broadcast(roomId, 'thread');
    await changed(roomId);
  },
  async reply(roomId, threadId, body, as) {
    await unwrap(api().record.reply(roomId, threadId, body, as === 'vowe' ? 'agent' : 'human'));
    broadcast(roomId, 'reply');
    await changed(roomId);
  },
  async sign(roomId, decisionId, version) {
    notAsViewer(roomId, 'sign decisions');
    await unwrap(api().record.sign(roomId, decisionId, version));
    broadcast(roomId, 'signature');
    await changed(roomId);
  },
  async propose(roomId, d) {
    notAsViewer(roomId, 'propose decisions');
    await unwrap(api().record.propose(roomId, d));
    broadcast(roomId, 'decision');
    await changed(roomId);
  },
  async amend(roomId, decisionId, change) {
    notAsViewer(roomId, 'change decisions');
    await unwrap(api().record.amend(roomId, decisionId, change));
    broadcast(roomId, 'decision');
    await changed(roomId);
  },
};

/** Viewers read, comment and listen. The database refuses the rest anyway; this says so before asking it. */
function notAsViewer(roomId: string, what: string) {
  if (known.get(roomId)?.room.role === 'viewer') throw new RoomUnavailable('permission-denied', `Viewers can’t ${what}. Ask an owner to make you a member.`);
}

/* ---------- Membership: who's in each room, their invitations, and changing them. ---------- */

const MEMBER_TONES: User['tone'][] = ['peer', 'peer2', 'peer3'];

function failure(e: RoomFailure): Result & { ok: false } {
  if (e.reason) return { ok: false, error: e.reason as MembershipError, detail: e.code === 'invalid' ? e.message : undefined };
  const error: MembershipError = { network: 'network', 'permission-denied': 'not_permitted', conflict: 'last_owner', 'not-found': 'room_gone' }[e.code as string] as MembershipError
    ?? 'not_permitted';
  return { ok: false, error, detail: e.code === 'invalid' || e.code === 'unknown' || e.code === 'signed-out' || e.code === 'not-configured' ? e.message : undefined };
}

/** Runs a change, then re-reads the room's access and tells the others in it. */
async function change(roomId: string, run: () => Promise<RoomResult<unknown>>, what: Parameters<typeof broadcastMembers>[1], userId: string | null = null): Promise<Result> {
  let r: RoomResult<unknown>;
  try { r = await run(); } catch (err) { return { ok: false, error: 'network', detail: (err as Error).message }; }
  if (!r.ok) return failure(r.error);
  await loadAccess(roomId);
  await broadcastMembers(roomId, what, userId);
  return { ok: true };
}

async function loadAccess(roomId: string): Promise<void> {
  try {
    const [members, invites, room] = await Promise.all([
      unwrap(api().rooms.members(roomId)), unwrap(api().invites.list(roomId)), unwrap(api().rooms.get(roomId)),
    ]);
    learnSelf(members);
    const k = known.get(roomId);
    known.set(roomId, { room, record: k?.record ?? null, members });
    invitations.set(roomId, invites);
  } catch (err) {
    if (err instanceof RoomUnavailable && err.code === 'not-found' && opened.has(roomId)) lose(roomId, { kind: 'room_gone' });
  }
  notify();
}

const expiryOf = (inv: RoomInvitation): LinkExpiry => {
  const days = (Date.parse(inv.expiresAt) - Date.parse(inv.sentAt)) / 86_400_000;
  return days <= 1.01 ? '24h' : days <= 7.01 ? '7d' : '30d';
};

const CONSUMER = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'yahoo.com']);

function accessOf(roomId: string): RoomAccess | null {
  const k = known.get(roomId);
  if (!k || !k.members.length || !selfId) return null;
  const order = [...k.members].sort((a, b) => Date.parse(a.joinedAt) - Date.parse(b.joinedAt));
  const others = order.filter((m) => !isMe(m.userId));
  const users: Record<string, User> = {};
  for (const m of order) {
    const name = m.name || m.email.split('@')[0];
    users[m.userId] = {
      id: m.userId, name: isMe(m.userId) ? (account.state.user?.name || name) : name, email: m.email, initials: initials(name) || '?',
      tone: isMe(m.userId) ? 'me' : MEMBER_TONES[others.indexOf(m) % MEMBER_TONES.length],
    };
  }
  const here = new Map((presence.get(roomId) ?? []).map((p) => [p.userId, p]));
  const snap = voice()?.snapshot;
  const onCall = snap && snap.roomId === roomId ? new Map(snap.participants.map((p) => [p.identity, p])) : new Map();
  const members: Member[] = order.map((m) => {
    const p = here.get(m.userId);
    const live = onCall.get(m.userId);
    return {
      userId: m.userId, role: m.role, joinedAt: Date.parse(m.joinedAt),
      presence: live || p?.call ? 'call' : p ? 'room' : 'away',
      speaking: live?.isSpeaking ?? false,
      muted: live ? live.isMuted : p?.call?.muted,
    };
  });
  const all = invitations.get(roomId) ?? [];
  const invites: Invitation[] = all.filter((i) => i.kind === 'email' && i.email).map((i) => ({
    id: i.id, email: i.email!, role: i.role, status: i.status, invitedBy: i.invitedBy, sentAt: Date.parse(i.sentAt), expiresAt: Date.parse(i.expiresAt),
    acceptedAt: i.acceptedAt ? Date.parse(i.acceptedAt) : undefined, revokedAt: i.revokedAt ? Date.parse(i.revokedAt) : undefined, resends: i.resends,
  }));
  const newest = all.find((i) => i.kind === 'link');
  const link: InviteLink | null = newest ? {
    id: newest.id, url: linkUrls.get(newest.id) ?? null, role: newest.role, expiry: expiryOf(newest), expiresAt: Date.parse(newest.expiresAt),
    domain: newest.domain, status: newest.status === 'pending' ? 'active' : newest.status === 'revoked' ? 'revoked' : 'expired', uses: newest.uses,
    createdBy: newest.invitedBy,
  } : null;
  const owner = order.find((m) => m.role === 'owner' && !isMe(m.userId)) ?? order.find((m) => m.role === 'owner');
  const domain = account.state.user?.email?.split('@')[1]?.toLowerCase() ?? null;
  return {
    roomId, roomName: k.room.name, viewerId: selfId, users, members, invites, link,
    ownerName: owner ? (isMe(owner.userId) ? 'an owner' : users[owner.userId].name.split(/\s+/)[0]) : 'an owner',
    domain: domain && !CONSUMER.has(domain) ? domain : null,
  };
}

const membership: MembershipSource = {
  access: accessOf,
  load: loadAccess,
  subscribe: (listener) => room.subscribe(listener),
  async invite(roomId, emails, role) {
    return change(roomId, () => api().invites.send(roomId, emails, role), 'invitation');
  },
  async resend(roomId, invitationId) {
    const inv = invitations.get(roomId)?.find((i) => i.id === invitationId);
    if (!inv?.email) return { ok: false, error: 'invite_not_found' };
    return change(roomId, () => api().invites.send(roomId, [inv.email!], inv.role), 'invitation');
  },
  async revokeInvite(roomId, invitationId) {
    return change(roomId, () => api().invites.revoke(invitationId), 'invitation');
  },
  async createLink(roomId, settings) {
    return change(roomId, async () => {
      const r = await api().invites.createLink(roomId, settings);
      if (r.ok) linkUrls.set(r.value.invitation.id, r.value.url);
      return r;
    }, 'invitation');
  },
  async revokeLink(roomId) {
    const live = invitations.get(roomId)?.find((i) => i.kind === 'link' && i.status === 'pending');
    if (!live) return { ok: true };
    const r = await change(roomId, () => api().invites.revoke(live.id), 'invitation');
    if (r.ok) linkUrls.delete(live.id);
    return r;
  },
  async changeRole(roomId, userId, role: RoomRole) {
    return change(roomId, () => api().rooms.setMemberRole(roomId, userId, role), 'role', userId);
  },
  async remove(roomId, userId) {
    return change(roomId, () => api().rooms.removeMember(roomId, userId), 'removed', userId);
  },
  async leave(roomId) {
    if (voice()?.snapshot.roomId === roomId) await voice()!.leave();
    // Said before going, while you can still reach the room's channel.
    await broadcastMembers(roomId, 'left', selfId);
    let r: RoomResult<void>;
    try { r = await api().rooms.removeMember(roomId); } catch (err) { return { ok: false, error: 'network', detail: (err as Error).message }; }
    if (!r.ok) return failure(r.error);
    lose(roomId, { kind: 'left', byName: undefined });
    void refresh();
    return { ok: true };
  },
  lost: (roomId) => lostRooms.get(roomId) ?? null,
  dismissLost: (roomId) => { lostRooms.delete(roomId); notify(); },
};

/** Your side of invitations: what's waiting for you, and redeeming a link someone shared. */
const invites: InviteSource = {
  async mine() { return unwrap(api().invites.mine()); },
  async resolve(key) { return unwrap(api().invites.resolve(key)); },
  async decline(invitationId) { return unwrap(api().invites.decline(invitationId)); },
  async accept(key) {
    const r = await api().invites.accept(key);
    if (!r.ok) throw Object.assign(new RoomUnavailable(r.error.code, r.error.message), { reason: r.error.reason });
    lostRooms.delete(r.value);
    await refresh();
    return r.value;
  },
};

/* ---------- Home: across your rooms, from what's already read, plus this machine's repositories. ---------- */

/**
 * Your clone of each room's repository (rooms.checkout): the checkout, or null when this machine has
 * none. Rooms without a repository, and rooms whose checkout couldn't be read, are left out.
 */
export async function roomCheckouts(roomIds: string[]): Promise<Map<string, RoomCheckout | null>> {
  const out = new Map<string, RoomCheckout | null>();
  await Promise.all(roomIds.filter((id) => known.get(id)?.room.repository).map(async (id) => {
    const r = await api().rooms.checkout(id).catch(() => null);
    if (r?.ok) out.set(id, r.value);
  }));
  return out;
}

/** This machine's repositories, as added (paths stay on this machine). */
export const repositories = {
  list: () => api().repos.list(),
  add: () => api().repos.add(),
  remove: (id: string) => api().repos.remove(id),
  detect: () => api().repos.detect(),
  addDetected: (path: string) => api().repos.addDetected(path),
};

/**
 * Claude Code work in the repositories added on this machine, most recent first. A repository whose
 * work can't be read is skipped, never guessed at.
 */
export async function localWork(repos: Repository[]): Promise<{ repository: string; stream: RoomWorkContext['workstreams'][number] }[]> {
  const all = await Promise.all(repos.map((r) => api().context.work(r.id).then(
    (ctx) => toRoomWorkContext(ctx).workstreams.map((stream) => ({ repository: r.name, stream })),
    () => [],
  )));
  return all.flat().sort((a, b) => Date.parse(b.stream.lastActivityAt ?? '0') - Date.parse(a.stream.lastActivityAt ?? '0'));
}

/** The Vowe room's services (Desk), over IPC. */
const vowe = createVoweServices();

/** Your Inbox marks on your account (inbox_state). Failures keep the server's own words: they say what's missing. */
export const inboxMarks = {
  async get() { const r = await api().inbox.getState(); if (r.ok) return r.value; throw new RoomUnavailable(r.error.code, r.error.code === 'network' ? WORDS.network! : r.error.message); },
  async save(marks: unknown) { const r = await api().inbox.saveState(marks); if (r.ok) return r.value; throw new RoomUnavailable(r.error.code, r.error.code === 'network' ? WORDS.network! : r.error.message); },
};

export const realWorkspace = { room, call, work: workSource, record, membership, invites, vowe };
export type RealWorkspace = typeof realWorkspace;
