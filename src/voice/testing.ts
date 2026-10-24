import type {
  CallTransport,
  RecognitionEvent,
  RecognitionStream,
  SpeechRecognizer,
  SpeechSynthesizer,
  TransportEvent,
} from './contract.js';

/**
 * In-memory stand-ins for the call and the speech providers, so the participant's turn-taking can be
 * tested without LiveKit or ElevenLabs. Real playback takes time, so FakeTransport "plays" at a
 * configurable speed and remembers what reached the call.
 */

export class FakeTransport implements CallTransport {
  readonly inputRate = 16000;
  readonly outputRate = 16000;
  /** Samples that went out to the call, per sentence of speech as it was queued. */
  readonly played: Int16Array[] = [];
  readonly attributes: Record<string, string>[] = [];
  cleared = 0;
  connected = false;
  private emit: (e: TransportEvent) => void = () => {};
  private queue = 0;
  private drained: (() => void)[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  /** `msPerChunk`: how long each played chunk takes to go out. */
  constructor(private readonly msPerChunk = 20) {}

  async connect(onEvent: (e: TransportEvent) => void) {
    this.emit = onEvent;
    this.connected = true;
  }

  send(e: TransportEvent) {
    this.emit(e);
  }

  async play(pcm: Int16Array) {
    this.played.push(pcm);
    this.queue++;
    this.timer ??= setInterval(() => {
      if (this.queue > 0) this.queue--;
      if (this.queue === 0) this.flush();
    }, this.msPerChunk);
  }

  playedOut() {
    if (this.queue === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.drained.push(resolve));
  }

  clear() {
    this.cleared++;
    this.queue = 0;
    this.flush();
  }

  async setAttributes(attributes: Record<string, string>) {
    this.attributes.push(attributes);
  }

  async disconnect() {
    this.connected = false;
    this.clear();
  }

  private flush() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const resolve of this.drained.splice(0)) resolve();
  }
}

/** A recognizer the test speaks through: `say(identity, …)` delivers recognition events to that person's stream. */
export class ScriptedRecognizer implements SpeechRecognizer {
  readonly name = 'scripted';
  readonly streams = new Map<string, { onEvent: (e: RecognitionEvent) => void; closed: boolean; received: number }>();
  opened = 0;
  /** Makes the next `open` calls fail. */
  failNext = 0;
  private order: string[] = [];

  /** The participant opens streams in the order speakers join; tests name them in that order. */
  expect(...identities: string[]) {
    this.order.push(...identities);
  }

  async open(_rate: number, onEvent: (e: RecognitionEvent) => void): Promise<RecognitionStream> {
    this.opened++;
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('recognizer unavailable');
    }
    const identity = this.order.shift() ?? `stream-${this.opened}`;
    const entry = { onEvent, closed: false, received: 0 };
    this.streams.set(identity, entry);
    return {
      send: (samples) => void (entry.received += samples.length),
      close: () => void (entry.closed = true),
    };
  }

  event(identity: string, e: RecognitionEvent) {
    const stream = this.streams.get(identity);
    if (!stream || stream.closed) throw new Error(`no open stream for ${identity}`);
    stream.onEvent(e);
  }
}

/** Each sentence becomes `chunks` chunks of a constant tone, so tests can see what was spoken and when. */
export class FakeSynthesizer implements SpeechSynthesizer {
  readonly name = 'fake';
  readonly said: string[] = [];
  readonly aborted: string[] = [];
  failures = 0;

  constructor(
    private readonly chunks = 3,
    private readonly delayMs = 5,
  ) {}

  async *synthesize(text: string, sampleRate: number, signal: AbortSignal): AsyncIterable<Int16Array> {
    if (this.failures > 0) {
      this.failures--;
      throw new Error('synthesis failed');
    }
    this.said.push(text);
    for (let i = 0; i < this.chunks; i++) {
      await new Promise((r) => setTimeout(r, this.delayMs));
      if (signal.aborted) {
        this.aborted.push(text);
        return;
      }
      yield new Int16Array(sampleRate / 50).fill(1000);
    }
  }
}

/** One 20 ms frame of loud (speaking) or quiet audio at 16 kHz. */
export function frame(loud: boolean): Int16Array {
  return new Int16Array(320).map((_, i) => (loud ? (i % 2 ? 4000 : -4000) : 0));
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Polls until `check` holds, or fails the test after `ms`. */
export async function until(check: () => boolean, ms = 2000, what = 'condition') {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await tick(5);
  }
}
