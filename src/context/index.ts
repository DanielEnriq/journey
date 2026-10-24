/**
 * One read-only view of the work in a repository: its Git state (from src/git), the Claude Code
 * sessions run in it (agents/claude-code.ts), and what hooks observed them doing
 * (agents/claude-code-hooks.ts). Callers get plain objects and never see where transcripts live.
 *
 * A workstream is one branch checked out in one worktree. Sessions are linked to the worktree their
 * working directory is in, and nothing else: the link says whether the branch they recorded still
 * matches, and sessions that fit no worktree are reported as unplaced rather than assigned.
 */

import { sep } from 'node:path';
import type { ClaudeCodeAdapter } from '../agents/claude-code.js';
import { recentEvents } from '../database/claude-code-events.js';
import { getRepository, listRepositories, type Repository } from '../database/repositories.js';
import { getIndexedSession, getWorkstream, indexedSessionIds, indexSessions, touchWorkstream } from '../database/work-context.js';
import { diffFile, diffStat, getStatus, listBranches, listCommits, listWorktrees } from '../git/index.js';
import type {
  ClaudeCodeEvent,
  ClaudeCodeMessage,
  ClaudeCodeSession,
  GitStatus,
  GitWorktree,
  RepositoryContext,
  SessionContext,
  SessionMessages,
  UnplacedSession,
  WorkContext,
  Workstream,
  WorkstreamContext,
  WorkstreamSessionLink,
  WorktreeChanges,
} from '../shared/api.js';

const RECENT_EVENTS = 100;
const RECENT_MESSAGES = 20;
const RECENT_COMMITS = 10;
const MAX_DIFF_FILES = 10;
const MAX_PATCH = 12_000;

/** All the text in a message that a search can match: what was said, and what tools were asked to do. */
function searchableText(m: ClaudeCodeMessage): string {
  return m.blocks
    .map((b) => (b.type === 'text' ? b.text : b.type === 'tool_use' ? `${b.name} ${b.input.text}` : b.type === 'tool_result' ? b.output.text : ''))
    .join('\n')
    .toLowerCase();
}

/** The worktree a directory is in: the deepest one, since worktrees can be nested in the main one. */
function worktreeOf(dir: string | null, worktrees: GitWorktree[]): GitWorktree | null {
  if (!dir) return null;
  let best: GitWorktree | null = null;
  for (const w of worktrees) {
    if ((dir === w.path || dir.startsWith(w.path + sep)) && (!best || w.path.length > best.path.length)) best = w;
  }
  return best;
}

function link(session: ClaudeCodeSession, worktree: GitWorktree): WorkstreamSessionLink {
  const recorded = session.gitBranch && session.gitBranch !== 'HEAD' ? session.gitBranch : null;
  const branch = !recorded || !worktree.branch ? 'unknown' : recorded === worktree.branch ? 'same' : 'different';
  return { sessionId: session.id, branch, sessionBranch: session.gitBranch };
}

const summary = (repo: Repository) => ({ id: repo.id, name: repo.name, path: repo.path });
const newest = (a: ClaudeCodeEvent | null, b: ClaudeCodeEvent | null | undefined) => (!b || (a && a.timestamp >= b.timestamp) ? a : b);

export class WorkContextService {
  constructor(private readonly claudeCode: ClaudeCodeAdapter) {}

  /** Lists the repository's sessions and refreshes their index, which lets a session be found by id alone. */
  async listSessions(repositoryId: string): Promise<ClaudeCodeSession[]> {
    const repo = this.repository(repositoryId);
    const sessions = await this.claudeCode.listSessions(repo.path);
    indexSessions(repo.id, sessions);
    return sessions;
  }

  async getRepositoryContext(repositoryId: string): Promise<RepositoryContext> {
    const repo = this.repository(repositoryId);
    const [status, worktrees, branches, recentCommits] = await Promise.all([
      getStatus(repo.path),
      listWorktrees(repo.path),
      listBranches(repo.path),
      listCommits(repo.path, RECENT_COMMITS),
    ]);
    return { repository: summary(repo), status, worktrees, branches, recentCommits };
  }

