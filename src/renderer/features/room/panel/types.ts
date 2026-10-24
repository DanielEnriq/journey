/**
 * The data the room panel draws. Everything here is a *view model*: plain,
 * serialisable, already resolved for the person looking at it. The panel never
 * fetches, subscribes or decides; whoever owns the room state builds these and
 * passes them in, and the panel calls back when someone acts.
 */

import type { ComponentChildren } from '../../../vendor/preact.js';

export type PersonId = string;

/** Colour is identity: each person keeps one tone everywhere in the room. */
export type PersonTone = 'me' | 'peer' | 'peer2' | 'peer3';

export interface Person {
  id: PersonId;
  name: string;
  initials: string;
  /** `agent` renders as the Vowe orb rather than initials. */
  kind: 'human' | 'agent';
  tone?: PersonTone;
}

/** Who is in a piece of the record right now, and doing what. */
export interface Presence {
  personId: PersonId;
  mode: 'reading' | 'typing' | 'reviewing';
}

export interface Approver {
  personId: PersonId;
  /** Highest version this person signed; `null` if never. Stale when < version. */
  signedVersion: number | null;
}

export interface Decision {
  id: string;
  version: number;
  title: string;
  /** The checks the decision commits to. Handed to the coding agent verbatim. */
  verify: string;
  proposedBy: PersonId;
  /** Omitted when the room doesn't know when it was proposed. */
  proposedAgo?: string;
  approvers: Approver[];
  /** `amending` while someone drafts the next version; `handed` once work started. */
  status: 'proposed' | 'agreed' | 'amending' | 'handed';
  handedTo?: string;
  earlierVersions: number;
  presence?: Presence;
}

export type ThreadKind = 'concern' | 'avoid' | 'constraint' | 'question' | 'note' | 'goal';

export interface Comment {
  id: string;
  authorId: PersonId;
  body: string;
  /** Relative time, already formatted ("14m", "now"). */
  ago: string;
  /** Just arrived; animates in once. */
  fresh?: boolean;
}

export interface Thread {
  id: string;
  kind: ThreadKind;
  /** The part on the canvas the thread is pinned to. Threads stack by anchor. */
  anchor: { id: string; name: string };
  root: Comment;
  replies: Comment[];
  presence?: Presence;
}

export interface StreamFile {
  path: string;
  added: number;
  removed: number;
}

export interface Stream {
  id: string;
  title: string;
  /** "Claude Code", "Codex"… */
  agent: string;
  meta: string;
  state: 'running' | 'needs' | 'done';
  line?: string;
  files?: StreamFile[];
}

export interface BriefItem {
  tone: 'ask' | 'live' | 'needs' | 'quiet';
  text: string;
}

export interface SetAside {
  label: string;
  reason: string;
}

export interface RoomPanelProps {
  people: Record<PersonId, Person>;
  /** The viewer. Their approver slot becomes the sign control. */
  meId: PersonId;
  subtitle?: string;
  goal?: { text: string; by: PersonId };
  brief?: BriefItem[];
  decision?: Decision;
  threads: Thread[];
  setAside?: SetAside[];
  streams: Stream[];
  /** Vowe is talking about the decision right now; outline it. */
  decisionPointed?: boolean;
  /** Vowe addition: anything the room adds under its running streams (an overlap warning). */
  children?: ComponentChildren;

  onOpenDecision?: (decisionId: string) => void;
  onSign?: (decisionId: string, version: number) => void;
  onProposeChange?: (decisionId: string) => void;
  /** Vowe addition: with no decision yet, offers to write one down. */
  onPropose?: () => void;
  onHandOff?: (decisionId: string) => void;
  onReply?: (threadId: string, body: string) => void;
  onShowAnchor?: (anchorId: string) => void;
  onDismissBrief?: () => void;
  onShowBrief?: () => void;
  onShowStream?: (streamId: string) => void;
}
