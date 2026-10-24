import { arr, id, int, obj, only, oneOf } from './check.js';
import { ref } from './commands.js';
import type { CanvasRef } from './model.js';

// What each person in a call is doing on the canvas right now: the view they're on, where their pen
// is, and what they have selected. It travels over the room's realtime channel and is never saved.
//
// The cursor is in the view's own coordinates (the stage every view is laid out on), not the screen's,
// so it lands on the same part for everyone however each of them has panned or zoomed. Cameras are
// never shared.

export interface CanvasPresence {
  view: string;
  cursor: { x: number; y: number } | null;
  selection: CanvasRef[];
  tool: 'select' | 'circle' | 'draw' | 'comment';
}

export const PRESENCE_TOOLS = ['select', 'circle', 'draw', 'comment'] as const;

export function parsePresence(raw: unknown): CanvasPresence {
  const p = obj(raw, 'presence');
  only(p, ['view', 'cursor', 'selection', 'tool'], 'presence');
  let cursor: CanvasPresence['cursor'] = null;
  if (p.cursor !== null && p.cursor !== undefined) {
    const c = obj(p.cursor, 'presence.cursor');
    only(c, ['x', 'y'], 'presence.cursor');
    cursor = { x: int(Math.round(Number(c.x)), 'presence.cursor.x', -20000, 20000), y: int(Math.round(Number(c.y)), 'presence.cursor.y', -20000, 20000) };
  }
  return {
    view: id(p.view, 'presence.view'),
    cursor,
    selection: arr(p.selection ?? [], 'presence.selection', 20).map((r, i) => ref(r, `presence.selection[${i}]`)),
    tool: oneOf(p.tool ?? 'select', PRESENCE_TOOLS, 'presence.tool'),
  };
}
