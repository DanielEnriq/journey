import { randomUUID } from 'node:crypto';
import { parseAddress } from './addressing.js';
import type {
  CallTransport,
  CanvasCommand,
  CanvasOutcome,
  CanvasRelay,
  ContextSource,
  RecognitionEvent,
  RecognitionStream,
  SpeechRecognizer,
  SpeechSynthesizer,
  Speaker,
  SpokenTurn,
  TransportEvent,
  VoiceReasoning,
  VoiceState,
} from './contract.js';
import { SpeechPlayer } from './player.js';
import { SentenceSplitter } from './sentences.js';

/**
 * Vowe as one more participant in a room's call: it hears each person separately, answers when
 * someone addresses it by name, speaks the answer into the call, and stops the moment someone talks
 * over it.
 *
 *   person's mic ─▶ CallTransport ─▶ one recognition stream per person ─▶ "Vowe, …"? ─▶ SpokenTurn
 *   SpokenTurn ─▶ VoiceReasoning ─▶ text ─▶ SentenceSplitter ─▶ SpeechPlayer ─▶ CallTransport ─▶ everyone
 *                                └▶ canvas command ─▶ CanvasRelay (the canvas engine applies it)
 *
 * One turn at a time. A new question, or anyone talking over Vowe, ends the current turn: its
 * speech stops and its reasoning request is aborted. Nothing is recorded: audio goes to the
 * recognizer and is dropped, and transcripts only leave as events.
 */

export interface VoiceTiming {
  /** After "Vowe?" alone, how long the same person has to say the question without the name again. */
  wakeWindowMs: number;
  /** How long after someone's last words their question counts as finished. */
  settleMs: number;
  /** Silence needed before Vowe starts an answer ("holding" until then). */
  floorMs: number;
  /**
   * Voice over Vowe that counts as an interruption. Pauses only slowly undo it, so a short "wait, wait"
   * counts, while a cough or a click does not.
   */
  bargeInMs: number;
  /** RMS (of 16-bit samples) above which a frame counts as voice. */
  voiceRms: number;
  /** Longest Vowe's speech waits for the canvas to show a command it described. */
  canvasWaitMs: number;
  /** Delays before reopening a person's recognition stream that failed, in order; then it gives up. */
  recognitionRetryMs: number[];
}

export const DEFAULT_TIMING: VoiceTiming = {
  wakeWindowMs: 6000,
  settleMs: 350,
  floorMs: 600,
  bargeInMs: 200,
  voiceRms: 600,
  canvasWaitMs: 2000,
  recognitionRetryMs: [250, 1000, 3000, 8000],
};

export type TurnOutcome = 'answered' | 'interrupted' | 'superseded' | 'refused' | 'failed' | 'requester-left' | 'stopped';

export type VoiceEvent =
  | { type: 'state'; state: VoiceState }
  /** Interim words from someone; for captions. */
  | { type: 'partial'; speaker: Speaker; text: string }
  /** A finished utterance, and whether it was said to Vowe. */
  | { type: 'heard'; speaker: Speaker; text: string; addressed: boolean }
  | { type: 'turn'; turn: SpokenTurn }
  /** A sentence Vowe starts saying. */
  | { type: 'say'; turnId: string; text: string }
  | { type: 'tool'; turnId: string; phase: 'started' | 'finished'; id: string; name: string; error?: string | null }
  | { type: 'canvas'; turnId: string; commandId: string; outcome: CanvasOutcome }
  | { type: 'interrupted'; turnId: string; by: string | null }
  | { type: 'turn-ended'; turnId: string; outcome: TurnOutcome }
  | { type: 'error'; scope: 'recognition' | 'synthesis' | 'reasoning' | 'canvas' | 'transport'; message: string; identity?: string }
  | { type: 'stopped'; reason: string | null };

export interface VoiceParticipantOptions {
  roomId: string;
  /** The person who brought Vowe into the call. Shown to everyone; it never borrows their model access. */
  summonedBy: Speaker;
  transport: CallTransport;
  recognizer: SpeechRecognizer;
  synthesizer: SpeechSynthesizer;
  reasoning: VoiceReasoning;
  canvas: CanvasRelay;
  context: ContextSource;
  timing?: Partial<VoiceTiming>;
  onEvent?(event: VoiceEvent): void;
}

