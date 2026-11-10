import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, sep } from 'node:path';
import type { SourceExcerpt } from '../../shared/system/api.js';

// Source excerpts for the inspector. The file name comes from the page, so it is only ever read as a
// path inside the repository: no absolute paths, no `..`, and no symlink that resolves outside the root.

export const MAX_EXCERPT_LINES = 400;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

/** Same hash as the index's `IndexedFile.hash`: sha256 hex, first 16 chars. */
export const contentHash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex').slice(0, 16);

export class SourceError extends Error {
  constructor(message: string, readonly code: 'invalid' | 'outside' | 'missing' | 'too-large') { super(message); }
}

/** Resolves a repo-relative path to a real file inside `root`, or throws. */
export async function confinedPath(root: string, file: string): Promise<string> {
  if (typeof file !== 'string' || !file || file.length > 1000 || file.includes('\0')) throw new SourceError('File must be a repo-relative path', 'invalid');
  const parts = file.split(/[\\/]+/);
  if (isAbsolute(file) || /^[a-zA-Z]:/.test(file) || parts.includes('..')) throw new SourceError(`Refusing path outside the repository: ${file}`, 'outside');
  const realRoot = await realpath(root);
  let real: string;
  try { real = await realpath(join(realRoot, ...parts)); }
  catch { throw new SourceError(`No such file: ${file}`, 'missing'); }
  const rel = relative(realRoot, real);
  if (!rel || rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel)) throw new SourceError(`Refusing path outside the repository: ${file}`, 'outside');
  if (rel.split(sep)[0] === '.git') throw new SourceError('Refusing to read inside .git', 'outside');
  const s = await stat(real);
  if (!s.isFile()) throw new SourceError(`Not a file: ${file}`, 'invalid');
  if (s.size > MAX_FILE_BYTES) throw new SourceError(`File too large to excerpt: ${file}`, 'too-large');
  return real;
}

const LANGUAGES: Record<string, string> = {
  '.ts': 'ts', '.tsx': 'tsx', '.cts': 'ts', '.mts': 'ts', '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'js',
  '.sql': 'sql', '.css': 'css', '.html': 'html', '.json': 'json', '.md': 'md',
};

export async function readExcerpt(root: string, file: string, start: number, end: number, context = 3): Promise<SourceExcerpt> {
  const real = await confinedPath(root, file);
  const num = (v: unknown, what: string) => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new SourceError(`${what} must be a non-negative whole number`, 'invalid');
    return v;
  };
  start = Math.max(1, num(start, 'Start'));
  end = Math.max(start, num(end, 'End'));
  context = Math.min(50, num(context, 'Context'));
  const buf = await readFile(real);
  const all = buf.toString('utf8').split(/\r?\n/);
  const from = Math.min(Math.max(1, start - context), all.length);
  const to = Math.min(all.length, end + context, from + MAX_EXCERPT_LINES - 1);
  return {
    file: file.split(/[\\/]+/).join('/'),
    start: from,
    lines: all.slice(from - 1, to),
    focus: { start: Math.min(start, all.length), end: Math.min(end, all.length) },
    hash: contentHash(buf),
    language: LANGUAGES[extname(real).toLowerCase()] ?? 'other',
  };
}
