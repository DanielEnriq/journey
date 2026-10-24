/**
 * The collaborator's tools. Each is read-only, goes through the WorkContextService (never the
 * filesystem or Git directly), stays inside the conversation's repository, and returns a compact
 * summary sized for a model request rather than the raw objects.
 *
 * To add a tool: define it with defineTool and add it to a registry list below. A tool that would
 * send something that stays local by default asks first with ctx.authorize.
 */

import { relative } from 'node:path';
import { z } from 'zod';
import type { WorkContextService } from '../context/index.js';
import type { ClaudeCodeBlock, ClaudeCodeEvent, ClaudeCodeMessage } from '../shared/api.js';

export interface ToolContext {
  work: WorkContextService;
  repositoryId: string;
  workstreamId: string | null;
  /** Who the content would go to, for approval prompts. */
  providerName: string;
  /**
   * Asks the user before sending content that stays on this machine by default. Answers are
   * remembered per `key` for the conversation.
   */
  authorize(key: string, request: { title: string; detail: string }): Promise<boolean>;
}

export interface AgentTool<I = unknown> {
  name: string;
  /** What the model reads to decide when and how to use it. */
  description: string;
  input: z.ZodType<I>;
  run(input: I, ctx: ToolContext): Promise<unknown>;
}

export const defineTool = <I>(tool: AgentTool<I>) => tool as AgentTool<unknown>;

const short = (id: string | null | undefined) => id?.slice(0, 8) ?? null;
const shortHash = (hash: string | null) => hash?.slice(0, 7) ?? null;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** Hook events with what they said; only for sessions the user approved, since prompts show up in them. */
function events(list: ClaudeCodeEvent[], max: number) {
  return list.slice(0, max).map((e) => ({ type: e.type, tool: e.toolName, summary: e.summary, at: e.timestamp, subagent: e.subagent || undefined }));
}

// ─── list_coding_sessions ────────────────────────────────────────────────────

const listCodingSessions = defineTool({
  name: 'list_coding_sessions',
  description:
    "Lists the repository's Claude Code sessions, newest activity first, with the workstreams (branch + worktree) they ran in. " +
    'Each session has its title, timestamps, recorded branch, how confidently it is linked to a workstream, and its last observed hook state. ' +
    'Message content is not included; use read_coding_session for that. Start here for questions about what work is happening.',
  input: z
    .object({
      workstreamId: z.string().optional().describe('Only sessions linked to this workstream.'),
      limit: z.number().int().min(1).max(40).optional().describe('Most sessions to return (default 12).'),
    })
    .strict(),
  async run({ workstreamId, limit = 12 }, ctx) {
    const work = await ctx.work.getWorkContext(ctx.repositoryId);
    const root = work.repository.repository.path;
    const rel = (path: string | null) => (path ? relative(root, path) || '.' : null);
    const linkOf = new Map(work.workstreams.flatMap((w) => w.sessions.map((l) => [l.sessionId, { workstreamId: w.id, branchMatch: l.branch }] as const)));
    const sessions = work.sessions.filter((s) => !workstreamId || linkOf.get(s.id)?.workstreamId === workstreamId);
    return {
      observedAt: work.generatedAt,
      workstreams: work.workstreams.map((w) => ({
        id: w.id,
        branch: w.branch ?? `detached at ${shortHash(w.head)}`,
        worktree: rel(w.worktreePath),
        main: w.mainWorktree,
        changedFiles: w.changedFiles,
        sessions: w.sessions.length,
        lastActivity: w.lastActivity && { type: w.lastActivity.type, at: w.lastActivity.timestamp, session: short(w.lastActivity.sessionId) },
      })),
      sessions: sessions.slice(0, limit).map((s) => ({
        id: s.id,
        title: s.title,
        createdAt: s.createdAt,
        lastModifiedAt: s.lastModifiedAt,
        cwd: rel(s.cwd),
        recordedBranch: s.gitBranch,
        ...(linkOf.get(s.id) ?? { workstreamId: null, branchMatch: null }),
        messageCount: s.messageCount,
        state: s.activity?.state ?? 'unknown',
        lastHookEvent: s.activity && { type: s.activity.lastEvent.type, tool: s.activity.lastEvent.toolName, at: s.activity.lastEvent.timestamp },
      })),
      omittedSessions: Math.max(0, sessions.length - limit),
      unplacedSessions: work.unplacedSessions.length,
    };
  },
});

// ─── read_coding_session ─────────────────────────────────────────────────────

const MAX_TEXT = 1500;
const MAX_TOOL_OUTPUT = 400;

