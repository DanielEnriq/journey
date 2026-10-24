/**
 * One read-only view of the work in a repository: its Git state (from src/git), the Claude Code
 * sessions run in it (agents/claude-code.ts), and what hooks observed them doing
 * (agents/claude-code-hooks.ts). Callers get plain objects and never see where transcripts live.
 *
 * A workstream is one branch checked out in one worktree. A session is linked to a worktree by
 * evidence, and each link names it (WorkstreamSessionLink.basis): Git placing the session's working
 * directory in that worktree, failing that (the directory is gone) its path lying inside the
 * worktree, and separately, files its tools worked on there. Paths are compared after resolving
 * symlinks, and a directory Git places in another repository (say, one nested inside) isn't counted.
 * The link also says whether the branch the session recorded matches. Sessions that fit no
 * worktree are reported as unplaced rather than assigned.
 */

import { realpath } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { ClaudeCodeAdapter } from '../agents/claude-code.js';
import { recentEvents, sessionFilePaths } from '../database/claude-code-events.js';
import { getRepository, listRepositories, type Repository } from '../database/repositories.js';
import { getIndexedSession, getWorkstream, indexedSessionIds, indexSessions, touchWorkstream } from '../database/work-context.js';
import { diffFile, diffStat, getStatus, gitIdentity, listBranches, listCommits, listWorktrees } from '../git/index.js';
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
/** How long a directory's Git identity is trusted; worktrees come and go, but not by the second. */
const IDENTITY_TTL_MS = 60_000;

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

function link(session: ClaudeCodeSession, worktree: GitWorktree, basis: WorkstreamSessionLink['basis']): WorkstreamSessionLink {
  const recorded = session.gitBranch;
  // Claude Code records "HEAD" for a detached checkout: a real state, but not a branch to compare.
  const branch = !recorded ? 'unknown' : recorded === 'HEAD' ? 'detached' : recorded === worktree.branch ? 'same' : 'different';
  return { sessionId: session.id, basis, branch, sessionBranch: recorded };
}

type Placement = { worktree: GitWorktree; basis: 'cwd' | 'cwd-path' } | { worktree: null; reason: UnplacedSession['reason'] };

const summary = (repo: Repository) => ({ id: repo.id, name: repo.name, path: repo.path });
const newest = (a: ClaudeCodeEvent | null, b: ClaudeCodeEvent | null | undefined) => (!b || (a && a.timestamp >= b.timestamp) ? a : b);

