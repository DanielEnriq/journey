import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relationKey, type Entity, type Relation, type SystemRegistry } from '../model.js';
import { buildScene, formFor, levelKey, type SystemScene } from './index.js';
import { rankNodes } from './layout.js';
import { emptyState, request, resolveAll, testRegistry } from './test-registry.js';

const scene = (reg: SystemRegistry, lens: Parameters<typeof request>[0] = 'organization', over: Parameters<typeof request>[1] = {}, state = emptyState(), inputs = {}) =>
  buildScene(reg, resolveAll(reg, request(lens, over)), state, inputs);

const node = (s: SystemScene, id: string) => s.nodes.find((n) => n.id === id);

test('same inputs give an identical scene', () => {
  const a = scene(testRegistry());
  const b = scene(testRegistry());
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  // Key order of the registry must not matter either.
  const r = testRegistry();
  const shuffled = { ...r, entities: Object.fromEntries(Object.entries(r.entities).reverse()), relations: Object.fromEntries(Object.entries(r.relations).reverse()) };
  assert.equal(JSON.stringify(scene(shuffled)), JSON.stringify(a));
});

test('the top level shows components, flattens the subsystem into a group, and nests elements as parts', () => {
  const s = scene(testRegistry());
  const ids = s.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ['component:bridge', 'component:client', 'component:engine', 'component:execute', 'component:hub', 'component:ipc', 'component:surface', 'store:db']);
  assert.equal(s.groups[0]?.id, 'subsystem:canvas');
  const client = node(s, 'component:client')!;
  assert.equal(client.form, 'client');
  assert.ok(client.parts.some((p) => p.entity === 'method:client-run'));
  // A store shows its tables, and who writes them.
  const db = node(s, 'store:db')!;
  const table = db.parts.find((p) => p.entity === 'table:room-canvases')!;
  assert.equal(table.role, 'table');
  assert.match(table.note ?? '', /written by execute/);
});

test('identity holds across levels: a part inside a component is the node you land on when entering it', () => {
  const reg = testRegistry();
  const top = scene(reg);
  const partIds = node(top, 'component:client')!.parts.filter((p) => p.entity).map((p) => p.entity).sort();
  const inside = scene(reg, 'organization', {}, { ...emptyState(), entered: ['component:client'] });
  assert.deepEqual(inside.nodes.map((n) => n.id).sort(), partIds);
  assert.equal(inside.level.root, 'component:client');
  assert.ok(inside.level.frame);
});

test('entering keeps the arrangement the parts had, and neighbours become portals in their direction', () => {
  const reg = testRegistry();
  const top = scene(reg);
  const client = node(top, 'component:client')!;
  const inside = scene(reg, 'organization', {}, { ...emptyState(), entered: ['component:client'] });
  // Parts in the same column inside the component stay in the same column once entered.
  const run = client.parts.find((p) => p.entity === 'method:client-run')!;
  const sameCol = client.parts.filter((p) => p.entity && p.rect.x === run.rect.x).map((p) => p.entity!);
  const xs = new Set(sameCol.map((id) => node(inside, id)!.rect.x));
  assert.equal(xs.size, 1);
  // The surface sits left of the client at the top; inside, its portal is on the left edge.
  const surface = inside.portals.find((p) => p.id === 'component:surface')!;
  assert.ok(surface, 'surface portal');
  assert.equal(surface.side, 'left');
  const bridge = inside.portals.find((p) => p.id === 'component:bridge')!;
  assert.notEqual(bridge.side, 'left');
  // Finer relations are drawn between the children, and to the portals.
  assert.ok(inside.edges.some((e) => e.from === 'component:surface' && e.to === 'method:client-run' && e.portal === 'from'));
  assert.ok(inside.edges.some((e) => e.from === 'method:client-run' && e.to === 'state:client-queue' && e.kind === 'writes'));
});

