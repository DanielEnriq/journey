/**
 * Vowe's voice in a call: the three contracts it sits between, kept apart so each side can be swapped
 * or faked on its own.
 *
 *   LiveKit → Voice      CallTransport: who is in the call, their audio in, Vowe's audio out
 *   Voice → Reasoning    VoiceReasoning: a spoken turn in, streamed text / tool / canvas events out
 *   Reasoning → Canvas   CanvasRelay: Vowe hands the reasoning runtime's commands to the canvas engine
 *                        and waits on the outcome only to time its speech; it never draws.
 *
 * Plus the speech providers in between (SpeechRecognizer, SpeechSynthesizer). Everything here runs in a
 * trusted process (Electron main), never in a renderer, so provider credentials stay out of pages.
 */

// ─── Shared ──────────────────────────────────────────────────────────────────

/**
 * Vowe's turn state, in the room UI's words (renderer/features/room/types.ts AgentState):
 * listening, holding (has an answer, waiting for a pause), thinking, speaking.
 */
export type VoiceState = 'listening' | 'holding' | 'thinking' | 'speaking';

/** 16-bit signed little-endian mono PCM. */
export interface Pcm {
  samples: Int16Array;
  sampleRate: number;
}

/** A person in the call, as LiveKit names them: identity is their cloud user id. */
export interface Speaker {
  identity: string;
  name: string | null;
}

// ─── LiveKit → Voice ─────────────────────────────────────────────────────────

export type TransportEvent =
  /** A person's microphone is live and its audio is flowing to `onAudio`. */
  | { type: 'speaker-joined'; speaker: Speaker }
  /** Their audio stopped: muted, unpublished, or they left. */
  | { type: 'speaker-left'; identity: string; reason: 'muted' | 'left' }
  | { type: 'audio'; identity: string; pcm: Pcm }
  /** No person is left in the call (muted or not). */
  | { type: 'alone' }
  | { type: 'reconnecting' }
  | { type: 'reconnected' }
  /** The call is over for Vowe: it left, was removed, or the room closed. Nothing follows it. */
  | { type: 'disconnected'; reason: string | null };

export interface CallTransport {
  /** The rate `audio` events carry and `play` expects. */
  readonly inputRate: number;
  readonly outputRate: number;
  connect(onEvent: (event: TransportEvent) => void): Promise<void>;
  /** Queues Vowe's speech; resolves once it is queued, not played. */
  play(pcm: Int16Array): Promise<void>;
  /** Resolves when everything queued has been played (or was cleared). */
  playedOut(): Promise<void>;
  /** Drops queued speech now: an interruption. */
  clear(): void;
  /** Shown to everyone in the call (LiveKit participant attributes): Vowe's state and who brought it in. */
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

/** One person's speech, as it is recognized. One stream per speaker, so attribution is exact. */
export interface RecognitionStream {
  /** PCM at the rate passed to `open`. */
  send(samples: Int16Array): void;
  close(): void;
}

export interface SpeechRecognizer {
  readonly name: string;
  open(sampleRate: number, onEvent: (event: RecognitionEvent) => void): Promise<RecognitionStream>;
}

export interface SpeechSynthesizer {
  readonly name: string;
  /** Streams PCM at `sampleRate` for `text`; stops early, without throwing, when `signal` aborts. */
  synthesize(text: string, sampleRate: number, signal: AbortSignal): AsyncIterable<Int16Array>;
}

// ─── Voice → Reasoning ───────────────────────────────────────────────────────

/** A component on the canvas, by the canvas engine's stable id. */
export interface ComponentRef {
  id: string;
  /** How a person would name it ("Payment Worker"), if the canvas knows. */
  label?: string;
}

/** What the requester is looking at when they ask. */
export interface TurnContext {
  /** What they selected or circled, first = most recent. */
  selection: ComponentRef[];
  /** The canvas view they have open ("architecture", "failure-flow", …), if known. */
  view: string | null;
}

/** One spoken question, as it reaches the reasoning runtime. */
export interface SpokenTurn {
  turnId: string;
  roomId: string;
  /** Who asked, by LiveKit identity = cloud user id. Recognition is per speaker, so this is not a guess. */
  requester: Speaker;
  /** The question with the address ("Vowe, …") taken off. */
  text: string;
  /** Everything recognized, for the runtime's own judgment. */
  heard: string;
  context: TurnContext;
  source: 'voice';
  /** When the question finished, ISO 8601. */
  at: string;
}

/**
 * A canvas command, in the canvas engine's own schema (feat/mvp-canvas-engine). Voice passes it through
 * untouched and never interprets it beyond `id`, so it can't drift from the engine's schema.
 */
export interface CanvasCommand {
  id: string;
  [field: string]: unknown;
}

export type ReasoningEvent =
  /** More of the answer, to be spoken as it arrives. */
  | { type: 'text'; delta: string }
  | { type: 'tool'; phase: 'started' | 'finished'; id: string; name: string; error?: string | null }
  /** A visual change to request from the canvas engine; Vowe's next words wait for it briefly. */
  | { type: 'canvas'; command: CanvasCommand }
  | { type: 'done'; stop: 'answered' | 'refused' | 'truncated' | 'step-limit' }
  /** The runtime gave up. `unauthorized` and `unavailable` are said aloud; `failed` gets a short apology. */
  | { type: 'error'; code: 'unauthorized' | 'unavailable' | 'failed'; message: string };

export type Authorization = { ok: true } | { ok: false; code: 'unauthorized' | 'unavailable'; message: string };

export interface VoiceReasoning {
  readonly name: string;
  /**
   * Whether this runtime may answer `requester` with model access they are entitled to. Model allowances
   * are per person (Sign in with ChatGPT, API keys): a runtime must refuse rather than spend someone else's.
   */
  authorize(requester: Speaker): Promise<Authorization>;
  /** Answers one turn. Must stop promptly, without throwing, when `signal` aborts (an interruption). */
  respond(turn: SpokenTurn, signal: AbortSignal): AsyncIterable<ReasoningEvent>;
}

// ─── Reasoning → Canvas (observed) ───────────────────────────────────────────

export type CanvasOutcome = 'applied' | 'rejected' | 'timeout';

export interface CanvasRelay {
  /** Hands a command to the canvas engine; resolves when it reports applied or rejected. */
  apply(command: CanvasCommand, turn: SpokenTurn): Promise<Exclude<CanvasOutcome, 'timeout'>>;
}

/** What each person is looking at, from the canvas's shared state. */
export interface ContextSource {
  forRequester(identity: string): TurnContext | Promise<TurnContext>;
}
