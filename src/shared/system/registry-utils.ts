import type { Freshness } from './api.js';
import {
  isKnownEntityKind, isKnownRelationKind, relationKey,
  type Diagnostic, type Entity, type EntityLevel, type EntityStatus, type Evidence, type Interpretation, type Relation,
  type RegistryDiff, type SystemRegistry,
} from './model.js';

// What every holder of a registry needs, without the indexer: checking one is whole, comparing two
// snapshots, marking what changed since a person last looked, and layering reviewable interpretations
// on top. Pure, so main, the dev server and the renderer all run it.

/* ---------- Small deterministic helpers. ---------- */

/** FNV-1a over a string, base36: short stable ids for evidence and steps (not for security). */
export function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36).padStart(7, '0');
}

export const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A copy of a record with its keys in sorted order, so equal registries serialise identically. */
export function sortedRecord<T>(r: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of Object.keys(r).sort(byString)) out[k] = r[k];
  return out;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** An entity's ancestors, nearest first. */
export function ancestors(reg: SystemRegistry, id: string): string[] {
  const out: string[] = [];
  let p = reg.entities[id]?.parent;
  while (p && reg.entities[p] && !out.includes(p)) { out.push(p); p = reg.entities[p].parent; }
  return out;
}

/** Children by parent id, each list sorted. */
export function childrenOf(reg: SystemRegistry): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const e of Object.values(reg.entities)) if (e.parent) (m.get(e.parent) ?? m.set(e.parent, []).get(e.parent)!).push(e.id);
  for (const l of m.values()) l.sort(byString);
  return m;
}

/** Every descendant of an entity (not itself). */
export function descendants(reg: SystemRegistry, id: string, kids = childrenOf(reg)): string[] {
  const out: string[] = [];
  const walk = (x: string) => { for (const c of kids.get(x) ?? []) { out.push(c); walk(c); } };
  walk(id);
  return out;
}

/** The nearest component-level ancestor (or itself). */
export function componentOf(reg: SystemRegistry, id: string): string | undefined {
  for (const x of [id, ...ancestors(reg, id)]) if (reg.entities[x]?.level === 'component') return x;
  return undefined;
}

/** Entities whose anchors are in any of these files. */
export function entitiesInFiles(reg: SystemRegistry, files: Iterable<string>): string[] {
  const set = new Set(files);
  return Object.values(reg.entities).filter((e) => e.anchors.some((a) => set.has(a.file))).map((e) => e.id).sort(byString);
}

/* ---------- Checking a registry is whole. ---------- */

