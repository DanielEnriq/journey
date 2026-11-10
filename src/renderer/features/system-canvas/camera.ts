import type { Point, Rect } from '../../../shared/system/render/scene.js';

// Camera math for the system canvas, kept pure so it can be tested: a camera is the stage point at the
// centre of the viewport and a zoom. Screen = (stage − centre) × zoom + viewport / 2.

export interface Camera { x: number; y: number; z: number }
export interface Viewport { w: number; h: number }

export const MIN_ZOOM = 0.12;
export const MAX_ZOOM = 3;
/** Detail by zoom: below MID a component is its silhouette and its name; from MID its head and the words on
 *  its relations read; from NEAR the labels of its parts. Nothing depends on an exact zoom: Enter shows it all. */
export const MID_ZOOM = 0.42;
export const NEAR_ZOOM = 0.8;

export const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

export function toScreen(c: Camera, v: Viewport, p: Point): Point {
  return { x: (p.x - c.x) * c.z + v.w / 2, y: (p.y - c.y) * c.z + v.h / 2 };
}

export function toStage(c: Camera, v: Viewport, p: Point): Point {
  return { x: (p.x - v.w / 2) / c.z + c.x, y: (p.y - v.h / 2) / c.z + c.y };
}

/** The camera that shows `r` whole inside the viewport, less a margin in screen px. Never zooms past `max`. */
export function fit(r: Rect, v: Viewport, margin = 48, max = 1.25): Camera {
  const w = Math.max(1, v.w - margin * 2), h = Math.max(1, v.h - margin * 2);
  const z = clampZoom(Math.min(max, w / Math.max(1, r.w), h / Math.max(1, r.h)));
  return { x: r.x + r.w / 2, y: r.y + r.h / 2, z };
}

/** Zooms by `factor`, keeping the stage point under `at` (screen) where it is. */
export function zoomAt(c: Camera, v: Viewport, factor: number, at: Point): Camera {
  const z = clampZoom(c.z * factor);
  const p = toStage(c, v, at);
  return { x: p.x - (at.x - v.w / 2) / z, y: p.y - (at.y - v.h / 2) / z, z };
}

export function panBy(c: Camera, dx: number, dy: number): Camera {
  return { x: c.x - dx / c.z, y: c.y - dy / c.z, z: c.z };
}

/** Moves the camera just enough to bring `r` into view (with a margin); keeps zoom unless it can't fit. */
export function reveal(c: Camera, v: Viewport, r: Rect, margin = 64): Camera {
  const vw = (v.w - margin * 2) / c.z, vh = (v.h - margin * 2) / c.z;
  if (r.w > vw || r.h > vh) return { ...fit(r, v, margin, c.z), z: Math.min(c.z, fit(r, v, margin).z) };
  let { x, y } = c;
  const left = x - vw / 2, right = x + vw / 2, top = y - vh / 2, bottom = y + vh / 2;
  if (r.x < left) x -= left - r.x; else if (r.x + r.w > right) x += r.x + r.w - right;
  if (r.y < top) y -= top - r.y; else if (r.y + r.h > bottom) y += r.y + r.h - bottom;
  return { x, y, z: c.z };
}

/** Interpolates two cameras; zoom moves in log space so a zoom-in feels even. t in 0..1. */
export function lerpCamera(a: Camera, b: Camera, t: number): Camera {
  if (t >= 1) return { ...b };
  if (t <= 0) return { ...a };
  const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  return { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e, z: Math.exp(Math.log(a.z) + (Math.log(b.z) - Math.log(a.z)) * e) };
}

/** The camera at which `inner` (a node at the outer level) appears exactly where `frame` appears under `cam`. */
export function matchFrame(cam: Camera, v: Viewport, from: Rect, to: Rect): Camera {
  // `from` on screen under cam:
  const s = toScreen(cam, v, { x: from.x, y: from.y });
  const sw = from.w * cam.z;
  const z = clampZoom(sw / Math.max(1, to.w));
  // Choose the centre so `to`'s top-left lands on `s`.
  return { x: to.x - (s.x - v.w / 2) / z, y: to.y - (s.y - v.h / 2) / z, z };
}

export const lodFor = (z: number): 'far' | 'mid' | 'near' => (z < MID_ZOOM ? 'far' : z < NEAR_ZOOM ? 'mid' : 'near');
