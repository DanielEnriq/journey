import type { CallTransport, SpeechSynthesizer, VoiceState } from './contract.js';
import { SpeechPlayer } from './player.js';
import { SentenceSplitter } from './sentences.js';

/**
 * The runtime's VoiceOutput (renderer/shared/vowe-voice.ts), in main: one person's Vowe saying the
 * answer to their question into the call, as its own participant ("Vowe (for Daniel)"), never through
 * their microphone.
 *
 *   begin(turnId)       the turn started: Vowe is thinking
 *   say(turnId, delta)  streamed text, spoken a sentence at a time as soon as each is complete
 *   end(turnId)         nothing more: finish what's been said
 *   stop(turnId)        interrupted, cancelled or failed: silence now, drop what's unspoken
 *
 * One turn at a time. A begin for a new turn stops the one before it. Calls for any other turn are ignored.
 */

export interface VoweVoiceOptions {
  transport: CallTransport;
  synthesizer: SpeechSynthesizer;
  onState(state: VoiceState): void;
  /** A sentence Vowe starts saying, for captions. */
  onSay(turnId: string, text: string): void;
  onError(message: string): void;
}

interface Turn {
  id: string;
  abort: AbortController;
  splitter: SentenceSplitter;
  player: SpeechPlayer;
}

export class VoweVoice {
  private turn: Turn | null = null;
  private _state: VoiceState = 'listening';

  constructor(private readonly o: VoweVoiceOptions) {}

  get state(): VoiceState {
    return this._state;
  }

  begin(turnId: string) {
    if (this.turn?.id === turnId) return;
    this.stopCurrent();
    const abort = new AbortController();
    const turn: Turn = {
      id: turnId,
      abort,
      splitter: new SentenceSplitter(),
      player: new SpeechPlayer(this.o.transport, this.o.synthesizer, abort.signal, {
        onSpeaking: () => this.turn === turn && this.setState('speaking'),
        onSay: (text) => this.turn === turn && this.o.onSay(turnId, text),
        onError: (err) => this.o.onError(`Vowe couldn’t say part of its answer: ${err.message}`),
      }),
    };
    this.turn = turn;
    this.setState('thinking');
    void turn.player.run().then(() => {
      if (this.turn !== turn) return;
      this.turn = null;
      this.setState('listening');
    });
  }

  say(turnId: string, delta: string) {
    const turn = this.current(turnId);
    if (turn) for (const sentence of turn.splitter.push(delta)) turn.player.say(sentence);
  }

  end(turnId: string) {
    const turn = this.current(turnId);
    if (!turn) return;
    for (const sentence of turn.splitter.flush()) turn.player.say(sentence);
    turn.player.end();
  }

  stop(turnId: string) {
    if (this.current(turnId)) this.stopCurrent();
  }

  /** Stops whatever is being said (leaving the call). */
  stopCurrent() {
    const turn = this.turn;
    if (!turn) return;
    this.turn = null;
    turn.abort.abort();
    this.o.transport.clear();
    this.setState('listening');
  }

  private current(turnId: string): Turn | null {
    return this.turn?.id === turnId ? this.turn : null;
  }

  private setState(state: VoiceState) {
    if (state === this._state) return;
    this._state = state;
    this.o.onState(state);
  }
}
