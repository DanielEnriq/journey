import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fit, lerpCamera, lodFor, matchFrame, panBy, reveal, toScreen, toStage, zoomAt } from './camera.js';
import { spatial, tabOrder } from './nav.js';
import { buildScene } from '../../../shared/system/render/index.js';
import { emptyState, request, resolveAll, testRegistry } from '../../../shared/system/render/test-registry.js';

const v = { w: 1000, h: 800 };

test('screen and stage convert both ways', () => {
  const c = { x: 100, y: 50, z: 2 };
  const p = { x: 130, y: 70 };
  assert.deepEqual(toStage(c, v, toScreen(c, v, p)), p);
  assert.deepEqual(toScreen(c, v, { x: 100, y: 50 }), { x: 500, y: 400 });
});

test('zooming keeps the point under the cursor still', () => {
  const c = { x: 0, y: 0, z: 1 };
  const at = { x: 800, y: 200 };
  const before = toStage(c, v, at);
  const z = zoomAt(c, v, 1.5, at);
  const after = toStage(z, v, at);
  assert.ok(Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9);
  assert.equal(zoomAt(c, v, 100, at).z, 3); // clamped
});

test('fit shows the whole rect, pan moves by screen pixels, reveal moves only as needed', () => {
  const f = fit({ x: 0, y: 0, w: 2000, h: 400 }, v, 0);
  assert.equal(f.z, 0.5);
  assert.deepEqual([f.x, f.y], [1000, 200]);
  assert.deepEqual(panBy({ x: 0, y: 0, z: 2 }, 100, 0), { x: -50, y: 0, z: 2 });
  const c = { x: 0, y: 0, z: 1 };
  assert.deepEqual(reveal(c, v, { x: -10, y: -10, w: 20, h: 20 }), c);
  const r = reveal(c, v, { x: 600, y: 0, w: 100, h: 50 }, 50);
  assert.equal(r.x, 600 + 100 - (1000 / 2 - 50));
});

test('camera interpolation ends exactly at the target, and lod switches at the near zoom', () => {
  const a = { x: 0, y: 0, z: 0.2 }, b = { x: 100, y: 40, z: 2 };
  assert.deepEqual(lerpCamera(a, b, 1), b);
  assert.deepEqual(lerpCamera(a, b, 0), a);
  assert.equal(lodFor(0.3), 'far');
  assert.equal(lodFor(1), 'near');
});

test('matchFrame puts the entered frame exactly where the component was on screen', () => {
  const cam = { x: 0, y: 0, z: 0.5 };
  const node = { x: 100, y: 100, w: 300, h: 200 };
  const frame = { x: -50, y: -80, w: 1200, h: 800 };
  const m = matchFrame(cam, v, node, frame);
  const a = toScreen(cam, v, { x: node.x, y: node.y });
  const b = toScreen(m, v, { x: frame.x, y: frame.y });
  assert.ok(Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6);
  assert.ok(Math.abs(node.w * cam.z - frame.w * m.z) < 1e-6);
});

test('keyboard order follows the reading order and arrows move spatially', () => {
  const reg = testRegistry();
  const s = buildScene(reg, resolveAll(reg, request('organization')), emptyState(), {});
  const first = tabOrder(s, null)!;
  assert.equal(first, s.outline[0].id);
  const second = tabOrder(s, first)!;
  assert.equal(tabOrder(s, second, true), first);
  // From the surface (top-left), moving right never lands on something to its left.
  const surface = s.nodes.find((n) => n.id === 'component:surface')!;
  const right = spatial(s, surface.id, 'right')!;
  const rn = s.nodes.find((n) => n.id === right)!;
  assert.ok(rn.rect.x + rn.rect.w / 2 > surface.rect.x + surface.rect.w / 2);
  assert.equal(spatial(s, surface.id, 'left'), null);
});
