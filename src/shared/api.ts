/**
 * The contract between main and renderer. Types only: the sandboxed preload can't
 * load local modules at runtime, so nothing here may emit JavaScript.
 *
 * Adding a capability: declare it in `Channels`, handle it in main/ipc.ts, and
 * expose it in preload/index.cts + `JourneyApi`. The compiler checks all three agree.
 */

import type { CanvasCommand, CanvasSnapshot } from '../assistant/canvas.js';
import type { Grounding } from '../assistant/evidence.js';
import type { ModelBilling, ModelProviderErrorCode } from '../assistant/provider.js';
import type { Tables } from '../integrations/supabase/types.js';
import type { CanvasChanged, CanvasDocument, CanvasPresence, CommandResult } from './canvas/index.js';
import type { HeardSpeech, VoiceStatus } from '../voice/index.js';
import type { About, Change, PR, VoweRecord } from './vowe/model.js';
import type { PlanOp } from './vowe/plan.js';

export type { CanvasCommand, CanvasSnapshot, Grounding };

export interface User {
  /** This machine's id for the person: the Google `sub` for a Google session, the cloud user id for GitHub. */
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
  /** How this session signed in. Either way it's the same Vowe account once the methods are linked. */
  provider: SignInProvider;
}

// ─── Sign-in methods ─────────────────────────────────────────────────────────
// Ways to sign in to Vowe. Each is an identity on the person's one Supabase user, so every method reaches
// the same rooms. Signing in proves who someone is and grants nothing else: repository access and
// ChatGPT model access are separate grants with their own consent (see docs/AUTH.md).

export type SignInProvider = 'google' | 'github';

export type AuthErrorCode =
  /** The person cancelled, here or on the provider's page. */
  | 'cancelled'
  | 'timed-out'
  /** This build or its Supabase project doesn't offer that method, or isn't set up safely for it. */
  | 'not-configured'
  /** The provider has no verified email for the account, and Vowe won't join accounts on an unverified one. */
  | 'email-unverified'
  /** Already one of your sign-in methods. */
  | 'already-linked'
  /** That Google or GitHub account already signs in to a different Vowe account; nothing was merged. */
  | 'linked-elsewhere'
  | 'not-linked'
  /** Removing it would leave no way to sign in. */
  | 'last-method'
  /** It's how this session signed in; sign in another way to remove it. */
  | 'current-method'
  | 'signed-out'
  /** The session ended (revoked, expired, or signed out elsewhere); sign in again. */
  | 'session-expired'
  | 'unknown';

export interface AuthFailure {
  code: AuthErrorCode;
  /** Says what happened and what to do, for showing as is. */
  message: string;
  provider?: SignInProvider;
}

/** What sign-in method channels resolve with: failures are values, so the code survives IPC. */
export type AuthResult<T> = { ok: true; value: T } | { ok: false; error: AuthFailure };

export interface SignInMethod {
  provider: SignInProvider;
  /** Whether it's on this Vowe account. */
  linked: boolean;
  /** The provider account: its email, plus the username for GitHub. Null when not linked. */
  email: string | null;
  username: string | null;
  linkedAt: string | null;
  /** This session signed in with it. */
  current: boolean;
  /** Whether this build can sign in and link with it right now. */
  available: boolean;
  /** unlink() would be allowed: it's linked, not this session's method, and another method remains. */
  canUnlink: boolean;
}

export type Theme = 'system' | 'light' | 'dark';

/** Every app preference. Add a key here and a default + validator in database/settings.ts. */
export interface Settings {
  theme: Theme;
}

export interface Repository {
  id: string;
  path: string;
  name: string;
  addedAt: string;
  lastOpenedAt: string | null;
}

/** A repository found on disk by repos.detect(), not yet added. */
export interface DetectedRepository {
  path: string;
  name: string;
}

// ─── Git ─────────────────────────────────────────────────────────────────────
// Read from the repository's working tree by main (src/git). Paths are absolute.

export type GitChange = 'modified' | 'type-changed' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked';

export interface GitFileChange {
  /** Relative to the working tree root. */
  path: string;
  /** The path before a rename or copy. */
  originalPath: string | null;
  /** Change in the index, relative to HEAD. */
  staged: GitChange | null;
  /** Change in the working tree, relative to the index. Untracked files only have this. */
  unstaged: GitChange | null;
  /** A merge conflict; `staged` and `unstaged` are null. */
  conflicted: boolean;
}

export interface GitStatus {
  /** Null when HEAD is detached. */
  branch: string | null;
  /** Commit hash of HEAD; null before the first commit. */
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFileChange[];
}

export interface GitCommit {
  commit: string;
  author: string;
  committedAt: string;
  subject: string;
}

export interface GitDiffStat {
  path: string;
  /** Null for binary files. */
  added: number | null;
  removed: number | null;
}

export interface GitBranch {
  /** e.g. "main", or "origin/main" for a remote-tracking branch. */
  name: string;
  remote: boolean;
  /** Checked out in the repository's own working tree. */
  current: boolean;
  commit: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** The upstream was deleted on the remote. */
  upstreamGone: boolean;
  /** ISO 8601 date of the tip commit. */
  committedAt: string | null;
  /** The worktree that has this branch checked out, if any. */
  worktreePath: string | null;
}

export interface GitWorktree {
  path: string;
  /** Null for a bare repository. */
  head: string | null;
  /** Null when detached or bare. */
  branch: string | null;
  /** The repository's own working tree, as opposed to one made with `git worktree add`. */
  main: boolean;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  /** Its directory is gone; `git worktree prune` would remove it. */
  prunable: boolean;
}

// ─── Claude Code sessions ────────────────────────────────────────────────────
// Read-only views of Claude Code's local transcripts (src/agents/claude-code.ts). They stay on
// this machine: nothing here is synced to the cloud.

/** A Claude Code session started in a repository or one of its worktrees. Times are ISO 8601. */
export interface ClaudeCodeSession {
  id: string;
  /** The /rename title, else Claude Code's summary, else the first prompt. */
  title: string;
  firstPrompt: string | null;
  /** Where the session ran: the repository, a subfolder, or one of its worktrees. */
  cwd: string | null;
  /** Branch at the end of the session ("HEAD" when detached). */
  gitBranch: string | null;
  createdAt: string | null;
  lastModifiedAt: string;
  /** Transcript size in bytes. */
  fileSize: number | null;
  /** Counting means reading the whole transcript, so this is null until its messages are read. */
  messageCount: number | null;
  /** What hooks last reported for the session; null if none were observed. */
  activity: ClaudeCodeActivity | null;
}

/**
 * What Vowe observes of a Claude Code session, named after the hook events. Hooks report all seven
 * (agents/claude-code-hooks.ts); the transcript watcher (agents/claude-code-watcher.ts) sees prompts,
 * tool results, and completed turns, but never a session starting or ending.
 */
export type ClaudeCodeEventType = 'SessionStart' | 'UserPromptSubmit' | 'PostToolUse' | 'PostToolUseFailure' | 'Notification' | 'Stop' | 'SessionEnd';

/** One observed event, reduced to a summary line; tool inputs and outputs aren't kept. */
export interface ClaudeCodeEvent {
  /** The hook's own id, or `transcript:<line uuid>[:<tool use id>]`, so re-reading never duplicates one. */
  id: string;
  sessionId: string;
  type: ClaudeCodeEventType;
  /** `hook`: from Vowe's Claude Code hooks; `transcript`: read from a line appended to the session's transcript. */
  source: 'hook' | 'transcript';
  /** When it happened, ISO 8601. */
  timestamp: string;
  cwd: string | null;
  /** For PostToolUse and PostToolUseFailure. */
  toolName: string | null;
  /**
   * One redacted line: the tool's command, file, or pattern (plus the error on a failure), the
   * prompt, the end of Claude's reply on Stop, what it asked for on Notification, the start source,
   * or the end reason.
   */
  summary: string | null;
  /** Fired inside a subagent rather than the main conversation. */
  subagent: boolean;
  /** The absolute path a file tool (Read, Write, Edit…) worked on: evidence of which worktree it touched. */
  filePath: string | null;
}

/**
 * What the latest observed event says about a session. None of these claims a process is running:
 * a long tool call and a killed process look the same from outside.
 * - `active`: new activity (a start, prompt, or tool call) was observed in the last few minutes;
 *   it lapses to `unknown` after that.
 * - `waiting`: Claude asked its user for permission or an answer, and nothing has happened since.
 * - `turn-completed`: Claude finished a reply and was waiting on its user.
 * - `ended`: the session exited; only a SessionEnd hook confirms this.
 * - `unknown`: nothing observed recently enough to say.
 */
export type ClaudeCodeActivityState = 'active' | 'waiting' | 'turn-completed' | 'ended' | 'unknown';

export interface ClaudeCodeActivity {
  state: ClaudeCodeActivityState;
  lastEvent: ClaudeCodeEvent;
}

/** Whether Vowe's hooks are in Claude Code's user settings. They apply to sessions started afterwards. */
export interface ClaudeCodeHooksStatus {
  /** `outdated`: some are missing or point at another copy of Vowe; installing again fixes it. */
  state: 'installed' | 'not-installed' | 'outdated';
  settingsPath: string;
  /** Why the settings couldn't be read, e.g. invalid JSON; Vowe won't change them then. */
  error: string | null;
}

/** Long text cut to a few thousand characters; `truncated` says whether anything was cut. */
export interface ClippedText {
  text: string;
  truncated: boolean;
}

