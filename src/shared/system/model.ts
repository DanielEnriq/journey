// Vowe's system canvas: the shared contracts.
//
// Four layers, kept apart so the same system can be drawn many ways without anyone claiming its structure
// changed:
//
//   1. Index      facts the language tooling established about one revision of a repository (RepoIndex).
//   2. Registry   typed system entities and relations built on the index, each tied to evidence, plus the
//                 reviewable interpretations people or agents layered on top (SystemRegistry).
//   3. View       a question or task, and the subset of the registry selected to answer it (ViewRequest).
//                 This is what a coding agent supplies. It never carries coordinates.
//   4. Scene      the deterministic drawing of a view: forms, layout, edges, levels (render/, owned there).
//
// Runtime events (Trace) are a fifth input, kept separate: a sequence derived from code illustrates a
// possible path; only a trace says what happened.
//
// Pure TypeScript with no imports, shared by the indexer (Node), main, the renderer and tests.

export const INDEX_SCHEMA = 'vowe.index/1';
export const REGISTRY_SCHEMA = 'vowe.registry/1';
export const VIEW_SCHEMA = 'vowe.system-view/1';
export const TRACE_SCHEMA = 'vowe.trace/1';

/* ======================================================================================================
 * 1. Index
 * ==================================================================================================== */

/** 1-based lines, 1-based columns, end inclusive of its line. Paths are repo-relative with forward slashes. */
export interface SourceRange { file: string; start: { line: number; col: number }; end: { line: number; col: number } }

/** What a snapshot describes: one repository at one revision, plus any uncommitted edits. */
export interface RepoRevision {
  repo: { id: string; name: string; root: string; remote?: string };
  /** The commit, or null outside git. */
  head: string | null;
  branch: string | null;
  /** Files whose working-tree content differs from `head` when indexed. */
  dirty: string[];
  indexedAt: string;
  /** Hash over every indexed file's path and content hash: equal fingerprints describe equal inputs. */
  fingerprint: string;
}

export type FileLang = 'ts' | 'tsx' | 'js' | 'sql' | 'css' | 'html' | 'json' | 'md' | 'other';
export type FileStatus = 'indexed' | 'partial' | 'unsupported' | 'error' | 'skipped';

export interface IndexedFile {
  path: string;
  lang: FileLang;
  /** sha256 of the content, hex, first 16 chars. */
  hash: string;
  size: number;
  lines: number;
  status: FileStatus;
  /** Why partial, unsupported, error or skipped. */
  note?: string;
  /** Test files (`*.test.ts`, `__tests__`). */
  test?: boolean;
}

export type SymbolKind =
  | 'function' | 'class' | 'method' | 'property' | 'interface' | 'type' | 'variable' | 'enum'
  /** A function whose body returns JSX. */
  | 'ui-component'
  | 'sql-table' | 'sql-column' | 'sql-function' | 'sql-policy' | 'sql-index'
  | 'test-case';

export interface IndexSymbol {
  /** `<file>#<qualified.name>`, e.g. `src/renderer/features/canvas/client.ts#CanvasClient.run`. */
  id: string;
  name: string;
  kind: SymbolKind;
  file: string;
  range: SourceRange;
  exported: boolean;
  /** The class, interface or table that contains it. */
  container?: string;
  /** One line: `run<K extends CommandName>(name: K, args: CommandArgs[K]): Promise<CommandResult>`. */
  signature?: string;
  /** The leading comment, trimmed, at most a few hundred chars. */
  doc?: string;
  /** Hash of the declaration's text: changes when the symbol's code changes, survives moves within the file. */
  hash: string;
  /** Small typed facts: string-literal union members, modifiers, column types, parameter names. */
  attrs?: Record<string, string | number | boolean | string[]>;
}

export interface IndexImport {
  from: string;
  /** Resolved repo-relative file, or null for a package or an unresolved path. */
  to: string | null;
  specifier: string;
  names: string[];
  typeOnly: boolean;
  range: SourceRange;
}