/** Dangling ids, relations with nothing to back them, odd kinds. Never throws: a registry with problems is still drawn, with them said. */
export function validateRegistry(reg: SystemRegistry): Diagnostic[] {
  const out: Diagnostic[] = [];
  const E = reg.entities, R = reg.relations, V = reg.evidence;
  for (const e of Object.values(E)) {
    if (e.parent && !E[e.parent]) out.push({ severity: 'error', message: `parent "${e.parent}" does not exist`, entity: e.id });
    for (const ev of e.evidence) if (!V[ev]) out.push({ severity: 'error', message: `evidence "${ev}" does not exist`, entity: e.id });
    if (!e.evidence.length && !e.interpretations?.length && e.provenance !== 'proposed') out.push({ severity: 'warning', message: 'no evidence', entity: e.id });
    if (!isKnownEntityKind(e.kind)) out.push({ severity: 'info', message: `kind "${e.kind}" has no form of its own`, entity: e.id });
  }
  for (const r of Object.values(R)) {
    if (!E[r.from]) out.push({ severity: 'error', message: `from "${r.from}" does not exist`, relation: r.id });
    if (!E[r.to]) out.push({ severity: 'error', message: `to "${r.to}" does not exist`, relation: r.id });
    if (r.id !== relationKey(r.from, r.kind, r.to)) out.push({ severity: 'error', message: 'id does not match from--kind--to', relation: r.id });
    for (const ev of r.evidence) if (!V[ev]) out.push({ severity: 'error', message: `evidence "${ev}" does not exist`, relation: r.id });
    for (const v of r.via ?? []) if (!R[v]) out.push({ severity: 'error', message: `via "${v}" does not exist`, relation: r.id });
    if (!r.evidence.length && !r.interpretations?.length) out.push({ severity: 'error', message: 'no evidence and no interpretation', relation: r.id });
    if (!isKnownRelationKind(r.kind)) out.push({ severity: 'info', message: `kind "${r.kind}" has no form of its own`, relation: r.id });
    if (r.kind === 'contains' && E[r.to]?.parent !== r.from) out.push({ severity: 'warning', message: 'contains does not match parent', relation: r.id });
  }
  for (const s of Object.values(reg.sequences)) {
    const ids = new Set(s.steps.map((x) => x.id));
    for (const st of s.steps) {
      if (!E[st.entity]) out.push({ severity: 'error', message: `sequence ${s.id} step ${st.id}: entity "${st.entity}" does not exist` });
      if (st.relation && !R[st.relation]) out.push({ severity: 'error', message: `sequence ${s.id} step ${st.id}: relation "${st.relation}" does not exist` });
      for (const n of st.next ?? []) if (!ids.has(n)) out.push({ severity: 'error', message: `sequence ${s.id} step ${st.id}: next "${n}" does not exist` });
      for (const ev of st.evidence) if (!V[ev]) out.push({ severity: 'error', message: `sequence ${s.id} step ${st.id}: evidence "${ev}" does not exist` });
      if (!st.evidence.length) out.push({ severity: 'warning', message: `sequence ${s.id} step ${st.id}: no evidence` });
    }
  }
  return out;
}

/* ---------- Comparing snapshots, and marking what a person hasn't seen. ---------- */

const entitySig = (e: Entity) => JSON.stringify([e.kind, e.name, e.parent ?? '', e.summary ?? '', e.anchors.map((a) => [a.file, a.symbol ?? '', a.hash ?? '']), e.attrs, e.provenance]);
const relationSig = (r: Relation) => JSON.stringify([r.label ?? '', r.provenance, r.confidence ?? null, (r.via ?? []).slice().sort(byString)]);

export function diffRegistries(a: SystemRegistry, b: SystemRegistry): RegistryDiff {
  const cmp = <T>(x: Record<string, T>, y: Record<string, T>, sig: (t: T) => string) => ({
    added: Object.keys(y).filter((k) => !(k in x)).sort(byString),
    removed: Object.keys(x).filter((k) => !(k in y)).sort(byString),
    changed: Object.keys(y).filter((k) => k in x && sig(x[k]) !== sig(y[k])).sort(byString),
  });
  return { from: a.revision.fingerprint, to: b.revision.fingerprint, entities: cmp(a.entities, b.entities, entitySig), relations: cmp(a.relations, b.relations, relationSig) };
}

export interface StatusInput {
  /** What changed on disk since the index (from the host): anchored entities go stale, removed files' go missing. */
  freshness?: Pick<Freshness, 'changed'> & { removed?: string[] };
  /** What changed since the snapshot the viewer last saw: added → new, changed → changed. */
  diff?: RegistryDiff;
  /** That snapshot: entities removed since are carried over as `missing`, so a view can still say where they were. */
  previous?: SystemRegistry;
  /** Files indexing couldn't fully read (status partial/error): entities anchored only there are `unknown`. */
  unreadable?: string[];
}

