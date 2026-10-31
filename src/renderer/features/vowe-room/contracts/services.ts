import type { RoomResult } from '../../../../shared/api.js';
import type { PersonId } from '../journey.js';
import type { About, Line, PR, Run, VoweRecord, Work } from './model.js';
import type { PlanOp } from '../state/plan.js';

// The services the Vowe room needs, as the renderer calls them. Every method resolves with Journey's
// RoomResult (failures are values, so codes survive IPC) and every write names the permission it needs
// (state/permissions.ts → Journey's can()). The server re-checks every permission; the renderer only uses
// them to decide what to show.
//
// Three groups, kept apart on purpose:
//   EXISTS IN JOURNEY   threads, replies, resolve, sign (RoomRecordSource), membership and invite
//                       (ShareDialog), canvas commands (CanvasClient), local workstreams and transcripts
//                       (WorkstreamDataSource). Adapters wrap these.
//   NEW, BUILDABLE NOW  the decision document, plan versions and suggested changes, authorization records,
//                       attention "done" marks. Pure record writes in Journey's room record; no new
//                       infrastructure. Shapes in BACKEND_HANDOFF.md.
//   NOT SUPPORTED       unattended agent runs, PR/CI sync, external notifications. Typed here as nullable;
//                       null means the room shows that truthfully and offers nothing that would need it.

/** A new conversation: on a canvas part or pin (Journey today), or on a decision line, plan passage, PR or check. */
export interface NewThread {
  about: About;
  body: string;
  /** Plan passage or decision line text the comment is anchored to. */
  quote?: string;
  /** A canvas pin, in stage units. */
  at?: { x: number; y: number };
  /** Ask someone directly: puts it in their For you. */
  waiting?: PersonId;
}

export interface ThreadService {
  /** permission: comment. Journey: RoomRecordSource.pin covers part/pin anchors; the other `about` kinds are new. */
  create(roomId: string, t: NewThread): Promise<RoomResult<{ id: string }>>;
  /** permission: comment. Journey: RoomRecordSource.reply. `parentId`: the reply it answers, in the same thread. */
  reply(roomId: string, threadId: string, body: string, parentId?: string | null): Promise<RoomResult<{ id: string }>>;
  /** permission: comment. Journey: RoomRecordSource.resolve. `reopen` opens a resolved thread again. */
  resolve(roomId: string, threadId: string, reopen?: boolean): Promise<RoomResult<void>>;
  /** Accept or dismiss an agent's offer in a thread. permission: write. Accepting only records the answer:
   *  whatever the offer makes (a decision draft, a plan revision) is created by a separate, visible write. */
  answerOffer(roomId: string, threadId: string, replyId: string, accept: boolean): Promise<RoomResult<void>>;
}

export interface DecisionService {
  /** A new draft. permission: write. Never in review, never signed. */
  create(roomId: string, d: { title: string; line?: string; from?: string; problem?: string }): Promise<RoomResult<{ id: string }>>;
  /** permission: write. Rejected with `conflict` once the version has a signature: amend instead. */
  editLine(roomId: string, decisionId: string, lineId: string, text: string): Promise<RoomResult<void>>;
  /** A new line on a draft (a commitment, a reason, an assumption…). permission: write. Rejected with `conflict` once signed. */
  addLine(roomId: string, decisionId: string, kind: Line['kind'], text: string): Promise<RoomResult<{ id: string }>>;
  editDoc(roomId: string, decisionId: string, field: 'problem' | 'rationale', text: string): Promise<RoomResult<void>>;
  /** Take or reject a suggested line edit. permission: write. */
  takeSuggestion(roomId: string, decisionId: string, lineId: string, accept: boolean): Promise<RoomResult<void>>;
  /** Move a draft to review and ask these members to sign. permission: write. Only members who may sign. */
  requestSignatures(roomId: string, decisionId: string, who: PersonId[]): Promise<RoomResult<void>>;
  /** permission: sign. Journey: RoomRecordSource.sign(roomId, decisionId, version). The version is the one read. */
  sign(roomId: string, decisionId: string, version: number): Promise<RoomResult<void>>;
  /** permission: sign. Leaves the version unsigned by you, with your reason. */
  requestChanges(roomId: string, decisionId: string, version: number, text: string): Promise<RoomResult<void>>;
  /** Start the next version as a draft; the agreed one stays until the new one is agreed, then is superseded.
   *  permission: write. Journey: RoomRecordSource.amend is the closest; it edits in place today. */
  amend(roomId: string, decisionId: string): Promise<RoomResult<{ id: string }>>;
  /** Dismiss or restore a decision the agent suggested. permission: write. */
  setSuggested(roomId: string, decisionId: string, state: 'dismissed' | 'draft'): Promise<RoomResult<void>>;
}