interface Listener {
  speaker: Speaker;
  stream: RecognitionStream | null;
  opening: boolean;
  failures: number;
  retry: ReturnType<typeof setTimeout> | null;
  /** Said "Vowe" alone; the next words are the question. */
  wakeUntil: number;
  /** A question being said, waiting to see if there's more. */
  pending: { text: string; heard: string; timer: ReturnType<typeof setTimeout> | null } | null;
  lastVoiceAt: number;
  voicedMs: number;
}

interface Turn {
  turn: SpokenTurn;
  abort: AbortController;
  outcome: TurnOutcome | null;
}

export class VoiceParticipant {
  private readonly timing: VoiceTiming;
  private readonly listeners = new Map<string, Listener>();
  private current: Turn | null = null;
  private _state: VoiceState = 'listening';
  private running = false;
  private stopping: Promise<void> | null = null;

  constructor(private readonly o: VoiceParticipantOptions) {
    this.timing = { ...DEFAULT_TIMING, ...o.timing };
  }

  get state(): VoiceState {
    return this._state;
  }

  get activeTurn(): SpokenTurn | null {
    return this.current?.turn ?? null;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    await this.o.transport.connect((e) => this.onTransport(e));
    await this.publishState();
  }

  /** Someone talked over Vowe (or held the mic button to): stop speaking and drop the turn. */
  interrupt(by: string | null) {
    const current = this.current;
    if (!current) return;
    this.emit({ type: 'interrupted', turnId: current.turn.turnId, by });
    this.end(current, 'interrupted');
  }

  /** Leaves the call and releases everything: recognition streams, synthesis, the turn, the connection. */
  stop(reason: string | null = null): Promise<void> {
    this.stopping ??= this.shutdown(reason);
    return this.stopping;
  }

  private async shutdown(reason: string | null) {
    this.running = false;
    if (this.current) this.end(this.current, 'stopped');
    for (const l of this.listeners.values()) this.release(l);
    this.listeners.clear();
    await this.o.transport.disconnect().catch((err) => this.emit({ type: 'error', scope: 'transport', message: String(err) }));
    this.emit({ type: 'stopped', reason });
  }

  // ─── Hearing ───────────────────────────────────────────────────────────────

  private onTransport(e: TransportEvent) {
    if (!this.running) return;
    switch (e.type) {
      case 'speaker-joined':
        return this.listen(e.speaker);
      case 'speaker-left': {
        const l = this.listeners.get(e.identity);
        if (l) this.release(l);
        this.listeners.delete(e.identity);
        if (e.reason === 'left' && this.current?.turn.requester.identity === e.identity) this.end(this.current, 'requester-left');
        return;
      }
      case 'audio':
        return this.hear(e.identity, e.pcm.samples, e.pcm.sampleRate);
      case 'alone':
        void this.stop('Everyone left the call');
        return;
      case 'reconnecting':
      case 'reconnected':
        return;
      case 'disconnected':
        void this.stop(e.reason);
        return;
    }
  }

  private listen(speaker: Speaker) {
    const existing = this.listeners.get(speaker.identity);
    if (existing) {
      existing.speaker = speaker;
      if (!existing.stream && !existing.opening && !existing.retry) void this.open(existing);
      return;
    }
    const l: Listener = { speaker, stream: null, opening: false, failures: 0, retry: null, wakeUntil: 0, pending: null, lastVoiceAt: 0, voicedMs: 0 };
    this.listeners.set(speaker.identity, l);
    void this.open(l);
  }

  private async open(l: Listener) {
    l.opening = true;
    try {
      const stream = await this.o.recognizer.open(this.o.transport.inputRate, (e) => this.onRecognition(l, e));
      if (!this.running || this.listeners.get(l.speaker.identity) !== l) return stream.close();
      l.stream = stream;
      l.failures = 0;
    } catch (err) {
      this.recognitionFailed(l, err instanceof Error ? err.message : String(err), true);
    } finally {
      l.opening = false;
    }
  }

  private recognitionFailed(l: Listener, message: string, retryable: boolean) {
    l.stream?.close();
    l.stream = null;
    this.emit({ type: 'error', scope: 'recognition', identity: l.speaker.identity, message });
    const delay = this.timing.recognitionRetryMs[l.failures++];
    if (!retryable || delay === undefined || !this.running || this.listeners.get(l.speaker.identity) !== l) return;
    l.retry = setTimeout(() => {
      l.retry = null;
      if (this.running && this.listeners.get(l.speaker.identity) === l) void this.open(l);
    }, delay);
  }