/** Returns a copy with each entity's and relation's status set. Later inputs win: unknown < new/changed < stale < missing. */
export function markStatus(reg: SystemRegistry, input: StatusInput): SystemRegistry {
  const out = clone(reg);
  const set = (e: { status: EntityStatus }, s: EntityStatus) => { e.status = s; };
  for (const e of Object.values(out.entities)) set(e, 'current');
  for (const r of Object.values(out.relations)) set(r, 'current');
  const unreadable = new Set(input.unreadable ?? []);
  for (const e of Object.values(out.entities)) if (e.anchors.length && e.anchors.every((a) => unreadable.has(a.file))) set(e, 'unknown');
  if (input.diff) {
    for (const id of input.diff.entities.added) if (out.entities[id]) set(out.entities[id], 'new');
    for (const id of input.diff.entities.changed) if (out.entities[id]) set(out.entities[id], 'changed');
    for (const id of input.diff.relations.added) if (out.relations[id]) set(out.relations[id], 'new');
    for (const id of input.diff.relations.changed) if (out.relations[id]) set(out.relations[id], 'changed');
    if (input.previous) {
      for (const id of input.diff.entities.removed) {
        const old = input.previous.entities[id];
        if (!old) continue;
        out.entities[id] = { ...clone(old), status: 'missing', ...(old.parent && !out.entities[old.parent] ? { parent: undefined } : {}) };
        for (const ev of old.evidence) if (!out.evidence[ev] && input.previous.evidence[ev]) out.evidence[ev] = clone(input.previous.evidence[ev]);
      }
    }
  }
  if (input.freshness) {
    const changed = new Set(input.freshness.changed), removed = new Set(input.freshness.removed ?? []);
    for (const e of Object.values(out.entities)) {
      if (e.anchors.some((a) => removed.has(a.file)) && e.anchors.every((a) => removed.has(a.file))) set(e, 'missing');
      else if (e.anchors.some((a) => changed.has(a.file) || removed.has(a.file))) set(e, 'stale');
    }
    for (const r of Object.values(out.relations)) {
      const touched = r.evidence.some((id) => { const f = out.evidence[id]?.range?.file; return !!f && (changed.has(f) || removed.has(f)); });
      if (touched) set(r, 'stale');
    }
  }
  out.entities = sortedRecord(out.entities);
  out.evidence = sortedRecord(out.evidence);
  return out;
}

/* ---------- Interpretations: reviewable claims layered on the derived registry. ---------- */

export const INTERPRETATIONS_SCHEMA = 'vowe.interpretations/1';

/** How the host keeps a repository's interpretations on disk: one JSON file, this shape. */
export interface InterpretationsFile { schema: typeof INTERPRETATIONS_SCHEMA; repo: string; interpretations: Interpretation[] }

const OPS = ['rename', 'classify', 'summarise', 'group', 'relate', 'reject'] as const;
const BY = ['human', 'agent', 'rule'] as const;
const STATUSES = ['proposed', 'accepted', 'rejected'] as const;

/** Thrown by the parsers here and in view.ts: says which field is wrong, like the canvas command checks. */
export class SystemInputError extends Error {
  constructor(message: string, readonly path: string) { super(`${path}: ${message}`); }
}

