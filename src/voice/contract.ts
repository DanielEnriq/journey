/**
 * Vowe's voice on one person's machine: the speech side of the runtime's VoiceAdapter
 * (renderer/shared/vowe-voice.ts, src/assistant/INTEGRATION.md → Voice). It never decides turns and
 * never reasons. It turns the local person's microphone into HumanSpeech for the adapter, and the
 * adapter's VoiceOutput calls into Vowe's audio in the call:
 *
 *   local mic (renderer) ─ PCM ─▶ Hearing ─ SpeechRecognizer ─▶ HumanSpeech ─▶ VoiceAdapter.hear
 *   VoiceAdapter ─ VoiceOutput ─▶ VoweVoice ─ SpeechSynthesizer ─▶ CallTransport ─▶ "Vowe (for Daniel)"
 *
 * Everything here runs in main, so the speech provider's credentials never reach a page.
 */

/**
 * What Vowe's voice is doing, in the room UI's words (renderer/features/room/types.ts AgentState).
 * `holding` isn't used: an answer starts as soon as it begins streaming.
 */
export type VoiceState = 'listening' | 'thinking' | 'speaking';

/** The local person's words, in the runtime's HumanSpeech shape (renderer/shared/vowe-voice.ts). */
export interface HeardSpeech {
  participant: { userId: string; name: string | null };
  text: string;
  /** False while they're still talking. Also sent, with text '…', the moment they talk over Vowe. */
  final: boolean;
  /** Set on every final: whether it was said to Vowe (see addressing.ts). */
  addressed?: boolean;
  at?: string;
}

// ─── The call: Vowe's own participant ────────────────────────────────────────

export type TransportEvent =
  /** The person this Vowe speaks for left the call, so it has no one to answer. */
  | { type: 'owner-left' }
  | { type: 'reconnecting' }
  | { type: 'reconnected' }
  /** The connection is over: Vowe left, was removed, or the room closed. Nothing follows it. */
  | { type: 'disconnected'; reason: string | null };

/** Publishes Vowe's speech to the room's call. It never subscribes: Vowe hears through the local microphone only. */
export interface CallTransport {
  /** The rate `play` expects. */
  readonly outputRate: number;
  connect(onEvent: (event: TransportEvent) => void): Promise<void>;
  /** Queues speech; resolves once it is queued, not played. */
  play(pcm: Int16Array): Promise<void>;
  /** Resolves when everything queued has been played (or was cleared). */
  playedOut(): Promise<void>;
  /** Drops queued speech now: an interruption. */
  clear(): void;
  /** Shown to everyone in the call (LiveKit participant attributes). */
  setAttributes(attributes: Record<string, string>): Promise<void>;
  disconnect(): Promise<void>;
}

// ─── Speech providers ────────────────────────────────────────────────────────

export type RecognitionEvent =
  /** Interim words, which may still change. */
  | { type: 'partial'; text: string }
  /** A finished stretch of speech (the provider's own end-of-speech detection). */
  | { type: 'final'; text: string }
  /** The stream failed; `retryable` says whether opening a new one may work. */
  | { type: 'error'; message: string; retryable: boolean }
  | { type: 'closed' };

export interface RecognitionStream {
  /** 16-bit mono PCM at the rate passed to `open`. */
  send(samples: Int16Array): void;
  close(): void;
}

export interface SpeechRecognizer {
  readonly name: string;
  open(sampleRate: number, onEvent: (event: RecognitionEvent) => void): Promise<RecognitionStream>;
}

export interface SpeechSynthesizer {
  readonly name: string;
  /** Streams 16-bit mono PCM at `sampleRate` for `text`; stops early, without throwing, when `signal` aborts. */
  synthesize(text: string, sampleRate: number, signal: AbortSignal): AsyncIterable<Int16Array>;
}