export class WorkContextService {
  private canonicalPaths = new Map<string, Promise<string>>();
  private identities = new Map<string, { at: number; value: Promise<{ toplevel: string; commonDir: string } | null> }>();

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
    const worktrees = await this.canonicalWorktrees(repo.path);
    const events = recentEvents(ids, await this.matchDirs([repo.path, ...worktrees.map((w) => w.path)]), limit);
    return this.ownActivity(repo, new Set(ids), events);
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
      activity: work.activity.filter((e) => linked.has(e.sessionId) || worktreeOf(e.cwd && resolve(e.cwd), work.repository.worktrees)?.path === worktree.path),
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
    const [session, worktrees] = await Promise.all([this.claudeCode.getSession(repo.path, sessionId), this.canonicalWorktrees(repo.path)]);
    if (!session) return null;
    const placement = await this.place(session.cwd, worktrees.filter((w) => !w.bare && !w.prunable), await this.commonDir(repo.path));
    const { worktree } = placement;
    const workstreamId = worktree ? touchWorkstream(repo.id, worktree.path, worktree.branch ?? '').id : null;
    return {
      session,
      repository: summary(repo),
      worktree,
      workstreamId,
      link: placement.worktree ? link(session, placement.worktree, placement.basis) : null,
      activity: recentEvents([sessionId], [], RECENT_EVENTS),
      recentMessages: recentMessages ?? { sessionId, offset: 0, total: 0, messages: [] },
    };
  }

  private repository(id: string): Repository {
    const repo = getRepository(id);
    if (!repo) throw new Error('No such repository');
    return repo;
  }

  private canonical(path: string): Promise<string> {
    let known = this.canonicalPaths.get(path);
    if (!known) {
      // A path that no longer exists keeps its spelling; its parent may still resolve.
      known = realpath(path).catch(() => (dirname(path) === path ? path : this.canonical(dirname(path)).then((d) => resolve(d, path.slice(dirname(path).length + 1)))));
      this.canonicalPaths.set(path, known);
      if (this.canonicalPaths.size > 5000) this.canonicalPaths.clear();
    }
    return known;
  }

  private identity(dir: string) {
    const cached = this.identities.get(dir);
    if (cached && Date.now() - cached.at < IDENTITY_TTL_MS) return cached.value;
    const value = this.canonical(dir).then(async (path) => {
      const id = await gitIdentity(path);
      return id && { toplevel: await this.canonical(id.toplevel), commonDir: await this.canonical(id.commonDir) };
    });
    this.identities.set(dir, { at: Date.now(), value });
    return value;
  }

  private async commonDir(repoPath: string) {
    return (await this.identity(repoPath))?.commonDir ?? null;
  }

  /** Worktrees with their paths resolved, so they compare equal to resolved session paths. */
  private async canonicalWorktrees(repoPath: string): Promise<GitWorktree[]> {
    return Promise.all((await listWorktrees(repoPath)).map(async (w) => ({ ...w, path: await this.canonical(w.path) })));
  }

  /** Paths to match event directories against: as Git lists them and as they resolve, since events record them unresolved. */
  private async matchDirs(paths: string[]): Promise<string[]> {
    return [...new Set([...paths, ...(await Promise.all(paths.map((p) => this.canonical(p))))])];
  }

  /** Which worktree a session's directory is in, by Git if it can still say, else by path alone. */
  private async place(cwd: string | null, live: GitWorktree[], repoCommonDir: string | null): Promise<Placement> {
    if (!cwd) return { worktree: null, reason: 'no-cwd' };
    const id = await this.identity(cwd);
    if (id) {
      if (repoCommonDir && id.commonDir !== repoCommonDir) return { worktree: null, reason: 'other-repository' };
      const worktree = live.find((w) => w.path === id.toplevel);
      return worktree ? { worktree, basis: 'cwd' } : { worktree: null, reason: 'no-worktree' };
    }
    const worktree = worktreeOf(await this.canonical(cwd), live);
    return worktree ? { worktree, basis: 'cwd-path' } : { worktree: null, reason: 'no-worktree' };
  }

  /**
   * Drops events that matched only because their directory is under one of the repository's paths,
   * when Git places that directory in another repository.
   */
  private async ownActivity(repo: Repository, sessionIds: Set<string>, events: ClaudeCodeEvent[]): Promise<ClaudeCodeEvent[]> {
    const commonDir = await this.commonDir(repo.path);
    if (!commonDir) return events;
    const keep = await Promise.all(
      events.map(async (e) => sessionIds.has(e.sessionId) || !e.cwd || ((await this.identity(e.cwd))?.commonDir ?? commonDir) === commonDir),
    );
    return events.filter((_, i) => keep[i]);
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
    const [repository, sessions, commonDir] = await Promise.all([this.getRepositoryContext(repo.id), this.listSessions(repo.id), this.commonDir(repo.path)]);
    const { status } = repository;
    const listedPaths = repository.worktrees.map((w) => w.path);
    const worktrees = await Promise.all(repository.worktrees.map(async (w) => ({ ...w, path: await this.canonical(w.path) })));
    repository.worktrees = worktrees;
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
    const placements = await Promise.all(sessions.map((s) => this.place(s.cwd, live, commonDir)));
    const edited = sessionFilePaths(sessions.map((s) => s.id));
    for (const [i, session] of sessions.entries()) {
      const placement = placements[i];
      if (placement.worktree) {
        links.get(placement.worktree.path)!.push(link(session, placement.worktree, placement.basis));
        lastActivity.set(placement.worktree.path, newest(lastActivity.get(placement.worktree.path)!, session.activity?.lastEvent));
      } else {
        unplacedSessions.push({ sessionId: session.id, reason: placement.reason, cwd: session.cwd });
      }
      // A session can work on files in a worktree other than the one it runs in.
      const others = new Set<GitWorktree>();
      for (const file of edited.get(session.id) ?? []) {
        const worktree = worktreeOf(await this.canonical(file), live);
        if (worktree && worktree !== placement.worktree) others.add(worktree);
      }
      for (const worktree of others) links.get(worktree.path)!.push(link(session, worktree, 'edited-files'));
    }

    const activity = await this.ownActivity(
      repo,
      new Set(sessions.map((s) => s.id)),
      recentEvents(
        sessions.map((s) => s.id),
        await this.matchDirs(listedPaths),
        RECENT_EVENTS,
      ),
    );
    // Events from sessions too new to have a transcript count for the worktree they ran in.
    for (const event of activity) {
      const worktree = worktreeOf(event.cwd && (await this.canonical(event.cwd)), live);
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
