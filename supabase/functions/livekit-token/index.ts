// Mints a LiveKit access token for a room's voice call. Runs on Supabase Edge Functions (Deno),
// so the LiveKit API secret never ships with the app.
//
// POST { roomId } with the caller's Supabase session as `Authorization: Bearer <jwt>`
//   → 200 { url, token }   token is valid for 10 minutes to join; an open call isn't cut off when it expires
//   → 401 not signed in, 403 not a member of the room (or no longer in its workspace), 400 bad request
// POST { roomId, userId, action: 'sync' }   owners only, after changing someone's role or removing them
//   → 200 { applied: 'removed' | 'updated' | 'none' }   takes a removed person off the call, and makes a
//     connected person's permissions follow their new role (a new viewer stops being heard at once)
//
// Owners and members publish their microphone; viewers only listen. Roles are read under RLS as the caller.
//
// Secrets (once per project): supabase secrets set LIVEKIT_URL=wss://… LIVEKIT_API_KEY=… LIVEKIT_API_SECRET=…
// Deploy: pnpm cloud:functions

import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { AccessToken, RoomServiceClient, TrackSource } from 'npm:livekit-server-sdk@2.19.1';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing secret ${name}`);
  return value;
}

/** The project's publishable key: hosted projects provide a JSON map, the local CLI a single key. */
function publishableKey(): string {
  const keys = Deno.env.get('SUPABASE_PUBLISHABLE_KEYS');
  if (keys) return (JSON.parse(keys) as Record<string, string>).default;
  return Deno.env.get('SUPABASE_PUBLISHABLE_KEY') ?? env('SUPABASE_ANON_KEY');
}

const reply = (status: number, body: object) => Response.json(body, { status });

type RoomRole = 'owner' | 'member' | 'viewer';

/** What a role may do on the call: everyone hears it; viewers publish nothing. Audio rooms: no camera or screen. */
function callPermissions(role: RoomRole) {
  const talks = role !== 'viewer';
  return { canSubscribe: true, canPublish: talks, canPublishSources: talks ? [TrackSource.MICROPHONE] : [], canPublishData: false };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return reply(405, { error: 'POST only' });
  const authorization = req.headers.get('Authorization');
  if (!authorization) return reply(401, { error: 'Not signed in' });

  // Scoped to the caller, so RLS answers every question below as them.
  const supabase = createClient(env('SUPABASE_URL'), publishableKey(), {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError || !auth.user) return reply(401, { error: 'Not signed in' });
  const userId = auth.user.id;

  const body: unknown = await req.json().catch(() => null);
  const roomId = (body as { roomId?: unknown } | null)?.roomId;
  if (typeof roomId !== 'string' || !UUID.test(roomId)) return reply(400, { error: 'roomId must be a room id' });

  // Same rule as the room's Realtime channel (private.can_use_room): RLS shows a room's room_members rows only
  // to its members who are still in its workspace, so this finds a row only if the caller is in both.
  async function roleOf(user: string): Promise<RoomRole | null> {
    const { data, error } = await supabase.from('room_members').select('role').eq('room_id', roomId).eq('user_id', user).maybeSingle();
    if (error) throw new Error(error.message);
    return (data?.role as RoomRole | undefined) ?? null;
  }

  let role: RoomRole | null;
  try {
    role = await roleOf(userId);
  } catch (err) {
    return reply(500, { error: (err as Error).message });
  }

  if ((body as { action?: unknown }).action === 'sync') {
    const target = (body as { userId?: unknown }).userId;
    if (typeof target !== 'string' || !UUID.test(target)) return reply(400, { error: 'userId must be a user id' });
    if (role !== 'owner') return reply(403, { error: 'Only the room’s owners can do that' });
    const rooms = new RoomServiceClient(env('LIVEKIT_URL').replace(/^ws/, 'http'), env('LIVEKIT_API_KEY'), env('LIVEKIT_API_SECRET'));
    try {
      const theirs = await roleOf(target);
      if (!theirs) {
        await rooms.removeParticipant(`room:${roomId}`, target);
        return reply(200, { applied: 'removed' });
      }
      await rooms.updateParticipant(`room:${roomId}`, target, { permission: { ...callPermissions(theirs), canUpdateMetadata: false } });
      return reply(200, { applied: 'updated' });
    } catch (err) {
      // They aren't on the call, or no call is running: there's nothing to bring in line.
      if (/not.?found|does not exist|404/i.test((err as Error).message)) return reply(200, { applied: 'none' });
      return reply(500, { error: (err as Error).message });
    }
  }

  if (!role) return reply(403, { error: 'Join the room before its call' });

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
    ...callPermissions(role),
    canUpdateOwnMetadata: false,
  });

  return reply(200, { url: env('LIVEKIT_URL'), token: await token.toJwt() });
});
