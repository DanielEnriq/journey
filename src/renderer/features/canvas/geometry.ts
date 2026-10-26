import { instanceKey, type Annotation, type CanvasRef, type Scene, type SceneNode } from '../../../shared/canvas/index.js';
import { inside, STAGE_H, STAGE_W } from '../room/geometry.js';
import type { Point } from '../room/types.js';

// The canvas engine's pure geometry: the camera, how a view is fitted into the free space, how a
// gesture in stage units resolves to what it touched (parts, copies, flow steps, strokes), and where
// someone you can't see waits on the edge. No DOM here, so all of it is unit-tested; CanvasSurface.tsx
// only feeds it pointer positions and sizes.

export type { Point };
export interface Cam { x: number; y: number; z: number }
export interface Size { w: number; h: number }
/** How a view sits in the surface: the fitted scale, the zoom it's drawn at, and its offset. */
export interface Frame { fit: number; z: number; ox: number; oy: number }

export const HOME: Cam = { x: 0, y: 0, z: 1 };
export const ZOOM_MIN = 0.35, ZOOM_MAX = 2.5;
/** The free space the design keeps: the tool rail on the left, the head above, the call below. */
export const RAIL = 64, RIGHT = 16, TOP = 52, BOTTOM = 84;
export const STEP_W = 220, STEP_H = 48;
/** How close the eraser has to pass to a stroke, in stage units. */
export const ERASE_R = 10;

export const clampZoom = (z: number) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));

/** Zooms about the centre of the view. */
export function zoomBy(cam: Cam, f: number): Cam {
  const z = clampZoom(cam.z * f), k = z / cam.z;
  return { x: cam.x * k, y: cam.y * k, z };
}

/** Fits a view's drawing (its viewBox) into the free space, as the design does. `reserve` is kept clear below (captions). */
export function frameOf(size: Size, viewBox: [number, number], cam: Cam, reserve = 0): Frame {
  const bottom = BOTTOM + reserve;
  const fit = size.w ? Math.max(0.5, Math.min(1.1, (size.w - RAIL - RIGHT - 24) / (viewBox[0] + 20), (size.h - TOP - bottom - 16) / (viewBox[1] + 10))) : 1;
  const z = cam.z * fit;
  const ox = (size.w ? (RAIL - RIGHT) / 2 : 0) + (STAGE_W - viewBox[0]) / 2 * z;
  const oy = (size.w ? (TOP - bottom) / 2 : 0) + (STAGE_H - viewBox[1]) / 2 * z;
  return { fit, z, ox, oy };
}

/** A point on the stage, in surface pixels. */
export function toScreen(size: Size, cam: Cam, f: Pick<Frame, 'z' | 'ox' | 'oy'>, x: number, y: number) {
  return { x: size.w / 2 + cam.x + f.ox + (x - STAGE_W / 2) * f.z, y: size.h / 2 + cam.y + f.oy + (y - STAGE_H / 2) * f.z };
}

/** ⌘-scroll: zooms about the pointer (`at`, surface pixels), keeping what's under it under it. */
export function wheelZoom(cam: Cam, off: { ox: number; oy: number }, at: { x: number; y: number }, size: Size, deltaY: number): Cam {
  const z = clampZoom(cam.z * Math.exp(-deltaY * 0.01)), r = z / cam.z;
  const cx = at.x - size.w / 2, cy = at.y - size.h / 2;
  return { x: cx - (cx - (cam.x + off.ox)) * r - off.ox, y: cy - (cy - (cam.y + off.oy)) * r - off.oy, z };
}

/** Moves the camera so a stage point is in the middle. */
export function centreOn(cam: Cam, f: Pick<Frame, 'z' | 'ox' | 'oy'>, at: { x: number; y: number }): Cam {
  return { x: -f.ox - (at.x - STAGE_W / 2) * f.z, y: -f.oy - (at.y - STAGE_H / 2) * f.z, z: cam.z };
}

/**
 * Someone whose cursor is off screen: where their tab waits on the edge (surface pixels) and the angle
 * its arrow points at them. Null when you can see them.
 */
