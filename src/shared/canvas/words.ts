import type { Component, Relationship } from './model.js';

// How the representations put a system into words: "Card charged again", "Charges #4182 as well."
// Everything they say comes from the document's names, labels and facts, never from a scenario script.

export const upperFirst = (t: string) => t.replace(/^\w/, (c) => c.toUpperCase());

/** "the provider" → "provider"; falls back to the name. */
export function nounOf(c: Component): string {
  return (c.short ?? c.name).replace(/^the\s+/i, '').toLowerCase();
}

/** "charge" → "charges", "publish" → "publishes", "retry" → "retries". */
export function third(verb: string): string {
  const [head, ...rest] = verb.split(' ');
  const v = /(s|sh|ch|x|z)$/.test(head) ? head + 'es' : /[^aeiou]y$/.test(head) ? head.slice(0, -1) + 'ies' : head + 's';
  return [v, ...rest].join(' ');
}

const IRREGULAR: Record<string, string> = { send: 'sent', write: 'wrote', pay: 'paid', run: 'ran', read: 'read', put: 'put', get: 'got', make: 'made' };

/** The relationship's verb in the past tense: its own `past`, or a regular guess. */
export function past(r: Relationship | undefined): string {
  if (!r) return 'done';
  if (r.past) return r.past;
  const verb = (r.label ?? r.kind).split(' ')[0];
  if (IRREGULAR[verb]) return IRREGULAR[verb];
  return verb.endsWith('e') ? verb + 'd' : /[^aeiou]y$/.test(verb) ? verb.slice(0, -1) + 'ied' : verb + 'ed';
}

/** "charge" → "charging", "send" → "sending". */
export const gerund = (verb: string) => (/[^e]e$/.test(verb) ? verb.slice(0, -1) : verb) + 'ing';

export const verbOf = (r: Relationship | undefined) => (r?.label ?? r?.kind ?? 'call').split(' ')[0];

const COUNT = ['none', 'one', 'two', 'three', 'four', 'five', 'six'];
export const countWord = (n: number) => COUNT[n] ?? String(n);
export const timesWord = (n: number) => n === 1 ? 'once' : n === 2 ? 'twice' : `${countWord(n)} times`;

export function plural(noun: string): string {
  return /(s|sh|ch|x|z)$/.test(noun) ? noun + 'es' : /[^aeiou]y$/.test(noun) ? noun.slice(0, -1) + 'ies' : noun + 's';
}

/** What a worker's running copies are called: worker-1, worker-2. */
export const instanceName = (c: Component, n: number) => `${c.facts?.instance ?? nounOf(c).split(' ').pop()}-${n}`;

/** Roughly how wide a wire label is at the canvas's 10.5px, for centring it in a gap. */
export const labelWidth = (t: string) => Math.round(t.length * 6.6 + 10);
