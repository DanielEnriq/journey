import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { indexRepository } from './index.js';

// Smoke test on the Journey repository itself: a few facts that must hold for the system canvas to work.
// Run from the repository root (or set JOURNEY_ROOT); skipped elsewhere.

const root = process.env.JOURNEY_ROOT ?? process.cwd();
const here = existsSync(join(root, 'src/renderer/features/canvas/client.ts'));

test('indexes Journey with the facts the canvas relies on', { skip: !here && 'not run from the Journey repository' }, async () => {
  const t0 = Date.now();
  const ix = await indexRepository(root);
  const ms = Date.now() - t0;
  const client = 'src/renderer/features/canvas/client.ts';
  assert.ok(
    ix.references.some((r) => r.from === `${client}#CanvasClient.run` && r.to === `${client}#CanvasTransport.execute` && r.kind === 'call'),
    'CanvasClient.run calls CanvasTransport.execute',
  );
  assert.ok(ix.literals.some((l) => l.literal === 'commit_canvas' && l.method === 'rpc' && l.in.startsWith('src/integrations/supabase/canvas.ts#')));
  assert.ok(ix.literals.some((l) => l.literal === 'canvas:execute' && l.file === 'src/main/ipc.ts'));
  assert.ok(ix.comparisons.some((c) => c.file === 'src/renderer/features/canvas/CanvasSurface.tsx' && c.subject === 'tool' && c.literal === 'draw'));
  const table = ix.symbols.find((s) => s.id === 'supabase/migrations/20261028000000_room_canvas.sql#public.room_canvases');
  assert.equal(table?.kind, 'sql-table');
  assert.ok((table?.attrs?.columns as string[]).includes('revision'));
  const commit = ix.symbols.find((s) => s.kind === 'sql-function' && s.name === 'commit_canvas')!;
  assert.ok(ix.references.some((r) => r.from === commit.id && r.kind === 'sql-write' && r.to === table!.id));
  assert.deepEqual(ix.symbols.find((s) => s.id === 'src/renderer/features/canvas/CanvasSurface.tsx#Tool')?.attrs?.members, ['select', 'pan', 'circle', 'draw', 'erase', 'comment']);
  assert.equal(ix.symbols.find((s) => s.id === 'src/shared/canvas/store.ts#MAX_ATTEMPTS')?.attrs?.value, 5);
  const store = ix.flows.find((f) => f.symbol === 'src/shared/canvas/store.ts#execute');
  assert.ok(store?.steps.some((s) => s.calleeSymbol?.endsWith('#CanvasStore.commit') && s.ctx.includes('loop')));
  assert.equal(ix.incomplete, false);
  console.log(`journey: ${ix.files.length} files, ${ix.symbols.length} symbols, ${ix.references.length} references, ${ix.literals.length} literals, ${ix.comparisons.length} comparisons, ${ix.flows.length} flows in ${ms}ms`);
});
