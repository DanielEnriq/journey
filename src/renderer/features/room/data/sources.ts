import type { Scene } from '../../../../shared/canvas/index.js';
import type { ChangedFile, PersonRef, RoomSummary, SpaceSummary } from '../types.js';
import type { RoomPanelProps } from '../panel/types.js';

// The seams between the app and the services behind it, implemented by the workspace
// (features/workspace/real: Supabase rooms and their record, Realtime presence, WorkContextService and
// Claude Code transcripts over IPC). The components only ever see these shapes.

/* ---------- Rooms: persistent, listed by the workspace, previewed outside the call. ---------- */

/** A repository the room picker offers: one added on this machine. */
export interface RepoChoice { id: string; label: string }

/** `repo` is a RepoChoice id. `spaceId`: the Space to make it in; your first Space when left out. */
export interface NewRoom { name: string; goal: string; repo: string | null; spaceId?: string }

/** What a room is called until someone names it, or says what it's for (then it's named from that). */
export const UNTITLED = 'Untitled';

/** A name for an untitled room from what it's for: its first line, cut at a word to fit a sidebar row. */
export function nameFromGoal(goal: string, max = 48): string {
  const line = goal.trim().split('\n')[0].replace(/[.?!:;,\s]+$/, '');
  if (line.length <= max) return line;
  const cut = line.slice(0, max + 1).replace(/\s+\S*$/, '');
  return (cut.length >= max / 2 ? cut : line.slice(0, max)).replace(/[.?!:;,\s]+$/, '') + '…';
}

/** A repository added on this machine, with the identity it's shared as; null where it has no shareable remote. */
export interface LocalRepo { id: string; label: string; identity: string | null }

/** What kind of thing happened, so a list can draw it with its icon. */
export type EventKind = 'call' | 'thread' | 'reply' | 'decision' | 'signed' | 'work' | 'resolved' | 'question' | 'repo' | 'people' | 'room';

/** Something that happened in a room, newest first wherever it is listed. */
export interface RoomEvent {
  id: string;
  /** Absent where the source can't say. */
  kind?: EventKind;
  /** ISO 8601. */
  at: string;
  text: string;
  who: PersonRef | null;
  /** `needs`: a person has to act; `pass`/`fail`: a verification outcome. Everything else is plain. */
  tone?: 'needs' | 'pass' | 'fail';
  /** Someone joined or left a call, or a call ended: kept in the room's history, never its one-line summary. */
  presence?: true;
}

/** What the room preview shows: enough to decide whether to join, never the canvas itself. */
export interface RoomPreview {
  room: RoomSummary;
  goal: { text: string; by: PersonRef } | null;
  /** Things others did since your last visit; empty on a first visit or when nothing changed. */
  since: RoomEvent[];
  recent: RoomEvent[];
  /** What waits on a person: a signature, an agent's question. Each is amber. */
  attention: { id: string; text: string; detail: string; streamId?: string }[];
  /** When you were last here (ISO 8601); null on a first visit. */
  seenAt?: string | null;
  /** The view last shared on the call, if anything has been drawn here. */
  lastView: { name: string; question: string; at: string; by: PersonRef | null; /** A real room's view, laid out from its saved canvas. */ scene?: Scene } | null;
}

/** Rooms and the people in them. Real: Supabase rooms plus Realtime presence. */
export interface RoomDataSource {
  list(): RoomSummary[];
  /** Called whenever a room, its call, or its preview changes. */
  subscribe(listener: () => void): () => void;
  create(room: NewRoom): Promise<RoomSummary>;
  /** You, as the room shows you. */
  me(): PersonRef;
  preview(roomId: string): Promise<RoomPreview>;
  /** You were here: "since you were last here" counts from now. */
  visited(roomId: string): void;
  /** You opened the room: its members can see you're here. Never joins its call. */
  enter?(roomId: string): Promise<void>;
  /** You closed the room. */
  exit?(roomId: string): Promise<void>;
  /** Repositories a room can be connected to; absent where rooms can't be. */
  repos?(): Promise<RepoChoice[]>;
  /** Adds a repository on this machine with a folder picker; null if cancelled. */
  addRepo?(): Promise<RepoChoice | null>;
  attach?(roomId: string, repoId: string): Promise<void>;
  /** Names the room or says what it's working toward; owners only. */
  update?(roomId: string, patch: { name?: string; goal?: string }): Promise<void>;
  /** Keeps a room, or lets it be quick again. */
  keep?(roomId: string, keep: boolean): Promise<void>;
  /** Pins a room at a place among yours (smallest first), moves it, or unpins it (null). Yours alone. */
  pin?(roomId: string, order: number | null): Promise<void>;
  /** Archives a room out of your sidebar (unpinning it), or brings it back. Yours alone. */
  archive?(roomId: string, archive: boolean): Promise<void>;
  /** Your Spaces, the ones you made first; read with list() and changed with the same subscribe(). */
  spaces?(): SpaceSummary[];
  /** Repositories on this machine that a Space can link, with their shared identities. */
  localRepos?(): Promise<LocalRepo[]>;
  /** Makes a Space and links the given repositories (LocalRepo ids) to it. */
  createSpace?(space: { name: string; repos: string[] }): Promise<SpaceSummary>;
  /** Owners only. */
  renameSpace?(spaceId: string, name: string): Promise<void>;
  /** Links a repository added on this machine (a LocalRepo id) to a Space. */
  linkRepo?(spaceId: string, repoId: string): Promise<void>;
  /** Unlinks one of a Space's repositories: whoever linked it, or a Space owner. */
  unlinkRepo?(spaceId: string, repository: string): Promise<void>;
}

