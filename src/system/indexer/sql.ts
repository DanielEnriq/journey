import type { FileStatus, IndexReference, IndexSymbol, ReferenceKind } from '../../shared/system/model.js';
import { hash16, LineMap, oneLine } from './util.js';

// A small, honest reader for Supabase migrations: not a SQL grammar. It splits each file into statements
// (respecting quotes, dollar-quoted bodies and comments), recognises the statement shapes migrations use,
// and replays them in filename order so the result is the schema after the last migration:
//
//   create table / alter table / drop table        → sql-table symbols with sql-column children
//   create [or replace] function / drop function   → sql-function (params, returns, language, security definer)
//   create / alter / drop policy                   → sql-policy on its table
//   create [unique] index / drop index             → sql-index on its table
//   create type … as enum / alter type add value   → type with attrs.members
//   create trigger … on t … execute function f()   → sql-call reference from the table to the function
//   insert into / update / delete from             → sql-write references (in functions, policies, top level)
//   select … from / join                           → sql-read references
//
// A symbol's id names the migration that created it (`<file>#public.room_canvases`); a column added later
// by `alter table` carries the file that added it. A function's id names the migration that last defined it.

export const SQL_TOOL = 'vowe-sql/1';

export const SQL_LIMITS = [
  'SQL is read statement by statement with patterns, not a full grammar: views, rules, sequences and composite types are listed only, and unusual syntax may be missed',
  'only supabase/migrations/*.sql are read (in filename order); other .sql files are listed, not parsed',
  'table reads and writes inside SQL bodies are found by pattern (`insert into`, `update`, `delete from`, `from`/`join`) and only kept when they name a table the migrations define; dynamic SQL (`execute format(…)`) is not followed',
  'foreign keys are recorded as column attrs (`references`), not as references',
];

export interface SqlFileInput { path: string; text: string }
export interface SqlPassOutput {
  symbols: IndexSymbol[];
  references: IndexReference[];
  files: Map<string, { status: FileStatus; note?: string }>;
}

interface Stmt { start: number; end: number; text: string }

/** Replaces comments with spaces (keeping newlines and offsets) and splits at top-level semicolons. */
export function splitStatements(src: string): Stmt[] {
  const chars = src.split('');
  const out: Stmt[] = [];
  let i = 0, start = 0;
  const blank = (a: number, b: number) => { for (let k = a; k < b; k++) if (chars[k] !== '\n') chars[k] = ' '; };
  while (i < src.length) {
    const c = src[i];
    if (c === '-' && src[i + 1] === '-') { const e = src.indexOf('\n', i); const end = e < 0 ? src.length : e; blank(i, end); i = end; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? src.length : e + 2; blank(i, end); i = end; continue; }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < src.length) { if (src[j] === c) { if (src[j + 1] === c) { j += 2; continue; } break; } j++; }
      i = j + 1; continue;
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_][\w]*)?\$/.exec(src.slice(i, i + 64));
      if (m) {
        const e = src.indexOf(m[0], i + m[0].length);
        i = e < 0 ? src.length : e + m[0].length;
        continue;
      }
    }
    if (c === ';') { out.push({ start, end: i, text: chars.slice(start, i).join('') }); start = i + 1; }
    i++;
  }
  if (src.slice(start).trim()) out.push({ start, end: src.length, text: chars.slice(start).join('') });
  // Trim leading whitespace but keep offsets right.
  return out.map((s) => {
    const lead = s.text.length - s.text.trimStart().length;
    return { start: s.start + lead, end: s.end, text: s.text.slice(lead).trimEnd() };
  }).filter((s) => s.text.length > 0);
}

