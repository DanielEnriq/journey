/**
 * The contract between main and renderer. Types only: the sandboxed preload can't
 * load local modules at runtime, so nothing here may emit JavaScript.
 *
 * Adding a capability: declare it in `Channels`, handle it in main/ipc.ts, and
 * expose it in preload/index.cts + `JourneyApi`. The compiler checks all three agree.
 */

import type { Tables } from '../integrations/supabase/types.js';
import type { CanvasChanged, CanvasDocument, CanvasPresence, CommandResult } from './canvas/index.js';

export interface User {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
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
 * What Vowe observes of a Claude Code session, named after the hook events. Hooks report all six
 * (agents/claude-code-hooks.ts); the transcript watcher (agents/claude-code-watcher.ts) sees prompts,
 * tool results, and completed turns, but never a session starting or ending.
 */
export type ClaudeCodeEventType = 'SessionStart' | 'UserPromptSubmit' | 'PostToolUse' | 'PostToolUseFailure' | 'Stop' | 'SessionEnd';

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
   * prompt, the end of Claude's reply on Stop, the start source, or the end reason.
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
 * - `turn-completed`: Claude finished a reply and was waiting on its user.
 * - `ended`: the session exited; only a SessionEnd hook confirms this.
 * - `unknown`: nothing observed recently enough to say.
 */
export type ClaudeCodeActivityState = 'active' | 'turn-completed' | 'ended' | 'unknown';

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
  provider: string;
  model: string;
  /** Whether credentials appear to be set; a request can still fail on them. */
  configured: boolean;
}

// ─── Cloud ───────────────────────────────────────────────────────────────────
// Cloud ids (created_by, Participant.userId, RoomEvent.senderId) are Supabase user ids,
// not the Google `sub` in User.id. RoomSession.selfId is the signed-in user's.

export type Workspace = Tables<'workspaces'>;

// ─── Rooms ───────────────────────────────────────────────────────────────────
// A room is persistent and exists apart from its call: opening one (rooms.get, rooms.members) reads
// cloud rows only. It never starts a call, opens the microphone, runs a coding agent, or shares
// local files. Joining the call (rooms.join, calls.access) is a separate step, for members only.
// Implementation: integrations/supabase/rooms.ts; rules: supabase/migrations/*_room_membership.sql.

/** `owner`s rename, delete, and manage members; `member`s use the room and can leave it. */
export type RoomRole = 'owner' | 'member';

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
  /** Your role in it. */
  role: RoomRole;
}

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

export interface RoomFailure {
  code: RoomErrorCode;
  message: string;
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
}

/**
 * Every event a room carries, by type. Add an entry here plus its validator in
 * integrations/supabase/realtime.ts; the compiler then checks senders and receivers.
 */
