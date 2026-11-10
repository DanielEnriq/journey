import type { Point, Rect } from './scene.js';

// Deterministic layered layout. Nodes are ranked along the flow (longest path over the relations that
// carry it, cycles broken by a fixed rule), banded across the flow by runtime zone, and ordered within a
// cell by their neighbours. Then memory and pins win: a node already placed keeps its place, a pinned node
// sits where the person put it, and anything new is fitted into free space near where the layout wanted it.
// No randomness, no clocks: ties always fall back to ids.

export interface LayoutNode { id: string; w: number; h: number; zone: string; group?: string; priority: number }
export interface LayoutEdge { from: string; to: string; weight: number }

export interface LayoutResult {
  pos: Record<string, Point>;
  placed: Record<string, 'pinned' | 'memory' | 'layout'>;
  rank: Record<string, number>;
  /** Back edges (from→to) the ranking reversed to break a cycle. */
  back: Set<string>;
  zoneOrder: string[];
  /** Zones laid out as a column beside the rows (shared code, built into several of them). */
  side: string[];
}

/** Code that runs in more than one runtime stands beside the stack rather than in it. */
export const SIDE_ZONES = ['shared'];

export const GAP_MAIN = 120;
export const GAP_CROSS = 56;
export const ZONE_GAP = 56;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Ranks by longest path; edges closing a cycle (found by DFS in id order) are reversed and remembered. */
export function rankNodes(ids: string[], edges: LayoutEdge[]): { rank: Record<string, number>; back: Set<string> } {
  const sorted = [...ids].sort(cmp);
  const out = new Map<string, string[]>();
  for (const id of sorted) out.set(id, []);
  const es = [...edges].filter((e) => out.has(e.from) && out.has(e.to) && e.from !== e.to)
    .sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to));
  for (const e of es) if (!out.get(e.from)!.includes(e.to)) out.get(e.from)!.push(e.to);
  for (const l of out.values()) l.sort(cmp);
  const state = new Map<string, 0 | 1 | 2>();
  const back = new Set<string>();
  const visit = (id: string) => {
    // Iterative DFS so a 300-node chain can't overflow the stack.
    const stack: [string, number][] = [[id, 0]];
    state.set(id, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const nexts = out.get(top[0])!;
      if (top[1] >= nexts.length) { state.set(top[0], 2); stack.pop(); continue; }
      const n = nexts[top[1]++];
      const s = state.get(n) ?? 0;
      if (s === 1) back.add(`${top[0]}>${n}`);
      else if (s === 0) { state.set(n, 1); stack.push([n, 0]); }
    }
  };
  // Start from sources first, so a cycle is broken at the edge that returns, not the one that leaves.
  const indeg = new Map(sorted.map((id) => [id, 0]));
  for (const [, l] of out) for (const t of l) indeg.set(t, indeg.get(t)! + 1);
  for (const id of sorted) if (indeg.get(id) === 0 && !state.get(id)) visit(id);
  for (const id of sorted) if (!state.get(id)) visit(id);

  // Longest path over the DAG (Kahn's order, ids breaking ties).
  const dag = new Map<string, string[]>(sorted.map((id) => [id, []]));
  const deg = new Map(sorted.map((id) => [id, 0]));
  for (const [f, l] of out) for (const t of l) {
    const [a, b] = back.has(`${f}>${t}`) ? [t, f] : [f, t];
    if (a === b || dag.get(a)!.includes(b)) continue;
    dag.get(a)!.push(b); deg.set(b, deg.get(b)! + 1);
  }
  const rank: Record<string, number> = {};
  const ready = sorted.filter((id) => deg.get(id) === 0);
  for (const id of sorted) rank[id] = 0;
  while (ready.length) {
    ready.sort(cmp);
    const id = ready.shift()!;
    for (const t of dag.get(id)!) {
      rank[t] = Math.max(rank[t], rank[id] + 1);
      deg.set(t, deg.get(t)! - 1);
      if (deg.get(t) === 0) ready.push(t);
    }
  }
  return { rank, back };
}

/**
 * Lays nodes out in a grid of (zone band × rank column). Flow 'right': ranks run left→right, zones stack
 * top→bottom. Flow 'down': ranks run top→bottom, zones sit side by side.
 */
