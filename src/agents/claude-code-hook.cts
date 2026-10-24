// Claude Code runs this for each hook event Vowe observes (installed by claude-code-hooks.ts).
// It's configured `async`, so Claude Code never waits on it; it must still be quick and silent:
// read the event from stdin, keep a small summary, drop it in the spool folder, exit 0.
//
// Standalone CommonJS run with Electron as plain Node: Node built-ins only, no local imports.
// It never reads environment variables, and tool inputs and outputs are reduced to one short line.
// The transcript watcher imports its helpers, so both sources summarize and redact the same way.

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, relative, isAbsolute } from 'node:path';

const MAX_SUMMARY = 200;
const spoolDir = process.argv[2];

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Masks the usual shapes of secrets that can turn up in commands and prompts. */
export function redact(text: string): string {
  return text
    .replace(/\b(bearer|basic)\s+[\w.~+/=-]+/gi, '$1 [redacted]')
    .replace(/\b(sk-[\w-]{8,}|gh[pousr]_\w{20,}|github_pat_\w{20,}|xox[abprs]-[\w-]+|AKIA[0-9A-Z]{16}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]+)/g, '[redacted]')
    .replace(/(\b[\w.-]*(?:key|token|secret|passw(?:or)?d|pwd|credential|auth)[\w.-]*\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1[redacted]')
    .replace(/(--?(?:token|password|secret|api-?key|key|auth)(?:\s+|=))("[^"]*"|'[^']*'|\S+)/gi, '$1[redacted]')
    .replace(/(\/\/)[^\s/:@]+:[^\s/@]+@/g, '$1[redacted]@');
}

export function clip(text: string | null): string | null {
  if (!text) return null;
  const line = redact(text.replace(/\s+/g, ' ').trim());
  return line.length > MAX_SUMMARY ? `${line.slice(0, MAX_SUMMARY - 1)}…` : line;
}

/** The file a file tool worked on, absolute, as evidence of which worktree a session touched. */
export function toolFilePath(name: string, input: unknown, cwd: string | null): string | null {
  if (!isObject(input) || !['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name)) return null;
  const path = str(input.file_path) ?? str(input.notebook_path);
  if (!path) return null;
  return isAbsolute(path) ? path : cwd ? join(cwd, path) : null;
}

function shortPath(path: string | null, cwd: string | null): string | null {
  if (!path || !cwd || !isAbsolute(path)) return path;
  const rel = relative(cwd, path);
  return rel && !rel.startsWith('..') ? rel : path;
}

/** One line saying what a tool call was about: the command, file, pattern, or URL. Never its output. */
export function describeTool(name: string, input: unknown, cwd: string | null): string | null {
  if (!isObject(input)) return null;
  switch (name) {
    case 'Bash':
      return str(input.description) ?? str(input.command);
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return shortPath(str(input.file_path), cwd);
    case 'NotebookEdit':
      return shortPath(str(input.notebook_path), cwd);
    case 'Grep':
    case 'Glob':
      return [str(input.pattern), shortPath(str(input.path), cwd)].filter(Boolean).join(' in ') || null;
    case 'WebFetch':
      return str(input.url)?.split('?')[0] ?? null;
    case 'WebSearch':
      return str(input.query);
    case 'TodoWrite':
      return 'Updated the to-do list';
  }
  for (const key of ['description', 'file_path', 'path', 'pattern', 'query', 'url', 'skill', 'name']) {
    const value = str(input[key]);
    if (value) return key.endsWith('path') ? shortPath(value, cwd) : value;
  }
  return null;
}

function normalize(input: Json) {
  const type = str(input.hook_event_name);
  const sessionId = str(input.session_id);
  if (!type || !sessionId) return null;
  const cwd = str(input.cwd);
  const toolName = str(input.tool_name);
  const filePath = toolName ? toolFilePath(toolName, input.tool_input, cwd) : null;
  let summary: string | null = null;
  switch (type) {
    case 'SessionStart':
      summary = str(input.source);
      break;
    case 'UserPromptSubmit':
      summary = str(input.prompt);
      break;
    case 'PostToolUse':
      summary = toolName && describeTool(toolName, input.tool_input, cwd);
      break;
    case 'PostToolUseFailure': {
      const what = toolName && describeTool(toolName, input.tool_input, cwd);
      const why = input.is_interrupt === true ? 'interrupted' : str(input.error);
      summary = [what, why].filter(Boolean).join(': ') || null;
      break;
    }
    case 'Stop':
      summary = str(input.last_assistant_message);
      break;
    case 'SessionEnd':
      summary = str(input.reason);
      break;
    default:
      return null;
  }
  return {
    id: randomUUID(),
    sessionId,
    type,
    timestamp: new Date().toISOString(),
    cwd,
    toolName,
    summary: clip(summary),
    subagent: Boolean(str(input.agent_id)),
    filePath,
  };
}

function run() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => (raw += chunk));
  process.stdin.on('end', () => onInput(raw));
}

function onInput(raw: string) {
  try {
    const input: unknown = JSON.parse(raw);
    const event = spoolDir && isObject(input) ? normalize(input) : null;
    if (!event) return;
    mkdirSync(spoolDir, { recursive: true });
    // Write then rename, so Vowe never reads a half-written file.
    const tmp = join(spoolDir, `${event.id}.tmp`);
    writeFileSync(tmp, JSON.stringify(event));
    renameSync(tmp, join(spoolDir, `${event.id}.json`));
  } catch {
    // Observing must never get in Claude Code's way: drop the event.
  }
}

if (require.main === module) run();
