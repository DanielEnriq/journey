import {
  LENSES, VIEW_SCHEMA, type Entity, type Lens, type ResolvedView, type Sequence, type SystemRegistry, type ViewRequest,
} from '../../../shared/system/model.js';
import { LENS_RELATIONS } from '../../../shared/system/render/grammar.js';

// The views the page offers before any agent is involved: one preset per lens, composed from what the
// registry has (its components, its sequences, its stores, its interfaces, what is dirty). Each preset is a
// plain ViewRequest — exactly what an agent would send — so the harness panel can show and edit it.
//
// Resolving and validating fall back to local versions here; the registry's view.ts is the authority
// when present (see resolve()).

export const LENS_LABEL: Record<Lens, string> = {
  organization: 'Organization', path: 'Path', failure: 'Failure', dataflow: 'Dataflow', 'interface-change': 'Interface change', 'change-review': 'Change review',
};

export const LENS_QUESTION: Record<Lens, string> = {
  organization: 'How is this system organised?',
  path: 'How does a command travel through it?',
  failure: 'What happens when saving loses a race?',
  dataflow: 'Where is information written and read?',
  'interface-change': 'What supports what people see and touch?',
  'change-review': 'What do the current changes touch?',
};

const src = { kind: 'preset' as const, id: 'preset', name: 'Preset' };
const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();

function components(reg: SystemRegistry): Entity[] {
  return Object.values(reg.entities).filter((e) => e.level === 'component').sort((a, b) => (a.id < b.id ? -1 : 1));
}

const hasLoop = (s: Sequence) => s.steps.some((st, i) => (st.next ?? []).some((n) => s.steps.findIndex((x) => x.id === n) <= i));

/** The sequence a path view should show: a command's path, preferring one about drawing. */
export function pathSequence(reg: SystemRegistry): Sequence | undefined {
  const seqs = Object.values(reg.sequences).sort((a, b) => (a.id < b.id ? -1 : 1));
  const code = seqs.filter((s) => s.kind === 'code-path' && !hasLoop(s));
  return code.find((s) => /draw/.test(s.subject ?? s.title)) ?? code.find((s) => s.subject?.startsWith('command:')) ?? code[0] ?? seqs[0];
}

export function failureSequence(reg: SystemRegistry): Sequence | undefined {
  const seqs = Object.values(reg.sequences).sort((a, b) => (a.id < b.id ? -1 : 1));
  return seqs.find((s) => hasLoop(s) && /retry|conflict|race|lost/i.test(s.title + (s.notes ?? []).join(' '))) ?? seqs.find(hasLoop);
}

export function presets(reg: SystemRegistry, changedFiles: string[] = []): ViewRequest[] {
  const comps = components(reg);
  const out: ViewRequest[] = [];
  const base = (lens: Lens, over: Partial<ViewRequest>): ViewRequest => ({
    schema: VIEW_SCHEMA, id: `preset:${lens}`, title: LENS_LABEL[lens], question: LENS_QUESTION[lens], lens, focus: [], depth: 1, source: src, ...over,
  });
  out.push(base('organization', { focus: comps.map((c) => c.id), rationale: 'Every component the registry found, with the relations between them.' }));
  const p = pathSequence(reg);
  if (p) out.push(base('path', { title: `Path · ${p.title}`, question: `How does ${p.subject ?? p.title} travel?`, sequence: p.id, focus: sorted(p.steps.map((s) => s.entity)), depth: 0, rationale: 'The parts the sequence passes through, in its order.' }));
  const f = failureSequence(reg);
  if (f) {
    const loopAt = f.steps.find((st, i) => (st.next ?? []).some((n) => f.steps.findIndex((x) => x.id === n) <= i));
    out.push(base('failure', { title: `Failure · ${f.title}`, sequence: f.id, failureAt: loopAt?.id, focus: sorted(f.steps.map((s) => s.entity)), depth: 0, rationale: 'The retry loop and the branch it takes when a save loses the race.' }));
  }
  const data = Object.values(reg.entities).filter((e) => ['store', 'table', 'state', 'queue', 'event-channel'].includes(e.kind)).map((e) => e.id);
  if (data.length) out.push(base('dataflow', { focus: sorted(data), depth: 1, rationale: 'Data holders and whoever writes or reads them.' }));
  const ui = Object.values(reg.entities).filter((e) => e.kind === 'interface').map((e) => e.id);
  if (ui.length) out.push(base('interface-change', { focus: sorted(ui), depth: 1, rationale: 'The interfaces and what they call and render.' }));
  const changed = sorted(changedFiles.length ? changedFiles : reg.revision.dirty);
  out.push(base('change-review', {
    changed, focus: sorted(Object.values(reg.entities).filter((e) => e.level === 'component' && e.anchors.some((a) => changed.includes(a.file))).map((e) => e.id)),
    depth: 1, rationale: changed.length ? `${changed.length} changed file(s) in the working tree.` : 'No changed files: nothing is affected yet.',
  }));
  return out;
}

