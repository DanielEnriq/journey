// Mints a LiveKit access token for a room's voice call; the same contract as the `livekit-token`
// Supabase Edge Function (supabase/functions/livekit-token), which the app falls back to without VOWE_API_URL.
//
// POST /livekit/token { roomId } → 200 { url, token }   valid for 10 minutes to join; an open call isn't cut off when it expires
//   → 401 not signed in, 403 not a member of the room (or no longer in its workspace), 400 bad request
// POST /livekit/sync { roomId, userId } → 200 { applied }   owners only, after changing someone's role or removing
//   them: takes a removed person off the call, and makes a connected person's permissions follow their new role.
//
// Owners and members may publish their microphone; viewers only listen. Roles are read under RLS as the
// caller, so this follows the same rules as the database (supabase/migrations/*_room_invitations.sql).

import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk';
import { HttpError, env, type Caller } from './http.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type RoomRole = 'owner' | 'member' | 'viewer';

export function isLiveKitConfigured(): boolean {
  return Boolean(process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);
}

/** What a role may do on the call: everyone hears it; viewers publish nothing. Audio rooms: no camera or screen. */
export function callPermissions(role: RoomRole) {
  const talks = role !== 'viewer';
  return { canSubscribe: true, canPublish: talks, canPublishSources: talks ? [TrackSource.MICROPHONE] : [], canPublishData: false };
}

function requireUuid(value: unknown, what: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new HttpError(400, `${what} must be a ${what === 'roomId' ? 'room' : 'user'} id`);
  return value;
}

/**
 * Someone's role in a room, as the caller may see it. RLS shows a room's room_members rows only to its members
 * who are still in its workspace (private.can_use_room), the same rule as the room's Realtime channel.
 */
async function roleIn({ supabase }: Caller, roomId: string, userId: string): Promise<RoomRole | null> {
  const { data, error } = await supabase.from('room_members').select('role').eq('room_id', roomId).eq('user_id', userId).maybeSingle();
  if (error) throw new Error(error.message);
  return (data?.role as RoomRole | undefined) ?? null;
}

export async function issueToken(caller: Caller, body: unknown): Promise<{ url: string; token: string }> {
  const roomId = requireUuid((body as { roomId?: unknown } | null)?.roomId, 'roomId');
  const role = await roleIn(caller, roomId, caller.userId);
  if (!role) throw new HttpError(403, 'Join the room before its call');

  const { data: profile } = await caller.supabase.from('users').select('name, avatar_url').eq('id', caller.userId).maybeSingle();

  const token = new AccessToken(env('LIVEKIT_API_KEY'), env('LIVEKIT_API_SECRET'), {
    identity: caller.userId, // one connection per user: joining from a second device replaces the first
    name: profile?.name ?? undefined,
    metadata: JSON.stringify({ avatarUrl: profile?.avatar_url ?? null }),
    ttl: '10m',
  });
  token.addGrant({ room: `room:${roomId}`, roomJoin: true, ...callPermissions(role), canUpdateOwnMetadata: false });

  return { url: env('LIVEKIT_URL'), token: await token.toJwt() };
}

/** The part of LiveKit's room service that sync uses; tests pass a fake. */
export type CallRooms = Pick<RoomServiceClient, 'removeParticipant' | 'updateParticipant'>;

function callRooms(): CallRooms {
  return new RoomServiceClient(env('LIVEKIT_URL').replace(/^ws/, 'http'), env('LIVEKIT_API_KEY'), env('LIVEKIT_API_SECRET'));
}

export async function syncParticipant(caller: Caller, body: unknown, rooms: CallRooms = callRooms()): Promise<{ applied: 'removed' | 'updated' | 'none' }> {
  const roomId = requireUuid((body as { roomId?: unknown } | null)?.roomId, 'roomId');
  const userId = requireUuid((body as { userId?: unknown }).userId, 'userId');
  if ((await roleIn(caller, roomId, caller.userId)) !== 'owner') throw new HttpError(403, 'Only the room’s owners can do that');

  const role = await roleIn(caller, roomId, userId);
  try {
    if (!role) {
      await rooms.removeParticipant(`room:${roomId}`, userId);
      return { applied: 'removed' };
    }
    await rooms.updateParticipant(`room:${roomId}`, userId, { permission: { ...callPermissions(role), canUpdateMetadata: false } });
    return { applied: 'updated' };
  } catch (err) {
    // They aren't on the call, or no call is running: there's nothing to bring in line.
    if (/not.?found|does not exist|404/i.test((err as Error).message)) return { applied: 'none' };
    throw err;
  }
}
