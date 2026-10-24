/**
 * Reads Claude Code's own session transcripts (~/.claude/projects/…/<session id>.jsonl) through the
 * Agent SDK's local session utilities. Main only, and strictly read-only: this never starts,
 * resumes, renames, or deletes a session, and nothing it reads leaves the machine. Listing and
 * reading are plain file reads by the SDK; no Anthropic API call is made.
 *
 * Sessions are always looked up through a repository path from the database, so a renderer can only
 * read sessions that belong to a repository the user added (or one of its Git worktrees).
 */

import type { SDKSessionInfo, SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeCodeActivity, ClaudeCodeBlock, ClaudeCodeMessage, ClaudeCodeMessagePage, ClaudeCodeSession } from '../shared/api.js';

type Sdk = typeof import('@anthropic-ai/claude-agent-sdk');

/** The SDK bundle is large; load it on first use rather than at startup. */
let sdk: Promise<Sdk> | null = null;
const loadSdk = () => (sdk ??= import('@anthropic-ai/claude-agent-sdk'));

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
/** Tool inputs and results can be whole files; the UI only needs enough to see what happened. */
const MAX_TEXT = 4000;
/** Full transcripts kept parsed, so paging through one doesn't re-read the file for every page. */
const CACHED_TRANSCRIPTS = 4;

interface Transcript {
  /** Changes whenever Claude Code appends to the session. */
  version: string;
  messages: ClaudeCodeMessage[];
}

export class ClaudeCodeAdapter {
  readonly id = 'claude-code';
  readonly name = 'Claude Code';

  /** Working directory of each session last listed for a repository: where its transcript lives. */
  private sessionDirs = new Map<string, Map<string, string>>();
  private transcripts = new Map<string, Transcript>();

  /** `activity` looks up what hooks last reported for each session (claude-code-hooks.ts). */
  constructor(private readonly activity: (sessionIds: string[]) => Map<string, ClaudeCodeActivity> = () => new Map()) {}

  /** Sessions started in the repository or any of its Git worktrees, most recently active first. */
  async listSessions(repoPath: string): Promise<ClaudeCodeSession[]> {
    const { listSessions } = await loadSdk();
    const infos = await listSessions({ dir: repoPath, includeWorktrees: true });
    const valid = infos.filter((info) => SESSION_ID.test(info.sessionId));
    const activity = this.activity(valid.map((info) => info.sessionId));
    const sessions = valid.map((info) => this.toSession(info, activity.get(info.sessionId)));
    this.sessionDirs.set(repoPath, new Map(valid.map((info) => [info.sessionId, info.cwd ?? repoPath])));
    return sessions.sort((a, b) => b.lastModifiedAt.localeCompare(a.lastModifiedAt));
  }

  /** Current metadata of one of the repository's sessions, or null if it's gone. */
  async getSession(repoPath: string, sessionId: string): Promise<ClaudeCodeSession | null> {
    const dir = await this.sessionDir(repoPath, sessionId);
    if (!dir) return null;
    const { getSessionInfo } = await loadSdk();
    const info = await getSessionInfo(sessionId, { dir });
    return info ? this.toSession(info, this.activity([sessionId]).get(sessionId)) : null;
  }

  /**
   * A page of the session's user and assistant messages, oldest first. With no `offset`, returns
   * the latest page, so a long conversation opens at its end; earlier pages load on demand.
   */
  async getMessages(
    repoPath: string,
    sessionId: string,
    page: { offset?: number; limit?: number } = {},
  ): Promise<ClaudeCodeMessagePage> {
    const limit = Math.min(Math.max(1, Math.floor(page.limit ?? DEFAULT_PAGE_SIZE)), MAX_PAGE_SIZE);
    const dir = await this.sessionDir(repoPath, sessionId);
    if (!dir) throw new Error('No such Claude Code session in this repository');
    const { messages } = await this.transcript(sessionId, dir);
    const total = messages.length;
    const offset = page.offset === undefined ? Math.max(0, total - limit) : Math.min(Math.max(0, Math.floor(page.offset)), total);
    return { sessionId, offset, total, messages: messages.slice(offset, offset + limit) };
  }

  /** Every message of the session, oldest first: for searching it. Cached like getMessages. */
  async getTranscript(repoPath: string, sessionId: string): Promise<ClaudeCodeMessage[]> {
    const dir = await this.sessionDir(repoPath, sessionId);
    if (!dir) throw new Error('No such Claude Code session in this repository');
    return (await this.transcript(sessionId, dir)).messages;
  }

