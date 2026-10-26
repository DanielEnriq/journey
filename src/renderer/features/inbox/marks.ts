import { Store } from '../../shared/store.js';
import type { InboxMarks } from './model.js';

// What you did to Inbox items, per person: seen counts, snoozes, follows, muted rooms, declined invitations,
// and when you were last active (for "Since Friday"). Kept on this machine first so every mark is instant,
// and written to your account (inbox_state) so they follow you to other devices; the newest copy wins.
// Done marks also go to the room (attention_done), and declines to the invitation itself (records.ts).
// Versioned, and every storage access is guarded.

export interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }

export interface LocalMarks extends InboxMarks {
  /** Invitations you declined: hidden at once, before the server's list catches up. */
  declined: string[];
  /** The last time this app was in use by you (updated while you're here). */
  lastActive: string | null;
  /** When these marks last changed, on any device: the newer copy wins. */
  updatedAt: string | null;
}

/** Your account's copy of the marks (inbox_state). Rejects with a message when it can't be reached. */
export interface RemoteMarks {
  get(): Promise<{ marks: unknown; updatedAt: string } | null>;
  save(marks: unknown): Promise<string>;
}

/** Where your marks are kept right now: on your account, or only here (the reason says why). */
export type MarksKept = { on: 'account' } | { on: 'device'; reason: string };

export const MARKS_VERSION = 1;
export const marksKey = (userId: string) => `vowe.inbox.v${MARKS_VERSION}:${userId}`;
export const EMPTY_MARKS: LocalMarks = { seen: {}, done: {}, snoozed: {}, follow: {}, mutedRooms: [], declined: [], lastActive: null, updatedAt: null };

const DAY = 86_400_000;
const MAX_SEEN = 2000;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

const isTime = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));

/** Reads the marks, dropping anything malformed and anything old enough not to matter any more. */
export function parseMarks(raw: string | null, now: string): LocalMarks {
  let v: Record<string, unknown> = {};
  try { v = obj(raw ? JSON.parse(raw) : {}); } catch { return { ...EMPTY_MARKS }; }
  if (v.v !== MARKS_VERSION) return { ...EMPTY_MARKS };
  const t = Date.parse(now);
  const seen: Record<string, number> = {};
  for (const [k, n] of Object.entries(obj(v.seen)).slice(-MAX_SEEN)) if (typeof n === 'number' && n >= 0) seen[k] = n;
  const done: Record<string, string> = {};
  for (const [k, at] of Object.entries(obj(v.done))) if (typeof at === 'string' && t - Date.parse(at) < 30 * DAY) done[k] = at;
  const snoozed: LocalMarks['snoozed'] = {};
  for (const [k, s] of Object.entries(obj(v.snoozed))) {
    const o = obj(s);
    if (typeof o.until === 'string' && typeof o.label === 'string' && t - Date.parse(o.until) < 7 * DAY) snoozed[k] = { until: o.until, label: o.label };
  }
  const follow: Record<string, boolean> = {};
  for (const [k, on] of Object.entries(obj(v.follow))) if (typeof on === 'boolean') follow[k] = on;
  return {
    seen, done, snoozed, follow, mutedRooms: strs(v.mutedRooms), declined: strs(v.declined),
    lastActive: isTime(v.lastActive) ? v.lastActive : null,
    updatedAt: isTime(v.updatedAt) ? v.updatedAt : null,
  };
}

export const serializeMarks = (m: LocalMarks) => JSON.stringify({ v: MARKS_VERSION, ...m });

const SAVE_AFTER_MS = 1500;

export class MarksStore {
  readonly store: Store<LocalMarks>;
  /** Where the marks are kept; null until your account's copy has been read. */
  readonly kept = new Store<{ kept: MarksKept | null }>({ kept: null });
  /** When you were last here before this session started (on any device); null the first time. */
  lastHere: string | null;
  private saving: ReturnType<typeof setTimeout> | null = null;
  private remoteRead = false;