test('relations roll up at the top level and say what they stand for', () => {
  const s = scene(testRegistry());
  const e = s.edges.find((x) => x.from === 'component:execute' && x.to === 'store:db' && x.kind === 'writes')!;
  assert.ok(e);
  assert.deepEqual(e.relations, [relationKey('function:execute', 'writes', 'table:room-canvases')]);
  // A write lands on the table it writes, not the store's middle.
  assert.equal(e.parts[1], 'table:room-canvases');
  // The inferred event keeps its provenance.
  const ev = s.edges.find((x) => x.kind === 'publishes')!;
  assert.equal(ev.provenance, 'inferred');
  // Sends across runtime zones are marked where they cross.
  const send = s.edges.find((x) => x.from === 'component:client' && x.kind === 'sends')!;
  assert.ok(send.crossings.length > 0);
});

test('layout memory keeps placed ids still when new entities appear; new ones go into free space', () => {
  const reg = testRegistry();
  const first = scene(reg);
  const memory = { [levelKey([])]: first.placed };
  const grown: SystemRegistry = structuredClone(reg);
  const add = (e: Entity) => (grown.entities[e.id] = e);
  add({ id: 'component:presence', kind: 'service', name: 'Presence', parent: 'subsystem:canvas', level: 'component', anchors: [{ file: 'src/main/presence.ts' }], attrs: {}, provenance: 'code', evidence: [], status: 'current' });
  const r: Relation = { id: relationKey('component:client', 'calls', 'component:presence'), kind: 'calls', from: 'component:client', to: 'component:presence', provenance: 'code', evidence: [], status: 'current' };
  grown.relations[r.id] = r;
  const second = scene(grown, 'organization', {}, emptyState(), { layoutMemory: memory });
  for (const [id, p] of Object.entries(first.placed)) assert.deepEqual(second.placed[id], p, `${id} stayed`);
  const fresh = node(second, 'component:presence')!;
  assert.equal(fresh.placed, 'layout');
  for (const n of second.nodes) if (n.id !== fresh.id) assert.ok(!overlap(n.rect, fresh.rect), `presence clear of ${n.id}`);
});

test('a pinned position wins over layout and memory', () => {
  const reg = testRegistry();
  const first = scene(reg);
  const state = { ...emptyState(), pinned: { '': { 'component:hub': [5000, 40] as [number, number] } } };
  const s = scene(reg, 'organization', {}, state, { layoutMemory: { '': first.placed } });
  const hub = node(s, 'component:hub')!;
  assert.deepEqual([hub.rect.x, hub.rect.y], [5000, 40]);
  assert.equal(hub.placed, 'pinned');
});

test('an unknown kind gets the honest form with its kind written', () => {
  const reg = testRegistry();
  reg.entities['x:thing'] = { id: 'x:thing', kind: 'flux-capacitor', name: 'Flux', level: 'component', anchors: [], attrs: {}, provenance: 'interpretation', evidence: [], status: 'current' };
  const s = scene(reg);
  const n = node(s, 'x:thing')!;
  assert.equal(n.form, 'unknown');
  assert.equal(n.kindLabel, 'flux-capacitor');
  assert.equal(formFor('store'), 'store');
  assert.ok(s.legend.forms.some((f) => f.form === 'unknown' && f.kinds.includes('flux-capacitor')));
});

test('cycles are ranked without looping forever, and the returning edge is routed as a return', () => {
  const { rank, back } = rankNodes(['a', 'b', 'c'], [{ from: 'a', to: 'b', weight: 1 }, { from: 'b', to: 'c', weight: 1 }, { from: 'c', to: 'a', weight: 1 }]);
  assert.deepEqual([rank.a, rank.b, rank.c], [0, 1, 2]);
  assert.ok(back.has('c>a'));
  const reg = testRegistry();
  const r: Relation = { id: relationKey('store:db', 'calls', 'component:surface'), kind: 'calls', from: 'store:db', to: 'component:surface', provenance: 'code', evidence: [], status: 'current' };
  reg.relations[r.id] = r;
  const s = scene(reg);
  // Somewhere the cycle closes, and that edge is drawn as a return rather than through the nodes.
  const returns = s.edges.filter((x) => x.back);
  assert.ok(returns.length >= 1);
  for (const e of returns) assert.ok(e.points.length >= 4);
});