  /** Where a session's transcript lives, if the session belongs to the repository. */
  private async sessionDir(repoPath: string, sessionId: string): Promise<string | null> {
    if (!SESSION_ID.test(sessionId)) return null;
    const known = this.sessionDirs.get(repoPath)?.get(sessionId);
    if (known) return known;
    await this.listSessions(repoPath); // a session started since the last listing
    return this.sessionDirs.get(repoPath)?.get(sessionId) ?? null;
  }

  /**
   * The whole parsed conversation. The SDK only reads complete transcripts (its offset/limit slice
   * after parsing), so parse once per change to the file and page from memory.
   */
  private async transcript(sessionId: string, dir: string): Promise<Transcript> {
    const { getSessionInfo, getSessionMessages } = await loadSdk();
    const info = await getSessionInfo(sessionId, { dir });
    if (!info) throw new Error('This Claude Code session no longer exists or has no readable messages');
    const version = `${info.lastModified}:${info.fileSize ?? ''}`;
    const cached = this.transcripts.get(sessionId);
    if (cached?.version === version) {
      this.transcripts.delete(sessionId); // re-insert: Map order doubles as least-recently-used
      this.transcripts.set(sessionId, cached);
      return cached;
    }
    const raw = await getSessionMessages(sessionId, { dir });
    const transcript = { version, messages: raw.flatMap((m) => toMessage(m) ?? []) };
    this.transcripts.delete(sessionId);
    this.transcripts.set(sessionId, transcript);
    while (this.transcripts.size > CACHED_TRANSCRIPTS) this.transcripts.delete(this.transcripts.keys().next().value!);
    return transcript;
  }

  private toSession(info: SDKSessionInfo, activity: ClaudeCodeActivity | undefined): ClaudeCodeSession {
    return {
      id: info.sessionId,
      title: info.customTitle || info.summary || info.firstPrompt || 'Untitled session',
      firstPrompt: info.firstPrompt ?? null,
      cwd: info.cwd ?? null,
      gitBranch: info.gitBranch ?? null,
      createdAt: isoDate(info.createdAt),
      lastModifiedAt: isoDate(info.lastModified) ?? new Date(0).toISOString(),
      fileSize: info.fileSize ?? null,
      // Counting means parsing the whole transcript, so only sessions already read have a count.
      messageCount: this.transcripts.get(info.sessionId)?.messages.length ?? null,
      activity: activity ?? null,
    };
  }
}

function isoDate(ms: number | undefined): string | null {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// ─── Messages ────────────────────────────────────────────────────────────────
// SessionMessage.message is typed `unknown`: it's an Anthropic Messages API message as Claude Code
// wrote it, so read every field defensively and keep going past anything unexpected.

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null;
const str = (value: unknown) => (typeof value === 'string' ? value : '');

function clip(text: string): { text: string; truncated: boolean } {
  return text.length > MAX_TEXT ? { text: text.slice(0, MAX_TEXT), truncated: true } : { text, truncated: false };
}

function toMessage(m: SessionMessage): ClaudeCodeMessage | null {
  if (m.type !== 'user' && m.type !== 'assistant') return null;
  const body = isObject(m.message) ? m.message : {};
  const content = body.content;
  const blocks = typeof content === 'string' ? [textBlock(content)] : Array.isArray(content) ? content.map(toBlock) : [];
  // Not in the SDK's type, but present on every transcript entry.
  const timestamp = (m as { timestamp?: unknown }).timestamp;
  return {
    uuid: m.uuid,
    role: m.type,
    timestamp: typeof timestamp === 'string' ? timestamp : null,
    parentToolUseId: m.parent_tool_use_id ?? null,
    blocks,
  };
}

function textBlock(text: string): ClaudeCodeBlock {
  return { type: 'text', ...clip(text) };
}

function toBlock(block: unknown): ClaudeCodeBlock {
  if (!isObject(block)) return { type: 'other', kind: typeof block };
  switch (block.type) {
    case 'text':
      return textBlock(str(block.text));
    case 'thinking':
      return { type: 'thinking', ...clip(str(block.thinking)) };
    case 'tool_use':
    case 'server_tool_use':
      return { type: 'tool_use', id: str(block.id), name: str(block.name), input: clip(stringify(block.input)) };
    case 'tool_result':
      return { type: 'tool_result', toolUseId: str(block.tool_use_id), isError: block.is_error === true, output: clip(resultText(block.content)) };
    case 'image':
      return { type: 'image' };
    default:
      return { type: 'other', kind: str(block.type) || 'unknown' };
  }
}

/** A tool result is a string or a list of text/image blocks. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (isObject(part) ? (part.type === 'text' ? str(part.text) : `[${str(part.type) || 'content'}]`) : '')).join('\n');
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return String(value);
  }
}