export type ReferenceKind = 'call' | 'new' | 'read' | 'write' | 'type' | 'jsx' | 'extends' | 'implements' | 'sql-read' | 'sql-write' | 'sql-call';

/** A use of one symbol inside another, resolved by the type checker (or the SQL reader). */
export interface IndexReference {
  /** The innermost indexed symbol that contains the use (function, method, class…), or the file as `<file>#`. */
  from: string;
  to: string;
  kind: ReferenceKind;
  range: SourceRange;
}

/**
 * A string literal passed to a call: channels (`handle('canvas:execute')`), tables (`.from('room_canvases')`),
 * RPCs, commands (`run('draw', …)`), events (`emit('changed')`). The registry turns matching literals into
 * relations; the index only records them.
 */
export interface LiteralSite {
  in: string;
  file: string;
  range: SourceRange;
  /** The callee as written, normalised: `handle`, `j.canvas.execute`, `supabase.from`, `this.transport.execute`. */
  callee: string;
  /** The callee's last name: `from`, `execute`, `run`. */
  method: string;
  calleeSymbol?: string;
  literal: string;
  argIndex: number;
}

/** A comparison against a string literal: `tool === 'draw'`, `e.type === 'canvas:changed'`, `case 'draw':`. */
export interface ComparisonSite {
  in: string;
  file: string;
  range: SourceRange;
  /** The compared expression as written: `tool`, `e.type`, `cmd.name`. */
  subject: string;
  literal: string;
  /** True for `!==` / `!=`: the branch is taken when the subject is *not* the literal. */
  negated?: boolean;
  /** The range of the branch the comparison guards, when it guards one. */
  branch?: SourceRange;
}

/** Ordered calls in one function body, with the control flow around each: a code-derived possible path. */
export interface CallFlow {
  symbol: string;
  steps: {
    callee: string;
    calleeSymbol?: string;
    range: SourceRange;
    /** Innermost last: e.g. ['loop', 'branch']. */
    ctx: ('loop' | 'branch' | 'try' | 'catch' | 'callback' | 'await')[];
    /** The branch condition or loop header as written, when ctx ends in branch/loop. */
    guard?: string;
  }[];
}

export interface LanguageCoverage { files: number; indexed: number; partial: number; unsupported: number; error: number; skipped: number }

export interface IndexCoverage {
  byLang: Partial<Record<FileLang, LanguageCoverage>>;
  /** What this index can't establish, said plainly: "dynamic imports are not resolved", … */
  limits: string[];
  /** Type-checker diagnostics that may have weakened resolution, by file (counts). */
  diagnostics: Record<string, number>;
}

export interface RepoIndex {
  schema: typeof INDEX_SCHEMA;
  revision: RepoRevision;
  /** Which tools produced it, with versions: `{ typescript: '5.9.3', sql: 'vowe-sql/1' }`. */
  tools: Record<string, string>;
  files: IndexedFile[];
  symbols: IndexSymbol[];
  imports: IndexImport[];
  references: IndexReference[];
  literals: LiteralSite[];
  comparisons: ComparisonSite[];
  flows: CallFlow[];
  coverage: IndexCoverage;
  /** True when the index was cut short (time or file limit) or a language pass failed. */
  incomplete: boolean;
}

/** What changed between two indexes, by file and symbol. */
export interface IndexDiff {
  from: string; // fingerprint
  to: string;
  files: { added: string[]; removed: string[]; changed: string[] };
  symbols: { added: string[]; removed: string[]; changed: string[]; /** old id → new id, same hash */ moved: Record<string, string> };
}

/* ======================================================================================================
 * 2. Registry
 * ==================================================================================================== */

/**
 * How we know. Drawn differently, always:
 *   code            established directly by an index fact (a definition, a resolved call, a SQL statement).
 *   inferred        a named rule over code facts ("a class holding a field typed by an interface whose
 *                   methods it calls is a client of that boundary"). Reviewable; the rule is the evidence.
 *   interpretation  asserted by a person or agent (a grouping, a name, a purpose). Reviewable.
 *   proposed        does not exist in the code yet: part of a suggested change.
 *   observed        seen at runtime in a recorded trace.
 */
