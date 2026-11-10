import type { EntityKind, EntityStatus, Lens, Provenance, RelationKind, SourceRange } from '../model.js';

// The Scene: a deterministic drawing of one level of a resolved view. Same registry, view, state and
// layout inputs → the same scene, byte for byte. Everything here is in stage units (px at zoom 1); the
// canvas only moves a camera over it and chooses how much detail to draw for the zoom.
//
// Identity: a node's id is its registry entity id at every level. A part drawn inside a component at the
// near level carries the same id as the node that part becomes once the component is entered.

export const SCENE_SCHEMA = 'vowe.system-scene/1';

export interface Rect { x: number; y: number; w: number; h: number }
export interface Point { x: number; y: number }

/** How a kind is drawn. Each has its own outline and arrangement of parts (forms.ts). */
export type FormId =
  | 'interface' | 'client' | 'engine' | 'store' | 'table' | 'service' | 'endpoint' | 'bridge' | 'queue' | 'worker'
  | 'channel' | 'external' | 'module' | 'function' | 'command' | 'state' | 'schema' | 'validator' | 'query'
  | 'class' | 'file' | 'test' | 'interaction' | 'step' | 'store-function' | 'column' | 'unknown';

/** Detail levels: far = silhouette (structure, no labels), near = labelled parts, entered = own frame. */
export type Lod = 'far' | 'near';

/** What a form shows inside itself: a compartment, a table drawer, a command chip, an empty queue slot… */
export interface Part {
  /** Unique within the node. When it stands for an entity, equal to that entity's id. */
  key: string;
  /** The entity it stands for, if any: clicking it selects (and Enter enters) that same id. */
  entity?: string;
  /** What it is inside the form: 'table', 'command', 'region', 'state', 'pending', 'slot', 'endpoint', 'more'… */
  role: string;
  label?: string;
  /** For a compartment: how many things it holds (drawn or not), so a distant view says "20 commands". */
  count?: number;
  /** For a compartment: what of it this view touches, by name (the rest is counted). */
  named?: string[];
  /** Second line: columns, the writer, a signature. */
  detail?: string;
  /** Relative to the node's top-left. */
  rect: Rect;
  /** The least detail at which it is drawn: 'far' parts are the silhouette, 'near' parts appear closer. */
  lod: Lod;
  /** Structure only: an empty slot that a recorded trace could fill. Never filled with invented work. */
  empty?: boolean;
  /** Relations entering or leaving through this part, summarised: "written by Canvas hub". */
  note?: string;
  provenance?: Provenance;
  status?: EntityStatus;
}

/** A connection point on a node's outline, chosen by the relation kind and the form (writes enter a table). */
export interface Port { edge: string; end: 'from' | 'to'; side: 'left' | 'right' | 'top' | 'bottom'; x: number; y: number; part?: string }

export type Emphasis = 'primary' | 'context' | 'dim';

export interface SceneNode {
  id: string;
  kind: EntityKind;
  /** The kind written plainly ('store', 'my-custom-kind'): unknown kinds keep their real name. */
  kindLabel: string;
  form: FormId;
  name: string;
  summary?: string;
  rect: Rect;
  /** SVG path data of the outline, relative to the node's top-left. */
  outline: string;
  /** The heading band's height: the name sits there at every detail level. */
  head: number;
  parts: Part[];
  /** How many child entities it has in the registry (drawn or not): Enter reveals them. */
  childCount: number;
  enterable: boolean;
  provenance: Provenance;
  confidence?: number;
  status: EntityStatus;
  /** Why it is on the canvas (from the resolved view): focus, parent, neighbour, sequence… */
  why: string;
  emphasis: Emphasis;
  /** For change-review: anchored in a changed file or symbol. */
  affected?: boolean;
  /** Where it was placed from: the person's pin, remembered layout, or fresh layout. */
  placed: 'pinned' | 'memory' | 'layout';
  zone: string;
  /** A grouping it belongs to (a subsystem the view flattened), for the outline and the hull. */
  group?: string;
  /** Anchor files, for the inspector and for showing stale/changed. */
  files: string[];
  /** Ghost of a requested id the registry doesn't have. */
  ghost?: boolean;
}

/** A neighbour outside the entered component, held at the frame's edge in its real direction. */
export interface ScenePortal {
  id: string;
  name: string;
  kind: EntityKind;
  kindLabel: string;
  form: FormId;
  side: 'left' | 'right' | 'top' | 'bottom';
  rect: Rect;
  /** How many relations cross to it. */
  count: number;
}

export type LineStyle = 'solid' | 'heavy' | 'thin' | 'dotted' | 'hairline' | 'double';
export type Terminal = 'none' | 'arrow' | 'open-arrow' | 'bracket' | 'tap' | 'ring' | 'bar' | 'triangle' | 'tick' | 'diamond' | 'chevron' | 'socket';