/** What a part draws inside itself in a given view. */
export interface PartState {
  slots?: { id: string; cls: string; note: string; leased: boolean; lease: number }[];
  insts?: { name: string; job: string; g: string; cls: string }[];
  calls?: { label: string; amt: string; mark: string; cls: string }[];
  rows?: { a: string; b: string; c: string; cls: string; cCls: string }[];
  cols?: string;
  endpoint?: string;
  screen?: { bn: string; bnCls: string; btn: string; btnCls: string };
  diff?: { t: string; cls: string }[];
  cap: string;
  capCls: string;
}

/** The call. Real: LiveKit for audio, ElevenLabs for Vowe's voice and captions. Never opens the mic by itself. */
export interface CallDataSource {
  /** Joins the room's call, starting one if nobody is in it. Resolves once connected, muted. */
  join(roomId: string): Promise<void>;
  leave(roomId: string): Promise<void>;
  setMuted(muted: boolean): void;
  setCaptions(on: boolean): void;
}

/* ---------- Work context: the coding activity behind a room. ---------- */

/**
 * How sure we are about a workstream, from evidence only (see features/work/status.ts):
 * `active` activity was observed recently; `completed` its checks passed; `attention` it is waiting on
 * a person; `unknown` nothing recent was observed, so whether it is still running can't be told.
 */
export type WorkStatus = 'active' | 'completed' | 'attention' | 'unknown';

/** A room's agents in one mark for the sidebar: any waiting on you, else any running, else none. */
export const workMark = (statuses: WorkStatus[]): 'running' | 'waiting' | null =>
  statuses.includes('attention') ? 'waiting' : statuses.includes('active') ? 'running' : null;

export interface WorkCheck { text: string; result: 'pass' | 'fail' | 'running' | 'not-run' }

/**
 * One branch in one worktree, with the Claude Code sessions linked to it. Shaped so an adapter can build
 * it from WorkContextService's Workstream (worktreePath, branch, changedFiles, sessions, lastActivity).
 */
export interface RoomWorkstream {
  id: string;
  title: string;
  agent: string;
  branch: string | null;
  worktree: string;
  status: WorkStatus;
  /** ISO 8601 of the latest observed event; null when none was. */
  lastActivityAt: string | null;
  /** The latest observed event, in words. */
  lastActivity: string | null;
  changedFiles: number | null;
  sessions: number;
  /** `room`: shared with the room's members; `local`: seen on your machine only. */
  visibility: 'room' | 'local';
  fromDecision?: string;
  question?: string;
  checks?: WorkCheck[];
  /** Observed events, newest first. */
  observed: { at: string; text: string }[];
  files?: ChangedFile[];
  /** Which of the room's repositories it's in, where the room has several. */
  repo?: string;
}

export interface RoomWorkContext {
  /** The room's first repository; null when its Space has none. */
  repo: string | null;
  /** All of the room's repositories, and whether each is cloned on this machine. */
  repos?: { repo: string; here: boolean }[];
  generatedAt: string;
  workstreams: RoomWorkstream[];
  /** Why there is nothing to show even though the room has a repository, e.g. it isn't cloned here. */
  unavailable?: string;
}

/** One message of a Claude Code session, reduced to what a person reads. */
export interface TranscriptLine { id: string; role: 'user' | 'assistant' | 'tool'; text: string; at: string | null }

export interface Transcript {
  title: string;
  /** Messages in the whole session; `lines` are the latest of them, oldest first. */
  total: number;
  lines: TranscriptLine[];
}

/** The coding work behind a room. Real: WorkContextService and Claude Code's transcripts, on this machine. */
export interface WorkstreamDataSource {
  /** The room's repositories, worktrees and sessions. Rejects when the context can't be read right now. */
  context(roomId: string): Promise<RoomWorkContext>;
  /** Shares a workstream seen only on your machine with the room's members; absent where that isn't built. */
  share?(roomId: string, streamId: string): Promise<void>;
  /** The latest of a workstream's most recent Claude Code session; absent where there are no transcripts. */
  transcript?(roomId: string, streamId: string): Promise<Transcript>;
}

/* ---------- A room's record in its call: threads, replies, the decision. ---------- */

/** A comment on the canvas: where it sits (stage units), and the anchor its thread stacks under in the panel. */
export interface RoomPin { threadId: string; anchor: string; x: number; y: number; body: string; author: PersonRef }

/** The record as the call shows it: the right column's panel, and the comments pinned on the canvas. */
export interface RoomRecordView {
  panel: Omit<RoomPanelProps, `on${string}` | 'children'>;
  pins: RoomPin[];
  /** The decision being worked on, to amend from; null until someone proposes one. */
  decision: { id: string; title: string; verify: string } | null;
}

/** Real: the record:* channels, refreshed when another member changes it. Everything here persists. */
export interface RoomRecordSource {
  load(roomId: string): Promise<RoomRecordView>;
  subscribe(roomId: string, listener: () => void): () => void;
  /** A comment pinned to a point on the canvas (or on a part there) starts a thread; resolves to its id. */
  pin(roomId: string, at: { x: number; y: number }, body: string, on?: { component: string; name: string } | null): Promise<string>;
  /** Takes a comment off the canvas: its thread is resolved, and stays in the room's history. */
  resolve(roomId: string, threadId: string): Promise<void>;
  /** `vowe`: Vowe's feedback, from this person's app on their model; the panel shows it as Vowe's. */
  reply(roomId: string, threadId: string, body: string, as?: 'vowe'): Promise<void>;
  sign(roomId: string, decisionId: string, version: number): Promise<void>;
  propose(roomId: string, decision: { title: string; verify: string }): Promise<void>;
  amend(roomId: string, decisionId: string, change: { title: string; verify: string }): Promise<void>;
}