export type Provenance = 'code' | 'inferred' | 'interpretation' | 'proposed' | 'observed';

/**
 * Where an entity stands against the latest index:
 *   current   its anchors match the index it was built from.
 *   changed   an anchor's code changed since the registry snapshot the viewer last saw (still present).
 *   stale     the working tree changed under it and the index hasn't been refreshed yet.
 *   missing   an anchor no longer exists (deleted or renamed and not matched).
 *   new       appeared since the snapshot the viewer last saw.
 *   unknown   indexing was incomplete for its files.
 */
export type EntityStatus = 'current' | 'changed' | 'stale' | 'missing' | 'new' | 'unknown';

export type EvidenceKind =
  | 'definition' | 'reference' | 'call' | 'import' | 'literal' | 'comparison' | 'flow'
  | 'sql' | 'test' | 'doc' | 'rule' | 'interpretation' | 'trace';

export interface Evidence {
  id: string;
  kind: EvidenceKind;
  /** One sentence a person can check: "`CanvasClient.run` calls `this.transport.execute`". */
  summary: string;
  range?: SourceRange;
  /** The index symbol it rests on. */
  symbol?: string;
  /** The file hash it was read from, so a viewer knows when it may no longer hold. */
  fileHash?: string;
  /** For `rule`: the rule's id (registry/rules), for `interpretation`: its id. */
  rule?: string;
}

/**
 * Entity kinds. Known kinds have their own visual forms; any other string is allowed and drawn honestly
 * as `unknown`-shaped, with its kind written on it.
 *
 * system/subsystem group; the middle kinds are what a system is made of; the code kinds are what a
 * component is made of.
 */
export const ENTITY_KINDS = [
  'system', 'subsystem', 'module',
  'interface', 'client', 'adapter', 'transport', 'service', 'endpoint', 'worker', 'queue', 'event-channel',
  'store', 'table', 'column', 'store-function', 'query', 'engine', 'command', 'validator', 'state', 'schema',
  'external', 'interaction', 'step',
  'function', 'method', 'class', 'type', 'file', 'test',
  'unknown',
] as const;
export type KnownEntityKind = (typeof ENTITY_KINDS)[number];
export type EntityKind = KnownEntityKind | (string & {});

/** How far in the entity sits: what an overview shows, what entering a component reveals, raw code. */
export type EntityLevel = 'system' | 'component' | 'element' | 'code';

export interface Anchor { file: string; symbol?: string; range?: SourceRange; /** hash of the symbol or file when anchored */ hash?: string }

export interface Entity {
  /** Stable across revisions while what it stands for survives: `component:canvas-client`, `table:room-canvases`. */
  id: string;
  kind: EntityKind;
  name: string;
  /** One line, plain: what it is for. Says where it came from via `provenance`. */
  summary?: string;
  /** Composition: the entity it is part of. Overview → component → element → code. */
  parent?: string;
  level: EntityLevel;
  anchors: Anchor[];
  /** Typed facts for the forms: tool ids, column names, command names, field roles… */
  attrs: Record<string, string | number | boolean | string[]>;
  provenance: Provenance;
  /** 0–1, for inferred entities: how strongly the rule matched. */
  confidence?: number;
  evidence: string[];
  status: EntityStatus;
  /** Interpretations that shaped this entity (renamed, regrouped, reclassified). */
  interpretations?: string[];
}

export const RELATION_KINDS = [
  'contains', 'calls', 'sends', 'handles', 'reads', 'writes', 'publishes', 'consumes', 'depends_on',
  'implements', 'verified_by', 'produces', 'renders', 'precedes',
] as const;
export type KnownRelationKind = (typeof RELATION_KINDS)[number];
export type RelationKind = KnownRelationKind | (string & {});

export interface Relation {
  /** `${from}--${kind}--${to}`. */
  id: string;
  kind: RelationKind;
  from: string;
  to: string;
  /** The verb or channel on the wire: `canvas:execute`, `commit_canvas`, `draw`. */
  label?: string;
  provenance: Provenance;
  confidence?: number;
  evidence: string[];
  status: EntityStatus;
  /** Rolled up from finer relations between descendants: the child relation ids it summarises. */
  via?: string[];
  interpretations?: string[];
}

