import { parseAddress } from './addressing.js';
import type { HeardSpeech, RecognitionEvent, RecognitionStream, SpeechRecognizer } from './contract.js';

/**
 * The local person's speech, from their own microphone only: whoever is signed in here is who's
 * talking, so attribution never depends on telling voices apart. Other people's speech is heard on
 * their own machines, and nobody's Vowe is ever transcribed.
 *
 * It turns recognition into HumanSpeech for the runtime's VoiceAdapter, which decides turns:
 *   - partials while they talk, for captions and so the adapter can stop Vowe;
 *   - finals marked `addressed` when said to Vowe, the name normalized to "Vowe, …" so the adapter's
 *     wake word matches however the recognizer spelled it ("Voe", "Vow"), at the start or the end;
 *     "Vowe?" on its own, then the question, counts as one address;
 *   - while Vowe is speaking, only sustained voice counts: the first sign is '…' (an interruption),
 *     and nothing is passed on before that, so Vowe's own voice leaking past echo cancellation can't
 *     interrupt it or be taken for the person.
 *
 * Audio goes to the recognizer and is dropped. Nothing is recorded.
 */

export interface HearingTiming {
  /** After "Vowe?" alone, how long they have to say the question. */
  wakeWindowMs: number;
  /** How long an addressed question waits for more words before it's passed on. */
  settleMs: number;
  /**
   * Voice over Vowe that counts as an interruption. Pauses undo it only slowly, so a short "wait, wait"
   * counts, while a cough or a click does not.
   */
  bargeInMs: number;
  /** RMS (of 16-bit samples) above which a frame counts as voice. */
  voiceRms: number;
  /** Delays before reopening recognition that failed, in order; then it gives up. */
  recognitionRetryMs: number[];
}

export const DEFAULT_HEARING: HearingTiming = {
  wakeWindowMs: 6000,
  settleMs: 350,
  bargeInMs: 200,
  voiceRms: 600,
  recognitionRetryMs: [250, 1000, 3000, 8000],
};

export const HEARING_RATE = 16000;

export interface HearingOptions {
  /** The person signed in here, by cloud user id: the only person this hears. */
  self: { userId: string; name: string | null };
  recognizer: SpeechRecognizer;
  timing?: Partial<HearingTiming>;
  onSpeech(speech: HeardSpeech): void;
  onError(message: string): void;
}

export class Hearing {
  private readonly timing: HearingTiming;
  private stream: RecognitionStream | null = null;
  private opening: Promise<void> | null = null;
  private failures = 0;
  /** Bumped per stream opened, so a replaced stream's late events are ignored. */
  private generation = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  /** Said "Vowe" alone; the next words are the question. */
  private wakeUntil = 0;
  private pending: { text: string; timer: ReturnType<typeof setTimeout> | null } | null = null;
  private voweSpeaking = false;
  private voicedMs = 0;
  /** They talked over Vowe while it was speaking, so what they say is theirs, not an echo. */
  private bargedIn = false;

  constructor(private readonly o: HearingOptions) {
    this.timing = { ...DEFAULT_HEARING, ...o.timing };
  }

  async start() {
    if (this.running) return;
    this.running = true;
    await this.open();
  }

  stop() {
    this.running = false;
    this.generation++;
    if (this.retry) clearTimeout(this.retry);
    if (this.pending?.timer) clearTimeout(this.pending.timer);
    this.retry = null;
    this.pending = null;
    this.stream?.close();
    this.stream = null;
  }

  /** Vowe started or stopped speaking for this person. */
  setVoweSpeaking(speaking: boolean) {
    if (speaking === this.voweSpeaking) return;
    this.voweSpeaking = speaking;
    this.voicedMs = 0;
    this.bargedIn = false;
  }

  /** 16 kHz mono PCM from the local microphone. */
  audio(samples: Int16Array) {
    if (!this.running) return;
    // Recognition closes when it gets no audio (you were muted) and retrying then only closes again, so
    // the next audio reopens it: unmuting is enough for Vowe to hear you again.
    if (!this.stream && !this.retry) void this.open();
    this.stream?.send(samples);
    // Only voice over Vowe counts toward an interruption, not the question that came before it.
    if (!this.voweSpeaking || this.bargedIn) return;
    const frameMs = (samples.length / HEARING_RATE) * 1000;
    const voiced = rms(samples) >= this.timing.voiceRms;
    this.voicedMs = voiced ? this.voicedMs + frameMs : Math.max(0, this.voicedMs - frameMs / 4);
    if (this.voicedMs >= this.timing.bargeInMs) {
      this.bargedIn = true;
      this.speech({ text: '…', final: false });
    }
  }

  private open(): Promise<void> {
    this.opening ??= (async () => {
      try {
        const generation = ++this.generation;
        const stream = await this.o.recognizer.open(HEARING_RATE, (e) => generation === this.generation && this.onRecognition(e));
        if (!this.running) return stream.close();
        this.stream = stream;
        this.failures = 0;
      } catch (err) {
        this.failed(err instanceof Error ? err.message : String(err), true);
      } finally {
        this.opening = null;
      }
    })();
    return this.opening;
  }

  private failed(message: string, retryable: boolean) {
    this.generation++;
    this.stream?.close();
    this.stream = null;
    this.o.onError(`Speech recognition: ${message}`);
    const delay = this.timing.recognitionRetryMs[this.failures++];
    if (!retryable || delay === undefined || !this.running) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      if (this.running) void this.open();
    }, delay);
  }

  private onRecognition(e: RecognitionEvent) {
    if (!this.running) return;
    switch (e.type) {
      case 'partial': {
        const text = e.text.trim();
        if (!text || (this.voweSpeaking && !this.bargedIn)) return;
        // Still talking: hold an addressed question open until they finish.
        if (this.pending?.timer) {
          clearTimeout(this.pending.timer);
          this.pending.timer = null;
        }
        return this.speech({ text, final: false });
      }
      case 'final':
        if (this.voweSpeaking && !this.bargedIn) return;
        return this.utterance(e.text.trim());
      case 'error':
        return this.failed(e.message, e.retryable);
      case 'closed':
        if (this.stream) this.failed('the stream closed', true);
        return;
    }
  }

  private utterance(text: string) {
    if (this.pending) {
      if (text) this.pending.text = `${this.pending.text} ${text}`;
      return this.settle();
    }
    if (!text) return;
    const address = parseAddress(text);
    const awaited = !address.addressed && Date.now() < this.wakeUntil;
    if (!address.addressed && !awaited) return this.speech({ text, final: true, addressed: false });
    const question = address.addressed ? address.question : text;
    if (!question) {
      this.wakeUntil = Date.now() + this.timing.wakeWindowMs;
      return;
    }
    this.wakeUntil = 0;
    this.pending = { text: question, timer: null };
    this.settle();
  }

  private settle() {
    const pending = this.pending;
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      this.pending = null;
      if (this.running) this.speech({ text: `Vowe, ${pending.text}`, final: true, addressed: true });
    }, this.timing.settleMs);
  }

  private speech(s: Omit<HeardSpeech, 'participant' | 'at'>) {
    this.o.onSpeech({ participant: this.o.self, ...s, at: new Date().toISOString() });
  }
}

export function rms(samples: Int16Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / samples.length);
}
