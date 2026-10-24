import { FunctionsHttpError } from '@supabase/supabase-js';
import type { CallAccess } from '../../shared/api.js';
import { isApiConfigured, postApi } from '../api/index.js';
import { getCloud } from '../supabase/index.js';
import { rooms } from '../supabase/workspaces.js';

/**
 * Voice calls run on LiveKit, one LiveKit room per Journey room (`room:<room id>`). Audio is
 * WebRTC, so the call itself lives in the renderer (src/renderer/calls/service.ts); main only gets it in.
 *
 * Access tokens come from the Vowe API's POST /livekit/token when VOWE_API_URL is set (server/), else
 * from the `livekit-token` Edge Function (supabase/functions/). Both hold the LiveKit API secret and
 * admit the same people as the room's Realtime channel: members of the room who are still in its
 * workspace. The app itself never sees the secret.
 */

/** Fetches a short-lived token for the call of a room you're a member of. Doesn't open the microphone. */
export async function getCallAccess(roomId: string): Promise<CallAccess> {
  await rooms.getRoom(roomId); // not-found unless you're a member; the token service checks the same
  if (isApiConfigured()) {
    const data = await postApi<CallAccess>('/livekit/token', { roomId }).catch((err: Error) => {
      throw new Error(`Could not join the call: ${err.message}`);
    });
    if (typeof data.url !== 'string' || typeof data.token !== 'string') throw new Error('Could not join the call: malformed token');
    return { url: data.url, token: data.token };
  }
  const { data, error } = await (await getCloud()).functions.invoke<CallAccess>('livekit-token', { body: { roomId } });
  if (error) {
    // The function explains refusals as { error }; surface that rather than "non-2xx status code".
    const reason = error instanceof FunctionsHttpError ? await readError(error.context as Response) : undefined;
    throw new Error(`Could not join the call: ${reason ?? error.message}`);
  }
  if (typeof data?.url !== 'string' || typeof data.token !== 'string') throw new Error('Could not join the call: malformed token');
  return { url: data.url, token: data.token };
}

async function readError(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === 'string' ? body.error : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Owners only, after changing someone's role or removing them: brings their connection to the room's call in
 * line, so a removed person is taken off it and a new viewer stops being heard without reconnecting. Best
 * effort: the database has already decided, and their next token follows it either way.
 */
export async function syncCallParticipant(roomId: string, userId: string): Promise<void> {
  try {
    if (isApiConfigured()) {
      await postApi('/livekit/sync', { roomId, userId });
      return;
    }
    const { error } = await (await getCloud()).functions.invoke('livekit-token', { body: { roomId, userId, action: 'sync' } });
    if (error) {
      const reason = error instanceof FunctionsHttpError ? await readError(error.context as Response) : undefined;
      throw new Error(reason ?? error.message);
    }
  } catch (err) {
    console.warn('[calls] could not update the call after a membership change:', (err as Error).message);
  }
}