test('dangling relations become stubs: outside the view, or not indexed', () => {
  const reg = testRegistry();
  const r: Relation = { id: relationKey('component:hub', 'calls', 'ghost:nowhere'), kind: 'calls', from: 'component:hub', to: 'ghost:nowhere', provenance: 'code', evidence: [], status: 'current' };
  reg.relations[r.id] = r;
  const req = request('organization');
  const resolved = resolveAll(reg, req);
  resolved.entities = resolved.entities.filter((id) => !id.startsWith('store:') && !id.startsWith('table:') && !id.startsWith('fn:'));
  const s = buildScene(reg, resolved, emptyState(), {});
  assert.ok(s.stubs.some((x) => x.node === 'component:hub' && x.reason === 'not-indexed'));
  assert.ok(s.stubs.some((x) => x.node === 'component:execute' && x.reason === 'outside-view' && x.others.includes('table:room-canvases')));
});

test('requested ids the registry lacks are drawn as ghosts, not dropped', () => {
  const reg = testRegistry();
  const resolved = { ...resolveAll(reg, request('organization')), missing: ['component:gone'] };
  const s = buildScene(reg, resolved, emptyState(), {});
  const g = node(s, 'component:gone')!;
  assert.equal(g.ghost, true);
  assert.equal(g.status, 'missing');
});

test('a path is placed on the entities its steps belong to, with its loop drawn as a loop and its claim said', () => {
  const s = scene(testRegistry(), 'path', { sequence: 'seq:draw' });
  const seq = s.sequence!;
  assert.match(seq.claim, /Possible path, derived from code/);
  assert.equal(seq.steps.find((x) => x.id === 's2')!.on, 'component:client');
  assert.equal(seq.steps.find((x) => x.id === 's2')!.part, 'method:client-run');
  const loop = seq.segments.find((x) => x.kind === 'loop')!;
  assert.deepEqual([loop.from, loop.to], ['s6', 's5']);
  assert.equal(loop.guard, 'revision === null');
  assert.ok(seq.segments.some((x) => x.kind === 'branch' && x.to === 's7'));
  // Off-path parts recede; on-path parts lead.
  assert.equal(node(s, 'component:client')!.emphasis, 'primary');
  // The path's order drives the flow: the surface is ranked before the store.
  assert.ok(node(s, 'component:surface')!.rect.x < node(s, 'store:db')!.rect.x);
});

test('a recorded trace is drawn as observed, with where and when', () => {
  const reg = testRegistry();
  const s = scene(reg, 'path', {}, emptyState(), {
    trace: { schema: 'vowe.trace/1', id: 't1', title: 'Conflict', recorded: { at: '2026-11-10T10:00:00Z', where: 'dev harness, in-memory store', by: 'host' }, events: [{ at: 0, entity: 'function:execute', label: 'load' }, { at: 3, entity: 'table:room-canvases', label: 'commit → null' }] },
  });
  assert.equal(s.sequence!.kind, 'trace');
  assert.match(s.sequence!.claim, /Observed — recorded dev harness, in-memory store, 2026-11-10T10:00:00Z/);
  assert.equal(s.sequence!.steps[1].time, 3);
});

test('stale, new and changed are carried as status, and change-review marks affected parts', () => {
  const reg = testRegistry();
  const s = scene(reg, 'change-review', { changed: ['src/shared/canvas/store.ts'] }, emptyState(), {
    stale: ['component:hub'], diff: { from: 'a', to: 'b', entities: { added: ['component:bridge'], removed: [], changed: ['component:engine'] }, relations: { added: [], removed: [], changed: [] } },
  });
  assert.equal(node(s, 'component:hub')!.status, 'stale');
  assert.equal(node(s, 'component:bridge')!.status, 'new');
  assert.equal(node(s, 'component:engine')!.status, 'changed');
  assert.equal(node(s, 'component:execute')!.affected, true);
  assert.equal(node(s, 'component:execute')!.emphasis, 'primary');
  assert.equal(node(s, 'component:surface')!.emphasis, 'dim');
  assert.deepEqual(s.legend.status.sort(), ['changed', 'current', 'new', 'stale']);
});

test('proposed entities from the view are drawn proposed', () => {
  const reg = testRegistry();
  const req = request('organization', { proposals: { entities: [{ id: 'component:cache', kind: 'store', name: 'Canvas cache', level: 'component', anchors: [], attrs: {}, provenance: 'proposed', evidence: [], status: 'new' }] } });
  const resolved = resolveAll(reg, req);
  resolved.entities.push('component:cache');
  const s = buildScene(reg, resolved, emptyState(), {});
  assert.equal(node(s, 'component:cache')!.provenance, 'proposed');
});

