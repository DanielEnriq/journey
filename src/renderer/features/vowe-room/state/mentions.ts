// What an @ can point at, and how a picked mention is kept in a message. The field shows "@Dana Lee"; the
// record keeps "@[Dana Lee|person:<id>]", so a rename doesn't break old mentions and a reader can act on the
// thing it names. Pure: no Preact, no Journey globals.

export type MentionKind = 'agent' | 'person' | 'session' | 'decision' | 'part';

export interface MentionItem {
  kind: MentionKind;
  id: string;
  /** What the row and the token show. */
  label: string;
  /** The grey short key before the label (a branch, a decision's version), when there is one. */
  key?: string;
  /** Extra words matched by the query but not shown (a part's technology, a session's agent). */
  also?: string;
  /** People: here or on the call. Sessions: running, needs you, waiting, done. Decisions: their state. */
  state?: string;
}

export const MENTION = /@\[([^|\]]+)\|(agent|person|session|decision|part):([^\]]+)\]/g;

export const tokenOf = (m: Pick<MentionItem, 'kind' | 'id' | 'label'>) => `@[${m.label.replace(/[[\]|]/g, '')}|${m.kind}:${m.id}]`;

/** A message as people read it: every token back to "@Label". */
export const plainMentions = (text: string) => text.replace(MENTION, (_, label: string) => `@${label}`);

/** The mentions a message keeps, in order. */
export function mentionsIn(text: string): { kind: MentionKind; id: string; label: string }[] {
  return [...text.matchAll(MENTION)].map((m) => ({ label: m[1], kind: m[2] as MentionKind, id: m[3] }));
}

/**
 * The field's text with what was picked turned into tokens. Only "@Label" that was picked from the menu and
 * is still in the text becomes one; a typed "@Dana" that was never picked stays words. Longest labels first,
 * so "@Dana Lee" wins over "@Dana".
 */
export function encodeMentions(text: string, picked: readonly MentionItem[]): string {
  const seen = new Map<string, MentionItem>();
  for (const m of picked) seen.set(m.label, m);
  const labels = [...seen.keys()].sort((a, b) => b.length - a.length);
  if (!labels.length) return text;
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[\\s(])@(${labels.map(esc).join('|')})(?![\\w])`, 'g');
  return text.replace(re, (_, pre: string, label: string) => pre + tokenOf(seen.get(label)!));
}

/** The query being typed after an @ that starts a word, up to the caret; null when the caret isn't in one. */
export function queryAt(text: string, caret: number): { start: number; q: string } | null {
  const m = /(^|[\s(])@([^\s@[\]]{0,32})$/.exec(text.slice(0, caret));
  return m ? { start: caret - m[2].length - 1, q: m[2] } : null;
}

/** How well an item matches: the label's start, then a word's start, then anywhere (label, key, or also). 0: no match. */
export function score(m: MentionItem, q: string): number {
  if (!q) return 1;
  const s = q.toLowerCase(), label = m.label.toLowerCase();
  if (label.startsWith(s)) return 4;
  if (label.split(/[\s/_.-]+/).some((w) => w.startsWith(s))) return 3;
  if (label.includes(s)) return 2;
  return `${m.key ?? ''} ${m.also ?? ''}`.toLowerCase().includes(s) ? 1 : 0;
}

/** The best few of one section, in the section's own order where they score the same. */
export function rank(items: readonly MentionItem[], q: string, max = 4): MentionItem[] {
  return items.map((m, i) => ({ m, i, s: score(m, q) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.i - b.i).slice(0, max).map((x) => x.m);
}
