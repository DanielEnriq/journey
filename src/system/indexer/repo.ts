import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { slug, type FileLang, type RepoRevision } from '../../shared/system/model.js';
import { countLines, hash16, toPosix } from './util.js';

// The repository as files on disk: which files there are (honouring .gitignore), what each one is,
// and which revision they describe.

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 });
  } catch {
    return null;
  }
}

/** True when `root` is the top of (or inside) a git work tree. */
export function isGitRepo(root: string): boolean {
  return git(root, ['rev-parse', '--is-inside-work-tree'])?.trim() === 'true';
}

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'out', 'coverage']);

/**
 * Every file the repository consists of, repo-relative, sorted. In git: tracked plus untracked-but-not-ignored
 * (`git ls-files -co --exclude-standard`), minus files deleted from the working tree and anything under node_modules. Outside git: a walk that
 * skips node_modules, dist, .git, out and coverage.
 */
export function listFiles(root: string): string[] {
  const out = isGitRepo(root) ? git(root, ['ls-files', '-co', '--exclude-standard', '-z']) : null;
  let files: string[];
  if (out !== null) {
    // Vendored packages are never the repository's own code, even when committed.
    files = [...new Set(out.split('\0').filter(Boolean).map(toPosix))].filter((f) => !/(^|\/)node_modules\//.test(f)).filter((f) => {
      try { return statSync(join(root, f)).isFile(); } catch { return false; }
    });
  } else {
    files = [];
    const walk = (dir: string, rel: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name), r); }
        else if (e.isFile()) files.push(r);
      }
    };
    walk(root, '');
  }
  return files.sort();
}

export function langOf(path: string): FileLang {
  const m = /\.([^./]+)$/.exec(path);
  switch (m?.[1].toLowerCase()) {
    case 'ts': case 'mts': case 'cts': return 'ts';
    case 'tsx': return 'tsx';
    case 'js': case 'mjs': case 'cjs': case 'jsx': return 'js';
    case 'sql': return 'sql';
    case 'css': return 'css';
    case 'html': case 'htm': return 'html';
    case 'json': return 'json';
    case 'md': case 'markdown': return 'md';
    default: return 'other';
  }
}

export const isTestFile = (path: string) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) || /(^|\/)__tests__\//.test(path);

/** Supabase migrations are the SQL we read; other .sql files are listed only. */
export const isMigration = (path: string) => /(^|\/)supabase\/migrations\/[^/]+\.sql$/.test(path);

export interface FileFacts { path: string; lang: FileLang; hash: string; size: number; lines: number; text: string | null; binary: boolean }

/** Reads one file: its hash, size and lines; the text when it looks like text. */
export function readFileFacts(root: string, path: string): FileFacts {
  const buf = readFileSync(join(root, path));
  const binary = buf.subarray(0, 8000).includes(0);
  const text = binary ? null : buf.toString('utf8');
  return { path, lang: langOf(path), hash: hash16(buf), size: buf.length, lines: text === null ? 0 : countLines(text), text, binary };
}

/** Same as the index's file hash, for freshness checks. */
export const hashFile = (root: string, path: string) => hash16(readFileSync(join(root, path)));

/** Where the revision came from: head, branch, dirty files, a stable repo id. */
export function readRevision(rootIn: string, files: { path: string; hash: string }[], indexedAt: string): RepoRevision {
  const root = resolve(rootIn);
  const name = basename(root);
  const inGit = isGitRepo(root);
  const head = inGit ? git(root, ['rev-parse', '--verify', '-q', 'HEAD'])?.trim() || null : null;
  const branchOut = inGit ? git(root, ['symbolic-ref', '--short', '-q', 'HEAD'])?.trim() : '';
  const remoteOut = inGit ? git(root, ['remote', 'get-url', 'origin'])?.trim() : '';
  // Never keep credentials embedded in a remote URL.
  const remote = remoteOut ? remoteOut.replace(/\/\/[^@/]*@/, '//') : undefined;
  const dirty: string[] = [];
  if (inGit) {
    const st = git(root, ['status', '--porcelain', '-z', '--untracked-files=all']) ?? '';
    const parts = st.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p.length < 4) continue;
      const code = p.slice(0, 2);
      dirty.push(toPosix(p.slice(3)));
      if (code[0] === 'R' || code[0] === 'C') i++; // the next entry is the rename's source
    }
  }
  return {
    repo: { id: repoId(root), name, root, ...(remote ? { remote } : {}) },
    head,
    branch: branchOut || null,
    dirty: [...new Set(dirty)].sort(),
    indexedAt,
    fingerprint: fingerprint(files),
  };
}

/** Stable per checkout: the folder's name, and a short hash of where it is. */
export const repoId = (root: string) => `${slug(basename(resolve(root)))}-${hash16(resolve(root)).slice(0, 8)}`;

export function fingerprint(files: { path: string; hash: string }[]): string {
  return hash16([...files].sort((a, b) => (a.path < b.path ? -1 : 1)).map((f) => `${f.path}\0${f.hash}\n`).join(''));
}

export function gitHead(root: string): string | null {
  return isGitRepo(root) ? git(root, ['rev-parse', '--verify', '-q', 'HEAD'])?.trim() || null : null;
}
