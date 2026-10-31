import type { PersonId, Thread } from '../contracts/model.js';
import { plainMentions } from './mentions.js';

// Discuss's list, worked out without Preact: what each thread's first line says as plain text, and which section it
// sits in. A thread sits in one section only, the first that takes it.

/** A message as one plain line: mentions and part references by name, code and Markdown marks gone. */
export function preview(body: string): string {
  return plainMentions(body)
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/\[([^|\]]+)\|[^\]]+\]/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(^|\s)[#>]+\s/g, '$1')
    .replace(/(\*\*|__|\*|_)(\S[^*_]*?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();
}

export type SectionKey = 'needs' | 'here' | 'rest';
export interface Section { key: SectionKey; threads: Thread[] }

/**
 * Needs you (waiting on you, or an open suggestion), then what's here (about the selected part, or else about
 * something in the canvas's view), then everything else. Newest first within each; empty sections are left out.
 * `parts(t)` is what a thread touches on the canvas.
 */
export function sections(threads: Thread[], o: { me: PersonId; parts(t: Thread): string[]; focus?: string | null; view?: Set<string> | null }): Section[] {
  const needs = (t: Thread) => t.waiting === o.me || t.replies.some((r) => r.offer?.state === 'open');
  const here = (t: Thread) => {
    const ps = o.parts(t);
    return o.focus ? ps.includes(o.focus) : o.view ? ps.some((x) => o.view!.has(x)) : ps.length > 0;
  };
  const out: Record<SectionKey, Thread[]> = { needs: [], here: [], rest: [] };
  for (const t of [...threads].reverse()) out[needs(t) ? 'needs' : here(t) ? 'here' : 'rest'].push(t);
  return (['needs', 'here', 'rest'] as SectionKey[]).filter((k) => out[k].length).map((key) => ({ key, threads: out[key] }));
}
