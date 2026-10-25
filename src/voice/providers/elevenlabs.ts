import type { RecognitionEvent, RecognitionStream, SpeechRecognizer, SpeechSynthesizer } from '../contract.js';

/**
 * Vowe's ears and voice on ElevenLabs, the speech provider the app is already configured for:
 * Scribe realtime for recognition and streaming text-to-speech for answers. Only speech: the
 * ElevenLabs agent's own LLM is never used, because Vowe's answers come from its reasoning runtime.
 *
 * Credentials never reach a renderer. Two ways in, chosen by the host (voice/host.ts):
 *   - `key`:  the ELEVENLABS_API_KEY in main's .env (local development)
 *   - `api`:  the Vowe API holds the key; it hands out single-use recognition tokens and speaks
 *             answers through POST /vowe/speech (server/src/vowe-voice.ts)
 *
 * Docs: https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime
 *       https://elevenlabs.io/docs/api-reference/text-to-speech/stream
 */

const API = 'https://api.elevenlabs.io/v1';
const REALTIME = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';

/** How speech providers are reached; see the header. */
export type ElevenLabsAccess =
  | { kind: 'key'; apiKey: string; voiceId: string; model: string }
  | {
      kind: 'api';
      /** POST /vowe/speech-token: a single-use Scribe token. */
      recognitionToken(): Promise<string>;
      /** POST /vowe/speech: streams PCM for `text`. */
      speak(text: string, sampleRate: number, signal: AbortSignal): Promise<Response>;
    };

/** Errors from Scribe that a fresh stream won't fix. */
const FATAL = new Set(['auth_error', 'quota_exceeded', 'unaccepted_terms', 'invalid_request']);
/** Audio is sent in ~100 ms pieces: fewer messages, still prompt partials. */
const SEND_MS = 100;

