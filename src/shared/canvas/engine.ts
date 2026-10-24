import type { CanvasCommand, Changed, CommandArgs, CommandName, CommandResult, ComponentInput, ConnectionInput, ProposalChange } from './commands.js';
import { CanvasError } from './errors.js';
import {
  ARCHITECTURE_VIEW, HISTORY_LIMIT, isAgent, relationshipId, VIEW_TYPES,
  type Actor, type Annotation, type CanvasDocument, type CanvasRef, type Component, type Highlight, type HistoryEntry,
  type Proposal, type Relationship, type Touch, type ViewSpec, type ViewType,
} from './model.js';
import { dangling } from './validate.js';
import { countWord, gerund } from './words.js';
import { castOf, failSteps, happySteps, readSystem, viewOf } from './views/index.js';

// Applies one validated command to a document and says what changed. Pure and deterministic given the
// same document, command, actor and time: ids of anything a command creates come from the command's
// id, so applying it optimistically in a renderer and authoritatively in main gives the same document.
//
// Rules that hold for every caller:
//   - Vowe (an `agent` actor) never changes the system outright: its structural changes land as a
//     proposal, drawn dashed, until a person accepts it. Its views land proposed too, until kept.
//   - Only people accept or reject proposals, keep views, and keep Vowe's suggested notes.
//   - Every change records what it touched before and after, so its author can undo it later unless
//     someone else changed the same thing since.

export interface Applied {
  doc: CanvasDocument;
  result: Omit<Extract<CommandResult, { ok: true }>, 'revision'>;
}

export function applyCommand(doc: CanvasDocument, cmd: CanvasCommand, actor: Actor, now = new Date().toISOString()): Applied {
  const tx = new Tx(clone(doc), cmd, actor, now);
  const run = HANDLERS[cmd.name] as (tx: Tx, args: unknown) => string;
  const message = run(tx, cmd.args);
  tx.commit(cmd.name !== 'undo' && cmd.name !== 'show_view' || tx.created);
  const proposed = tx.proposedSomething;
  const changed = tx.changed;
  const any = Object.values(changed).some((l) => l.length) || tx.movedView;
  return {
    doc: tx.doc,
    result: {
      ok: true, command: cmd.id, name: cmd.name, applied: !any ? 'noop' : proposed ? 'proposed' : 'applied',
      changed, activeView: tx.doc.activeView, message,
    },
  };
}

