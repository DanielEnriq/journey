import type { CallTransport, SpeechSynthesizer } from './contract.js';

/**
 * Speaks one answer into the call, sentence by sentence, as the reasoning runtime streams it.
 *
 * The next sentences are synthesized while the current one plays, so there are no gaps between them.
 * Aborting the signal stops everything at once: synthesis, waiting, and playback (the caller clears
 * the call's queue).
 */

/** Sentences synthesized ahead of the one playing. */
const LOOKAHEAD = 2;

interface Say {
  text: string;
  chunks: Int16Array[];
  started: boolean;
  done: boolean;
  error: Error | null;
  changed: Signal;
}
export interface PlayerHooks {
  /** The first sound of the answer is going out. */
  onSpeaking(): void;
  /** A sentence starts playing. */
  onSay(text: string): void;
  /** A sentence couldn't be synthesized, even after a retry; the rest still play. */
  onError(error: Error): void;
}

export class SpeechPlayer {
  private readonly items: Say[] = [];
  private ended = false;
  private added = new Signal();
  private playing = 0;

  constructor(
    private readonly transport: CallTransport,
    private readonly synthesizer: SpeechSynthesizer,
    private readonly signal: AbortSignal,
    private readonly hooks: PlayerHooks,
  ) {}

  say(text: string) {
    if (this.ended || !text.trim()) return;
    this.items.push({ text, chunks: [], started: false, done: false, error: null, changed: new Signal() });
    this.pump();
    this.added.fire();
  }

  /** Nothing more will be added. */
  end() {
    this.ended = true;
    this.added.fire();
  }

  /** Plays everything, in order, until the end or an abort. Resolves true if it played to the end. */
  async run(): Promise<boolean> {
    const aborted = abortion(this.signal);
    let speaking = false;
    for (this.playing = 0; ; this.playing++) {
      while (this.playing >= this.items.length && !this.ended) {
        if ((await Promise.race([this.added.next(), aborted])) === ABORTED) return false;
      }
      const item = this.items[this.playing];
      if (!item) break;
      this.pump();
      for (let k = 0; ; ) {
        if (this.signal.aborted) return false;
        if (k < item.chunks.length) {
          if (!speaking) {
            this.hooks.onSpeaking();
            speaking = true;
          }
          if (k === 0) this.hooks.onSay(item.text);
          await this.transport.play(item.chunks[k++]);
          continue;
        }
        if (item.done || item.error) break;
        if ((await Promise.race([item.changed.next(), aborted])) === ABORTED) return false;
      }
      item.chunks.length = 0; // played; don't hold an answer's audio in memory
    }
    if (speaking && (await Promise.race([this.transport.playedOut(), aborted])) === ABORTED) return false;
    return !this.signal.aborted;
  }

  /** Starts synthesizing the sentences within LOOKAHEAD of the one playing. */
  private pump() {
    let ahead = 0;
    for (let i = this.playing; i < this.items.length && ahead <= LOOKAHEAD; i++) {
      const item = this.items[i];
      ahead++;
      if (!item.started) {
        item.started = true;
        void this.synthesize(item);
      }
    }
  }

  private async synthesize(item: Say) {
    for (let attempt = 1; ; attempt++) {
      try {
        for await (const chunk of this.synthesizer.synthesize(item.text, this.transport.outputRate, this.signal)) {
          item.chunks.push(chunk);
          item.changed.fire();
        }
        item.done = true;
        break;
      } catch (err) {
        // Retry a connection that failed before any audio; once some has played, a retry would repeat it.
        if (attempt < 2 && !item.chunks.length && !this.signal.aborted) continue;
        item.error = err instanceof Error ? err : new Error(String(err));
        if (!this.signal.aborted) this.hooks.onError(item.error);
        break;
      }
    }
    item.changed.fire();
  }
}

/** A repeatable wake-up: next() resolves on the following fire(). */
class Signal {
  private waiters: (() => void)[] = [];
  next(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  fire() {
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }
}

const ABORTED = Symbol('aborted');

function abortion(signal: AbortSignal): Promise<typeof ABORTED> {
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(ABORTED), { once: true }));
}