  private release(l: Listener) {
    if (l.retry) clearTimeout(l.retry);
    if (l.pending?.timer) clearTimeout(l.pending.timer);
    l.retry = null;
    l.pending = null;
    l.stream?.close();
    l.stream = null;
  }

  private hear(identity: string, samples: Int16Array, sampleRate: number) {
    const l = this.listeners.get(identity);
    if (!l) return;
    l.stream?.send(samples);

    const voiced = rms(samples) >= this.timing.voiceRms;
    if (voiced) l.lastVoiceAt = Date.now();
    // Only voice over Vowe counts toward an interruption, not the question that came before it.
    if (this._state !== 'speaking') return;
    const frameMs = (samples.length / sampleRate) * 1000;
    l.voicedMs = voiced ? l.voicedMs + frameMs : Math.max(0, l.voicedMs - frameMs / 4);
    if (l.voicedMs >= this.timing.bargeInMs) {
      l.voicedMs = 0;
      this.interrupt(identity);
    }
  }

  private onRecognition(l: Listener, e: RecognitionEvent) {
    if (!this.running || this.listeners.get(l.speaker.identity) !== l) return;
    switch (e.type) {
      case 'partial':
        if (!e.text.trim()) return;
        this.emit({ type: 'partial', speaker: l.speaker, text: e.text });
        // Still talking: hold a pending question open until they finish.
        if (l.pending?.timer) {
          clearTimeout(l.pending.timer);
          l.pending.timer = null;
        }
        return;
      case 'final':
        return this.onUtterance(l, e.text.trim());
      case 'error':
        return this.recognitionFailed(l, e.message, e.retryable);
      case 'closed':
        if (l.stream) this.recognitionFailed(l, 'Recognition stream closed', true);
        return;
    }
  }

  /** Basic turn detection: a question is finished once its speaker has been quiet for settleMs. */
  private onUtterance(l: Listener, text: string) {
    if (!text) {
      if (l.pending) this.settle(l);
      return;
    }
    if (l.pending) {
      l.pending.text = join(l.pending.text, text);
      l.pending.heard = join(l.pending.heard, text);
      this.emit({ type: 'heard', speaker: l.speaker, text, addressed: true });
      return this.settle(l);
    }
    const address = parseAddress(text);
    const awaited = !address.addressed && Date.now() < l.wakeUntil;
    this.emit({ type: 'heard', speaker: l.speaker, text, addressed: address.addressed || awaited });
    if (!address.addressed && !awaited) return;
    const question = address.addressed ? address.question : text;
    if (!question) {
      l.wakeUntil = Date.now() + this.timing.wakeWindowMs;
      return;
    }
    l.wakeUntil = 0;
    l.pending = { text: question, heard: text, timer: null };
    this.settle(l);
  }

  private settle(l: Listener) {
    if (!l.pending) return;
    if (l.pending.timer) clearTimeout(l.pending.timer);
    l.pending.timer = setTimeout(() => {
      const pending = l.pending;
      l.pending = null;
      if (pending && this.running) void this.ask(l.speaker, pending.text, pending.heard);
    }, this.timing.settleMs);
  }

  // ─── Answering ─────────────────────────────────────────────────────────────

  private async ask(requester: Speaker, text: string, heard: string) {
    if (this.current) this.end(this.current, 'superseded');
    const abort = new AbortController();
    const turn: SpokenTurn = {
      turnId: randomUUID(),
      roomId: this.o.roomId,
      requester,
      text,
      heard,
      context: { selection: [], view: null },
      source: 'voice',
      at: new Date().toISOString(),
    };
    const current: Turn = { turn, abort, outcome: null };
    this.current = current;
    this.setState('thinking');

    const player = new SpeechPlayer(this.o.transport, this.o.synthesizer, abort.signal, {
      waitForFloor: (signal) => this.waitForFloor(signal),
      onSpeaking: () => this.setState('speaking'),
      onSay: (say) => this.emit({ type: 'say', turnId: turn.turnId, text: say }),
      onError: (err) => this.emit({ type: 'error', scope: 'synthesis', message: err.message }),
    });
    const playing = player.run();

    try {
      turn.context = await this.o.context.forRequester(requester.identity);
      this.emit({ type: 'turn', turn });
      const auth = await this.o.reasoning.authorize(requester);
      if (!auth.ok) {
        current.outcome = 'refused';
        player.say(auth.message);
      } else {
        current.outcome = await this.reason(current, player);
      }
    } catch (err) {
      if (!abort.signal.aborted) {
        current.outcome = 'failed';
        this.emit({ type: 'error', scope: 'reasoning', message: err instanceof Error ? err.message : String(err) });
        player.say('Sorry, I lost my train of thought. Could you ask again?');
      }
    }
    player.end();
    await playing;
    if (this.current === current) this.end(current, current.outcome ?? 'answered');
  }