/** A command that failed, as the result a caller gets back. */
export function failure(cmd: { id?: string; name?: string } | null, err: unknown): Extract<CommandResult, { ok: false }> {
  const e = err instanceof CanvasError ? err : new CanvasError('unknown', (err as Error)?.message ?? String(err));
  return { ok: false, command: cmd?.id ?? '', name: cmd?.name ?? '', error: { code: e.code, message: e.message, ...(e.path ? { path: e.path } : {}) } };
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

type Coll = 'components' | 'relationships' | 'views' | 'annotations' | 'proposals';

/** One command's changes, recording what each entity was before it was first touched. */
class Tx {
  readonly before: Touch = {};
  readonly changed: Changed = { components: [], relationships: [], views: [], annotations: [], proposals: [] };
  movedView = false;
  created = false;
  proposedSomething = false;
  /** Set while applying a proposal's changes. */
  proposal: Proposal | null = null;
  private seq = 0;

  constructor(public doc: CanvasDocument, readonly cmd: CanvasCommand, readonly actor: Actor, readonly now: string) {}

  /** A stable id for the nth thing this command creates. */
  newId(prefix: string) { return `${prefix}-${this.cmd.id}${this.seq++ ? '-' + this.seq : ''}`; }

  set<K extends Coll>(coll: K, id: string, value: CanvasDocument[K][string] | null) {
    const bucket = (this.before[coll] ??= {}) as Record<string, unknown>;
    if (!(id in bucket)) bucket[id] = this.doc[coll][id] ? clone(this.doc[coll][id]) : null;
    const target = this.doc[coll] as Record<string, unknown>;
    if (value === null) delete target[id]; else target[id] = value;
    if (!this.changed[coll].includes(id)) this.changed[coll].push(id);
  }

  setActive(view: string) {
    if (this.doc.activeView === view) return;
    if (!('activeView' in this.before)) this.before.activeView = this.doc.activeView;
    this.doc.activeView = view;
    this.movedView = true;
  }

  setHighlight(h: Highlight | null) {
    if (!('highlight' in this.before)) this.before.highlight = this.doc.highlight ? clone(this.doc.highlight) : null;
    this.doc.highlight = h;
    this.movedView = true;
  }

  /** Records the change for undo; navigation alone isn't recorded. */
  commit(record: boolean) {
    const keys = Object.keys(this.before) as (keyof Touch)[];
    if (!record || !keys.length) return;
    const after: Touch = {};
    for (const k of keys) {
      if (k === 'activeView') after.activeView = this.doc.activeView;
      else if (k === 'highlight') after.highlight = this.doc.highlight ? clone(this.doc.highlight) : null;
      else {
        const ids = Object.keys(this.before[k]!);
        (after as Record<string, unknown>)[k] = Object.fromEntries(ids.map((id) => [id, (this.doc[k] as Record<string, unknown>)[id] ?? null]));
      }
    }
    const entry: HistoryEntry = { command: this.cmd.id, name: this.cmd.name, by: this.actor, at: this.now, before: clone(this.before), after: clone(after) };
    this.doc.history = this.doc.history.concat([entry]).slice(-HISTORY_LIMIT);
  }

  component(id: string, path = 'args.component'): Component {
    const c = this.doc.components[id];
    if (!c) throw new CanvasError('not-found', `No component "${id}" on this canvas`, path);
    return c;
  }

  view(id: string, path = 'args.view'): ViewSpec {
    const v = viewOf(this.doc, id);
    if (!v) throw new CanvasError('not-found', `No view "${id}" on this canvas`, path);
    return v;
  }

  humansOnly(what: string) {
    if (isAgent(this.actor)) throw new CanvasError('forbidden', `Only a person in the room can ${what}.`);
  }
}

/* ---------- The system: components and relationships. ---------- */

/** What a component may sit inside: services in boundaries, events in queues. */
function checkParent(tx: Tx, c: ComponentInput, path: string) {
  if (!c.parent) {
    if (c.kind === 'event') throw new CanvasError('invalid', 'an event lives in a queue: give its `parent`', `${path}.parent`);
    return;
  }
  const p = tx.doc.components[c.parent];
  if (!p) throw new CanvasError('not-found', `No component "${c.parent}" to put it in`, `${path}.parent`);
  const ok = c.kind === 'event' ? p.kind === 'queue' : p.kind === 'boundary';
  if (!ok) throw new CanvasError('invalid', c.kind === 'event' ? 'an event’s parent must be a queue' : `a ${c.kind}’s parent must be a boundary`, `${path}.parent`);
}

function addComponent(tx: Tx, input: ComponentInput, path: string) {
  if (tx.doc.components[input.id]) throw new CanvasError('conflict', `"${input.id}" is already on the canvas; update it instead`, `${path}.id`);
  checkParent(tx, input, path);
  const c: Component = { ...clone(input), status: tx.proposal ? 'proposed' : 'agreed', ...(tx.proposal ? { proposal: tx.proposal.id } : {}) };
  tx.set('components', c.id, c);
  tx.proposal?.components.push(c.id);
  ensureArchitecture(tx);
}

function updateComponent(tx: Tx, id: string, patch: CommandArgs['update_component']['patch'], path: string) {
  const cur = tx.component(id, `${path}.component`);
  const next: Component = { ...cur, ...clone(patch) };
  if (patch.kind && patch.kind !== cur.kind) {
    const used = Object.values(tx.doc.relationships).some((r) => r.from === id || r.to === id);
    if (used) throw new CanvasError('conflict', `${cur.name} is connected; remove its connections before changing what kind of thing it is`, `${path}.patch.kind`);
  }
  checkParent(tx, next, `${path}.patch`);
  if (same(next, cur)) return;
  if (tx.proposal) {
    if (!(id in tx.proposal.before) && cur.status === 'agreed') tx.proposal.before[id] = clone(cur);
    next.status = 'proposed';
    next.proposal = tx.proposal.id;
    if (!tx.proposal.components.includes(id)) tx.proposal.components.push(id);
  }
  tx.set('components', id, next);
}

const REL_RULES: Record<Relationship['kind'], { to?: Component['kind'][]; not: Component['kind'][]; say?: string }> = {
  calls: { not: ['queue', 'database', 'event', 'boundary'], say: 'a call goes to a service, worker or external system' },
  publishes: { to: ['queue'], not: [], say: 'something publishes to a queue' },
  consumes: { to: ['queue'], not: [], say: 'something consumes from a queue' },
  reads_writes: { to: ['database'], not: [], say: 'reads and writes go to a database' },
  depends_on: { not: ['event', 'boundary'] },
  retries: { not: ['event', 'boundary'] },
};

function connect(tx: Tx, input: ConnectionInput, path: string) {
  const from = tx.component(input.from, `${path}.from`), to = tx.component(input.to, `${path}.to`);
  if (from.kind === 'event' || from.kind === 'boundary') throw new CanvasError('invalid', `a ${from.kind} doesn’t ${input.kind.replace('_', '/')} anything`, `${path}.from`);
  const rule = REL_RULES[input.kind];
  if ((rule.to && !rule.to.includes(to.kind)) || rule.not.includes(to.kind)) {
    throw new CanvasError('invalid', `${from.name} can’t ${input.kind.replace('_', '/')} ${to.name} (a ${to.kind}): ${rule.say ?? 'not a valid target'}`, `${path}.to`);
  }
  const id = relationshipId(input.from, input.kind, input.to);
  const existing = tx.doc.relationships[id];
  const rel: Relationship = {
    id, kind: input.kind, from: input.from, to: input.to,
    ...(input.label ? { label: input.label } : {}), ...(input.past ? { past: input.past } : {}),
    status: tx.proposal ? 'proposed' : 'agreed', ...(tx.proposal ? { proposal: tx.proposal.id } : {}),
  };
  if (existing && existing.label === rel.label && existing.past === rel.past && existing.status === rel.status) return;
  tx.set('relationships', id, rel);
  if (tx.proposal && !tx.proposal.relationships.includes(id)) tx.proposal.relationships.push(id);
}

function removeComponent(tx: Tx, id: string) {
  tx.component(id);
  for (const r of Object.values(tx.doc.relationships)) if (r.from === id || r.to === id) tx.set('relationships', r.id, null);
  for (const c of Object.values(tx.doc.components)) {
    if (c.parent !== id) continue;
    if (c.kind === 'event') removeComponent(tx, c.id);
    else { const { parent: _p, ...rest } = c; tx.set('components', c.id, rest as Component); }
  }
  for (const v of Object.values(tx.doc.views)) if (v.focus === id || v.subject === id) removeView(tx, v.id);
  for (const a of Object.values(tx.doc.annotations)) if (a.kind === 'note' && a.on === id) tx.set('annotations', a.id, null);
  if (tx.doc.highlight?.components.includes(id)) {
    const rest = tx.doc.highlight.components.filter((c) => c !== id);
    tx.setHighlight(rest.length ? { ...tx.doc.highlight, components: rest } : null);
  }
  tx.set('components', id, null);
}

/** Proposals are how Vowe changes a system: applied dashed, kept or rolled back by a person. */
function propose(tx: Tx, title: string, rationale: string | undefined, changes: ProposalChange[]): Proposal {
  const p: Proposal = { id: tx.newId('p'), title, ...(rationale ? { rationale } : {}), status: 'open', by: tx.actor, at: tx.now, components: [], relationships: [], before: {} };
  tx.proposal = p;
  changes.forEach((ch, i) => {
    const at = `args.changes[${i}].args`;
    if (ch.name === 'add_component') addComponent(tx, ch.args.component, `${at}.component`);
    else if (ch.name === 'update_component') updateComponent(tx, ch.args.component, ch.args.patch, at);
    else connect(tx, ch.args, at);
  });
  tx.proposal = null;
  tx.set('proposals', p.id, p);
  tx.proposedSomething = true;
  return p;
}

/** Vowe's structural commands go through a proposal named after what it asked for. */
function structural(tx: Tx, title: string, changes: ProposalChange[], direct: () => void): string | null {
  if (!isAgent(tx.actor)) { direct(); return null; }
  const p = propose(tx, title, undefined, changes);
  return `Proposed “${p.title}” (${p.id}); it stays dashed until someone in the room accepts it.`;
}

/* ---------- Views. ---------- */

function ensureArchitecture(tx: Tx) {
  if (tx.doc.views[ARCHITECTURE_VIEW]) return;
  tx.set('views', ARCHITECTURE_VIEW, {
    id: ARCHITECTURE_VIEW, type: 'architecture', name: 'Architecture', question: 'What is this system?',
    provenance: 'From the room’s system', status: 'agreed', by: tx.actor, at: tx.now,
  });
}

const NAMES: Record<ViewType, string> = { architecture: 'Architecture', 'failure-flow': 'Failure flow', concurrency: 'Concurrency' };

function createView(tx: Tx, a: CommandArgs['create_view']): ViewSpec {
  const sys = readSystem(tx.doc);
  if (a.type !== 'architecture' && !a.focus) throw new CanvasError('invalid', `a ${NAMES[a.type]} view is about one component: give its \`focus\``, 'args.focus');
  const cast = a.focus ? castOf(sys, a.focus, a.subject) : null;
  if (a.parent) tx.view(a.parent, 'args.parent');
  if (a.steps) a.steps.forEach((s, i) => tx.component(s.actor, `args.steps[${i}].actor`));
  let id = a.id ?? (a.type === 'architecture' ? ARCHITECTURE_VIEW : a.type);
  if (!a.id && tx.doc.views[id]) id = `${a.type}-${a.focus}`;
  if (viewOf(tx.doc, id) && (tx.doc.views[id] || id === ARCHITECTURE_VIEW && a.type !== 'architecture')) {
    throw new CanvasError('conflict', `A view "${id}" already exists; show it, or give the new one another id`, 'args.id');
  }
  const f = cast?.focus, job = cast?.job;
  const question = a.question ?? (a.type === 'architecture' ? 'What is this system?'
    : a.type === 'failure-flow' ? `What if ${f!.short ?? 'the ' + f!.name.toLowerCase()} fails mid-job?`
    : `What if ${countWord(a.instances ?? 2)} ${(f!.short ?? f!.name).replace(/^the /, '')}s take the same job?`);
  const parent = a.parent ?? (a.type === 'concurrency'
    ? Object.values(tx.doc.views).find((v) => v.type === 'failure-flow' && v.focus === a.focus)?.id ?? ARCHITECTURE_VIEW
    : a.type === 'failure-flow' ? ARCHITECTURE_VIEW : undefined);
  const spec: ViewSpec = {
    id, type: a.type, name: a.name ?? NAMES[a.type], question,
    provenance: (isAgent(tx.actor) ? 'Drawn by Vowe from the room’s system' : 'From the room’s system') + (job?.label ? ` · job ${job.label}` : ''),
    ...(parent ? { parent } : {}), ...(a.focus ? { focus: a.focus } : {}), ...(job ? { subject: job.id } : {}),
    ...(a.type === 'failure-flow' ? { steps: a.steps ? a.steps.map((s, i) => ({ id: `s${i + 1}`, ...s })) : happySteps(cast!) } : {}),
    ...(a.type === 'concurrency' ? { instances: a.instances ?? 2 } : {}),
    status: isAgent(tx.actor) ? 'proposed' : 'agreed', by: tx.actor, at: tx.now,
  };
  tx.set('views', id, spec);
  tx.created = true;
  if (spec.status === 'proposed') tx.proposedSomething = true;
  return spec;
}

function removeView(tx: Tx, id: string) {
  if (id === ARCHITECTURE_VIEW) throw new CanvasError('forbidden', 'The Architecture view is the system itself; it can’t be removed', 'args.view');
  tx.view(id);
  for (const a of Object.values(tx.doc.annotations)) if (a.kind !== 'note' && a.view === id) tx.set('annotations', a.id, null);
  for (const v of Object.values(tx.doc.views)) if (v.parent === id) tx.set('views', v.id, { ...v, parent: tx.doc.views[id]?.parent ?? ARCHITECTURE_VIEW });
  tx.set('views', id, null);
  if (tx.doc.activeView === id) tx.setActive(ARCHITECTURE_VIEW);
}

function refExists(tx: Tx, r: CanvasRef, path: string) {
  tx.component(r.component, `${path}.component`);
  if ('step' in r) tx.view(r.view, `${path}.view`);
}

/* ---------- Commands. ---------- */

type Handler<K extends CommandName> = (tx: Tx, a: CommandArgs[K]) => string;

const HANDLERS: { [K in CommandName]: Handler<K> } = {
  load_system(tx, a) {
    const order = (c: ComponentInput) => c.kind === 'boundary' ? 0 : c.kind === 'event' ? 2 : 1;
    const comps = a.components.map((c, i) => ({ c, i })).sort((x, y) => order(x.c) - order(y.c));
    const changes: ProposalChange[] = [
      ...comps.map(({ c }) => ({ name: 'add_component' as const, args: { component: c } })),
      ...a.relationships.map((r) => ({ name: 'connect_components' as const, args: r })),
    ];
    if (a.replace) {
      tx.humansOnly('replace the whole system');
      for (const k of ['components', 'relationships', 'annotations', 'proposals'] as const) for (const id of Object.keys(tx.doc[k])) tx.set(k, id, null);
      for (const id of Object.keys(tx.doc.views)) tx.set('views', id, null);
      if (tx.doc.highlight) tx.setHighlight(null);
      tx.setActive(ARCHITECTURE_VIEW);
    }
    const proposed = structural(tx, 'Load a system', changes, () => {
      comps.forEach(({ c, i }) => addComponent(tx, c, `args.components[${i}]`));
      a.relationships.forEach((r, i) => connect(tx, r, `args.relationships[${i}]`));
    });
    ensureArchitecture(tx);
    return proposed ?? `Loaded ${a.components.length} components and ${a.relationships.length} relationships.`;
  },

  add_component(tx, a) {
    return structural(tx, `Add ${a.component.name}`, [{ name: 'add_component', args: a }], () => addComponent(tx, a.component, 'args.component'))
      ?? `Added ${a.component.name}.`;
  },

  update_component(tx, a) {
    const c = tx.component(a.component);
    return structural(tx, `Change ${c.name}`, [{ name: 'update_component', args: a }], () => updateComponent(tx, a.component, a.patch, 'args'))
      ?? `Updated ${c.name}.`;
  },

  remove_component(tx, a) {
    const c = tx.component(a.component);
    tx.humansOnly('remove a component; Vowe can propose changes instead');
    removeComponent(tx, a.component);
    return `Removed ${c.name} and everything connected to it.`;
  },

  connect_components(tx, a) {
    const from = tx.component(a.from, 'args.from'), to = tx.component(a.to, 'args.to');
    return structural(tx, `${from.name} ${a.kind.replace('_', '/')} ${to.name}`, [{ name: 'connect_components', args: a }], () => connect(tx, a, 'args'))
      ?? `Connected ${from.name} → ${to.name} (${a.label ?? a.kind}).`;
  },

  highlight_component(tx, a) {
    a.components.forEach((id, i) => tx.component(id, `args.components[${i}]`));
    const next = a.components.length ? { components: a.components, by: tx.actor, at: tx.now } : null;
    if (same(next?.components, tx.doc.highlight?.components) && (next?.by.id ?? null) === (tx.doc.highlight?.by.id ?? null)) return 'Already pointing there.';
    tx.setHighlight(next);
    return next ? `Pointing at ${a.components.map((id) => tx.doc.components[id].name).join(', ')}.` : 'Stopped pointing.';
  },

  annotate_component(tx, a) {
    const c = tx.component(a.component);
    const note: Annotation = {
      id: tx.newId('n'), kind: 'note', on: c.id, note: a.kind ?? (isAgent(tx.actor) ? 'question' : 'note'), text: a.text,
      status: isAgent(tx.actor) ? 'suggested' : 'kept', by: tx.actor, at: tx.now,
    };
    tx.set('annotations', note.id, note);
    return `Noted on ${c.name}.`;
  },

  show_view(tx, a) {
    let v = viewOf(tx.doc, a.view);
    const type = (VIEW_TYPES as readonly string[]).includes(a.view) ? a.view as ViewType : null;
    if (type && !doc(tx).views[a.view] && a.view !== ARCHITECTURE_VIEW) {
      v = Object.values(tx.doc.views).find((x) => x.type === type && (!a.focus || x.focus === a.focus) && (!a.instances || x.instances === a.instances));
      if (!v) {
        const focus = a.focus ?? tx.doc.highlight?.components[0];
        v = createView(tx, { type, ...(focus ? { focus } : {}), ...(a.instances ? { instances: a.instances } : {}) });
      }
    }
    if (!v) throw new CanvasError('not-found', `No view "${a.view}" on this canvas; create_view draws a new one`, 'args.view');
    if (a.focus && v.focus && v.focus !== a.focus) throw new CanvasError('conflict', `“${v.name}” is about ${tx.doc.components[v.focus]?.name ?? v.focus}, not ${a.focus}`, 'args.focus');
    tx.setActive(v.id);
    return tx.created ? `Drew ${v.name} and showed it to everyone.` : `Showing ${v.name}.`;
  },

  create_view(tx, a) {
    const v = createView(tx, a);
    if (a.show !== false) tx.setActive(v.id);
    return `Drew ${v.name}${v.status === 'proposed' ? ', proposed until someone keeps it' : ''}.`;
  },

  add_failure(tx, a) {
    const v = a.view ? tx.view(a.view) : (() => {
      const active = viewOf(tx.doc, tx.doc.activeView);
      if (active?.type === 'failure-flow' && active.focus === a.component) return active;
      const found = Object.values(tx.doc.views).find((x) => x.type === 'failure-flow' && x.focus === a.component);
      return found ?? createView(tx, { type: 'failure-flow', focus: a.component });
    })();
    if (v.type !== 'failure-flow') throw new CanvasError('unsupported', `${v.name} isn’t a Failure flow; failures are added to a sequence`, 'args.view');
    if (v.focus !== a.component) throw new CanvasError('unsupported', `“${v.name}” follows ${tx.doc.components[v.focus!]?.name}; add the failure to a flow about ${a.component}`, 'args.component');
    const cast = castOf(readSystem(tx.doc), v.focus, v.subject);
    const steps = failSteps(cast, v.steps ?? happySteps(cast), a.after, a.mode);
    const verb = a.mode === 'crash' ? 'crashes' : 'times out';
    tx.set('views', v.id, { ...tx.doc.views[v.id] ?? v, steps, question: `What if ${cast.focus.short ?? 'the ' + cast.focus.name.toLowerCase()} ${verb} after ${gerund(cast.verb)}?` });
    tx.setActive(v.id);
    return `${cast.focus.name} ${verb} after the ${cast.verb} and before its ack: ${cast.queue.name} hands ${cast.job?.label ?? 'the job'} out again and ${cast.effect.name} sees it ${steps.filter((s) => s.op === 'effect').length === 2 ? 'twice' : 'again'}.`;
  },

  propose_change(tx, a) {
    const p = propose(tx, a.title, a.rationale, a.changes);
    return `Proposed “${p.title}” (${p.id}).`;
  },

  accept_proposal(tx, a) {
    tx.humansOnly('accept a proposal');
    const p = openProposal(tx, a.proposal);
    for (const id of p.components) { const c = tx.doc.components[id]; if (c?.proposal === p.id) { const { proposal: _x, ...rest } = c; tx.set('components', id, { ...rest, status: 'agreed' }); } }
    for (const id of p.relationships) { const r = tx.doc.relationships[id]; if (r?.proposal === p.id) { const { proposal: _x, ...rest } = r; tx.set('relationships', id, { ...rest, status: 'agreed' }); } }
    tx.set('proposals', p.id, { ...p, status: 'accepted' });
    return `Accepted “${p.title}”.`;
  },

  reject_proposal(tx, a) {
    tx.humansOnly('reject a proposal');
    const p = openProposal(tx, a.proposal);
    for (const id of p.relationships) if (tx.doc.relationships[id]?.proposal === p.id) tx.set('relationships', id, null);
    for (const id of p.components.slice().reverse()) {
      const c = tx.doc.components[id];
      if (c?.proposal !== p.id) continue;
      if (p.before[id]) tx.set('components', id, clone(p.before[id]));
      else removeComponent(tx, id);
    }
    tx.set('proposals', p.id, { ...p, status: 'rejected' });
    return `Rejected “${p.title}”.`;
  },

  keep_view(tx, a) {
    tx.humansOnly('keep a view');
    const v = tx.view(a.view);
    if (v.status === 'agreed') return `${v.name} is already kept.`;
    tx.set('views', v.id, { ...v, status: 'agreed' });
    return `Kept ${v.name}.`;
  },

  remove_view(tx, a) {
    const v = tx.view(a.view);
    if (isAgent(tx.actor) && v.by.kind !== 'agent') throw new CanvasError('forbidden', 'Vowe can only remove views it drew', 'args.view');
    removeView(tx, a.view);
    return `Removed ${v.name}.`;
  },

  draw(tx, a) {
    tx.view(a.view);
    (a.refs ?? []).forEach((r, i) => refExists(tx, r, `args.refs[${i}]`));
    const id = tx.newId(a.kind === 'ink' ? 'i' : 'o');
    tx.set('annotations', id, a.kind === 'ink'
      ? { id, kind: 'ink', view: a.view, d: a.d, by: tx.actor, at: tx.now }
      : { id, kind: 'circle', view: a.view, d: a.d, refs: a.refs ?? [], by: tx.actor, at: tx.now });
    const names = (a.refs ?? []).map((r) => tx.doc.components[r.component].name);
    return a.kind === 'circle' ? (names.length ? `Circled ${[...new Set(names)].join(', ')}.` : 'Circled empty space.') : 'Drew on the canvas.';
  },

  remove_annotation(tx, a) {
    const an = annotation(tx, a.annotation);
    if (isAgent(tx.actor) && an.by.kind !== 'agent') throw new CanvasError('forbidden', 'Vowe can only remove its own notes', 'args.annotation');
    tx.set('annotations', an.id, null);
    return 'Removed.';
  },

  keep_note(tx, a) {
    tx.humansOnly('keep a suggested note');
    const an = annotation(tx, a.annotation);
    if (an.kind !== 'note') throw new CanvasError('invalid', 'only notes are kept', 'args.annotation');
    if (an.status === 'kept') return 'Already kept.';
    tx.set('annotations', an.id, { ...an, status: 'kept' });
    return 'Kept the note.';
  },

  undo(tx, a) {
    const h = tx.doc.history;
    const idx = a.command ? h.findIndex((e) => e.command === a.command) : h.map((e) => e.by.id).lastIndexOf(tx.actor.id);
    if (idx < 0) throw new CanvasError('not-found', a.command ? `Nothing to undo for ${a.command}` : 'Nothing of yours to undo here', 'args.command');
    const entry = h[idx];
    if (entry.by.id !== tx.actor.id) throw new CanvasError('forbidden', `That was ${entry.by.name}’s change; only they can undo it`, 'args.command');
    // Undo only what nobody has changed since.
    for (const [k, ids] of Object.entries(entry.after) as [keyof Touch, unknown][]) {
      if (k === 'activeView') continue; // where everyone is looking moves on; undo doesn't fight it
      if (k === 'highlight') { if (!same(tx.doc.highlight, ids)) throw changedSince(entry); continue; }
      for (const [id, v] of Object.entries(ids as Record<string, unknown>)) {
        if (!same((tx.doc[k] as Record<string, unknown>)[id], v)) throw changedSince(entry);
      }
    }
    for (const [k, ids] of Object.entries(entry.before) as [keyof Touch, unknown][]) {
      if (k === 'activeView') { if (tx.doc.activeView === entry.after.activeView && (tx.doc.views[ids as string] || ids === ARCHITECTURE_VIEW)) tx.setActive(ids as string); continue; }
      if (k === 'highlight') { tx.setHighlight(ids as Highlight | null); continue; }
      for (const [id, v] of Object.entries(ids as Record<string, unknown>)) tx.set(k, id, v as never);
    }
    const left = dangling(tx.doc);
    if (left) throw new CanvasError('conflict', `Someone built on this since; undoing ${entry.name.replace(/_/g, ' ')} would leave ${left}`);
    tx.doc.history = h.filter((_, i) => i !== idx);
    return `Undid ${entry.name.replace(/_/g, ' ')}.`;
  },
};

const doc = (tx: Tx) => tx.doc;

function openProposal(tx: Tx, id: string): Proposal {
  const p = tx.doc.proposals[id];
  if (!p) throw new CanvasError('not-found', `No proposal "${id}"`, 'args.proposal');
  if (p.status !== 'open') throw new CanvasError('conflict', `“${p.title}” was already ${p.status}`, 'args.proposal');
  return p;
}

function annotation(tx: Tx, id: string): Annotation {
  const an = tx.doc.annotations[id];
  if (!an) throw new CanvasError('not-found', `No annotation "${id}"`, 'args.annotation');
  return an;
}

const changedSince = (e: HistoryEntry) => new CanvasError('conflict', `Someone changed this since; ${e.name.replace(/_/g, ' ')} can’t be undone without losing their change`);