/** How a relation kind is drawn: never by colour alone. */
export interface RelationGrammar {
  kind: RelationKind;
  /** Plain words for the legend: "calls — control passes and comes back". */
  says: string;
  line: LineStyle;
  start: Terminal;
  end: Terminal;
  /** Drawn as a crossing mark when it leaves one runtime zone for another. */
  marksBoundary: boolean;
  /** Ranks the layout: does it carry the flow forward (from → to)? 'reverse' = flow runs to → from. */
  flow: 'forward' | 'reverse' | 'none';
}

export interface SceneEdge {
  id: string;
  kind: RelationKind;
  from: string;
  to: string;
  /** A relation id when it is one relation; a synthetic id when it rolls several up. */
  relations: string[];
  label?: string;
  /** Count of the finer relations it stands for. */
  count: number;
  provenance: Provenance;
  provenanceMix: Partial<Record<Provenance, number>>;
  status: EntityStatus;
  grammar: RelationGrammar;
  /** Polyline through these points (the canvas rounds the corners). */
  points: Point[];
  labelAt?: Point;
  /** Where it crosses from one runtime zone to another. */
  crossings: { at: Point; from: string; to: string }[];
  /** Part of a cycle and routed as a return. */
  back: boolean;
  /** One end is a portal (outside the entered component). */
  portal?: 'from' | 'to';
  /** The part each end lands on (a table, an endpoint), when the relation reaches one. */
  parts: [string | null, string | null];
  emphasis: Emphasis;
}

/** A connection whose other end is not drawn: outside the view, or not indexed at all. */
export interface SceneStub {
  id: string;
  node: string;
  direction: 'in' | 'out';
  reason: 'outside-view' | 'not-indexed';
  count: number;
  kinds: RelationKind[];
  /** The ids on the other end (for "show them"). */
  others: string[];
  points: Point[];
  labelAt: Point;
}

/** "+N more": what a cap kept off the canvas, and where to ask for it. */
export interface SceneOverflow { id: string; zone: string; hidden: string[]; rect: Rect }

export interface SceneZone {
  id: string;
  label: string;
  /** How the zone was decided: the entity's own attribute, or its file location. */
  basis: 'attribute' | 'file-path' | 'none';
  rect: Rect;
  /** A row of the stack, or a column beside it. */
  orient: 'row' | 'column';
}

export interface SceneGroup { id: string; name: string; kind: EntityKind; members: string[]; rect: Rect }

export interface SceneStep {
  id: string;
  index: number;
  entity: string;
  /** The visible node (or portal) it is drawn on: the entity itself or its nearest visible ancestor. */
  on: string | null;
  /** A part of `on` it sits on, when the entity is drawn as a part there. */
  part?: string;
  at: Point;
  label: string;
  detail?: string;
  ctx: string[];
  guard?: string;
  next: string[];
  evidence: string[];
  relation?: string;
  /** For the failure lens: the step where it goes wrong. */
  failure?: boolean;
  /** Traces only. */
  time?: number;
  observed?: Record<string, string | number | boolean>;
}

export interface SceneSegment {
  from: string;
  to: string;
  kind: 'next' | 'loop' | 'branch';
  points: Point[];
  /** The loop's condition as written in code, said once per loop (with its bound when the code names one). */
  guard?: string;
  /** For a branch: the outcome it leads to, in the target step's words. */
  outcome?: string;
  /** On the way to failure: the retry loop, or a branch ending in failure. */
  failing?: boolean;
}

export interface SceneSequence {
  id: string;
  title: string;
  kind: 'code-path' | 'trace';
  /** Said with the drawing, always: what this is and is not. */
  claim: string;
  recorded?: { at: string; where: string; by: string };
  steps: SceneStep[];
  segments: SceneSegment[];
  notes: string[];
  /** Steps whose entity isn't on this level at all. */
  offstage: string[];
}

export interface OutlineItem { id: string; name: string; kindLabel: string; depth: number; parts: { id: string; label: string }[] }

export interface SceneLegend {
  forms: { form: FormId; kinds: string[] }[];
  relations: RelationGrammar[];
  provenance: Provenance[];
  status: EntityStatus[];
}

export interface SystemScene {
  schema: typeof SCENE_SCHEMA;
  view: string;
  lens: Lens;
  /** 'right' or 'down': the direction the view's flow reads in. */
  flow: 'right' | 'down';
  /** The entered path ('' for the top) and the entered component. */
  level: { key: string; entered: string[]; root: string | null; frame: Rect | null; form: FormId | null };
  bounds: Rect;
  zones: SceneZone[];
  groups: SceneGroup[];
  /** Inside an entered component: its compartments, as regions holding their parts. */
  regions: { id: string; label: string; rect: Rect }[];
  nodes: SceneNode[];
  edges: SceneEdge[];
  portals: ScenePortal[];
  stubs: SceneStub[];
  overflow: SceneOverflow[];
  sequence: SceneSequence | null;
  legend: SceneLegend;
  /** Keyboard and screen-reader order of what is on this level. */
  outline: OutlineItem[];
  /** Positions of everything placed on this level: the caller keeps them as layout memory. */
  placed: Record<string, [number, number]>;
  warnings: string[];
}

/** For the inspector: where an evidence item points. */
export type EvidenceRange = SourceRange;
