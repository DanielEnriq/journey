import {
  LENSES, VIEW_SCHEMA, RELATION_KINDS, slug,
  type Entity, type EntityLevel, type Lens, type Provenance, type Relation, type RelationKind, type ResolvedView, type Sequence,
  type SystemRegistry, type ViewRequest, type ViewSource,
} from './model.js';
import {
  ancestors, byString, childrenOf, entityId, list, obj, oneOf, only, str, SystemInputError,
} from './registry-utils.js';

// Views: a question, a lens and the entities that matter, resolved against a registry into exactly what a
// canvas draws and why each thing is there. Pure and renderer-safe. `parseViewRequest` is the gate for
// anything untrusted (an agent's tool call, a saved view, a URL), and names the field that is wrong.

/** The relation kinds each lens draws when the request doesn't say. */
export const LENS_RELATIONS: Record<Lens, RelationKind[]> = {
  organization: ['contains', 'calls', 'sends', 'handles', 'renders', 'implements', 'publishes', 'consumes', 'reads', 'writes', 'depends_on'],
  path: ['calls', 'sends', 'handles', 'implements', 'produces', 'writes', 'reads', 'precedes'],
  failure: ['calls', 'implements', 'handles', 'sends', 'writes', 'reads'],
  dataflow: ['reads', 'writes', 'sends', 'handles', 'publishes', 'consumes', 'calls', 'implements'],
  'interface-change': ['produces', 'renders', 'calls', 'handles', 'verified_by'],
  'change-review': ['calls', 'renders', 'sends', 'implements', 'writes', 'reads', 'depends_on', 'verified_by'],
};

/** Beyond this many entities a view stops adding neighbours and says so. */
export const VIEW_ENTITY_CAP = 160;

const SOURCES = ['manual', 'preset', 'agent', 'harness'] as const;
const LEVELS: readonly EntityLevel[] = ['system', 'component', 'element', 'code'];
const PROVENANCES: readonly Provenance[] = ['code', 'inferred', 'interpretation', 'proposed', 'observed'];
const kindName = (v: unknown, path: string) => {
  if (typeof v !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(v)) throw new SystemInputError('must be a kind like "service" or "calls"', path);
  return v;
};
const ids = (v: unknown, path: string, max = 60) => list(v, path, max).map((x, i) => entityId(x, `${path}[${i}]`));

/** Validates an untrusted view request. Throws SystemInputError naming the field that is wrong. */
export function parseViewRequest(raw: unknown): ViewRequest {
  const o = obj(raw, 'view');
  only(o, ['schema', 'id', 'title', 'question', 'lens', 'focus', 'include', 'exclude', 'relationKinds', 'depth', 'sequence', 'failureAt', 'enter', 'changed', 'proposals', 'source', 'rationale'], 'view');
  if (o.schema !== undefined && o.schema !== VIEW_SCHEMA) throw new SystemInputError(`must be "${VIEW_SCHEMA}"`, 'view.schema');
  const lens = oneOf(o.lens, LENSES, 'view.lens');
  const out: ViewRequest = {
    schema: VIEW_SCHEMA,
    id: typeof o.id === 'string' && /^[\w:.\-/]{1,120}$/.test(o.id) ? o.id : o.id === undefined ? `view:${lens}:${slug(String(o.title ?? 'untitled'))}` : (() => { throw new SystemInputError('must be 1–120 letters, digits, or : . - / _', 'view.id'); })(),
    title: str(o.title, 'view.title', 120),
    question: str(o.question ?? o.title, 'view.question', 400),
    lens,
    focus: ids(o.focus ?? [], 'view.focus'),
    source: source(o.source),
  };
  if (o.include !== undefined) out.include = ids(o.include, 'view.include', 200);
  if (o.exclude !== undefined) out.exclude = ids(o.exclude, 'view.exclude', 200);
  if (o.relationKinds !== undefined) out.relationKinds = list(o.relationKinds, 'view.relationKinds', RELATION_KINDS.length * 2).map((k, i) => kindName(k, `view.relationKinds[${i}]`));
  if (o.depth !== undefined) {
    if (typeof o.depth !== 'number' || !Number.isInteger(o.depth) || o.depth < 0 || o.depth > 3) throw new SystemInputError('must be a whole number from 0 to 3', 'view.depth');
    out.depth = o.depth;
  }
  if (o.sequence !== undefined) out.sequence = entityId(o.sequence, 'view.sequence');
  if (o.failureAt !== undefined) out.failureAt = str(o.failureAt, 'view.failureAt', 80);
  if (o.enter !== undefined) out.enter = entityId(o.enter, 'view.enter');
  if (o.changed !== undefined) out.changed = list(o.changed, 'view.changed', 500).map((c, i) => str(c, `view.changed[${i}]`, 400));
  if (o.rationale !== undefined) out.rationale = str(o.rationale, 'view.rationale', 1000);
  if (o.proposals !== undefined) out.proposals = proposals(o.proposals, 'view.proposals');
  if (!out.focus.length && !out.sequence && !out.changed?.length && !out.include?.length && !out.proposals) throw new SystemInputError('name at least one entity to focus on (or a sequence, changed files or proposals)', 'view.focus');
  return out;
}