export function layeredLayout(nodes: LayoutNode[], edges: LayoutEdge[], opts: {
  flow: 'right' | 'down';
  zoneOrder?: (zones: string[], meanRank: Record<string, number>) => string[];
  memory?: Record<string, [number, number]>;
  pinned?: Record<string, [number, number]>;
  /**
   * 'rows': each runtime zone is a row and the flow runs down through them, like a section through the
   * stack; within a row, parts sit under the neighbours they connect to. 'columns': classic layers along
   * the flow (one zone, or none).
   */
  mode?: 'rows' | 'columns';
}): LayoutResult {
  const ids = nodes.map((n) => n.id).sort(cmp);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const { rank, back } = rankNodes(ids, edges);
  // Compress ranks so empty columns don't open gaps.
  const used = [...new Set(ids.map((id) => rank[id]))].sort((a, b) => a - b);
  for (const id of ids) rank[id] = used.indexOf(rank[id]);

  const zones = [...new Set(ids.map((id) => byId.get(id)!.zone))].sort(cmp);
  const mean: Record<string, number> = {};
  for (const z of zones) { const r = ids.filter((id) => byId.get(id)!.zone === z).map((id) => rank[id]); mean[z] = r.reduce((a, b) => a + b, 0) / r.length; }
  const zoneOrder = opts.zoneOrder ? opts.zoneOrder(zones, mean) : [...zones].sort((a, b) => mean[a] - mean[b] || cmp(a, b));

  // Order within each (zone, rank) cell: group first (so a subsystem's members sit together), then the
  // barycentre of neighbours in earlier ranks, two sweeps, ids breaking ties.
  const adj = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of edges) if (adj.has(e.from) && adj.has(e.to) && e.from !== e.to) { adj.get(e.from)!.push(e.to); adj.get(e.to)!.push(e.from); }
  const cellKey = (id: string) => `${byId.get(id)!.zone}|${rank[id]}`;
  const cells = new Map<string, string[]>();
  for (const id of ids) { const k = cellKey(id); if (!cells.has(k)) cells.set(k, []); cells.get(k)!.push(id); }
  const order: Record<string, number> = {};
  for (const l of cells.values()) l.forEach((id, i) => (order[id] = i));
  const groupKey = (id: string) => byId.get(id)!.group ?? '';
  for (let sweep = 0; sweep < 2; sweep++) {
    for (const l of [...cells.values()]) {
      const bc = (id: string) => {
        const ns = adj.get(id)!.filter((n) => rank[n] < rank[id] || (sweep === 1 && rank[n] > rank[id]));
        return ns.length ? ns.reduce((s, n) => s + order[n], 0) / ns.length : order[id];
      };
      const b = new Map(l.map((id) => [id, bc(id)]));
      l.sort((x, y) => cmp(groupKey(x), groupKey(y)) || b.get(x)! - b.get(y)! || byId.get(y)!.priority - byId.get(x)!.priority || cmp(x, y));
      l.forEach((id, i) => (order[id] = i));
    }
  }

  // Grid sizes: a column is as long (along the flow) as its widest node; a band as deep as its fullest cell.
  const down = opts.flow === 'down';
  const mainSize = (n: LayoutNode) => (down ? n.h : n.w);
  const crossSize = (n: LayoutNode) => (down ? n.w : n.h);
  const ranks = Math.max(0, ...ids.map((id) => rank[id])) + 1;
  const colMain = new Array(ranks).fill(0);
  for (const id of ids) colMain[rank[id]] = Math.max(colMain[rank[id]], mainSize(byId.get(id)!));
  const colStart: number[] = [];
  let acc = 0;
  for (let r = 0; r < ranks; r++) { colStart.push(acc); acc += colMain[r] + GAP_MAIN; }
  const bandStart: Record<string, number> = {};
  let crossAcc = 0;
  for (const z of zoneOrder) {
    bandStart[z] = crossAcc;
    let deepest = 0;
    for (const [k, l] of cells) {
      if (!k.startsWith(z + '|')) continue;
      const d = l.reduce((s, id) => s + crossSize(byId.get(id)!), 0) + GAP_CROSS * (l.length - 1);
      deepest = Math.max(deepest, d);
    }
    crossAcc += deepest + ZONE_GAP * 2;
  }

  let fresh: Record<string, Point> = {};
  const side = opts.mode === 'rows' && zoneOrder.length > 1 && zoneOrder.some((z) => !SIDE_ZONES.includes(z)) ? zoneOrder.filter((z) => SIDE_ZONES.includes(z)) : [];
  if (opts.mode === 'rows' && zoneOrder.length > 1) fresh = rowLayout(ids, byId, adj, rank, order, zoneOrder);
  else for (const [k, l] of cells) {
    const z = k.slice(0, k.lastIndexOf('|'));
    let c = bandStart[z] + ZONE_GAP;
    for (const id of l) {
      const n = byId.get(id)!;
      // Centre nodes in their column so short ones don't hug the left edge.
      const m = colStart[rank[id]] + (colMain[rank[id]] - mainSize(n)) / 2;
      fresh[id] = down ? { x: c, y: m } : { x: m, y: c };
      c += crossSize(n) + GAP_CROSS;
    }
  }

  // Pins, then memory, then fresh placement fitted around what's already there.
  const pos: Record<string, Point> = {};
  const placed: LayoutResult['placed'] = {};
  const taken: Rect[] = [];
  for (const id of ids) {
    const p = opts.pinned?.[id];
    if (p) { pos[id] = { x: p[0], y: p[1] }; placed[id] = 'pinned'; }
  }
  for (const id of ids) {
    if (pos[id]) continue;
    const m = opts.memory?.[id];
    if (m) { pos[id] = { x: m[0], y: m[1] }; placed[id] = 'memory'; }
  }
  for (const id of ids) if (pos[id]) taken.push(rectOf(pos[id], byId.get(id)!));
  const hasPrior = taken.length > 0;
  for (const id of ids) {
    if (pos[id]) continue;
    const n = byId.get(id)!;
    const want = hasPrior ? shiftedFresh(id, fresh, pos, byId) : fresh[id];
    const at = freeSpot(want, n, taken, down);
    pos[id] = at;
    placed[id] = 'layout';
    taken.push(rectOf(at, n));
  }
  return { pos, placed, rank, back, zoneOrder, side };
}