  private async reason(current: Turn, player: SpeechPlayer): Promise<TurnOutcome> {
    const { turn, abort } = current;
    const splitter = new SentenceSplitter();
    let outcome: TurnOutcome = 'answered';
    for await (const e of this.o.reasoning.respond(turn, abort.signal)) {
      if (abort.signal.aborted) break;
      switch (e.type) {
        case 'text':
          for (const sentence of splitter.push(e.delta)) player.say(sentence);
          break;
        case 'tool':
          this.emit({ type: 'tool', turnId: turn.turnId, phase: e.phase, id: e.id, name: e.name, error: e.error });
          break;
        case 'canvas':
          for (const sentence of splitter.flush()) player.say(sentence);
          player.barrier(this.relay(turn, e.command));
          break;
        case 'done':
          if (e.stop === 'refused') outcome = 'refused';
          break;
        case 'error':
          outcome = e.code === 'failed' ? 'failed' : 'refused';
          this.emit({ type: 'error', scope: 'reasoning', message: e.message });
          for (const sentence of splitter.flush()) player.say(sentence);
          player.say(e.code === 'failed' ? 'Sorry, I couldn’t work that out just now.' : e.message);
          break;
      }
    }
    for (const sentence of splitter.flush()) player.say(sentence);
    return outcome;
  }

  /** Hands the command to the canvas engine; settles within canvasWaitMs either way. */
  private relay(turn: SpokenTurn, command: CanvasCommand): Promise<CanvasOutcome> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<CanvasOutcome>((resolve) => (timer = setTimeout(() => resolve('timeout'), this.timing.canvasWaitMs)));
    const applied = this.o.canvas.apply(command, turn).catch((err) => {
      this.emit({ type: 'error', scope: 'canvas', message: err instanceof Error ? err.message : String(err) });
      return 'rejected' as const;
    });
    return Promise.race([applied, timeout]).then((outcome) => {
      clearTimeout(timer);
      this.emit({ type: 'canvas', turnId: turn.turnId, commandId: command.id, outcome });
      return outcome;
    });
  }

  /** Vowe was asked, so it answers, but not over someone mid-sentence: it holds until a pause. */
  private async waitForFloor(signal: AbortSignal) {
    for (;;) {
      if (signal.aborted) return;
      const lastVoice = Math.max(0, ...[...this.listeners.values()].map((l) => l.lastVoiceAt));
      const wait = lastVoice + this.timing.floorMs - Date.now();
      if (wait <= 0) return;
      this.setState('holding');
      await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 100)));
    }
  }

  private end(current: Turn, outcome: TurnOutcome) {
    if (this.current !== current) return;
    this.current = null;
    current.abort.abort();
    if (outcome !== 'answered' && outcome !== 'refused' && outcome !== 'failed') this.o.transport.clear();
    this.emit({ type: 'turn-ended', turnId: current.turn.turnId, outcome });
    if (this.running) this.setState('listening');
  }

  // ─── Visible state ─────────────────────────────────────────────────────────

  private setState(state: VoiceState) {
    if (this._state === state) return;
    this._state = state;
    if (state === 'speaking') for (const l of this.listeners.values()) l.voicedMs = 0;
    this.emit({ type: 'state', state });
    void this.publishState();
  }

  /** Everyone in the call sees Vowe's state and who brought it in, through LiveKit attributes. */
  private publishState() {
    return this.o.transport
      .setAttributes({ 'vowe.state': this._state, 'vowe.summonedBy': this.o.summonedBy.identity, 'vowe.hearing': 'addressed-only' })
      .catch(() => {}); // cosmetic; the call carries on without it
  }

  private emit(event: VoiceEvent) {
    try {
      this.o.onEvent?.(event);
    } catch (err) {
      console.error('[voice] event listener failed:', err);
    }
  }
}

function join(a: string, b: string) {
  return a ? `${a} ${b}` : b;
}

export function rms(samples: Int16Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / samples.length);
}
