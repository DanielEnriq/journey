import type { Component, Relationship, ViewSpec } from '../model.js';
import { countWord, instanceName, labelWidth, past, third, upperFirst, verbOf } from '../words.js';
import {
  callRow, inst, jobLabel, neighboursOf, PART, size, slot, tableOf,
  type PartState, type Rect, type Scene, type SceneBound, type SceneLabel, type SceneNode, type SceneWire, type System,
} from './scene.js';

// Architecture: the system as a topology. Work flows left to right in columns (whoever publishes, the
// queue, its consumers, what they call); stores sit under whoever reads and writes them; a boundary
// is drawn around the components it contains. With the Payment system this reproduces the design's
// Architecture board to within a few pixels: the same columns, gaps, wires and labels.

const ROW_Y = 190;
const GAP_X = 60;
const GAP_Y = 40;
const STORE_GAP = 74;
const LABEL_H = 16;
const PAD = { left: 18, right: 18, top: 30, bottom: 22 };

/** Edges that carry work along the main row, oriented the way the work goes. */
function flow(r: Relationship, sys: System): [string, string] | null {
  const to = sys.get(r.to);
  if (!to || to.kind === 'database' || to.kind === 'event' || to.kind === 'boundary') return null;
  if (r.kind === 'consumes') return [r.to, r.from];
  if (r.kind === 'calls' || r.kind === 'publishes' || r.kind === 'depends_on') return [r.from, r.to];
  return null;
}

/** The first part already placed that a box at (x, y, w, h) would overlap, gaps included. */
const meets = (ax: number, ay: number, aw: number, ah: number, bx: number, by: number, bw: number, bh: number) => ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;

function blocker(rects: Record<string, Rect>, x: number, y: number, w: number, h: number): Rect | undefined {
  return Object.values(rects).find(([rx, ry, rw, rh]) => x < rx + rw + GAP_X / 2 && rx < x + w + GAP_X / 2 && y < ry + rh + GAP_Y && ry < y + h + GAP_Y);
}

