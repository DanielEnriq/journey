import type { ClaudeCodeEvent, RoomSessionWaitingOn, WorkContext, Workstream } from '../../../shared/api.js';
import type { RoomWorkContext, RoomWorkstream } from '../room/data/sources.js';
import { classify } from './status.js';

// The boundary between WorkContextService (src/context, over IPC as context:work) and what a room shows.
// The room's WorkstreamDataSource.context() returns this shape; today that source is a mock, and the
// room backend will decide which repository a room is bound to and call toRoomWorkContext with it.
// Everything here is observed on this machine, so every workstream starts out `local`.

/** Observed events kept per workstream. */
const OBSERVED_LIMIT = 8;

export function toRoomWorkContext(context: WorkContext): RoomWorkContext {
  return {
    repo: context.repository.repository.name,
    generatedAt: context.generatedAt,
    workstreams: context.workstreams.map((w) => toRoomWorkstream(w, context)),
  };
}

export function toRoomWorkstream(w: Workstream, context: Pick<WorkContext, 'sessions' | 'activity'>, now = Date.now()): RoomWorkstream {
  const linked = new Set(w.sessions.map((s) => s.sessionId));
  // context.sessions is most recently active first, so the first linked one names the work.
  const session = context.sessions.find((s) => linked.has(s.id));
  const observed = context.activity
    .filter((e) => linked.has(e.sessionId))
    .slice(0, OBSERVED_LIMIT)
    .map((e) => ({ at: e.timestamp, text: describe(e) }));
  const stream: Omit<RoomWorkstream, 'status'> = {
    id: w.id,
    title: session?.title || w.branch || basename(w.worktreePath),
    agent: 'Claude Code',
    branch: w.branch,
    worktree: w.worktreePath,
    lastActivityAt: w.lastActivity?.timestamp ?? null,
    lastActivity: w.lastActivity ? describe(w.lastActivity) : null,
    ...(w.lastActivity && waitingOnOf(w.lastActivity) && { waitingOn: waitingOnOf(w.lastActivity)! }),
    changedFiles: w.changedFiles,
    sessions: w.sessions.length,
    visibility: 'local',
    observed,
  };
  return { ...stream, status: classify(stream, now) };
}

const EVENT_WORDS: Record<ClaudeCodeEvent['type'], string> = {
  SessionStart: 'Session started',
  UserPromptSubmit: 'Prompted',
  PostToolUse: 'Used',
  PostToolUseFailure: 'Failed',
  Notification: 'Asked',
  Stop: 'Finished a reply',
  SessionEnd: 'Session ended',
};

/** One event in words: what kind it was, the tool if any, and its redacted summary. */
export function describe(e: ClaudeCodeEvent): string {
  const head = e.toolName ? `${EVENT_WORDS[e.type]} ${e.toolName}` : EVENT_WORDS[e.type];
  return e.summary ? `${head}: ${e.summary}` : head;
}

/** What a Notification says the session waits for: a permission prompt names it, a question doesn't. */
export function waitingOnOf(e: Pick<ClaudeCodeEvent, 'type' | 'summary'>): RoomSessionWaitingOn | null {
  if (e.type !== 'Notification') return null;
  return /permission/i.test(e.summary ?? '') ? 'permission' : 'input';
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