export interface RoomEvents {
  'chat:message': { text: string };
  /** The room's record changed (a thread, reply, decision or signature); members re-read it. */
  'record:changed': { what: 'thread' | 'reply' | 'decision' | 'signature' };
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

export type RoomActivityKind = 'thread' | 'reply' | 'decision' | 'amended' | 'signed' | 'repository' | 'call-started' | 'call-left';

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
// Each room has a LiveKit audio call, joined from the renderer (renderer/call.ts). Main only
// hands out access; LiveKit participant identities are cloud user ids, like Participant.userId.

/** Where to connect for a room's call. The token is short-lived and only admits you to that room. */
export interface CallAccess {
  url: string;
  token: string;
}

/** The OS-level microphone permission. `denied`/`restricted` mean the user must change it in system settings. */
export type MicrophoneAccess = 'granted' | 'denied' | 'restricted';

/**
 * IPC channel names. `invoke` channels are request/response handled by main
 * (arguments are untrusted at runtime; handlers must validate them). `event`
 * channels are pushed from main to renderers.
 */
export interface Channels {
  invoke: {
    'auth:getUser': () => User | null;
    'auth:signIn': () => User;
    'auth:signOut': () => void;
    'settings:get': () => Settings;
    'settings:update': (patch: Partial<Settings>) => Settings;
    'repos:list': () => Repository[];
    /** Main shows a folder picker; resolves null if cancelled. The renderer never sends paths. */
    'repos:add': () => Repository | null;
    'repos:remove': (id: string) => void;
    /** Looks for repositories in the usual code folders, leaving out ones already added. */
    'repos:detect': () => DetectedRepository[];
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
    'record:get': (roomId: string) => RoomResult<RoomRecord>;
    'record:addThread': (roomId: string, thread: NewThread) => RoomResult<RoomThread>;
    'record:reply': (roomId: string, threadId: string, body: string) => RoomResult<RoomComment>;
    'record:resolve': (roomId: string, threadId: string) => RoomResult<void>;
    'record:propose': (roomId: string, decision: { title: string; verify: string }) => RoomResult<RoomDecision>;
    'record:amend': (roomId: string, decisionId: string, change: { title?: string; verify?: string }) => RoomResult<RoomDecision>;
    /** Signs the decision's current version; refused if `version` isn't current any more. */
    'record:sign': (roomId: string, decisionId: string, version: number) => RoomResult<RoomDecision>;
    'record:seen': (roomId: string) => RoomResult<void>;
    'record:call': (roomId: string, what: 'call-started' | 'call-left') => RoomResult<void>;
    'canvas:load': (roomId: string) => RoomResult<RoomCanvas>;
    /** Runs a Canvas Command as the signed-in person; the result says if it was refused and why. */
    'canvas:execute': (roomId: string, command: unknown) => CanvasExecuted;
    /** Your view, pen and selection: sent to the room's call and kept for Vowe's "this". */
    'canvas:presence': (roomId: string, presence: CanvasPresence) => void;
    'rooms:join': (roomId: string) => RoomSession;
    'rooms:leave': (roomId: string) => void;
    'rooms:send': <K extends RoomEventType>(roomId: string, type: K, payload: RoomEvents[K]) => RoomEvent<K>;
    'calls:access': (roomId: string) => CallAccess;
    /** Asks the OS for the microphone if it hasn't been asked yet; otherwise reports the current answer. */
    'calls:requestMicrophone': () => MicrophoneAccess;
    'agent:status': () => AgentStatus;
    /** Starts a conversation when `conversationId` is null; resolves with the agent's answer. */
    'agent:send': (conversationId: string | null, context: AgentContext, text: string) => AgentReply;
    /** Answers an agent:approval request. */
    'agent:approve': (approvalId: string, approved: boolean) => void;
    /** Forgets the conversation and declines anything it's waiting on. */
    'agent:reset': (conversationId: string) => void;
  };
  event: {
    'auth:changed': User | null;
    'claudeCode:event': ClaudeCodeEvent;
    'rooms:event': RoomEvent;
    'rooms:presence': { roomId: string; participants: Participant[] };
    'rooms:status': { roomId: string; status: RoomStatus };
    /** A room's canvas changed, here or elsewhere; `result` when this app made the change. */
    'canvas:changed': RoomCanvas & { result?: CommandResult };
    'agent:approval': AgentApprovalRequest;
    'agent:toolCall': { conversationId: string; call: AgentToolCall };
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
    signIn(): Promise<User>;
    signOut(): Promise<void>;
    /** Subscribes to sign-in/sign-out; returns an unsubscribe function. */
    onChange(listener: (user: User | null) => void): () => void;
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
  };
  /** A room's record: threads, replies, decisions and signatures, activity. Members only. */
  record: {
    get(roomId: string): Promise<RoomResult<RoomRecord>>;
    addThread(roomId: string, thread: NewThread): Promise<RoomResult<RoomThread>>;
    reply(roomId: string, threadId: string, body: string): Promise<RoomResult<RoomComment>>;
    resolve(roomId: string, threadId: string): Promise<RoomResult<void>>;
    propose(roomId: string, decision: { title: string; verify: string }): Promise<RoomResult<RoomDecision>>;
    amend(roomId: string, decisionId: string, change: { title?: string; verify?: string }): Promise<RoomResult<RoomDecision>>;
    sign(roomId: string, decisionId: string, version: number): Promise<RoomResult<RoomDecision>>;
    /** Moves your "last looked" marker to now. */
    seen(roomId: string): Promise<RoomResult<void>>;
    /** Records that you started or left the room's call. */
    call(roomId: string, what: 'call-started' | 'call-left'): Promise<RoomResult<void>>;
  };
  calls: {
    /** Returns a token for the room's call. Members only. */
    access(roomId: string): Promise<CallAccess>;
    requestMicrophone(): Promise<MicrophoneAccess>;
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
  };
}
