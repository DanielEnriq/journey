import { arr, bool, id, int, obj, oneOf, only, optId, optStr, path, str, strings, table, type Obj } from './check.js';
import { CanvasError, invalid, type CanvasErrorCode } from './errors.js';
import {
  COMPONENT_KINDS, NOTE_KINDS, RELATIONSHIP_KINDS, VIEW_TYPES,
  type CanvasRef, type ComponentKind, type NoteKind, type RelationshipKind, type ViewType,
} from './model.js';

// The Canvas Command API: everything that changes a room's canvas, from a person's pen or from Vowe,
// is one of these, validated here and applied by engine.ts. Names and payloads are the contract with the
// reasoning runtime (INTEGRATION.md); `tools.ts` publishes them as JSON Schema tool definitions.
//
// A command is { schema, id, name, args }. `id` is chosen by whoever issues it and makes retries
// idempotent-safe to trace; entities a command creates derive their ids from it.

export const COMMAND_SCHEMA = 'vowe.canvas.command/1';

export interface ComponentInput {
  id: string;
  kind: ComponentKind;
  name: string;
  short?: string;
  tech?: string;
  parent?: string;
  endpoint?: string;
  lease?: string;
  rows?: string[][];
  label?: string;
  amount?: string;
  state?: 'waiting' | 'leased' | 'done';
  facts?: Record<string, string>;
  note?: string;
}

export interface ConnectionInput {
  from: string;
  to: string;
  kind: RelationshipKind;
  label?: string;
  past?: string;
}

export interface StepInput { actor: string; op: 'lease' | 'effect' | 'ack' | 'crash' | 'expire' | 'timeout' | 'note'; title: string; sub: string; tone?: 'crash' | 'bad' | 'good' }

/** Every command, by name, with its arguments. */
export interface CommandArgs {
  /** Loads a whole system as structured input; `replace` clears the document first. */
  load_system: { components: ComponentInput[]; relationships: ConnectionInput[]; replace?: boolean };
  add_component: { component: ComponentInput };
  update_component: { component: string; patch: Partial<Omit<ComponentInput, 'id'>> };
  remove_component: { component: string };
  connect_components: ConnectionInput;
  /** Points at components with Vowe's focus ring; an empty list clears it. */
  highlight_component: { components: string[] };
  annotate_component: { component: string; text: string; kind?: NoteKind };
  /**
   * Makes a view the one everyone sees. `view` is a view id, or a representation type, in which case
   * the room's view of that type (about `focus`, if given) is shown, and drawn first if there is none.
   */
  show_view: { view: string; focus?: string; instances?: number };
  create_view: {
    type: ViewType; id?: string; name?: string; question?: string; focus?: string; subject?: string;
    instances?: number; steps?: StepInput[]; parent?: string; show?: boolean;
  };
  /** Failure flow: the focus crashes (or times out) after a step, before its acknowledgment. */
  add_failure: { view?: string; component: string; after?: string; mode: 'crash' | 'timeout' };
  /** Changes the system only as a proposal: dashed until a person accepts it. */
  propose_change: { title: string; rationale?: string; changes: ProposalChange[] };
  accept_proposal: { proposal: string };
  reject_proposal: { proposal: string };
  /** A view Vowe proposed becomes one the room keeps. */
  keep_view: { view: string };
  remove_view: { view: string };
  /** A person's pen: ink, or a circle around what they mean. */
  draw: { view: string; kind: 'ink' | 'circle'; d: string; refs?: CanvasRef[] };
  remove_annotation: { annotation: string };
  keep_note: { annotation: string };
  /** Undoes the given command, or the actor's own latest one. */
  undo: { command?: string };
}

export type CommandName = keyof CommandArgs;
export const COMMAND_NAMES = [
  'load_system', 'add_component', 'update_component', 'remove_component', 'connect_components', 'highlight_component',
  'annotate_component', 'show_view', 'create_view', 'add_failure', 'propose_change', 'accept_proposal', 'reject_proposal',
  'keep_view', 'remove_view', 'draw', 'remove_annotation', 'keep_note', 'undo',
] as const satisfies readonly CommandName[];

