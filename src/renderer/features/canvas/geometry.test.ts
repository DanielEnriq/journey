import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { applyCommand, buildScene, command, emptyDocument, PAYMENT_SYSTEM, type Actor, type Annotation } from '../../../shared/canvas/index.js';
import { STAGE_H, STAGE_W } from '../room/geometry.js';
import {
  askAt, centreOn, circled, edgeOf, erasedBy, frameOf, HOME, marqueeHits, nearPath, partAt, pathPts, refKey, targetsOf, toScreen,
  wheelZoom, zoomBy, ZOOM_MAX, ZOOM_MIN, type Point,
} from './geometry.js';

// The canvas engine's geometry: camera, fitting, and what a gesture lands on, without a DOM.

const DAN: Actor = { kind: 'human', id: 'u-dan', name: 'Daniel' };
const doc = applyCommand(emptyDocument(), command('load_system', PAYMENT_SYSTEM, 'cmd-load-1'), DAN, '2026-10-24T12:00:00.000Z').doc;
const arch = buildScene(doc, 'architecture');
const conc = buildScene(applyCommand(doc, command('show_view', { view: 'concurrency', focus: 'payment-worker' }, 'cmd-conc-1'), DAN).doc, 'concurrency');
const size = { w: 1200, h: 800 };
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-6, `${a} ≈ ${b}`);

describe('the camera', () => {
  test('zoom stays within bounds and keeps the centre', () => {
    assert.deepEqual(zoomBy(HOME, 1.25), { x: 0, y: 0, z: 1.25 });
    assert.equal(zoomBy({ x: 0, y: 0, z: 2.4 }, 2).z, ZOOM_MAX);
    assert.equal(zoomBy({ x: 0, y: 0, z: 0.4 }, 0.5).z, ZOOM_MIN);
    assert.deepEqual(zoomBy({ x: 10, y: -20, z: 1 }, 2), { x: 20, y: -40, z: 2 });
  });

  test('a view is fitted into the free space and centred on the stage', () => {
    const f = frameOf(size, [980, 616], HOME);
    assert.ok(f.fit > 0.5 && f.fit <= 1.1);
    assert.equal(f.z, f.fit);
    assert.equal(frameOf({ w: 0, h: 0 }, [980, 616], HOME).fit, 1);
    // Keeping room for captions makes the drawing smaller, never bigger.
    assert.ok(frameOf(size, [980, 616], HOME, 58).fit <= f.fit);
  });

  test('⌘-scroll zooms about the pointer: what is under it stays under it', () => {
    const vb: [number, number] = [STAGE_W, STAGE_H], cam = { x: 30, y: -10, z: 1 }, f = frameOf(size, vb, cam);
    const stage = { x: 300, y: 200 }, at = toScreen(size, cam, f, stage.x, stage.y);
    const next = wheelZoom(cam, f, at, size, -40);
    assert.ok(next.z > 1);
    const again = toScreen(size, next, frameOf(size, vb, next), stage.x, stage.y);
    close(again.x, at.x); close(again.y, at.y);
  });

  test('centring on a point puts it in the middle of the surface', () => {
    const f = frameOf(size, [980, 616], HOME), cam = centreOn(HOME, f, { x: 700, y: 100 });
    const p = toScreen(size, cam, f, 700, 100);
    close(p.x, size.w / 2); close(p.y, size.h / 2);
  });

  test('someone off screen waits on the edge, pointing at them; someone visible does not', () => {
    const f = frameOf(size, [980, 616], HOME);
    assert.equal(edgeOf(size, HOME, f, { x: STAGE_W / 2, y: STAGE_H / 2 }), null);
    const e = edgeOf(size, HOME, f, { x: 5000, y: STAGE_H / 2 })!;
    assert.ok(e.x <= size.w - 16 - 74 && Math.abs(e.a) < 10, JSON.stringify(e));
  });
});

describe('what a gesture lands on', () => {
  test('targets are parts and copies by semantic ref; refKey keys them', () => {
    const t = targetsOf(conc);
    assert.deepEqual(t.filter((x) => !('step' in x.ref)).map((x) => refKey(x.ref)), ['retry-queue', 'payment-worker', 'payment-worker#2', 'payment-provider']);
    assert.equal(refKey({ step: 's1', view: 'failure-flow', component: 'payment-worker' }), 'step:failure-flow:s1');
  });

  test('a circle means what its centre-points enclose, including one copy of a component', () => {
    const w2 = conc.nodes.find((n) => n.key === 'payment-worker#2')!.rect;
    const ring: Point[] = Array.from({ length: 12 }, (_, i) => { const a = i / 12 * Math.PI * 2; return [w2[0] + w2[2] / 2 + Math.cos(a) * (w2[2] / 2 + 18), w2[1] + w2[3] / 2 + Math.sin(a) * (w2[3] / 2 + 18)]; });
    assert.deepEqual(circled(conc, ring).map((h) => h.ref), [{ component: 'payment-worker', instance: 2 }]);
    assert.deepEqual(askAt(ring), { x: Math.max(...ring.map((q) => q[0])) + 12, y: Math.min(...ring.map((q) => q[1])) });
  });

  test('a marquee selects the parts it overlaps; the comment tool finds the part under it', () => {
    const t = targetsOf(arch), n = arch.nodes[0];
    assert.deepEqual(marqueeHits(t, [n.rect[0] - 5, n.rect[1] - 5], [n.rect[0] + 10, n.rect[1] + 10]), [{ component: n.component }]);
    assert.deepEqual(partAt(t, [n.rect[0] + 3, n.rect[1] + 3]), { component: n.component, name: n.short });
    assert.equal(partAt(t, [-500, -500]), null);
  });
});

describe('the eraser', () => {
  const ink = (id: string, d: string, by = DAN): Extract<Annotation, { kind: 'ink' }> => ({ id, kind: 'ink', view: 'architecture', d, by, at: '' });
  test('reads a pen path and measures distance to it', () => {
    assert.deepEqual(pathPts('M10 20 L30.5 -4 Z'), [[10, 20], [30.5, -4]]);
    assert.ok(nearPath([[0, 0], [100, 0]], [50, 8], 10));
    assert.ok(!nearPath([[0, 0], [100, 0]], [50, 12], 10));
  });
  test('erases only the strokes a drag passes over, once each', () => {
    const marks = [ink('a', 'M0 0 L100 0'), ink('b', 'M0 100 L100 100')];
    assert.deepEqual(erasedBy(marks, [50, -40], [50, 40]), ['a']);
    assert.deepEqual(erasedBy(marks, [50, -40], [50, 140]), ['a', 'b']);
    assert.deepEqual(erasedBy(marks, [50, -40], [50, 140], new Set(['a'])), ['b']);
  });
});
