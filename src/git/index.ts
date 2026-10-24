/**
 * Read-only Git queries against local repositories, run with the user's `git` binary.
 * Main only: callers pass paths from the database, never paths from the renderer.
 *
 * Everything parses porcelain / -z output, which Git keeps stable across versions and locales.
 */

import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import type { GitBranch, GitChange, GitFileChange, GitStatus, GitWorktree } from '../shared/api.js';

const TIMEOUT_MS = 15_000;
const MAX_OUTPUT = 64 * 1024 * 1024; // status of a large, dirty repository can run to megabytes

function git(cwd: string, args: string[]): Promise<string> {
  // A repository's own config can name a program for core.fsmonitor, which `git status` would
  // run; the user may add a repository they don't trust, so never let it.
  const argv = ['-C', cwd, '-c', 'core.fsmonitor=false', ...args];
  return new Promise((done, fail) => {
    execFile(
      'git',
      argv,
      {
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT,
        encoding: 'utf8',
        // No credential prompts; no index.lock from status, so a concurrent `git commit` won't fail.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
      },
      (err, stdout, stderr) => {
        if (!err) return done(stdout);
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fail(new Error('Git is not installed or not on PATH'));
        fail(new Error(stderr.trim().replace(/^fatal: /, '') || err.message));
      },
    );
  });
}

/** The top of the working tree containing `path`, or null if it isn't inside one. */
export async function findWorkingTreeRoot(path: string): Promise<string | null> {
  try {
    return resolve((await git(path, ['rev-parse', '--show-toplevel'])).trim());
  } catch {
    return null;
  }
}

// ─── Status ──────────────────────────────────────────────────────────────────

const CHANGE: Record<string, GitChange> = {
  M: 'modified',
  T: 'type-changed',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
};

/** Branch, upstream, and changed files of the working tree at `path`. Ignored files are left out. */
export async function getStatus(path: string): Promise<GitStatus> {
  const out = await git(path, ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z']);
  const status: GitStatus = { branch: null, head: null, upstream: null, ahead: 0, behind: 0, files: [] };
  const entries = out.split('\0');

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    if (entry.startsWith('# ')) {
      const [key, ...rest] = entry.slice(2).split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid') status.head = value === '(initial)' ? null : value;
      else if (key === 'branch.head') status.branch = value === '(detached)' ? null : value;
      else if (key === 'branch.upstream') status.upstream = value;
      else if (key === 'branch.ab') {
        const [, ahead, behind] = /^\+(\d+) -(\d+)$/.exec(value) ?? [];
        status.ahead = Number(ahead ?? 0);
        status.behind = Number(behind ?? 0);
      }
      continue;
    }

    // Paths may contain spaces, so split off a fixed number of fields and keep the rest whole.
    const kind = entry[0];
    if (kind === '?') {
      status.files.push(change(entry.slice(2), null, null, 'untracked'));
    } else if (kind === '1') {
      const f = fields(entry, 9);
      status.files.push(change(f[8], null, CHANGE[f[1][0]] ?? null, CHANGE[f[1][1]] ?? null));
    } else if (kind === '2') {
      // A rename or copy: the original path follows as its own NUL-separated entry.
      const f = fields(entry, 10);
      const originalPath = entries[++i] ?? null;
      status.files.push(change(f[9], originalPath, CHANGE[f[1][0]] ?? null, CHANGE[f[1][1]] ?? null));
    } else if (kind === 'u') {
      status.files.push({ ...change(fields(entry, 11)[10], null, null, null), conflicted: true });
    }
  }
  return status;
}

function fields(entry: string, count: number): string[] {
  const parts = entry.split(' ');
  return [...parts.slice(0, count - 1), parts.slice(count - 1).join(' ')];
}

function change(path: string, originalPath: string | null, staged: GitChange | null, unstaged: GitChange | null): GitFileChange {
  return { path, originalPath, staged, unstaged, conflicted: false };
}

// ─── Branches ────────────────────────────────────────────────────────────────

const BRANCH_FORMAT = [
  '%(refname)',
  '%(objectname)',
  '%(HEAD)',
  '%(upstream:short)',
  '%(upstream:track,nobracket)',
  '%(committerdate:iso-strict)',
  '%(worktreepath)',
].join('%00');

/** Local branches, then remote-tracking branches, each sorted by name. */
export async function listBranches(path: string): Promise<GitBranch[]> {
  const out = await git(path, ['for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads', 'refs/remotes']);
  const branches: GitBranch[] = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [ref, commit, head, upstream, track, committedAt, worktreePath] = line.split('\0');
    const remote = ref.startsWith('refs/remotes/');
    if (remote && ref.endsWith('/HEAD')) continue; // origin/HEAD is an alias, not a branch
    branches.push({
      name: ref.replace(/^refs\/(heads|remotes)\//, ''),
      remote,
      current: head === '*',
      commit,
      upstream: upstream || null,
      ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
      behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
      upstreamGone: track === 'gone',
      committedAt: committedAt || null,
      worktreePath: worktreePath ? resolve(worktreePath) : null,
    });
  }
  return branches;
}

// ─── Worktrees ───────────────────────────────────────────────────────────────

/** Every worktree of the repository at `path`, main worktree first. */
export async function listWorktrees(path: string): Promise<GitWorktree[]> {
  const out = await git(path, ['worktree', 'list', '--porcelain', '-z']);
  const worktrees: GitWorktree[] = [];
  let current: GitWorktree | null = null;

  // One attribute per NUL-terminated entry; an empty entry ends each worktree.
  for (const entry of out.split('\0')) {
    if (!entry) {
      current = null;
      continue;
    }
    const space = entry.indexOf(' ');
    const key = space === -1 ? entry : entry.slice(0, space);
    const value = space === -1 ? '' : entry.slice(space + 1);
    if (key === 'worktree') {
      current = {
        path: resolve(value),
        head: null,
        branch: null,
        main: worktrees.length === 0,
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
      };
      worktrees.push(current);
    } else if (!current) {
      continue;
    } else if (key === 'HEAD') current.head = /^0+$/.test(value) ? null : value; // all zeros before the first commit
    else if (key === 'branch') current.branch = value.replace(/^refs\/heads\//, '');
    else if (key === 'bare') current.bare = true;
    else if (key === 'detached') current.detached = true;
    else if (key === 'locked') current.locked = true;
    else if (key === 'prunable') current.prunable = true;
  }
  return worktrees;
}