  /** Hook events from the repository's sessions or from any directory in its worktrees, newest first. */
  async getRecentActivity(repositoryId: string, limit = RECENT_EVENTS): Promise<ClaudeCodeEvent[]> {
    const repo = this.repository(repositoryId);
    let ids = indexedSessionIds(repo.id);
    if (!ids.length) ids = (await this.listSessions(repo.id)).map((s) => s.id);
    const worktrees = await listWorktrees(repo.path);
    return recentEvents(ids, [repo.path, ...worktrees.map((w) => w.path)], limit);
  }

  async getWorkContext(repositoryId: string): Promise<WorkContext> {
    return this.build(this.repository(repositoryId));
  }

  async listWorkstreams(repositoryId: string): Promise<Workstream[]> {
    return (await this.getWorkContext(repositoryId)).workstreams;
  }

  async getWorkstreamContext(workstreamId: string): Promise<WorkstreamContext | null> {
    const row = getWorkstream(workstreamId);
    const repo = row && getRepository(row.repositoryId);
    if (!repo) return null;
    const work = await this.build(repo);
    const workstream = work.workstreams.find((w) => w.id === workstreamId);
    if (!workstream) return null; // that branch isn't checked out there any more
    const worktree = work.repository.worktrees.find((w) => w.path === workstream.worktreePath)!;
    const linked = new Set(workstream.sessions.map((l) => l.sessionId));
    return {
      workstream,
      repository: work.repository.repository,
      status: worktree.main ? work.repository.status : await getStatus(worktree.path),
      sessions: work.sessions.filter((s) => linked.has(s.id)),
      activity: work.activity.filter((e) => linked.has(e.sessionId) || worktreeOf(e.cwd, work.repository.worktrees) === worktree),
    };
  }

  /**
   * Changes in a workstream's worktree, with the diffs of up to ten of its changed files. Only files
   * Git reports as changed can be diffed, so this never reads arbitrary paths.
   */
  async getWorktreeChanges(workstreamId: string, diffPaths: string[] = []): Promise<WorktreeChanges | null> {
    const context = await this.getWorkstreamContext(workstreamId);
    if (!context) return null;
    const { workstream, status } = context;
    const changed = new Map(status.files.map((f) => [f.path, f]));
    const unknown = diffPaths.filter((p) => !changed.has(p));
    if (unknown.length) throw new Error(`Not changed in this worktree: ${unknown.join(', ')}`);
    const [stats, recentCommits, diffs] = await Promise.all([
      diffStat(workstream.worktreePath),
      listCommits(workstream.worktreePath, RECENT_COMMITS),
      Promise.all(
        diffPaths.slice(0, MAX_DIFF_FILES).map(async (path) => {
          const patch = await diffFile(workstream.worktreePath, path, changed.get(path)!.unstaged === 'untracked');
          return { path, patch: patch.slice(0, MAX_PATCH), truncated: patch.length > MAX_PATCH };
        }),
      ),
    ]);
    return { workstream, status, diffStat: stats, recentCommits, diffs };
  }

