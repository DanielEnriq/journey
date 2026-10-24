/**
 * Turns an answer streaming in as text deltas into sentences to speak, so Vowe starts talking after
 * the first sentence rather than the whole answer, and reads it the way a person would say it.
 */

/** Short pieces sound choppy; shorter sentences wait to join the next one. */
const MIN_CHARS = 24;
const BOUNDARY = /[.!?…]+["')\]]*(?=\s)|\n+/g;

export class SentenceSplitter {
  private buffer = '';

  /** Adds a delta; returns the sentences it completed. */
  push(delta: string): string[] {
    this.buffer += delta;
    const out: string[] = [];
    let start = 0;
    BOUNDARY.lastIndex = 0;
    for (let m = BOUNDARY.exec(this.buffer); m; m = BOUNDARY.exec(this.buffer)) {
      const end = m.index + m[0].length;
      if (end - start < MIN_CHARS && m[0][0] !== '\n') continue;
      const sentence = spoken(this.buffer.slice(start, end));
      if (sentence) out.push(sentence);
      start = end;
    }
    this.buffer = this.buffer.slice(start);
    return out;
  }

  /** What is left once the answer is complete. */
  flush(): string[] {
    const rest = spoken(this.buffer);
    this.buffer = '';
    return rest ? [rest] : [];
  }
}

/**
 * Text written for a screen, made sayable: no Markdown marks, bullets, or code ticks, and evidence
 * citations ("session 1a2b3c4d #42", short hashes) left to the canvas and the record, not read out.
 */
export function spoken(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`session [0-9a-f]{6,} #\d+`/gi, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, '')
    .replace(/^#+\s*/gm, '')
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1')
    .replace(/\(\s*\)/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();
}
