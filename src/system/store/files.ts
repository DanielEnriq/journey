import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Where the system canvas keeps what it has worked out, per repository: the last index and registry
// (a cache, safe to delete), and what people made that isn't derivable (saved views, interpretations,
// recorded traces). Plain JSON files, each written whole to a temporary name and renamed over the old
// one, so a crash mid-write leaves the previous version rather than half a file.

/** `VOWE_SYSTEM_HOME`, else `~/.vowe/system`. Electron passes its own (under userData). */
export function defaultHome(): string {
  return process.env.VOWE_SYSTEM_HOME || join(homedir(), '.vowe', 'system');
}

export async function readJson<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T; }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    // A corrupt cache file is treated as absent; anything else (permissions) should surface.
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const dir = file.slice(0, file.lastIndexOf('/'));
  await mkdir(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(value), 'utf8');
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

export async function listJson<T>(dir: string): Promise<T[]> {
  let names: string[];
  try { names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort(); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []; throw err; }
  const out: T[] = [];
  for (const n of names) { const v = await readJson<T>(join(dir, n)); if (v) out.push(v); }
  return out;
}

/** The files kept for one repository. */
export function repoFiles(home: string, repoId: string) {
  const dir = join(home, 'repos', repoId);
  return {
    dir,
    index: join(dir, 'index.json'),
    registry: join(dir, 'registry.json'),
    views: join(dir, 'views.json'),
    interpretations: join(dir, 'interpretations.json'),
    traces: join(dir, 'traces'),
  };
}

/** Repositories added beyond the defaults. */
export const reposFile = (home: string) => join(home, 'repos.json');

/** Runs tasks for the same key one after another; different keys run independently. */
export function serial() {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const run = (tails.get(key) ?? Promise.resolve()).then(task, task);
    const tail = run.catch(() => {});
    tails.set(key, tail);
    void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
    return run;
  };
}