export type ProposalChange =
  | { name: 'add_component'; args: CommandArgs['add_component'] }
  | { name: 'update_component'; args: CommandArgs['update_component'] }
  | { name: 'connect_components'; args: CommandArgs['connect_components'] };

export type CanvasCommand = { [K in CommandName]: { schema: typeof COMMAND_SCHEMA; id: string; name: K; args: CommandArgs[K] } }[CommandName];

/** What changed, by id, so a caller can say what it did and point at it. */
export interface Changed { components: string[]; relationships: string[]; views: string[]; annotations: string[]; proposals: string[] }

export type CommandResult =
  | {
    ok: true; command: string; name: CommandName; revision: number;
    /** `proposed`: it landed dashed, waiting on a person; `noop`: nothing needed to change. */
    applied: 'applied' | 'proposed' | 'noop';
    changed: Changed; activeView: string; message: string;
  }
  | { ok: false; command: string; name: string; error: { code: CanvasErrorCode; message: string; path?: string } };

const COMMAND_ID = /^[A-Za-z0-9_-]{6,64}$/;

/** Builds a command with a fresh id; the runtime's tool calls go through `fromToolCall`. */
export function command<K extends CommandName>(name: K, args: CommandArgs[K], commandId = newCommandId()): CanvasCommand {
  return { schema: COMMAND_SCHEMA, id: commandId, name, args } as CanvasCommand;
}

export function newCommandId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return 'c' + (c?.randomUUID ? c.randomUUID().replace(/-/g, '').slice(0, 20) : Math.random().toString(36).slice(2) + Date.now().toString(36));
}

/** A tool call from the reasoning runtime, `{ name, arguments }`, as a validated command. */
export function fromToolCall(name: string, args: unknown, commandId?: string): CanvasCommand {
  return parseCommand({ schema: COMMAND_SCHEMA, id: commandId ?? newCommandId(), name, args });
}

/** Validates an untrusted command. Throws CanvasError('invalid') naming the field that is wrong. */
export function parseCommand(raw: unknown): CanvasCommand {
  const o = obj(raw, 'command');
  only(o, ['schema', 'id', 'name', 'args'], 'command');
  if (o.schema !== COMMAND_SCHEMA) throw invalid(`must be "${COMMAND_SCHEMA}"`, 'command.schema');
  if (typeof o.id !== 'string' || !COMMAND_ID.test(o.id)) throw invalid('must be 6–64 letters, digits, - or _', 'command.id');
  const name = oneOf(o.name, COMMAND_NAMES, 'command.name');
  const args = parseArgs(name, o.args ?? {});
  return { schema: COMMAND_SCHEMA, id: o.id, name, args } as CanvasCommand;
}

