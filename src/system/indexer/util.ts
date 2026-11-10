import { createHash } from 'node:crypto';
import type { SourceRange } from '../../shared/system/model.js';

// Small helpers the indexer passes share: hashing, line maps, stable ordering.

/** sha256 hex, first 16 chars: what `IndexedFile.hash` and `IndexSymbol.hash` carry. */
export const hash16 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex').slice(0, 16);

/** Offsets → 1-based line/col, for languages we read ourselves (SQL). */
export class LineMap {
  private starts: number[] = [0];
  constructor(readonly file: string, text: string) {
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) this.starts.push(i + 1);
  }
  pos(offset: number) {
    let lo = 0, hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return { line: lo + 1, col: offset - this.starts[lo] + 1 };
  }
  range(start: number, end: number): SourceRange {
    return { file: this.file, start: this.pos(start), end: this.pos(Math.max(start, end - 1)) };
  }
}

export const countLines = (text: string) => (text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0));

/** Collapses whitespace and caps length, for signatures, guards and attrs. */
export function oneLine(s: string, max = 240): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export const byString = cmp;

export function rangeKey(r: SourceRange): string {
  const p = (n: number) => String(n).padStart(6, '0');
  return `${r.file}:${p(r.start.line)}:${p(r.start.col)}:${p(r.end.line)}:${p(r.end.col)}`;
}

/** Sorts by a list of string keys, in order: every array in the index goes through this for determinism. */
export function sortBy<T>(items: T[], ...keys: ((t: T) => string)[]): T[] {
  return items.sort((a, b) => {
    for (const k of keys) {
      const c = cmp(k(a), k(b));
      if (c) return c;
    }
    return 0;
  });
}

/** JSON with object keys in sorted order, so equal indexes serialise byte-identically. */
export function stableStringify(v: unknown, indent?: number): string {
  return JSON.stringify(sortKeys(v), null, indent);
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortKeys(x);
    }
    return out;
  }
  return v;
}

export const toPosix = (p: string) => p.split('\\').join('/');