function source(raw: unknown): ViewSource {
  if (raw === undefined) return { kind: 'manual', id: 'manual', name: 'Manual' };
  const s = obj(raw, 'view.source');
  only(s, ['kind', 'id', 'name'], 'view.source');
  return { kind: oneOf(s.kind, SOURCES, 'view.source.kind'), id: str(s.id, 'view.source.id', 100), name: str(s.name, 'view.source.name', 100) };
}

/** Proposed entities and relations: things not in the code. Always drawn as proposed, whatever they claim. */
export function proposals(raw: unknown, path: string): NonNullable<ViewRequest['proposals']> {
  const p = obj(raw, path);
  only(p, ['entities', 'relations'], path);
  const entities = list(p.entities ?? [], `${path}.entities`, 40).map((x, i) => proposedEntity(x, `${path}.entities[${i}]`));
  const relations = list(p.relations ?? [], `${path}.relations`, 80).map((x, i) => proposedRelation(x, `${path}.relations[${i}]`));
  return { ...(entities.length ? { entities } : {}), ...(relations.length ? { relations } : {}) };
}

export function proposedEntity(raw: unknown, at: string): Entity {
  const e = obj(raw, at);
  only(e, ['id', 'kind', 'name', 'summary', 'parent', 'level', 'attrs', 'provenance', 'evidence', 'status', 'anchors'], at);
  const level = e.level === undefined ? 'component' : oneOf(e.level, LEVELS, `${at}.level`);
  if (e.provenance !== undefined) oneOf(e.provenance, PROVENANCES, `${at}.provenance`);
  const attrs: Entity['attrs'] = {};
  if (e.attrs !== undefined) {
    const a = obj(e.attrs, `${at}.attrs`);
    if (Object.keys(a).length > 20) throw new SystemInputError('must have at most 20 entries', `${at}.attrs`);
    for (const [k, v] of Object.entries(a)) {
      if (typeof v === 'string') attrs[k] = str(v, `${at}.attrs.${k}`, 300, 0);
      else if (typeof v === 'number' || typeof v === 'boolean') attrs[k] = v;
      else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) attrs[k] = (v as string[]).slice(0, 40);
      else throw new SystemInputError('must be a string, number, boolean or list of strings', `${at}.attrs.${k}`);
    }
  }
  return {
    id: entityId(e.id, `${at}.id`), kind: kindName(e.kind, `${at}.kind`), name: str(e.name, `${at}.name`, 80), level,
    ...(e.summary !== undefined ? { summary: str(e.summary, `${at}.summary`, 400) } : {}),
    ...(e.parent !== undefined ? { parent: entityId(e.parent, `${at}.parent`) } : {}),
    anchors: [], attrs, provenance: 'proposed', evidence: [], status: 'new',
  };
}

