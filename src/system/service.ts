import { existsSync, readFileSync, statSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Freshness, IndexSummary, Refreshed, RepoChoice, SavedView, SourceExcerpt, SystemApi } from '../shared/system/api.js';
import {
  slug, VIEW_SCHEMA,
  type IndexDiff, type Interpretation, type RegistryDiff, type RepoIndex, type RepoRevision, type SystemRegistry, type Trace,
} from '../shared/system/model.js';
import { interpretationsFile, parseInterpretation, parseInterpretationsFile, SystemInputError } from '../shared/system/registry-utils.js';
import { defaultHome, listJson, readJson, repoFiles, reposFile, serial, writeJsonAtomic } from './store/files.js';
import { readExcerpt } from './store/source.js';
import { recordCanvasTraces } from './traces/canvas-store.js';

// The system canvas's host, in Node: what the dev server serves over HTTP and Electron main over IPC.
// It keeps one repository's index and registry warm, caches both under the home dir so reopening an
// unchanged tree costs a fingerprint check, and keeps what people made (saved views, interpretations)
// beside them. The index and registry come from the indexer and registry workstreams through
// `SystemEngine`, so tests can drive the host with a small fake.

/** What the host needs from the indexer and the registry builder. */
export interface SystemEngine {
  /** Names the indexer and rules: a cache written under another version is rebuilt, not trusted. */
  version?: string;
  index(root: string): Promise<RepoIndex>;
  /** What changed on disk since `index`, without re-indexing. */
  scan(root: string, index: RepoIndex): Promise<{ fingerprint: string; changed: string[]; headMoved: boolean }>;
  /** Re-indexes what changed since `prev`. */
  refresh(root: string, prev: RepoIndex): Promise<RepoIndex>;
  diffIndexes(a: RepoIndex, b: RepoIndex): IndexDiff;
  build(index: RepoIndex, interpretations: Interpretation[]): SystemRegistry;
  diffRegistries(a: SystemRegistry, b: SystemRegistry): RegistryDiff;
  /** Sets each entity's status against the previous snapshot (changed, new, missing). */
  mark(next: SystemRegistry, diff: RegistryDiff, prev: SystemRegistry): SystemRegistry;
  fixtures(): { id: string; label: string }[];
  fixture(id: string): SystemRegistry | null;
}

/** SystemApi plus what only a host can do: add a repository, re-record traces. */
export interface SystemService extends SystemApi {
  addRepo(path: string): Promise<RepoChoice>;
  recordTraces(repo: string): Promise<Trace[]>;
  /** How the last open of a repository was served, for tests and logs. */
  lastOpen(repo: string): 'memory' | 'cache' | 'indexed' | 'refreshed' | null;
}

export interface SystemServiceOptions {
  /** Default: `VOWE_SYSTEM_HOME`, else `~/.vowe/system`. */
  home?: string;
  /** Repository roots offered by default. Default: the Journey repository this code is part of. */
  repos?: string[];
  engine?: SystemEngine | (() => Promise<SystemEngine>);
  /** Whether `traces()` records the canvas-store harness runs for the Journey repo when none are saved. Default true. */
  recordTraces?: boolean;
}

export class SystemError extends Error {
  constructor(message: string, readonly code: 'invalid' | 'not-found' | 'outside' | 'missing' | 'too-large' = 'invalid') { super(message); }
}

interface Repo {
  id: string;
  name: string;
  root: string;
  index?: RepoIndex;
  registry?: SystemRegistry;
  summary?: IndexSummary;
  revision?: RepoRevision;
  last: 'memory' | 'cache' | 'indexed' | 'refreshed' | null;
}

interface Meta { revision: RepoRevision; summary: IndexSummary; interpretations: string; engine?: string }

const MAX_VIEW_BYTES = 512 * 1024;
const MAX_VIEWS = 200;

/** The repository offered by default: `VOWE_SYSTEM_REPO`, else the Journey checkout (below). */
export function journeyRoot(): string {
  return process.env.VOWE_SYSTEM_REPO ? resolve(process.env.VOWE_SYSTEM_REPO) : checkoutRoot();
}

