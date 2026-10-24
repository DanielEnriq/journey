import { config } from '../config.js';

/**
 * ElevenLabs Agents (realtime voice) integration path. Not wired into main yet.
 *
 * Shape of a call:
 *   engineers ⇄ calling agent (ElevenLabs: STT → LLM → TTS) ⇐ contextual updates ⇐ worker agent (any coding harness)
 *
 * The worker never speaks directly; it streams what it's doing into the call via
 * `sendContext`, which ElevenLabs folds into the agent's state without interrupting speech.
 *
 * Docs: https://elevenlabs.io/docs/eleven-agents/libraries/web-sockets
 */

const API = 'https://api.elevenlabs.io/v1';

/** Server → client events we care about; anything else arrives as `unknown`. */
export type AgentEvent =
  | { type: 'conversation_initiation_metadata'; conversation_initiation_metadata_event: { conversation_id: string } }
  | { type: 'user_transcript'; user_transcription_event: { user_transcript: string } }
  | { type: 'agent_response'; agent_response_event: { agent_response: string } }
  | { type: 'audio'; audio_event: { audio_base_64: string; event_id: number } }
  | { type: 'interruption'; interruption_event: { event_id: number } }
  | { type: 'ping'; ping_event: { event_id: number; ping_ms?: number } }
  | { type: string; [key: string]: unknown };

function elevenlabs() {
  const { apiKey, agentId } = config.elevenlabs;
  if (!apiKey || !agentId) throw new Error('ElevenLabs not configured — set ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID in .env');
  return { apiKey, agentId };
}

/** Short-lived (15 min) WebSocket URL for a private agent. Keeps the API key in the main process. */
export async function getSignedUrl(): Promise<string> {
  const { apiKey, agentId } = elevenlabs();
  const res = await fetch(`${API}/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`, {
    headers: { 'xi-api-key': apiKey },
  });
  if (!res.ok) throw new Error(`ElevenLabs signed URL failed: ${res.status} ${await res.text()}`);
  const { signed_url } = (await res.json()) as { signed_url: string };
  return signed_url;
}

export class CallSession {
  private ws: WebSocket | undefined;

  constructor(private readonly onEvent: (event: AgentEvent) => void) {}

  async connect(): Promise<void> {
    const ws = new WebSocket(await getSignedUrl());
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('ElevenLabs WebSocket failed to open')), { once: true });
    });
    ws.addEventListener('message', (msg) => this.handle(JSON.parse(String(msg.data)) as AgentEvent));
    this.send({ type: 'conversation_initiation_client_data' });
  }

  /** Non-interrupting context from the worker agent (progress, findings, diffs summarized). */
  sendContext(text: string) {
    this.send({ type: 'contextual_update', text });
  }

  /** Base64 PCM from the (eventually mixed) call audio. */
  sendUserAudio(base64Pcm: string) {
    this.send({ user_audio_chunk: base64Pcm });
  }

  close() {
    this.ws?.close();
    this.ws = undefined;
  }

  private handle(event: AgentEvent) {
    if (event.type === 'ping') {
      const { event_id } = (event as Extract<AgentEvent, { type: 'ping' }>).ping_event;
      this.send({ type: 'pong', event_id });
      return;
    }
    this.onEvent(event);
  }

  private send(payload: object) {
    if (this.ws?.readyState !== WebSocket.OPEN) throw new Error('Call is not connected');
    this.ws.send(JSON.stringify(payload));
  }
}