export function proposedRelation(raw: unknown, at: string): Relation {
  const r = obj(raw, at);
  only(r, ['id', 'kind', 'from', 'to', 'label', 'provenance', 'evidence', 'status'], at);
  const from = entityId(r.from, `${at}.from`), to = entityId(r.to, `${at}.to`), kind = kindName(r.kind, `${at}.kind`);
  if (from === to) throw new SystemInputError('must relate two different entities', `${at}.to`);
  return {
    id: `${from}--${kind}--${to}`, kind, from, to, ...(r.label !== undefined ? { label: str(r.label, `${at}.label`, 80) } : {}),
    provenance: 'proposed', evidence: [], status: 'new',
  };
}

/** Resolves a request: every id checked, parents and neighbours added, each with the reason it is there. */
export function resolveView(reg: SystemRegistry, req: ViewRequest): ResolvedView {
  const E = reg.entities;
  const why: Record<string, string> = {};
  const missing: string[] = [];
  const warnings: string[] = [];
  const add = (id: string, reason: string) => { if (!(id in why)) why[id] = reason; };
  const known = (id: string) => { if (E[id]) return true; if (!missing.includes(id)) missing.push(id); return false; };
  const proposedEntities = new Map((req.proposals?.entities ?? []).map((e) => [e.id, e]));
  const has = (id: string) => !!E[id] || proposedEntities.has(id);

  for (const id of req.focus) if (proposedEntities.has(id) || known(id)) add(id, proposedEntities.has(id) ? 'proposal' : 'focus');
  for (const id of req.include ?? []) if (proposedEntities.has(id) || known(id)) add(id, 'include');

  let seq: Sequence | undefined;
  if (req.sequence) {
    seq = reg.sequences[req.sequence];
    if (!seq) { missing.push(req.sequence); warnings.push(`No sequence "${req.sequence}" in this registry.`); }
    else for (const st of seq.steps) if (known(st.entity)) add(st.entity, 'sequence');
  } else if (req.lens === 'path' || req.lens === 'failure') warnings.push(`A ${req.lens} view without a sequence shows only its focus and neighbours.`);
  if (req.failureAt) {
    if (!seq) warnings.push('failureAt needs a sequence.');
    else if (!seq.steps.some((s) => s.id === req.failureAt)) { missing.push(req.failureAt); warnings.push(`No step "${req.failureAt}" in ${seq.id}.`); }
  }

  if (req.changed?.length) {
    // A file means everything anchored in it; a symbol (`file#Name`) only what is anchored at it or inside it.
    const files = new Set(req.changed.filter((c) => !c.includes('#')));
    const symbols = req.changed.filter((c) => c.includes('#'));
    let hits = 0;
    for (const e of Object.values(E)) {
      const touched = e.anchors.some((a) => files.has(a.file) || (!!a.symbol && symbols.some((s) => a.symbol === s || a.symbol!.startsWith(s + '.'))));
      if (!touched) continue;
      // Code-level entities are drawn through their element; a changed column shows its table.
      const at = e.level === 'code' && e.parent ? e.parent : e.id;
      add(at, 'changed');
      hits++;
    }
    if (!hits) warnings.push('None of the changed files are anchored in this registry (not indexed, or not part of any part found).');
  }

  if (req.enter) {
    if (known(req.enter)) {
      add(req.enter, 'focus');
      for (const c of childrenOf(reg).get(req.enter) ?? []) if (E[c].level !== 'code') add(c, 'enter');
    }
  }

  // Neighbours, hop by hop, along the lens's relation kinds. A neighbour stays at its node's level or rises
  // to component level, so a view of components doesn't fill with code.
  const kinds = new Set(req.relationKinds ?? LENS_RELATIONS[req.lens]);
  const depth = req.depth ?? (req.sequence || req.changed?.length ? 0 : 1);
  const adj = new Map<string, Relation[]>();
  for (const r of Object.values(reg.relations)) {
    if (!kinds.has(r.kind) || r.kind === 'contains') continue;
    (adj.get(r.from) ?? adj.set(r.from, []).get(r.from)!).push(r);
    (adj.get(r.to) ?? adj.set(r.to, []).get(r.to)!).push(r);
  }
  let frontier = Object.keys(why).filter((id) => why[id] === 'focus' || why[id] === 'include');
  let capped = false;
  for (let hop = 0; hop < depth && frontier.length; hop++) {
    const next: string[] = [];
    for (const id of frontier.sort(byString)) {
      const lvl = E[id]?.level;
      for (const r of (adj.get(id) ?? []).slice().sort((a, b) => byString(a.id, b.id))) {
        const other = r.from === id ? r.to : r.from;
        const ol = E[other]?.level;
        if (other in why || !ol || (ol !== lvl && ol !== 'component')) continue;
        if (Object.keys(why).length >= VIEW_ENTITY_CAP) { capped = true; break; }
        add(other, 'neighbour');
        next.push(other);
      }
    }
    frontier = next;
  }
  if (capped) warnings.push(`Stopped adding neighbours at ${VIEW_ENTITY_CAP} entities; narrow the focus or lower the depth.`);

  for (const id of [...(req.exclude ?? [])]) { if (!E[id] && !proposedEntities.has(id)) { if (!missing.includes(id)) missing.push(id); } delete why[id]; }

  // Parents, for context: the composition every entity on the canvas sits in.
  for (const id of Object.keys(why)) for (const p of ancestors(reg, id)) add(p, 'parent');
  for (const e of proposedEntities.values()) if (e.parent && E[e.parent]) { add(e.parent, 'parent'); for (const p of ancestors(reg, e.parent)) add(p, 'parent'); }

  const entities = Object.keys(why).filter(has).sort(byString);
  const inView = new Set(entities);
  const rels = new Set<string>();
  for (const r of Object.values(reg.relations)) {
    if (!inView.has(r.from) || !inView.has(r.to)) continue;
    if (r.kind === 'contains' || kinds.has(r.kind)) rels.add(r.id);
  }
  for (const st of seq?.steps ?? []) if (st.relation && reg.relations[st.relation] && inView.has(reg.relations[st.relation].from) && inView.has(reg.relations[st.relation].to)) rels.add(st.relation);
  for (const r of req.proposals?.relations ?? []) {
    if (!has(r.from) || !has(r.to)) { warnings.push(`Proposed relation ${r.id} names an entity the registry doesn't have.`); continue; }
    rels.add(r.id);
  }
  return { request: req, entities, relations: [...rels].sort(byString), why: Object.fromEntries(entities.map((id) => [id, why[id]])), missing: missing.sort(byString), warnings };
}

