import { h, type ComponentChildren } from '../../vendor/preact.js';
import { useMemo } from '../../vendor/preact-hooks.js';
import { CanvasSurface, makeCanvasUi } from './CanvasSurface.js';
import type { CanvasClient } from './client.js';

// A room's live canvas in Journey's rooms and the harness: the one canvas engine (CanvasSurface.tsx)
// with its own UI state and no record marks. Kept as its own export so existing callers (RoomScreen's
// fresh call, the harness) keep their props; everything it draws and every gesture is the engine's.

export { circled, refKey } from './geometry.js';

export interface LiveSurfaceProps {
  client: CanvasClient;
  /** The comment tool: where you clicked on the canvas (stage units) and the part it landed on, if any. Absent: no comment tool. */
  onComment?(x: number, y: number, on: { component: string; name: string } | null): void;
  /** Drawn over the canvas but kept on it as you pan and zoom (comment pins); `place` turns stage units into surface pixels. */
  anchored?(place: (x: number, y: number) => { x: number; y: number }): ComponentChildren;
  /** Asking Vowe about what you selected or circled (component ids, and how the canvas names them). Absent: no ask. */
  onAsk?(about: { selected: string[]; circled: string[]; names: string[] }): void;
  /** Drawn inside the surface, over the canvas: pins, the empty state, captions, the call bar. */
  children?: ComponentChildren;
}

export function LiveSurface({ client, onComment, onAsk, anchored, children }: LiveSurfaceProps) {
  const ui = useMemo(makeCanvasUi, []);
  return (
    <CanvasSurface client={client} ui={ui} onComment={onComment} anchored={anchored} states={false}
      onAsk={onAsk ? ({ selected, circled, names }) => onAsk({ selected, circled, names }) : undefined}>
      {children}
    </CanvasSurface>
  );
}
