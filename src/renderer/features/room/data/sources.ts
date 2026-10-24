import type { Scene } from '../../../../shared/canvas/index.js';
import type {
  AgentTarget, BoundDef, ChangedFile, Decision, LabelDef, Note, PartDef, Person, PersonId, PersonRef, RoomSummary, StepDef,
  ViewDef, ViewId, WireDef, Workstream,
} from '../types.js';
import type { RoomPanelProps } from '../panel/types.js';
import type { Scenario } from '../controller.js';

// The seams between the app and the services behind it. Two workspaces implement them: the real one
// (features/workspace/real: Supabase rooms and their record, Realtime presence, WorkContextService and
// Claude Code transcripts over IPC) and the Payment Reliability demo (features/workspace/mock, plus
// ../mock/ for its scripted canvas, call and coding agent). The components only ever see these shapes.

/* ---------- Rooms: persistent, listed by the workspace, previewed outside the call. ---------- */

/** A repository the room picker offers: one added on this machine, or a demo example. */
export interface RepoChoice { id: string; label: string }

/** `repo` is a RepoChoice id. */
export interface NewRoom { name: string; goal: string; repo: string | null }

/** Something that happened in a room, newest first wherever it is listed. */
export interface RoomEvent {
  id: string;
  /** ISO 8601. */
  at: string;
  text: string;
  who: PersonRef | null;
  /** `needs`: a person has to act; `pass`/`fail`: a verification outcome. Everything else is plain. */
  tone?: 'needs' | 'pass' | 'fail';
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
  people(): Record<PersonId, Person>;
  /** Asks a teammate to join; resolves once they have. Only ever called after the room said yes. */
  invite(person: PersonId): Promise<void>;
  /** Repositories a room can be connected to; absent where rooms can't be (the demo). */
  repos?(): Promise<RepoChoice[]>;
  /** Adds a repository on this machine with a folder picker; null if cancelled. */
  addRepo?(): Promise<RepoChoice | null>;
  attach?(roomId: string, repoId: string): Promise<void>;
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

/** The system on the canvas and the views drawn of it. Real: Vowe's composer, bound to the repository. */
export interface CanvasDataSource {
  parts(): PartDef[];
  /** Every view's wires, labels, boundaries and steps; the canvas fades in the current view's. */
  wires(): WireDef[];
  labels(): LabelDef[];
  bounds(): BoundDef[];
  steps(): StepDef[];
  view(id: ViewId): ViewDef | undefined;
  /** Vowe draws a new view mid-call from the building blocks, and says how. */
  compose(id: 'timeout' | 'ui', parent: ViewId): ViewDef;
  /** A part's own drawing for a view, given how far the handed-off work has got. */
  describe(part: PartDef, view: ViewId, work: { progress: number; question: QuestionState }): PartState;
}

/** The call. Real: LiveKit for audio, ElevenLabs for Vowe's voice and captions. Never opens the mic by itself. */
export interface CallDataSource {
  /** Joins the room's call, starting one if nobody is in it. Resolves once connected, muted. */
  join(roomId: string): Promise<void>;
  leave(roomId: string): Promise<void>;
  setMuted(muted: boolean): void;
  setCaptions(on: boolean): void;
}

/** What people meant and what they agreed. Real: the intent and decision service. */
export interface IntentDataSource {
  goal(): { text: string; by: PersonId };
  notes(): Note[];
  decision(): Decision;
  /** The decision's fixed fields; only its checks get amended in this room. */
  decisionText(): { what: string; goal: string; avoid: string; because: string; why: string };
  /** A check Vowe suggests while the decision is amended. */
  suggestedCheck(): string;
}

export type QuestionState = 'none' | 'open' | 'answered';

export interface WorkEvents {
  /** Stage index into stages(): started, reading, changing, testing, ready. */
  progress(stage: number): void;
  /** The agent hit something the decision doesn't settle. */
  question(): void;
}

/* ---------- Work context: the coding activity behind a room. ---------- */

/**
 * How sure we are about a workstream, from evidence only (see features/work/status.ts):
 * `active` activity was observed recently; `completed` its checks passed; `attention` it is waiting on
 * a person; `unknown` nothing recent was observed, so whether it is still running can't be told.
 */
export type WorkStatus = 'active' | 'completed' | 'attention' | 'unknown';

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
}

export interface RoomWorkContext {
  /** Null when the room has no repository attached. */
  repo: string | null;
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

/** The Payment Reliability call's scripted coding agent and its handoff. */
export interface ScriptedWorkSource extends WorkstreamDataSource {
  /** Work already running before this room's decision was handed off. */
  running(scenario: Scenario): Workstream[];
  stages(): string[];
  files(): ChangedFile[];
  branch(): string;
  handoff(decision: Decision, target: AgentTarget, events: WorkEvents): void;
  answer(text: string, events: WorkEvents): void;
}

export interface RoomSources {
  room: RoomDataSource;
  canvas: CanvasDataSource;
  call: CallDataSource;
  intent: IntentDataSource;
  work: ScriptedWorkSource;
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