type Obj = Record<string, unknown>;
const bad = (msg: string, path: string) => new SystemInputError(msg, path);
export function isObj(v: unknown): v is Obj { return typeof v === 'object' && v !== null && !Array.isArray(v); }
export function obj(v: unknown, path: string): Obj { if (!isObj(v)) throw bad('must be an object', path); return v; }
export function only(o: Obj, keys: readonly string[], path: string) {
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw bad(`unknown field "${k}"`, path);
}
export function str(v: unknown, path: string, max = 200, min = 1): string {
  if (typeof v !== 'string' || v.length < min || v.length > max) throw bad(`must be a string of ${min}–${max} characters`, path);
  return v;
}
export function oneOf<T extends string>(v: unknown, allowed: readonly T[], path: string): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) throw bad(`must be one of ${allowed.map((a) => `"${a}"`).join(', ')}`, path);
  return v as T;
}
export function list(v: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(v)) throw bad('must be an array', path);
  if (v.length > max) throw bad(`must have at most ${max} items`, path);
  return v;
}
/** Registry ids: `component:canvas-client`, `table:room-canvases`, `command:draw`. Loose on purpose; resolution says whether it exists. */
export const ENTITY_ID = /^[a-z][a-z0-9-]*:[A-Za-z0-9_.:/#@-]{1,200}$/;
export function entityId(v: unknown, path: string): string {
  if (typeof v !== 'string' || !ENTITY_ID.test(v)) throw bad('must be a registry id like "component:canvas-client"', path);
  return v;
}
const kindName = (v: unknown, path: string) => {
  if (typeof v !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(v)) throw bad('must be a kind like "service" or "calls"', path);
  return v;
};

/** Validates one untrusted interpretation. */
export function parseInterpretation(raw: unknown, path = 'interpretation'): Interpretation {
  const o = obj(raw, path);
  only(o, ['id', 'op', 'by', 'at', 'status', 'note', 'orphaned'], path);
  const op = obj(o.op, `${path}.op`);
  const kind = oneOf(op.kind, OPS, `${path}.op.kind`);
  const p = (f: string) => `${path}.op.${f}`;
  let parsed: Interpretation['op'];
  switch (kind) {
    case 'rename': only(op, ['kind', 'entity', 'name'], `${path}.op`); parsed = { kind, entity: entityId(op.entity, p('entity')), name: str(op.name, p('name'), 80) }; break;
    case 'classify': only(op, ['kind', 'entity', 'as'], `${path}.op`); parsed = { kind, entity: entityId(op.entity, p('entity')), as: kindName(op.as, p('as')) }; break;
    case 'summarise': only(op, ['kind', 'entity', 'summary'], `${path}.op`); parsed = { kind, entity: entityId(op.entity, p('entity')), summary: str(op.summary, p('summary'), 400) }; break;
    case 'group':
      only(op, ['kind', 'id', 'name', 'as', 'members'], `${path}.op`);
      parsed = {
        kind, id: entityId(op.id, p('id')), name: str(op.name, p('name'), 80), as: kindName(op.as, p('as')),
        members: list(op.members, p('members'), 200).map((m, i) => str(m, p(`members[${i}]`), 300)),
      };
      if (!parsed.members.length) throw bad('must have at least one member', p('members'));
      break;
    case 'relate':
      only(op, ['kind', 'from', 'to', 'relation', 'label'], `${path}.op`);
      parsed = {
        kind, from: entityId(op.from, p('from')), to: entityId(op.to, p('to')), relation: kindName(op.relation, p('relation')),
        ...(op.label !== undefined ? { label: str(op.label, p('label'), 80) } : {}),
      };
      if (parsed.from === parsed.to) throw bad('must relate two different entities', p('to'));
      break;
    case 'reject': only(op, ['kind', 'target'], `${path}.op`); parsed = { kind, target: str(op.target, p('target'), 300) }; break;
  }
  const by = obj(o.by, `${path}.by`);
  only(by, ['kind', 'id', 'name'], `${path}.by`);
  return {
    id: str(o.id, `${path}.id`, 100),
    op: parsed,
    by: { kind: oneOf(by.kind, BY, `${path}.by.kind`), id: str(by.id, `${path}.by.id`, 100), name: str(by.name, `${path}.by.name`, 100) },
    at: str(o.at, `${path}.at`, 40),
    status: oneOf(o.status ?? 'proposed', STATUSES, `${path}.status`),
    ...(o.note !== undefined ? { note: str(o.note, `${path}.note`, 1000) } : {}),
  };
}

/** Reads an interpretations file (or a bare array); throws SystemInputError naming the bad field. */
export function parseInterpretationsFile(raw: unknown): InterpretationsFile {
  if (Array.isArray(raw)) return { schema: INTERPRETATIONS_SCHEMA, repo: '', interpretations: raw.map((x, i) => parseInterpretation(x, `interpretations[${i}]`)) };
  const o = obj(raw, 'file');
  if (o.schema !== INTERPRETATIONS_SCHEMA) throw bad(`must be "${INTERPRETATIONS_SCHEMA}"`, 'file.schema');
  const items = list(o.interpretations, 'file.interpretations', 5000).map((x, i) => parseInterpretation(x, `interpretations[${i}]`));
  const seen = new Set<string>();
  for (const [i, it] of items.entries()) { if (seen.has(it.id)) throw bad(`duplicate id "${it.id}"`, `interpretations[${i}].id`); seen.add(it.id); }
  return { schema: INTERPRETATIONS_SCHEMA, repo: typeof o.repo === 'string' ? o.repo : '', interpretations: items };
}

export function interpretationsFile(repo: string, interpretations: Interpretation[]): InterpretationsFile {
  const strip = (i: Interpretation) => { const { orphaned: _o, ...rest } = i; return rest; };
  return { schema: INTERPRETATIONS_SCHEMA, repo, interpretations: interpretations.map(strip).sort((a, b) => byString(a.at + a.id, b.at + b.id)) };
}

const LEVEL_ABOVE: Record<EntityLevel, EntityLevel> = { code: 'element', element: 'component', component: 'system', system: 'system' };

/**
 * Applies interpretations on top of a derived registry, in order. Accepted ones change it; proposed ones are
 * recorded on their target (so a viewer can review them) without changing it; rejected ones are only kept.
 * One whose target no longer resolves is marked `orphaned` and changes nothing.
 */
export function applyInterpretations(reg: SystemRegistry, interpretations: Interpretation[]): SystemRegistry {
  const out = clone(reg);
  out.interpretations = { ...out.interpretations };
  const note = (target: { interpretations?: string[] } | undefined, id: string) => {
    if (target && !(target.interpretations ??= []).includes(id)) target.interpretations.push(id);
  };
  const resolveMembers = (members: string[]) => members.flatMap((m) => {
    if (out.entities[m]) return [m];
    // A file path: the component-level entities anchored in it.
    return Object.values(out.entities).filter((e) => e.level === 'component' && e.anchors.some((a) => a.file === m)).map((e) => e.id);
  });
  for (const raw of interpretations) {
    const it: Interpretation = { ...clone(raw) };
    delete it.orphaned;
    const op = it.op;
    const targets = op.kind === 'group' ? resolveMembers(op.members)
      : op.kind === 'relate' ? [op.from, op.to]
      : op.kind === 'reject' ? [op.target] : [op.entity];
    const resolves = op.kind === 'group' ? targets.length > 0
      : op.kind === 'reject' ? !!(out.entities[op.target] || out.relations[op.target])
      : targets.every((t) => out.entities[t]);
    if (!resolves) {
      it.orphaned = true;
      out.interpretations[it.id] = it;
      out.diagnostics = [...out.diagnostics, { severity: 'warning', message: `interpretation ${it.id} no longer resolves (${op.kind})` }];
      continue;
    }
    out.interpretations[it.id] = it;
    for (const t of targets) note(out.entities[t] ?? out.relations[t], it.id);
    if (it.status !== 'accepted') continue;
    const evId = `ev:interpretation:${shortHash(it.id)}`;
    const ev: Evidence = { id: evId, kind: 'interpretation', summary: `${it.by.name} (${it.by.kind}): ${describeOp(op)}${it.note ? ` — ${it.note}` : ''}`, rule: it.id };
    switch (op.kind) {
      case 'rename': out.entities[op.entity].name = op.name; break;
      case 'classify': out.entities[op.entity].kind = op.as; break;
      case 'summarise': out.entities[op.entity].summary = op.summary; break;
      case 'group': {
        out.evidence[evId] = ev;
        const levels = targets.map((t) => out.entities[t].level);
        const level = LEVEL_ABOVE[levels.includes('component') ? 'component' : levels.includes('element') ? 'element' : 'code'];
        const parents = [...new Set(targets.map((t) => out.entities[t].parent ?? ''))];
        const existing = out.entities[op.id];
        out.entities[op.id] = {
          id: op.id, kind: op.as, name: op.name, level, anchors: existing?.anchors ?? [],
          attrs: existing?.attrs ?? {}, provenance: 'interpretation', evidence: [evId], status: 'current', interpretations: [it.id],
          ...(parents.length === 1 && parents[0] && parents[0] !== op.id ? { parent: parents[0] } : existing?.parent ? { parent: existing.parent } : {}),
        };
        for (const t of targets) {
          if (t === op.id) continue;
          const old = out.entities[t].parent;
          if (old) delete out.relations[relationKey(old, 'contains', t)];
          out.entities[t].parent = op.id;
          const rid = relationKey(op.id, 'contains', t);
          out.relations[rid] = { id: rid, kind: 'contains', from: op.id, to: t, provenance: 'interpretation', evidence: [evId], status: 'current', interpretations: [it.id] };
        }
        const p = out.entities[op.id].parent;
        if (p) { const rid = relationKey(p, 'contains', op.id); out.relations[rid] = { id: rid, kind: 'contains', from: p, to: op.id, provenance: 'interpretation', evidence: [evId], status: 'current', interpretations: [it.id] }; }
        break;
      }
      case 'relate': {
        out.evidence[evId] = ev;
        const rid = relationKey(op.from, op.relation, op.to);
        const prev = out.relations[rid];
        out.relations[rid] = prev
          ? { ...prev, interpretations: [...new Set([...(prev.interpretations ?? []), it.id])], evidence: [...new Set([...prev.evidence, evId])] }
          : { id: rid, kind: op.relation, from: op.from, to: op.to, ...(op.label ? { label: op.label } : {}), provenance: 'interpretation', evidence: [evId], status: 'current', interpretations: [it.id] };
        break;
      }
      case 'reject': rejectTarget(out, op.target); break;
    }
  }
  out.entities = sortedRecord(out.entities);
  out.relations = sortedRecord(out.relations);
  out.evidence = sortedRecord(out.evidence);
  out.interpretations = sortedRecord(out.interpretations);
  return out;
}

/** Removes an entity (its children move up to its parent) or a relation, and what pointed at it. */
function rejectTarget(reg: SystemRegistry, target: string) {
  if (reg.relations[target]) {
    delete reg.relations[target];
    for (const r of Object.values(reg.relations)) if (r.via) r.via = r.via.filter((v) => v !== target);
    for (const s of Object.values(reg.sequences)) for (const st of s.steps) if (st.relation === target) delete st.relation;
    return;
  }
  const e = reg.entities[target];
  if (!e) return;
  for (const c of Object.values(reg.entities)) if (c.parent === target) {
    if (e.parent) c.parent = e.parent; else delete c.parent;
  }
  delete reg.entities[target];
  const gone = new Set<string>();
  for (const r of Object.values(reg.relations)) if (r.from === target || r.to === target) { gone.add(r.id); delete reg.relations[r.id]; }
  for (const r of Object.values(reg.relations)) if (r.via) r.via = r.via.filter((v) => !gone.has(v));
  for (const s of Object.values(reg.sequences)) for (const st of s.steps) {
    if (st.relation && gone.has(st.relation)) delete st.relation;
    if (st.entity === target && e.parent) st.entity = e.parent;
  }
  for (const s of Object.values(reg.sequences)) if (s.steps.some((st) => !reg.entities[st.entity])) delete reg.sequences[s.id];
}

export function describeOp(op: Interpretation['op']): string {
  switch (op.kind) {
    case 'rename': return `${op.entity} is named "${op.name}"`;
    case 'classify': return `${op.entity} is a ${op.as}`;
    case 'summarise': return `${op.entity}: ${op.summary}`;
    case 'group': return `${op.members.length} members form "${op.name}" (${op.as})`;
    case 'relate': return `${op.from} ${op.relation} ${op.to}${op.label ? ` (${op.label})` : ''}`;
    case 'reject': return `${op.target} is not right`;
  }
}