/** One content block of a message, simplified from the Anthropic Messages API shape. */
export type ClaudeCodeBlock =
  | ({ type: 'text' } & ClippedText)
  | ({ type: 'thinking' } & ClippedText)
  /** `input` is the tool's arguments as pretty-printed JSON. */
  | { type: 'tool_use'; id: string; name: string; input: ClippedText }
  | { type: 'tool_result'; toolUseId: string; isError: boolean; output: ClippedText }
  | { type: 'image' }
  /** A block type this view doesn't show, e.g. redacted_thinking. */
  | { type: 'other'; kind: string };

export interface ClaudeCodeMessage {
  uuid: string;
  /** Tool results come back as `user` messages. */
  role: 'user' | 'assistant';
  timestamp: string | null;
  /** Set when the message belongs to a subagent run by that tool call. */
  parentToolUseId: string | null;
  blocks: ClaudeCodeBlock[];
}

export interface ClaudeCodeMessagePage {
  sessionId: string;
  /** Index of the first message returned. */
  offset: number;
  /** Messages in the whole conversation. */
  total: number;
  /** Oldest first. */
  messages: ClaudeCodeMessage[];
}

// ─── Work context ────────────────────────────────────────────────────────────
// Git state, Claude Code sessions, and hook activity for a repository, combined by
// context/index.ts. Relationships come only from recorded facts (directories, branch names);
// where those don't settle one, the uncertainty is kept instead of guessed away.

export interface RepositoryContext {
  repository: Pick<Repository, 'id' | 'name' | 'path'>;
  /** Of the repository's own working tree. */
  status: GitStatus;
  worktrees: GitWorktree[];
  branches: GitBranch[];
  /** On the main worktree's HEAD, newest first. */
  recentCommits: GitCommit[];
}

/**
 * Why a session is linked to a workstream, and how sure that is. A session can be linked to more
 * than one workstream (it ran in one worktree and edited files in another).
 *
 * `basis`, the evidence for the link:
 * - `cwd`: Git confirms the session's directory is in this worktree of this repository.
 * - `cwd-path`: the directory is under this worktree's path, but Git couldn't confirm it (it's gone).
 * - `edited-files`: it ran elsewhere, but file edits observed from it are in this worktree.
 *
 * `branch`, whether it's the same piece of work as what's checked out now:
 * - `same`: the session's last recorded branch is the one checked out now.
 * - `different`: it recorded another branch.
 * - `detached`: it recorded a detached HEAD, so which commit it was on is unknown.
 * - `unknown`: nothing was recorded, or the evidence (edited files) says nothing about branches.
 */
export interface WorkstreamSessionLink {
  sessionId: string;
  basis: 'cwd' | 'cwd-path' | 'edited-files';
  branch: 'same' | 'different' | 'detached' | 'unknown';
  /** The branch the session recorded; `HEAD` means detached. */
  sessionBranch: string | null;
}

/** A session that can't be placed in any current worktree. */
export interface UnplacedSession {
  sessionId: string;
  /**
   * `no-cwd`: none was recorded; `no-worktree`: its directory isn't in a worktree that still exists;
   * `other-repository`: Git says its directory belongs to another repository (say, one nested inside).
   */
  reason: 'no-cwd' | 'no-worktree' | 'other-repository';
  cwd: string | null;
}

/** One branch checked out in one worktree: a piece of work in progress. Ids are stable across launches. */
export interface Workstream {
  id: string;
  repositoryId: string;
  worktreePath: string;
  mainWorktree: boolean;
  /** Null when HEAD is detached. */
  branch: string | null;
  head: string | null;
  /** Files changed in this worktree's working tree or index; null if its status couldn't be read. */
  changedFiles: number | null;
  sessions: WorkstreamSessionLink[];
  /** The latest hook event from a linked session or from a directory in this worktree. */
  lastActivity: ClaudeCodeEvent | null;
}

export interface WorkstreamContext {
  workstream: Workstream;
  repository: Pick<Repository, 'id' | 'name' | 'path'>;
  /** Branch, upstream, and changed files of this worktree. */
  status: GitStatus;
  /** The linked sessions, most recently active first; `workstream.sessions` says how each is linked. */
  sessions: ClaudeCodeSession[];
  activity: ClaudeCodeEvent[];
}

export interface SessionContext {
  session: ClaudeCodeSession;
  repository: Pick<Repository, 'id' | 'name' | 'path'>;
  /** The worktree its directory is in, if it still exists. */
  worktree: GitWorktree | null;
  /** The workstream for that worktree's current branch, and how the session relates to it. */
  workstreamId: string | null;
  link: WorkstreamSessionLink | null;
  activity: ClaudeCodeEvent[];
  /** The latest messages; older pages come from claudeCode.messages. */
  recentMessages: ClaudeCodeMessagePage;
}

/** What changed in one workstream's worktree, against its HEAD. */
export interface WorktreeChanges {
  workstream: Workstream;
  status: GitStatus;
  /** Tracked files only; untracked ones are in `status.files`. */
  diffStat: GitDiffStat[];
  recentCommits: GitCommit[];
  /** Only for the files asked for, each clipped. */
  diffs: { path: string; patch: string; truncated: boolean }[];
}

/** Messages picked out of a session by position or by search, each with its index in the conversation. */
export interface SessionMessages {
  session: ClaudeCodeSession;
  workstreamId: string | null;
  link: WorkstreamSessionLink | null;
  /** Messages in the whole conversation. */
  total: number;
  messages: { index: number; message: ClaudeCodeMessage }[];
  activity: ClaudeCodeEvent[];
}

/** Lines of tracked files that matched a code search. */
export interface CodeSearch {
  /** The worktree searched. */
  root: string;
  matches: { path: string; line: number; text: string }[];
  omitted: number;
}

/** Some lines of one tracked file, each prefixed with its number. */
export interface CodeExcerpt {
  /** Relative to the worktree. */
  path: string;
  from: number;
  to: number;
  totalLines: number;
  text: string;
}

/** Everything known about the work in one repository, in one object. */
export interface WorkContext {
  generatedAt: string;
  repository: RepositoryContext;
  workstreams: Workstream[];
  /** Every session of the repository, most recently active first. */
  sessions: ClaudeCodeSession[];
  unplacedSessions: UnplacedSession[];
  /** Newest first. */
  activity: ClaudeCodeEvent[];
}

// ─── Collaborator agent ──────────────────────────────────────────────────────
// Vowe's own agent (src/assistant): answers questions about the work using read-only tools over the
// work context. It never changes anything, and transcript excerpts reach the model provider only for
// sessions the user approves.

/** What the agent is looking at: a repository, and optionally one of its workstreams. */
export interface AgentContext {
  repositoryId: string;
  workstreamId: string | null;
}

export interface AgentToolCall {
  id: string;
  name: string;
  input: unknown;
  /** Set when the input was invalid or the tool failed; the model is told the same. */
  error: string | null;
}

/** Asks the user before content that stays local by default is sent to the model provider. */
export interface AgentApprovalRequest {
  id: string;
  conversationId: string;
  title: string;
  detail: string;
}

export interface AgentReply {
  conversationId: string;
  text: string;
  toolCalls: AgentToolCall[];
  /** The model that wrote the answer; can differ from the configured one after a fallback. */
  model: string | null;
  /**
   * `answered` normally; `step-limit` when it had to answer before finishing its investigation;
   * `truncated` when the answer hit the output limit; `refused` when the model declined.
   */
  stop: 'answered' | 'step-limit' | 'truncated' | 'refused';
}

export interface AgentStatus {
  /** The provider the next turn would use, e.g. "ChatGPT". */
  provider: string;
  providerId: string;
  /** Who pays: the person's ChatGPT plan, or an API key on this machine. */
  billing: ModelBilling;
  model: string;
  /** Whether credentials appear to be set; a request can still fail on them. */
  configured: boolean;
  chatgpt: ChatGptStatus;
}

// ─── Sign in with ChatGPT ────────────────────────────────────────────────────
// Separate from Google sign-in (which is who you are in rooms): this lets Vowe's agent use your
// ChatGPT plan for its requests. Tokens stay in main (integrations/openai/chatgpt.ts).

export interface ChatGptStatus {
  /** Whether this build offers ChatGPT plan usage at all (its eligibility gate). */
  enabled: boolean;
  /** The active account, signed in or not. */
  account: { clientId: string; email: string | null; label: string } | null;
  signedIn: boolean;
  /** Whether plan usage was granted at sign-in; null with no account. */
  planUsage: 'granted' | 'not-granted' | null;
  /** Show "You're using your ChatGPT plan" once; dismissWelcome() after "Got it". */
  welcome: boolean;
  /** Why the account needs to sign in again, in words. */
  problem: string | null;
  savedAccounts: { clientId: string; label: string; signedIn: boolean }[];
  /** ChatGPT settings → Usage, for "Manage usage". */
  usageUrl: string;
}

// ─── Vowe in a room ──────────────────────────────────────────────────────────
// One runtime for typed questions and, later, the call's voice participant (src/assistant/voice.ts).
// It runs on the asking person's machine, with their model sign-in and their local context; see
// src/assistant/INTEGRATION.md.

/** A question to Vowe from someone in a room. */
export interface RoomAgentTurn {
  roomId: string;
  /** The cloud user asking. Must be the person signed in on this machine. */
  participant: { userId: string; name: string | null };
  question: string;
  /** What was said before, oldest first, for context (a few turns). */
  recentTurns: { speaker: string; text: string; at?: string }[];
  /** What the asker's canvas shows, including what they selected or circled. */
  canvas: CanvasSnapshot;
  /** Continues an earlier turn's conversation; null or absent starts one. */
  conversationId?: string | null;
  source: 'text' | 'voice';
}