/**
 * An ordered path through entities: a command's way from a gesture to a save, the store's retry loop.
 * `code-path` is derived from code and shows what can happen; `trace` comes from a recorded run.
 */
export interface Sequence {
  id: string;
  title: string;
  kind: 'code-path' | 'trace';
  /** What it's about: `command:draw`. */
  subject?: string;
  steps: SequenceStep[];
  provenance: Provenance;
  evidence: string[];
  /** Where the path branches or loops, said in words: "if the save lost the race, reload and re-apply (≤5)". */
  notes?: string[];
}

export interface SequenceStep {
  id: string;
  /** Who does it. */
  entity: string;
  /** The relation travelled to get here, when there is one. */
  relation?: string;
  label: string;
  detail?: string;
  /** Control flow it sits in: loop, branch… copied from the index's CallFlow. */
  ctx?: string[];
  /** For a branch: what it depends on, as written in code. */
  guard?: string;
  /** Steps that can follow this one (default: the next). Lets a loop or a branch be drawn as one. */
  next?: string[];
  evidence: string[];
  /** Only for traces: when it happened (ms from the trace start) and what was seen. */
  at?: number;
  observed?: Record<string, string | number | boolean>;
}

/** A reviewable claim layered on the derived registry. Applied on every rebuild while its target still resolves. */
export interface Interpretation {
  id: string;
  op:
    | { kind: 'rename'; entity: string; name: string }
    | { kind: 'classify'; entity: string; as: EntityKind }
    | { kind: 'summarise'; entity: string; summary: string }
    /** Put these entities (or files) under one component. */
    | { kind: 'group'; id: string; name: string; as: EntityKind; members: string[] }
    | { kind: 'relate'; from: string; to: string; relation: RelationKind; label?: string }
    | { kind: 'reject'; target: string };
  by: { kind: 'human' | 'agent' | 'rule'; id: string; name: string };
  at: string;
  status: 'proposed' | 'accepted' | 'rejected';
  note?: string;
  /** Set on rebuild when the target no longer resolves. */
  orphaned?: boolean;
}

export interface Diagnostic {
  severity: 'info' | 'warning' | 'error';
  message: string;
  entity?: string;
  relation?: string;
  file?: string;
}

export interface SystemRegistry {
  schema: typeof REGISTRY_SCHEMA;
  /** The index it was built from. */
  revision: RepoRevision;
  /** The rules version that built it: rebuilding the same index with the same rules gives the same registry. */
  rules: string;
  entities: Record<string, Entity>;
  relations: Record<string, Relation>;
  evidence: Record<string, Evidence>;
  sequences: Record<string, Sequence>;
  interpretations: Record<string, Interpretation>;
  diagnostics: Diagnostic[];
  coverage: IndexCoverage;
  incomplete: boolean;
  /** True for hand-made registries used by tests and the second-system demonstration. Never presented as an index of a repository. */
  fixture?: { label: string; note: string };
}

/** What changed between two registry snapshots, by entity and relation id. */
export interface RegistryDiff {
  from: string;
  to: string;
  entities: { added: string[]; removed: string[]; changed: string[] };
  relations: { added: string[]; removed: string[]; changed: string[] };
}

/* ======================================================================================================
 * 3. View: the question, and the slice of the registry selected for it
 * ==================================================================================================== */

/**
 * What the person is trying to do. Each lens composes the same entities differently:
 *   organization       how is it organised: parts and relationships, composition.
 *   path               how does something travel: a sequence through the parts (command path).
 *   failure            what happens when something goes wrong: the sequence, the state, the branch taken.
 *   dataflow           where information moves: data entities, reads and writes, transformations.
 *   interface-change   changing what people see: the interface and what supports it.
 *   change-review      reviewing a change: affected parts and the evidence for each.
 */
export const LENSES = ['organization', 'path', 'failure', 'dataflow', 'interface-change', 'change-review'] as const;
export type Lens = (typeof LENSES)[number];

