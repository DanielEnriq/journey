import { resolve } from 'node:path';
import type { IndexDiff, IndexSymbol, RepoIndex } from '../../shared/system/model.js';
import { fingerprint, gitHead, hashFile, listFiles } from './repo.js';
import type { IndexOptions } from './index.js';

// Change detection: how the working tree differs from an index (cheap: list, stat, hash), what changed
// between two indexes, and a refresh that re-indexes only when something did.

export interface IndexFreshness {
  /** The index's fingerprint, and the working tree's now: equal means nothing changed. */
  indexed: string;
  current: string;
  changed: string[];
  added: string[];
  removed: string[];
  head: string | null;
  headMoved: boolean;
  fresh: boolean;
}

export function scanFreshness(rootIn: string, index: RepoIndex): IndexFreshness {
  const root = resolve(rootIn);
  const known = new Map(index.files.map((f) => [f.path, f]));
  const now = listFiles(root);
  const changed: string[] = [], added: string[] = [];
  const current: { path: string; hash: string }[] = [];
  for (const p of now) {
    const f = known.get(p);
    let h: string;
    try { h = hashFile(root, p); } catch { continue; }
    current.push({ path: p, hash: h });
    if (!f) { added.push(p); continue; }
    if (f.hash !== h) changed.push(p);
  }
  const onDisk = new Set(now);
  const removed = index.files.map((f) => f.path).filter((p) => !onDisk.has(p));
  const head = gitHead(root);
  const headMoved = head !== index.revision.head;
  const cur = fingerprint(current);
  return { indexed: index.revision.fingerprint, current: cur, changed, added, removed: removed.sort(), head, headMoved, fresh: !changed.length && !added.length && !removed.length && !headMoved };
}

/**
 * What changed from `a` to `b`. A symbol whose id disappeared while an added one has the same declaration
 * hash (a file moved or renamed, the code unchanged) is reported once, in `moved`, not as removed + added.
 */
export function diffIndexes(a: RepoIndex, b: RepoIndex): IndexDiff {
  const fa = new Map(a.files.map((f) => [f.path, f.hash]));
  const fb = new Map(b.files.map((f) => [f.path, f.hash]));
  const files = {
    added: [...fb.keys()].filter((p) => !fa.has(p)).sort(),
    removed: [...fa.keys()].filter((p) => !fb.has(p)).sort(),
    changed: [...fb.keys()].filter((p) => fa.has(p) && fa.get(p) !== fb.get(p)).sort(),
  };
  const sa = new Map(a.symbols.map((s) => [s.id, s]));
  const sb = new Map(b.symbols.map((s) => [s.id, s]));
  let added = [...sb.keys()].filter((id) => !sa.has(id)).sort();
  let removed = [...sa.keys()].filter((id) => !sb.has(id)).sort();
  const changed = [...sb.keys()].filter((id) => sa.has(id) && sa.get(id)!.hash !== sb.get(id)!.hash).sort();

  // Pair removed with added by hash; prefer the same name and kind, then path order. One-to-one.
  const moved: Record<string, string> = {};
  const byHash = new Map<string, IndexSymbol[]>();
  for (const id of added) {
    const s = sb.get(id)!;
    const k = `${s.kind}|${s.hash}`;
    byHash.set(k, [...(byHash.get(k) ?? []), s]);
  }
  for (const id of removed) {
    const old = sa.get(id)!;
    const cands = byHash.get(`${old.kind}|${old.hash}`);
    if (!cands?.length) continue;
    const i = Math.max(0, cands.findIndex((c) => c.name === old.name));
    const [hit] = cands.splice(i, 1);
    moved[id] = hit.id;
  }
  const movedTo = new Set(Object.values(moved));
  added = added.filter((id) => !movedTo.has(id));
  removed = removed.filter((id) => !(id in moved));
  return { from: a.revision.fingerprint, to: b.revision.fingerprint, files, symbols: { added, removed, changed, moved } };
}

/**
 * Re-indexes `root` if anything changed since `prev` (by file hash or git head), and says what changed.
 * Unchanged → `prev` itself and an empty diff. Changed → a full re-run: every fact in the new index is read
 * fresh, so nothing stale is carried over (a whole-repo TypeScript program is needed for cross-file
 * resolution anyway).
 */
export async function refreshIndex(root: string, prev: RepoIndex, opts: IndexOptions = {}): Promise<{ index: RepoIndex; diff: IndexDiff; freshness: IndexFreshness; reindexed: boolean }> {
  const freshness = scanFreshness(root, prev);
  if (freshness.fresh && !prev.incomplete) {
    const f = prev.revision.fingerprint;
    return { index: prev, diff: { from: f, to: f, files: { added: [], removed: [], changed: [] }, symbols: { added: [], removed: [], changed: [], moved: {} } }, freshness, reindexed: false };
  }
  const { indexRepositorySync } = await import('./index.js');
  const index = indexRepositorySync(root, opts);
  return { index, diff: diffIndexes(prev, index), freshness, reindexed: true };
}