/** Max parts side by side in one row before it wraps into another line within its zone. */
const ROW_MAX = 6;

function rowLayout(ids: string[], byId: Map<string, LayoutNode>, adj: Map<string, string[]>, rank: Record<string, number>, order: Record<string, number>, zoneOrder: string[]): Record<string, Point> {
  const out: Record<string, Point> = {};
  const unit = 360;
  let y = ZONE_GAP;
  // Only a stack can have something beside it: with no other zone, the side zone is the stack.
  const hasStack = zoneOrder.some((z) => !SIDE_ZONES.includes(z));
  const sideZones = hasStack ? zoneOrder.filter((z) => SIDE_ZONES.includes(z)) : [];
  const stackZones = zoneOrder.filter((z) => !sideZones.includes(z));
  for (const z of stackZones) {
    const members = ids.filter((id) => byId.get(id)!.zone === z);
    // Where each wants to be: under (or over) the centre of its already-placed neighbours, else by rank.
    const want = new Map(members.map((id) => {
      const placed = adj.get(id)!.filter((n) => out[n]);
      const x = placed.length
        ? placed.reduce((s, n) => s + out[n].x + byId.get(n)!.w / 2, 0) / placed.length
        : rank[id] * unit + byId.get(id)!.w / 2;
      return [id, x] as const;
    }));
    const sorted = [...members].sort((a, b) => want.get(a)! - want.get(b)! || rank[a] - rank[b] || order[a] - order[b] || cmp(a, b));
    for (let i = 0; i < sorted.length; i += ROW_MAX) {
      const line = sorted.slice(i, i + ROW_MAX);
      let right = -Infinity;
      let deepest = 0;
      for (const id of line) {
        const n = byId.get(id)!;
        const x = Math.max(want.get(id)! - n.w / 2, right + GAP_MAIN * 0.75);
        out[id] = { x: Math.round(x), y };
        right = x + n.w;
        deepest = Math.max(deepest, n.h);
      }
      y += deepest + GAP_CROSS;
    }
    y += ZONE_GAP * 2 - GAP_CROSS + 24;
  }
  // Shift so the leftmost part starts at 0.
  const minX = Math.min(...Object.values(out).map((p) => p.x));
  for (const id of Object.keys(out)) out[id] = { x: out[id].x - minX, y: out[id].y };
  // The side column: beside the stack, each part level with the middle of what uses it.
  const right = Math.max(0, ...Object.keys(out).map((id) => out[id].x + byId.get(id)!.w));
  let colX = right + GAP_MAIN * 1.6 + 100;
  for (const z of sideZones) {
    const members = ids.filter((id) => byId.get(id)!.zone === z);
    const want = new Map(members.map((id) => {
      const placed = adj.get(id)!.filter((n) => out[n] && !members.includes(n));
      const yy = placed.length ? placed.reduce((s, n) => s + out[n].y + byId.get(n)!.h / 2, 0) / placed.length - byId.get(id)!.h / 2 : ZONE_GAP + rank[id] * 200;
      return [id, yy] as const;
    }));
    const sorted = [...members].sort((a, b) => want.get(a)! - want.get(b)! || cmp(a, b));
    let bottom = -Infinity, widest = 0;
    for (const id of sorted) {
      const n = byId.get(id)!;
      const yy = Math.max(want.get(id)!, bottom + GAP_CROSS);
      out[id] = { x: colX, y: Math.round(yy) };
      bottom = yy + n.h;
      widest = Math.max(widest, n.w);
    }
    colX += widest + GAP_MAIN * 1.6;
  }
  return out;
}