export interface WorkService {
  /** permission: write. A draft plan: no doer is authorized, nothing runs. */
  create(roomId: string, w: { title: string; objective: string; decision?: string; thread?: string }): Promise<RoomResult<{ id: string }>>;
  /** Apply one plan edit to the working draft. `base` is the version the editor read: the server rejects with
   *  `conflict` if someone else changed it since, and the Desk reloads. permission: write. */
  plan(roomId: string, workId: string, op: PlanOp, base: number): Promise<RoomResult<void>>;
  /** Accept or reject one suggested change. permission: write. */
  decideChange(roomId: string, workId: string, changeId: string, accept: boolean): Promise<RoomResult<void>>;
  /** Freeze `version` as approved and authorize its doer. Always a person's explicit act; never automatic.
   *  permission: sign (proposed: plan owner or room owner, see BACKEND_HANDOFF.md). */
  authorize(roomId: string, workId: string, version: number): Promise<RoomResult<void>>;
  /** Grant or refuse a scope request at the edge of what was authorized. permission: sign. */
  allowScope(roomId: string, workId: string, allow: boolean): Promise<RoomResult<void>>;
  /** Answer, defer or discuss a doer's question. permission: write. */
  answer(roomId: string, workId: string, questionId: string, text: string): Promise<RoomResult<void>>;
  defer(roomId: string, workId: string, questionId: string): Promise<RoomResult<void>>;
  /** Resolving is a person's call. permission: sign. */
  resolve(roomId: string, workId: string): Promise<RoomResult<void>>;
}

export interface AttentionService {
  /** Items you opened or acted on, so they leave For you on every device. permission: comment (your own marks). */
  markDone(roomId: string, ids: string[]): Promise<RoomResult<void>>;
}

/** Settings the room's people can change. */
export interface SettingsService {
  /** Rename the assistant for the room's workspace. permission: room owner (server-enforced). Empty: back to Vowe.
   *  Only its displayed name changes; its identity (glyph, attribution, id 'vowe') never does. */
  agentName(roomId: string, name: string): Promise<RoomResult<void>>;
}

/** NOT SUPPORTED in Journey: dispatching and steering an agent run from an authorized plan, unattended. */
export interface RunService {
  /** Start a run bound to an approved plan version. permission: sign. */
  start(roomId: string, workId: string, version: number): Promise<RoomResult<Run>>;
  /** Ask the run to stop after its current step. permission: write. */
  stop(roomId: string, workId: string, runId: string): Promise<RoomResult<void>>;
  /** A note to the run, inside its approved plan. permission: write. */
  note(roomId: string, workId: string, runId: string, text: string): Promise<RoomResult<void>>;
  subscribe(roomId: string, workId: string, fn: (run: Run) => void): () => void;
}

/** NOT SUPPORTED in Journey: PR and CI state read from GitHub and linked to plan steps. */
export interface GitHubService {
  prs(roomId: string, work: Pick<Work, 'id' | 'repo'>): Promise<RoomResult<PR[]>>;
  subscribe(roomId: string, fn: () => void): () => void;
}

/** NOT SUPPORTED in Journey: telling someone outside the app that something needs them. */
export interface NotificationService {
  notify(roomId: string, to: PersonId, attentionId: string): Promise<RoomResult<void>>;
}

export interface VoweServices {
  record: {
    /** Everything the Desk draws for one room. Journey's RoomRecord (threads, decisions, activity, lastSeenAt)
     *  is the existing subset; plans, work, notices and done marks are new. */
    load(roomId: string): Promise<RoomResult<VoweRecord>>;
    /** Journey: the room's 'record:changed' realtime event. */
    subscribe(roomId: string, fn: () => void): () => void;
  };
  threads: ThreadService;
  decisions: DecisionService;
  work: WorkService;
  attention: AttentionService;
  settings: SettingsService | null;
  runs: RunService | null;
  github: GitHubService | null;
  notifications: NotificationService | null;
}

/** What the room can truthfully offer, derived from the services and the record. */
export interface Capabilities {
  /** A run can be started, stopped and sent notes. False today. */
  agentRuns: boolean;
  /** PR and check state is synced from GitHub. False today: PRs shown are what the record holds. */
  githubSync: boolean;
  /** People can be told outside the app. False today: For you is in-app only. */
  notifications: boolean;
}

export function capabilitiesOf(s: Pick<VoweServices, 'runs' | 'github' | 'notifications'>): Capabilities {
  return { agentRuns: !!s.runs, githubSync: !!s.github, notifications: !!s.notifications };
}

export const NO_CAPABILITIES: Capabilities = { agentRuns: false, githubSync: false, notifications: false };

/** What the room's record looks like while it loads or after it failed (Journey's RoomLoad). */
export type { RoomLoad, RoomResult, RoomFailure, RoomErrorCode } from '../../../../shared/api.js';
