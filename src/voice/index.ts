import { config } from '../config.js';
import { isApiConfigured, postApi } from '../integrations/api/index.js';
import { getCurrentUser } from '../integrations/google/auth.js';
import { getCloud, getCloudUserId } from '../integrations/supabase/index.js';
import type { Speaker, VoiceReasoning } from './contract.js';
import { VoiceHost } from './host.js';
import type { LiveKitAccess } from './livekit.js';
import { ElevenLabsRecognizer, ElevenLabsSynthesizer, agentVoice, type ElevenLabsAccess } from './providers/elevenlabs.js';

export type { VoiceHostEvent, VoiceStatus } from './host.js';
export type { TurnContext, VoiceState } from './contract.js';
export type { VoiceEvent } from './participant.js';

/**
 * Vowe's voice for this app, with credentials resolved here in main:
 *   - its seat in a call always comes from the Vowe API (POST /vowe/token), which holds the LiveKit secret
 *     and checks you're a member of the room; the app never mints LiveKit tokens
 *   - speech goes through the Vowe API too when VOWE_API_URL is set; otherwise, for local development,
 *     through ELEVENLABS_API_KEY in this machine's .env (as the existing ElevenLabs integration does)
 */
export function createVoiceHost(reasoning: (roomId: string, self: Speaker) => VoiceReasoning): VoiceHost {
  return new VoiceHost({
    self: async () => ({ identity: await getCloudUserId(), name: getCurrentUser()?.name ?? null }),
    seat,
    speech: async (roomId) => {
      const access = await speechAccess(roomId);
      return { recognizer: new ElevenLabsRecognizer(access), synthesizer: new ElevenLabsSynthesizer(access) };
    },
    reasoning,
  });
}

async function seat(roomId: string): Promise<LiveKitAccess> {
  if (!isApiConfigured()) throw new Error('Vowe’s voice needs the Vowe API: set VOWE_API_URL (locally, run pnpm api:start)');
  const access = await postApi<LiveKitAccess>('/vowe/token', { roomId }).catch((err: Error) => {
    throw new Error(`Could not bring Vowe into the call: ${err.message}`);
  });
  if (typeof access.url !== 'string' || typeof access.token !== 'string') throw new Error('Could not bring Vowe into the call: malformed token');
  return access;
}

async function speechAccess(roomId: string): Promise<ElevenLabsAccess> {
  if (isApiConfigured()) {
    return {
      kind: 'api',
      recognitionToken: async () => (await postApi<{ token: string }>('/vowe/speech-token', { roomId })).token,
      speak: async (text, sampleRate, signal) => {
        const { data } = await (await getCloud()).auth.getSession();
        return fetch(`${config.api.url}/vowe/speech`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session!.access_token}` },
          body: JSON.stringify({ roomId, text, sampleRate }),
          signal,
        });
      },
    };
  }
  const { apiKey, agentId } = config.elevenlabs;
  if (!apiKey) throw new Error('Vowe’s voice needs speech: set VOWE_API_URL, or ELEVENLABS_API_KEY for local development');
  return { kind: 'key', apiKey, ...(await agentVoice(apiKey, agentId)) };
}