export interface AgentError {
  code: ModelProviderErrorCode | 'not-authorized' | 'busy' | 'invalid-turn';
  message: string;
  retryable: boolean;
  /** For usage limits: ChatGPT settings → Usage. */
  manageUrl?: string;
  /** OpenAI's or Anthropic's own code and request id, for diagnosis. */
  providerCode?: string;
  requestId?: string;
}

export interface AgentProviderInfo {
  id: string;
  name: string;
  billing: ModelBilling;
  model: string;
}

export interface RoomAgentReply {
  turnId: string;
  conversationId: string;
  roomId: string;
  text: string;
  stop: AgentReply['stop'] | 'cancelled' | 'failed';
  /** The claims behind the answer, checked against what the tools returned. */
  grounding: Grounding;
  /** The same, as it may be shown to the room: local excerpts and session ids removed (groundingForRoom). Post this one. */
  roomGrounding: Grounding;
  /** Validated canvas requests, in the order they were made. */
  commands: CanvasCommand[];
  toolCalls: AgentToolCall[];
  /** What the question was resolved against. */
  focus: { how: 'circled' | 'selected' | 'none'; componentIds: string[] };
  provider: AgentProviderInfo;
  /** The model that wrote the answer. */
  model: string | null;
  error?: AgentError;
}

/** Everything a turn does, in order. A turn ends with exactly one of completed, cancelled, or error. */
export type AgentEvent =
  | { type: 'turn.started'; turnId: string; conversationId: string; roomId: string; provider: AgentProviderInfo }
  /** Partial answer text. `step` counts model calls; text before a tool call is Vowe thinking aloud. */
  | { type: 'text.delta'; turnId: string; step: number; delta: string }
  /** The answer's full text, once known. */
  | { type: 'text.final'; turnId: string; text: string }
  | { type: 'tool.started'; turnId: string; call: { id: string; name: string; input: unknown } }
  | { type: 'tool.finished'; turnId: string; call: AgentToolCall; evidence: string[] }
  | { type: 'approval.requested'; turnId: string; request: AgentApprovalRequest }
  | { type: 'canvas.command'; turnId: string; command: CanvasCommand }
  /** A canvas request the runtime refused to emit, and why (the model is told too). */
  | { type: 'canvas.rejected'; turnId: string; tool: string; errors: string[] }
  /**
   * What the room's canvas did with validated requests (`requests` are their ids): run, landed as a proposal
   * waiting on a person, or declined, and why. Structural requests become one proposal when the turn has
   * answered, so these can follow `text.final`; they always come before the turn's ending event.
   */
  | { type: 'canvas.applied'; turnId: string; requests: string[]; result: CommandResult }
  | { type: 'turn.completed'; turnId: string; reply: RoomAgentReply }
  | { type: 'turn.cancelled'; turnId: string; reason: 'interrupted' | 'cancelled'; reply: RoomAgentReply }
  | { type: 'turn.failed'; turnId: string; error: AgentError; reply: RoomAgentReply };

// ─── Cloud ───────────────────────────────────────────────────────────────────
// Cloud ids (created_by, Participant.userId, RoomEvent.senderId) are Supabase user ids,
// not the Google `sub` in User.id. RoomSession.selfId is the signed-in user's.

export type Workspace = Tables<'workspaces'>;

// ─── Rooms ───────────────────────────────────────────────────────────────────
// A room is persistent and exists apart from its call: opening one (rooms.get, rooms.members) reads
// cloud rows only. It never starts a call, opens the microphone, runs a coding agent, or shares
// local files. Joining the call (rooms.join, calls.access) is a separate step, for members only.
// Implementation: integrations/supabase/rooms.ts; rules: supabase/migrations/*_room_membership.sql.

/**
 * `owner`s rename, delete, and manage members and invitations; `member`s use the room, sign its
 * decisions and talk on its call; `viewer`s read, comment and listen. The database and the LiveKit
 * token services enforce the difference (supabase/migrations/*_room_invitations.sql).
 */
export type RoomRole = 'owner' | 'member' | 'viewer';

/** A room you're a member of. Ids are stable UUIDs; times are ISO 8601. */
export interface RoomSummary {
  id: string;
  workspaceId: string;
  name: string;
  /** What the room is for; null when nobody said. */
  goal: string | null;
  /**
   * Shared repository identity, e.g. `github.com/acme/payments`. Never a local path: each member
   * maps it to their own checkout on their machine (see RoomCheckout).
   */
  repository: string | null;
  createdBy: string;
  createdAt: string;
  /** Last change to the room's own fields (name, goal, repository). */
  updatedAt: string;
  /**
   * When the room was kept; null while it's quick. A room keeps itself once it holds a decision or a plan,
   * and a quick one that goes quiet drops out of the sidebar into Earlier. Neither is ever deleted.
   */
  keptAt: string | null;
  /** Your role in it. */
  role: RoomRole;
  /** Where it sits among the rooms you pinned, smallest first; null when you haven't pinned it. Yours alone. */
  pinOrder: number | null;
  /** When you archived it out of your sidebar; null while it's there. Yours alone: the room is untouched. */
  archivedAt: string | null;
}

/** A repository linked to a Space (a workspace). Every room in the Space can use all of its repositories. */
export interface SpaceRepository {
  workspaceId: string;
  /** Shared identity, e.g. `github.com/acme/payments`; each member maps it to their own clone. */
  repository: string;
  addedBy: string | null;
  addedAt: string;
}

/** What a coding session was last seen doing, by the machine running it. */
/** `waiting`: the agent asked whoever runs it for something and has done nothing since (see RoomSessionWaitingOn). */
export type RoomSessionStatus = 'active' | 'waiting' | 'completed' | 'attention' | 'unknown';
/** What a waiting session asked for: permission to use a tool, or an answer to a question it put. */
export type RoomSessionWaitingOn = 'permission' | 'input';
/** Which coding agent runs a session. */
export type RoomSessionAgent = 'claude-code' | 'codex';

/**
 * A Claude Code session attached to a room: the room's members see it, its title and what it's doing.
 * Its transcript stays on the machine that ran it; that machine publishes the status when it changes.
 */
export interface AttachedSession {
  roomId: string;
  /** The agent's own session id. */
  sessionId: string;
  agent: RoomSessionAgent;
  /** The Space repository it runs in, by shared identity. */
  repository: string;
  title: string;
  branch: string | null;
  /** Whose machine it runs on: whoever attached it. Null once their account is gone. */
  attachedBy: string | null;
  attachedAt: string;
  status: RoomSessionStatus;
  /** Set exactly when the status is `waiting`. Whoever attached it is who it waits on. */
  waitingOn: RoomSessionWaitingOn | null;
  /** The latest thing it did, in words. */
  activity: string | null;
  changedFiles: number | null;
  /** When the status was last published; null until it first is. */
  statusAt: string | null;
  /** When the machine running it last observed it do anything; null until that's published. */
  lastSeenAt: string | null;
}

export type NewRoomSession = Pick<AttachedSession, 'sessionId' | 'repository' | 'title' | 'branch'> & Partial<Pick<AttachedSession, 'agent'> & RoomSessionReport>;
/** What the machine running a session publishes about it. */
export type RoomSessionReport = Pick<AttachedSession, 'status' | 'activity' | 'changedFiles'> & Partial<Pick<AttachedSession, 'waitingOn' | 'lastSeenAt'>>;

export interface RoomDetails extends RoomSummary {
  memberCount: number;
}

export interface RoomMember {
  roomId: string;
  /** Cloud user id. */
  userId: string;
  role: RoomRole;
  joinedAt: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface NewRoom {
  workspaceId: string;
  name: string;
  goal?: string | null;
  /** A remote URL (`git@github.com:acme/payments.git`) or identity; stored as the identity. Local paths are refused. */
  repository?: string | null;
}

/** Fields to change; leave one out to keep it, or set goal/repository to null to clear it. */
export interface RoomPatch {
  name?: string;
  goal?: string | null;
  repository?: string | null;
}

/**
 * Why a room call failed:
 *   not-found          no such room, or you aren't a member (indistinguishable on purpose)
 *   permission-denied  you can see the room but your role can't do that
 *   invalid            bad input, e.g. an empty name, a local path as repository, a user outside the workspace
 *   conflict           would leave a room without an owner
 *   signed-out         no cloud session; sign in again
 *   not-configured     Supabase isn't set up in .env; rooms are unavailable
 *   network            the cloud couldn't be reached; safe to retry
 */
export type RoomErrorCode =
  | 'not-found'
  | 'permission-denied'
  | 'invalid'
  | 'conflict'
  | 'signed-out'
  | 'not-configured'
  | 'network'
  | 'unknown';

/** Your Inbox marks as the server keeps them (inbox_state): the renderer's own shape, opaque here. */
export interface InboxStateRow { marks: unknown; updatedAt: string }

export interface RoomFailure {
  code: RoomErrorCode;
  message: string;
  /** For membership and invitations: which designed state explains it (MembershipErrorCode). */
  reason?: MembershipErrorCode;
}

/** What room channels resolve with: failures are values, so the code survives IPC. */
export type RoomResult<T> = { ok: true; value: T } | { ok: false; error: RoomFailure };

/** A suggested shape for UI state around a room call: loading until the RoomResult arrives. */
export type RoomLoad<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; error: RoomFailure };

// ─── Room integration boundaries ─────────────────────────────────────────────
// Contracts only: nothing implements these yet. Each system keys its data by room id. Anything that
// comes from this machine (paths, transcripts, worktrees) stays local unless a member explicitly
// shares a summary of it with the room.

/** Where a room's repository is checked out on this machine. Resolved locally; never stored in the cloud. */
export interface RoomCheckout {
  roomId: string;
  /** RoomSummary.repository. */
  repository: string;
  /** Local Repository.id. */
  repositoryId: string;
  path: string;
}

