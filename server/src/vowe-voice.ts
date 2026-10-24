// Your Vowe's voice in a room's call: what your app's main process needs from the API, so the LiveKit and
// ElevenLabs secrets stay here. Every route is room-scoped: the caller must be a member of the room (not a
// viewer), checked under their RLS like POST /livekit/token (livekit.ts). Knowing a room's LiveKit name is
// never enough to bring Vowe in. Speech is billed to Vowe's ElevenLabs account, never to anyone's model plan.
//
// POST /vowe/token        { roomId }                    → 200 { url, token }   your Vowe's seat in room:<roomId>
// POST /vowe/speech-token { roomId }                    → 200 { token }        single-use Scribe realtime token
// POST /vowe/speech       { roomId, text, sampleRate }  → 200 audio/pcm        Vowe saying `text`, streamed
//   → 401 not signed in, 403 not a member / a viewer, 400 bad request, 503 not configured

import type { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { AccessToken, TrackSource } from 'livekit-server-sdk';
import { HttpError, env, type Caller } from './http.js';
import { isElevenLabsConfigured } from './elevenlabs.js';
import { isLiveKitConfigured } from './livekit.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ELEVENLABS = 'https://api.elevenlabs.io/v1';
/** Vowe speaks in sentences; anything longer is not a sentence. */
const MAX_TEXT = 1000;
const RATES = new Set([16000, 22050, 24000]);

/**
 * Your Vowe's LiveKit identity (renderer/shared/vowe-voice.ts VOWE_VOICE). People's identities are bare user
 * ids, so a Vowe can never take a person's place, and each person's Vowe has a seat of its own.
 */
export const voweIdentity = (userId: string) => `vowe:${userId}`;

/** Checks the caller may bring Vowe into this room; returns the room id. */
async function requireSpeaker({ userId, supabase }: Caller, body: unknown): Promise<string> {
  const roomId = (body as { roomId?: unknown } | null)?.roomId;
  if (typeof roomId !== 'string' || !UUID.test(roomId)) throw new HttpError(400, 'roomId must be a room id');
  // The same rule as the room's call (livekit.ts): RLS shows the row only to members still in its workspace.
  const { data: membership, error } = await supabase.from('room_members').select('role').eq('room_id', roomId).eq('user_id', userId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!membership) throw new HttpError(403, 'Join the room before bringing Vowe into its call');
  if ((membership.role as string) === 'viewer') throw new HttpError(403, 'Viewers can listen but not bring Vowe in');
  return roomId;
}

/**
 * Your Vowe's grant, for the signed-in caller only (the identity comes from their verified session, never the
 * request): kind agent, so every app sees it isn't a person; the microphone only, as for people; no
 * subscribing, since it hears through your own microphone in your app; and attributes it can update, which is
 * how the call shows whose Vowe it is and what it's doing.
 */
export function voweToken(roomId: string, userId: string, name: string | null): AccessToken {
  const token = new AccessToken(env('LIVEKIT_API_KEY'), env('LIVEKIT_API_SECRET'), {
    identity: voweIdentity(userId), // one per person: bringing it in from a second device replaces the first
    name: `Vowe (for ${name ?? 'a member'})`,
    attributes: { kind: 'vowe', speaksFor: userId, state: 'listening' },
    ttl: '10m',
  });
  token.kind = 'agent';
  token.addGrant({
    room: `room:${roomId}`,
    roomJoin: true,
    canSubscribe: false,
    canPublish: true,
    canPublishSources: [TrackSource.MICROPHONE],
    canPublishData: false,
    canUpdateOwnMetadata: true,
  });
  return token;
}

export async function issueVoweToken(caller: Caller, body: unknown): Promise<{ url: string; token: string }> {
  if (!isLiveKitConfigured()) throw new HttpError(503, 'Calls are not configured on the API');
  const roomId = await requireSpeaker(caller, body);
  const { data: profile } = await caller.supabase.from('users').select('name').eq('id', caller.userId).maybeSingle();
  return { url: env('LIVEKIT_URL'), token: await voweToken(roomId, caller.userId, (profile?.name as string | null | undefined) ?? null).toJwt() };
}

export async function issueSpeechToken(caller: Caller, body: unknown): Promise<{ token: string }> {
  if (!isElevenLabsConfigured()) throw new HttpError(503, 'Speech is not configured on the API');
  await requireSpeaker(caller, body);
  const res = await fetch(`${ELEVENLABS}/single-use-token/realtime_scribe`, { method: 'POST', headers: { 'xi-api-key': env('ELEVENLABS_API_KEY') } });
  if (!res.ok) throw new Error(`ElevenLabs token failed: ${res.status} ${await res.text()}`);
  return { token: ((await res.json()) as { token: string }).token };
}

/** Streams Vowe saying `text` as 16-bit mono PCM, in the agent's voice (or VOWE_VOICE_ID). */
export async function speak(caller: Caller, body: unknown, res: ServerResponse): Promise<void> {
  if (!isElevenLabsConfigured()) throw new HttpError(503, 'Speech is not configured on the API');
  await requireSpeaker(caller, body);
  const { text, sampleRate } = body as { text?: unknown; sampleRate?: unknown };
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) throw new HttpError(400, `text must be 1–${MAX_TEXT} characters`);
  if (typeof sampleRate !== 'number' || !RATES.has(sampleRate)) throw new HttpError(400, 'sampleRate must be 16000, 22050 or 24000');

  const { voiceId, model } = await voice();
  const abort = new AbortController();
  res.on('close', () => abort.abort()); // Vowe was interrupted: stop paying for speech nobody will hear
  const upstream = await fetch(`${ELEVENLABS}/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=pcm_${sampleRate}`, {
    method: 'POST',
    headers: { 'xi-api-key': env('ELEVENLABS_API_KEY'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: model }),
    signal: abort.signal,
  });
  if (!upstream.ok || !upstream.body) throw new Error(`ElevenLabs speech failed: ${upstream.status} ${await upstream.text()}`);
  res.writeHead(200, { 'Content-Type': 'audio/pcm', 'Cache-Control': 'no-store', 'X-Sample-Rate': String(sampleRate) });
  Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream).on('error', () => res.destroy()).pipe(res);
}

let cachedVoice: Promise<{ voiceId: string; model: string }> | null = null;

/** VOWE_VOICE_ID / VOWE_TTS_MODEL, else the voice configured on the ElevenLabs agent (as the app does). */
function voice(): Promise<{ voiceId: string; model: string }> {
  cachedVoice ??= (async () => {
    const voiceId = process.env.VOWE_VOICE_ID;
    const model = process.env.VOWE_TTS_MODEL;
    if (voiceId && model) return { voiceId, model };
    const res = await fetch(`${ELEVENLABS}/convai/agents/${encodeURIComponent(env('ELEVENLABS_AGENT_ID'))}`, { headers: { 'xi-api-key': env('ELEVENLABS_API_KEY') } });
    if (!res.ok) throw new Error(`ElevenLabs agent lookup failed: ${res.status}`);
    const tts = ((await res.json()) as { conversation_config?: { tts?: { voice_id?: string; model_id?: string } } }).conversation_config?.tts;
    const id = voiceId ?? tts?.voice_id;
    if (!id) throw new Error('The ElevenLabs agent has no voice; set VOWE_VOICE_ID');
    return { voiceId: id, model: model ?? tts?.model_id ?? 'eleven_flash_v2_5' };
  })().catch((err) => {
    cachedVoice = null;
    throw err;
  });
  return cachedVoice;
}