export function architecture(spec: ViewSpec, sys: System): Scene {
  const doc = sys.doc;
  const drawn = Object.values(doc.components).filter((c) => PART[c.kind]);
  const main = drawn.filter((c) => c.kind !== 'database');
  const stores = drawn.filter((c) => c.kind === 'database');

  // Columns by longest path from where work enters; a cycle is cut where it closes.
  const edges = sys.rels.map((r) => flow(r, sys)).filter((e): e is [string, string] => !!e && main.some((c) => c.id === e[0]) && main.some((c) => c.id === e[1]));
  const rank = new Map<string, number>();
  const visiting = new Set<string>();
  const rankOf = (id: string): number => {
    if (rank.has(id)) return rank.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const ins = edges.filter(([, to]) => to === id).map(([from]) => from);
    const r = ins.length ? Math.max(...ins.map((f) => rankOf(f) + 1)) : 0;
    visiting.delete(id);
    rank.set(id, r);
    return r;
  };
  main.forEach((c) => rankOf(c.id));
  const columns: Component[][] = [];
  main.forEach((c) => { (columns[rank.get(c.id)!] ??= []).push(c); });

  const rects: Record<string, Rect> = {};
  let x = 0;
  columns.filter(Boolean).forEach((col) => {
    const w = Math.max(...col.map((c) => size(c)[0]));
    let y = ROW_Y;
    col.forEach((c) => {
      const [cw, ch] = size(c);
      // Shorter parts centre on the row, as the design's endpoint does.
      rects[c.id] = [x + (w - cw) / 2, y + (146 - ch) / 2, cw, ch];
      y += Math.max(ch, 146) + GAP_Y;
    });
    x += w + GAP_X;
  });

  // Stores under whoever reads and writes them; unconnected stores at the end of the row.
  const below: Record<string, number> = {};
  stores.forEach((s) => {
    const accessor = sys.rels.find((r) => r.to === s.id && rects[r.from])?.from;
    const [w, h] = size(s);
    if (accessor) {
      const a = rects[accessor], sx = a[0] + a[2] / 2 - w / 2;
      let stack = below[accessor] ?? a[1] + a[3] + STORE_GAP;
      // Another part may already stand under the accessor in its column: go on down past it.
      for (let hit = blocker(rects, sx, stack, w, h); hit; hit = blocker(rects, sx, stack, w, h)) stack = hit[1] + hit[3] + STORE_GAP;
      rects[s.id] = [sx, stack, w, h];
      below[accessor] = stack + h + GAP_Y;
    } else {
      rects[s.id] = [x, ROW_Y, w, h];
      x += w + GAP_X;
    }
  });

  const wires: SceneWire[] = [];
  const labels: SceneLabel[] = [];
  const pairs: [string, string][] = [];
  sys.rels.forEach((r) => {
    const e = flow(r, sys) ?? (r.kind === 'reads_writes' || sys.get(r.to)?.kind === 'database' ? [r.from, r.to] as [string, string] : null);
    if (!e || !rects[e[0]] || !rects[e[1]]) return;
    const A = rects[e[0]], B = rects[e[1]], t = r.label ?? r.kind.replace('_', '/');
    pairs.push(e);
    const ay = A[1] + A[3] / 2, by = B[1] + B[3] / 2;
    if (B[0] >= A[0] + A[2]) {
      const x1 = A[0] + A[2], x2 = B[0], level = Math.abs(ay - by) < 1, mx = level ? x1 : x1 + (x2 - x1) / 2;
      if (level) wires.push({ c: 'h arrow', x: x1, y: ay, w: x2 - x1, h: 1.35 });
      else {
        wires.push({ c: 'h', x: x1, y: ay, w: mx - x1, h: 1.35 }, { c: 'v', x: mx, y: Math.min(ay, by), w: 1.35, h: Math.abs(by - ay) }, { c: 'h arrow', x: mx, y: by, w: x2 - mx, h: 1.35 });
      }
      // Wires fanning out of one part share their first stretch, and a long wire runs behind the parts it passes,
      // so a label goes to the first of these spots that sits on no other label and no part (the middle may run onto its own ends, as it always has): the middle of the
      // wire, the middle of its last stretch, or just before its target. With none free, it's left to the other views.
      const w = labelWidth(t);
      const spot = [
        { x: Math.round(x1 + Math.max(2, (x2 - x1 - w) / 2)), y: Math.min(ay, by) - 19 },
        { x: Math.round(mx + Math.max(2, (x2 - mx - w) / 2)), y: by - 19 },
        { x: Math.round(x2 - w - 4), y: by - 19 },
      ].find((c, i) => labels.every((l) => !meets(c.x, c.y, w, LABEL_H, l.x, l.y, labelWidth(l.t), LABEL_H)) && Object.entries(rects).every(([id, [rx, ry, rw, rh]]) => (i === 0 && e.includes(id)) || !meets(c.x, c.y, w, LABEL_H, rx, ry, rw, rh)));
      if (spot) labels.push({ t, ...spot });
    } else if (B[1] >= A[1] + A[3]) {
      const cx = A[0] + A[2] / 2, y1 = A[1] + A[3];
      if (cx > B[0] && cx < B[0] + B[2]) {
        wires.push({ c: 'v varrow', x: cx, y: y1, w: 1.35, h: B[1] - y1 });
        labels.push({ t, x: cx + 8, y: Math.round(y1 + (B[1] - y1) / 2 - 11) });
      } else {
        // Below but in another column: down to the target's middle, then across into its near side.
        const left = B[0] + B[2] <= cx, ex = left ? B[0] + B[2] : B[0];
        wires.push({ c: 'v', x: cx, y: y1, w: 1.35, h: by - y1 }, { c: 'h arrow' + (left ? ' rev' : ''), x: Math.min(cx, ex), y: by, w: Math.abs(ex - cx), h: 1.35 });
        labels.push({ t, x: cx + 8, y: Math.round(y1 + (by - y1) / 2 - 11) });
      }
    }
    // Anything pointing back up or left is a relationship the topology doesn't draw; other views do.
  });

  const bounds: SceneBound[] = Object.values(doc.components).filter((b) => b.kind === 'boundary').flatMap((b) => {
    const inside = drawn.filter((c) => c.parent === b.id && rects[c.id]).map((c) => rects[c.id]);
    if (!inside.length) return [];
    const x0 = Math.min(...inside.map((r) => r[0])) - PAD.left, y0 = Math.min(...inside.map((r) => r[1])) - PAD.top;
    const x1 = Math.max(...inside.map((r) => r[0] + r[2])) + PAD.right, y1 = Math.max(...inside.map((r) => r[1] + r[3])) + PAD.bottom;
    return [{ x: x0, y: y0, w: x1 - x0, h: y1 - y0, label: b.name, component: b.id }];
  });

  const nodes: SceneNode[] = drawn.map((c) => ({
    key: c.id, component: c.id, instance: 1, kind: PART[c.kind]!.kind, smart: PART[c.kind]!.smart,
    name: c.name, short: c.short ?? 'the ' + c.name.toLowerCase(), tech: c.tech ?? '', rect: rects[c.id], proposed: c.status === 'proposed',
    delay: 0, state: steady(c, sys),
  }));

  const right = Math.max(0, ...nodes.map((n) => n.rect[0] + n.rect[2]), ...bounds.map((b) => b.x + b.w));
  const bottom = Math.max(0, ...nodes.map((n) => n.rect[1] + n.rect[3]));
  return {
    view: spec.id, type: 'architecture', name: spec.name, question: spec.question, provenance: spec.provenance, parent: spec.parent,
    proposed: spec.status === 'proposed',
    recipe: { arrangement: 'Topology', blocks: drawn.map((c) => block(c, sys)).concat(bounds.map((b) => `Boundary · ${b.label}`)) },
    viewBox: [Math.round(right), Math.round(bottom + 30)], nodes, wires, labels, bounds, steps: [], neighbours: neighboursOf(pairs),
  };
}