const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*)`;
const QN = String.raw`(${IDENT}(?:\s*\.\s*${IDENT})?)`;
const unq = (s: string) => (s.startsWith('"') ? s.slice(1, -1).replace(/""/g, '"') : s.toLowerCase());
function qualify(raw: string): string {
  const parts = raw.split(/\s*\.\s*(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((p) => unq(p.trim()));
  return parts.length === 1 ? `public.${parts[0]}` : `${parts[0]}.${parts[1]}`;
}

/** Index of the paren closing the one at `open`, skipping strings. */
function matchParen(t: string, open: number): number {
  let depth = 0;
  for (let i = open; i < t.length; i++) {
    const c = t[i];
    if (c === "'" || c === '"') { let j = i + 1; while (j < t.length && !(t[j] === c && t[j + 1] !== c)) j += t[j] === c ? 2 : 1; i = j; continue; }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return -1;
}

/** Top-level comma split with offsets relative to `t`. */
function splitTop(t: string): { text: string; at: number }[] {
  const out: { text: string; at: number }[] = [];
  let depth = 0, from = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === "'" || c === '"') { let j = i + 1; while (j < t.length && !(t[j] === c && t[j + 1] !== c)) j += t[j] === c ? 2 : 1; i = j; continue; }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) { out.push({ text: t.slice(from, i), at: from }); from = i + 1; }
  }
  out.push({ text: t.slice(from), at: from });
  return out.map((p) => {
    const lead = p.text.length - p.text.trimStart().length;
    return { text: p.text.trim(), at: p.at + lead };
  }).filter((p) => p.text);
}

/** Blanks string literals (keeping offsets) so words inside messages aren't read as SQL. */
const maskStrings = (t: string) => t.replace(/'(?:[^']|'')*'/g, (m) => "'" + ' '.repeat(m.length - 2) + "'");

const COL_STOP = /\s(not\s+null|null|default|primary\s+key|references|check|unique|generated|collate|constraint)\b/i;

interface RawRef { from: string; kind: ReferenceKind; name: string; file: string; start: number; end: number; call: boolean }

export function runSqlPass(inputs: SqlFileInput[]): SqlPassOutput {
  const syms = new Map<string, IndexSymbol>();
  const tables = new Map<string, string>(); // qualified name → id
  const columns = new Map<string, Map<string, string>>(); // table id → column → id
  const functions = new Map<string, string>();
  const policies = new Map<string, string>(); // `${tableId}|${name}` → id
  const indexes = new Map<string, string>();
  const types = new Map<string, string>();
  const raw: RawRef[] = [];
  const files = new Map<string, { status: FileStatus; note?: string }>();
  const lines = new Map<string, LineMap>();

  const remove = (id: string | undefined) => {
    if (!id) return;
    syms.delete(id);
    for (const [k, v] of columns.get(id) ?? []) { syms.delete(v); void k; }
    columns.delete(id);
  };

  for (const { path: file, text: src } of [...inputs].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const lm = new LineMap(file, src);
    lines.set(file, lm);
    const notUnderstood: string[] = [];
    const fileId = `${file}#`;
    const range = (a: number, b: number) => lm.range(a, b);
    const mk = (id: string, name: string, kind: IndexSymbol['kind'], a: number, b: number, text: string, extra: Partial<IndexSymbol>): IndexSymbol => {
      const s: IndexSymbol = { id, name, kind, file, range: range(a, b), exported: true, hash: hash16(oneLine(text, 1e6)), ...extra };
      syms.set(id, s);
      return s;
    };
    const scanBody = (from: string, body: string, at: number) => {
      const t = maskStrings(body);
      const push = (kind: ReferenceKind, name: string, s: number, e: number, call = false) => raw.push({ from, kind, name, file, start: at + s, end: at + e, call });
      let m: RegExpExecArray | null;
      const re = (s: string) => new RegExp(s, 'gi');
      for (const r = re(String.raw`\binsert\s+into\s+${QN}`); (m = r.exec(t));) push('sql-write', m[1], m.index, m.index + m[0].length);
      for (const r = re(String.raw`\bdelete\s+from\s+(?:only\s+)?${QN}`); (m = r.exec(t));) push('sql-write', m[1], m.index, m.index + m[0].length);
      for (const r = re(String.raw`\bupdate\s+(?:only\s+)?${QN}`); (m = r.exec(t));) {
        const before = t.slice(Math.max(0, m.index - 12), m.index);
        if (/\b(do|for|on)\s+$/i.test(before)) continue; // on conflict do update, for update, on update cascade
        push('sql-write', m[1], m.index, m.index + m[0].length);
      }
      for (const r = re(String.raw`\b(from|join)\s+(?:only\s+)?${QN}(\s*\()?`); (m = r.exec(t));) {
        const before = t.slice(Math.max(0, m.index - 12), m.index);
        if (m[1].toLowerCase() === 'from' && /\b(delete|distinct)\s+$/i.test(before)) continue;
        if (m[3]) continue; // a set-returning function, handled as a call
        push('sql-read', m[2], m.index, m.index + m[0].length);
      }
      for (const r = re(String.raw`${QN}\s*\(`); (m = r.exec(t));) push('sql-call', m[1], m.index, m.index + m[0].length - 1, true);
    };

    for (const st of splitStatements(src)) {
      const t = st.text;
      const at = st.start;
      let m: RegExpExecArray | null;

      if ((m = new RegExp(String.raw`^create\s+(?:(?:global\s+|local\s+)?(?:temporary|temp)\s+|unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?${QN}\s*\(`, 'i').exec(t))) {
        const q = qualify(m[1]);
        const open = m.index + m[0].length - 1;
        const close = matchParen(t, open);
        if (close < 0) { notUnderstood.push(oneLine(t, 60)); continue; }
        remove(tables.get(q));
        const id = `${file}#${q}`;
        const cols = new Map<string, string>();
        const pk: string[] = [];
        const colNames: string[] = [];
        const table = mk(id, q.split('.')[1], 'sql-table', at, st.end, t, { signature: oneLine(`create table ${q}`), attrs: { schema: q.split('.')[0] } });
        for (const item of splitTop(t.slice(open + 1, close))) {
          const itemAt = at + open + 1 + item.at;
          const pkm = /^(?:constraint\s+\S+\s+)?primary\s+key\s*\(([^)]*)\)/i.exec(item.text);
          if (pkm) { pk.push(...pkm[1].split(',').map((c) => unq(c.trim()))); continue; }
          if (/^(constraint|unique|check|foreign\s+key|exclude|primary\s+key|like)\b/i.test(item.text)) continue;
          const col = addColumn(item.text, itemAt, id, q, cols);
          if (col) { colNames.push(col.name); if (col.attrs?.primaryKey) pk.push(col.name); }
        }
        table.attrs = { ...table.attrs, columns: colNames, ...(pk.length ? { primaryKey: pk } : {}) };
        tables.set(q, id);
        columns.set(id, cols);
        continue;
      }

      if ((m = new RegExp(String.raw`^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${QN}\s+([\s\S]*)$`, 'i').exec(t))) {
        const q = qualify(m[1]);
        const id = tables.get(q);
        if (!id) continue; // a table these migrations don't define (auth.users…)
        const table = syms.get(id)!;
        const cols = columns.get(id)!;
        const actionsAt = m.index + m[0].length - m[2].length;
        for (const act of splitTop(m[2])) {
          const a = act.text;
          let am: RegExpExecArray | null;
          if ((am = /^add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?/i.exec(a)) && !/^add\s+(constraint|primary|unique|check|foreign|exclude)\b/i.test(a)) {
            const def = a.slice(am[0].length);
            const col = addColumn(def, at + actionsAt + act.at + am[0].length, id, q, cols);
            if (col) table.attrs = { ...table.attrs, columns: [...((table.attrs?.columns as string[]) ?? []), col.name] };
          } else if ((am = /^add\s+(?:constraint\s+\S+\s+)?primary\s+key\s*\(([^)]*)\)/i.exec(a))) {
            table.attrs = { ...table.attrs, primaryKey: am[1].split(',').map((c) => unq(c.trim())) };
          } else if ((am = new RegExp(String.raw`^drop\s+(?:column\s+)?(?:if\s+exists\s+)?(${IDENT})`, 'i').exec(a)) && !/^drop\s+(constraint|default)\b/i.test(a)) {
            const c = unq(am[1]);
            syms.delete(cols.get(c) ?? '');
            cols.delete(c);
            table.attrs = { ...table.attrs, columns: ((table.attrs?.columns as string[]) ?? []).filter((x) => x !== c) };
          } else if ((am = new RegExp(String.raw`^alter\s+(?:column\s+)?(${IDENT})\s+(.*)$`, 'is').exec(a))) {
            const col = syms.get(cols.get(unq(am[1])) ?? '');
            if (!col) continue;
            const what = am[2];
            let wm: RegExpExecArray | null;
            if ((wm = /^(?:set\s+data\s+)?type\s+(.+?)(?:\s+using\s+.*)?$/is.exec(what))) col.attrs = { ...col.attrs, type: oneLine(wm[1], 80) };
            else if ((wm = /^set\s+default\s+(.*)$/is.exec(what))) col.attrs = { ...col.attrs, default: oneLine(wm[1], 80) };
            else if (/^drop\s+default/i.test(what)) { const { default: _d, ...rest } = col.attrs ?? {}; col.attrs = rest; }
            else if (/^set\s+not\s+null/i.test(what)) col.attrs = { ...col.attrs, notNull: true };
            else if (/^drop\s+not\s+null/i.test(what)) col.attrs = { ...col.attrs, notNull: false };
            col.attrs = { ...col.attrs, alteredIn: [...new Set([...((col.attrs?.alteredIn as string[]) ?? []), file])] };
          } else if ((am = new RegExp(String.raw`^rename\s+(?:column\s+)?(${IDENT})\s+to\s+(${IDENT})`, 'i').exec(a)) && !/^rename\s+to\b/i.test(a)) {
            const [from, to] = [unq(am[1]), unq(am[2])];
            const old = syms.get(cols.get(from) ?? '');
            if (!old) continue;
            syms.delete(old.id);
            cols.delete(from);
            const nid = `${old.file}#${q}.${to}`;
            syms.set(nid, { ...old, id: nid, name: to, attrs: { ...old.attrs, renamedFrom: from } });
            cols.set(to, nid);
            table.attrs = { ...table.attrs, columns: ((table.attrs?.columns as string[]) ?? []).map((x) => (x === from ? to : x)) };
          } else if ((am = new RegExp(String.raw`^rename\s+to\s+(${IDENT})`, 'i').exec(a))) {
            renameTable(q, `${q.split('.')[0]}.${unq(am[1])}`);
          } else if (/^enable\s+row\s+level\s+security/i.test(a)) {
            table.attrs = { ...table.attrs, rls: true };
          } else if (/^(disable\s+row\s+level\s+security)/i.test(a)) {
            table.attrs = { ...table.attrs, rls: false };
          }
          // Constraints, owners, replica identity…: understood as "not about columns", left out.
          if (syms.has(table.id)) table.attrs = { ...table.attrs, alteredIn: [...new Set([...((table.attrs?.alteredIn as string[]) ?? []), file])] };
        }
        continue;
      }

      if ((m = /^drop\s+table\s+(?:if\s+exists\s+)?(.+?)(?:\s+(?:cascade|restrict))?$/is.exec(t))) {
        for (const n of splitTop(m[1])) {
          const q = qualify(n.text);
          const id = tables.get(q);
          remove(id);
          tables.delete(q);
          for (const [k, v] of [...policies, ...indexes]) if (syms.get(v)?.container === id || k.startsWith(`${id}|`)) { syms.delete(v); policies.delete(k); indexes.delete(k); }
        }
        continue;
      }

      if ((m = new RegExp(String.raw`^create\s+(?:or\s+replace\s+)?function\s+${QN}\s*\(`, 'i').exec(t))) {
        const q = qualify(m[1]);
        const open = m.index + m[0].length - 1;
        const close = matchParen(t, open);
        if (close < 0) { notUnderstood.push(oneLine(t, 60)); continue; }
        const params: string[] = [], paramTypes: string[] = [];
        for (const p of splitTop(t.slice(open + 1, close))) {
          const toks = p.text.replace(/\s+(default\s+|=\s*).*/is, '').split(/\s+/);
          if (/^(in|out|inout|variadic)$/i.test(toks[0])) toks.shift();
          if (toks.length >= 2) { params.push(unq(toks[0])); paramTypes.push(toks.slice(1).join(' ')); }
          else { params.push(''); paramTypes.push(toks.join(' ')); }
        }
        // The body: `as $tag$ … $tag$` or `as '…'`. Everything else is the function's options.
        const rest = src.slice(at + close + 1, st.end);
        const bm = /\bas\s+(\$[A-Za-z_]*\$)/i.exec(rest);
        let body = '', bodyAt = 0, opts = rest;
        if (bm) {
          const bStart = bm.index + bm[0].length;
          const bEnd = rest.indexOf(bm[1], bStart);
          body = rest.slice(bStart, bEnd < 0 ? rest.length : bEnd);
          bodyAt = at + close + 1 + bStart;
          opts = rest.slice(0, bm.index) + ' ' + (bEnd < 0 ? '' : rest.slice(bEnd + bm[1].length));
        }
        opts = opts.replace(/--[^\n]*/g, ' ');
        const returns = /\breturns\s+([\s\S]+?)(?=\s+(?:language|security|stable|immutable|volatile|as|set|strict|cost|parallel|leakproof|called|returns\s+null|window)\b|\s*$)/i.exec(opts)?.[1];
        const language = /\blanguage\s+'?(\w+)/i.exec(opts)?.[1]?.toLowerCase();
        const volatility = /\b(stable|immutable|volatile)\b/i.exec(opts)?.[1]?.toLowerCase();
        const prev = functions.get(q);
        if (prev) syms.delete(prev);
        const id = `${file}#${q}`;
        mk(id, q.split('.')[1], 'sql-function', at, st.end, src.slice(at, st.end), {
          signature: oneLine(`${q}(${splitTop(t.slice(open + 1, close)).map((p) => p.text).join(', ')})${returns ? ` returns ${returns}` : ''}`),
          attrs: {
            schema: q.split('.')[0], params, paramTypes,
            ...(returns ? { returns: oneLine(returns, 120) } : {}),
            ...(language ? { language } : {}),
            securityDefiner: /\bsecurity\s+definer\b/i.test(opts),
            ...(volatility ? { volatility } : {}),
            ...(prev && prev !== id ? { redefines: prev } : {}),
          },
        });
        functions.set(q, id);
        if (body) scanBody(id, body, bodyAt);
        continue;
      }

      if ((m = new RegExp(String.raw`^drop\s+function\s+(?:if\s+exists\s+)?${QN}`, 'i').exec(t))) {
        const q = qualify(m[1]);
        syms.delete(functions.get(q) ?? '');
        functions.delete(q);
        continue;
      }

      if ((m = new RegExp(String.raw`^create\s+policy\s+(${IDENT})\s+on\s+${QN}([\s\S]*)$`, 'i').exec(t))) {
        const name = unq(m[1]);
        const q = qualify(m[2]);
        const tid = tables.get(q);
        const rest = m[3];
        const restAt = m.index + m[0].length - rest.length;
        const cmd = /\bfor\s+(all|select|insert|update|delete)\b/i.exec(rest)?.[1]?.toLowerCase() ?? 'all';
        const roles = /\bto\s+([\w\s,"]+?)(?=\s+(?:using|with)\b|$)/i.exec(rest)?.[1];
        const clause = (kw: RegExp) => {
          const cm = kw.exec(rest);
          if (!cm) return null;
          const open = cm.index + cm[0].length - 1;
          const close = matchParen(rest, open);
          return close < 0 ? null : { text: rest.slice(open + 1, close), at: restAt + open + 1 };
        };
        const using = clause(/\busing\s*\(/i), check = clause(/\bwith\s+check\s*\(/i);
        const id = `${file}#${q}.policy:${name}`;
        const key = `${tid ?? q}|${name}`;
        syms.delete(policies.get(key) ?? '');
        mk(id, name, 'sql-policy', at, st.end, t, {
          ...(tid ? { container: tid } : {}),
          signature: oneLine(`policy "${name}" on ${q} for ${cmd}`),
          attrs: { table: q, command: cmd, ...(roles ? { roles: roles.split(',').map((r) => unq(r.trim())) } : {}), ...(using ? { using: oneLine(using.text, 200) } : {}), ...(check ? { check: oneLine(check.text, 200) } : {}), permissive: !/\bas\s+restrictive\b/i.test(rest) },
        });
        policies.set(key, id);
        if (using) scanBody(id, using.text, at + using.at);
        if (check) scanBody(id, check.text, at + check.at);
        continue;
      }

      if ((m = new RegExp(String.raw`^(drop|alter)\s+policy\s+(?:if\s+exists\s+)?(${IDENT})\s+on\s+${QN}`, 'i').exec(t))) {
        const q = qualify(m[3]);
        const key = `${tables.get(q) ?? q}|${unq(m[2])}`;
        if (m[1].toLowerCase() === 'drop') { syms.delete(policies.get(key) ?? ''); policies.delete(key); }
        else {
          const p = syms.get(policies.get(key) ?? '');
          if (p) p.attrs = { ...p.attrs, alteredIn: [...new Set([...((p.attrs?.alteredIn as string[]) ?? []), file])] };
        }
        continue;
      }

      if ((m = new RegExp(String.raw`^create\s+(unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?(${IDENT})?\s*on\s+(?:only\s+)?${QN}\s*(?:using\s+(\w+)\s*)?\(`, 'i').exec(t))) {
        const q = qualify(m[3]);
        const open = m.index + m[0].length - 1;
        const close = matchParen(t, open);
        const iname = m[2] ? unq(m[2]) : `${q.split('.')[1]}_idx`;
        const iq = `${q.split('.')[0]}.${iname}`;
        const tid = tables.get(q);
        const id = `${file}#${iq}`;
        mk(id, iname, 'sql-index', at, st.end, t, {
          ...(tid ? { container: tid } : {}),
          signature: oneLine(`${m[1] ? 'unique ' : ''}index ${iname} on ${q} (${close > 0 ? t.slice(open + 1, close) : '…'})`),
          attrs: { table: q, unique: !!m[1], columns: close > 0 ? splitTop(t.slice(open + 1, close)).map((c) => oneLine(c.text, 60)) : [], ...(m[4] ? { method: m[4].toLowerCase() } : {}), ...(/\swhere\s/i.test(t.slice(close)) ? { partial: true } : {}) },
        });
        indexes.set(iq, id);
        continue;
      }

      if ((m = new RegExp(String.raw`^drop\s+index\s+(?:concurrently\s+)?(?:if\s+exists\s+)?${QN}`, 'i').exec(t))) {
        const q = qualify(m[1]);
        syms.delete(indexes.get(q) ?? '');
        indexes.delete(q);
        continue;
      }

      if ((m = new RegExp(String.raw`^create\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\s+(${IDENT})\s+([\s\S]*?)\bon\s+${QN}[\s\S]*?\bexecute\s+(?:function|procedure)\s+${QN}\s*\(`, 'i').exec(t))) {
        const q = qualify(m[3]);
        const tid = tables.get(q);
        const timing = oneLine(m[2], 80).toLowerCase();
        if (tid) {
          const tab = syms.get(tid)!;
          tab.attrs = { ...tab.attrs, triggers: [...((tab.attrs?.triggers as string[]) ?? []), unq(m[1])] };
        }
        const fStart = t.toLowerCase().lastIndexOf(m[4].toLowerCase());
        raw.push({ from: tid ?? fileId, kind: 'sql-call', name: m[4], file, start: at + fStart, end: at + fStart + m[4].length, call: true });
        void timing;
        continue;
      }

      if ((m = new RegExp(String.raw`^create\s+type\s+${QN}\s+as\s+(enum\s*\(([\s\S]*)\)|\()`, 'i').exec(t))) {
        const q = qualify(m[1]);
        const members = m[2] !== undefined ? [...m[2].matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1].replace(/''/g, "'")) : null;
        const id = `${file}#${q}`;
        mk(id, q.split('.')[1], 'type', at, st.end, t, { signature: oneLine(`type ${q} as ${members ? 'enum' : 'composite'}`), attrs: { schema: q.split('.')[0], sql: true, ...(members ? { members } : {}) } });
        types.set(q, id);
        continue;
      }

      if ((m = new RegExp(String.raw`^alter\s+type\s+${QN}\s+add\s+value\s+(?:if\s+not\s+exists\s+)?'((?:[^']|'')*)'`, 'i').exec(t))) {
        const s = syms.get(types.get(qualify(m[1])) ?? '');
        if (s) s.attrs = { ...s.attrs, members: [...((s.attrs?.members as string[]) ?? []), m[2]], alteredIn: [...new Set([...((s.attrs?.alteredIn as string[]) ?? []), file])] };
        continue;
      }

      if (/^(insert|update|delete|with|select)\b/i.test(t)) { scanBody(fileId, src.slice(at, st.end), at); continue; }
      if (/^do\b/i.test(t)) {
        const dm = /(\$[A-Za-z_]*\$)([\s\S]*?)\1/.exec(src.slice(at, st.end));
        if (dm) scanBody(fileId, dm[2], at + dm.index + dm[1].length);
        continue;
      }
      if (/^(grant|revoke|comment\s+on|create\s+schema|create\s+extension|alter\s+publication|alter\s+function|alter\s+default\s+privileges|drop\s+trigger|drop\s+type|set|reset|begin|commit|notify|security\s+label|alter\s+schema|alter\s+role|drop\s+schema)\b/i.test(t)) continue;
      notUnderstood.push(oneLine(t, 60));
    }

    files.set(file, notUnderstood.length
      ? { status: 'partial', note: `${notUnderstood.length} statement(s) not understood, e.g. \`${notUnderstood[0]}\`` }
      : { status: 'indexed' });

    // Closures over this file's line map.
    function addColumn(def: string, defAt: number, tableId: string, tableQ: string, cols: Map<string, string>): IndexSymbol | null {
      const nm = new RegExp(String.raw`^(${IDENT})\s+([\s\S]*)$`).exec(def.trim());
      if (!nm) return null;
      const name = unq(nm[1]);
      const rest = nm[2];
      const stop = COL_STOP.exec(' ' + rest);
      const type = oneLine(stop ? rest.slice(0, stop.index) : rest, 80);
      const refm = new RegExp(String.raw`references\s+${QN}\s*(?:\(([^)]*)\))?`, 'i').exec(rest);
      const dflt = /\bdefault\s+(.+?)(?=\s+(?:not\s+null|null|primary\s+key|references|check|unique|generated|constraint)\b|$)/is.exec(rest)?.[1];
      const pk = /\bprimary\s+key\b/i.test(rest);
      const id = `${file}#${tableQ}.${name}`;
      syms.delete(cols.get(name) ?? '');
      const s = mk(id, name, 'sql-column', defAt, defAt + def.trim().length, def, {
        container: tableId,
        signature: oneLine(`${name} ${type}`),
        attrs: {
          type, notNull: pk || /\bnot\s+null\b/i.test(rest),
          ...(pk ? { primaryKey: true } : {}),
          ...(dflt ? { default: oneLine(dflt, 80) } : {}),
          ...(refm ? { references: `${qualify(refm[1])}${refm[2] ? `(${refm[2].trim()})` : ''}` } : {}),
          ...(/\bunique\b/i.test(rest) ? { unique: true } : {}),
        },
      });
      cols.set(name, id);
      return s;
    }
  }

  function renameTable(from: string, to: string) {
    const id = tables.get(from);
    const t = id && syms.get(id);
    if (!id || !t) return;
    const nid = `${t.file}#${to}`;
    syms.delete(id);
    syms.set(nid, { ...t, id: nid, name: to.split('.')[1], attrs: { ...t.attrs, renamedFrom: from } });
    const cols = new Map<string, string>();
    for (const [c, cid] of columns.get(id) ?? []) {
      const s = syms.get(cid)!;
      syms.delete(cid);
      const ncid = `${s.file}#${to}.${c}`;
      syms.set(ncid, { ...s, id: ncid, container: nid });
      cols.set(c, ncid);
    }
    for (const s of syms.values()) if (s.container === id) s.container = nid;
    columns.delete(id);
    columns.set(nid, cols);
    tables.delete(from);
    tables.set(to, nid);
  }

  // Resolve uses against the schema as the last migration leaves it.
  const references: IndexReference[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (r.from !== `${r.file}#` && !syms.has(r.from)) continue; // its function was replaced or dropped later
    const q = qualify(r.name);
    const to = r.call ? functions.get(q) : tables.get(q);
    if (!to) continue;
    const range = lines.get(r.file)!.range(r.start, r.end);
    const k = `${r.from}|${to}|${r.kind}|${range.start.line}:${range.start.col}`;
    if (seen.has(k)) continue;
    seen.add(k);
    references.push({ from: r.from, to, kind: r.kind, range });
  }
  return { symbols: [...syms.values()], references, files };
}
