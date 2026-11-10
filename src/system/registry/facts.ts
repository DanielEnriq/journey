import type {
  CallFlow, ComparisonSite, IndexedFile, IndexImport, IndexReference, IndexSymbol, LiteralSite, RepoIndex, SourceRange,
} from '../../shared/system/model.js';
import { byString } from '../../shared/system/registry-utils.js';

// The index, looked up the ways the rules need it. Nothing here decides anything about the system.

const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => { const l = m.get(k); if (l) l.push(v); else m.set(k, [v]); };

export const dirOf = (file: string) => (file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '');
export const baseOf = (file: string) => file.slice(file.lastIndexOf('/') + 1).replace(/\.(test\.)?[^.]+$/, '');

/** `a.ts#A.b.c` → `a.ts#A`. */
export function topOf(id: string): string {
  const i = id.indexOf('#');
  if (i < 0) return id;
  const name = id.slice(i + 1);
  const dot = name.indexOf('.');
  return dot < 0 ? id : id.slice(0, i + 1 + dot);
}

export const within = (r: SourceRange, outer: SourceRange) =>
  r.file === outer.file
  && (r.start.line > outer.start.line || (r.start.line === outer.start.line && r.start.col >= outer.start.col))
  && (r.end.line < outer.end.line || (r.end.line === outer.end.line && r.end.col <= outer.end.col));

export const before = (a: SourceRange, b: SourceRange) => a.start.line < b.start.line || (a.start.line === b.start.line && a.start.col < b.start.col);

export class Facts {
  readonly files = new Map<string, IndexedFile>();
  readonly symbols = new Map<string, IndexSymbol>();
  readonly inFile = new Map<string, IndexSymbol[]>();
  /** Members by container symbol id. */
  readonly members = new Map<string, IndexSymbol[]>();
  readonly refsFrom = new Map<string, IndexReference[]>();
  readonly refsTo = new Map<string, IndexReference[]>();
  readonly literalsIn = new Map<string, LiteralSite[]>();
  readonly literalsByValue = new Map<string, LiteralSite[]>();
  readonly literalsInFile = new Map<string, LiteralSite[]>();
  readonly comparisonsInFile = new Map<string, ComparisonSite[]>();
  readonly comparisonsByValue = new Map<string, ComparisonSite[]>();
  readonly flows = new Map<string, CallFlow>();
  readonly importsFrom = new Map<string, IndexImport[]>();
  readonly importsTo = new Map<string, IndexImport[]>();
  readonly sqlTables = new Map<string, IndexSymbol>();
  readonly sqlFunctions = new Map<string, IndexSymbol>();
  readonly tests = new Set<string>();