  /**
   * Some of a session's messages: those best matching `query` (any of its words), or else the
   * `limit` messages before index `before` (default: the end).
   */
  async getSessionMessages(
    sessionId: string,
    options: { query?: string; before?: number; limit: number },
  ): Promise<SessionMessages | null> {
    const context = await this.getSessionContext(sessionId);
    if (!context) return null;
    const repo = this.repository(context.repository.id);
    const transcript = await this.claudeCode.getTranscript(repo.path, sessionId);
    const indexed = transcript.map((message, index) => ({ index, message }));
    let picked: typeof indexed;
    const terms = options.query?.toLowerCase().split(/\s+/).filter((t) => t.length > 1) ?? [];
    if (terms.length) {
      picked = indexed
        .map((m) => ({ m, score: terms.filter((t) => searchableText(m.message).includes(t)).length }))
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score || b.m.index - a.m.index)
        .slice(0, options.limit)
        .map((s) => s.m)
        .sort((a, b) => a.index - b.index);
    } else {
      const end = Math.min(options.before ?? transcript.length, transcript.length);
      picked = indexed.slice(Math.max(0, end - options.limit), end);
    }
    const { session, workstreamId, link, activity } = context;
    return { session, workstreamId, link, total: transcript.length, messages: picked, activity };
  }

  async getSessionContext(sessionId: string): Promise<SessionContext | null> {
    const repo = await this.repositoryOfSession(sessionId);
    if (!repo) return null;
    // Messages first: reading them is what makes the session's message count known.
    const recentMessages = await this.claudeCode.getMessages(repo.path, sessionId, { limit: RECENT_MESSAGES }).catch(() => null);
    const [session, worktrees] = await Promise.all([this.claudeCode.getSession(repo.path, sessionId), listWorktrees(repo.path)]);
    if (!session) return null;
    const worktree = worktreeOf(session.cwd, worktrees.filter((w) => !w.bare && !w.prunable));
    const workstreamId = worktree ? touchWorkstream(repo.id, worktree.path, worktree.branch ?? '').id : null;
    return {
      session,
      repository: summary(repo),
      worktree,
      workstreamId,
      link: worktree ? link(session, worktree) : null,
      activity: recentEvents([sessionId], [], RECENT_EVENTS),
      recentMessages: recentMessages ?? { sessionId, offset: 0, total: 0, messages: [] },
    };
  }

  private repository(id: string): Repository {
    const repo = getRepository(id);
    if (!repo) throw new Error('No such repository');
    return repo;
  }

  /** From the session index; a session not indexed yet is looked for in each repository. */
  private async repositoryOfSession(sessionId: string): Promise<Repository | null> {
    const indexed = getIndexedSession(sessionId);
    const repo = indexed && getRepository(indexed.repositoryId);
    if (repo) return repo;
    for (const candidate of listRepositories()) {
      if ((await this.listSessions(candidate.id)).some((s) => s.id === sessionId)) return candidate;
    }
    return null;
  }

  private async build(repo: Repository): Promise<WorkContext> {
    const [repository, sessions] = await Promise.all([this.getRepositoryContext(repo.id), this.listSessions(repo.id)]);
    const { status, worktrees } = repository;
    // Bare and deleted worktrees have no working tree for a session to have run in.
    const live = worktrees.filter((w) => !w.bare && !w.prunable);
    const statuses = new Map<string, GitStatus | null>(
      await Promise.all(
        live.map(async (w) => [w.path, w.main ? status : await getStatus(w.path).catch(() => null)] as const),
      ),
    );

    const links = new Map<string, WorkstreamSessionLink[]>(live.map((w) => [w.path, []]));
    const lastActivity = new Map<string, ClaudeCodeEvent | null>(live.map((w) => [w.path, null]));
    const unplacedSessions: UnplacedSession[] = [];
    for (const session of sessions) {
      const worktree = worktreeOf(session.cwd, live);
      if (!worktree) {
        unplacedSessions.push({ sessionId: session.id, reason: session.cwd ? 'no-worktree' : 'no-cwd', cwd: session.cwd });
        continue;
      }
      links.get(worktree.path)!.push(link(session, worktree));
      lastActivity.set(worktree.path, newest(lastActivity.get(worktree.path)!, session.activity?.lastEvent));
    }

    const activity = recentEvents(
      sessions.map((s) => s.id),
      worktrees.map((w) => w.path),
      RECENT_EVENTS,
    );
    // Events from sessions too new to have a transcript count for the worktree they ran in.
    for (const event of activity) {
      const worktree = worktreeOf(event.cwd, live);
      if (worktree) lastActivity.set(worktree.path, newest(lastActivity.get(worktree.path)!, event));
    }

    const workstreams: Workstream[] = live.map((w) => ({
      id: touchWorkstream(repo.id, w.path, w.branch ?? '').id,
      repositoryId: repo.id,
      worktreePath: w.path,
      mainWorktree: w.main,
      branch: w.branch,
      head: w.head,
      changedFiles: statuses.get(w.path)?.files.length ?? null,
      sessions: links.get(w.path)!,
      lastActivity: lastActivity.get(w.path)!,
    }));

    return {
      generatedAt: new Date().toISOString(),
      repository,
      workstreams,
      sessions,
      unplacedSessions,
      activity,
    };
  }
}
