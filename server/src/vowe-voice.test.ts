import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { TokenVerifier } from 'livekit-server-sdk';
import { HttpError, type Caller } from './http.js';
import { issueSpeechToken, issueVoweToken } from './vowe-voice.js';

const ROOM = '0b7c6c4e-55d2-4d0f-9f53-0d0b8a3ef001';
const OTHER_ROOM = '0b7c6c4e-55d2-4d0f-9f53-0d0b8a3ef002';
const ME = '7d1f2b9a-3c4e-4f5a-8b6c-1d2e3f4a5b6c';

/** Answers the room_members lookup as RLS would for this caller: only their own rows in rooms they're in. */
function caller(memberships: Record<string, string>): Caller {
  const supabase = {
    from() {
      const filters: Record<string, unknown> = {};
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => ((filters[column] = value), query),
        maybeSingle: async () => {
          const role = filters.user_id === ME ? memberships[filters.room_id as string] : undefined;
          return { data: role ? { role } : null, error: null };
        },
      };
      return query;
    },
  };
  return { userId: ME, supabase: supabase as unknown as SupabaseClient };
}

async function refusal(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof HttpError, String(err));
    return err;
  }
  assert.fail('expected a refusal');
}

describe('POST /vowe/token', () => {
  before(() => {
    process.env.LIVEKIT_URL = 'wss://lk.test';
    process.env.LIVEKIT_API_KEY = 'devkey';
    process.env.LIVEKIT_API_SECRET = 'a-secret-long-enough-for-hs256-signing';
  });

  it('refuses a bad room id, a room the caller is not in, and a viewer', async () => {
    assert.equal((await refusal(issueVoweToken(caller({ [ROOM]: 'member' }), { roomId: 'room:abc' }))).status, 400);
    assert.equal((await refusal(issueVoweToken(caller({ [ROOM]: 'member' }), { roomId: OTHER_ROOM }))).status, 403);
    assert.equal((await refusal(issueVoweToken(caller({ [ROOM]: 'viewer' }), { roomId: ROOM }))).status, 403);
  });

  it('seats Vowe as an agent in that room only, with a microphone and nothing else', async () => {
    const { url, token } = await issueVoweToken(caller({ [ROOM]: 'member' }), { roomId: ROOM });
    assert.equal(url, 'wss://lk.test');
    const claims = await new TokenVerifier('devkey', 'a-secret-long-enough-for-hs256-signing').verify(token);
    assert.equal(claims.sub, 'vowe');
    assert.equal(claims.name, 'Vowe');
    assert.equal(claims.kind, 'agent');
    assert.deepEqual(claims.attributes, { 'vowe.summonedBy': ME, 'vowe.state': 'listening' });
    assert.equal(claims.video?.room, `room:${ROOM}`);
    assert.equal(claims.video?.roomJoin, true);
    assert.deepEqual(claims.video?.canPublishSources, ['microphone']);
    assert.equal(claims.video?.canPublishData, false);
    assert.equal(claims.video?.canUpdateOwnMetadata, true);
    assert.equal(claims.video?.roomAdmin, undefined);
  });

  it('works for the room owner too', async () => {
    await issueVoweToken(caller({ [ROOM]: 'owner' }), { roomId: ROOM });
  });
});

describe('POST /vowe/speech-token', () => {
  it('is room-scoped like the seat', async () => {
    process.env.ELEVENLABS_API_KEY = 'xi-test';
    process.env.ELEVENLABS_AGENT_ID = 'agent_test';
    assert.equal((await refusal(issueSpeechToken(caller({}), { roomId: ROOM }))).status, 403);
    assert.equal((await refusal(issueSpeechToken(caller({ [ROOM]: 'viewer' }), { roomId: ROOM }))).status, 403);
  });
});