/** One of a room's repositories and its clone on this machine; nulls when it isn't cloned here. Never stored in the cloud. */
export interface RoomRepositoryCheckout {
  repository: string;
  repositoryId: string | null;
  path: string | null;
}

/**
 * A line of coding work (a branch in a worktree, with its Claude Code sessions) linked to a room.
 * `local` ones come from WorkContextService on this machine; `room` ones were shared with members.
 */
export interface RoomWorkstreamRef {
  roomId: string;
  workstreamId: string;
  repository: string | null;
  branch: string | null;
  visibility: 'local' | 'room';
}

/** Whether a room's call is running. Having a room never implies one: no call is the normal state. */
export interface RoomCallState {
  roomId: string;
  active: boolean;
  participants: Participant[];
}

/** A canvas view drawn in a room. */
export interface RoomViewRef {
  roomId: string;
  viewId: string;
}

/** An engineering decision recorded in a room. */
export interface RoomDecisionRef {
  roomId: string;
  decisionId: string;
  version: number;
}

/** Someone connected to a live room. Several windows or devices of one user count once. */
export interface Participant {
  userId: string;
  name: string | null;
  avatarUrl: string | null;
  /** When they connected, ISO 8601. */
  joinedAt: string;
  /**
   * Whether they're connected to the room's LiveKit call, as their own client reports it; null while
   * they only have the room open. Being in the room never puts anyone in the call.
   */
  call: { muted: boolean } | null;
}

/**
 * Every event a room carries, by type. Add an entry here plus its validator in
 * integrations/supabase/realtime.ts; the compiler then checks senders and receivers.
 */
export interface RoomEvents {
  'chat:message': { text: string };
  /**
   * The room's record changed (a thread, reply, decision or signature; work and its plan; the room's
   * settings such as the assistant's name); members re-read it. The database sends it too, after each
   * vowe_* write.
   */
  'record:changed': { what: 'thread' | 'reply' | 'decision' | 'signature' | 'work' | 'plan' | 'settings' | 'sessions' };
  /**
   * Who's in the room changed: someone joined, left, was removed or got another role, or an invitation
   * changed. Members re-read the room's access; `userId` (when it's about a person) lets the person it's
   * about tear down at once rather than on their next read.
   */
  'members:changed': { what: 'joined' | 'left' | 'removed' | 'role' | 'invitation'; userId: string | null };
  /** Someone saved the room's canvas; members re-read it (canvas:load). Carries no content. */
  'canvas:changed': CanvasChanged;
  /** Where someone is on the canvas: their view, pen and selection. Never saved; cameras aren't shared. */
  'canvas:presence': CanvasPresence;
}

export type RoomEventType = keyof RoomEvents;

/** A room's canvas as saved: its semantic document (src/shared/canvas) and how many saves it has had. */
export interface RoomCanvas {
  roomId: string;
  revision: number;
  doc: CanvasDocument;
}

/** What running a canvas command did, and the canvas it left (unchanged if it failed). */
export interface CanvasExecuted {
  result: CommandResult;
  canvas: RoomCanvas;
}

/** A room event as delivered: `type` narrows `payload`. */
export type RoomEvent<K extends RoomEventType = RoomEventType> = {
  [T in K]: {
    id: string;
    roomId: string;
    type: T;
    payload: RoomEvents[T];
    /** Self-reported by the sender; the room only admits its members, but members could lie. */
    senderId: string;
    sentAt: string;
  };
}[K];

export interface RoomSession {
  roomId: string;
  selfId: string;
  participants: Participant[];
}

/** `reconnecting` after a dropped connection (rejoins automatically); `left` once the room is closed. */
export type RoomStatus = 'connected' | 'reconnecting' | 'left';

// ─── The Vowe room's record ──────────────────────────────────────────────────
// Decisions as documents with per-version state, versioned plans, authorization, scope requests,
// questions, findings, tracked PRs and attention marks (supabase/migrations/*_vowe_room_work.sql). The
// record itself is VoweRecord (shared/vowe/model.ts). 'agent' saves Vowe's content from your session,
// shown as Vowe's; the database never lets it sign, authorize, allow scope or resolve.

export type VoweAuthorKind = 'human' | 'agent';
export interface VoweNewThread {
  about: About;
  body: string;
  /** The plan passage or decision line it's anchored to. */
  quote?: string;
  /** A canvas pin, in stage units. */
  at?: { x: number; y: number };
  /** Ask someone in the room directly (a cloud user id). */
  waiting?: string;
}
/** Vowe offering to make something from a conversation; people accept or dismiss it. */
export interface VoweOffer { kind: 'decision' | 'work' | 'revision' | 'edit'; text: string; target?: string }
/** One suggested plan change, before anyone decides it. */
export type VoweChange = Omit<Change, 'id' | 'state' | 'decidedBy'>;
export interface VoweRevision { base: number; why: string; changes: VoweChange[]; from?: string }
export type VoweLineKind = 'decide' | 'because' | 'assume' | 'open' | 'scope';

// ─── Room record ─────────────────────────────────────────────────────────────
// What a room keeps between calls: threads pinned to what it was looking at, their replies, its
// decisions with their versions and signatures, and what happened (supabase/migrations/*_room_record.sql).
// Authors, versions and timestamps are set by the database, never by the client.

export type ThreadKind = 'note' | 'concern' | 'avoid' | 'constraint' | 'question' | 'goal';

export interface RoomAuthor {
  /** Cloud user id. */
  id: string;
  name: string | null;
  email: string;
}

export interface RoomComment {
  id: string;
  body: string;
  author: RoomAuthor;
  /** `agent`: Vowe wrote it, from `author`'s app on their model. */
  authorKind: 'human' | 'agent';
  createdAt: string;
}

export interface RoomThread {
  id: string;
  roomId: string;
  kind: ThreadKind;
  /** A canvas part (its id and name), or `pin` with the point it was dropped on. */
  anchor: { id: string; name: string; x: number | null; y: number | null };
  body: string;
  author: RoomAuthor;
  createdAt: string;
  resolvedAt: string | null;
  /** Oldest first. */
  replies: RoomComment[];
}

export interface NewThread {
  kind: ThreadKind;
  anchor: { id: string; name: string; x?: number | null; y?: number | null };
  body: string;
}

export interface RoomSignature {
  userId: string;
  version: number;
  signedAt: string;
}

export interface RoomDecision {
  id: string;
  roomId: string;
  title: string;
  /** The checks, `;`-separated, as written. */
  verify: string;
  /** Bumped by the database whenever the title or checks change. */
  version: number;
  proposedBy: RoomAuthor;
  createdAt: string;
  updatedAt: string;
  /** Every signature on any version; only those on `version` count. */
  signatures: RoomSignature[];
  /** Earlier versions, newest first. */
  history: { version: number; title: string; verify: string; proposedBy: RoomAuthor; createdAt: string }[];
}

export type RoomActivityKind =
  | 'thread' | 'reply' | 'decision' | 'amended' | 'signed' | 'repository' | 'call-started' | 'call-left'
  | 'joined' | 'left' | 'removed' | 'role';

export interface RoomActivity {
  id: string;
  kind: RoomActivityKind;
  actor: RoomAuthor | null;
  subject: string | null;
  version: number | null;
  createdAt: string;
}

export interface RoomRecord {
  roomId: string;
  /** Open threads, oldest first. */
  threads: RoomThread[];
  /** The room's decisions, newest first; the first is the one the room is working on. */
  decisions: RoomDecision[];
  /** Newest first, at most 50. */
  activity: RoomActivity[];
  /** When you last looked at this room; null on a first visit. */
  lastSeenAt: string | null;
}

// ─── Voice calls ─────────────────────────────────────────────────────────────
// Each room has a LiveKit audio call, joined from the renderer (renderer/calls/service.ts). Main only
// hands out access; LiveKit participant identities are cloud user ids, like Participant.userId.

/** Where to connect for a room's call. The token is short-lived and only admits you to that room. */
export interface CallAccess {
  url: string;
  token: string;
}

// ─── Invitations ─────────────────────────────────────────────────────────────
// Getting people into a room (supabase/migrations/*_room_invitations.sql, integrations/supabase/invitations.ts).
// Email invitations are bound to one address and redeemed in the app by whoever signs in with it; the
// room's invite link carries a token, shown once to the owner who made it. Accepting makes you a member
// with the invitation's role. It never joins the call.

export type InvitationStatus = 'pending' | 'accepted' | 'expired' | 'revoked';
export type LinkExpiry = '24h' | '7d' | '30d';

/** An invitation as the room's members see it. Tokens are never part of it. */
export interface RoomInvitation {
  id: string;
  roomId: string;
  kind: 'email' | 'link';
  /** Email invitations: who it's for. */
  email: string | null;
  /** Links: the email domain it's limited to, if any. */
  domain: string | null;
  role: RoomRole;
  /** `pending` past its expiry reads as `expired`. A link is live while `pending`. */
  status: InvitationStatus;
  invitedBy: string;
  sentAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  resends: number;
  uses: number;
}

/** A newly made invite link. `url` holds its token: this is the only time it's available. */
export interface RoomLink {
  invitation: RoomInvitation;
  url: string;
}

/** Why an invitation can't be used, or a membership action was refused; each has a designed state. */
export type MembershipErrorCode =
  | 'invalid_email' | 'not_permitted' | 'last_owner' | 'rate_limited'
  | 'invite_expired' | 'invite_revoked' | 'invite_used' | 'invite_not_found'
  | 'wrong_account' | 'domain_not_allowed' | 'link_revoked' | 'room_gone' | 'network';

