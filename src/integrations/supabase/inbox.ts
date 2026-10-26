import type { InboxStateRow } from '../../shared/api.js';
import type { Cloud } from './index.js';
import { RoomError, toRoomError } from './rooms.js';

/**
 * Your Inbox marks on the server (inbox_state, one row per person, RLS: only you). The renderer keeps a local
 * copy for speed and writes the whole set back; the newest write wins. Done marks live in attention_done.
 */

export type InboxStateService = ReturnType<typeof createInboxStateService>;

const MAX_BYTES = 200_000;
/** The schema cache or database doesn't know the table: the database predates 20261031000000_inbox_state. */
const MISSING = new Set(['PGRST205', 'PGRST202', '42P01', '42883']);

function failure(error: { code?: string; message?: string }): RoomError {
  if (error.code && MISSING.has(error.code)) return new RoomError('not-configured', 'This database doesn’t keep Inbox marks yet (migration 20261031000000_inbox_state)');
  return toRoomError(error);
}

export function createInboxStateService(client: () => Promise<Cloud>) {
  async function signedIn(): Promise<Cloud> {
    const supabase = await client();
    const { data, error } = await supabase.auth.getSession();
    if (error) throw toRoomError(error);
    if (!data.session) throw new RoomError('signed-out', 'Sign in to use rooms');
    return supabase;
  }

  return {
    /** Your marks, or null if you've never saved any. */
    async get(): Promise<InboxStateRow | null> {
      const { data, error } = await (await signedIn()).from('inbox_state').select('marks, updated_at').maybeSingle();
      if (error) throw failure(error);
      return data ? { marks: data.marks, updatedAt: data.updated_at } : null;
    },

    /** Replaces your marks; resolves with the time the server kept them. */
    async save(marks: unknown): Promise<string> {
      if (typeof marks !== 'object' || marks === null || Array.isArray(marks)) throw new RoomError('invalid', 'Inbox marks must be an object');
      if (JSON.stringify(marks).length > MAX_BYTES) throw new RoomError('invalid', 'Inbox marks are too large');
      const at = new Date().toISOString();
      const { error } = await (await signedIn()).from('inbox_state')
        .upsert({ marks: marks as never, updated_at: at }, { onConflict: 'user_id' });
      if (error) throw failure(error);
      return at;
    },
  };
}
