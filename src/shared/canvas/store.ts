import { parseCommand, type CanvasCommand, type CommandResult } from './commands.js';
import { applyCommand, failure } from './engine.js';
import { CanvasError } from './errors.js';
import { emptyDocument, type Actor, type CanvasDocument } from './model.js';

// Running a command against wherever a room's canvas is kept. Every caller (main's hub for people and
// for Vowe, the dev harness, the tests) goes through `execute`, so there is one way a command lands:
// read the latest document, apply the command, save it only if nobody saved in between, and if someone
// did, apply the same command again to what they saved. Commands are semantic ("add the failure after
// the charge"), so re-applying one to a newer document does the right thing rather than overwriting.

export interface StoredCanvas { revision: number; doc: CanvasDocument }

export interface CanvasStore {
  load(roomId: string): Promise<StoredCanvas>;
  /** Saves when the stored revision is still `base`; the new revision, or null if someone saved first. */
  commit(roomId: string, base: number, doc: CanvasDocument, cmd: CanvasCommand, actor: Actor): Promise<number | null>;
}

export interface Executed { result: CommandResult; canvas: StoredCanvas }

export const MAX_ATTEMPTS = 5;

export async function execute(store: CanvasStore, roomId: string, raw: unknown, actor: Actor, now?: () => string): Promise<Executed> {
  let cmd: CanvasCommand;
  try { cmd = parseCommand(raw); }
  catch (err) { return { result: failure(raw as { id?: string; name?: string }, err), canvas: await store.load(roomId) }; }

  let canvas = await store.load(roomId);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let applied;
    try { applied = applyCommand(canvas.doc, cmd, actor, now?.()); }
    catch (err) { return { result: failure(cmd, err), canvas }; }
    if (applied.result.applied === 'noop') return { result: { ...applied.result, revision: canvas.revision }, canvas };
    const revision = await store.commit(roomId, canvas.revision, applied.doc, cmd, actor);
    if (revision !== null) {
      const saved = { revision, doc: applied.doc };
      return { result: { ...applied.result, revision }, canvas: saved };
    }
    canvas = await store.load(roomId);
  }
  return { result: failure(cmd, new CanvasError('busy', 'The canvas kept changing under this command; nothing was saved. Try again.')), canvas };
}

/** A store in memory: tests, the room preview, and the dev harness without a cloud. */
export function memoryStore(seed: Record<string, StoredCanvas> = {}, onCommit?: (roomId: string, canvas: StoredCanvas) => void): CanvasStore & { rooms: Record<string, StoredCanvas> } {
  const rooms: Record<string, StoredCanvas> = { ...seed };
  const copy = (c: StoredCanvas): StoredCanvas => JSON.parse(JSON.stringify(c));
  return {
    rooms,
    async load(roomId) { return copy(rooms[roomId] ?? { revision: 0, doc: emptyDocument() }); },
    async commit(roomId, base, doc) {
      if ((rooms[roomId]?.revision ?? 0) !== base) return null;
      rooms[roomId] = copy({ revision: base + 1, doc });
      onCommit?.(roomId, copy(rooms[roomId]));
      return base + 1;
    },
  };
}
