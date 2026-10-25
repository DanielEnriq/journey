// A room's engineering canvas, as meaning first: the system's components and how they relate, the views
// drawn of it, and what people and Vowe pinned on it. Positions are never stored here; every view is
// laid out from this document (views/), so `payment-worker` is the same component in every
// view, however many copies of it a view draws.
//
// Three layers, kept apart:
//   1. Engineering:  components, relationships (this file).
//   2. Views:        which representation of the system the room keeps, and its scenario (ViewSpec).
//   3. Interaction:  cursors and selections, which never enter the document (presence.ts).
//
// Pure TypeScript with no imports, so main, the renderer and the reasoning runtime all run it.

export const CANVAS_SCHEMA = 'vowe.canvas/1';

/** Stable, human-readable ids: `payment-worker`, `retry-queue`. Never derived from a position or a view. */
export const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const ID_MAX = 64;

export const COMPONENT_KINDS = ['service', 'worker', 'queue', 'database', 'external', 'event', 'boundary'] as const;
export type ComponentKind = (typeof COMPONENT_KINDS)[number];

export const RELATIONSHIP_KINDS = ['calls', 'publishes', 'consumes', 'reads_writes', 'depends_on', 'retries'] as const;
export type RelationshipKind = (typeof RELATIONSHIP_KINDS)[number];

export const VIEW_TYPES = ['architecture', 'failure-flow', 'concurrency'] as const;
export type ViewType = (typeof VIEW_TYPES)[number];

export const NOTE_KINDS = ['note', 'concern', 'avoid', 'constraint', 'question', 'goal'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

/** `agreed` is part of the room's system; `proposed` is drawn dashed until a person accepts it. */
export type Status = 'agreed' | 'proposed';

/** Who did something. Only main can act as the agent; a renderer is always the signed-in person. */
export interface Actor {
  kind: 'human' | 'agent';
  /** A cloud user id for a person; `vowe` for the agent. */
  id: string;
  name: string;
}

export interface Component {
  id: string;
  kind: ComponentKind;
  name: string;
  /** How it is named mid-sentence: "the worker". */
  short?: string;
  /** One line under the name: "retry-worker", "jobs · 30s lease". */
  tech?: string;
  /** What contains it: the boundary a service sits in, or the queue an event waits in. */
  parent?: string;
  /** A service's entry point, drawn inside it. */
  endpoint?: string;
  /** A queue's lease or visibility timeout, "30s". */
  lease?: string;
  /** A database's rows; the first row is the header. */
  rows?: string[][];
  /** An event or job: its label (#4182), what it is about, and where it stands in the steady state. */
  label?: string;
  amount?: string;
  state?: 'waiting' | 'leased' | 'done';
  /** Small, named facts the representations use for wording: { item: 'retry', subject: 'card' }. */
  facts?: Record<string, string>;
  /** A caption the Architecture view shows under it. */
  note?: string;
  status: Status;
  proposal?: string;
}

export interface Relationship {
  id: string;
  kind: RelationshipKind;
  from: string;
  to: string;
  /** The verb on the wire: "charge", "lease", "enqueue". */
  label?: string;
  /** The verb in the past tense, for sentences: "charged". */
  past?: string;
  status: Status;
  proposal?: string;
}

/** One step of a Failure flow, on the lifeline of the component that does it. */
export interface FlowStep {
  id: string;
  actor: string;
  /** What happens, which decides what each part draws inside itself. */
  op: 'lease' | 'effect' | 'ack' | 'crash' | 'expire' | 'timeout' | 'note';
  title: string;
  sub: string;
  tone?: 'crash' | 'bad' | 'good';
}

export interface ViewSpec {
  id: string;
  type: ViewType;
  name: string;
  question: string;
  /** Where its data came from, said on the canvas so nobody mistakes a drawing for evidence. */
  provenance: string;
  /** The view it grew from. */
  parent?: string;
  /** The component the view is about. */
  focus?: string;
  /** Failure flow and Concurrency: the job or event the scenario follows. */
  subject?: string;
  /** Failure flow: the ordered steps. */
  steps?: FlowStep[];
  /** Concurrency: how many copies of the focus run at once. */
  instances?: number;
  status: Status;
  by: Actor;
  at: string;
}

/** What `this` means: a component (one of its copies, in a view that draws several) or a flow step. */
export type CanvasRef =
  | { component: string; instance?: number }
  | { step: string; view: string; component: string };

export type Annotation =
  | { id: string; kind: 'note'; on: string; note: NoteKind; text: string; status: 'suggested' | 'kept'; by: Actor; at: string }
  | { id: string; kind: 'ink'; view: string; d: string; by: Actor; at: string }
  | { id: string; kind: 'circle'; view: string; d: string; refs: CanvasRef[]; by: Actor; at: string };

export interface Proposal {
  id: string;
  title: string;
  rationale?: string;
  status: 'open' | 'accepted' | 'rejected';
  by: Actor;
  at: string;
  components: string[];
  relationships: string[];
  /** Components a proposal changed rather than added: their state before, to restore on rejection. */
  before: Record<string, Component>;
}

/** The entities one command touched, before and after, so it can be undone selectively. */
export interface Touch {
  components?: Record<string, Component | null>;
  relationships?: Record<string, Relationship | null>;
  views?: Record<string, ViewSpec | null>;
  annotations?: Record<string, Annotation | null>;
  proposals?: Record<string, Proposal | null>;
  activeView?: string;
  highlight?: Highlight | null;
}

export interface HistoryEntry {
  command: string;
  name: string;
  by: Actor;
  at: string;
  before: Touch;
  after: Touch;
}

export interface Highlight { components: string[]; by: Actor; at: string }

export interface CanvasDocument {
  schema: typeof CANVAS_SCHEMA;
  components: Record<string, Component>;
  relationships: Record<string, Relationship>;
  views: Record<string, ViewSpec>;
  /** The view everyone in the call is looking at. Cameras stay each person's own. */
  activeView: string;
  /** What Vowe (or a person) is pointing at, drawn with Vowe's focus ring. */
  highlight: Highlight | null;
  annotations: Record<string, Annotation>;
  proposals: Record<string, Proposal>;
  /** Newest last; bounded. */
  history: HistoryEntry[];
}

export const HISTORY_LIMIT = 40;

/** The view every document starts with: the system, before anyone asked a question of it. */
export const ARCHITECTURE_VIEW = 'architecture';

export function emptyDocument(): CanvasDocument {
  return {
    schema: CANVAS_SCHEMA, components: {}, relationships: {}, views: {}, activeView: ARCHITECTURE_VIEW,
    highlight: null, annotations: {}, proposals: {}, history: [],
  };
}

/** Relationship ids are derived from what they connect, so the same edge never appears twice. */
export const relationshipId = (from: string, kind: RelationshipKind, to: string) => `${from}--${kind}--${to}`;

/** The visual key of a component's nth copy in a view that draws several; the first copy is the component. */
export const instanceKey = (component: string, instance = 1) => instance <= 1 ? component : `${component}#${instance}`;

export function parseInstanceKey(key: string): { component: string; instance: number } {
  const m = /^(.+)#(\d+)$/.exec(key);
  return m ? { component: m[1], instance: Number(m[2]) } : { component: key, instance: 1 };
}

export const isAgent = (a: Actor) => a.kind === 'agent';
