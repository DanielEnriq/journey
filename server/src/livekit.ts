// Mints a LiveKit access token for a room's voice call; the same contract as the `livekit-token`
// Supabase Edge Function (supabase/functions/livekit-token), which the app falls back to without VOWE_API_URL.
//
// POST { roomId } → 200 { url, token }   valid for 10 minutes to join; an open call isn't cut off when it expires
//   → 401 not signed in, 403 not a member of the room (or no longer in its workspace), 400 bad request

import { AccessToken, TrackSource } from 'livekit-server-sdk';
import { HttpError, env, type Caller } from './http.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isLiveKitConfigured(): boolean {
  return Boolean(process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);
}

export async function issueToken({ userId, supabase }: Caller, body: unknown): Promise<{ url: string; token: string }> {
  const roomId = (body as { roomId?: unknown } | null)?.roomId;
  if (typeof roomId !== 'string' || !UUID.test(roomId)) throw new HttpError(400, 'roomId must be a room id');

  // Same rule as the room's Realtime channel (private.can_use_room): RLS shows a room's room_members rows only
  // to its members who are still in its workspace, so this finds a row only if the caller is in both.
  const { data: membership, error } = await supabase
    .from('room_members')
    .select('room_id')
    .eq('room_id', roomId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!membership) throw new HttpError(403, 'Join the room before its call');

  const { data: profile } = await supabase.from('users').select('name, avatar_url').eq('id', userId).maybeSingle();

  const token = new AccessToken(env('LIVEKIT_API_KEY'), env('LIVEKIT_API_SECRET'), {
    identity: userId, // one connection per user: joining from a second device replaces the first
    name: profile?.name ?? undefined,
    metadata: JSON.stringify({ avatarUrl: profile?.avatar_url ?? null }),
    ttl: '10m',
  });
  token.addGrant({
    room: `room:${roomId}`,
    roomJoin: true,
    canSubscribe: true,
    canPublish: true,
    canPublishSources: [TrackSource.MICROPHONE], // audio rooms: no camera or screen share
    canPublishData: false,
    canUpdateOwnMetadata: false,
  });

  return { url: env('LIVEKIT_URL'), token: await token.toJwt() };
}