/** Validates a request the way an agent's would be checked. Returns the parsed request or the problems, said plainly. */
export function validateRequest(raw: unknown, reg: SystemRegistry | null): { ok: true; request: ViewRequest } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['The request must be a JSON object.'] };
  const r = raw as Record<string, unknown>;
  if (r.schema !== VIEW_SCHEMA) errors.push(`schema must be "${VIEW_SCHEMA}".`);
  for (const k of ['id', 'title', 'question']) if (typeof r[k] !== 'string' || !(r[k] as string).trim()) errors.push(`${k} must be a non-empty string.`);
  if (!LENSES.includes(r.lens as Lens)) errors.push(`lens must be one of ${LENSES.join(', ')}.`);
  const ids = (k: string, required = false) => {
    if (r[k] === undefined && !required) return;
    if (!Array.isArray(r[k]) || (r[k] as unknown[]).some((x) => typeof x !== 'string')) errors.push(`${k} must be a list of ids.`);
  };
  ids('focus', true); ids('include'); ids('exclude'); ids('changed'); ids('relationKinds');
  if (r.depth !== undefined && (typeof r.depth !== 'number' || r.depth < 0 || r.depth > 3 || !Number.isInteger(r.depth))) errors.push('depth must be a whole number from 0 to 3.');
  for (const k of ['sequence', 'failureAt', 'enter', 'rationale']) if (r[k] !== undefined && typeof r[k] !== 'string') errors.push(`${k} must be a string.`);
  if (typeof r.sequence === 'string' && reg && !reg.sequences[r.sequence]) errors.push(`sequence "${r.sequence}" is not in the registry.`);
  if ('x' in r || 'y' in r || 'positions' in r || 'layout' in r) errors.push('A view request names entities, never coordinates: remove x/y/positions/layout.');
  const s = r.source as Record<string, unknown> | undefined;
  if (!s || typeof s !== 'object' || !['manual', 'preset', 'agent', 'harness'].includes(s.kind as string) || typeof s.id !== 'string' || typeof s.name !== 'string')
    errors.push('source must be { kind: manual|preset|agent|harness, id, name }.');
  return errors.length ? { ok: false, errors } : { ok: true, request: raw as ViewRequest };
}

/** The registry's resolution of a request, locally: focus, their parents, neighbours by depth, the sequence, the change. */
export function resolveLocal(reg: SystemRegistry, req: ViewRequest): ResolvedView {
  const why: Record<string, string> = {};
  const missing: string[] = [];
  const warnings: string[] = [];
  const add = (id: string, reason: string) => { if (!(id in why)) why[id] = reason; };
  const exists = (id: string) => !!reg.entities[id] || !!req.proposals?.entities?.some((e) => e.id === id);
  for (const id of req.focus) exists(id) ? add(id, 'focus') : missing.push(id);
  for (const id of req.include ?? []) exists(id) ? add(id, 'include') : missing.push(id);
  for (const e of req.proposals?.entities ?? []) add(e.id, 'proposal');
  const seq = req.sequence ? reg.sequences[req.sequence] : undefined;
  if (req.sequence && !seq) warnings.push(`Sequence ${req.sequence} is not in the registry.`);
  for (const s of seq?.steps ?? []) if (reg.entities[s.entity]) add(s.entity, 'sequence');
  if (req.changed?.length) {
    const set = new Set(req.changed);
    for (const e of Object.values(reg.entities)) if (e.anchors.some((a) => set.has(a.file) || (a.symbol && set.has(a.symbol)))) add(e.id, 'changed');
  }
  const kinds = new Set(req.relationKinds ?? LENS_RELATIONS[req.lens]);
  const rels = Object.values(reg.relations).filter((r) => kinds.has(r.kind));
  // Neighbours: through relations between the entities or their descendants, so a component's neighbours
  // include whoever talks to its internals.
  const top = (id: string): string => { let e = reg.entities[id]; const seen = new Set<string>(); while (e?.parent && reg.entities[e.parent] && e.level !== 'component' && !seen.has(e.id)) { seen.add(e.id); e = reg.entities[e.parent]; } return e?.id ?? id; };
  let frontier = Object.keys(why);
  for (let d = 0; d < (req.depth ?? 1); d++) {
    const tops = new Set(frontier.map(top));
    const next: string[] = [];
    for (const r of rels) {
      const a = top(r.from), b = top(r.to);
      if (tops.has(a) && reg.entities[b] && !(b in why)) { add(b, 'neighbour'); next.push(b); }
      if (tops.has(b) && reg.entities[a] && !(a in why)) { add(a, 'neighbour'); next.push(a); }
    }
    frontier = next;
  }
  for (const id of Object.keys(why)) {
    let p = reg.entities[id]?.parent;
    const seen = new Set<string>();
    while (p && reg.entities[p] && !seen.has(p)) { seen.add(p); add(p, 'parent'); p = reg.entities[p].parent; }
  }
  for (const id of req.exclude ?? []) delete why[id];
  const entities = Object.keys(why).sort();
  const inView = new Set(entities.map(top));
  const relations = rels.filter((r) => inView.has(top(r.from)) && inView.has(top(r.to))).map((r) => r.id).sort();
  return { request: req, entities, relations, why, missing, warnings };
}