test('a 300-entity system stays within the cap, bounded, overlap-free and fast', () => {
  const reg = synthetic(300);
  const t0 = performance.now();
  const s = scene(reg);
  const ms = performance.now() - t0;
  assert.ok(s.nodes.length <= 36, `${s.nodes.length} nodes`);
  const hidden = s.overflow.reduce((n, o) => n + o.hidden.length, 0);
  assert.equal(s.nodes.length + hidden, 60);
  assert.ok(s.bounds.w < 20000 && s.bounds.h < 20000, JSON.stringify(s.bounds));
  for (let i = 0; i < s.nodes.length; i++) for (let j = i + 1; j < s.nodes.length; j++) assert.ok(!overlap(s.nodes[i].rect, s.nodes[j].rect), `${s.nodes[i].id} × ${s.nodes[j].id}`);
  assert.ok(ms < 1500, `${ms.toFixed(0)}ms`);
  // Entering one of them still works and stays deterministic.
  const st = { ...emptyState(), entered: [s.nodes[0].id] };
  assert.equal(JSON.stringify(scene(reg, 'organization', {}, st)), JSON.stringify(scene(reg, 'organization', {}, st)));
});

function overlap(a: { x: number; y: number; w: number; h: number }, b: typeof a) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** 60 components of mixed kinds, 4 children each, chained and cross-linked deterministically. */
function synthetic(n: number): SystemRegistry {
  const base = testRegistry();
  const reg: SystemRegistry = { ...base, entities: {}, relations: {}, sequences: {} };
  const kinds = ['service', 'store', 'queue', 'worker', 'client', 'engine', 'interface', 'external', 'event-channel', 'module'];
  const zones = ['src/renderer/', 'src/main/', 'src/shared/', 'supabase/'];
  const comps = n / 5;
  const add = (e: Entity) => (reg.entities[e.id] = e);
  const rel = (from: string, kind: string, to: string) => { const id = relationKey(from, kind, to); reg.relations[id] = { id, kind, from, to, provenance: 'code', evidence: [], status: 'current' }; };
  for (let i = 0; i < comps; i++) {
    const id = `c${String(i).padStart(3, '0')}`;
    add({ id, kind: kinds[i % kinds.length], name: `Component ${i}`, level: 'component', anchors: [{ file: `${zones[i % 4]}c${i}.ts` }], attrs: {}, provenance: 'code', evidence: [], status: 'current' });
    for (let k = 0; k < 4; k++) add({ id: `${id}.e${k}`, kind: k % 2 ? 'function' : 'state', name: `part ${k}`, parent: id, level: 'element', anchors: [], attrs: {}, provenance: 'code', evidence: [], status: 'current' });
    if (i > 0) rel(`c${String(i - 1).padStart(3, '0')}.e1`, 'calls', `${id}.e0`);
    if (i % 7 === 3) rel(`${id}.e3`, 'writes', `c${String((i * 3) % comps).padStart(3, '0')}.e2`);
  }
  return reg;
}

test('a distant form says what it holds by count, and every part it draws is real content', () => {
  const s = scene(testRegistry());
  const engine = node(s, 'component:engine')!;
  const commands = engine.parts.find((p) => p.role === 'compartment:commands')!;
  assert.equal(commands.count, 3);
  // Every chip names a real child or an attr value; nothing anonymous.
  for (const n of s.nodes) for (const p of n.parts) if (!p.role.startsWith('compartment:') && !['slot', 'plug', 'boundary', 'bus', 'more'].includes(p.role)) assert.ok(p.label, `${n.id} ${p.key}`);
});