  constructor(
    readonly userId: string,
    private readonly storage: StorageLike | null,
    private readonly now: () => string,
    private readonly remote: RemoteMarks | null = null,
  ) {
    let raw: string | null = null;
    try { raw = storage?.getItem(marksKey(userId)) ?? null; } catch { /* storage may be unavailable */ }
    const m = parseMarks(raw, now());
    this.lastHere = m.lastActive;
    this.store = new Store<LocalMarks>(m);
    if (!remote) this.kept.setState({ kept: { on: 'device', reason: 'Not signed in to an account' } });
  }

  get marks(): LocalMarks { return this.store.state; }

  /** Reads your account's copy: the newer of it and this machine's wins, and the loser is brought up to date. */
  async sync(): Promise<void> {
    if (!this.remote) return;
    try {
      const got = await this.remote.get();
      this.remoteRead = true;
      const theirs = got ? parseMarks(JSON.stringify({ v: MARKS_VERSION, ...(got.marks as object) }), this.now()) : null;
      const mine = this.marks;
      if (theirs && (theirs.updatedAt ?? got!.updatedAt) > (mine.updatedAt ?? '')) {
        if (!this.lastHere || (theirs.lastActive && theirs.lastActive > this.lastHere)) this.lastHere = theirs.lastActive;
        this.store.setState(theirs);
        this.keepLocal();
        this.kept.setState({ kept: { on: 'account' } });
      } else if (!theirs || (mine.updatedAt ?? '') > (theirs.updatedAt ?? got!.updatedAt)) {
        await this.flush();
      } else {
        this.kept.setState({ kept: { on: 'account' } });
      }
    } catch (e) {
      this.kept.setState({ kept: { on: 'device', reason: e instanceof Error ? e.message : String(e) } });
    }
  }

  /** Writes to your account now (otherwise it's written shortly after the last change). */
  async flush(): Promise<void> {
    if (this.saving) { clearTimeout(this.saving); this.saving = null; }
    if (!this.remote || !this.remoteRead) return;
    try {
      await this.remote.save(JSON.parse(serializeMarks(this.marks)));
      this.kept.setState({ kept: { on: 'account' } });
    } catch (e) {
      this.kept.setState({ kept: { on: 'device', reason: e instanceof Error ? e.message : String(e) } });
    }
  }

  private keepLocal() {
    try { this.storage?.setItem(marksKey(this.userId), serializeMarks(this.store.state)); } catch { /* storage may be full or unavailable */ }
  }

  private set(patch: Partial<LocalMarks>) {
    this.store.setState({ ...patch, updatedAt: this.now() });
    this.keepLocal();
    if (this.remote && this.remoteRead && !this.saving) this.saving = setTimeout(() => { this.saving = null; void this.flush(); }, SAVE_AFTER_MS);
  }

  seen(id: string, events: number) { if (this.marks.seen[id] !== events) { const { [id]: _, ...rest } = this.marks.seen; this.set({ seen: { ...rest, [id]: events } }); } }
  done(key: string) { this.set({ done: { ...this.marks.done, [key]: this.now() } }); }
  undone(key: string) { const { [key]: _, ...rest } = this.marks.done; this.set({ done: rest }); }
  snooze(id: string, until: string, label: string) { this.set({ snoozed: { ...this.marks.snoozed, [id]: { until, label } } }); }
  unsnooze(id: string) { const { [id]: _, ...rest } = this.marks.snoozed; this.set({ snoozed: rest }); }
  follow(subjectId: string, on: boolean) { this.set({ follow: { ...this.marks.follow, [subjectId]: on } }); }
  mute(roomId: string, on: boolean) {
    const rest = this.marks.mutedRooms.filter((r) => r !== roomId);
    this.set({ mutedRooms: on ? [...rest, roomId] : rest });
  }
  decline(invitationId: string) { if (!this.marks.declined.includes(invitationId)) this.set({ declined: [...this.marks.declined, invitationId] }); }
  /** You're here now: what the next session's "Since …" counts from. */
  touch() { this.set({ lastActive: this.now() }); }
}
