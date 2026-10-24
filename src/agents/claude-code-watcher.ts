/**
 * Observes Claude Code sessions by reading their transcripts as Claude Code appends to them, so
 * live activity shows up without installing hooks or changing Claude Code's settings. Read-only:
 * it never writes under ~/.claude.
 *
 * One recursive fs.watch on ~/.claude/projects says which transcript changed; that file is read
 * from the last position stored for it (claude-code-transcript.ts does the parsing), and new events
 * go into the same table, and out through the same emitter, as hook events. Positions persist, so
 * a restart picks up where it stopped, including what was written while Vowe was closed. Reads
 * are debounced per file and run one at a time; a slow rescan catches anything a watch event missed.
 *
 * On its very first run the watcher starts at the end of every existing transcript: past
 * sessions stay readable through the adapter, but aren't replayed as activity.
 */

import { watch, type FSWatcher } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import {
  deleteTranscriptPosition,
  getTranscriptPosition,
  hasTranscriptPositions,
  insertEvent,
  setTranscriptPosition,
} from '../database/claude-code-events.js';
import { claudeCodeActivity, claudeConfigDir } from './claude-code-hooks.js';
import { newCursor, readTranscript, type TranscriptCursor } from './claude-code-transcript.js';

/** Writes come in bursts (a tool call and its result); read once the burst settles. */
const DEBOUNCE_MS = 200;
/** Catches changes a watch event missed, and retries a watch that failed or a folder that wasn't there. */
const RESCAN_MS = 5 * 60_000;
const RETRY_MS = 60_000;

const projectsDir = () => join(claudeConfigDir(), 'projects');

interface Tracked {
  sessionId: string;
  cursor: TranscriptCursor;
}

let running = false;
let watcher: FSWatcher | null = null;
let rescanTimer: NodeJS.Timeout | null = null;
const tracked = new Map<string, Tracked>();
const pending = new Map<string, NodeJS.Timeout>();
/** Reads run one after another, so a file is never read twice at once and positions only move forward. */
let queue: Promise<void> = Promise.resolve();

/**
 * The session a transcript belongs to, or null if the path isn't one: `<project>/<session>.jsonl`,
 * or a subagent's `<project>/<session>/subagents/<agent>.jsonl`.
 */
export function transcriptSession(root: string, path: string): string | null {
  if (!path.endsWith('.jsonl')) return null;
  const parts = relative(root, path).split(sep);
  if (parts.length === 2) return basename(parts[1], '.jsonl');
  if (parts.length === 4 && parts[2] === 'subagents') return parts[1];
  return null;
}

export function startTranscriptWatcher() {
  if (running) return;
  running = true;
  void scan(!hasTranscriptPositions());
}

export function stopTranscriptWatcher() {
  running = false;
  watcher?.close();
  watcher = null;
  if (rescanTimer) clearTimeout(rescanTimer);
  rescanTimer = null;
  for (const timer of pending.values()) clearTimeout(timer);
  pending.clear();
  tracked.clear();
}

/** Lists every transcript, starts watching if not already, and reads whatever changed. */
async function scan(baseline = false) {
  if (!running) return;
  const root = projectsDir();
  try {
    if (!watcher) watcher = startWatching(root);
    const files = await listTranscripts(root);
    for (const path of files) {
      if (baseline && !tracked.has(path)) {
        const { size, ino } = await stat(path);
        const sessionId = transcriptSession(root, path)!;
        setTranscriptPosition(path, sessionId, size, ino);
      }
      enqueue(path);
    }
    const present = new Set(files);
    for (const path of tracked.keys()) if (!present.has(path)) enqueue(path); // gone: forgotten on read
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    if (!missing) console.warn('[claude-code] transcript scan failed:', (err as Error).message);
    watcher?.close();
    watcher = null;
    schedule(RETRY_MS);
    return;
  }
  schedule(RESCAN_MS);
}

function schedule(ms: number) {
  if (rescanTimer) clearTimeout(rescanTimer);
  rescanTimer = running ? setTimeout(() => void scan(), ms) : null;
  rescanTimer?.unref();
}

function startWatching(root: string): FSWatcher {
  const w = watch(root, { recursive: true }, (_type, name) => {
    if (name) changed(join(root, name.toString()));
  });
  w.on('error', (err) => {
    console.warn('[claude-code] transcript watcher failed:', err.message);
    if (watcher === w) watcher = null;
    w.close();
    schedule(RETRY_MS);
  });
  return w;
}

async function listTranscripts(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const project of await readdir(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const dir = join(root, project.name);
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(join(dir, entry.name));
      else if (entry.isDirectory()) {
        const subagents = join(dir, entry.name, 'subagents');
        for (const name of await readdir(subagents).catch(() => [] as string[])) {
          if (name.endsWith('.jsonl')) files.push(join(subagents, name));
        }
      }
    }
  }
  return files;
}

function changed(path: string) {
  if (!transcriptSession(projectsDir(), path)) return;
  clearTimeout(pending.get(path));
  pending.set(
    path,
    setTimeout(() => {
      pending.delete(path);
      enqueue(path);
    }, DEBOUNCE_MS),
  );
}

function enqueue(path: string) {
  queue = queue.then(() => readChanges(path)).catch((err) => console.warn('[claude-code] reading a transcript failed:', (err as Error).message));
}

async function readChanges(path: string) {
  if (!running) return;
  const sessionId = transcriptSession(projectsDir(), path);
  if (!sessionId) return;
  let entry = tracked.get(path);
  if (!entry) {
    // Unknown files are new since the last run: read them from the start.
    const saved = getTranscriptPosition(path);
    entry = { sessionId, cursor: saved ? { offset: saved.offset, inode: saved.inode, tools: new Map() } : newCursor() };
    tracked.set(path, entry);
  }
  let result;
  try {
    result = await readTranscript(path, sessionId, entry.cursor);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    tracked.delete(path);
    deleteTranscriptPosition(path);
    return;
  }
  for (const event of result.events) if (insertEvent(event)) claudeCodeActivity.emit('event', event);
  const moved = result.cursor.offset !== entry.cursor.offset || result.cursor.inode !== entry.cursor.inode;
  entry.cursor = result.cursor;
  if (moved) setTranscriptPosition(path, sessionId, result.cursor.offset, result.cursor.inode);
}
