import type { IndexDiff, RegistryDiff, RepoRevision, SystemRegistry, Trace, ViewRequest, ViewState } from './model.js';

// What the system canvas asks of whoever hosts the index: the dev server over HTTP
// (scripts/system-canvas/serve.mjs) or Electron main over IPC (main/system-canvas.ts). Both implement
// this interface with the same Node service (src/system/service.ts); the renderer only sees this.

export interface RepoChoice {
  id: string;
  name: string;
  root: string;
  /** The last index's revision, if there is one. */
  indexed?: RepoRevision;
}

/** What the index knows about the working tree right now, without re-indexing. */
export interface Freshness {
  repo: string;
  fingerprint: string;
  /** Files changed, added or removed on disk since the index was built. */
  changed: string[];
  /** Registry entities anchored in those files: drawn stale until refreshed. */
  staleEntities: string[];
  headMoved: boolean;
}

export interface IndexSummary {
  revision: RepoRevision;
  files: number;
  symbols: number;
  references: number;
  incomplete: boolean;
  ms: number;
}

/** A source excerpt for the inspector. */
export interface SourceExcerpt {
  file: string;
  /** First line number of `lines`. */
  start: number;
  lines: string[];
  /** The highlighted range within the excerpt, in file line numbers. */
  focus: { start: number; end: number };
  /** Hash of the file now; differs from the evidence's `fileHash` when it changed since indexing. */
  hash: string;
  language: string;
}

export interface Refreshed {
  summary: IndexSummary;
  registry: SystemRegistry;
  indexDiff: IndexDiff;
  registryDiff: RegistryDiff;
}

export interface SavedView { request: ViewRequest; state: ViewState | null; savedAt: string }

export interface SystemApi {
  repos(): Promise<RepoChoice[]>;
  /** Indexes (or loads the cached index of) a repository and builds its registry. */
  open(repo: string, opts?: { reindex?: boolean }): Promise<{ summary: IndexSummary; registry: SystemRegistry }>;
  freshness(repo: string): Promise<Freshness>;
  /** Re-indexes what changed and rebuilds the registry, reporting the differences. */
  refresh(repo: string): Promise<Refreshed>;
  source(repo: string, file: string, start: number, end: number, context?: number): Promise<SourceExcerpt>;
  /** Fixture registries (clearly labelled) for tests and the second-system demonstration. */
  fixtures(): Promise<{ id: string; label: string }[]>;
  fixture(id: string): Promise<SystemRegistry>;
  views(repo: string): Promise<SavedView[]>;
  saveView(repo: string, view: SavedView): Promise<void>;
  traces(repo: string): Promise<Trace[]>;
}