export interface InvitePerson { id: string; name: string; avatarUrl: string | null }

/** What an invitation is, as its holder may see it before joining. */
export interface InviteContext {
  /** The invitation's id. */
  id: string;
  via: 'email' | 'link';
  inviter: InvitePerson;
  roomName: string;
  role: RoomRole;
  /** Masked address an email invitation is bound to, e.g. `j•••@acme.com`. */
  boundEmail: string | null;
  domain: string | null;
}

/** What an invitation would do for the signed-in person: resolveInvite's answer. */
export type InviteResolution =
  | { kind: 'preview'; invite: InviteContext; room: { id: string; name: string; goal: string | null; members: InvitePerson[] } }
  | { kind: 'already-member'; roomId: string; roomName: string }
  | { kind: 'wrong-account'; invite: InviteContext; signedInAs: string }
  | { kind: 'error'; error: MembershipErrorCode; invite?: InviteContext; signedInAs?: string };

/** An invitation waiting for you: an email invitation sent to the address you signed in with. */
export interface IncomingInvitation {
  id: string;
  roomId: string;
  roomName: string;
  role: RoomRole;
  inviterName: string;
  sentAt: string;
  expiresAt: string;
}

/** Names one invitation to resolve or accept: a link's token, or one of your email invitations. */
export type InviteKey = { token: string } | { invitationId: string };

/** The OS-level microphone permission. `denied`/`restricted` mean the user must change it in system settings. */
export type MicrophoneAccess = 'granted' | 'denied' | 'restricted';

// ─── Vowe's voice ────────────────────────────────────────────────────────────
// The speech half of the runtime's VoiceAdapter (renderer/shared/vowe-voice.ts): your Vowe's voice in
// the call you're in, as its own participant `vowe:<your user id>`, and your microphone heard as
// HumanSpeech. Audio, speech providers and credentials stay in main and the Vowe API. See
// src/voice/INTEGRATION.md.

export type { HeardSpeech, VoiceStatus } from '../voice/index.js';

/**
 * IPC channel names. `invoke` channels are request/response handled by main
 * (arguments are untrusted at runtime; handlers must validate them). `event`
 * channels are pushed from main to renderers.
 */
