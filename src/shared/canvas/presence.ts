import { arr, id, int, obj, only, oneOf } from './check.js';
import { COMMAND_NAMES, ref } from './commands.js';
import { invalid } from './errors.js';
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

/** Sent on the room's channel after a save, so everyone else re-reads the canvas. Carries no content. */
export interface CanvasChanged { revision: number; command: string; name: string }

export function parseCanvasChanged(raw: unknown): CanvasChanged {
  const p = obj(raw, 'changed');
  only(p, ['revision', 'command', 'name'], 'changed');
  if (typeof p.command !== 'string' || p.command.length > 80) throw invalid('must be a command id', 'changed.command');
  return { revision: int(p.revision, 'changed.revision', 1, Number.MAX_SAFE_INTEGER), command: p.command, name: oneOf(p.name, COMMAND_NAMES, 'changed.name') };
}
