import type {
  Entity, EntityStatus, Provenance, Relation, RegistryDiff, ResolvedView, Sequence, SequenceStep, SystemRegistry, Trace, ViewState,
} from '../model.js';
import { drawForm, formFor } from './forms.js';
import { LENS_RELATIONS } from '../view.js';
import { grammarFor, LENS_FLOW, PROVENANCE_ORDER } from './grammar.js';
import { GAP_CROSS, GAP_MAIN, labelPoint, layeredLayout, pad, route, union, type LayoutEdge, type Side } from './layout.js';
import {
  SCENE_SCHEMA, type Emphasis, type FormId, type OutlineItem, type Part, type Point, type Rect, type SceneEdge, type SceneGroup,
  type SceneNode, type SceneOverflow, type ScenePortal, type SceneSegment, type SceneSequence, type SceneStep, type SceneStub,
  type SceneZone, type SystemScene,
} from './scene.js';

export * from './scene.js';
export { FORM_TABLE, formFor, drawForm, outlineFor } from './forms.js';
export { GRAMMAR, grammarFor, LENS_FLOW, PROVENANCE_SAYS, STATUS_SAYS, PROVENANCE_ORDER } from './grammar.js';

// buildScene: one level of a resolved view, drawn. The level is the person's entered path (ViewState
// .entered): the top shows the view's components; entering a component composes its internals in its own
// frame, with its neighbours held at the frame's edges in the direction they really lie.

export interface LayoutInputs {
  /** Positions already given to ids, per level key: they are kept so new information never reshuffles. */
  layoutMemory?: Record<string, Record<string, [number, number]>>;
  /** Entities anchored in files changed on disk since indexing (Freshness.staleEntities). */
  stale?: string[];
  /** What changed since the registry the person last saw: drawn new / changed. */
  diff?: RegistryDiff | null;
  /** A recorded run. When given, the path is drawn as observed, from it. */
  trace?: Trace | null;
  /** Components drawn on one level before "+N more" (default 36). */
  maxNodes?: number;
}

