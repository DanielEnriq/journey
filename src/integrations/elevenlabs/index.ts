import { config } from '../../config.js';
import type { AudioFormat, VoiceAgentEvent, VoiceAgentProvider, VoiceAgentSession } from '../voice/provider.js';

/**
 * ElevenLabs Agents (realtime voice), as a VoiceAgentProvider. Nothing starts a session yet.
 *
 * Shape of a call, once bridged:
 *   engineers ⇄ LiveKit room ⇄ calling agent (ElevenLabs: STT → LLM → TTS) ⇐ contextual updates ⇐ worker agent
 *
 * The worker never speaks directly; it streams what it's doing into the call via
 * `sendContext`, which ElevenLabs folds into the agent's state without interrupting speech.
 *
 * Docs: https://elevenlabs.io/docs/eleven-agents/libraries/web-sockets
 */

const API = 'https://api.elevenlabs.io/v1';

/** Server → client events we act on; anything else arrives as the last member. */
type ServerEvent =
  | {
      type: 'conversation_initiation_metadata';
      conversation_initiation_metadata_event: {
        conversation_id: string;
        agent_output_audio_format?: string;
        user_input_audio_format?: string;
      };
    }
  | { type: 'user_transcript'; user_transcription_event: { user_transcript: string } }
  | { type: 'agent_response'; agent_response_event: { agent_response: string } }
  | { type: 'audio'; audio_event: { audio_base_64: string; event_id: number } }
  | { type: 'interruption'; interruption_event: { event_id: number } }
  | { type: 'ping'; ping_event: { event_id: number; ping_ms?: number } }
  | { type: '_other' };

function credentials() {
  const { apiKey, agentId } = config.elevenlabs;
  if (!apiKey || !agentId) throw new Error('ElevenLabs not configured — set ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID in .env');
  return { apiKey, agentId };
}

async function request(path: string): Promise<unknown> {
  const { apiKey } = credentials();
  const res = await fetch(`${API}${path}`, { headers: { 'xi-api-key': apiKey } });
  if (!res.ok) throw new Error(`ElevenLabs ${path.split('?')[0]} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Short-lived (15 min) WebSocket URL for a private agent. Keeps the API key in the main process. */
async function getSignedUrl(): Promise<string> {
  const { agentId } = credentials();
  const { signed_url } = (await request(`/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`)) as {
    signed_url: string;
  };
  return signed_url;
}

/** "pcm_16000" → 16 kHz PCM. The agent's dashboard settings decide these; we only support PCM. */
function parseFormat(format: string | undefined): AudioFormat {
  const match = /^pcm_(\d+)$/.exec(format ?? 'pcm_16000');
  if (!match) throw new Error(`ElevenLabs agent uses ${format} audio; set it to PCM in the agent's settings`);
  return { encoding: 'pcm_s16le', sampleRate: Number(match[1]) };
}

class ElevenLabsSession implements VoiceAgentSession {
  private closed = false;

  constructor(
    private readonly ws: WebSocket,
    readonly conversationId: string,
    readonly input: AudioFormat,
    readonly output: AudioFormat,
    private readonly onEvent: (event: VoiceAgentEvent) => void,
  ) {
    ws.addEventListener('message', (msg) => this.handle(parse(msg.data)));
    ws.addEventListener('close', (e) => this.end(e.reason || null), { once: true });
  }

  sendUserAudio(pcm: Uint8Array) {
    this.send({ user_audio_chunk: Buffer.from(pcm).toString('base64') });
  }

  sendContext(text: string) {
    this.send({ type: 'contextual_update', text });
  }

  close() {
    this.ws.close();
    this.end(null);
  }

  private handle(event: ServerEvent | undefined) {
    switch (event?.type) {
      case 'ping':
        return this.send({ type: 'pong', event_id: event.ping_event.event_id });
      case 'user_transcript':
        return this.onEvent({ type: 'user_transcript', text: event.user_transcription_event.user_transcript });
      case 'agent_response':
        return this.onEvent({ type: 'agent_response', text: event.agent_response_event.agent_response });
      case 'audio':
        return this.onEvent({ type: 'agent_audio', pcm: Buffer.from(event.audio_event.audio_base_64, 'base64') });
      case 'interruption':
        return this.onEvent({ type: 'interruption' });
    }
  }

  private end(reason: string | null) {
    if (this.closed) return;
    this.closed = true;
    this.onEvent({ type: 'closed', reason });
  }

  private send(payload: object) {
    if (this.ws.readyState !== WebSocket.OPEN) throw new Error('ElevenLabs session is not connected');
    this.ws.send(JSON.stringify(payload));
  }
}

function parse(data: unknown): ServerEvent | undefined {
  try {
    return JSON.parse(String(data)) as ServerEvent;
  } catch {
    return undefined;
  }
}

/** Opens the socket and waits for the conversation's metadata, which carries its audio formats. */
async function startSession(onEvent: (event: VoiceAgentEvent) => void): Promise<VoiceAgentSession> {
  const ws = new WebSocket(await getSignedUrl());
  const metadata = await new Promise<Extract<ServerEvent, { type: 'conversation_initiation_metadata' }>>((resolve, reject) => {
    const onOpen = () => ws.send(JSON.stringify({ type: 'conversation_initiation_client_data' }));
    const onMessage = (msg: MessageEvent) => {
      const event = parse(msg.data);
      if (event?.type !== 'conversation_initiation_metadata') return;
      stopListening();
      resolve(event);
    };
    const onError = () => fail('ElevenLabs WebSocket failed');
    const onClose = (e: CloseEvent) => fail(`ElevenLabs closed the conversation: ${e.reason || e.code}`);
    const fail = (message: string) => {
      stopListening();
      ws.close();
      reject(new Error(message));
    };
    const stopListening = () => {
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('message', onMessage);
      ws.removeEventListener('error', onError);
      ws.removeEventListener('close', onClose);
    };
    ws.addEventListener('open', onOpen);
    ws.addEventListener('message', onMessage);
    ws.addEventListener('error', onError);
    ws.addEventListener('close', onClose);
  });

  const { conversation_id, user_input_audio_format, agent_output_audio_format } = metadata.conversation_initiation_metadata_event;
  try {
    return new ElevenLabsSession(ws, conversation_id, parseFormat(user_input_audio_format), parseFormat(agent_output_audio_format), onEvent);
  } catch (err) {
    ws.close();
    throw err;
  }
}

export const elevenlabs: VoiceAgentProvider = {
  name: 'ElevenLabs',
  isConfigured: () => Boolean(config.elevenlabs.apiKey && config.elevenlabs.agentId),
  async verify() {
    await request(`/convai/agents/${encodeURIComponent(credentials().agentId)}`);
  },
  startSession,
};
