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
export type Room = Tables<'rooms'>;

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
    'rooms:list': (workspaceId: string) => Room[];
    'rooms:create': (workspaceId: string, name: string) => Room;
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
    list(workspaceId: string): Promise<Room[]>;
    /** Creates a room in a workspace you belong to; you become a member but aren't connected yet. */
    create(workspaceId: string, name: string): Promise<Room>;
    /** Becomes a member if needed, connects, and announces you to the room. Joining twice is a no-op. */
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
    /** Becomes a room member if needed and returns a token for the room's call. */
    access(roomId: string): Promise<CallAccess>;
    requestMicrophone(): Promise<MicrophoneAccess>;
  };
}
