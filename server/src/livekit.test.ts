import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { before, describe, it } from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { TokenVerifier } from 'livekit-server-sdk';
import { HttpError, authenticate, type Caller } from './http.js';
import { issueToken, syncParticipant, type CallRooms, type RoomRole } from './livekit.js';

const ROOM = '0b7c6c4e-55d2-4d0f-9f53-0d0b8a3ef001';
const ME = '7d1f2b9a-3c4e-4f5a-8b6c-1d2e3f4a5b6c';
const THEM = '2a4c6e8f-1b3d-4f5a-9c7e-0d2f4a6b8c0e';

/**
 * A Supabase client that answers the queries issueToken and syncParticipant make, as RLS would for this
 * caller: `memberOf` lists the rooms the caller is in (as a member, unless `roles` says otherwise).
 */
function caller(memberOf: string[], roles: Record<string, RoomRole> = {}): Caller {
  const supabase = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => ((filters[column] = value), query),
        maybeSingle: async () => {
          if (table === 'room_members') {
            const visible = memberOf.includes(filters.room_id as string);
            const role = roles[filters.user_id as string] ?? (filters.user_id === ME ? 'member' : undefined);
            return { data: visible && role ? { role } : null, error: null };
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

  it('lets a viewer listen to the call but not publish anything', async () => {
    const { token } = await issueToken(caller([ROOM], { [ME]: 'viewer' }), { roomId: ROOM });
    const claims = await new TokenVerifier('devkey', process.env.LIVEKIT_API_SECRET!).verify(token);
    assert.equal(claims.video?.roomJoin, true);
    assert.equal(claims.video?.canSubscribe, true);
    assert.equal(claims.video?.canPublish, false);
    assert.deepEqual(claims.video?.canPublishSources ?? [], []);
  });

  it('lets owners publish their microphone like members', async () => {
    const { token } = await issueToken(caller([ROOM], { [ME]: 'owner' }), { roomId: ROOM });
    const claims = await new TokenVerifier('devkey', process.env.LIVEKIT_API_SECRET!).verify(token);
    assert.equal(claims.video?.canPublish, true);
    assert.deepEqual(claims.video?.canPublishSources, ['microphone']);
  });
});

describe('POST /livekit/sync', () => {
  function rooms() {
    const calls: { op: string; identity: string; permission?: unknown }[] = [];
    const fake: CallRooms = {
      removeParticipant: async (_room: string, identity: string) => void calls.push({ op: 'remove', identity }),
      updateParticipant: async (_room: string, identity: string, options?: unknown) => {
        calls.push({ op: 'update', identity, permission: (options as { permission?: unknown } | undefined)?.permission });
        return {} as never;
      },
    } as CallRooms;
    return { fake, calls };
  }

  it('is for owners only', async () => {
    const { fake, calls } = rooms();
    await assert.rejects(syncParticipant(caller([ROOM]), { roomId: ROOM, userId: THEM }, fake), (err: HttpError) => err.status === 403);
    await assert.rejects(syncParticipant(caller([]), { roomId: ROOM, userId: THEM }, fake), (err: HttpError) => err.status === 403);
    assert.deepEqual(calls, []);
  });

  it('takes someone who is no longer a member off the call', async () => {
    const { fake, calls } = rooms();
    const result = await syncParticipant(caller([ROOM], { [ME]: 'owner' }), { roomId: ROOM, userId: THEM }, fake);
    assert.deepEqual(result, { applied: 'removed' });
    assert.deepEqual(calls, [{ op: 'remove', identity: THEM }]);
  });

  it('stops a new viewer publishing, without disconnecting them', async () => {
    const { fake, calls } = rooms();
    const result = await syncParticipant(caller([ROOM], { [ME]: 'owner', [THEM]: 'viewer' }), { roomId: ROOM, userId: THEM }, fake);
    assert.deepEqual(result, { applied: 'updated' });
    assert.equal(calls[0]?.op, 'update');
    assert.equal((calls[0]?.permission as { canPublish: boolean }).canPublish, false);
  });

  it('is a no-op for someone who isn’t on the call', async () => {
    const fake = { removeParticipant: async () => { throw new Error('participant not found'); } } as unknown as CallRooms;
    const result = await syncParticipant(caller([ROOM], { [ME]: 'owner' }), { roomId: ROOM, userId: THEM }, fake);
    assert.deepEqual(result, { applied: 'none' });
  });
});