/** The gist of a tool call: its command, file, or pattern. Inputs can be clipped JSON, so fall back to raw text. */
function toolGist(block: Extract<ClaudeCodeBlock, { type: 'tool_use' }>): string {
  let detail = '';
  try {
    const input = JSON.parse(block.input.text) as Record<string, unknown>;
    const value = ['command', 'file_path', 'notebook_path', 'pattern', 'path', 'url', 'query', 'description', 'prompt'].map((k) => input[k]).find((v) => typeof v === 'string');
    detail = typeof value === 'string' ? value : '';
  } catch {
    detail = block.input.text;
  }
  return detail ? `${block.name}: ${clip(detail.replace(/\s+/g, ' '), 200)}` : block.name;
}

function condense(index: number, m: ClaudeCodeMessage) {
  const text = m.blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
  const toolCalls = m.blocks.flatMap((b) => (b.type === 'tool_use' ? [toolGist(b)] : []));
  const toolResults = m.blocks.flatMap((b) =>
    b.type === 'tool_result' ? [{ error: b.isError || undefined, output: clip(b.output.text, b.isError ? 2 * MAX_TOOL_OUTPUT : MAX_TOOL_OUTPUT) }] : [],
  );
  if (!text && !toolCalls.length && !toolResults.length) return null; // thinking only
  return {
    n: index,
    role: toolResults.length && !text ? 'tool results' : m.role,
    at: m.timestamp,
    subagent: m.parentToolUseId ? true : undefined,
    text: text ? clip(text, MAX_TEXT) : undefined,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    toolResults: toolResults.length ? toolResults : undefined,
  };
}

const readCodingSession = defineTool({
  name: 'read_coding_session',
  description:
    "Reads messages from one Claude Code session in the repository: what the user asked, what Claude Code said, the tools it called, and clipped tool output, plus the session's recent hook activity. " +
    'Each message has its index `n` for citing. Without `query`, returns the latest messages (or those before `before`); with `query`, returns the messages that best match any of its words. ' +
    'Ask for only what you need. The user is asked to approve sharing each session the first time; if they decline, say what you could not check.',
  input: z
    .object({
      sessionId: z.string().min(8).describe('Full session id, or its first 8+ characters.'),
      query: z.string().max(200).optional().describe('Words to search for, e.g. "retry backoff test".'),
      before: z.number().int().min(0).optional().describe('Return messages before this index, for paging back.'),
      limit: z.number().int().min(1).max(40).optional().describe('Most messages to return (default 20).'),
    })
    .strict(),
  async run({ sessionId, query, before, limit = 20 }, ctx) {
    const sessions = await ctx.work.listSessions(ctx.repositoryId);
    const matches = sessions.filter((s) => s.id.startsWith(sessionId.toLowerCase()));
    if (matches.length !== 1) throw new Error(matches.length ? 'That id prefix matches several sessions; use more characters.' : 'No session with that id in this repository.');
    const session = matches[0];
    const approved = await ctx.authorize(`session:${session.id}`, {
      title: `Share messages from "${clip(session.title, 80)}" with ${ctx.providerName}?`,
      detail: `To answer, Vowe wants to send excerpts of this Claude Code session (messages, tool calls, clipped tool output, and hook activity) to ${ctx.providerName}. Other sessions stay on this machine unless you approve them too.`,
    });
    if (!approved) return { declined: true, note: 'The user declined to share this session. Work from its metadata, and say what you could not check.' };
    const result = await ctx.work.getSessionMessages(session.id, { query, before, limit });
    if (!result) throw new Error('That session is no longer readable.');
    const messages = result.messages.flatMap(({ index, message }) => condense(index, message) ?? []);
    const first = result.messages[0]?.index;
    return {
      session: { id: session.id, title: session.title, recordedBranch: session.gitBranch, state: session.activity?.state ?? 'unknown', totalMessages: result.total },
      workstreamId: result.workstreamId,
      branchMatch: result.link?.branch ?? null,
      showing: query ? `${messages.length} messages best matching "${query}"` : `messages ${first ?? 0}–${(result.messages.at(-1)?.index ?? -1)} of ${result.total}`,
      earlierAvailable: !query && first !== undefined && first > 0 ? `call again with before=${first}` : undefined,
      messages,
      recentHookActivity: events(result.activity, 15),
    };
  },
});

// ─── get_repository_status ───────────────────────────────────────────────────

const MAX_FILES = 80;