const GROUP_KINDS = new Set(['system', 'subsystem']);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Runtime zones from file location: where code runs is part of what it is. Labelled as inferred from paths. */
const PATH_ZONES: [RegExp, string, string][] = [
  [/^src\/renderer\//, 'renderer', 'Renderer process'],
  [/^src\/preload\//, 'preload', 'Preload bridge'],
  [/^src\/main\//, 'main', 'Main process'],
  [/^(src\/integrations\/supabase\/|supabase\/)/, 'cloud', 'Cloud · Supabase'],
  [/^server\//, 'server', 'API server'],
  [/^src\/system\//, 'node', 'Node service'],
  [/^src\/shared\//, 'shared', 'Shared code — built into more than one process'],
];
const ZONE_LAST = ['shared', 'none'];

export const levelKey = (entered: string[]) => entered.join('/');

interface Ctx {
  registry: SystemRegistry;
  resolved: ResolvedView;
  state: ViewState;
  inputs: LayoutInputs;
  ent: (id: string) => Entity | undefined;
  children: (id: string) => Entity[];
  relations: Relation[];
  pool: Set<string>;
  allowed: (r: Relation) => boolean;
  flow: 'right' | 'down';
  sequence: Sequence | null;
  recorded?: Trace['recorded'];
  layouts: Map<string, LevelLayout>;
}

interface LevelLayout {
  key: string;
  root: string | null;
  members: string[];
  groupOf: Map<string, string>;
  drawn: Map<string, ReturnType<typeof drawForm>>;
  pos: Record<string, Point>;
  placed: Record<string, 'pinned' | 'memory' | 'layout'>;
  zone: Map<string, { id: string; label: string; basis: SceneZone['basis'] }>;
  zoneOrder: string[];
  rank: Record<string, number>;
  back: Set<string>;
  hidden: Map<string, string[]>;
}

export function buildScene(registry: SystemRegistry, resolved: ResolvedView, state: ViewState, inputs: LayoutInputs = {}): SystemScene {
  const req = resolved.request;
  const lens = req.lens;
  const proposed = new Map<string, Entity>();
  for (const e of req.proposals?.entities ?? []) proposed.set(e.id, { ...e, provenance: 'proposed' });
  const proposedRels = (req.proposals?.relations ?? []).map((r) => ({ ...r, provenance: 'proposed' as Provenance }));
  const ent = (id: string) => registry.entities[id] ?? proposed.get(id);

  const kids = new Map<string, Entity[]>();
  for (const id of [...Object.keys(registry.entities), ...proposed.keys()].sort(cmp)) {
    const e = ent(id)!;
    if (!e.parent) continue;
    if (!kids.has(e.parent)) kids.set(e.parent, []);
    kids.get(e.parent)!.push(e);
  }
  const relations = [...Object.values(registry.relations), ...proposedRels].sort((a, b) => cmp(a.id, b.id));
  const kinds = new Set<string>(req.relationKinds ?? LENS_RELATIONS[lens]);
  const explicit = new Set(resolved.relations);
  const pool = new Set(resolved.entities.filter((id) => ent(id)));
  for (const id of proposed.keys()) pool.add(id);

  let sequence: Sequence | null = null;
  let recorded: Trace['recorded'] | undefined;
  if (inputs.trace) { sequence = traceToSequence(inputs.trace, registry); recorded = inputs.trace.recorded; }
  else if (req.sequence && registry.sequences[req.sequence]) sequence = registry.sequences[req.sequence];

  const ctx: Ctx = {
    registry, resolved, state, inputs, ent, relations, pool, sequence, recorded,
    children: (id) => kids.get(id) ?? [],
    allowed: (r) => r.kind !== 'contains' && (kinds.has(r.kind) || explicit.has(r.id)),
    flow: LENS_FLOW[lens], layouts: new Map(),
  };

  // Entered ids that no longer resolve are dropped from the path rather than failing the view.
  const entered = state.entered.filter((id) => ent(id));
  const L = layoutLevel(ctx, entered);
  return compose(ctx, L, entered);
}

/* ---------- which entities make up a level ---------- */

function membersOf(ctx: Ctx, entered: string[]): { root: string | null; members: string[]; groupOf: Map<string, string> } {
  const root = entered[entered.length - 1] ?? null;
  const cands = new Set(ctx.pool);
  if (root) {
    // Entering reveals the component's internals whether or not the view listed them.
    for (const k of ctx.children(root)) cands.add(k.id);
  }
  const groupOf = new Map<string, string>();
  const members: string[] = [];
  for (const id of [...cands].sort(cmp)) {
    if (id === root || entered.includes(id)) continue;
    // Its nearest ancestor among the candidates (skipping flattened groups) must be the root.
    let p = ctx.ent(id)?.parent;
    let group: string | undefined;
    let ok = false;
    const seen = new Set<string>();
    while (true) {
      if (p === undefined || seen.has(p)) { ok = root === null; break; }
      seen.add(p);
      if (p === root) { ok = true; break; }
      if (cands.has(p)) {
        const pe = ctx.ent(p);
        if (pe && GROUP_KINDS.has(pe.kind) && !root) { group ??= p; p = pe.parent; continue; }
        break;
      }
      p = ctx.ent(p)?.parent;
    }
    if (!ok) continue;
    const e = ctx.ent(id)!;
    // A system or subsystem with members on this level is a grouping, not a node.
    if (GROUP_KINDS.has(e.kind) && !root && [...cands].some((c) => isUnder(ctx, c, id))) continue;
    members.push(id);
    if (group) groupOf.set(id, group);
  }
  return { root, members, groupOf };
}

function isUnder(ctx: Ctx, id: string, anc: string): boolean {
  let p = ctx.ent(id)?.parent;
  const seen = new Set<string>();
  while (p && !seen.has(p)) { if (p === anc) return true; seen.add(p); p = ctx.ent(p)?.parent; }
  return false;
}

function zoneOf(e: Entity): { id: string; label: string; basis: SceneZone['basis'] } {
  for (const k of ['zone', 'runtime', 'process']) {
    const v = e.attrs[k];
    if (typeof v === 'string' && v) return { id: v, label: String(e.attrs.zoneLabel ?? v), basis: 'attribute' };
  }
  const file = e.anchors[0]?.file;
  if (file) for (const [re, id, label] of PATH_ZONES) if (re.test(file)) return { id, label, basis: 'file-path' };
  return { id: 'none', label: '', basis: 'none' };
}

/* ---------- layout of one level (memoised: entering needs the level above for directions) ---------- */

function layoutLevel(ctx: Ctx, entered: string[]): LevelLayout {
  const key = levelKey(entered);
  const hit = ctx.layouts.get(key);
  if (hit) return hit;
  const { root, members: all, groupOf } = membersOf(ctx, entered);
  const seqIds = new Set((ctx.sequence?.steps ?? []).map((s) => s.entity));
  const focus = new Set(ctx.resolved.request.focus);
  const degree = new Map<string, number>();
  for (const r of ctx.relations) { degree.set(r.from, (degree.get(r.from) ?? 0) + 1); degree.set(r.to, (degree.get(r.to) ?? 0) + 1); }
  const touchesSeq = (id: string) => seqIds.has(id) || [...seqIds].some((s) => isUnder(ctx, s, id));
  const priority = (id: string) => (focus.has(id) ? 1000 : 0) + (touchesSeq(id) ? 500 : 0) + (degree.get(id) ?? 0);

  // Dense systems: keep the most relevant, say how many more there are, per zone.
  const cap = ctx.inputs.maxNodes ?? 36;
  const zone = new Map(all.map((id) => [id, zoneOf(ctx.ent(id)!)]));
  let members = all;
  const hidden = new Map<string, string[]>();
  if (all.length > cap) {
    const ranked = [...all].sort((a, b) => priority(b) - priority(a) || cmp(a, b));
    const keep = new Set(ranked.slice(0, cap));
    members = all.filter((id) => keep.has(id));
    for (const id of all) if (!keep.has(id)) {
      const z = zone.get(id)!.id;
      if (!hidden.has(z)) hidden.set(z, []);
      hidden.get(z)!.push(id);
    }
  }

  const drawn = new Map(members.map((id) => {
    const e = ctx.ent(id)!;
    const children = ctx.children(id);
    const ids = new Set([id, ...children.map((c) => c.id)]);
    const rels = ctx.relations.filter((r) => ids.has(r.from) || ids.has(r.to));
    return [id, drawForm({ entity: e, children, registry: ctx.registry, relations: rels }, ctx.resolved.request.lens)] as const;
  }));

  // Ranking edges: relations that carry the flow, plus the order of the path being shown.
  const vis = visibility(ctx, new Set(members), root, null);
  const edges: LayoutEdge[] = [];
  for (const r of ctx.relations) {
    if (!ctx.allowed(r)) continue;
    const g = grammarFor(r.kind);
    if (g.flow === 'none') continue;
    const a = vis(r.from), b = vis(r.to);
    if (a.kind !== 'member' || b.kind !== 'member' || a.id === b.id) continue;
    edges.push(g.flow === 'forward' ? { from: a.id, to: b.id, weight: 1 } : { from: b.id, to: a.id, weight: 1 });
  }
  if (ctx.sequence) {
    const steps = ctx.sequence.steps;
    let prev: string | null = null;
    for (const s of steps) {
      const v = vis(s.entity);
      if (v.kind !== 'member') continue;
      if (prev && prev !== v.id) edges.push({ from: prev, to: v.id, weight: 2 });
      prev = v.id;
    }
  }

  // Entering keeps the arrangement the parts had inside the component: their compartments become the grid.
  let memory = ctx.inputs.layoutMemory?.[key];
  if (root && !memory) memory = arrangementFromParts(ctx, entered, members);
  const pinned = ctx.state.pinned?.[key];
  const lay = layeredLayout(
    members.map((id) => ({ id, w: drawn.get(id)!.w, h: drawn.get(id)!.h, zone: zone.get(id)!.id, group: groupOf.get(id), priority: priority(id) })),
    edges,
    {
      flow: ctx.flow, memory, pinned,
      zoneOrder: (zs, mean) => [...zs].sort((a, b) => Number(ZONE_LAST.includes(a)) - Number(ZONE_LAST.includes(b)) || ZONE_LAST.indexOf(a) - ZONE_LAST.indexOf(b) || mean[a] - mean[b] || cmp(a, b)),
    },
  );
  const out: LevelLayout = { key, root, members, groupOf, drawn, pos: lay.pos, placed: lay.placed, zone, zoneOrder: lay.zoneOrder, rank: lay.rank, back: lay.back, hidden };
  ctx.layouts.set(key, out);
  return out;
}

/** Positions for an entered level from where each child sat as a part of the component at the level above. */
function arrangementFromParts(ctx: Ctx, entered: string[], members: string[]): Record<string, [number, number]> | undefined {
  const root = entered[entered.length - 1];
  const e = ctx.ent(root)!;
  const children = ctx.children(root);
  const ids = new Set([root, ...children.map((c) => c.id)]);
  const form = drawForm({ entity: e, children, registry: ctx.registry, relations: ctx.relations.filter((r) => ids.has(r.from) || ids.has(r.to)) });
  const parts = form.parts.filter((p) => p.entity && members.includes(p.entity));
  if (!parts.length) return undefined;
  const xs = [...new Set(parts.map((p) => p.rect.x))].sort((a, b) => a - b);
  const ys = [...new Set(parts.map((p) => p.rect.y))].sort((a, b) => a - b);
  const sizes = new Map(members.map((id) => {
    const c = ctx.ent(id)!;
    const d = drawForm({ entity: c, children: ctx.children(id), registry: ctx.registry, relations: [] });
    return [id, d] as const;
  }));
  const colW = xs.map((x) => Math.max(...parts.filter((p) => p.rect.x === x).map((p) => sizes.get(p.entity!)!.w)));
  const rowH = ys.map((y) => Math.max(...parts.filter((p) => p.rect.y === y).map((p) => sizes.get(p.entity!)!.h)));
  const colX: number[] = [], rowY: number[] = [];
  xs.forEach((_, i) => colX.push(i === 0 ? 0 : colX[i - 1] + colW[i - 1] + GAP_MAIN * 0.6));
  ys.forEach((_, i) => rowY.push(i === 0 ? 0 : rowY[i - 1] + rowH[i - 1] + GAP_CROSS * 0.6));
  const out: Record<string, [number, number]> = {};
  for (const p of parts) out[p.entity!] = [colX[xs.indexOf(p.rect.x)], rowY[ys.indexOf(p.rect.y)]];
  return out;
}

type Vis = { kind: 'member'; id: string } | { kind: 'root' } | { kind: 'portal'; id: string } | { kind: 'outside'; id: string } | { kind: 'not-indexed'; id: string };

/** Where an entity shows on this level: as a member (itself or an ancestor), inside the root, through a portal, or not at all. */
function visibility(ctx: Ctx, members: Set<string>, root: string | null, parentMembers: Set<string> | null) {
  const memo = new Map<string, Vis>();
  return (id: string): Vis => {
    const hit = memo.get(id);
    if (hit) return hit;
    let v: Vis;
    if (!ctx.ent(id)) v = { kind: 'not-indexed', id };
    else {
      let cur: string | undefined = id;
      let found: Vis | null = null;
      let underRoot = false;
      const chain: string[] = [];
      const seen = new Set<string>();
      while (cur && !seen.has(cur)) {
        seen.add(cur); chain.push(cur);
        if (members.has(cur)) { found = { kind: 'member', id: cur }; break; }
        if (cur === root) { underRoot = true; break; }
        cur = ctx.ent(cur)?.parent;
      }
      if (found) v = found;
      else if (underRoot) v = { kind: 'root' };
      else if (root && parentMembers) {
        const p = chain.find((c) => parentMembers.has(c));
        v = p ? { kind: 'portal', id: p } : { kind: 'outside', id };
      } else v = { kind: 'outside', id };
    }
    memo.set(id, v);
    return v;
  };
}

/* ---------- composing the scene ---------- */

function compose(ctx: Ctx, L: LevelLayout, entered: string[]): SystemScene {
  const req = ctx.resolved.request;
  const lens = req.lens;
  const down = ctx.flow === 'down';
  const root = L.root;
  const parentL = root ? layoutLevel(ctx, entered.slice(0, -1)) : null;
  const vis = visibility(ctx, new Set(L.members), root, parentL ? new Set(parentL.members) : null);
  const stale = new Set(ctx.inputs.stale ?? []);
  const added = new Set(ctx.inputs.diff?.entities.added ?? []);
  const changedIds = new Set(ctx.inputs.diff?.entities.changed ?? []);
  const changedFiles = new Set(req.changed ?? []);
  const seqIds = new Set((ctx.sequence?.steps ?? []).map((s) => s.entity));
  const focus = new Set(req.focus);

  const statusOf = (e: Entity): EntityStatus =>
    e.status === 'missing' ? 'missing' : stale.has(e.id) ? 'stale' : added.has(e.id) ? 'new' : changedIds.has(e.id) ? 'changed' : e.status;

  const affected = (id: string): boolean => {
    if (!changedFiles.size) return false;
    const hit = (e: Entity) => e.anchors.some((a) => changedFiles.has(a.file) || (a.symbol !== undefined && changedFiles.has(a.symbol))) || changedFiles.has(e.id);
    const e = ctx.ent(id)!;
    if (hit(e)) return true;
    const stack = [...ctx.children(id)];
    while (stack.length) { const c = stack.pop()!; if (hit(c)) return true; stack.push(...ctx.children(c.id)); }
    return false;
  };

  const DATA_FORMS = new Set<FormId>(['store', 'table', 'state', 'queue', 'channel', 'schema', 'column']);
  const emphasisOf = (id: string, form: FormId): Emphasis => {
    if (focus.has(id)) return 'primary';
    switch (lens) {
      case 'path': case 'failure':
        if (!ctx.sequence) return 'context';
        return seqIds.has(id) || [...seqIds].some((s) => isUnder(ctx, s, id)) ? 'primary' : 'dim';
      case 'dataflow': return DATA_FORMS.has(form) ? 'primary' : 'context';
      case 'interface-change': return form === 'interface' || form === 'interaction' ? 'primary' : 'context';
      case 'change-review': return affected(id) ? 'primary' : 'dim';
      default: return 'context';
    }
  };

  /* nodes */
  const nodes: SceneNode[] = L.members.map((id) => {
    const e = ctx.ent(id)!;
    const d = L.drawn.get(id)!;
    const p = L.pos[id];
    const parts: Part[] = d.parts.map((pt) => {
      if (!pt.entity) return pt;
      const pe = ctx.ent(pt.entity);
      return pe ? { ...pt, status: statusOf(pe) } : pt;
    });
    return {
      id, kind: e.kind, kindLabel: String(e.kind), form: d.form, name: e.name, summary: e.summary,
      rect: { x: p.x, y: p.y, w: d.w, h: d.h }, outline: d.outline, head: d.head, parts,
      childCount: ctx.children(id).length, enterable: ctx.children(id).length > 0,
      provenance: e.provenance, confidence: e.confidence, status: statusOf(e),
      why: ctx.resolved.why[id] ?? (root ? 'inside' : 'context'), emphasis: emphasisOf(id, d.form),
      affected: changedFiles.size ? affected(id) : undefined, placed: L.placed[id],
      zone: L.zone.get(id)!.id, group: L.groupOf.get(id), files: [...new Set(e.anchors.map((a) => a.file))].sort(cmp),
    };
  });

  // Ids the view asked for that the registry doesn't have: drawn as ghosts at the top, never silently dropped.
  if (!root) {
    let gy = Math.max(0, ...nodes.map((n) => n.rect.y + n.rect.h)) + 80;
    for (const id of [...ctx.resolved.missing].sort(cmp)) {
      const w = 240, h = 72;
      nodes.push({
        id, kind: 'unknown', kindLabel: 'missing', form: 'unknown', name: id, summary: 'Asked for by the view, but not found in the registry.',
        rect: { x: 0, y: gy, w, h }, outline: `M0 0 H${w} V${h} H0 Z`, head: 44, parts: [], childCount: 0, enterable: false,
        provenance: 'interpretation', status: 'missing', why: 'missing', emphasis: 'context', placed: 'layout', zone: 'none', files: [], ghost: true,
      });
      gy += h + 24;
    }
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));

  /* zones */
  const zones: SceneZone[] = [];
  const all = union(nodes.map((n) => n.rect));
  for (const z of L.zoneOrder) {
    const ms = nodes.filter((n) => n.zone === z && !n.ghost);
    if (!ms.length) continue;
    const info = L.zone.get(ms[0].id)!;
    if (info.basis === 'none' && L.zoneOrder.length === 1) continue;
    const u = union(ms.map((n) => n.rect));
    const rect = down
      ? { x: u.x - 28, y: all.y - 56, w: u.w + 56, h: all.h + 96 }
      : { x: all.x - 64, y: u.y - 40, w: all.w + 128, h: u.h + 64 };
    zones.push({ id: z, label: info.label || 'Unplaced', basis: info.basis, rect });
  }

  /* groups (subsystems the level flattened) */
  const groups: SceneGroup[] = [];
  const gm = new Map<string, string[]>();
  for (const n of nodes) if (n.group) { if (!gm.has(n.group)) gm.set(n.group, []); gm.get(n.group)!.push(n.id); }
  for (const [g, ms] of [...gm].sort((a, b) => cmp(a[0], b[0]))) {
    const ge = ctx.ent(g)!;
    groups.push({ id: g, name: ge.name, kind: ge.kind, members: ms, rect: pad(union(ms.map((m) => byId.get(m)!.rect)), 18) });
  }

  /* edges: relations rolled up to what this level shows */
  interface Agg { from: string; to: string; kind: string; rels: Relation[]; portal?: 'from' | 'to' }
  const agg = new Map<string, Agg>();
  const stubAgg = new Map<string, { node: string; dir: 'in' | 'out'; reason: SceneStub['reason']; kinds: Set<string>; others: Set<string>; count: number }>();
  const portalCount = new Map<string, number>();
  for (const r of ctx.relations) {
    if (!ctx.allowed(r)) continue;
    const a = vis(r.from), b = vis(r.to);
    if (a.kind === 'root' || b.kind === 'root') continue; // summaries of the entered component itself
    const end = (v: Vis) => (v.kind === 'member' || v.kind === 'portal' ? v.id : null);
    const fa = end(a), fb = end(b);
    if (a.kind === 'member' && b.kind === 'member') {
      if (fa === fb) continue;
    } else if (a.kind === 'member' && b.kind === 'portal') portalCount.set(fb!, (portalCount.get(fb!) ?? 0) + 1);
    else if (a.kind === 'portal' && b.kind === 'member') portalCount.set(fa!, (portalCount.get(fa!) ?? 0) + 1);
    else {
      // One end drawn, the other not: a stub says so instead of a line to nowhere.
      const inside = a.kind === 'member' ? a : b.kind === 'member' ? b : null;
      if (!inside) continue;
      const other = inside === a ? b : a;
      const reason: SceneStub['reason'] = other.kind === 'not-indexed' ? 'not-indexed' : 'outside-view';
      const dir = inside === a ? 'out' : 'in';
      const k = `${inside.id}|${dir}|${reason}`;
      const s = stubAgg.get(k) ?? { node: inside.id, dir, reason, kinds: new Set(), others: new Set(), count: 0 };
      s.kinds.add(r.kind); s.others.add(inside === a ? r.to : r.from); s.count++;
      stubAgg.set(k, s);
      continue;
    }
    const k = `${fa}|${r.kind}|${fb}`;
    const g = agg.get(k) ?? { from: fa!, to: fb!, kind: r.kind, rels: [], portal: a.kind === 'portal' ? 'from' : b.kind === 'portal' ? 'to' : undefined };
    g.rels.push(r);
    agg.set(k, g);
  }

  /* portals: neighbours outside the entered component, at the frame's edge in their real direction */
  let frame: Rect | null = null;
  const portals: ScenePortal[] = [];
  if (root && parentL) {
    const inner = union(nodes.map((n) => n.rect));
    frame = { x: inner.x - 72, y: inner.y - 96, w: inner.w + 144, h: inner.h + 168 };
    const rp = parentL.pos[root];
    const rd = parentL.drawn.get(root);
    const rc = rp && rd ? { x: rp.x + rd.w / 2, y: rp.y + rd.h / 2 } : { x: 0, y: 0 };
    const bySide: Record<Side, { id: string; t: number }[]> = { left: [], right: [], top: [], bottom: [] };
    for (const id of [...portalCount.keys()].sort(cmp)) {
      const p = parentL.pos[id], d = parentL.drawn.get(id);
      const c = p && d ? { x: p.x + d.w / 2, y: p.y + d.h / 2 } : { x: rc.x + 1, y: rc.y };
      const dx = c.x - rc.x, dy = c.y - rc.y;
      const side: Side = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'right' : 'left') : (dy >= 0 ? 'bottom' : 'top');
      // Where along that edge: the direction's slope, projected onto the frame.
      const t = side === 'left' || side === 'right' ? (Math.abs(dx) < 1 ? 0 : dy / Math.abs(dx)) : (Math.abs(dy) < 1 ? 0 : dx / Math.abs(dy));
      bySide[side].push({ id, t: Math.max(-1, Math.min(1, t)) });
    }
    const PW = 184, PH = 56;
    for (const side of ['left', 'right', 'top', 'bottom'] as Side[]) {
      const list = bySide[side].sort((a, b) => a.t - b.t || cmp(a.id, b.id));
      const vertical = side === 'left' || side === 'right';
      const span = vertical ? frame.h : frame.w;
      const size = vertical ? PH : PW;
      const gap = 18;
      let prevEnd = -Infinity;
      const placedAt: number[] = [];
      for (const it of list) {
        let c = (vertical ? frame.y : frame.x) + span / 2 + it.t * (span / 2 - size);
        c = Math.max(c, prevEnd + gap + size / 2);
        placedAt.push(c);
        prevEnd = c + size / 2;
      }
      // If the run overflows the edge, slide it back inside.
      const over = list.length ? prevEnd - ((vertical ? frame.y + frame.h : frame.x + frame.w) - 8) : 0;
      list.forEach((it, i) => {
        const c = placedAt[i] - Math.max(0, over);
        const pe = ctx.ent(it.id)!;
        const rect = side === 'left' ? { x: frame!.x - PW - 28, y: c - PH / 2, w: PW, h: PH }
          : side === 'right' ? { x: frame!.x + frame!.w + 28, y: c - PH / 2, w: PW, h: PH }
          : side === 'top' ? { x: c - PW / 2, y: frame!.y - PH - 28, w: PW, h: PH }
          : { x: c - PW / 2, y: frame!.y + frame!.h + 28, w: PW, h: PH };
        portals.push({ id: it.id, name: pe.name, kind: pe.kind, kindLabel: String(pe.kind), form: formFor(pe.kind), side, rect, count: portalCount.get(it.id)! });
      });
    }
  }
  const portalById = new Map(portals.map((p) => [p.id, p]));
  const rectOf = (id: string): Rect | null => byId.get(id)?.rect ?? portalById.get(id)?.rect ?? null;

  /* ports and routes */
  const zoneRect = new Map(zones.map((z) => [z.id, z.rect]));
  const zoneOfId = (id: string) => byId.get(id)?.zone ?? 'portal';
  const aggs = [...agg.values()].sort((a, b) => cmp(a.from, b.from) || cmp(a.kind, b.kind) || cmp(a.to, b.to));
  type Pending = { a: Agg; sa: Side; sb: Side; pa?: Point; pb?: Point; partA?: string; partB?: string; back: boolean };
  const pend: Pending[] = [];
  const sideCount = new Map<string, Pending[]>();
  for (const a of aggs) {
    const ra = rectOf(a.from)!, rb = rectOf(a.to)!;
    let sa: Side, sb: Side;
    const before = down ? rb.y + rb.h <= ra.y : rb.x + rb.w <= ra.x;
    const after = down ? rb.y >= ra.y + ra.h : rb.x >= ra.x + ra.w;
    if (after) [sa, sb] = down ? ['bottom', 'top'] : ['right', 'left'];
    else if (before) [sa, sb] = down ? ['right', 'right'] : ['bottom', 'bottom'];
    else {
      const below = down ? rb.x >= ra.x : rb.y >= ra.y;
      [sa, sb] = down ? (below ? ['right', 'left'] : ['left', 'right']) : (below ? ['bottom', 'top'] : ['top', 'bottom']);
    }
    const p: Pending = { a, sa, sb, back: before };
    // Form-appropriate connection points: a relation that reaches a part (a table, an endpoint) lands on it.
    const partFor = (nodeId: string, side: Side, ids: string[]) => {
      const n = byId.get(nodeId);
      if (!n) return;
      for (const id of ids) {
        const part = n.parts.find((pt) => pt.entity && (pt.entity === id || isUnder(ctx, id, pt.entity)));
        if (part) {
          const r = part.rect;
          const at = side === 'left' ? { x: n.rect.x, y: n.rect.y + r.y + r.h / 2 } : side === 'right' ? { x: n.rect.x + n.rect.w, y: n.rect.y + r.y + r.h / 2 }
            : side === 'top' ? { x: n.rect.x + r.x + r.w / 2, y: n.rect.y } : { x: n.rect.x + r.x + r.w / 2, y: n.rect.y + n.rect.h };
          return { at, key: part.key };
        }
      }
    };
    const fa = partFor(a.from, sa, a.rels.map((r) => r.from)), fb = partFor(a.to, sb, a.rels.map((r) => r.to));
    if (fa) { p.pa = fa.at; p.partA = fa.key; }
    if (fb) { p.pb = fb.at; p.partB = fb.key; }
    pend.push(p);
    for (const [id, s, has] of [[a.from, sa, !!fa], [a.to, sb, !!fb]] as const) {
      if (has) continue;
      const k = `${id}|${s}`;
      if (!sideCount.has(k)) sideCount.set(k, []);
      sideCount.get(k)!.push(p);
    }
  }
  // Spread free ports along each side, ordered by where the other end is, so lines don't cross at the node.
  for (const [k, list] of [...sideCount].sort((x, y) => cmp(x[0], y[0]))) {
    const [id, side] = k.split('|') as [string, Side];
    const r = rectOf(id)!;
    const vertical = side === 'left' || side === 'right';
    const otherC = (p: Pending) => { const o = rectOf(p.a.from === id ? p.a.to : p.a.from)!; return vertical ? o.y + o.h / 2 : o.x + o.w / 2; };
    list.sort((x, y) => otherC(x) - otherC(y) || cmp(x.a.kind, y.a.kind) || cmp(x.a.from + x.a.to, y.a.from + y.a.to));
    list.forEach((p, i) => {
      const t = (i + 1) / (list.length + 1);
      const span = vertical ? r.h : r.w;
      const off = span * 0.2 + t * span * 0.6;
      const at = side === 'left' ? { x: r.x, y: r.y + off } : side === 'right' ? { x: r.x + r.w, y: r.y + off } : side === 'top' ? { x: r.x + off, y: r.y } : { x: r.x + off, y: r.y + r.h };
      if (p.a.from === id && !p.pa) p.pa = at; else if (!p.pb) p.pb = at; else p.pa = at;
    });
  }
  const maxBottom = Math.max(0, ...nodes.map((n) => n.rect.y + n.rect.h));
  const maxRight = Math.max(0, ...nodes.map((n) => n.rect.x + n.rect.w));
  let backLane = 0;
  const edges: SceneEdge[] = pend.map((p) => {
    const a = p.a;
    let pts: Point[];
    if (p.back) {
      // A return (a cycle): routed around the outside, below (or right of) everything, so it reads as a loop back.
      backLane++;
      const lane = (down ? maxRight : maxBottom) + 36 + backLane * 14;
      pts = down ? route(p.pa!, 'right', p.pb!, 'right', lane) : route(p.pa!, 'bottom', p.pb!, 'bottom', lane);
    } else pts = route(p.pa!, p.sa, p.pb!, p.sb);
    const mix: Partial<Record<Provenance, number>> = {};
    for (const r of a.rels) mix[r.provenance] = (mix[r.provenance] ?? 0) + 1;
    const provenance = PROVENANCE_ORDER.find((pv) => mix[pv]) ?? 'code';
    const statuses = a.rels.map((r) => r.status);
    const status: EntityStatus = statuses.includes('missing') ? 'missing' : statuses.includes('stale') ? 'stale' : statuses.includes('changed') ? 'changed' : statuses.includes('new') ? 'new' : statuses.every((s) => s === 'unknown') ? 'unknown' : 'current';
    const labels = [...new Set(a.rels.map((r) => r.label).filter((l): l is string => !!l))].sort(cmp);
    const label = labels.length === 0 ? undefined : labels.length <= 2 ? labels.join(', ') : `${labels[0]} +${labels.length - 1}`;
    const g = grammarFor(a.kind);
    const crossings: SceneEdge['crossings'] = [];
    const za = zoneOfId(a.from), zb = zoneOfId(a.to);
    if (g.marksBoundary && za !== zb && zoneRect.has(za)) {
      const at = exitPoint(pts, zoneRect.get(za)!);
      if (at) crossings.push({ at, from: za, to: zb });
    }
    const ea = byId.get(a.from)?.emphasis ?? 'context', eb = byId.get(a.to)?.emphasis ?? 'context';
    const emphasis: Emphasis = ea === 'dim' || eb === 'dim' ? 'dim' : ea === 'primary' && eb === 'primary' ? 'primary' : 'context';
    return {
      id: a.rels.length === 1 ? a.rels[0].id : `rollup:${a.from}--${a.kind}--${a.to}`, kind: a.kind, from: a.from, to: a.to,
      relations: a.rels.map((r) => r.id), label: label ?? (a.kind in GRAMMAR_KNOWN ? undefined : a.kind),
      count: a.rels.length, provenance, provenanceMix: mix, status, grammar: g, points: pts, labelAt: labelPoint(pts), crossings,
      back: p.back, portal: a.portal, emphasis,
      parts: [p.partA ?? null, p.partB ?? null],
    };
  });

  /* stubs: connections whose other end isn't drawn */
  const stubs: SceneStub[] = [];
  for (const s of [...stubAgg.values()].sort((a, b) => cmp(a.node, b.node) || cmp(a.dir, b.dir) || cmp(a.reason, b.reason))) {
    const r = byId.get(s.node)!.rect;
    const outSide = s.dir === 'out';
    const k = stubs.filter((x) => x.node === s.node && x.direction === s.dir).length;
    const at = down
      ? { x: r.x + r.w * (0.3 + k * 0.25), y: outSide ? r.y + r.h : r.y }
      : { x: outSide ? r.x + r.w : r.x, y: r.y + r.h - 14 - k * 18 };
    const end = down ? { x: at.x, y: at.y + (outSide ? 40 : -40) } : { x: at.x + (outSide ? 44 : -44), y: at.y };
    stubs.push({
      id: `stub:${s.node}:${s.dir}:${s.reason}`, node: s.node, direction: s.dir, reason: s.reason, count: s.count,
      kinds: [...s.kinds].sort(cmp), others: [...s.others].sort(cmp), points: outSide ? [at, end] : [end, at], labelAt: end,
    });
  }

  /* overflow: "+N more" per zone, at the end of its band */
  const overflow: SceneOverflow[] = [];
  for (const [z, ids] of [...L.hidden].sort((a, b) => cmp(a[0], b[0]))) {
    const zr = zoneRect.get(z) ?? all;
    const rect = down ? { x: zr.x + 12, y: zr.y + zr.h - 52, w: 180, h: 40 } : { x: zr.x + zr.w - 200, y: zr.y + 8, w: 184, h: 40 };
    overflow.push({ id: `more:${z}`, zone: z, hidden: [...ids].sort(cmp), rect });
  }

  /* the sequence, placed on what this level shows */
  const sequence = ctx.sequence ? placeSequence(ctx, ctx.sequence, vis, byId, portalById, req.failureAt) : null;

  /* bounds, legend, outline */
  const rects = [...nodes.map((n) => n.rect), ...zones.map((z) => z.rect), ...portals.map((p) => p.rect), ...groups.map((g) => g.rect), ...overflow.map((o) => o.rect)];
  if (frame) rects.push(frame);
  for (const e of edges) rects.push(union(e.points.map((p) => ({ x: p.x, y: p.y, w: 0, h: 0 }))));
  for (const s of stubs) rects.push(union(s.points.map((p) => ({ x: p.x - 40, y: p.y - 10, w: 80, h: 20 }))));
  if (sequence) for (const s of sequence.steps) rects.push({ x: s.at.x - 20, y: s.at.y - 20, w: 40, h: 40 });
  if (sequence) for (const s of sequence.segments) rects.push(union(s.points.map((p) => ({ x: p.x, y: p.y, w: 0, h: 0 }))));
  const bounds = pad(union(rects), 40);

  const formKinds = new Map<FormId, Set<string>>();
  for (const n of nodes) { if (!formKinds.has(n.form)) formKinds.set(n.form, new Set()); formKinds.get(n.form)!.add(n.kindLabel); }
  const relKinds = [...new Set(edges.map((e) => e.kind))].sort(cmp);
  const provs = new Set<Provenance>([...nodes.map((n) => n.provenance), ...edges.flatMap((e) => Object.keys(e.provenanceMix) as Provenance[])]);
  if (sequence?.kind === 'trace') provs.add('observed');
  const stats = new Set<EntityStatus>(nodes.map((n) => n.status));

  const zi = (z: string) => L.zoneOrder.indexOf(z);
  const reading = [...nodes].sort((a, b) => zi(a.zone) - zi(b.zone) || (down ? a.rect.x - b.rect.x : a.rect.y - b.rect.y) || (down ? a.rect.y - b.rect.y : a.rect.x - b.rect.x) || cmp(a.id, b.id));
  const outline: OutlineItem[] = reading.map((n) => ({
    id: n.id, name: n.name, kindLabel: n.kindLabel, depth: entered.length,
    parts: n.parts.filter((p) => p.entity).map((p) => ({ id: p.entity!, label: p.label ?? p.entity! })),
  }));

  const placed: Record<string, [number, number]> = {};
  for (const n of nodes) if (!n.ghost) placed[n.id] = [n.rect.x, n.rect.y];

  const warnings = [...ctx.resolved.warnings];
  for (const [z, ids] of L.hidden) warnings.push(`${ids.length} more in ${z} not drawn (showing the ${L.members.length} most relevant).`);
  if (sequence?.offstage.length) warnings.push(`${sequence.offstage.length} step(s) happen in parts not on this level.`);
  if (state0(ctx).entered.length !== entered.length) warnings.push('Part of the entered path no longer exists; showing the nearest level that does.');

  return {
    schema: SCENE_SCHEMA, view: req.id, lens, flow: ctx.flow,
    level: { key: L.key, entered, root, frame, form: root ? formFor(ctx.ent(root)!.kind) : null },
    bounds, zones, groups, nodes, edges, portals, stubs, overflow, sequence,
    legend: {
      forms: [...formKinds].sort((a, b) => cmp(a[0], b[0])).map(([form, ks]) => ({ form, kinds: [...ks].sort(cmp) })),
      relations: relKinds.map(grammarFor),
      provenance: PROVENANCE_ORDER.filter((p) => provs.has(p)),
      status: (['current', 'changed', 'stale', 'missing', 'new', 'unknown'] as EntityStatus[]).filter((s) => stats.has(s)),
    },
    outline, placed, warnings,
  };
}

const GRAMMAR_KNOWN: Record<string, true> = Object.fromEntries(
  ['calls', 'sends', 'handles', 'writes', 'reads', 'publishes', 'consumes', 'depends_on', 'implements', 'verified_by', 'produces', 'renders', 'precedes', 'contains'].map((k) => [k, true]),
);

const state0 = (ctx: Ctx) => ctx.state;

/** Where a polyline first leaves a rectangle. */
function exitPoint(pts: Point[], r: Rect): Point | null {
  const inside = (p: Point) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (inside(a) && !inside(b)) {
      let lo = 0, hi = 1;
      for (let k = 0; k < 20; k++) {
        const m = (lo + hi) / 2;
        if (inside({ x: a.x + (b.x - a.x) * m, y: a.y + (b.y - a.y) * m })) lo = m; else hi = m;
      }
      return { x: Math.round(a.x + (b.x - a.x) * lo), y: Math.round(a.y + (b.y - a.y) * lo) };
    }
  }
  return null;
}

/* ---------- sequences ---------- */

function placeSequence(
  ctx: Ctx, seq: Sequence, vis: (id: string) => Vis, byId: Map<string, SceneNode>, portals: Map<string, ScenePortal>, failureAt?: string,
): SceneSequence {
  const steps: SceneStep[] = [];
  const perNode = new Map<string, number>();
  const offstage: string[] = [];
  const maxBottom = Math.max(0, ...[...byId.values()].map((n) => n.rect.y + n.rect.h));
  let offX = 0;
  seq.steps.forEach((s: SequenceStep, index) => {
    const v = vis(s.entity);
    const on = v.kind === 'member' || v.kind === 'portal' ? v.id : null;
    let at: Point;
    let part: string | undefined;
    const n = on ? byId.get(on) : undefined;
    const pr = on ? portals.get(on) : undefined;
    if (n) {
      const pt = n.parts.find((p) => p.entity && (p.entity === s.entity || isUnder(ctx, s.entity, p.entity)));
      const k = perNode.get(n.id) ?? 0;
      perNode.set(n.id, k + 1);
      if (pt) {
        part = pt.key;
        at = { x: n.rect.x + pt.rect.x + pt.rect.w - 12 - (k % 3) * 6, y: n.rect.y + pt.rect.y + pt.rect.h / 2 };
      } else {
        // Stations along the node's head, right to left, wrapping to a second row.
        const per = Math.max(1, Math.floor((n.rect.w - 150) / 26));
        at = { x: n.rect.x + n.rect.w - 18 - (k % per) * 26, y: n.rect.y + 16 + Math.floor(k / per) * 24 };
      }
    } else if (pr) {
      const k = perNode.get(pr.id) ?? 0;
      perNode.set(pr.id, k + 1);
      at = { x: pr.rect.x + pr.rect.w - 16 - k * 24, y: pr.rect.y + pr.rect.h / 2 };
    } else {
      offstage.push(s.id);
      at = { x: offX, y: maxBottom + 120 };
      offX += 40;
    }
    steps.push({
      id: s.id, index, entity: s.entity, on, part, at: { x: Math.round(at.x), y: Math.round(at.y) }, label: s.label, detail: s.detail,
      ctx: s.ctx ?? [], guard: s.guard, next: s.next ?? (index + 1 < seq.steps.length ? [seq.steps[index + 1].id] : []),
      evidence: s.evidence, relation: s.relation, time: s.at, observed: s.observed, failure: failureAt === s.id || undefined,
    });
  });
  const idx = new Map(steps.map((s) => [s.id, s]));
  const segments: SceneSegment[] = [];
  let loops = 0;
  for (const s of steps) {
    for (const t of s.next) {
      const to = idx.get(t);
      if (!to) continue;
      const kind: SceneSegment['kind'] = to.index <= s.index ? 'loop' : s.next.length > 1 ? 'branch' : 'next';
      let points: Point[];
      if (kind === 'loop') {
        // A loop is drawn as one: out below both stations and back.
        loops++;
        const y = Math.max(s.at.y, to.at.y) + 44 + loops * 10;
        points = [s.at, { x: s.at.x, y }, { x: to.at.x, y }, to.at];
      } else points = [s.at, to.at];
      segments.push({ from: s.id, to: t, kind, points, guard: kind !== 'next' ? s.guard ?? to.guard : undefined });
    }
  }
  const claim = seq.kind === 'trace' && ctx.recorded
    ? `Observed — recorded ${ctx.recorded.where}, ${ctx.recorded.at}, by ${ctx.recorded.by}.`
    : seq.kind === 'trace' ? 'Observed — from a recorded trace.'
    : 'Possible path, derived from code — not a recording of a run.';
  return { id: seq.id, title: seq.title, kind: seq.kind, claim, recorded: ctx.recorded, steps, segments, notes: seq.notes ?? [], offstage };
}

/** A recorded trace as a sequence: every event a step on the entity it happened in. Events on unknown ids stay, flagged. */
export function traceToSequence(trace: Trace, registry: SystemRegistry): Sequence {
  return {
    id: `trace:${trace.id}`, title: trace.title, kind: 'trace', provenance: 'observed', evidence: [],
    notes: trace.events.some((e) => !registry.entities[e.entity]) ? ['Some events name parts the registry does not have.'] : [],
    steps: trace.events.map((e, i) => ({
      id: `trace:${trace.id}:${i}`, entity: e.entity, label: e.label, evidence: [], at: e.at, observed: e.data,
    })),
  };
}

/** The level keys from the top down to the entered path: '' , 'a', 'a/b'. */
export function levelKeys(entered: string[]): string[] {
  return entered.map((_, i) => levelKey(entered.slice(0, i + 1))).reduce((acc, k) => [...acc, k], ['']);
}
