/**
 * Observes independently running Claude Code sessions through Claude Code hooks. Passive only:
 * the hooks are `async`, so Claude Code never waits for them, and they never return a decision.
 *
 * Each hook run executes claude-code-hook.cjs, which writes one small JSON file per event into a
 * spool folder under userData. Main watches that folder (no polling), validates each file, stores
 * it in SQLite keyed by the hook's event id, and deletes the file. Events that arrive while Vowe is
 * closed wait in the spool and are read at the next launch; ids make re-reads harmless.
 *
 * Hooks are only added to Claude Code's user settings when the user asks (installHooks), merged
 * into whatever hooks are already there; uninstallHooks removes only ours.
 */

import { app } from 'electron';
import { EventEmitter } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, watch, type FSWatcher } from 'node:fs';
import { chmod, copyFile, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { insertEvent, latestEvents, pruneEvents } from '../database/claude-code-events.js';
import type { ClaudeCodeActivity, ClaudeCodeEvent, ClaudeCodeEventType, ClaudeCodeHooksStatus } from '../shared/api.js';

const EVENTS: ClaudeCodeEventType[] = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SessionEnd'];
/** Names the installed script; any hook command containing it is Vowe's. */
const SCRIPT_NAME = 'vowe-claude-hook.cjs';
/** Activity observed this recently counts as `active`; after that, nothing says what the session is doing. */
const ACTIVE_FOR_MS = 5 * 60_000;
const KEEP_EVENTS_DAYS = 30;

const baseDir = () => join(app.getPath('userData'), 'claude-code');
const spoolDir = () => join(baseDir(), 'events');
const installedScript = () => join(baseDir(), SCRIPT_NAME);
/** The compiled script inside the app; copied out so rebuilding or moving the app can't break a running hook. */
const bundledScript = join(import.meta.dirname, 'claude-code-hook.cjs');
export const claudeConfigDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const settingsPath = () => join(claudeConfigDir(), 'settings.json');

// ─── Activity ────────────────────────────────────────────────────────────────

/**
 * Hook events and transcript events. Both sources feed the same table and the same states, and
 * each event says which one it came from.
 */
export const claudeCodeActivity = new EventEmitter<{ event: [ClaudeCodeEvent] }>();

/** The state a session's latest event supports (see ClaudeCodeActivityState). */
export function activityFor(lastEvent: ClaudeCodeEvent, now = Date.now()): ClaudeCodeActivity {
  switch (lastEvent.type) {
    case 'SessionEnd':
      return { state: 'ended', lastEvent };
    case 'Stop':
      return { state: 'turn-completed', lastEvent };
    default:
      return { state: now - Date.parse(lastEvent.timestamp) < ACTIVE_FOR_MS ? 'active' : 'unknown', lastEvent };
  }
}

/** Activity for each of the given sessions that has any observed events. */
export function sessionActivity(sessionIds: string[]): Map<string, ClaudeCodeActivity> {
  const now = Date.now();
  return new Map([...latestEvents(sessionIds)].map(([id, event]) => [id, activityFor(event, now)]));
}

// ─── Spool ───────────────────────────────────────────────────────────────────

const nullableString = z.string().max(2000).nullable();
/** Spool files come from outside the app: check every field before storing. */
const spooledEvent = z
  .object({
    id: z.uuid(),
    sessionId: z.string().min(1).max(200),
    type: z.enum(EVENTS),
    timestamp: z.iso.datetime(),
    cwd: nullableString,
    toolName: nullableString,
    summary: nullableString,
    subagent: z.boolean(),
    // Hook scripts installed by older builds don't send it.
    filePath: nullableString.default(null),
  })
  .transform((e): ClaudeCodeEvent => ({ ...e, source: 'hook' }));

let watcher: FSWatcher | null = null;
let draining: Promise<void> | null = null;
let drainAgain = false;

/** Starts reading hook events: whatever queued up while the app was closed, then new ones as they land. */
export function startClaudeCodeObserver() {
  if (watcher) return;
  mkdirSync(spoolDir(), { recursive: true });
  pruneEvents(new Date(Date.now() - KEEP_EVENTS_DAYS * 86_400_000).toISOString());
  // Keep the installed script in step with this build of the app.
  if (existsSync(installedScript())) {
    try {
      copyFileSync(bundledScript, installedScript());
    } catch (err) {
      console.warn('[claude-code] could not update hook script:', (err as Error).message);
    }
  }
  watcher = watch(spoolDir(), () => void drain());
  watcher.on('error', (err) => console.warn('[claude-code] spool watcher failed:', err.message));
  void drain();
}

export function stopClaudeCodeObserver() {
  watcher?.close();
  watcher = null;
}

/** Reads every finished spool file; runs one pass at a time, plus one more if files landed meanwhile. */
function drain(): Promise<void> {
  if (draining) {
    drainAgain = true;
    return draining;
  }
  draining = (async () => {
    do {
      drainAgain = false;
      await drainOnce();
    } while (drainAgain);
  })()
    .catch((err) => console.warn('[claude-code] reading hook events failed:', (err as Error).message))
    .finally(() => (draining = null));
  return draining;
}

async function drainOnce() {
  const dir = spoolDir();
  const names = await readdir(dir).catch(() => [] as string[]);
  const batch: { file: string; event: ClaudeCodeEvent | null }[] = [];
  for (const name of names) {
    const file = join(dir, name);
    if (name.endsWith('.tmp')) {
      // A hook killed mid-write leaves its temp file behind.
      const age = await stat(file).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age > 60_000) await unlink(file).catch(() => {});
      continue;
    }
    if (!name.endsWith('.json')) continue;
    let event: ClaudeCodeEvent | null = null;
    try {
      const parsed = spooledEvent.safeParse(JSON.parse(await readFile(file, 'utf8')));
      if (parsed.success) event = parsed.data;
      else console.warn(`[claude-code] dropped malformed hook event ${name}`);
    } catch {
      console.warn(`[claude-code] dropped unreadable hook event ${name}`);
    }
    batch.push({ file, event });
  }
  // File names are random ids; announce events in the order they happened.
  batch.sort((a, b) => (a.event?.timestamp ?? '').localeCompare(b.event?.timestamp ?? ''));
  for (const { file, event } of batch) {
    if (event && insertEvent(event)) claudeCodeActivity.emit('event', event);
    // Stored or worthless either way. If the app dies before this, the event id stops a duplicate.
    await unlink(file).catch(() => {});
  }
}

