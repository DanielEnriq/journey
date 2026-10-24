import type {
  AgentTarget, BoundDef, ChangedFile, Decision, LabelDef, Note, PartDef, Person, PersonId, PersonRef, RoomSummary, StepDef,
  ViewDef, ViewId, WireDef, Workstream,
} from '../types.js';

// The seams between the app and the services behind it. Today every one is a mock (features/workspace/mock
// for rooms, calls and work context; ../mock/ for the Payment Reliability canvas); the real ones
// (Supabase, LiveKit + ElevenLabs, Vowe's composer, the intent service, WorkContextService) implement
// the same shapes, and the components only ever see these.

/* ---------- Rooms: persistent, listed by the workspace, previewed outside the call. ---------- */

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
  lastView: { name: string; question: string; at: string; by: PersonRef | null } | null;
}

/** Rooms and the people in them. Real: Supabase rooms plus Realtime presence. */
export interface RoomDataSource {
  list(): RoomSummary[];
  /** Called whenever a room, its call, or its preview changes. */
  subscribe(listener: () => void): () => void;
  create(room: NewRoom): RoomSummary;
  preview(roomId: string): Promise<RoomPreview>;
  /** You were here: "since you were last here" counts from now. */
  visited(roomId: string): void;
  people(): Record<PersonId, Person>;
  /** Asks a teammate to join; resolves once they have. Only ever called after the room said yes. */
  invite(person: PersonId): Promise<void>;
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
}

/** Coding agents working from signed decisions. Real: the Claude Code / Codex adapters, each in its own worktree. */
export interface WorkstreamDataSource {
  /** The room's repositories, worktrees and sessions. Rejects when the context can't be read right now. */
  context(roomId: string): Promise<RoomWorkContext>;
  /** Shares a workstream seen only on your machine with the room's members. */
  share(roomId: string, streamId: string): Promise<void>;
  /* The Payment Reliability call's scripted handoff. */
  /** Work already running before this room's decision was handed off. */
  running(): Workstream[];
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
  work: WorkstreamDataSource;
}
