/**
 * Turns lines appended to a Claude Code transcript (~/.claude/projects/<dir>/<session id>.jsonl)
 * into observed events. Pure apart from reading the file, so it runs under plain Node in tests.
 *
 * A transcript is append-only JSONL written while Claude Code works, so a read can end mid-line:
 * only whole lines are consumed, and the rest is read again next time. Event ids come from the
 * lines' own uuids, so reading the same bytes twice yields the same ids and storage drops repeats.
 *
 * What a transcript shows: user prompts, tool results (and, from the preceding tool_use, which tool),
 * and assistant replies that ended a turn. What it doesn't: a session starting or ending, so those
 * come only from hooks.
 */

import { open } from 'node:fs/promises';
import type { ClaudeCodeEvent } from '../shared/api.js';
import { clip, describeTool, toolFilePath } from './claude-code-hook.cjs';

const NEWLINE = 0x0a;
/** Read this much per pass; a longer line is read whole by growing the buffer. */
const CHUNK = 4 * 1024 * 1024;
/** Tool calls awaiting their result; a call whose result never appears shouldn't be kept forever. */
const MAX_PENDING_TOOLS = 500;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);

interface PendingTool {
  name: string;
  summary: string | null;
  filePath: string | null;
}

/** Parsing state carried between reads of one transcript. */
export interface TranscriptCursor {
  /** Bytes consumed so far: always just after a newline. */
  offset: number;
  /** The file's inode when `offset` was taken; a different one means the file was replaced. */
  inode: number | null;
  /** Tool calls seen whose results haven't been, by tool_use id. Not persisted: after a restart, names of in-flight calls are unknown. */
  tools: Map<string, PendingTool>;
}

export const newCursor = (): TranscriptCursor => ({ offset: 0, inode: null, tools: new Map() });

/**
 * Events in whole lines of `bytes`; returns how many bytes those lines took. A trailing partial
 * line is left for the next read. Lines that aren't valid JSON are skipped.
 */
export function parseTranscriptBytes(bytes: Buffer, fallbackSessionId: string, tools: Map<string, PendingTool>): { events: ClaudeCodeEvent[]; consumed: number } {
  const end = bytes.lastIndexOf(NEWLINE);
  if (end === -1) return { events: [], consumed: 0 };
  const events: ClaudeCodeEvent[] = [];
  for (const line of bytes.subarray(0, end).toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (isObject(entry)) events.push(...lineEvents(entry, fallbackSessionId, tools));
  }
  while (tools.size > MAX_PENDING_TOOLS) tools.delete(tools.keys().next().value!);
  return { events, consumed: end + 1 };
}

function lineEvents(entry: Json, fallbackSessionId: string, tools: Map<string, PendingTool>): ClaudeCodeEvent[] {
  const uuid = str(entry.uuid);
  const timestamp = str(entry.timestamp);
  const message = isObject(entry.message) ? entry.message : null;
  if (!uuid || !timestamp || !message || Number.isNaN(Date.parse(timestamp))) return [];
  const base = {
    sessionId: str(entry.sessionId) ?? fallbackSessionId,
    source: 'transcript' as const,
    timestamp: new Date(timestamp).toISOString(),
    cwd: str(entry.cwd),
    subagent: entry.isSidechain === true,
  };
  const content = message.content;

  if (entry.type === 'assistant') {
    const blocks = Array.isArray(content) ? content.filter(isObject) : [];
    for (const b of blocks) {
      const id = str(b.id);
      const name = str(b.name);
      if (b.type === 'tool_use' && id && name) {
        tools.set(id, { name, summary: describeTool(name, b.input, base.cwd), filePath: toolFilePath(name, b.input, base.cwd) });
      }
    }
    // A subagent finishing isn't the session's turn ending.
    if (message.stop_reason !== 'end_turn' || base.subagent) return [];
    const text = blocks.flatMap((b) => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : [])).join('\n');
    return [{ ...base, id: `transcript:${uuid}`, type: 'Stop', toolName: null, summary: clip(text), filePath: null }];
  }

  if (entry.type !== 'user' || entry.isMeta === true || entry.isCompactSummary === true) return [];
  if (typeof content === 'string') {
    // Slash commands and their output are recorded as tagged user text, not prompts.
    if (content.trimStart().startsWith('<')) return [];
    return [{ ...base, id: `transcript:${uuid}`, type: 'UserPromptSubmit', toolName: null, summary: clip(content), filePath: null }];
  }
  if (!Array.isArray(content)) return [];
  const events: ClaudeCodeEvent[] = [];
  const text: string[] = [];
  for (const b of content.filter(isObject)) {
    if (b.type === 'text' && typeof b.text === 'string') text.push(b.text);
    if (b.type !== 'tool_result') continue;
    const toolUseId = str(b.tool_use_id);
    if (!toolUseId) continue;
    const tool = tools.get(toolUseId);
    tools.delete(toolUseId);
    const failed = b.is_error === true;
    const error = failed ? (typeof b.content === 'string' ? b.content : null) : null;
    events.push({
      ...base,
      id: `transcript:${uuid}:${toolUseId}`,
      type: failed ? 'PostToolUseFailure' : 'PostToolUse',
      toolName: tool?.name ?? null,
      summary: clip([tool?.summary, error].filter(Boolean).join(': ') || null),
      filePath: tool?.filePath ?? null,
    });
  }
  if (!events.length && text.length && !text.join('').trimStart().startsWith('<')) {
    events.push({ ...base, id: `transcript:${uuid}`, type: 'UserPromptSubmit', toolName: null, summary: clip(text.join('\n')), filePath: null });
  }
  return events;
}

/**
 * Reads what was appended to the transcript since `cursor`, and the cursor to read from next.
 * Starts over from the beginning if the file was replaced or got shorter; ids make that safe.
 */
export async function readTranscript(path: string, sessionId: string, cursor: TranscriptCursor): Promise<{ events: ClaudeCodeEvent[]; cursor: TranscriptCursor }> {
  const file = await open(path, 'r');
  try {
    const { size, ino } = await file.stat();
    let next = cursor;
    if ((cursor.inode !== null && cursor.inode !== ino) || size < cursor.offset) next = newCursor();
    next = { ...next, inode: ino };
    const events: ClaudeCodeEvent[] = [];
    let length = CHUNK;
    while (next.offset < size) {
      const want = Math.min(length, size - next.offset);
      const buffer = Buffer.alloc(want);
      const { bytesRead } = await file.read(buffer, 0, want, next.offset);
      const parsed = parseTranscriptBytes(buffer.subarray(0, bytesRead), sessionId, next.tools);
      if (!parsed.consumed) {
        if (next.offset + bytesRead >= size) break; // a line still being written
        length *= 2; // a line longer than the chunk
        continue;
      }
      events.push(...parsed.events);
      next = { ...next, offset: next.offset + parsed.consumed };
      length = CHUNK;
    }
    return { events, cursor: next };
  } finally {
    await file.close();
  }
}
