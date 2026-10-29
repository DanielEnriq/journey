import { Store } from '../../shared/store.js';
import type { IncomingInvitation, InviteKey, RoomResult } from '../../../shared/api.js';
import type { Scene } from '../../../shared/canvas/index.js';
import { AGENT, type VoweRecord } from '../vowe-room/contracts/model.js';
import type { VoweServices } from '../vowe-room/contracts/services.js';
import type { PersonId } from '../vowe-room/journey.js';
import type { RoomSummary } from '../room/types.js';
import { agentPerson, derive, doneKey, inviterPerson, SERVER_DONE_PREFIX, type InvitationInput, type RoomInput } from './derive.js';
import { MarksStore, type RemoteMarks, type StorageLike } from './marks.js';
import type { InboxItem, InboxMarks, InboxView, Source } from './model.js';
import type { InboxPerson, InboxSource, InboxState, ItemContext } from './source.js';

// The Inbox over a workspace's rooms: reads every room's record through the same services the room uses
// (cached; re-read on record:changed, when your rooms change and when the window gets focus; a few at a
// time), plus your invitations, derives the view and publishes it. Every act goes through those services,
// so the Inbox can't do anything the Desk couldn't. No window globals here: real.ts binds it.

export interface InboxDeps {
  services: Pick<VoweServices, 'record' | 'threads' | 'decisions' | 'work' | 'attention'>;
  rooms: { list(): RoomSummary[]; subscribe(fn: () => void): () => void };
  invites: { mine(): Promise<IncomingInvitation[]>; accept(key: InviteKey): Promise<string>; decline?(invitationId: string): Promise<void> } | null;
  /** You, before any record says (the workspace's own idea of your cloud user id). */
  me(): PersonId | null;
  /** Where marks are kept; null keeps them in memory only. */
  storage: StorageLike | null;
  /** Your account's copy of the marks, so they follow you between devices; null keeps them on this machine. */
  remoteMarks?: RemoteMarks | null;
  now?: () => Date;
  scene?(roomId: string): Promise<Scene | null>;
  /** Window focus; the source re-reads on it. */
  onFocus?(fn: () => void): () => void;
  /** Reads at once. */
  concurrency?: number;
  /** How long a Done can be undone before it's written to the server. */
  undoMs?: number;
  /** Sources this workspace can't produce (shown as "not in Journey yet"). */
  unavailable?: Source[];
}

export const NOT_IN_JOURNEY: Source[] = ['runner', 'github'];
const EMPTY_VIEW: InboxView = { needs: [], following: [], activity: [], resolved: [], snoozed: [], away: null };
const NO_MARKS: InboxMarks = { seen: {}, done: {}, snoozed: {}, follow: {}, mutedRooms: [] };
const TONES: InboxPerson['tone'][] = ['peer', 'p2', 'p3'];

const initialsOf = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';

interface Cached { record: VoweRecord | null; error: string | null; at: number }

export interface InboxController extends InboxSource {
  /** Stops listening and writes any pending Done marks now. */
  dispose(): void;
  /** For tests: resolves once nothing is being read. */
  idle(): Promise<void>;
  /** You're here now (what the next session's "Since …" counts from). */
  touch(): void;
}

