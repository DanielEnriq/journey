import type { Rect, SystemScene } from '../../../shared/system/render/scene.js';

// Keyboard order and spatial moves between what's on the canvas. Tab follows the scene's reading order
// (zone, then along the flow); arrows go to the nearest thing in that direction, so the keyboard moves
// the way the eye does.

export type Dir = 'left' | 'right' | 'up' | 'down';

export interface Target { id: string; rect: Rect }

/** Everything selectable on a level, in reading order: nodes, then portals. */
export function targets(scene: SystemScene): Target[] {
  const byId = new Map(scene.nodes.map((n) => [n.id, n]));
  return [
    ...scene.outline.map((o) => ({ id: o.id, rect: byId.get(o.id)!.rect })),
    ...scene.portals.map((p) => ({ id: p.id, rect: p.rect })),
  ];
}

/**
 * The next target for Tab (or Shift+Tab). Null past the last (or before the first) one: the canvas lets
 * the key through then, so focus moves on to the zoom bar, the player and the inspector instead of
 * circling inside the canvas for ever.
 */
export function tabOrder(scene: SystemScene, current: string | null, back = false): string | null {
  const t = targets(scene);
  if (!t.length) return null;
  const i = current ? t.findIndex((x) => x.id === current) : -1;
  if (i < 0) return back ? t[t.length - 1].id : t[0].id;
  return t[i + (back ? -1 : 1)]?.id ?? null;
}

/** The nearest target in a direction: distance along it, with sideways drift costing double. */
export function spatial(scene: SystemScene, current: string | null, dir: Dir): string | null {
  const t = targets(scene);
  if (!current) return t[0]?.id ?? null;
  const from = t.find((x) => x.id === current);
  if (!from) return t[0]?.id ?? null;
  const c = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
  const a = c(from.rect);
  let best: string | null = null, bs = Infinity;
  for (const x of t) {
    if (x.id === current) continue;
    const b = c(x.rect);
    const dx = b.x - a.x, dy = b.y - a.y;
    const along = dir === 'right' ? dx : dir === 'left' ? -dx : dir === 'down' ? dy : -dy;
    const side = dir === 'right' || dir === 'left' ? Math.abs(dy) : Math.abs(dx);
    if (along <= 1) continue;
    const s = along + side * 2;
    if (s < bs || (s === bs && best !== null && x.id < best)) { bs = s; best = x.id; }
  }
  return best;
}