export interface Channels {
  invoke: {
    'auth:getUser': () => User | null;
    /** Why the last session ended on its own (also at launch), until the next sign-in; else null. */
    'auth:getEnded': () => AuthFailure | null;
    /** Rejects with a message to show as is; `google` when no provider is given. */
    'auth:signIn': (provider?: SignInProvider) => User;
    /** Stops waiting for the browser: the sign-in or link in flight fails as `cancelled`. */
    'auth:cancel': () => void;
    'auth:signOut': () => void;
    'auth:methods': () => AuthResult<SignInMethod[]>;
    /** Opens the provider in the browser, as the signed-in person; resolves with the methods after. */
    'auth:link': (provider: SignInProvider) => AuthResult<SignInMethod[]>;
    'auth:unlink': (provider: SignInProvider) => AuthResult<SignInMethod[]>;
    'settings:get': () => Settings;
    'settings:update': (patch: Partial<Settings>) => Settings;
    'repos:list': () => Repository[];
    /** Main shows a folder picker; resolves null if cancelled. The renderer never sends paths. */
    'repos:add': () => Repository | null;
    'repos:remove': (id: string) => void;
    /** Looks for repositories in the usual code folders, leaving out ones already added. */
    'repos:detect': () => DetectedRepository[];
    /** Each added repository's shared identity (its `origin`, as host/path), or null where it has none. */
    'repos:identities': () => { id: string; identity: string | null }[];
    /** Only accepts a path the last repos:detect returned, so this can't add arbitrary paths. */
    'repos:addDetected': (path: string) => Repository;
    /** Records the repository as opened, which moves it to the top of the list. */
    'repos:open': (id: string) => Repository;
    'git:status': (repositoryId: string) => GitStatus;
    'git:branches': (repositoryId: string) => GitBranch[];
    'git:worktrees': (repositoryId: string) => GitWorktree[];
    'claudeCode:sessions': (repositoryId: string) => ClaudeCodeSession[];
    'claudeCode:session': (repositoryId: string, sessionId: string) => ClaudeCodeSession | null;
    'claudeCode:messages': (repositoryId: string, sessionId: string, page: { offset?: number; limit?: number }) => ClaudeCodeMessagePage;
    'claudeCode:activity': (repositoryId: string) => ClaudeCodeEvent[];
    'claudeCode:hooksStatus': () => ClaudeCodeHooksStatus;
    'claudeCode:installHooks': () => ClaudeCodeHooksStatus;
    'claudeCode:uninstallHooks': () => ClaudeCodeHooksStatus;
    'context:work': (repositoryId: string) => WorkContext;
    'context:repository': (repositoryId: string) => RepositoryContext;
    'context:workstreams': (repositoryId: string) => Workstream[];
    'context:workstream': (workstreamId: string) => WorkstreamContext | null;
    'context:session': (sessionId: string) => SessionContext | null;
    'workspaces:list': () => Workspace[];
    'workspaces:create': (name: string) => Workspace;
    'rooms:list': (workspaceId?: string) => RoomResult<RoomSummary[]>;
    'rooms:get': (roomId: string) => RoomResult<RoomDetails>;
    'rooms:create': (room: NewRoom) => RoomResult<RoomDetails>;
    'rooms:update': (roomId: string, patch: RoomPatch) => RoomResult<RoomDetails>;
    'rooms:delete': (roomId: string) => RoomResult<void>;
    'rooms:members': (roomId: string) => RoomResult<RoomMember[]>;
    'rooms:addMember': (roomId: string, userId: string, role?: RoomRole) => RoomResult<RoomMember>;
    'rooms:setMemberRole': (roomId: string, userId: string, role: RoomRole) => RoomResult<RoomMember>;
    /** Without a userId, leaves the room (membership, not the call). */
    'rooms:removeMember': (roomId: string, userId?: string) => RoomResult<void>;
    /** Attaches the shared identity of a local repository's `origin` remote; its path stays local. */
    'rooms:attachRepository': (roomId: string, repositoryId: string) => RoomResult<RoomDetails>;
    /** The room's repository checked out on this machine: an added local repository whose origin matches. */
    'rooms:checkout': (roomId: string) => RoomResult<RoomCheckout | null>;
    /** Each of the room's repositories (its Space's), and where it's checked out here if it is. */
    'rooms:checkouts': (roomId: string) => RoomResult<RoomRepositoryCheckout[]>;
    /** Keeps a room, or lets it be quick again. Owners and members. */
    'rooms:keep': (roomId: string, keep: boolean) => RoomResult<RoomDetails>;
    /** Pins a room at a place among yours, moves it, or unpins it (null). Yours alone. */
    'rooms:pin': (roomId: string, order: number | null) => RoomResult<RoomDetails>;
    /** Archives a room out of your sidebar, or brings it back. Yours alone. */
    'rooms:archive': (roomId: string, archive: boolean) => RoomResult<RoomDetails>;
    'rooms:sessions': (roomId: string) => RoomResult<AttachedSession[]>;
    /** Owners and members; the session must be in one of the Space's repositories. */
    'rooms:attachSession': (roomId: string, session: NewRoomSession) => RoomResult<AttachedSession>;
    /** Whoever attached it, or a room owner. */
    'rooms:detachSession': (roomId: string, sessionId: string) => RoomResult<void>;
    /** Whoever attached it: what it's doing now, on their machine. */
    'rooms:reportSession': (roomId: string, sessionId: string, report: RoomSessionReport) => RoomResult<void>;
    'spaces:repositories': (workspaceId: string) => RoomResult<SpaceRepository[]>;
    /** Links a local repository's `origin` identity to the Space; its path stays local. */
    'spaces:link': (workspaceId: string, repositoryId: string) => RoomResult<SpaceRepository>;
    'spaces:unlink': (workspaceId: string, repository: string) => RoomResult<void>;
    /** Owners only. */
    'spaces:rename': (workspaceId: string, name: string) => RoomResult<void>;
    'record:get': (roomId: string) => RoomResult<RoomRecord>;
    'record:addThread': (roomId: string, thread: NewThread) => RoomResult<RoomThread>;
    'record:reply': (roomId: string, threadId: string, body: string, authorKind?: 'human' | 'agent', parentId?: string | null) => RoomResult<RoomComment>;
    'record:resolve': (roomId: string, threadId: string, reopen?: boolean) => RoomResult<void>;
    'record:propose': (roomId: string, decision: { title: string; verify: string }) => RoomResult<RoomDecision>;
    'record:amend': (roomId: string, decisionId: string, change: { title?: string; verify?: string }) => RoomResult<RoomDecision>;
    /** Signs the decision's current version; refused if `version` isn't current any more. */
    'record:sign': (roomId: string, decisionId: string, version: number) => RoomResult<RoomDecision>;
    'record:seen': (roomId: string) => RoomResult<void>;
    'record:call': (roomId: string, what: 'call-started' | 'call-left') => RoomResult<void>;
    'vowe:load': (roomId: string) => RoomResult<VoweRecord>;
    'vowe:thread': (roomId: string, thread: VoweNewThread, authorKind?: VoweAuthorKind) => RoomResult<{ id: string }>;
    'vowe:offer': (roomId: string, threadId: string, body: string, offer: VoweOffer) => RoomResult<{ id: string }>;
    'vowe:answerOffer': (roomId: string, threadId: string, replyId: string, accept: boolean) => RoomResult<void>;
    'vowe:link': (roomId: string, threadId: string, about: About) => RoomResult<void>;
    'vowe:decision:create': (roomId: string, decision: { title: string; line?: string; from?: string; problem?: string }, authorKind?: VoweAuthorKind) => RoomResult<{ id: string }>;
    'vowe:decision:addLine': (roomId: string, decisionId: string, kind: VoweLineKind, text: string, authorKind?: VoweAuthorKind) => RoomResult<{ id: string }>;
    'vowe:decision:editLine': (roomId: string, decisionId: string, lineId: string, text: string) => RoomResult<void>;
    'vowe:decision:suggestLine': (roomId: string, decisionId: string, lineId: string, text: string, why: string, authorKind?: VoweAuthorKind) => RoomResult<void>;
    'vowe:decision:editDoc': (roomId: string, decisionId: string, field: 'problem' | 'rationale', text: string) => RoomResult<void>;
    'vowe:decision:takeSuggestion': (roomId: string, decisionId: string, lineId: string, accept: boolean) => RoomResult<void>;
    'vowe:decision:requestSignatures': (roomId: string, decisionId: string, who: string[]) => RoomResult<void>;
    'vowe:decision:requestChanges': (roomId: string, decisionId: string, version: number, text: string) => RoomResult<void>;
    'vowe:decision:amend': (roomId: string, decisionId: string) => RoomResult<{ id: string }>;
    'vowe:decision:setSuggested': (roomId: string, decisionId: string, state: 'dismissed' | 'draft') => RoomResult<void>;
    'vowe:work:create': (roomId: string, work: { title: string; objective: string; decision?: string; thread?: string }, authorKind?: VoweAuthorKind) => RoomResult<{ id: string }>;
    'vowe:work:plan': (roomId: string, workId: string, op: PlanOp, base: number) => RoomResult<{ version: number }>;
    'vowe:work:suggest': (roomId: string, workId: string, revision: VoweRevision, authorKind?: VoweAuthorKind) => RoomResult<{ id: string }>;
    'vowe:work:decideChange': (roomId: string, workId: string, changeId: string, accept: boolean) => RoomResult<void>;
    'vowe:work:authorize': (roomId: string, workId: string, version: number) => RoomResult<void>;
    'vowe:work:requestScope': (roomId: string, workId: string, ask: { text: string; adds: string; by: string }, authorKind?: VoweAuthorKind) => RoomResult<{ id: string }>;
    'vowe:work:allowScope': (roomId: string, workId: string, allow: boolean) => RoomResult<void>;
    'vowe:work:ask': (roomId: string, workId: string, question: { text: string; about?: string; step?: string; for: string; options?: string[] }, authorKind?: VoweAuthorKind) => RoomResult<{ id: string }>;
    'vowe:work:answer': (roomId: string, workId: string, questionId: string, text: string) => RoomResult<void>;
    'vowe:work:defer': (roomId: string, workId: string, questionId: string) => RoomResult<void>;
    'vowe:work:finding': (roomId: string, workId: string, finding: { text: string; evidence?: string[]; offer?: string }, authorKind?: VoweAuthorKind) => RoomResult<{ id: string }>;
    'vowe:work:trackPr': (roomId: string, workId: string, pr: { num: number; title: string; state: PR['state']; branch?: string; url?: string; step?: string }) => RoomResult<void>;
    'vowe:work:resolve': (roomId: string, workId: string) => RoomResult<void>;
    'vowe:attention:done': (roomId: string, ids: string[]) => RoomResult<void>;
    'vowe:settings:agentName': (roomId: string, name: string) => RoomResult<string>;
    'invites:list': (roomId: string) => RoomResult<RoomInvitation[]>;
    'invites:send': (roomId: string, emails: string[], role: RoomRole) => RoomResult<RoomInvitation[]>;
    'invites:createLink': (roomId: string, settings: { role: RoomRole; expiry: LinkExpiry; domain: string | null }) => RoomResult<RoomLink>;
    'invites:revoke': (invitationId: string) => RoomResult<void>;
    'invites:mine': () => RoomResult<IncomingInvitation[]>;
    'invites:decline': (invitationId: string) => RoomResult<void>;
    'inbox:state:get': () => RoomResult<InboxStateRow | null>;
    'inbox:state:save': (marks: unknown) => RoomResult<string>;
    'invites:resolve': (key: InviteKey) => RoomResult<InviteResolution>;
    /** Resolves with the room's id. */
    'invites:accept': (key: InviteKey) => RoomResult<string>;
    'canvas:load': (roomId: string) => RoomResult<RoomCanvas>;
    /** Runs a Canvas Command as the signed-in person; the result says if it was refused and why. */
    'canvas:execute': (roomId: string, command: unknown) => CanvasExecuted;
    /** Your view, pen and selection: sent to the room's call and kept for Vowe's "this". */
    'canvas:presence': (roomId: string, presence: CanvasPresence) => void;
    'rooms:join': (roomId: string) => RoomSession;
    'rooms:leave': (roomId: string) => void;
    'rooms:send': <K extends RoomEventType>(roomId: string, type: K, payload: RoomEvents[K]) => RoomEvent<K>;
    /** Tells the room whether you're in its call (and muted); null when you're only in the room. */
    'rooms:setCall': (roomId: string, call: { muted: boolean } | null) => void;
    'calls:access': (roomId: string) => CallAccess;
    /** Asks the OS for the microphone if it hasn't been asked yet; otherwise reports the current answer. */
    'calls:requestMicrophone': () => MicrophoneAccess;
    'calls:openMicrophoneSettings': () => void;
    'agent:status': () => AgentStatus;
    /** Starts a conversation when `conversationId` is null; resolves with the agent's answer. */
    'agent:send': (conversationId: string | null, context: AgentContext, text: string) => AgentReply;
    /** Answers an agent:approval request. */
    'agent:approve': (approvalId: string, approved: boolean) => void;
    /** Forgets the conversation and declines anything it's waiting on. */
    'agent:reset': (conversationId: string) => void;
    /** Starts a room turn; its progress arrives as agent:event, and it resolves once it has started. */
    'agent:ask': (turn: RoomAgentTurn) => { turnId: string };
    /** Cancels a running turn (an interruption, or the person gave up). */
    'agent:cancel': (turnId: string) => void;
    'chatgpt:status': () => ChatGptStatus;
    /** Opens the browser to sign in: the active (or a saved) account, or 'new' for another one. */
    'chatgpt:signIn': (account?: string) => ChatGptStatus;
    /** Revokes and forgets the active account's tokens; `revoked` says whether OpenAI confirmed it. */
    'chatgpt:signOut': () => { revoked: boolean };
    'chatgpt:dismissWelcome': () => void;
    /** Brings your Vowe into the room's call; rejects with a reason to show. */
    'voice:start': (roomId: string) => VoiceStatus;
    'voice:stop': () => void;
    'voice:status': () => VoiceStatus;
    'voice:audio': (roomId: string, pcm: Uint8Array) => void;
    'voice:begin': (turnId: string) => void;
    'voice:say': (turnId: string, text: string) => void;
    'voice:end': (turnId: string) => void;
    'voice:cancel': (turnId: string) => void;
  };
  event: {
    'auth:changed': User | null;
    /** The session ended without anyone signing out here (`session-expired`). Followed by auth:changed null. */
    'auth:ended': AuthFailure;
    'claudeCode:event': ClaudeCodeEvent;
    'rooms:event': RoomEvent;
    'rooms:presence': { roomId: string; participants: Participant[] };
    'rooms:status': { roomId: string; status: RoomStatus };
    /** A room's canvas changed, here or elsewhere; `result` when this app made the change. */
    'canvas:changed': RoomCanvas & { result?: CommandResult };
    'agent:approval': AgentApprovalRequest;
    'agent:toolCall': { conversationId: string; call: AgentToolCall };
    'agent:event': AgentEvent;
    'chatgpt:changed': ChatGptStatus;
    'voice:status': VoiceStatus;
    'voice:speech': { roomId: string; speech: HeardSpeech };
    'voice:said': { roomId: string; turnId: string; text: string };
    /** The window went in or out of full screen (and once on load): macOS hides the traffic lights there. */
    'window:fullScreen': boolean;
  };
}

export type InvokeChannel = keyof Channels['invoke'];
export type InvokeArgs<K extends InvokeChannel> = Parameters<Channels['invoke'][K]>;
export type InvokeResult<K extends InvokeChannel> = ReturnType<Channels['invoke'][K]>;
export type EventChannel = keyof Channels['event'];