/** What each part draws in the steady state: the system working as intended. */
export function steady(c: Component, sys: System): PartState {
  const out: PartState = { cap: c.note ?? '', capCls: 'cap' };
  if (c.kind === 'service') out.endpoint = c.endpoint;
  if (c.kind === 'queue') {
    const consumers = sys.rels.filter((r) => r.kind === 'consumes' && r.to === c.id).map((r) => sys.get(r.from)!).filter(Boolean);
    const holder = (j: Component) => consumers[0] ? instanceName(consumers[0], 1) : 'a consumer';
    const jobs = sys.jobsIn(c.id).slice(0, 3);
    out.slots = jobs.map((j) => j.state === 'done' ? slot(jobLabel(j), 'acked', 'done') : j.state === 'leased' ? slot(jobLabel(j), 'leased', holder(j), 62) : slot(jobLabel(j), 'visible', 'waiting'));
    const leased = jobs.find((j) => j.state === 'leased');
    if (!c.note && leased) out.cap = `${jobLabel(leased)} leased to ${holder(leased)}.`;
  }
  if (c.kind === 'worker') {
    const job = sys.leasedBy(c.id), effect = sys.effectOf(c.id);
    out.insts = [inst(instanceName(c, 1), job ? jobLabel(job) : 'idle', '')];
    if (!c.note && effect && sys.queueOf(c.id)) out.cap = `${upperFirst(third(verbOf(effect)))}, then acks the job.`;
  }
  if (c.kind === 'external') {
    const effects = sys.rels.filter((r) => r.kind === 'calls' && r.to === c.id);
    const rows = effects.flatMap((r) => { const job = sys.leasedBy(r.from); return job ? [callRow(`${verbOf(r)} ${jobLabel(job)}`, job.amount ?? '', '✓')] : []; });
    out.calls = rows;
    if (!c.note && rows.length) out.cap = `${upperFirst(past(effects[0]))} once.`;
  }
  if (c.kind === 'database') Object.assign(out, tableOf(c));
  return out;
}

function block(c: Component, sys: System): string {
  if (c.kind === 'service') return `${c.endpoint ? 'Endpoint' : 'Service'} · ${c.name}`;
  if (c.kind === 'queue') {
    const jobs = sys.jobsIn(c.id);
    return jobs.length > 1 ? `Queue · jobs ${jobLabel(jobs[0])}–${jobLabel(jobs[jobs.length - 1]).replace(/^#/, '')}` : `Queue · ${c.name}`;
  }
  if (c.kind === 'worker') return `Service · ${instanceName(c, 1)}`;
  if (c.kind === 'external') {
    const r = sys.rels.find((x) => x.kind === 'calls' && x.to === c.id);
    return r && sys.leasedBy(r.from) ? `External · one ${verbOf(r)}` : `External · ${c.name}`;
  }
  return `Store · ${countWord(Math.max(0, (c.rows?.length ?? 1) - 1))} rows`;
}