const rectOf = (p: Point, n: { w: number; h: number }): Rect => ({ x: p.x, y: p.y, w: n.w, h: n.h });

/**
 * Where a new node should go when others are remembered: its fresh spot moved by the same offset as its
 * nearest remembered neighbour in the fresh layout moved, so it lands beside what it sat beside.
 */
function shiftedFresh(id: string, fresh: Record<string, Point>, pos: Record<string, Point>, byId: Map<string, LayoutNode>): Point {
  let best: string | null = null, bd = Infinity;
  for (const o of Object.keys(pos).sort(cmp)) {
    if (!fresh[o]) continue;
    const d = Math.hypot(fresh[o].x - fresh[id].x, fresh[o].y - fresh[id].y);
    if (d < bd) { bd = d; best = o; }
  }
  void byId;
  if (!best) return fresh[id];
  return { x: fresh[id].x + pos[best].x - fresh[best].x, y: fresh[id].y + pos[best].y - fresh[best].y };
}

const overlaps = (a: Rect, b: Rect, m: number) => a.x < b.x + b.w + m && b.x < a.x + a.w + m && a.y < b.y + b.h + m && b.y < a.y + a.h + m;

/** The nearest spot to `want` that clears everything placed, searched in a fixed ring order. */
export function freeSpot(want: Point, n: { w: number; h: number }, taken: Rect[], down: boolean): Point {
  const clear = (p: Point) => !taken.some((t) => overlaps(rectOf(p, n), t, 24));
  if (clear(want)) return want;
  const step = 40;
  for (let ring = 1; ring < 200; ring++) {
    // Prefer moving across the flow (down a band) before along it, so ranks stay readable.
    const cand: Point[] = [];
    for (let i = -ring; i <= ring; i++) {
      const a = down ? { x: want.x + ring * step, y: want.y + i * step } : { x: want.x + i * step, y: want.y + ring * step };
      const b = down ? { x: want.x - ring * step, y: want.y + i * step } : { x: want.x + i * step, y: want.y - ring * step };
      cand.push(a, b);
    }
    for (let i = -ring + 1; i < ring; i++) {
      cand.push(down ? { x: want.x + i * step, y: want.y + ring * step } : { x: want.x + ring * step, y: want.y + i * step });
      cand.push(down ? { x: want.x + i * step, y: want.y - ring * step } : { x: want.x - ring * step, y: want.y + i * step });
    }
    cand.sort((p, q) => Math.hypot(p.x - want.x, p.y - want.y) - Math.hypot(q.x - want.x, q.y - want.y) || p.y - q.y || p.x - q.x);
    for (const c of cand) if (clear(c)) return c;
  }
  return { x: want.x, y: Math.max(...taken.map((t) => t.y + t.h)) + 40 };
}

/* ---------- edge routing ---------- */

export type Side = 'left' | 'right' | 'top' | 'bottom';

/** An orthogonal route between two ports leaving and entering along their sides' normals. */
export function route(a: Point, sa: Side, b: Point, sb: Side, bend?: number): Point[] {
  const out = 18;
  const n = (p: Point, s: Side, d: number): Point =>
    s === 'left' ? { x: p.x - d, y: p.y } : s === 'right' ? { x: p.x + d, y: p.y } : s === 'top' ? { x: p.x, y: p.y - d } : { x: p.x, y: p.y + d };
  const a1 = n(a, sa, out), b1 = n(b, sb, out);
  const horizontal = (s: Side) => s === 'left' || s === 'right';
  const pts: Point[] = [a, a1];
  if (horizontal(sa) && horizontal(sb)) {
    const mx = bend ?? (a1.x + b1.x) / 2;
    pts.push({ x: mx, y: a1.y }, { x: mx, y: b1.y });
  } else if (!horizontal(sa) && !horizontal(sb)) {
    const my = bend ?? (a1.y + b1.y) / 2;
    pts.push({ x: a1.x, y: my }, { x: b1.x, y: my });
  } else if (horizontal(sa)) pts.push({ x: b1.x, y: a1.y });
  else pts.push({ x: a1.x, y: b1.y });
  pts.push(b1, b);
  return simplify(pts);
}