export function parseArgs<K extends CommandName>(name: K, raw: unknown): CommandArgs[K] {
  const a = obj(raw, 'args');
  const p = (f: string) => `args.${f}`;
  const parsers: { [N in CommandName]: () => CommandArgs[N] } = {
    load_system: () => {
      only(a, ['components', 'relationships', 'replace'], 'args');
      return {
        components: arr(a.components, p('components'), 200).map((c, i) => component(c, p(`components[${i}]`))),
        relationships: arr(a.relationships ?? [], p('relationships'), 400).map((r, i) => connection(r, p(`relationships[${i}]`))),
        ...(a.replace !== undefined ? { replace: bool(a.replace, p('replace')) } : {}),
      };
    },
    add_component: () => { only(a, ['component'], 'args'); return { component: component(a.component, p('component')) }; },
    update_component: () => {
      only(a, ['component', 'patch'], 'args');
      const raw = obj(a.patch, p('patch'));
      if (raw.id !== undefined) throw invalid('a component’s id never changes; add a new one instead', p('patch.id'));
      const patch = component({ ...raw, id: 'patch' }, p('patch'), true);
      const { id: _id, ...rest } = patch;
      if (!Object.keys(rest).length) throw invalid('must change at least one field', p('patch'));
      return { component: id(a.component, p('component')), patch: rest };
    },
    remove_component: () => { only(a, ['component'], 'args'); return { component: id(a.component, p('component')) }; },
    connect_components: () => connection(a, 'args'),
    highlight_component: () => {
      only(a, ['components', 'component'], 'args');
      // `component` alone is accepted for a single part, the way people say it.
      if (a.component !== undefined && a.components !== undefined) throw invalid('give `component` or `components`, not both', 'args');
      if (a.component !== undefined) return { components: [id(a.component, p('component'))] };
      return { components: arr(a.components, p('components'), 20).map((c, i) => id(c, p(`components[${i}]`))) };
    },
    annotate_component: () => {
      only(a, ['component', 'text', 'kind'], 'args');
      return {
        component: id(a.component, p('component')), text: str(a.text, p('text'), 1000),
        ...(a.kind !== undefined ? { kind: oneOf(a.kind, NOTE_KINDS, p('kind')) } : {}),
      };
    },
    show_view: () => {
      only(a, ['view', 'focus', 'instances'], 'args');
      const view = typeof a.view === 'string' && (VIEW_TYPES as readonly string[]).includes(a.view) ? a.view : id(a.view, p('view'));
      return {
        view, ...(a.focus !== undefined ? { focus: id(a.focus, p('focus')) } : {}),
        ...(a.instances !== undefined ? { instances: int(a.instances, p('instances'), 2, 4) } : {}),
      };
    },
    create_view: () => {
      only(a, ['type', 'id', 'name', 'question', 'focus', 'subject', 'instances', 'steps', 'parent', 'show'], 'args');
      const out: CommandArgs['create_view'] = { type: oneOf(a.type, VIEW_TYPES, p('type')) };
      if (a.id !== undefined) out.id = id(a.id, p('id'));
      if (a.name !== undefined) out.name = str(a.name, p('name'), 60);
      if (a.question !== undefined) out.question = str(a.question, p('question'), 200);
      if (a.focus !== undefined) out.focus = id(a.focus, p('focus'));
      if (a.subject !== undefined) out.subject = id(a.subject, p('subject'));
      if (a.instances !== undefined) out.instances = int(a.instances, p('instances'), 2, 4);
      if (a.parent !== undefined) out.parent = id(a.parent, p('parent'));
      if (a.show !== undefined) out.show = bool(a.show, p('show'));
      if (a.steps !== undefined) out.steps = arr(a.steps, p('steps'), 12).map((s, i) => step(s, p(`steps[${i}]`)));
      return out;
    },
    add_failure: () => {
      only(a, ['view', 'component', 'after', 'mode'], 'args');
      return {
        component: id(a.component, p('component')), mode: oneOf(a.mode ?? 'crash', ['crash', 'timeout'] as const, p('mode')),
        ...(a.view !== undefined ? { view: id(a.view, p('view')) } : {}),
        ...(a.after !== undefined ? { after: str(a.after, p('after'), 80) } : {}),
      };
    },
    propose_change: () => {
      only(a, ['title', 'rationale', 'changes'], 'args');
      const changes = arr(a.changes, p('changes'), 30).map((c, i): ProposalChange => {
        const co = obj(c, p(`changes[${i}]`));
        only(co, ['name', 'args'], p(`changes[${i}]`));
        const n = oneOf(co.name, ['add_component', 'update_component', 'connect_components'] as const, p(`changes[${i}].name`));
        try { return { name: n, args: parseArgs(n, co.args) } as ProposalChange; }
        catch (err) { throw rePath(err, p(`changes[${i}].`)); }
      });
      if (!changes.length) throw invalid('must propose at least one change', p('changes'));
      return { title: str(a.title, p('title'), 200), changes, ...(a.rationale !== undefined ? { rationale: str(a.rationale, p('rationale'), 1000) } : {}) };
    },
    accept_proposal: () => { only(a, ['proposal'], 'args'); return { proposal: str(a.proposal, p('proposal'), 80) }; },
    reject_proposal: () => { only(a, ['proposal'], 'args'); return { proposal: str(a.proposal, p('proposal'), 80) }; },
    keep_view: () => { only(a, ['view'], 'args'); return { view: id(a.view, p('view')) }; },
    remove_view: () => { only(a, ['view'], 'args'); return { view: id(a.view, p('view')) }; },
    draw: () => {
      only(a, ['view', 'kind', 'd', 'refs'], 'args');
      return {
        view: id(a.view, p('view')), kind: oneOf(a.kind, ['ink', 'circle'] as const, p('kind')), d: path(a.d, p('d')),
        ...(a.refs !== undefined ? { refs: arr(a.refs, p('refs'), 40).map((r, i) => ref(r, p(`refs[${i}]`))) } : {}),
      };
    },
    remove_annotation: () => { only(a, ['annotation'], 'args'); return { annotation: str(a.annotation, p('annotation'), 80) }; },
    keep_note: () => { only(a, ['annotation'], 'args'); return { annotation: str(a.annotation, p('annotation'), 80) }; },
    undo: () => { only(a, ['command'], 'args'); return a.command !== undefined ? { command: str(a.command, p('command'), 80) } : {}; },
  };
  return parsers[name]() as CommandArgs[K];
}

