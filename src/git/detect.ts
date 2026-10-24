/**
 * Finds Git repositories in the folders people usually keep code in, so the user can add one
 * without the folder picker. Reads directory listings only; runs no Git and opens no files.
 */

import { readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { DetectedRepository } from '../shared/api.js';

// Nothing under ~/Documents or ~/Desktop: reading those makes macOS ask the user for access.
const ROOTS = ['projects', 'code', 'dev', 'Developer', 'src', 'repos', 'workspace', 'GitHub'];
/** root/repo and root/owner/repo. */
const MAX_DEPTH = 2;
const MAX_RESULTS = 100;
const SKIP = new Set(['node_modules', 'Library', 'vendor']);

/** Repositories under the usual code folders in the home directory, sorted by path. */
export async function detectRepositories(): Promise<DetectedRepository[]> {
  const found = new Map<string, DetectedRepository>();
  // Real paths, so a root reached through a symlink or another letter case isn't scanned twice,
  // and paths match what Git reports for repositories added with the folder picker.
  const roots = await Promise.all(ROOTS.map((root) => realpath(join(homedir(), root)).catch(() => null)));
  await Promise.all([...new Set(roots)].map((root) => root && scan(root, 0, found)));
  return [...found.values()].sort((a, b) => a.path.localeCompare(b.path)).slice(0, MAX_RESULTS);
}

async function scan(dir: string, depth: number, found: Map<string, DetectedRepository>) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // missing or unreadable
  }
  // A .git directory marks a repository; a .git file is a linked worktree or submodule, so skip it.
  if (depth > 0 && entries.some((e) => e.name === '.git' && e.isDirectory())) {
    found.set(dir, { path: dir, name: basename(dir) });
    return; // don't look for repositories inside repositories
  }
  if (depth === MAX_DEPTH) return;
  await Promise.all(
    entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name))
      .map((e) => scan(join(dir, e.name), depth + 1, found)),
  );
}