  constructor(readonly index: RepoIndex) {
    for (const f of index.files) { this.files.set(f.path, f); if (f.test || /\.test\.[cm]?[jt]sx?$|__tests__\//.test(f.path)) this.tests.add(f.path); }
    for (const s of index.symbols) {
      this.symbols.set(s.id, s);
      push(this.inFile, s.file, s);
      if (s.kind === 'sql-table') this.sqlTables.set(bareSqlName(s.name), s);
      if (s.kind === 'sql-function') this.sqlFunctions.set(bareSqlName(s.name), s);
    }
    for (const s of index.symbols) {
      const c = this.containerOf(s);
      if (c) push(this.members, c, s);
    }
    for (const r of index.references) { push(this.refsFrom, r.from, r); push(this.refsTo, r.to, r); }
    for (const l of index.literals) { push(this.literalsIn, l.in, l); push(this.literalsByValue, l.literal, l); push(this.literalsInFile, l.file, l); }
    for (const c of index.comparisons) { push(this.comparisonsInFile, c.file, c); push(this.comparisonsByValue, c.literal, c); }
    for (const f of index.flows) this.flows.set(f.symbol, f);
    for (const i of index.imports) { push(this.importsFrom, i.from, i); if (i.to) push(this.importsTo, i.to, i); }
  }

  /** The containing symbol's id, whether the index wrote an id or a bare name. */
  containerOf(s: IndexSymbol): string | undefined {
    if (s.container) {
      if (this.symbols.has(s.container)) return s.container;
      const guess = `${s.file}#${s.container}`;
      if (this.symbols.has(guess)) return guess;
    }
    const name = s.id.slice(s.id.indexOf('#') + 1);
    const dot = name.lastIndexOf('.');
    if (dot > 0) { const p = `${s.file}#${name.slice(0, dot)}`; if (this.symbols.has(p)) return p; }
    return undefined;
  }

  memberSymbols(id: string): IndexSymbol[] { return (this.members.get(id) ?? []).slice().sort((a, b) => byString(a.id, b.id)); }

  /** Every reference made from inside a symbol, its members' included. */
  refsWithin(id: string): IndexReference[] {
    const out = [...(this.refsFrom.get(id) ?? [])];
    for (const m of this.members.get(id) ?? []) out.push(...this.refsWithin(m.id));
    return out;
  }

  literalsWithin(id: string): LiteralSite[] {
    const out = [...(this.literalsIn.get(id) ?? [])];
    for (const m of this.members.get(id) ?? []) out.push(...this.literalsWithin(m.id));
    return out;
  }

  /** The innermost indexed symbol in `file` whose range contains `r`. */
  symbolAt(r: SourceRange): IndexSymbol | undefined {
    let best: IndexSymbol | undefined;
    for (const s of this.inFile.get(r.file) ?? []) {
      if (s.kind.startsWith('sql-') && s.kind !== 'sql-function') continue;
      if (within(r, s.range) && (!best || within(s.range, best.range))) best = s;
    }
    return best;
  }

  fileHash(file: string) { return this.files.get(file)?.hash; }
  isTest(file: string) { return this.tests.has(file); }
  status(file: string) { return this.files.get(file)?.status; }

  /** String-list attrs, tolerant of a JSON string or a comma list. */
  strings(s: IndexSymbol | undefined, key: string): string[] {
    const v = s?.attrs?.[key];
    if (Array.isArray(v)) return v.map(String);
    if (typeof v === 'string') { try { const p = JSON.parse(v); if (Array.isArray(p)) return p.map(String); } catch { /* not JSON */ } return v.split(',').map((x) => x.trim()).filter(Boolean); }
    return [];
  }

  /** The declared type of a field/parameter/variable, from its signature: `private queue: CanvasCommand[]` → `CanvasCommand[]`. */
  declaredType(s: IndexSymbol): string | undefined {
    const t = s.attrs?.type;
    if (typeof t === 'string') return t;
    const sig = s.signature ?? '';
    const m = /^[^(=]*?:\s*(.+?)(\s*=.*)?$/.exec(sig);
    return m?.[1]?.trim();
  }

  /** The return type written in a function's signature. */
  returnType(s: IndexSymbol): string | undefined {
    const t = s.attrs?.returns;
    if (typeof t === 'string') return t;
    const sig = s.signature ?? '';
    let depth = 0;
    for (let i = 0; i < sig.length; i++) {
      const c = sig[i];
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) { const m = /^\s*(?::|=>)\s*(.+)$/.exec(sig.slice(i + 1)); return m?.[1]?.replace(/\s*(\{|=>).*$/, '').trim(); } }
    }
    return undefined;
  }

  /** Union members or interface/object keys a symbol declares. */
  keysOf(s: IndexSymbol): string[] {
    for (const k of ['members', 'keys']) { const l = this.strings(s, k); if (l.length) return l; }
    if (s.kind === 'interface' || s.kind === 'class') return this.memberSymbols(s.id).map((m) => m.name);
    if (s.kind === 'type') {
      const sig = s.signature ?? '';
      const lits = [...sig.matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => m[1] ?? m[2]);
      if (lits.length >= 2 && /=\s*['"]|^\s*['"]|\|/.test(sig) && !/[{:]/.test(sig.replace(/'[^']*'|"[^"]*"/g, ''))) return lits;
      return this.memberSymbols(s.id).map((m) => m.name);
    }
    if (s.kind === 'variable') return this.memberSymbols(s.id).map((m) => m.name);
    return [];
  }
}

/** `public.room_canvases` → `room_canvases`. */
export const bareSqlName = (n: string) => n.replace(/^"?[a-z_]+"?\./i, '').replace(/"/g, '');