/** What the preload exposes on `window.journey`. */
export interface JourneyApi {
  auth: {
    getUser(): Promise<User | null>;
    getEnded(): Promise<AuthFailure | null>;
    signIn(provider?: SignInProvider): Promise<User>;
    cancel(): Promise<void>;
    signOut(): Promise<void>;
    /** Subscribes to sign-in/sign-out; returns an unsubscribe function. */
    onChange(listener: (user: User | null) => void): () => void;
    /** The session ended on its own (expired or revoked); auth:changed follows with null. */
    onEnded(listener: (failure: AuthFailure) => void): () => void;
    /** This account's sign-in methods: which are linked, and which could be removed. */
    methods(): Promise<AuthResult<SignInMethod[]>>;
    link(provider: SignInProvider): Promise<AuthResult<SignInMethod[]>>;
    unlink(provider: SignInProvider): Promise<AuthResult<SignInMethod[]>>;
  };
  settings: {
    get(): Promise<Settings>;
    update(patch: Partial<Settings>): Promise<Settings>;
  };
  repos: {
    list(): Promise<Repository[]>;
    add(): Promise<Repository | null>;
    remove(id: string): Promise<void>;
    /** Repositories found in ~/projects, ~/code, ~/Developer and similar, not yet added. */
    detect(): Promise<DetectedRepository[]>;
    /** Adds one of the repositories the last detect() returned. */
    addDetected(path: string): Promise<Repository>;
    /** Marks the repository as the one being worked on (most recently opened). */
    open(id: string): Promise<Repository>;
    /** Each added repository's shared identity from its `origin`; null where it has no shareable remote. */
    identities(): Promise<{ id: string; identity: string | null }[]>;
  };
  git: {
    /** Current branch, upstream, and changed files of the repository's working tree. */
    status(repositoryId: string): Promise<GitStatus>;
    /** Local branches, then remote-tracking branches. */
    branches(repositoryId: string): Promise<GitBranch[]>;
    /** All worktrees of the repository, main worktree first. */
    worktrees(repositoryId: string): Promise<GitWorktree[]>;
  };
  /** Read-only access to Claude Code sessions on this machine; never starts or changes one. */
  claudeCode: {
    /** Sessions run in the repository or any of its worktrees, most recently active first. */
    sessions(repositoryId: string): Promise<ClaudeCodeSession[]>;
    /** Fresh metadata for one session; null if it's gone or not in this repository. */
    session(repositoryId: string, sessionId: string): Promise<ClaudeCodeSession | null>;
    /**
     * Up to `limit` (default 50, max 200) messages from `offset`. Omit `offset` for the latest
     * page; then ask for earlier pages with a smaller offset.
     */
    messages(repositoryId: string, sessionId: string, page?: { offset?: number; limit?: number }): Promise<ClaudeCodeMessagePage>;
    /** Recent hook events from the repository's sessions and worktrees, newest first. */
    activity(repositoryId: string): Promise<ClaudeCodeEvent[]>;
    hooksStatus(): Promise<ClaudeCodeHooksStatus>;
    /** Adds Vowe's async hooks to ~/.claude/settings.json, leaving every other setting and hook as it was. */
    installHooks(): Promise<ClaudeCodeHooksStatus>;
    /** Removes only Vowe's hooks. */
    uninstallHooks(): Promise<ClaudeCodeHooksStatus>;
    /** Every hook event as it arrives, from any repository; returns an unsubscribe function. */
    onEvent(listener: (event: ClaudeCodeEvent) => void): () => void;
  };
  /** Read-only, local-only views combining Git, Claude Code sessions, and their activity. */
  context: {
    work(repositoryId: string): Promise<WorkContext>;
    repository(repositoryId: string): Promise<RepositoryContext>;
    workstreams(repositoryId: string): Promise<Workstream[]>;
    /** Null if that branch is no longer checked out in that worktree. */
    workstream(workstreamId: string): Promise<WorkstreamContext | null>;
    /** Null if the session isn't in any added repository. */
    session(sessionId: string): Promise<SessionContext | null>;
  };
  workspaces: {
    /** Workspaces the signed-in user belongs to. */
    list(): Promise<Workspace[]>;
    /** Creates a workspace owned by the signed-in user. */
    create(name: string): Promise<Workspace>;
    /** The Space's repositories, the order they were linked in. */
    repositories(workspaceId: string): Promise<RoomResult<SpaceRepository[]>>;
    /** Links a local repository to the Space by its `origin` remote; only the identity leaves this machine. */
    link(workspaceId: string, repositoryId: string): Promise<RoomResult<SpaceRepository>>;
    /** Whoever linked it, or a Space owner. */
    unlink(workspaceId: string, repository: string): Promise<RoomResult<void>>;
    /** Owners only. */
    rename(workspaceId: string, name: string): Promise<RoomResult<void>>;
  };
  rooms: {
    // Persistent rooms. Each resolves with a RoomResult rather than rejecting, so the UI can tell
    // not-found, permission-denied, network and the rest apart. None of these joins the call.
    /** Rooms you're a member of, most recently changed first; optionally one workspace's only. */
    list(workspaceId?: string): Promise<RoomResult<RoomSummary[]>>;
    /** Opens a room's record (its preview data). Doesn't connect, start a call, or touch local files. */
    get(roomId: string): Promise<RoomResult<RoomDetails>>;
    /** Creates a room in a workspace you belong to; you become its owner but aren't connected. */
    create(room: NewRoom): Promise<RoomResult<RoomDetails>>;
    /** Owners only. */
    update(roomId: string, patch: RoomPatch): Promise<RoomResult<RoomDetails>>;
    /** Owners only. */
    delete(roomId: string): Promise<RoomResult<void>>;
    members(roomId: string): Promise<RoomResult<RoomMember[]>>;
    /** Owners only. `userId` is the cloud id of an existing member of the room's workspace. */
    addMember(roomId: string, userId: string, role?: RoomRole): Promise<RoomResult<RoomMember>>;
    /** Owners only. A room always keeps an owner. */
    setMemberRole(roomId: string, userId: string, role: RoomRole): Promise<RoomResult<RoomMember>>;
    /** Leaves the room (no userId), or as an owner removes someone. Not the same as leaving the call. */
    removeMember(roomId: string, userId?: string): Promise<RoomResult<void>>;
    /** Owners only. Sets the room's repository from a local repository's `origin`; the path never leaves this machine. */
    attachRepository(roomId: string, repositoryId: string): Promise<RoomResult<RoomDetails>>;
    /** Where this room's repository is checked out on this machine; null when it isn't, or the room has none. */
    checkout(roomId: string): Promise<RoomResult<RoomCheckout | null>>;
    /** Every repository the room can use (its Space's), each with where it's checked out here, or nulls. */
    checkouts(roomId: string): Promise<RoomResult<RoomRepositoryCheckout[]>>;
    /** Keeps the room, or lets it be quick again; owners and members. */
    keep(roomId: string, keep: boolean): Promise<RoomResult<RoomDetails>>;
    /** Pins the room at a place among yours (smallest first), moves it, or unpins it (null). Yours alone. */
    pin(roomId: string, order: number | null): Promise<RoomResult<RoomDetails>>;
    /** Archives the room out of your sidebar (unpinning it), or brings it back. Yours alone. */
    archive(roomId: string, archive: boolean): Promise<RoomResult<RoomDetails>>;
    /** The coding sessions attached to the room, in the order they were attached. Members. */
    sessions(roomId: string): Promise<RoomResult<AttachedSession[]>>;
    /** Attaches one of your sessions to the room (owners and members); attaching it again updates it. */
    attachSession(roomId: string, session: NewRoomSession): Promise<RoomResult<AttachedSession>>;
    /** Detaches a session: whoever attached it, or a room owner. Nothing on any machine changes. */
    detachSession(roomId: string, sessionId: string): Promise<RoomResult<void>>;
    /** Publishes what a session you attached is doing now. */
    reportSession(roomId: string, sessionId: string, report: RoomSessionReport): Promise<RoomResult<void>>;

    // The live room: Realtime channel and presence. Members only.
    /** Connects and announces you to the room. Members only; joining twice is a no-op. */
    join(roomId: string): Promise<RoomSession>;
    /** Disconnects from the room; you stay a member and can join again. */
    leave(roomId: string): Promise<void>;
    /** Sends to everyone else connected; resolves with the event once the server has it. */
    send<K extends RoomEventType>(roomId: string, type: K, payload: RoomEvents[K]): Promise<RoomEvent<K>>;
    onEvent(listener: (event: RoomEvent) => void): () => void;
    onPresence(listener: (update: { roomId: string; participants: Participant[] }) => void): () => void;
    onStatus(listener: (update: { roomId: string; status: RoomStatus }) => void): () => void;
    /** Tells everyone in the room whether you're in its call, and muted; null once you leave the call. */
    setCall(roomId: string, call: { muted: boolean } | null): Promise<void>;
  };
  /**
   * Getting people into rooms. Owners invite by email and make the room's link; anyone signed in can
   * look up and accept an invitation meant for them. Accepting never joins the call.
   */
  invites: {
    /** The room's invitations (members). */
    list(roomId: string): Promise<RoomResult<RoomInvitation[]>>;
    /** Owners. Existing members are skipped; a pending invitation is sent again. */
    send(roomId: string, emails: string[], role: RoomRole): Promise<RoomResult<RoomInvitation[]>>;
    /** Owners. Replaces the room's live link; the result's `url` is the only copy of its token. */
    createLink(roomId: string, settings: { role: RoomRole; expiry: LinkExpiry; domain: string | null }): Promise<RoomResult<RoomLink>>;
    /** Owners: withdraw an email invitation or turn the link off. */
    revoke(invitationId: string): Promise<RoomResult<void>>;
    /** Email invitations waiting for the address you signed in with. */
    mine(): Promise<RoomResult<IncomingInvitation[]>>;
    /** Declines one of those: it leaves your list until it's sent again. */
    decline(invitationId: string): Promise<RoomResult<void>>;
    resolve(key: InviteKey): Promise<RoomResult<InviteResolution>>;
    /** Makes you a member; resolves with the room's id. */
    accept(key: InviteKey): Promise<RoomResult<string>>;
  };
  /** Home's Inbox: your own marks (seen, snoozed, followed, muted), kept on the server for every device. */
  inbox: {
    getState(): Promise<RoomResult<InboxStateRow | null>>;
    saveState(marks: unknown): Promise<RoomResult<string>>;
  };
  /** A room's record: threads, replies, decisions and signatures, activity. Members only. */
  record: {
    get(roomId: string): Promise<RoomResult<RoomRecord>>;
    addThread(roomId: string, thread: NewThread): Promise<RoomResult<RoomThread>>;
    /** `parentId`: the reply this one answers, in the same thread; none answers the thread itself. */
    reply(roomId: string, threadId: string, body: string, authorKind?: 'human' | 'agent', parentId?: string | null): Promise<RoomResult<RoomComment>>;
    /** `reopen`: open a resolved thread again. */
    resolve(roomId: string, threadId: string, reopen?: boolean): Promise<RoomResult<void>>;
    propose(roomId: string, decision: { title: string; verify: string }): Promise<RoomResult<RoomDecision>>;
    amend(roomId: string, decisionId: string, change: { title?: string; verify?: string }): Promise<RoomResult<RoomDecision>>;
    sign(roomId: string, decisionId: string, version: number): Promise<RoomResult<RoomDecision>>;
    /** Moves your "last looked" marker to now. */
    seen(roomId: string): Promise<RoomResult<void>>;
    /** Records that you started or left the room's call. */
    call(roomId: string, what: 'call-started' | 'call-left'): Promise<RoomResult<void>>;
  };
  /**
   * The Vowe room's record (VoweRecord): decision documents, versioned plans and their authorization.
   * Replies, resolving and signing stay on `record`. Members only; each write names who may do it, and the
   * database enforces it. Decision ids are the Desk's: `<decision>` for v1, `<decision>.v<n>` after.
   */
  vowe: {
    load(roomId: string): Promise<RoomResult<VoweRecord>>;
    /** permission: comment. */
    thread(roomId: string, thread: VoweNewThread, authorKind?: VoweAuthorKind): Promise<RoomResult<{ id: string }>>;
    /** Vowe's reply carrying an offer. permission: comment. */
    offer(roomId: string, threadId: string, body: string, offer: VoweOffer): Promise<RoomResult<{ id: string }>>;
    /** Records the answer only. permission: write. */
    answerOffer(roomId: string, threadId: string, replyId: string, accept: boolean): Promise<RoomResult<void>>;
    /** Another subject a thread concerns. permission: comment. */
    link(roomId: string, threadId: string, about: About): Promise<RoomResult<void>>;
    decisions: {
      /** A draft (a person) or a suggestion (Vowe). permission: write. */
      create(roomId: string, decision: { title: string; line?: string; from?: string; problem?: string }, authorKind?: VoweAuthorKind): Promise<RoomResult<{ id: string }>>;
      addLine(roomId: string, decisionId: string, kind: VoweLineKind, text: string, authorKind?: VoweAuthorKind): Promise<RoomResult<{ id: string }>>;
      /** `conflict` once the version has a signature or isn't current. permission: write. */
      editLine(roomId: string, decisionId: string, lineId: string, text: string): Promise<RoomResult<void>>;
      suggestLine(roomId: string, decisionId: string, lineId: string, text: string, why: string, authorKind?: VoweAuthorKind): Promise<RoomResult<void>>;
      editDoc(roomId: string, decisionId: string, field: 'problem' | 'rationale', text: string): Promise<RoomResult<void>>;
      takeSuggestion(roomId: string, decisionId: string, lineId: string, accept: boolean): Promise<RoomResult<void>>;
      /** You (if you may sign) and `who` (owners and members) become its approvers; `who` may be empty. */
      requestSignatures(roomId: string, decisionId: string, who: string[]): Promise<RoomResult<void>>;
      /** permission: sign. */
      requestChanges(roomId: string, decisionId: string, version: number, text: string): Promise<RoomResult<void>>;
      /** The next version as a draft; returns its Desk id. permission: write. */
      amend(roomId: string, decisionId: string): Promise<RoomResult<{ id: string }>>;
      setSuggested(roomId: string, decisionId: string, state: 'dismissed' | 'draft'): Promise<RoomResult<void>>;
    };
    work: {
      create(roomId: string, work: { title: string; objective: string; decision?: string; thread?: string }, authorKind?: VoweAuthorKind): Promise<RoomResult<{ id: string }>>;
      /** One plan op against `base`, the version you read; `conflict` if it moved. permission: write. */
      plan(roomId: string, workId: string, op: PlanOp, base: number): Promise<RoomResult<{ version: number }>>;
      /** Suggested changes, each decided on its own. permission: write. */
      suggest(roomId: string, workId: string, revision: VoweRevision, authorKind?: VoweAuthorKind): Promise<RoomResult<{ id: string }>>;
      decideChange(roomId: string, workId: string, changeId: string, accept: boolean): Promise<RoomResult<void>>;
      /** Freezes `version` as approved. permission: the plan's owner or the room's owner. Starts nothing. */
      authorize(roomId: string, workId: string, version: number): Promise<RoomResult<void>>;
      requestScope(roomId: string, workId: string, ask: { text: string; adds: string; by: string }, authorKind?: VoweAuthorKind): Promise<RoomResult<{ id: string }>>;
      /** permission: the plan's owner or the room's owner. */
      allowScope(roomId: string, workId: string, allow: boolean): Promise<RoomResult<void>>;
      ask(roomId: string, workId: string, question: { text: string; about?: string; step?: string; for: string; options?: string[] }, authorKind?: VoweAuthorKind): Promise<RoomResult<{ id: string }>>;
      answer(roomId: string, workId: string, questionId: string, text: string): Promise<RoomResult<void>>;
      defer(roomId: string, workId: string, questionId: string): Promise<RoomResult<void>>;
      finding(roomId: string, workId: string, finding: { text: string; evidence?: string[]; offer?: string }, authorKind?: VoweAuthorKind): Promise<RoomResult<{ id: string }>>;
      /** A PR as a person reports it (no GitHub sync). permission: write. */
      trackPr(roomId: string, workId: string, pr: { num: number; title: string; state: PR['state']; branch?: string; url?: string; step?: string }): Promise<RoomResult<void>>;
      /** Every tracked PR must be merged or closed. permission: the plan's owner or the room's owner. */
      resolve(roomId: string, workId: string): Promise<RoomResult<void>>;
    };
    /** Your own For you marks. permission: comment. */
    markDone(roomId: string, ids: string[]): Promise<RoomResult<void>>;
    /** Renames the assistant in the room's workspace ('' → 'Vowe'); returns the name in use. Owners only. */
    setAgentName(roomId: string, name: string): Promise<RoomResult<string>>;
  };
  calls: {
    /** Returns a token for the room's call. Members only. */
    access(roomId: string): Promise<CallAccess>;
    requestMicrophone(): Promise<MicrophoneAccess>;
    /** Opens the system's microphone privacy settings (macOS); does nothing elsewhere. */
    openMicrophoneSettings(): Promise<void>;
  };
  /**
   * A room's semantic canvas. Members read it; owners and members change it, one Canvas Command at a
   * time (src/shared/canvas/commands.ts). Changes made anywhere arrive through onChanged.
   */
  canvas: {
    load(roomId: string): Promise<RoomResult<RoomCanvas>>;
    execute(roomId: string, command: unknown): Promise<CanvasExecuted>;
    /** Throttle this: it goes to everyone in the call. Requires having joined the room. */
    presence(roomId: string, presence: CanvasPresence): Promise<void>;
    onChanged(listener: (change: RoomCanvas & { result?: CommandResult }) => void): () => void;
  };
  /** Vowe's collaborator agent: text conversations about the work, through read-only tools. */
  agent: {
    status(): Promise<AgentStatus>;
    send(conversationId: string | null, context: AgentContext, text: string): Promise<AgentReply>;
    approve(approvalId: string, approved: boolean): Promise<void>;
    reset(conversationId: string): Promise<void>;
    /** The agent wants to send something that needs the user's say-so; answer with approve(). */
    onApproval(listener: (request: AgentApprovalRequest) => void): () => void;
    /** Each tool call as it finishes, while send() is still pending. */
    onToolCall(listener: (update: { conversationId: string; call: AgentToolCall }) => void): () => void;
    /** Asks Vowe a question in a room; follow it with onEvent. */
    ask(turn: RoomAgentTurn): Promise<{ turnId: string }>;
    cancel(turnId: string): Promise<void>;
    onEvent(listener: (event: AgentEvent) => void): () => void;
  };
  /** Sign in with ChatGPT, so Vowe's agent can use your ChatGPT plan. Separate from Google sign-in. */
  chatgpt: {
    status(): Promise<ChatGptStatus>;
    signIn(account?: string): Promise<ChatGptStatus>;
    signOut(): Promise<{ revoked: boolean }>;
    dismissWelcome(): Promise<void>;
    onChange(listener: (status: ChatGptStatus) => void): () => void;
  };
  /** Your Vowe's voice in a room's call. Members only (not viewers); one call at a time. */
  voice: {
    /** Brings your Vowe into the room's call, hearing your microphone; rejects with a reason to show. */
    start(roomId: string): Promise<VoiceStatus>;
    stop(): Promise<void>;
    status(): Promise<VoiceStatus>;
    /** Your microphone while it's on: 16 kHz mono 16-bit PCM, in chunks of at most 1 s. */
    audio(roomId: string, pcm: Uint8Array): Promise<void>;
    /** The runtime's VoiceOutput: what your Vowe says for a turn, as it streams. */
    begin(turnId: string): Promise<void>;
    say(turnId: string, text: string): Promise<void>;
    end(turnId: string): Promise<void>;
    /** Silence now, dropping what's unspoken: interrupted, cancelled or failed. */
    cancel(turnId: string): Promise<void>;
    onStatus(listener: (status: VoiceStatus) => void): () => void;
    /** Your speech, for VoiceAdapter.hear. Not stored anywhere. */
    onSpeech(listener: (update: { roomId: string; speech: HeardSpeech }) => void): () => void;
    /** Each sentence your Vowe starts saying, for captions. */
    onSaid(listener: (update: { roomId: string; turnId: string; text: string }) => void): () => void;
  };
  window: {
    /** Whether the window is in full screen, now (once the page has loaded) and on every change. */
    onFullScreen(listener: (fullScreen: boolean) => void): () => void;
  };
}
