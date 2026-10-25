// Source: vowe-home-pass2.zip (approved Claude Design package, Pass 2), imports adapted to the vendored Preact.
/**
 * Pass 2 view models. Each one is derived from Journey state (see journey.ts and
 * INTEGRATION.md §3). Components never fetch; the app passes these in and handles
 * the callbacks.
 *
 * Capability rule: a field typed `X | null` is `null` when Journey can't know it
 * here (the UI leaves it out), and an empty array when it can but there's
 * nothing yet (the UI shows an honest empty state).
 */
import type { ComponentChildren } from '../../vendor/preact.js';
import type { PersonTone } from '../components.js';

import type { AuthFailure, IncomingInvitation, RoomRole, SignInProvider } from '../../../shared/api.js';
import type { WorkStatus } from '../../features/room/data/sources.js';

export type { SignInProvider as ProviderId };

export interface Person {
  id: string;
  name: string;
  initials: string;
  tone?: PersonTone;
}

/* -------------------------------------------------------------------- auth */

/**
 * The sign-in screen's state, as Journey's renderer can observe it:
 * `auth.signIn(p)` is one promise, `auth.cancel()` stops it, and
 * `auth.getEnded()` says why a session ended on its own.
 */
export type AuthPhase =
  | { kind: 'idle'; ended?: AuthFailure | null }
  | { kind: 'pending'; provider: SignInProvider }
  | { kind: 'cancelled' }
  | { kind: 'failed'; failure: Pick<AuthFailure, 'message'> & Partial<AuthFailure> }
  /** `account.user === undefined`: main hasn't answered `getUser` yet. */
  | { kind: 'restoring' }
  | { kind: 'signing-out' };

/** Who's signed in, for the account menu (from `User`). */
export interface AccountView {
  name: string;
  email: string;
  initials: string;
  tone?: PersonTone;
  provider: SignInProvider;
}

/* ------------------------------------------------------------------- rooms */

/** A small drawing of a room's last shared view. */
export interface CanvasSketch {
  nodes: { id: string; label: string; kind: string; x: number; y: number; state?: 'agreed' | 'proposed' | 'fault' }[];
  edges: { from: string; to: string; state?: 'agreed' | 'proposed' | 'fault' }[];
}

/**
 * In Journey, `canvas.load` + `buildScene` gives a Scene. Pass the app's own
 * `<SceneGlimpse>` as `still`, or a `sketch` adapted from the scene.
 */
export type CanvasPreview =
  | { status: 'ready'; sketch?: CanvasSketch; still?: ComponentChildren; viewName?: string }
  | { status: 'empty' }
  | { status: 'loading' }
  | { status: 'unavailable' };

/** One room on Home and in the Rooms index (from `RoomSummary` and the room's record). */
export interface RoomCard {
  id: string;
  name: string;
  role: RoomRole;
  /** `RoomSummary.repository`, e.g. `github.com/acme/payments`; null when none is attached. */
  repository: string | null;
  /** `rooms.checkout`: 'here' has a clone on this machine, 'missing' doesn't; null when unknown or no repository. */
  checkout: 'here' | 'missing' | null;
  /** The last thing that happened, in words, and when. */
  activity: { text: string; at: string | null };
  /** "Decision v3 needs your signature"; null when nothing does. */
  needs: string | null;
  /** Realtime presence. Only known for rooms whose channel you've joined; `null` otherwise. */
  presence: { here: Person[]; inCall: Person[] } | null;
  preview: CanvasPreview;
}

/* --------------------------------------------------------------- needs you */

export type NeedItem =
  | { kind: 'invitation'; invitation: IncomingInvitation }
  | { kind: 'signature'; id: string; roomId: string; roomName: string; title: string; version: number; proposedBy: string }
  /** Journey addition: a room's own need, in its words (the demo's rooms; RoomSummary.needs). */
  | { kind: 'room'; roomId: string; roomName: string; text: string };

/* -------------------------------------------------------------------- work */

/** A Claude Code workstream in a repository on this machine (`toRoomWorkstream`). */
export interface WorkItem {
  id: string;
  title: string;
  /** Always "Claude Code" today. */
  agent: string;
  repository: string;
  branch: string | null;
  status: WorkStatus;
  lastActivity: string | null;
  lastActivityAt: string | null;
}

export interface DecisionItem {
  id: string;
  roomId: string;
  roomName: string;
  title: string;
  version: number;
  /** All of the room's members and owners signed the current version. */
  agreed: boolean;
  at: string;
}

/* ---------------------------------------------------------------- projects */

/** A repository added on this machine (`Repository`), plus the rooms that use it. */
export interface LocalRepoView {
  id: string;
  name: string;
  /** For this person only, e.g. "~/code/payments". Never shared. */
  pathLabel: string;
  lastOpenedAt: string | null;
  /** Remote identity: not exposed by `repos.list` today (N). Null hides it. */
  remote: string | null;
  rooms: { id: string; name: string }[];
}

/** A room repository with no clone here (`rooms.checkout` → null). */
export interface MissingRepoView {
  repository: string;
  rooms: { id: string; name: string }[];
}

/* -------------------------------------------------------------------- home */

/** Which actions this build supports. Missing ones aren't shown. */
export interface HomeCapabilities {
  /** Cloud configured (Supabase): rooms exist at all. */
  rooms: boolean;
  /** Repository picker and detection (always true in the app, false in a browser preview). */
  repositories: boolean;
}