const getRepositoryStatus = defineTool({
  name: 'get_repository_status',
  description:
    "Reads the repository's actual Git state now: current branch and upstream, changed files in the main worktree, every worktree with its workstream id, local branches, and recent commits.",
  input: z.object({}).strict(),
  async run(_input, ctx) {
    const work = await ctx.work.getWorkContext(ctx.repositoryId);
    const { repository, status, worktrees, branches, recentCommits } = work.repository;
    const workstreamOf = new Map(work.workstreams.map((w) => [w.worktreePath, w.id]));
    const local = branches.filter((b) => !b.remote);
    return {
      observedAt: work.generatedAt,
      repository: { name: repository.name, path: repository.path },
      branch: status.branch ?? `detached at ${shortHash(status.head)}`,
      head: shortHash(status.head),
      upstream: status.upstream,
      ahead: status.ahead,
      behind: status.behind,
      changedFiles: status.files.slice(0, MAX_FILES),
      omittedChangedFiles: Math.max(0, status.files.length - MAX_FILES),
      worktrees: worktrees.map((w) => ({
        workstreamId: workstreamOf.get(w.path) ?? null,
        path: w.path,
        branch: w.branch,
        head: shortHash(w.head),
        main: w.main,
        locked: w.locked || undefined,
        prunable: w.prunable || undefined,
      })),
      localBranches: local.slice(0, 30).map((b) => ({
        name: b.name,
        current: b.current || undefined,
        upstream: b.upstream,
        ahead: b.ahead,
        behind: b.behind,
        upstreamGone: b.upstreamGone || undefined,
        lastCommitAt: b.committedAt,
        checkedOutAt: b.worktreePath,
      })),
      omittedBranches: Math.max(0, local.length - 30),
      remoteBranches: branches.length - local.length,
      recentCommits: recentCommits.map((c) => ({ commit: shortHash(c.commit), subject: c.subject, author: c.author, at: c.committedAt })),
    };
  },
});

// ─── get_worktree_changes ────────────────────────────────────────────────────

const getWorktreeChanges = defineTool({
  name: 'get_worktree_changes',
  description:
    "Reads uncommitted changes in one workstream's worktree against its HEAD: each changed file with lines added/removed, recent commits, and the sessions linked to it. " +
    'Pass `diffPaths` (files from the changed list) to get their unified diffs, clipped. Defaults to the selected workstream, or the main worktree.',
  input: z
    .object({
      workstreamId: z.string().optional().describe('A workstream id from list_coding_sessions or get_repository_status.'),
      diffPaths: z.array(z.string()).max(10).optional().describe('Changed files to include diffs for, as listed.'),
    })
    .strict(),
  async run({ workstreamId, diffPaths = [] }, ctx) {
    let id = workstreamId ?? ctx.workstreamId;
    if (!id) id = (await ctx.work.listWorkstreams(ctx.repositoryId)).find((w) => w.mainWorktree)?.id ?? null;
    if (!id) throw new Error('The repository has no worktree with a working tree.');
    const changes = await ctx.work.getWorktreeChanges(id, diffPaths);
    if (!changes || changes.workstream.repositoryId !== ctx.repositoryId) throw new Error('No such workstream in this repository (its branch may no longer be checked out).');
    const { workstream, status, diffStat, recentCommits, diffs } = changes;
    const lines = new Map(diffStat.map((d) => [d.path, d]));
    return {
      workstream: { id: workstream.id, branch: workstream.branch ?? `detached at ${shortHash(workstream.head)}`, worktree: workstream.worktreePath, main: workstream.mainWorktree },
      upstream: status.upstream,
      ahead: status.ahead,
      behind: status.behind,
      files: status.files.slice(0, MAX_FILES).map((f) => ({
        path: f.path,
        renamedFrom: f.originalPath ?? undefined,
        staged: f.staged,
        unstaged: f.unstaged,
        conflicted: f.conflicted || undefined,
        added: lines.get(f.path)?.added,
        removed: lines.get(f.path)?.removed,
      })),
      omittedFiles: Math.max(0, status.files.length - MAX_FILES),
      recentCommits: recentCommits.slice(0, 5).map((c) => ({ commit: shortHash(c.commit), subject: c.subject, at: c.committedAt })),
      linkedSessions: workstream.sessions.map((l) => ({ id: short(l.sessionId), branchMatch: l.branch })),
      diffs,
    };
  },
});

/** The read-only tools over the work context. Future registries (room context, decisions, canvas, handoffs) sit beside it. */
export const workContextTools: AgentTool[] = [listCodingSessions, readCodingSession, getRepositoryStatus, getWorktreeChanges];