/** The Journey checkout this module was built in or is run from, else the working directory. Traces run its code. */
function checkoutRoot(): string {
  const isJourney = (dir: string) => {
    try { return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name === 'journey' && existsSync(join(dir, 'src', 'shared', 'canvas', 'store.ts')); }
    catch { return false; }
  };
  for (const start of [import.meta.dirname, process.cwd()]) {
    for (let dir = start; ; dir = dirname(dir)) {
      if (isJourney(dir)) return dir;
      if (dirname(dir) === dir) break;
    }
  }
  return process.cwd();
}

export function createSystemService(opts: SystemServiceOptions = {}): SystemService {
  const home = resolve(opts.home ?? defaultHome());
  const defaults = (opts.repos ?? [journeyRoot()]).map((r) => resolve(r));
  const hostRoot = checkoutRoot();
  const once = serial();
  const repos = new Map<string, Repo>();
  let loaded: Promise<void> | null = null;

  let engine: Promise<SystemEngine> | null = null;
  const getEngine = () => engine ??= typeof opts.engine === 'function' ? opts.engine()
    : opts.engine ? Promise.resolve(opts.engine)
    : import('./store/engine.js').then((m) => m.defaultEngine());

  function register(root: string): Repo {
    for (const r of repos.values()) if (r.root === root) return r;
    const name = basename(root) || 'repository';
    let id = slug(name);
    for (let n = 2; repos.has(id); n++) id = `${slug(name)}-${n}`;
    const repo: Repo = { id, name, root, last: null };
    repos.set(id, repo);
    return repo;
  }

  async function load() {
    loaded ??= (async () => {
      for (const root of defaults) register(root);
      for (const root of (await readJson<string[]>(reposFile(home))) ?? []) if (typeof root === 'string' && existsSync(root)) register(root);
      for (const r of repos.values()) {
        const meta = await readJson<Meta>(join(repoFiles(home, r.id).dir, 'meta.json'));
        if (meta) { r.revision = meta.revision; r.summary = meta.summary; }
      }
    })();
    return loaded;
  }

  async function repo(id: unknown): Promise<Repo> {
    await load();
    if (typeof id !== 'string') throw new SystemError('Repository id must be a string');
    const r = repos.get(id);
    if (!r) throw new SystemError(`No such repository: ${id}`, 'not-found');
    return r;
  }

  const files = (r: Repo) => repoFiles(home, r.id);

  async function interpretations(r: Repo): Promise<Interpretation[]> {
    const raw = await readJson<unknown>(files(r).interpretations);
    return raw ? parseInterpretationsFile(raw).interpretations : [];
  }
  const interpretationsKey = (list: Interpretation[]) => JSON.stringify(list.map((i) => [i.id, i.status, i.at]));

  function summarise(index: RepoIndex, ms: number): IndexSummary {
    return {
      revision: index.revision, files: index.files.length, symbols: index.symbols.length,
      references: index.references.length, incomplete: index.incomplete, ms: Math.round(ms),
    };
  }

  async function persist(r: Repo, index: RepoIndex, registry: SystemRegistry, summary: IndexSummary, interps: Interpretation[]) {
    const f = files(r);
    const eng = await getEngine();
    await writeJsonAtomic(f.index, index);
    await writeJsonAtomic(f.registry, registry);
    await writeJsonAtomic(join(f.dir, 'meta.json'), { revision: index.revision, summary, interpretations: interpretationsKey(interps), ...(eng.version ? { engine: eng.version } : {}) } satisfies Meta);
    Object.assign(r, { index, registry, summary, revision: index.revision });
  }

  /** The repository's index and registry, from memory, the cache, or a fresh index, in that order. */
  async function ensure(r: Repo, reindex = false): Promise<{ index: RepoIndex; registry: SystemRegistry; summary: IndexSummary }> {
    const eng = await getEngine();
    const t0 = performance.now();
    const interps = await interpretations(r);
    if (!reindex) {
      let index = r.index, registry = r.registry, from: Repo['last'] = 'memory';
      if (!index) {
        const meta = await readJson<Meta>(join(files(r).dir, 'meta.json'));
        if (meta && meta.engine === eng.version) {
          index = (await readJson<RepoIndex>(files(r).index)) ?? undefined;
          registry = (await readJson<SystemRegistry>(files(r).registry)) ?? undefined;
        }
        from = 'cache';
      }
      if (index) {
        const scan = await eng.scan(r.root, index);
        if (!scan.changed.length && !scan.headMoved) {
          const meta = await readJson<Meta>(join(files(r).dir, 'meta.json'));
          // A cached registry only counts if it describes this index with today's interpretations.
          const usable = registry && registry.revision.fingerprint === index.revision.fingerprint && meta?.interpretations === interpretationsKey(interps);
          if (!usable) { registry = eng.build(index, interps); from = 'indexed'; }
          const summary = { ...summarise(index, performance.now() - t0), ...(from === 'indexed' ? {} : { cached: true }) };
          if (from === 'indexed') await persist(r, index, registry!, summary, interps);
          else Object.assign(r, { index, registry, summary, revision: index.revision });
          r.last = from === 'indexed' ? 'indexed' : from;
          return { index, registry: registry!, summary };
        }
      }
    }
    const index = await eng.index(r.root);
    const registry = eng.build(index, interps);
    const summary = summarise(index, performance.now() - t0);
    await persist(r, index, registry, summary, interps);
    r.last = 'indexed';
    return { index, registry, summary };
  }

  function choice(r: Repo): RepoChoice {
    return { id: r.id, name: r.name, root: r.root, ...(r.revision ? { indexed: r.revision } : {}) };
  }

  function validInterpretation(v: unknown): Interpretation {
    const o = v && typeof v === 'object' && !('at' in v) ? { ...v, at: new Date().toISOString() } : v;
    try { return parseInterpretation(o); }
    catch (err) { throw err instanceof SystemInputError ? new SystemError(err.message) : err; }
  }

  function validView(v: unknown): SavedView {
    const o = v as SavedView;
    if (!o || typeof o !== 'object' || !o.request || typeof o.request !== 'object') throw new SystemError('A saved view needs its request');
    if (o.request.schema !== VIEW_SCHEMA) throw new SystemError(`View request schema must be ${VIEW_SCHEMA}`);
    if (typeof o.request.id !== 'string' || !o.request.id || o.request.id.length > 200) throw new SystemError('View request needs an id');
    if (o.state !== null && (typeof o.state !== 'object' || o.state === undefined)) throw new SystemError('View state must be an object or null');
    if (JSON.stringify(o).length > MAX_VIEW_BYTES) throw new SystemError('Saved view is too large');
    return { request: o.request, state: o.state ?? null, savedAt: typeof o.savedAt === 'string' ? o.savedAt : new Date().toISOString() };
  }

  async function record(r: Repo): Promise<Trace[]> {
    const { registry, index } = await once(r.id, () => ensure(r));
    const traces = await recordCanvasTraces(registry, index.revision.head ?? index.revision.fingerprint);
    for (const t of traces) await writeJsonAtomic(join(files(r).traces, `${slug(t.id)}.json`), t);
    return traces;
  }

  return {
    async repos() {
      await load();
      return [...repos.values()].map(choice);
    },

    async addRepo(path) {
      await load();
      if (typeof path !== 'string' || !path) throw new SystemError('Path must be a non-empty string');
      const root = await realpath(resolve(path)).catch(() => { throw new SystemError(`No such directory: ${path}`, 'not-found'); });
      if (!statSync(root).isDirectory()) throw new SystemError(`Not a directory: ${path}`);
      const r = register(root);
      const extra = [...repos.values()].map((x) => x.root).filter((x) => !defaults.includes(x));
      await writeJsonAtomic(reposFile(home), extra);
      return choice(r);
    },

    async open(id, o) {
      const r = await repo(id);
      return once(r.id, async () => {
        const { registry, summary } = await ensure(r, o?.reindex === true);
        return { summary, registry };
      });
    },

    async freshness(id): Promise<Freshness> {
      const r = await repo(id);
      return once(r.id, async () => {
        const { index, registry } = r.index && r.registry ? { index: r.index, registry: r.registry } : await ensure(r);
        const scan = await (await getEngine()).scan(r.root, index);
        const changed = new Set<string>(scan.changed);
        const staleEntities = Object.values(registry.entities)
          .filter((e) => e.anchors.some((a) => changed.has(a.file)))
          .map((e) => e.id).sort();
        return { repo: r.id, fingerprint: scan.fingerprint, changed: [...changed].sort(), staleEntities, headMoved: scan.headMoved };
      });
    },

    async refresh(id): Promise<Refreshed> {
      const r = await repo(id);
      return once(r.id, async () => {
        const eng = await getEngine();
        const prev = r.index && r.registry ? { index: r.index, registry: r.registry } : await ensure(r);
        const t0 = performance.now();
        const index = await eng.refresh(r.root, prev.index);
        const interps = await interpretations(r);
        const built = eng.build(index, interps);
        const indexDiff = eng.diffIndexes(prev.index, index);
        const registryDiff = eng.diffRegistries(prev.registry, built);
        const registry = eng.mark(built, registryDiff, prev.registry);
        const summary = summarise(index, performance.now() - t0);
        await persist(r, index, registry, summary, interps);
        r.last = 'refreshed';
        return { summary, registry, indexDiff, registryDiff };
      });
    },

    async source(id, file, start, end, context): Promise<SourceExcerpt> {
      const r = await repo(id);
      try { return await readExcerpt(r.root, file, start, end, context ?? 3); }
      catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'invalid' || code === 'outside' || code === 'missing' || code === 'too-large') throw new SystemError((err as Error).message, code);
        throw err;
      }
    },

    async fixtures() { return (await getEngine()).fixtures(); },

    async fixture(id) {
      if (typeof id !== 'string') throw new SystemError('Fixture id must be a string');
      const f = (await getEngine()).fixture(id);
      if (!f) throw new SystemError(`No such fixture: ${id}`, 'not-found');
      return f;
    },

    async views(id) {
      const r = await repo(id);
      return (await readJson<SavedView[]>(files(r).views)) ?? [];
    },

    async saveView(id, view) {
      const r = await repo(id);
      const v = validView(view);
      await once(`${r.id}:views`, async () => {
        const all = ((await readJson<SavedView[]>(files(r).views)) ?? []).filter((x) => x.request.id !== v.request.id);
        all.push(v);
        if (all.length > MAX_VIEWS) throw new SystemError(`At most ${MAX_VIEWS} saved views per repository`);
        await writeJsonAtomic(files(r).views, all);
      });
    },

    async addInterpretation(id, interpretation) {
      const r = await repo(id);
      const i = validInterpretation(interpretation);
      return once(r.id, async () => {
        const all = (await interpretations(r)).filter((x) => x.id !== i.id);
        all.push(i);
        await writeJsonAtomic(files(r).interpretations, interpretationsFile(r.id, all));
        const { index } = r.index ? { index: r.index } : await ensure(r);
        const registry = (await getEngine()).build(index, all);
        await persist(r, index, registry, r.summary ?? summarise(index, 0), all);
        return registry;
      });
    },

    async traces(id) {
      const r = await repo(id);
      const saved = await listJson<Trace>(files(r).traces);
      if (saved.length || opts.recordTraces === false || r.root !== hostRoot) return saved;
      return record(r);
    },

    async recordTraces(id) {
      const r = await repo(id);
      if (r.root !== hostRoot) throw new SystemError('Traces can only be recorded for the Journey repository this host runs');
      return record(r);
    },

    lastOpen(id) { return repos.get(id)?.last ?? null; },
  };
}
