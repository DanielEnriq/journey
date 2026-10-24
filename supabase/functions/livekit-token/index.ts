// Mints a LiveKit access token for a room's voice call. Runs on Supabase Edge Functions (Deno),
// so the LiveKit API secret never ships with the app.
//
// POST { roomId } with the caller's Supabase session as `Authorization: Bearer <jwt>`
//   → 200 { url, token }   token is valid for 10 minutes to join; an open call isn't cut off when it expires
//   → 401 not signed in, 403 not a member of the room (or no longer in its workspace), 400 bad request
//
// Secrets (once per project): supabase secrets set LIVEKIT_URL=wss://… LIVEKIT_API_KEY=… LIVEKIT_API_SECRET=…
// Deploy: pnpm cloud:functions

import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { AccessToken, TrackSource } from 'npm:livekit-server-sdk@2.19.1';

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

  // Same rule as the room's Realtime channel (private.can_use_room): RLS shows room_members rows only to
  // members of the room's workspace, so this finds a row only if the caller is in both the room and its workspace.
  const { data: membership, error: memberError } = await supabase
    .from('room_members')
    .select('room_id')
    .eq('room_id', roomId)
    .eq('user_id', userId)
    .maybeSingle();
  if (memberError) return reply(500, { error: memberError.message });
  if (!membership) return reply(403, { error: 'Join the room before its call' });

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

  return reply(200, { url: env('LIVEKIT_URL'), token: await token.toJwt() });
});
