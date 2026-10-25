// The room's vocabulary, shared by its data sources, its controller and its components.

export type PersonId = 'daniel' | 'john' | 'srikar' | 'vowe';
export type ViewId = 'arch' | 'failure' | 'alternatives' | 'concurrency' | 'impl' | 'timeout' | 'ui';
export type Tool = 'select' | 'pan' | 'circle' | 'draw' | 'comment';
/** Vowe's turn state, said in words beside the orb. */
export type AgentState = 'listening' | 'holding' | 'thinking' | 'speaking';
export type Chime = 'pauses' | 'asked';
export type AgentTarget = 'claude' | 'codex';
export type Point = [number, number];
/** x, y, width, height on the stage. */
export type Rect = [number, number, number, number];

export interface Person {
  name: string;
  full: string;
  initials: string;
  /** Class of the small avatar beside a note: `mav`, `mav peer`, … */
  av: string;
}

/** Someone shown by their initials; `tone` picks their colour (you are `me`). */
export interface PersonRef { name: string; initials: string; tone: 'me' | 'peer' | 'p2' | 'p3' }

/** A room as the workspace lists it. Rooms persist; calls in them come and go. */
export interface RoomSummary {
  id: string;
  name: string;
  /** The repository the room works in; null when none is attached. */
  repo: string | null;
  /** Who is in the room's call right now, you included once you join; empty when there is no call. */
  inCall: PersonRef[];
  /** Who has the room open right now, in the call or not; absent where that isn't known (the demo). */
  here?: PersonRef[];
  /** Your role in the room; absent in the demo. Viewers read, comment and listen. */
  role?: 'owner' | 'member' | 'viewer';
  /** What needs you here, in a few words; null when nothing does. The only amber in the list. */
  needs: string | null;
  /** The last thing that happened here, in words, and when (ISO 8601). */
  activity: string;
  activityAt: string | null;
  /** Rooms with a scripted example canvas. Only Payment Reliability has one. */
  demo?: 'payments';
}

/** Kind is felt from shape: queues are pills with rails, stores have a lip, externals are washed out. */
export type PartKind = 'service' | 'queue' | 'external' | 'store' | 'client' | 'code';
/** What a part draws inside itself: its slots, its running copies, the calls it saw, its rows… */
export type PartSmart = 'endpoint' | 'queue' | 'worker' | 'calls' | 'table' | 'screen' | 'diff';

export interface PartDef {
  id: string;
  kind: PartKind;
  smart: PartSmart;
  name: string;
  /** How Vowe names it mid-sentence: "the queue". */
  short: string;
  tech: string;
  /** Where it waits, faded out, in views that don't show it. */
  hide?: Rect;
  /** Dashed until the room agrees to it. */
  proposed?: boolean;
}

export interface WireDef { v: ViewId; c: string; x: number; y: number; w: number; h: number; d?: number }
export interface LabelDef { v: ViewId; t: string; x: number; y: number }
export interface BoundDef { v: ViewId[]; x: number; y: number; w: number; h: number; label: string }
export interface StepDef { v: ViewId; id: string; n: string; title: string; sub: string; short: string; x: number; y: number; tone?: string }
export interface Recipe { arrangement: string; blocks: string[] }

/** One saved view: a question, an arrangement of parts, and where its data came from. */
export interface ViewDef {
  name: string;
  question: string;
  parent?: ViewId;
  provenance: string;
  recipe: Recipe;
  layout: Record<string, Rect>;
  viewBox: [number, number];
  neighbours?: Record<string, string[]>;
  /** Where John's and Srikar's cursors rest in this view. */
  cursor: Point;
  cursor2: Point;
  /** The part John has selected here, if any. */
  peerSelection?: string;
}

export type NoteKind = 'note' | 'concern' | 'avoid' | 'constraint' | 'question' | 'goal';

export interface Note {
  id: string;
  kind: NoteKind;
  text: string;
  who: PersonId;
  /** The part it is pinned to. */
  on: string;
  /** Answered by the decision. */
  linked?: boolean;
  /** Vowe suggested it; outlined until a person keeps it. */
  suggested?: boolean;
  /** Just kept, with Undo. */
  fresh?: boolean;
  /** When it was noted, ISO 8601. */
  at?: string;
}

export interface Decision {
  v: number;
  /** The checks, `;`-separated, as written. */
  verify: string;
  /** The previous version's checks, to mark what was added. */
  base: string | null;
  /** The version each approver signed; 0 for none. */
  sig: { john: number; daniel: number };
  amending: boolean;
  draft: string;
  /** John is reading the new version. */
  reviewing: boolean;
  history: { v: number; verify: string; by: string }[];
}

export interface ChangedFile { path: string; a: string; d: string }

export interface Workstream {
  title: string;
  agent: string;
  meta: string;
  /** `done` once its checks passed. */
  state: 'running' | 'done';
}

/** A word on the live line; `ref` names the part it points at while spoken. */
export interface Word { t: string; tail?: string; ref?: string; chip?: boolean; chipTo?: string }