test('entering an interface lays its interactions out as a rail in declared order, with key hints and what they produce', () => {
  const reg = testRegistry();
  const s = scene(reg, 'organization', {}, { ...emptyState(), entered: ['component:surface'] });
  const order = ['select', 'pan', 'circle', 'draw', 'erase', 'comment'].map((t) => node(s, `interaction:tool-${t}`)!);
  for (let i = 1; i < order.length; i++) {
    assert.equal(order[i].rect.x, order[0].rect.x, 'one column');
    assert.ok(order[i].rect.y > order[i - 1].rect.y, 'declared order');
  }
  assert.equal(order[3].parts.find((p) => p.role === 'key')?.label, 'P');
  const prod = s.edges.find((e) => e.kind === 'produces' && e.from === 'interaction:tool-draw')!;
  assert.equal(prod.to, 'component:engine');
  assert.equal(prod.portal, 'to');
  assert.equal(prod.label, 'draw');
  assert.ok(s.regions.some((r) => r.label === 'interaction regions'));
});

test('a retry is drawn as one loop with its guard said once, its branch outcomes named, and its stations in order', () => {
  const s = scene(testRegistry(), 'failure', { sequence: 'seq:retry' });
  const seq = s.sequence!;
  const guards = seq.segments.filter((g) => g.guard);
  assert.equal(guards.length, 1);
  assert.match(guards[0].guard!, /attempt < MAX_ATTEMPTS · ≤ MAX_ATTEMPTS = 5/);
  assert.equal(guards[0].kind, 'loop');
  assert.ok(guards[0].failing);
  const outcomes = seq.segments.filter((g) => g.kind === 'branch').map((g) => g.outcome);
  assert.ok(outcomes.includes('saved: returns the new revision'));
  assert.ok(seq.segments.some((g) => g.outcome === 'failure(…): busy' && g.failing));
  // Several steps on the engine sit in a lane, in order, never on top of one another.
  const onEngine = seq.steps.filter((x) => x.on === 'component:engine');
  assert.ok(onEngine.length >= 3);
  const xs = onEngine.map((x) => x.at.x);
  assert.deepEqual([...xs].sort((a, b) => a - b), xs);
  assert.equal(new Set(seq.steps.map((x) => `${x.at.x},${x.at.y}`)).size, seq.steps.length);
});

test('compartments name what the view touches first and count the rest', () => {
  const s = scene(testRegistry());
  const tables = node(s, 'store:db')!.parts.find((p) => p.role === 'compartment:tables')!;
  // room_canvases is written by a part in view; room_canvas_ops only by the store's own function.
  assert.deepEqual(tables.named, ['room_canvases']);
  assert.equal(tables.count, 2);
  const path = scene(testRegistry(), 'path', { sequence: 'seq:retry' });
  const commands = node(path, 'component:engine')!.parts.find((p) => p.role === 'compartment:commands')!;
  assert.equal(commands.named?.[0], 'draw');
});

test('entering a busy database keeps the tables the view reaches, ranked as its casing ranked them', () => {
  // Regression: entering ranked internals by raw degree only, so busy tables unrelated to the view
  // pushed out the ones the canvas writes (and the ops table its commit function fills).
  const reg = testRegistry();
  const rel = (from: string, kind: string, to: string): Relation => ({ id: relationKey(from, kind, to), kind, from, to, provenance: 'code', evidence: [], status: 'current' });
  const busy = Array.from({ length: 8 }, (_, i) => `table:busy-${i}`);
  for (const id of busy) reg.entities[id] = { id, kind: 'table', name: id.slice(6), level: 'element', parent: 'store:db', anchors: [], attrs: {}, provenance: 'code', evidence: [], status: 'current' };
  for (const a of busy) for (const b of busy) if (a < b) { const r = rel(a, 'reads', b); reg.relations[r.id] = r; }
  const calls = rel('function:execute', 'calls', 'fn:commit-canvas');
  reg.relations[calls.id] = calls;
  const inside = scene(reg, 'organization', {}, { ...emptyState(), entered: ['store:db'] }, { maxNodes: 4 });
  const ids = inside.nodes.map((n) => n.id);
  for (const id of ['table:room-canvases', 'fn:commit-canvas', 'table:room-canvas-ops']) assert.ok(ids.includes(id), `${id} in ${ids.join(', ')}`);
  // And the casing, from outside, lists the same ones first.
  const db = node(scene(reg), 'store:db')!;
  const first = db.parts.map((p) => p.entity).filter((id) => id?.startsWith('table:'))[0];
  assert.equal(first, 'table:room-canvases');
});