// ─── Installing ──────────────────────────────────────────────────────────────

type HookCommand = { type?: unknown; command?: unknown };
type MatcherGroup = { matcher?: unknown; hooks?: unknown };

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** Electron's own binary runs the script as plain Node, so the hook doesn't need Node on Claude Code's PATH. */
const hookCommand = () => `ELECTRON_RUN_AS_NODE=1 ${quote(process.execPath)} ${quote(installedScript())} ${quote(spoolDir())}`;
const isOurs = (hook: unknown) => typeof (hook as HookCommand)?.command === 'string' && ((hook as HookCommand).command as string).includes(SCRIPT_NAME);

/** The settings file as an object, or a reason not to touch it. */
async function readSettings(): Promise<{ settings: Record<string, unknown>; exists: boolean } | { error: string }> {
  let text: string;
  try {
    text = await readFile(settingsPath(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { settings: {}, exists: false };
    return { error: `Can't read ${settingsPath()}: ${(err as Error).message}` };
  }
  let settings: unknown;
  try {
    settings = text.trim() ? JSON.parse(text) : {};
  } catch {
    return { error: `${settingsPath()} isn't valid JSON, so Vowe won't change it` };
  }
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return { error: `${settingsPath()} isn't a JSON object` };
  const hooks = (settings as Record<string, unknown>).hooks;
  if (hooks !== undefined && (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks))) {
    return { error: `"hooks" in ${settingsPath()} isn't an object` };
  }
  return { settings: settings as Record<string, unknown>, exists: true };
}

/** Our hooks taken out of every event, leaving other hooks (and the groups that hold them) as they were. */
function withoutOurs(hooks: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      next[event] = groups;
      continue;
    }
    const kept = groups.flatMap((group: MatcherGroup) => {
      if (!Array.isArray(group?.hooks) || !group.hooks.some(isOurs)) return [group];
      const others = group.hooks.filter((h) => !isOurs(h));
      return others.length ? [{ ...group, hooks: others }] : [];
    });
    if (kept.length || !groups.length) next[event] = kept;
  }
  return next;
}

async function writeSettings(settings: Record<string, unknown>, existed: boolean) {
  const path = settingsPath();
  mkdirSync(dirname(path), { recursive: true });
  // One backup of the file as it was before Vowe first changed it.
  const backup = `${path}.vowe-backup`;
  if (existed && !existsSync(backup)) await copyFile(path, backup);
  // Write beside it and rename, so Claude Code never reads a half-written file.
  const tmp = `${path}.vowe-${process.pid}.tmp`;
  const mode = existed ? (await stat(path)).mode & 0o777 : 0o600;
  await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode });
  await rename(tmp, path);
}

export async function getHooksStatus(): Promise<ClaudeCodeHooksStatus> {
  const read = await readSettings();
  if ('error' in read) return { state: 'not-installed', settingsPath: settingsPath(), error: read.error };
  const hooks = (read.settings.hooks ?? {}) as Record<string, unknown>;
  const command = hookCommand();
  const commands = (event: string) =>
    (Array.isArray(hooks[event]) ? (hooks[event] as MatcherGroup[]) : [])
      .flatMap((g) => (Array.isArray(g?.hooks) ? g.hooks : []))
      .filter(isOurs)
      .map((h: HookCommand) => h.command);
  const found = EVENTS.map(commands);
  const state = found.every((c) => c.length === 1 && c[0] === command) && existsSync(installedScript())
    ? 'installed'
    : found.some((c) => c.length)
      ? 'outdated'
      : 'not-installed';
  return { state, settingsPath: settingsPath(), error: null };
}

export async function installHooks(): Promise<ClaudeCodeHooksStatus> {
  const read = await readSettings();
  if ('error' in read) throw new Error(read.error);
  mkdirSync(spoolDir(), { recursive: true });
  await copyFile(bundledScript, installedScript());
  await chmod(installedScript(), 0o644);
  const hooks = withoutOurs((read.settings.hooks ?? {}) as Record<string, unknown>);
  for (const event of EVENTS) {
    const ours = { type: 'command', command: hookCommand(), async: true, timeout: 10 };
    hooks[event] = [...((hooks[event] as unknown[]) ?? []), { hooks: [ours] }];
  }
  await writeSettings({ ...read.settings, hooks }, read.exists);
  return getHooksStatus();
}

export async function uninstallHooks(): Promise<ClaudeCodeHooksStatus> {
  const read = await readSettings();
  if ('error' in read) throw new Error(read.error);
  if (read.settings.hooks !== undefined) {
    const { hooks: _hooks, ...rest } = read.settings;
    const hooks = withoutOurs(read.settings.hooks as Record<string, unknown>);
    await writeSettings(Object.keys(hooks).length ? { ...rest, hooks } : rest, read.exists);
  }
  await unlink(installedScript()).catch(() => {});
  return getHooksStatus();
}