/* ======================================================================================================
 * Presets: views found by generic queries over the registry, for whichever lenses its facts support.
 * ==================================================================================================== */

const PRESET_SOURCE: ViewSource = { kind: 'preset', id: 'registry-presets/1', name: 'Registry presets' };

const componentOf = (reg: SystemRegistry, id: string): string | undefined => [id, ...ancestors(reg, id)].find((x) => reg.entities[x]?.level === 'component');
const subsystemOf = (reg: SystemRegistry, id: string): string | undefined => [id, ...ancestors(reg, id)].find((x) => reg.entities[x]?.kind === 'subsystem');

export interface PresetOptions {
  /** For change-review: the files a change touches (default: the revision's dirty files). */
  changed?: string[];
}

/**
 * Up to one view per lens, chosen by queries, not names: the subsystem with the most command-producing
 * interactions (else the largest), the code paths through it, its retry loop, where its data is stored,
 * its busiest interface, and what the working-tree change touches.
 */
export function presetViews(reg: SystemRegistry, opts: PresetOptions = {}): ViewRequest[] {
  const E = reg.entities;
  const R = Object.values(reg.relations);
  const out: ViewRequest[] = [];
  const view = (lens: Lens, key: string, title: string, question: string, rest: Partial<ViewRequest>, rationale: string): ViewRequest => ({
    schema: VIEW_SCHEMA, id: `preset:${lens}:${slug(key)}`, title, question, lens, focus: [], ...rest, source: PRESET_SOURCE, rationale,
  });

  // The subsystem: most interactions that produce commands; else the most components.
  const subsystems = Object.values(E).filter((e) => e.kind === 'subsystem' || e.kind === 'system');
  const producing = new Map<string, number>();
  for (const r of R) if (r.kind === 'produces' && E[r.from]?.kind === 'interaction') { const s = subsystemOf(reg, r.from); if (s) producing.set(s, (producing.get(s) ?? 0) + 1); }
  const comps = (sub: string) => Object.values(E).filter((e) => e.level === 'component' && e.parent === sub).map((e) => e.id).sort(byString);
  const ranked = subsystems.map((s) => ({ s, p: producing.get(s.id) ?? 0, c: comps(s.id).length })).filter((x) => x.c > 0)
    .sort((a, b) => b.p - a.p || b.c - a.c || byString(a.s.id, b.s.id));
  const sub = ranked[0]?.s;
  if (!sub) return out;
  const how = ranked[0].p ? `the subsystem with the most interactions that produce commands (${ranked[0].p})` : `the largest subsystem (${ranked[0].c} components)`;

  // Its sequences: command paths whose subject lives in it (or passes through it), and retry loops.
  const touches = (s: Sequence) => s.steps.filter((st) => subsystemOf(reg, st.entity) === sub.id).length;
  const paths = Object.values(reg.sequences).filter((s) => s.id.startsWith('sequence:command-path:') && touches(s) > 0).sort((a, b) => touches(b) - touches(a) || byString(a.id, b.id));
  const retries = Object.values(reg.sequences).filter((s) => s.steps.some((st) => st.next?.some((n) => s.steps.findIndex((x) => x.id === n) < s.steps.findIndex((x) => x.id === st.id))))
    .sort((a, b) => (paths[0] ? overlap(b, paths[0]) - overlap(a, paths[0]) : 0) || touches(b) - touches(a) || byString(a.id, b.id));
  const path = paths[0], retry = retries[0];

  // Organization: the components on its main path (and the stores they reach), else its best-connected ones.
  const pathComps = path ? [...new Set(path.steps.map((st) => componentOf(reg, st.entity)).filter((x): x is string => !!x))] : [];
  const degree = (id: string) => R.filter((r) => r.kind !== 'contains' && (r.from === id || r.to === id)).length;
  const own = comps(sub.id).filter((id) => E[id].kind !== 'event-channel').sort((a, b) => degree(b) - degree(a) || byString(a, b));
  const orgFocus = pathComps.length ? pathComps : own.slice(0, 10);
  const channels = comps(sub.id).filter((id) => E[id].kind === 'event-channel' && R.some((r) => (r.kind === 'publishes' || r.kind === 'consumes') && r.to === id && orgFocus.includes(r.from)));
  out.push(view('organization', sub.name, `${sub.name}: how it is organised`, `How is ${sub.name.toLowerCase()} organised, and how do its parts relate?`,
    { focus: orgFocus, ...(channels.length ? { include: channels } : {}), depth: 0 },
    `${sub.name} is ${how}. Shown: ${pathComps.length ? `the components its main code path (${path!.id}) runs through` : 'its best-connected components'}${channels.length ? ', and the event channels between them' : ''}.`));

  if (path) {
    out.push(view('path', path.subject ?? path.id, path.title, `What happens, step by step, when ${E[path.steps[0].entity]?.name ?? 'it'} issues '${E[path.subject ?? '']?.name ?? path.id}'?`,
      { focus: path.subject && E[path.subject] ? [path.subject] : [path.steps[0].entity], sequence: path.id, depth: 0 },
      `The command path through ${sub.name} with the most steps inside it: ${path.steps.length} steps, derived from code (a possible path, not a recorded run).`));
  }
  if (retry) {
    const failAt = retry.steps.find((st) => st.next?.some((n) => retry.steps.findIndex((x) => x.id === n) < retry.steps.findIndex((x) => x.id === st.id)));
    const branch = retry.steps.find((st) => (st.next?.length ?? 0) > 1);
    out.push(view('failure', retry.id, retry.title, 'What happens when a save loses the race to someone else\'s?',
      { focus: [...new Set([branch?.entity, failAt?.entity].filter((x): x is string => !!x))], sequence: retry.id, ...(failAt ? { failureAt: failAt.id } : {}), depth: 0 },
      `A loop in the code that retries a save which can return null${path ? `, on the same path as ${path.id}` : ''}.`));
  }

  // Dataflow: where the subject's data is stored and what carries it there.
  const stores = new Set<string>();
  const dataComps = new Set<string>();
  for (const r of R) if (r.kind === 'writes' || r.kind === 'reads') {
    const inPath = path?.steps.some((st) => st.entity === r.to || st.entity === r.from);
    if (!inPath) continue;
    if (E[r.to]?.kind === 'table' || E[r.to]?.kind === 'store-function') stores.add(r.to);
    if (E[r.from]?.kind === 'store-function') stores.add(r.from);
  }
  for (const st of path?.steps ?? []) { const c = componentOf(reg, st.entity); if (c && ['adapter', 'transport', 'store', 'engine', 'service', 'client'].includes(E[c].kind)) dataComps.add(c); }
  if (stores.size || dataComps.size) {
    const storeIds = [...stores].sort(byString);
    out.push(view('dataflow', sub.name, `${sub.name}: where its data travels and is kept`, `Where does ${sub.name.toLowerCase()}'s data travel, and where is it stored?`,
      { focus: storeIds.length ? storeIds : [...dataComps].sort(byString), include: [...dataComps].sort(byString), depth: 0 },
      `The tables and store functions the main path writes, and the components that carry data to them.`));
  }

  // Interface-change: the interface with the most command-producing interactions, its interactions and what supports them.
  const ifaces = Object.values(E).filter((e) => e.kind === 'interface' && e.level === 'component').map((e) => {
    const inter = Object.values(E).filter((x) => x.kind === 'interaction' && x.parent === e.id).map((x) => x.id);
    const prod = R.filter((r) => r.kind === 'produces' && (inter.includes(r.from) || r.from === e.id)).length;
    return { e, inter, prod, inSub: subsystemOf(reg, e.id) === sub.id };
  }).filter((x) => x.inter.length || x.prod).sort((a, b) => Number(b.inSub) - Number(a.inSub) || b.prod - a.prod || b.inter.length - a.inter.length || byString(a.e.id, b.e.id));
  const ui = ifaces[0];
  if (ui) {
    const commands = [...new Set(R.filter((r) => r.kind === 'produces' && (ui.inter.includes(r.from) || r.from === ui.e.id) && E[r.to]?.kind === 'command').map((r) => r.to))].sort(byString);
    const callees = [...new Set(R.filter((r) => r.from === ui.e.id && (r.kind === 'calls' || r.kind === 'produces') && E[r.to]?.level === 'component' && subsystemOf(reg, r.to) === sub.id).map((r) => r.to))].sort(byString);
    out.push(view('interface-change', ui.e.name, `${ui.e.name}: its interactions and what supports them`, `If ${ui.e.name.toLowerCase()} changes, which interactions, commands and parts are involved?`,
      { focus: [ui.e.id, ...ui.inter], include: [...commands, ...callees], enter: ui.e.id, depth: 0 },
      `The interface with the most interactions that produce commands (${ui.prod} produced), entered, with the commands it issues and the parts it calls.`));
  }

  // Change-review: what the working-tree change touches.
  const changed = (opts.changed ?? reg.revision.dirty ?? []).filter((f) => Object.values(E).some((e) => e.anchors.some((a) => a.file === f.split('#')[0])));
  if (changed.length) {
    out.push(view('change-review', changed.length === 1 ? changed[0] : `${changed.length}-files`, `Review: ${changed.length} changed file${changed.length === 1 ? '' : 's'}`, 'What does this change touch, and what verifies it?',
      { changed: changed.slice(0, 200), depth: 0 },
      `${opts.changed ? 'The given' : 'The working tree\'s'} changed files that the registry anchors parts in${changed.length > 200 ? ' (first 200)' : ''}.`));
  }
  return out;
}

const overlap = (a: Sequence, b: Sequence) => { const s = new Set(b.steps.map((x) => x.entity)); return a.steps.filter((x) => s.has(x.entity)).length; };

/** A change-review view for a given list of changed files or symbols. */
export function changeReviewView(reg: SystemRegistry, changed: string[], title = 'Review the change'): ViewRequest {
  return parseViewRequest({ schema: VIEW_SCHEMA, id: `view:change-review:${slug(changed.join(' ')).slice(0, 40)}`, title, question: 'What does this change touch, and what verifies it?', lens: 'change-review', focus: [], changed, depth: 0, source: { kind: 'manual', id: 'manual', name: 'Manual' } });
}
