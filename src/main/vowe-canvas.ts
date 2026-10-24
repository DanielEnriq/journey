import type { AgentEvent } from '../shared/api.js';
import { canvasEvents, snapshotOf } from '../shared/canvas/index.js';
import { canvas } from './canvas.js';

// Where Vowe's room turns meet the room's canvas, in main (src/shared/canvas/runtime.ts is the adapter).
// A turn sees the canvas the hub will run its requests on, and each validated request runs through the
// hub as Vowe, so the engine's agent rules apply: pointing and notes land at once (notes as suggestions),
// new views land proposed, and structural changes become one proposal a person accepts or rejects.
// The asker's renderer sees every outcome as `canvas.applied`, and the room sees the canvas change.

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The turn with its canvas read from the room's document rather than the renderer's copy, keeping what
 * the asker selected and circled. A turn that isn't about a readable room is left for the runtime to refuse.
 */
export async function withRoomCanvas(turn: unknown): Promise<unknown> {
  if (!isRecord(turn) || typeof turn.roomId !== 'string') return turn;
  const sent = isRecord(turn.canvas) && isRecord(turn.canvas.selection) ? turn.canvas.selection : {};
  const ids = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  try {
    const { doc } = await canvas.load(turn.roomId);
    return { ...turn, canvas: snapshotOf(doc, { selected: ids(sent.selected), circled: ids(sent.circled) }) };
  } catch {
    return turn;
  }
}

/** A turn's events, with its canvas requests run on this app's hub (see canvasEvents). */
export const roomCanvasEvents = (roomId: string, forward: (event: AgentEvent) => void) => canvasEvents(canvas, roomId, forward);
