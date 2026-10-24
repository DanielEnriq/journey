import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { before, describe, it } from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { TokenVerifier } from 'livekit-server-sdk';
import { HttpError, authenticate, type Caller } from './http.js';
import { issueToken } from './livekit.js';

const ROOM = '0b7c6c4e-55d2-4d0f-9f53-0d0b8a3ef001';
const ME = '7d1f2b9a-3c4e-4f5a-8b6c-1d2e3f4a5b6c';

/** A Supabase client that answers the two queries issueToken makes, as RLS would for this caller. */
function caller(memberOf: string[]): Caller {
  const supabase = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => ((filters[column] = value), query),
        maybeSingle: async () => {
          if (table === 'room_members') {
            const found = filters.user_id === ME && memberOf.includes(filters.room_id as string);
            return { data: found ? { room_id: filters.room_id } : null, error: null };
          }
          return { data: { name: 'Ana', avatar_url: 'https://example.com/ana.png' }, error: null };
        },
      };
      return query;
    },
  };
  return { userId: ME, supabase: supabase as unknown as SupabaseClient };
}

describe('POST /livekit/token', () => {
  before(() => {
    process.env.LIVEKIT_URL = 'wss://lk.test';
    process.env.LIVEKIT_API_KEY = 'devkey';
    process.env.LIVEKIT_API_SECRET = 'a-secret-long-enough-for-hs256-signing';
  });

  it('turns away callers without a session', async () => {
    await assert.rejects(authenticate({ headers: {} } as IncomingMessage), (err: HttpError) => err.status === 401);
  });

  it('refuses a malformed room id', async () => {
    await assert.rejects(issueToken(caller([ROOM]), { roomId: 'room-1' }), (err: HttpError) => err.status === 400);
    await assert.rejects(issueToken(caller([ROOM]), null), (err: HttpError) => err.status === 400);
  });

  it('refuses people who are not members of the room', async () => {
    await assert.rejects(issueToken(caller([]), { roomId: ROOM }), (err: HttpError) => err.status === 403 && /Join the room/.test(err.message));
  });

  it('admits a member to that room only, publishing their microphone and nothing else', async () => {
    const { url, token } = await issueToken(caller([ROOM]), { roomId: ROOM });
    assert.equal(url, 'wss://lk.test');
    assert.doesNotMatch(token, /a-secret-long-enough/);
    const claims = await new TokenVerifier('devkey', process.env.LIVEKIT_API_SECRET!).verify(token);
    assert.equal(claims.sub, ME);
    assert.equal(claims.name, 'Ana');
    assert.deepEqual(JSON.parse(claims.metadata!), { avatarUrl: 'https://example.com/ana.png' });
    assert.equal(claims.video?.room, `room:${ROOM}`);
    assert.equal(claims.video?.roomJoin, true);
    assert.equal(claims.video?.canSubscribe, true);
    assert.deepEqual(claims.video?.canPublishSources, ['microphone']);
    assert.equal(claims.video?.canPublishData, false);
    assert.equal(claims.video?.roomAdmin, undefined);
    assert.ok(claims.exp! - claims.nbf! <= 600, 'valid for at most 10 minutes');
  });
});