const segHits = (a: Point, b: Point, r: Rect) => {
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
  return x0 < r.x + r.w && x1 > r.x && y0 < r.y + r.h && y1 > r.y;
};
const clearPath = (pts: Point[], obs: Rect[]) => pts.every((p, i) => i === 0 || !obs.some((r) => segHits(pts[i - 1], p, r)));

/**
 * An orthogonal route that goes around parts instead of through them: if the plain route crosses
 * another part, the long middle run moves to the nearest free corridor (a gap between parts).
 */
export function routeAvoiding(a: Point, sa: Side, b: Point, sb: Side, obstacles: Rect[], bend?: number): Point[] {
  const obs = obstacles.map((r) => ({ x: r.x - 8, y: r.y - 8, w: r.w + 16, h: r.h + 16 }));
  const plain = route(a, sa, b, sb, bend);
  if (clearPath(plain, obs)) return plain;
  const vert = (s: Side) => s === 'top' || s === 'bottom';
  if (vert(sa) && vert(sb)) {
    const y1 = a.y + (sa === 'bottom' ? 18 : -18) + (bend !== undefined ? (bend - (a.y + b.y) / 2) * 0.3 : 0);
    const y2 = b.y + (sb === 'top' ? -18 : 18);
    const xs = new Set<number>([a.x, b.x]);
    for (const r of obs) { xs.add(r.x - 10); xs.add(r.x + r.w + 10); }
    const best = [...xs].map((x) => ({ x, pts: simplify([a, { x: a.x, y: y1 }, { x, y: y1 }, { x, y: y2 }, { x: b.x, y: y2 }, b]) }))
      .filter((c) => clearPath(c.pts, obs))
      .sort((p, q) => Math.abs(p.x - a.x) + Math.abs(p.x - b.x) - (Math.abs(q.x - a.x) + Math.abs(q.x - b.x)) || p.x - q.x)[0];
    if (best) return best.pts;
  } else if (!vert(sa) && !vert(sb)) {
    const x1 = a.x + (sa === 'right' ? 18 : -18), x2 = b.x + (sb === 'left' ? -18 : 18);
    const ys = new Set<number>([a.y, b.y]);
    for (const r of obs) { ys.add(r.y - 10); ys.add(r.y + r.h + 10); }
    const best = [...ys].map((y) => ({ y, pts: simplify([a, { x: x1, y: a.y }, { x: x1, y }, { x: x2, y }, { x: x2, y: b.y }, b]) }))
      .filter((c) => clearPath(c.pts, obs))
      .sort((p, q) => Math.abs(p.y - a.y) + Math.abs(p.y - b.y) - (Math.abs(q.y - a.y) + Math.abs(q.y - b.y)) || p.y - q.y)[0];
    if (best) return best.pts;
  }
  return plain;
}

/** Drops repeated and collinear points. */
export function simplify(pts: Point[]): Point[] {
  const r = (p: Point) => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 });
  const out: Point[] = [];
  for (const p0 of pts) {
    const p = r(p0);
    const l = out[out.length - 1];
    if (l && l.x === p.x && l.y === p.y) continue;
    if (out.length >= 2) {
      const k = out[out.length - 2];
      if ((k.x === l.x && l.x === p.x) || (k.y === l.y && l.y === p.y)) { out[out.length - 1] = p; continue; }
    }
    out.push(p);
  }
  return out;
}

/** The midpoint of the longest segment: where a label reads best. */
export function labelPoint(pts: Point[]): Point {
  let best = 0, bl = -1;
  for (let i = 0; i < pts.length - 1; i++) {
    const l = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    if (l > bl) { bl = l; best = i; }
  }
  const a = pts[best], b = pts[best + 1] ?? a;
  return { x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2) };
}

export function union(rs: Rect[]): Rect {
  if (!rs.length) return { x: 0, y: 0, w: 0, h: 0 };
  const x = Math.min(...rs.map((r) => r.x)), y = Math.min(...rs.map((r) => r.y));
  return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, h: Math.max(...rs.map((r) => r.y + r.h)) - y };
}

export const pad = (r: Rect, p: number): Rect => ({ x: r.x - p, y: r.y - p, w: r.w + 2 * p, h: r.h + 2 * p });
