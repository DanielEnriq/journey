import type { HeardSpeech } from '../../../shared/api.js';
import { Store } from '../../shared/store.js';

/**
 * The call's captions in this app: your own speech, as your Vowe hears it (recognition runs only while
 * it's in the call), and what your Vowe says. Other people's speech is recognized on their machines and
 * never reaches this one, so it isn't captioned here. Nothing is stored.
 *
 * Two lines, as the captions panel draws them: the one being said now, and the one before it.
 */

export interface CaptionLine {
  who: 'you' | 'vowe';
  text: string;
  /** Still being said: a partial that the next update replaces. */
  live: boolean;
  /** Vowe's sentences for one turn run on together in one line. */
  turnId?: string;
}

export interface CaptionsState {
  prev: CaptionLine | null;
  cur: CaptionLine | null;
}

/** Long lines keep their end, where the words are arriving. */
export const CAPTION_CHARS = 180;

export class Captions {
  readonly store = new Store<CaptionsState>({ prev: null, cur: null });

  /** Your speech (voice.onSpeech). The '…' that marks talking over Vowe isn't words, so it's skipped. */
  heard(speech: HeardSpeech) {
    const text = speech.text.trim();
    if (!text || text === '…') return;
    const { cur } = this.store.state;
    if (cur?.who === 'you' && cur.live) this.store.setState({ cur: { who: 'you', text, live: !speech.final } });
    else this.next({ who: 'you', text, live: !speech.final });
  }

  /** A sentence your Vowe starts saying (voice.onSaid). */
  said(turnId: string, sentence: string) {
    const text = sentence.trim();
    if (!text) return;
    const { cur } = this.store.state;
    if (cur?.who === 'vowe' && cur.turnId === turnId) this.store.setState({ cur: { ...cur, text: `${cur.text} ${text}` } });
    else this.next({ who: 'vowe', text, live: false, turnId });
  }

  clear() {
    this.store.setState({ prev: null, cur: null });
  }

  private next(line: CaptionLine) {
    const { cur } = this.store.state;
    this.store.setState({ prev: cur ? { ...cur, live: false } : this.store.state.prev, cur: line });
  }
}

/** A line's text as shown: its last CAPTION_CHARS characters, from a word boundary. */
export function captionText(text: string): string {
  if (text.length <= CAPTION_CHARS) return text;
  const tail = text.slice(-CAPTION_CHARS);
  if (text[text.length - CAPTION_CHARS - 1] === ' ') return '…' + tail; // cut exactly at a word
  const space = tail.indexOf(' ');
  return '…' + (space >= 0 ? tail.slice(space + 1) : tail);
}
