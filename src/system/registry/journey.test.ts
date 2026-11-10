import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { relationKey } from '../../shared/system/model.js';
import { validateRegistry } from '../../shared/system/registry-utils.js';
import { presetViews, resolveView } from '../../shared/system/view.js';
import { indexRepository } from '../indexer/index.js';
import { buildRegistry } from './index.js';

// The registry built from the Journey repository itself: the canvas subsystem must come out right — its
// parts, the draw command's path to the database and the save's retry loop, each step with evidence.
// Run from the repository root (or set JOURNEY_ROOT); skipped elsewhere. Indexing takes ~15s.

const root = process.env.JOURNEY_ROOT ?? process.cwd();
const here = existsSync(join(root, 'src/renderer/features/canvas/client.ts'));

test('Journey: the canvas subsystem, the draw path and the save-retry loop, with evidence', { skip: !here && 'not run from the Journey repository', timeout: 120_000 }, async () => {
  const reg = buildRegistry(await indexRepository(root));
  const E = reg.entities;
  const has = (from: string, kind: string, to: string) => assert.ok(reg.relations[relationKey(from, kind, to)], `${from} ${kind} ${to}`);
  assert.deepEqual(validateRegistry(reg).filter((d) => d.severity === 'error'), []);

  const canvas = {
    'component:canvas-surface': 'interface', 'component:canvas-client': 'client', 'component:canvas-ipc-transport': 'adapter',
    'component:main-canvas': 'service', 'component:supabase-canvas-hub': 'service', 'component:supabase-canvas-store': 'adapter', 'component:canvas-engine': 'engine',
  };
  for (const [id, kind] of Object.entries(canvas)) { assert.equal(E[id]?.kind, kind, id); assert.equal(E[id].parent, 'subsystem:canvas', id); }
  assert.equal(E['component:preload-bridge']?.kind, 'adapter');
  assert.equal(E['component:main-ipc']?.kind, 'service');
  assert.equal(E['component:supabase-database']?.kind, 'store');

  // Internals.
  assert.deepEqual(Object.values(E).filter((e) => e.kind === 'interaction' && e.parent === 'component:canvas-surface').map((e) => e.attrs.tool).sort(), ['circle', 'comment', 'draw', 'erase', 'pan', 'select']);
  assert.equal(E['interaction:canvas-surface/draw'].attrs.label, 'Draw');
  assert.equal(E['transport:canvas-transport']?.parent, 'component:canvas-client');
  assert.equal(E['state:canvas-client/queue']?.attrs.role, 'queue');
  assert.ok((E['method:canvas-client/run'].attrs.roles as string[]).includes('outgoing'));
  assert.ok((E['method:canvas-client/saved'].attrs.roles as string[]).includes('reconcile'));
  assert.equal(Object.values(E).filter((e) => e.kind === 'command' && e.parent === 'component:canvas-engine').length, 20);
  assert.ok(E['validator:canvas-engine/parse-command']);
  assert.equal(E['endpoint:canvas-execute']?.parent, 'component:main-ipc');
  for (const t of ['table:room-canvases', 'table:room-canvas-ops', 'store-function:commit-canvas']) assert.equal(E[t]?.parent, 'component:supabase-database', t);

  // Relations.
  has('interaction:canvas-surface/draw', 'produces', 'command:canvas-engine/draw');
  has('component:canvas-ipc-transport', 'implements', 'transport:canvas-transport');
  has('component:supabase-canvas-store', 'implements', 'transport:canvas-store');
  has('method:preload-bridge/canvas.execute', 'sends', 'endpoint:canvas-execute');
  has('component:preload-bridge', 'sends', 'component:main-ipc');
  has('endpoint:canvas-execute', 'handles', 'function:main-canvas/execute-as-person');
  has('store-function:commit-canvas', 'writes', 'table:room-canvases');
  has('store-function:commit-canvas', 'writes', 'table:room-canvas-ops');
  has('component:supabase-canvas-store', 'reads', 'component:supabase-database');

  // The draw command's path, gesture to SQL.
  const path = reg.sequences['sequence:command-path:draw'];
  assert.ok(path);
  const order = ['interaction:canvas-surface/draw', 'component:canvas-surface', 'method:canvas-client/run', 'method:canvas-transport.execute', 'method:canvas-ipc-transport/execute',
    'endpoint:canvas-execute', 'function:main-canvas/execute-as-person', 'method:supabase-canvas-hub/execute', 'function:canvas-engine/execute', 'validator:canvas-engine/parse-command',
    'function:canvas-engine/apply-command', 'command:canvas-engine/draw', 'method:canvas-store.commit', 'method:supabase-canvas-store/commit', 'store-function:commit-canvas', 'table:room-canvases'];
  const at = order.map((id) => path.steps.findIndex((s) => s.entity === id));
  assert.ok(at.every((i) => i >= 0), `missing: ${order.filter((_, i) => at[i] < 0).join(', ')}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'in order');
  assert.ok(path.steps.some((s) => s.entity.startsWith('method:preload-bridge/') && s.label.includes('j.canvas.execute')));
  for (const s of path.steps) assert.ok(s.evidence.length && s.evidence.every((id) => reg.evidence[id]), s.id);

  // The save's retry loop.
  const retry = reg.sequences['sequence:save-retry'];
  assert.ok(retry);
  const commit = retry.steps.find((s) => s.entity === 'method:canvas-store.commit')!;
  assert.ok(commit.ctx?.includes('loop'));
  assert.equal(commit.guard, 'for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++)');
  const branch = retry.steps.find((s) => (s.next?.length ?? 0) === 2 && s.next!.some((n) => retry.steps.find((x) => x.id === n)?.label.startsWith('saved')))!;
  const reload = retry.steps.find((s) => s.id === branch.next!.find((n) => !retry.steps.find((x) => x.id === n)!.label.startsWith('saved')))!;
  assert.equal(reload.entity, 'method:canvas-store.load');
  const apply = retry.steps.find((s) => s.entity === 'function:canvas-engine/apply-command')!;
  assert.ok(reload.next?.includes(apply.id), 'reload goes round to apply again');
  assert.ok(retry.notes?.some((n) => n.includes('MAX_ATTEMPTS = 5')));
  for (const s of retry.steps) assert.ok(s.evidence.length, s.id);

  // Presets, chosen by queries, land on the canvas subsystem.
  const presets = presetViews(reg);
  assert.ok(presets.find((p) => p.lens === 'organization')?.focus.includes('component:canvas-client'));
  assert.equal(presets.find((p) => p.lens === 'path')?.sequence, 'sequence:command-path:draw');
  assert.equal(presets.find((p) => p.lens === 'failure')?.sequence, 'sequence:save-retry');
  assert.equal(presets.find((p) => p.lens === 'interface-change')?.enter, 'component:canvas-surface');
  for (const p of presets) assert.deepEqual(resolveView(reg, p).missing, [], p.id);
});
