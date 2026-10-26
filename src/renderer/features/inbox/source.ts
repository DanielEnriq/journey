import type { Store } from '../../shared/store.js';
import type { Scene } from '../../../shared/canvas/index.js';
import type { VoweRecord } from '../vowe-room/contracts/model.js';
import type { PersonId } from '../vowe-room/journey.js';
import type { InboxItem, InboxView, Source } from './model.js';

// CONTRACT (lead-owned): what Home's Inbox reads and what it can do. The systems side implements
// InboxSource over Journey's real records (one per signed-in workspace); the UI side only reads `store`
// and calls these methods. Nothing here fetches in a component, and nothing is presented as more real than it
// is: sources Journey doesn't produce (`runner`, `github`) are listed in `unavailable` and never appear as items.

export interface InboxPerson { id: PersonId; name: string; initials: string; tone: 'me' | 'peer' | 'p2' | 'p3' }

export interface InboxState {
  /** loading: the first read; ready: `view` is current; failed: `error` says why (the last view stays). */
  status: 'loading' | 'ready' | 'failed';
  error: string | null;
  view: InboxView;
  /** ISO time the view was derived at; rows say "41m" against it. */
  now: string;
  /** You, as the record names you (cloud user id); null before the first read. */
  me: PersonId | null;
  /** Everyone the view mentions, so rows can draw names and faces without another lookup. */
  people: Record<PersonId, InboxPerson>;
  /** The number on Home in the sidebar: exactly `view.needs.length`. Nothing else is a count. */
  needsCount: number;
  /** Sources Journey can't produce yet (shown as "not in Journey yet" where the design mentions them). */
  unavailable: Source[];
}

/** The record and canvas behind one item, for the reading page (Preview). Null while it loads or when unreadable. */
export interface ItemContext { record: VoweRecord | null; scene: Scene | null }

/** Every act returns a promise that rejects with a message to show; on success the view re-derives on its own. */
export interface InboxSource {
  readonly store: Store<InboxState>;
  /** Re-read every room's record now (the source also refreshes itself on record:changed and focus). */
  refresh(): void;
  /** The record (and canvas scene) of an item's room, cached; for the reading page. */
  context(roomId: string): Promise<ItemContext>;

  /* Your marks: persisted per person, survive relaunch. */
  /** Selecting or opening an item clears its unseen events. */
  seen(item: InboxItem): void;
  /** Following and Activity only (Needs you leaves when discharged). Returns an undo. */
  done(item: InboxItem): () => void;
  snooze(item: InboxItem, until: string, label: string): void;
  unsnooze(itemId: string): void;
  follow(item: InboxItem, on: boolean): void;
  muteRoom(roomId: string, on: boolean): void;

  /* Discharging an obligation from the reading page, through the same room services the Desk uses. */
  sign(item: InboxItem): Promise<void>;
  requestChanges(item: InboxItem, text: string): Promise<void>;
  answer(item: InboxItem, text: string): Promise<void>;
  reply(item: InboxItem, body: string): Promise<void>;
  authorize(item: InboxItem): Promise<void>;
  allowScope(item: InboxItem, allow: boolean): Promise<void>;
  /** An invitation item: accept returns the room id to open; decline removes it. */
  acceptInvitation(item: InboxItem, yes: boolean): Promise<string | null>;
}
