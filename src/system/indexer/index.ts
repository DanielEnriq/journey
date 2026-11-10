import { resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import ts from 'typescript-api';
import {
  INDEX_SCHEMA, type FileLang, type IndexCoverage, type IndexedFile, type LanguageCoverage, type RepoIndex,
} from '../../shared/system/model.js';
import { isMigration, isTestFile, listFiles, readFileFacts, readRevision, type FileFacts } from './repo.js';
import { runSqlPass, SQL_LIMITS, SQL_TOOL } from './sql.js';
import { DIAGNOSTICS_CUT, runTypeScriptPass, type TsPassOutput } from './typescript.js';
import { rangeKey, sortBy } from './util.js';

// Vowe's repository indexer: one revision of a repository → a RepoIndex (`vowe.index/1`) of facts the
// language tooling established. Nothing here interprets; the registry does that on top.

export { diffIndexes, refreshIndex, scanFreshness, type IndexFreshness } from './freshness.js';
export { stableStringify } from './util.js';

export const INDEXER_TOOL = 'vowe-indexer/1';

export interface IndexOptions {
  /** The one time in the index; fixed in tests so two runs are byte-identical. Default: now. */
  indexedAt?: string;
  /** Read at most this many files (in path order); the rest are listed as skipped and the index is incomplete. */
  maxFiles?: number;
  /** Stop reading after this long; what's left is listed as skipped and the index is incomplete. */
  timeoutMs?: number;
  /** Count type-checker diagnostics per file (a full type check; default true). */
  diagnostics?: boolean;
}

const GENERAL_LIMITS = [
  'CSS and HTML are listed, not parsed: class names, ids and markup are not linked to code',
  'JSON, Markdown and other files are listed (path, hash, size, lines), not parsed',
  'runtime behaviour (what actually runs, values, timings) is not observed: only a recorded trace can say that',
];

/**
 * Indexes the repository at `root`. Type-checker diagnostics (a full type check) are counted on a worker
 * thread in parallel with the main passes.
 */
export async function indexRepository(rootIn: string, opts: IndexOptions = {}): Promise<RepoIndex> {
  if (opts.diagnostics === false) return indexRepositorySync(rootIn, opts);
  const plan = planIndex(rootIn, opts);
  const worker = countDiagnosticsOnWorker(plan);
  const index = assemble(plan, { ...opts, diagnostics: false });
  const d = await worker;
  if (d.ok) {
    index.coverage.diagnostics = Object.fromEntries(Object.entries(d.counts).sort(([a], [b]) => (a < b ? -1 : 1)));
    if (!d.complete) { index.coverage.limits.push(DIAGNOSTICS_CUT); index.incomplete = true; }
  } else {
    index.coverage.limits.push(`type-checker diagnostics were not counted (${d.error})`);
  }
  return index;
}

/** The same, synchronously, counting diagnostics on this thread (slower: nothing runs in parallel). */
export function indexRepositorySync(rootIn: string, opts: IndexOptions = {}): RepoIndex {
  return assemble(planIndex(rootIn, opts), opts);
}

interface Plan {
  root: string;
  t0: number;
  deadline: number;
  facts: FileFacts[];
  unreadable: Map<string, string>;
  overLimit: Set<string>;
  readable: FileFacts[];
  codeFiles: string[];
  tsconfigs: string[];
  limits: string[];
}

function planIndex(rootIn: string, opts: IndexOptions): Plan {
  const t0 = Date.now();
  const root = resolve(rootIn);
  const deadline = opts.timeoutMs !== undefined ? t0 + opts.timeoutMs : Number.MAX_SAFE_INTEGER;
  const limits = [...GENERAL_LIMITS];
  const paths = listFiles(root);
  const facts: FileFacts[] = [];
  const unreadable = new Map<string, string>();
  for (const p of paths) {
    try { facts.push(readFileFacts(root, p)); } catch (err) { unreadable.set(p, (err as Error).message); }
  }
  const overLimit = new Set<string>();
  if (opts.maxFiles !== undefined && facts.length > opts.maxFiles) {
    for (const f of facts.slice(opts.maxFiles)) overLimit.add(f.path);
    limits.push(`file limit reached: read ${opts.maxFiles} of ${facts.length} files (maxFiles); the rest are listed as skipped`);
  }
  const readable = facts.filter((f) => !overLimit.has(f.path));
  const codeFiles = readable.filter((f) => (f.lang === 'ts' || f.lang === 'tsx' || f.lang === 'js') && !f.binary).map((f) => f.path);
  const tsconfigs = readable.filter((f) => /(^|\/)tsconfig\.json$/.test(f.path)).map((f) => f.path);
  return { root, t0, deadline, facts, unreadable, overLimit, readable, codeFiles, tsconfigs, limits };
}

type WorkerResult = { ok: true; counts: Record<string, number>; complete: boolean } | { ok: false; error: string };

function countDiagnosticsOnWorker(plan: Plan): Promise<WorkerResult> {
  return new Promise((done) => {
    let w: Worker;
    try {
      w = new Worker(new URL('./diagnostics-worker.js', import.meta.url), {
        workerData: { root: plan.root, files: plan.codeFiles, tsconfigs: plan.tsconfigs, deadline: plan.deadline },
      });
    } catch (err) { done({ ok: false, error: (err as Error).message }); return; }
    w.once('message', (m: WorkerResult) => { done(m); void w.terminate(); });
    w.once('error', (err: Error) => done({ ok: false, error: err.message }));
    w.once('exit', (code) => done({ ok: false, error: `worker exited (${code})` }));
  });
}

function assemble(plan: Plan, opts: IndexOptions): RepoIndex {
  const { root, deadline, facts, unreadable, overLimit, readable, codeFiles, tsconfigs } = plan;
  const limits = [...plan.limits];
  let incomplete = overLimit.size > 0;

  /* TypeScript / JavaScript */
  let tsOut: TsPassOutput | null = null;
  try {
    tsOut = runTypeScriptPass({ root, files: codeFiles, tsconfigs, deadline, diagnostics: opts.diagnostics ?? true });
    limits.push(...tsOut.limits);
    incomplete ||= tsOut.incomplete;
  } catch (err) {
    incomplete = true;
    limits.push(`the TypeScript pass failed (${(err as Error).message}); no TypeScript/JavaScript facts are included`);
  }

  /* SQL */
  const migrations = readable.filter((f) => f.lang === 'sql' && isMigration(f.path));
  let sqlOut: ReturnType<typeof runSqlPass> | null = null;
  if (migrations.length) {
    if (Date.now() > deadline) {
      incomplete = true;
      limits.push('time limit reached before the SQL pass');
    } else {
      try {
        sqlOut = runSqlPass(migrations.map((f) => ({ path: f.path, text: f.text ?? '' })));
        limits.push(...SQL_LIMITS);
      } catch (err) {
        incomplete = true;
        limits.push(`the SQL pass failed (${(err as Error).message}); no SQL facts are included`);
      }
    }
  }

  /* Files */
  const files: IndexedFile[] = facts.map((f): IndexedFile => {
    const base = { path: f.path, lang: f.lang, hash: f.hash, size: f.size, lines: f.lines, ...(isTestFile(f.path) ? { test: true } : {}) };
    const st = (status: IndexedFile['status'], note?: string): IndexedFile => ({ ...base, status, ...(note ? { note } : {}) });
    if (overLimit.has(f.path)) return st('skipped', 'over the maxFiles limit');
    if (f.binary) return st('skipped', 'binary file');
    switch (f.lang) {
      case 'ts': case 'tsx': case 'js': {
        if (!tsOut) return st('error', 'the TypeScript pass failed');
        const r = tsOut.files.get(f.path);
        return r ? st(r.status, r.note) : st('error', 'not read by the TypeScript pass');
      }
      case 'sql': {
        if (!isMigration(f.path)) return st('unsupported', 'only supabase/migrations/*.sql are read; listed, not parsed');
        const r = sqlOut?.files.get(f.path);
        return r ? st(r.status, r.note) : st(sqlOut ? 'error' : 'skipped', sqlOut ? 'not read by the SQL pass' : 'the SQL pass did not run');
      }
      case 'css': return st('unsupported', 'CSS is listed, not parsed');
      case 'html': return st('unsupported', 'HTML is listed, not parsed');
      case 'md': return st('unsupported', 'Markdown is listed, not parsed');
      case 'json': return st('unsupported', 'JSON is listed, not parsed');
      default: return st('unsupported', 'no reader for this file type; listed only');
    }
  });
  for (const [p, msg] of unreadable) files.push({ path: p, lang: 'other', hash: '', size: 0, lines: 0, status: 'error', note: `could not be read: ${msg}` });

  const byLang: Partial<Record<FileLang, LanguageCoverage>> = {};
  for (const f of files) {
    const c = (byLang[f.lang] ??= { files: 0, indexed: 0, partial: 0, unsupported: 0, error: 0, skipped: 0 });
    c.files++;
    c[f.status]++;
  }
  if (files.some((f) => f.status === 'error')) incomplete = true;
  const coverage: IndexCoverage = { byLang, limits: [...new Set(limits)], diagnostics: tsOut?.diagnostics ?? {} };

  const indexedAt = opts.indexedAt ?? new Date().toISOString();
  const rk = (x: { range: { file: string; start: { line: number; col: number }; end: { line: number; col: number } } }) => rangeKey(x.range);
  return {
    schema: INDEX_SCHEMA,
    revision: readRevision(root, files, indexedAt),
    tools: { typescript: ts.version, sql: SQL_TOOL, indexer: INDEXER_TOOL },
    files: sortBy(files, (f) => f.path),
    symbols: sortBy([...(tsOut?.symbols ?? []), ...(sqlOut?.symbols ?? [])], (s) => s.id),
    imports: sortBy(tsOut?.imports ?? [], (i) => i.from, rk, (i) => i.specifier),
    references: sortBy([...(tsOut?.references ?? []), ...(sqlOut?.references ?? [])], (r) => r.from, (r) => r.to, (r) => r.kind, rk),
    literals: sortBy(tsOut?.literals ?? [], rk, (l) => String(l.argIndex).padStart(3, '0')),
    comparisons: sortBy(tsOut?.comparisons ?? [], rk),
    flows: sortBy(tsOut?.flows ?? [], (f) => f.symbol),
    coverage,
    incomplete,
  };
}