export async function singleUseToken(apiKey: string, type: 'realtime_scribe'): Promise<string> {
  const res = await fetch(`${API}/single-use-token/${type}`, { method: 'POST', headers: { 'xi-api-key': apiKey } });
  if (!res.ok) throw new Error(`ElevenLabs token failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { token: string }).token;
}

export class ElevenLabsRecognizer implements SpeechRecognizer {
  readonly name = 'ElevenLabs Scribe';

  constructor(
    private readonly access: ElevenLabsAccess,
    /** Words to bias recognition toward; Vowe's own name first. */
    private readonly keyterms: string[] = ['Vowe'],
  ) {}

  async open(sampleRate: number, onEvent: (event: RecognitionEvent) => void): Promise<RecognitionStream> {
    const token = this.access.kind === 'key' ? await singleUseToken(this.access.apiKey, 'realtime_scribe') : await this.access.recognitionToken();
    const url = new URL(REALTIME);
    url.searchParams.set('model_id', 'scribe_v2_realtime');
    url.searchParams.set('audio_format', `pcm_${sampleRate}`);
    url.searchParams.set('commit_strategy', 'vad');
    url.searchParams.set('vad_silence_threshold_secs', '0.6');
    url.searchParams.set('language_code', 'en');
    url.searchParams.set('enable_logging', 'false'); // no audio or transcripts kept on ElevenLabs' side
    for (const term of this.keyterms) url.searchParams.append('keyterms', term);
    url.searchParams.set('token', token);

    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const fail = (message: string) => (ws.close(), reject(new Error(message)));
      ws.addEventListener('message', function started(msg) {
        const event = parse(msg.data);
        if (event?.message_type === 'session_started') {
          ws.removeEventListener('message', started);
          resolve();
        } else if (event && 'error' in event) fail(`Scribe refused the stream: ${event.message_type}: ${event.error}`);
      });
      ws.addEventListener('error', () => fail('Scribe connection failed'), { once: true });
      ws.addEventListener('close', (e) => fail(`Scribe closed: ${e.reason || e.code}`), { once: true });
    });
    return new ScribeStream(ws, sampleRate, onEvent);
  }
}

type ScribeEvent = { message_type: string; text?: string; error?: string };

class ScribeStream implements RecognitionStream {
  private pending: Int16Array[] = [];
  private pendingSamples = 0;
  private closedByUs = false;

  constructor(
    private readonly ws: WebSocket,
    private readonly sampleRate: number,
    onEvent: (event: RecognitionEvent) => void,
  ) {
    ws.addEventListener('message', (msg) => {
      const event = parse(msg.data);
      if (!event) return;
      if (event.message_type === 'partial_transcript') onEvent({ type: 'partial', text: event.text ?? '' });
      else if (event.message_type === 'committed_transcript') onEvent({ type: 'final', text: event.text ?? '' });
      else if (typeof event.error === 'string') onEvent({ type: 'error', message: `${event.message_type}: ${event.error}`, retryable: !FATAL.has(event.message_type) });
    });
    ws.addEventListener('close', () => {
      if (!this.closedByUs) onEvent({ type: 'closed' });
    });
  }

  send(samples: Int16Array) {
    if (this.ws.readyState !== WebSocket.OPEN) return; // dropped: audio is never buffered beyond one piece
    this.pending.push(samples);
    this.pendingSamples += samples.length;
    if (this.pendingSamples < (this.sampleRate * SEND_MS) / 1000) return;
    const audio = concat(this.pending, this.pendingSamples);
    this.pending = [];
    this.pendingSamples = 0;
    this.ws.send(
      JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength).toString('base64'),
        commit: false,
        sample_rate: this.sampleRate,
      }),
    );
  }

  close() {
    this.closedByUs = true;
    this.pending = [];
    this.ws.close();
  }
}

export class ElevenLabsSynthesizer implements SpeechSynthesizer {
  readonly name = 'ElevenLabs';

  constructor(private readonly access: ElevenLabsAccess) {}

  async *synthesize(text: string, sampleRate: number, signal: AbortSignal): AsyncIterable<Int16Array> {
    let res: Response;
    try {
      res = this.access.kind === 'key' ? await this.request(this.access, text, sampleRate, signal) : await this.access.speak(text, sampleRate, signal);
    } catch (err) {
      if (signal.aborted) return;
      throw err;
    }
    if (!res.ok || !res.body) throw new Error(`Speech failed: ${res.status} ${await res.text().catch(() => '')}`);
    yield* pcmChunks(res.body, signal);
  }

  private request(access: Extract<ElevenLabsAccess, { kind: 'key' }>, text: string, sampleRate: number, signal: AbortSignal) {
    return speechRequest(access.apiKey, access.voiceId, access.model, text, sampleRate, signal);
  }
}

/** The ElevenLabs streaming request, shared with the Vowe API's proxy (server/src/vowe-voice.ts mirrors it). */
export function speechRequest(apiKey: string, voiceId: string, model: string, text: string, sampleRate: number, signal: AbortSignal) {
  return fetch(`${API}/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=pcm_${sampleRate}`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/pcm' },
    body: JSON.stringify({ text, model_id: model }),
    signal,
  });
}

/** A body of raw 16-bit PCM as Int16Array chunks, carrying an odd byte over to the next chunk. */
export async function* pcmChunks(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncIterable<Int16Array> {
  const reader = body.getReader();
  let carry: Uint8Array | null = null;
  try {
    for (;;) {
      const { done, value } = await reader.read().catch((err) => {
        if (signal.aborted) return { done: true as const, value: undefined };
        throw err;
      });
      if (done || signal.aborted) return;
      let bytes = value;
      if (carry) {
        bytes = new Uint8Array(carry.length + value.length);
        bytes.set(carry);
        bytes.set(value, carry.length);
        carry = null;
      }
      const even = bytes.length & ~1;
      if (even < bytes.length) carry = bytes.slice(even);
      if (!even) continue;
      const aligned = new Uint8Array(bytes.subarray(0, even)); // copy: Int16Array needs 2-byte alignment
      yield new Int16Array(aligned.buffer, 0, even / 2);
    }
  } finally {
    reader.releaseLock();
    if (signal.aborted) await body.cancel().catch(() => {});
  }
}

function concat(parts: Int16Array[], length: number): Int16Array {
  if (parts.length === 1) return parts[0];
  const out = new Int16Array(length);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function parse(data: unknown): ScribeEvent | undefined {
  try {
    return JSON.parse(String(data)) as ScribeEvent;
  } catch {
    return undefined;
  }
}

/**
 * Which voice Vowe speaks with: VOWE_VOICE_ID / VOWE_TTS_MODEL when set, otherwise the voice and model
 * already configured on the app's ElevenLabs agent (ELEVENLABS_AGENT_ID), so Vowe sounds the same everywhere.
 */
export async function agentVoice(apiKey: string, agentId: string | undefined): Promise<{ voiceId: string; model: string }> {
  const voiceId = process.env.VOWE_VOICE_ID;
  const model = process.env.VOWE_TTS_MODEL;
  if (voiceId && model) return { voiceId, model };
  if (!agentId) throw new Error('Set VOWE_VOICE_ID (and VOWE_TTS_MODEL), or ELEVENLABS_AGENT_ID to use its voice');
  const res = await fetch(`${API}/convai/agents/${encodeURIComponent(agentId)}`, { headers: { 'xi-api-key': apiKey } });
  if (!res.ok) throw new Error(`ElevenLabs agent lookup failed: ${res.status}`);
  const tts = ((await res.json()) as { conversation_config?: { tts?: { voice_id?: string; model_id?: string } } }).conversation_config?.tts;
  if (!(voiceId ?? tts?.voice_id)) throw new Error('The ElevenLabs agent has no voice; set VOWE_VOICE_ID');
  return { voiceId: voiceId ?? tts!.voice_id!, model: model ?? tts?.model_id ?? 'eleven_flash_v2_5' };
}