export function createInboxSource(deps: InboxDeps): InboxController {
  const now = () => (deps.now ?? (() => new Date()))();
  const iso = () => now().toISOString();
  const limit = Math.max(1, deps.concurrency ?? 4);
  const undoMs = deps.undoMs ?? 6000;
  const store = new Store<InboxState>({
    status: 'loading', error: null, view: EMPTY_VIEW, now: iso(), me: null, people: {}, needsCount: 0, unavailable: deps.unavailable ?? NOT_IN_JOURNEY,
  });
  const cache = new Map<string, Cached>();
  const subs = new Map<string, () => void>();
  const queue: string[] = [];
  const reading = new Set<string>();
  let invitations: IncomingInvitation[] = [];
  let invitesRead = false;
  let marks: MarksStore | null = null;
  let offMarks: (() => void) | null = null;
  let disposed = false;
  const pendingDone = new Map<string, { roomId: string; key: string; timer: ReturnType<typeof setTimeout> }>();
  const idleWaiters: (() => void)[] = [];

  const roomList = () => deps.rooms.list();
  const meNow = (): PersonId | null => {
    for (const c of cache.values()) if (c.record?.me) return c.record.me;
    return deps.me();
  };
  /** The marks store for whoever is signed in, made the first time we know who that is. */
  const marksFor = (me: PersonId | null): MarksStore | null => {
    if (!me) return null;
    if (marks?.userId !== me) {
      offMarks?.();
      void marks?.flush();
      const m = marks = new MarksStore(me, deps.storage, iso, deps.remoteMarks ?? null);
      const offs = [m.store.subscribe(() => publish()), m.kept.subscribe(() => publish())];
      offMarks = () => offs.forEach((off) => off());
      void m.sync();
    }
    return marks;
  };

  function people(me: PersonId, rooms: RoomInput[]): Record<PersonId, InboxPerson> {
    const names = new Map<PersonId, string>();
    let agent = 'Vowe';
    for (const r of rooms) {
      for (const m of r.record.members) if (m.name && !names.has(m.who)) names.set(m.who, m.name);
      if (r.record.agentName) agent = r.record.agentName;
      for (const w of r.record.work) {
        if (w.doer?.kind === 'agent') names.set(agentPerson(w.doer.name), w.doer.name);
        if (w.scopeAsk) names.set(agentPerson(w.scopeAsk.by), w.scopeAsk.by);
      }
    }
    for (const i of invitations) names.set(inviterPerson(i.id), i.inviterName);
    const out: Record<PersonId, InboxPerson> = {};
    out[AGENT] = { id: AGENT, name: agent, initials: initialsOf(agent).slice(0, 1), tone: 'peer' };
    const others = [...names.keys()].filter((id) => id !== me && id !== AGENT).sort();
    others.forEach((id, i) => { const name = names.get(id)!; out[id] = { id, name, initials: initialsOf(name), tone: TONES[i % TONES.length] }; });
    out[me] = { id: me, name: 'You', initials: initialsOf(names.get(me) ?? 'You'), tone: 'me' };
    return out;
  }

  function publish() {
    if (disposed) return;
    const me = meNow();
    const list = roomList();
    const m = marksFor(me);
    const rooms: RoomInput[] = list.flatMap((r) => {
      const c = cache.get(r.id);
      return c?.record ? [{ id: r.id, name: r.name, role: r.role ?? null, record: c.record }] : [];
    });
    const tried = list.filter((r) => cache.has(r.id)).length;
    const failed = list.filter((r) => cache.get(r.id)?.error && !cache.get(r.id)?.record);
    const first = tried < list.length || (deps.invites && !invitesRead);
    if (!me) {
      store.setState({ status: first ? 'loading' : list.length ? 'failed' : 'ready', error: !first && list.length ? (failed[0] ? cache.get(failed[0].id)!.error : 'Couldn’t tell who you are yet') : null, now: iso() });
      return;
    }
    const lm = m?.marks;
    const invs: InvitationInput[] = invitations
      .filter((i) => !lm?.declined.includes(i.id) && !list.some((r) => r.id === i.roomId))
      .map((i) => ({ id: i.id, roomId: i.roomId, roomName: i.roomName, role: i.role, fromName: i.inviterName, at: i.sentAt }));
    const ppl = people(me, rooms);
    const view = derive({
      me, now: iso(), lastHere: m?.lastHere ?? null, rooms, invitations: invs,
      marks: lm ? { seen: lm.seen, done: lm.done, snoozed: lm.snoozed, follow: lm.follow, mutedRooms: lm.mutedRooms } : NO_MARKS,
      serverDone: rooms.flatMap((r) => r.record.done),
      nameOf: (id) => ppl[id]?.name ?? (id === me ? 'You' : 'Someone'),
    });
    const allFailed = list.length > 0 && failed.length === list.length;
    store.setState({
      status: allFailed && !first ? 'failed' : first && !rooms.length ? 'loading' : 'ready',
      error: failed.length ? `Couldn’t read ${failed.length === 1 ? `“${failed[0].name}”` : `${failed.length} of your rooms`}: ${cache.get(failed[0].id)!.error}` : null,
      view, now: iso(), me, people: ppl, needsCount: view.needs.length, marksKept: m?.kept.state.kept ?? null,
    });
  }

  function pump() {
    while (!disposed && reading.size < limit && queue.length) {
      const id = queue.shift()!;
      if (reading.has(id)) continue;
      reading.add(id);
      void deps.services.record.load(id).then(
        (res) => { if (roomList().some((r) => r.id === id)) cache.set(id, res.ok ? { record: res.value, error: null, at: Date.now() } : { record: cache.get(id)?.record ?? null, error: res.error.message || res.error.code, at: Date.now() }); },
        (err: Error) => { cache.set(id, { record: cache.get(id)?.record ?? null, error: err.message, at: Date.now() }); },
      ).finally(() => {
        reading.delete(id);
        publish();
        pump();
        if (!reading.size && !queue.length) idleWaiters.splice(0).forEach((f) => f());
      });
    }
  }
  const read = (id: string) => { if (!queue.includes(id)) queue.push(id); pump(); };

  function readInvites() {
    if (!deps.invites) return;
    deps.invites.mine().then((list) => { invitations = list; }, () => { /* keep the last list */ }).finally(() => { invitesRead = true; publish(); });
  }

  function sync() {
    const ids = new Set(roomList().map((r) => r.id));
    for (const [id, off] of subs) if (!ids.has(id)) { off(); subs.delete(id); cache.delete(id); }
    for (const id of ids) if (!subs.has(id)) { subs.set(id, deps.services.record.subscribe(id, () => read(id))); read(id); }
    publish();
  }

  const offRooms = deps.rooms.subscribe(() => { sync(); });
  let lastFocus = 0;
  const offFocus = deps.onFocus?.(() => { if (Date.now() - lastFocus > 10_000) { lastFocus = Date.now(); refresh(); } }) ?? (() => {});
  // "3m ago" moves and snoozes expire: re-derive every minute.
  const tick = setInterval(publish, 60_000);
  (tick as { unref?: () => void }).unref?.();

  function refresh() {
    for (const r of roomList()) read(r.id);
    readInvites();
  }

  sync();
  readInvites();

  /* ---------- acts ---------- */

  const recordOf = (item: InboxItem): VoweRecord => {
    const r = cache.get(item.room.id)?.record;
    if (!r) throw new Error('That room’s record isn’t loaded yet. Try again in a moment.');
    return r;
  };
  async function run(roomId: string, res: Promise<RoomResult<unknown>>) {
    const r = await res;
    if (!r.ok) throw new Error(r.error.message || 'That didn’t go through.');
    read(roomId);
  }
  const decisionOf = (item: InboxItem) => {
    const d = recordOf(item).decisions.find((x) => x.id === item.subject.id);
    if (!d) throw new Error('That decision isn’t in the room any more.');
    return d;
  };
  const workOf = (item: InboxItem) => {
    const r = recordOf(item);
    const w = item.subject.kind === 'question' ? r.work.find((x) => x.question?.id === item.subject.id) : r.work.find((x) => x.id === item.subject.id);
    if (!w) throw new Error('That plan isn’t in the room any more.');
    return w;
  };
  function flushDone(id: string) {
    const p = pendingDone.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    pendingDone.delete(id);
    void deps.services.attention.markDone(p.roomId, [SERVER_DONE_PREFIX + p.key]).catch(() => { /* kept locally */ });
  }

  const source: InboxController = {
    store,
    refresh,
    async context(roomId): Promise<ItemContext> {
      let record = cache.get(roomId)?.record ?? null;
      if (!record) { const r = await deps.services.record.load(roomId); record = r.ok ? r.value : null; }
      const scene = deps.scene ? await deps.scene(roomId).catch(() => null) : null;
      return { record, scene };
    },
    seen(item) { marks?.seen(item.id, item.events.length); },
    unread(item) { marks?.unseen(item.id); },
    done(item) {
      if (item.tier === 'needs' || !marks) return () => {};
      const key = doneKey(item);
      marks.done(key);
      marks.seen(item.id, item.events.length);
      flushDone(item.id);
      pendingDone.set(item.id, { roomId: item.room.id, key, timer: setTimeout(() => flushDone(item.id), undoMs) });
      return () => {
        const p = pendingDone.get(item.id);
        if (p) { clearTimeout(p.timer); pendingDone.delete(item.id); }
        marks?.undone(key);
      };
    },
    snooze(item, until, label) { marks?.snooze(item.id, until, label); },
    unsnooze(id) { marks?.unsnooze(id); },
    follow(item, on) { marks?.follow(item.subject.id, on); },
    muteRoom(roomId, on) { marks?.mute(roomId, on); },

    async sign(item) {
      const d = decisionOf(item);
      await run(item.room.id, deps.services.decisions.sign(item.room.id, d.id, d.version));
    },
    async requestChanges(item, text) {
      const d = decisionOf(item);
      if (!text.trim()) throw new Error('Say what should change.');
      await run(item.room.id, deps.services.decisions.requestChanges(item.room.id, d.id, d.version, text.trim()));
    },
    async answer(item, text) {
      if (!text.trim()) throw new Error('Write an answer first.');
      if (item.subject.kind === 'thread') { await source.reply(item, text); return; }
      const w = workOf(item);
      if (!w.question || w.question.id !== item.subject.id) throw new Error('That question was already answered.');
      await run(item.room.id, deps.services.work.answer(item.room.id, w.id, w.question.id, text.trim()));
    },
    async reply(item, body) {
      if (!body.trim()) throw new Error('Write a reply first.');
      if (item.subject.kind !== 'thread') throw new Error('Only a thread takes a reply.');
      await run(item.room.id, deps.services.threads.reply(item.room.id, item.subject.id, body.trim()));
    },
    async authorize(item) {
      const w = workOf(item);
      await run(item.room.id, deps.services.work.authorize(item.room.id, w.id, w.version));
    },
    async allowScope(item, allow) {
      const w = workOf(item);
      await run(item.room.id, deps.services.work.allowScope(item.room.id, w.id, allow));
    },
    async acceptInvitation(item, yes) {
      if (item.subject.kind !== 'invitation') throw new Error('That isn’t an invitation.');
      if (!yes) {
        marks?.decline(item.subject.id); // hidden at once; the server's list drops it too
        publish();
        if (deps.invites?.decline) {
          try { await deps.invites.decline(item.subject.id); } catch (e) {
            throw new Error(`Hidden on this machine only: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        return null;
      }
      if (!deps.invites) throw new Error('Invitations aren’t available here.');
      const roomId = await deps.invites.accept({ invitationId: item.subject.id });
      invitations = invitations.filter((i) => i.id !== item.subject.id);
      readInvites();
      return roomId;
    },

    dispose() {
      disposed = true;
      for (const id of [...pendingDone.keys()]) flushDone(id);
      void marks?.flush();
      offRooms(); offFocus(); offMarks?.(); clearInterval(tick);
      for (const off of subs.values()) off();
      subs.clear();
    },
    touch() { marks?.touch(); },
    idle: () => (reading.size || queue.length ? new Promise<void>((r) => idleWaiters.push(r)) : Promise.resolve()),
  };
  return source;
}

/** Keeps "when you were last here" current while the window is in use. */
export function trackPresence(source: { touch(): void } | null, win: Pick<Window, 'addEventListener' | 'removeEventListener'>, doc: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>): () => void {
  const touch = () => source?.touch();
  const vis = () => { if (doc.visibilityState === 'hidden') touch(); };
  win.addEventListener('blur', touch);
  win.addEventListener('beforeunload', touch);
  doc.addEventListener('visibilitychange', vis);
  const t = setInterval(touch, 60_000);
  return () => { win.removeEventListener('blur', touch); win.removeEventListener('beforeunload', touch); doc.removeEventListener('visibilitychange', vis); clearInterval(t); };
}
