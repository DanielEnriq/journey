import { onUserChange } from '../integrations/google/auth.js';
import { createCanvasHub, createCanvasStore, toCanvasError } from '../integrations/supabase/canvas.js';
import { getCloud, getCloudUserId } from '../integrations/supabase/index.js';
import { roomActivity, sendRoomEvent } from '../integrations/supabase/realtime.js';
import { rooms } from '../integrations/supabase/workspaces.js';
import { CanvasError, emptyDocument, failure, parsePresence, type Actor } from '../shared/canvas/index.js';

// The app's one canvas hub, as the signed-in user: renderers reach it over IPC (main/ipc.ts), and the
// reasoning runtime calls `canvas.executeAsAgent` and `canvas.context` in main. See INTEGRATION.md.

let self: { id: string; actor: Actor } | undefined;

async function person(): Promise<Actor> {
  const id = await getCloudUserId().catch((err) => { throw toCanvasError(err); });
  if (self?.id === id) return self.actor;
  const { data } = await (await getCloud()).from('users').select('name').eq('id', id).maybeSingle();
  self = { id, actor: { kind: 'human', id, name: data?.name ?? 'Someone' } };
  return self.actor;
}

export const canvas = createCanvasHub({
  store: createCanvasStore(async () => {
    try { return await getCloud(); }
    catch (err) {
      const e = toCanvasError(err);
      throw e.code === 'network' ? e : new CanvasError('signed-out', 'Sign in to use the canvas');
    }
  }),
  person,
  // Only connected rooms can announce; anyone not in the call reads the canvas when they next open it.
  announce: async (roomId, change) => {
    try { await sendRoomEvent(roomId, 'canvas:changed', change); }
    catch (err) { if (!/Join the room/.test((err as Error).message)) throw err; }
  },
});

/** Before a room's canvas is read, the room service checks membership, so a stranger gets not-found, not an empty canvas. */
export async function loadRoomCanvas(roomId: string) {
  await rooms.getRoom(roomId);
  const { revision, doc } = await canvas.load(roomId);
  return { roomId, revision, doc };
}

roomActivity.on('event', (event) => {
  if (event.type === 'canvas:changed') void canvas.remoteChanged(event.roomId, event.payload.revision).catch((err: Error) => console.warn('[canvas]', err.message));
});

onUserChange((user) => { if (!user) self = undefined; });

/** A person's command from a renderer, as a result that always crosses IPC intact. */
export async function executeAsPerson(roomId: string, command: unknown) {
  try {
    const { result, canvas: saved } = await canvas.execute(roomId, command);
    return { result, canvas: { roomId, ...saved } };
  } catch (err) {
    return { result: failure(command as never, toCanvasError(err)), canvas: { roomId, revision: 0, doc: emptyDocument() } };
  }
}

/** Keeps what you're pointing at for Vowe, and shows it to the call. */
export async function sharePresence(roomId: string, raw: unknown) {
  const presence = parsePresence(raw);
  canvas.setPresence(roomId, presence);
  await sendRoomEvent(roomId, 'canvas:presence', presence).catch(() => {}); // not in the call: nobody to show
}