function rePath(err: unknown, prefix: string) {
  return err instanceof CanvasError && err.path ? new CanvasError(err.code, err.message.replace(`${err.path}: `, ''), prefix + err.path) : err;
}

const COMPONENT_FIELDS = ['id', 'kind', 'name', 'short', 'tech', 'parent', 'endpoint', 'lease', 'rows', 'label', 'amount', 'state', 'facts', 'note'];

function component(raw: unknown, at: string, partial = false): ComponentInput {
  const c = obj(raw, at);
  only(c, COMPONENT_FIELDS, at);
  const out: Partial<ComponentInput> = { id: partial ? 'patch' : id(c.id, `${at}.id`) };
  if (!partial || c.kind !== undefined) out.kind = oneOf(c.kind, COMPONENT_KINDS, `${at}.kind`);
  if (!partial || c.name !== undefined) out.name = str(c.name, `${at}.name`, 80);
  const text: [keyof ComponentInput, number][] = [['short', 80], ['tech', 120], ['endpoint', 120], ['lease', 40], ['label', 40], ['amount', 40], ['note', 240]];
  for (const [k, max] of text) if (c[k] !== undefined) (out as Obj)[k] = optStr(c[k], `${at}.${k}`, max);
  if (c.parent !== undefined) out.parent = optId(c.parent, `${at}.parent`);
  if (c.rows !== undefined) out.rows = table(c.rows, `${at}.rows`);
  if (c.state !== undefined) out.state = oneOf(c.state, ['waiting', 'leased', 'done'] as const, `${at}.state`);
  if (c.facts !== undefined) out.facts = strings(c.facts, `${at}.facts`, 12);
  return out as ComponentInput;
}

function connection(raw: unknown, at: string): ConnectionInput {
  const r = obj(raw, at);
  only(r, ['from', 'to', 'kind', 'label', 'past'], at);
  const out: ConnectionInput = { from: id(r.from, `${at}.from`), to: id(r.to, `${at}.to`), kind: oneOf(r.kind, RELATIONSHIP_KINDS, `${at}.kind`) };
  if (out.from === out.to) throw invalid('a component can’t connect to itself', `${at}.to`);
  if (r.label !== undefined) out.label = str(r.label, `${at}.label`, 40);
  if (r.past !== undefined) out.past = str(r.past, `${at}.past`, 40);
  return out;
}

function step(raw: unknown, at: string): StepInput {
  const s = obj(raw, at);
  only(s, ['actor', 'op', 'title', 'sub', 'tone'], at);
  return {
    actor: id(s.actor, `${at}.actor`), op: oneOf(s.op, ['lease', 'effect', 'ack', 'crash', 'expire', 'timeout', 'note'] as const, `${at}.op`),
    title: str(s.title, `${at}.title`, 60), sub: str(s.sub, `${at}.sub`, 80),
    ...(s.tone !== undefined ? { tone: oneOf(s.tone, ['crash', 'bad', 'good'] as const, `${at}.tone`) } : {}),
  };
}

export function ref(raw: unknown, at: string): CanvasRef {
  const r = obj(raw, at);
  if (r.step !== undefined) {
    only(r, ['step', 'view', 'component'], at);
    return { step: str(r.step, `${at}.step`, 80), view: id(r.view, `${at}.view`), component: id(r.component, `${at}.component`) };
  }
  only(r, ['component', 'instance'], at);
  return { component: id(r.component, `${at}.component`), ...(r.instance !== undefined ? { instance: int(r.instance, `${at}.instance`, 1, 8) } : {}) };
}