/** Who chose this view. An agent's choice is drawn as a proposal until a person keeps it. */
export interface ViewSource { kind: 'manual' | 'preset' | 'agent' | 'harness'; id: string; name: string }

/**
 * The contract a coding agent will use: name the question, the lens and the entities that matter, and the
 * renderer composes the rest. Ids only, no coordinates. Validated by `parseViewRequest` (view.ts).
 */
export interface ViewRequest {
  schema: typeof VIEW_SCHEMA;
  id: string;
  title: string;
  question: string;
  lens: Lens;
  /** The entities the view is about. Their parents are added for context; neighbours per `depth`. */
  focus: string[];
  /** Also show these. */
  include?: string[];
  exclude?: string[];
  /** Relations to draw; default: every kind the lens draws. */
  relationKinds?: RelationKind[];
  /** How many relation hops from the focus to include (0–3, default 1). */
  depth?: number;
  /** For path and failure: the sequence to show. */
  sequence?: string;
  /** For failure: the step where it goes wrong, and the branch taken there. */
  failureAt?: string;
  /** Open inside this entity (a component id) when the view opens. */
  enter?: string;
  /** For change-review: the files or symbols the change touches. */
  changed?: string[];
  /** Entities and relations the view proposes (not in the code); drawn proposed. */
  proposals?: { entities?: Entity[]; relations?: Relation[] };
  source: ViewSource;
  /** Why these were chosen, shown with the view. */
  rationale?: string;
}

/** A view as the registry resolves it: every id checked, with the reason each entity is on the canvas. */
export interface ResolvedView {
  request: ViewRequest;
  entities: string[];
  relations: string[];
  /** Why each entity is included: 'focus' | 'include' | 'parent' | 'neighbour' | 'sequence' | 'changed' | 'proposal'. */
  why: Record<string, string>;
  /** Ids in the request the registry doesn't have (deleted, renamed, never existed). */
  missing: string[];
  warnings: string[];
}

/** A person's place in a view: saved, so closing and reopening returns them to it. */
export interface ViewState {
  view: string;
  /** The registry fingerprint it was last seen against, so reopening can say what changed since. */
  seenFingerprint: string;
  /** The path of entered components, outermost first. */
  entered: string[];
  selection: { entity: string } | { relation: string } | { step: string; sequence: string } | null;
  /** Per level (the entered path joined by '/', '' for the top): camera centre and zoom. */
  cameras: Record<string, { x: number; y: number; z: number }>;
  /** Where people put things (stage units, per level key): wins over layout. */
  pinned: Record<string, Record<string, [number, number]>>;
  /** Components whose internals are expanded in place (without entering). */
  expanded: string[];
  playback?: { sequence: string; step: number };
}

/* ======================================================================================================
 * 5. Traces: runtime events, when a run was recorded
 * ==================================================================================================== */

export interface Trace {
  schema: typeof TRACE_SCHEMA;
  id: string;
  title: string;
  /** Where and when it was recorded, said with the drawing. */
  recorded: { at: string; where: string; by: string };
  revision?: string;
  events: { at: number; entity: string; label: string; data?: Record<string, string | number | boolean> }[];
}

/* ---------- Small helpers everyone uses. ---------- */

export const relationKey = (from: string, kind: string, to: string) => `${from}--${kind}--${to}`;

/** `src/a/b.ts#Name` → `{ file: 'src/a/b.ts', name: 'Name' }`. */
export function splitSymbolId(id: string): { file: string; name: string } {
  const i = id.indexOf('#');
  return i < 0 ? { file: id, name: '' } : { file: id.slice(0, i), name: id.slice(i + 1) };
}

/** A stable slug from any name: `Canvas client` → `canvas-client`. */
export function slug(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'x';
}

export const isKnownEntityKind = (k: string): k is KnownEntityKind => (ENTITY_KINDS as readonly string[]).includes(k);
export const isKnownRelationKind = (k: string): k is KnownRelationKind => (RELATION_KINDS as readonly string[]).includes(k);
