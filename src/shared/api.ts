/**
 * The contract between main and renderer. Types only: the sandboxed preload can't
 * load local modules at runtime, so nothing here may emit JavaScript.
 *
 * Adding a capability: declare it in `Channels`, handle it in main/ipc.ts, and
 * expose it in preload/index.cts + `JourneyApi`. The compiler checks all three agree.
 */

import type { Tables } from '../integrations/supabase/types.js';

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
}

export type RoomEventType = keyof RoomEvents;

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
    'rooms:join': (roomId: string) => RoomSession;
    'rooms:leave': (roomId: string) => void;
    'rooms:send': <K extends RoomEventType>(roomId: string, type: K, payload: RoomEvents[K]) => RoomEvent<K>;
    'calls:access': (roomId: string) => CallAccess;
    /** Asks the OS for the microphone if it hasn't been asked yet; otherwise reports the current answer. */
    'calls:requestMicrophone': () => MicrophoneAccess;
  };
  event: {
    'auth:changed': User | null;
    'rooms:event': RoomEvent;
    'rooms:presence': { roomId: string; participants: Participant[] };
    'rooms:status': { roomId: string; status: RoomStatus };
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
  calls: {
    /** Returns a token for the room's call. Members only. */
    access(roomId: string): Promise<CallAccess>;
    requestMicrophone(): Promise<MicrophoneAccess>;
  };
}
