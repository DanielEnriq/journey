import { Store } from '../../shared/store.js';
import type { InboxMarks } from './model.js';

// What you did to Inbox items, kept per person on this machine ("local first", as the design asks):
// seen counts, snoozes, follows, muted rooms, declined invitations, and when you were last active (for
// "Since Friday"). Done marks are also written to the server (attention_done, see real.ts), so they reach
// every device; the local copy just makes them instant. Versioned, and every storage access is guarded.

export interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }

export interface LocalMarks extends InboxMarks {
  /** Invitations you declined (Journey has no decline on the server): hidden on this machine. */
  declined: string[];
  /** The last time this app was in use by you (updated while you're here). */
  lastActive: string | null;
}

export const MARKS_VERSION = 1;
export const marksKey = (userId: string) => `vowe.inbox.v${MARKS_VERSION}:${userId}`;
export const EMPTY_MARKS: LocalMarks = { seen: {}, done: {}, snoozed: {}, follow: {}, mutedRooms: [], declined: [], lastActive: null };

const DAY = 86_400_000;
const MAX_SEEN = 2000;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

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
    lastActive: typeof v.lastActive === 'string' && !Number.isNaN(Date.parse(v.lastActive)) ? v.lastActive : null,
  };
}

export const serializeMarks = (m: LocalMarks) => JSON.stringify({ v: MARKS_VERSION, ...m });

export class MarksStore {
  readonly store: Store<LocalMarks>;
  /** When you were last here before this session started; null the first time. */
  readonly lastHere: string | null;

  constructor(readonly userId: string, private readonly storage: StorageLike | null, private readonly now: () => string) {
    let raw: string | null = null;
    try { raw = storage?.getItem(marksKey(userId)) ?? null; } catch { /* storage may be unavailable */ }
    const m = parseMarks(raw, now());
    this.lastHere = m.lastActive;
    this.store = new Store<LocalMarks>(m);
  }

  get marks(): LocalMarks { return this.store.state; }

  private set(patch: Partial<LocalMarks>) {
    this.store.setState(patch);
    try { this.storage?.setItem(marksKey(this.userId), serializeMarks(this.store.state)); } catch { /* storage may be full or unavailable */ }
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