export function edgeOf(size: Size, cam: Cam, f: Pick<Frame, 'z' | 'ox' | 'oy'>, at: { x: number; y: number }, reserve = 0): { x: number; y: number; a: number } | null {
  if (!size.w) return null;
  const p = toScreen(size, cam, f, at.x, at.y);
  const L0 = RAIL, R0 = size.w - RIGHT, T0 = 48, B0 = size.h - BOTTOM - reserve;
  if (p.x >= L0 && p.x <= R0 && p.y >= T0 && p.y <= B0) return null;
  const ex = Math.max(L0 + 6, Math.min(R0 - 74, p.x)), ey = Math.max(T0 + 6, Math.min(B0 - 30, p.y));
  return { x: Math.round(ex), y: Math.round(ey), a: Math.round(Math.atan2(p.y - (ey + 12), p.x - (ex + 40)) * 180 / Math.PI) };
}

/* ---------- What a gesture lands on. ---------- */

/** One thing a gesture can land on: a part (which copy of which component) or a flow step. */
export interface Target { key: string; ref: CanvasRef; short: string; x: number; y: number; w: number; h: number }

export const refKey = (r: CanvasRef) => 'step' in r ? `step:${r.view}:${r.step}` : instanceKey(r.component, r.instance);
export const nodeRef = (n: SceneNode): CanvasRef => n.instance > 1 ? { component: n.component, instance: n.instance } : { component: n.component };
export const isStep = (t: Target) => 'step' in t.ref;

export function targetsOf(scene: Scene | undefined): Target[] {
  if (!scene) return [];
  return [
    ...scene.nodes.map((n) => ({ key: n.key, ref: nodeRef(n), short: n.short, x: n.rect[0], y: n.rect[1], w: n.rect[2], h: n.rect[3] })),
    ...scene.steps.map((s) => ({ key: `step:${scene.view}:${s.id}`, ref: { step: s.id, view: scene.view, component: s.component }, short: s.short, x: s.x, y: s.y, w: STEP_W, h: STEP_H })),
  ];
}

/** What a circle drawn through `pts` is around: every part or step whose centre it encloses. */
export function circled(scene: Scene | undefined, pts: Point[]): { ref: CanvasRef; short: string }[] {
  return targetsOf(scene).filter((t) => inside([t.x + t.w / 2, t.y + t.h / 2], pts)).map(({ ref, short }) => ({ ref, short }));
}

/** The parts (never steps) a marquee dragged from `a` to `b` overlaps. */
export function marqueeHits(targets: Target[], a: Point, b: Point): CanvasRef[] {
  const x0 = Math.min(a[0], b[0]), y0 = Math.min(a[1], b[1]), x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
  return targets.filter((t) => !isStep(t) && t.x < x1 && t.x + t.w > x0 && t.y < y1 && t.y + t.h > y0).map((t) => t.ref);
}

/** The part (never a step) under a point, for the comment tool. */
export function partAt(targets: Target[], p: Point): { component: string; name: string } | null {
  const hit = targets.find((t) => !isStep(t) && p[0] >= t.x && p[0] <= t.x + t.w && p[1] >= t.y && p[1] <= t.y + t.h);
  return hit && !('step' in hit.ref) ? { component: hit.ref.component, name: hit.short } : null;
}

/** Where the "You circled" card sits: right of the circle, level with its top. */
export function askAt(pts: Point[]): { x: number; y: number } {
  return { x: Math.max(...pts.map((q) => q[0])) + 12, y: Math.min(...pts.map((q) => q[1])) };
}

/** Moves the marquee only once the pointer has really moved. */
export const moved = (a: Point, b: Point, slop = 5) => Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]) > slop;

/* ---------- The eraser. ---------- */

/** The points a pen path passes through (M/L, as toD writes them). */
export function pathPts(d: string): Point[] {
  const nums = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const out: Point[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) out.push([nums[i], nums[i + 1]]);
  return out;
}

/** Whether `p` is within `r` of the polyline through `pts`. */
export function nearPath(pts: Point[], p: Point, r: number): boolean {
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[i + 1] ?? a;
    const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
    if (Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)) <= r) return true;
  }
  return false;
}

type Mark = Exclude<Annotation, { kind: 'note' }>;

/** The strokes an eraser dragged from `a` to `b` passes over, sampled every 4 units, skipping `done`. */
export function erasedBy(marks: readonly Mark[], a: Point, b: Point, done: ReadonlySet<string> = new Set(), r = ERASE_R): string[] {
  const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 4));
  const out: string[] = [];
  for (const m of marks) {
    if (done.has(m.id)) continue;
    const pts = pathPts(m.d);
    for (let i = 0; i <= steps; i++) {
      const q: Point = [a[0] + (b[0] - a[0]) * i / steps, a[1] + (b[1] - a[1]) * i / steps];
      if (nearPath(pts, q, r)) { out.push(m.id); break; }
    }
  }
  return out;
}
