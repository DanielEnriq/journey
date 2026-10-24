/**
 * Whether something said in the call was said to Vowe. People talk to each other far more than to
 * Vowe, so only an explicit address counts: its name at the start ("Vowe, what if this crashes?",
 * "Hey Vowe …") or at the end ("… after charging, Vowe?"). A name in the middle of a sentence is
 * people talking about Vowe, not to it.
 */

/**
 * "Vowe" as speech recognition writes it. Rhymes with "now"; recognizers that don't know the word
 * spell it as these. Kept to whole words, so "vowed" or "vowels" never match.
 */
const NAME = String.raw`(?:vowe|vow|voe|vau|vao|vowie)`;
/** Also heard for "Vowe" when it opens a question (Scribe, even with the keyterm); only counts there. */
const OPENING_NAME = String.raw`(?:${NAME}|whoa)`;
const GREETING = String.raw`(?:(?:hey|hi|okay|ok|so|um|uh|and)[\s,.]+)?`;
const LEADING = new RegExp(String.raw`^\s*${GREETING}${OPENING_NAME}\b[\s,.:;!?-]*`, 'i');
const TRAILING = new RegExp(String.raw`[\s,]+${NAME}[\s.!?]*$`, 'i');

export interface Address {
  /** Said to Vowe. */
  addressed: boolean;
  /** What to answer, without the name; empty when they only said the name and are still going. */
  question: string;
}

export function parseAddress(text: string): Address {
  const leading = LEADING.exec(text);
  if (leading) return { addressed: true, question: tidy(text.slice(leading[0].length)) };
  const trailing = TRAILING.exec(text);
  if (trailing && trailing.index > 0) return { addressed: true, question: tidy(text.slice(0, trailing.index)) };
  return { addressed: false, question: '' };
}

function tidy(text: string): string {
  const trimmed = text.trim().replace(/^[,.;:!-]+\s*/, '');
  return trimmed ? trimmed[0].toUpperCase() + trimmed.slice(1) : '';
}
