/** A person's cloud user id, or AGENT. */
export type PersonId = string;
import type { RoomRole } from '../api.js';
export type { RoomRole };

// The room's record, as the Desk draws it: threads, decisions, work, and who needs to do what.
// Journey's RoomRecord (shared/api.ts) already keeps threads anchored to a part or pin with their replies
// (the agent's included), decisions with versions and signatures, activity and lastSeenAt. Everything else
// here (decision documents, plan versions and suggested changes, authorization, runs, PRs, notices) is new;
// BACKEND_HANDOFF.md maps each field to what exists and what has to be built.

/** Journey's ClaimBasis: how we know something. */
export type Basis = 'observed' | 'inferred' | 'hypothetical' | 'decided';

export interface Evidence { id: string; label: string; source: 'code' | 'test' | 'log' | 'session' | 'review' | 'doc'; ref: string; basis: Basis }

/** Who said or made something, and whether a person stated it or Vowe inferred it. */
export interface By { who: PersonId; how?: 'stated' | 'inferred' | 'edited' | 'observed' }

/**
 * What a thread is about. Journey anchors threads to a canvas part or a pin; the rest are new. One thread,
 * one subject: a thread that matters to a decision and a PR is linked from both, never copied.
 */
export type About =
  | { kind: 'part'; id: string; name: string }
  | { kind: 'edge'; id: string; name: string }
  | { kind: 'scenario'; id: string; name: string }
  | { kind: 'decision'; id: string; name: string }
  | { kind: 'line'; id: string; decision: string; name: string }
  | { kind: 'work'; id: string; name: string }
  | { kind: 'step'; id: string; work: string; name: string }
  | { kind: 'pr'; id: string; name: string }
  | { kind: 'check'; id: string; pr: string; name: string };

export interface Reply {
  id: string;
  /** The reply this one answers; none when it answers the thread (the first reply is the thread itself). */
  parent?: string;
  by: PersonId;
  body: string;
  ago: string;
  evidence?: string[];
  /** Canvas parts the reply points at; hovering lights them. */
  points?: string[];
  fresh?: boolean;
  /** Vowe offering to make something from the conversation; a person accepts or dismisses. */
  offer?: { kind: 'decision' | 'work' | 'revision' | 'edit'; text: string; state: 'open' | 'accepted' | 'dismissed'; by?: PersonId; target?: string };
  /** Said aloud in the call (kept as a transcript line in the thread). */
  spoken?: boolean;
}

export interface Thread {
  id: string;
  about: About;
  title?: string;
  replies: Reply[];
  status: 'open' | 'resolved';
  /** Other subjects this conversation also concerns (a decision line, a PR): shown there as links. */
  linked?: About[];
  /** Who it's waiting on, if anyone. */
  waiting?: PersonId;
  /** `under`: the reply being answered, when it's one (an agent answering shows beneath it). `draft` and `doing`,
   *  live from the asker's own turn: the agent's answer so far, and what it's doing in words. */
  presence?: { personId: PersonId; mode: 'typing' | 'reading'; under?: string; draft?: string; doing?: string };
  /** The passage a comment is anchored to (plan steps, decision lines). */
  quote?: string;
  at?: { x: number; y: number };
}

export interface Line {
  id: string;
  kind: 'decide' | 'because' | 'assume' | 'open' | 'scope';
  text: string;
  by: By;
  basis?: Basis;
  evidence?: string[];
  /** A change someone (or Vowe) suggested, not yet taken. */
  suggest?: { text: string; by: PersonId; why: string };
  was?: string;
  overturned?: { by: PersonId; why: string; evidence?: string };
}

export interface Decision {
  id: string;
  title: string;
  /** suggested: Vowe noticed one · draft: written, not yet asked for · review: asking for signatures · agreed · superseded · dismissed. */
  state: 'suggested' | 'draft' | 'review' | 'agreed' | 'superseded' | 'dismissed';
  version: number;
  lines: Line[];
  verify: string[];
  alternatives: { id: string; title: string; why: string; state: 'open' | 'set-aside' }[];
  approvers: { who: PersonId; signed: number | null; changes?: string }[];
  from?: string;
  parts: string[];
  by: By;
  ago: string;
  work?: string[];
  /** The decision as an argument: the prose around the typed lines. Who wrote each part is kept. */
  doc?: {
    problem: { text: string; by: By };
    rationale?: { text: string; by: By };
    tradeoffs: { text: string; by: By }[];
    consequences: { text: string; by: By }[];
    /** Evidence ids that cut against the decision. */
    against?: string[];
  };
  reviewers?: PersonId[];
  /** The version this one replaces, and why it was reconsidered. */
  revises?: { version: number; why: string };
  implemented?: string[];
}

export interface Step {
  id: string;
  text: string;
  pr?: string;
  /** Who wrote it first, and who last changed it. */
  by: By;
  edited?: PersonId;
  state: 'todo' | 'doing' | 'done' | 'wont';
  /** Promoted to its own work item (that item's id); this plan depends on it. */
  promoted?: string;
}

/** Something the plan points at, inspectable in place. */
export interface Ref {
  id: string; kind: 'decision' | 'thread' | 'part' | 'file' | 'evidence' | 'work'; label: string; target: string; sub?: string;
  /** file: the referenced lines as captured when the plan cited them (shown in place). */
  excerpt?: string;
  /** file: where to read it on the forge (https only). */
  url?: string;
}

/** What a plan version holds. Approving freezes one of these. */
export interface PlanBody { objective: string; plan: Step[]; may: string[]; mayNot: string[]; askWhen: string[]; accept: string[] }
export interface PlanVersion {
  version: number;
  /** Who shaped this version. */
  by: PersonId[];
  ago: string;
  approved?: { by: PersonId; ago: string; doer: string; scope: string; includes?: string[] };
  body: PlanBody;
}

/** One change Vowe (or a person) suggests to a plan, accepted or rejected on its own. */
export type ChangeKind = 'edit' | 'add' | 'remove' | 'move' | 'promote' | 'bound' | 'verify';
export interface Change {
  id: string;
  kind: ChangeKind;
  step?: string;
  text?: string;
  /** add: insert after this step (null: at the start). move: new index. */
  after?: string | null;
  list?: 'may' | 'mayNot' | 'askWhen';
  /** promote: the new work item's title, and what the proposer filled in for it (id, why, scope). */
  title?: string;
  seed?: Partial<Pick<Work, 'id' | 'why' | 'parts' | 'may' | 'mayNot' | 'askWhen' | 'accept'>>;
  note?: string;
  state: 'open' | 'accepted' | 'rejected';
  decidedBy?: PersonId;
}
export interface Revision { id: string; by: PersonId; why: string; from?: string; changes: Change[]; base: number }

export interface Check { name: string; state: 'pass' | 'fail' | 'running' | 'queued'; detail?: string; took?: string; log?: string[]; /** The CI run's page (https). */ url?: string }

export interface PR {
  id: string;
  num: number;
  title: string;
  state: 'draft' | 'open' | 'review' | 'changes' | 'merged' | 'closed';
  branch: string;
  by: PersonId;
  step?: string;
  checks: Check[];
  dependsOn?: number;
  supersededBy?: number;
  review?: { by: PersonId; state: 'approved' | 'changes' | 'commented' | 'requested'; text?: string };
  files: { path: string; add: number; del: number }[];
  parts: string[];
  ago: string;
  /** The PR's page. When absent and the repo is on github.com, the Desk links github.com/<repo>/pull/<num>. */
  url?: string;
}

export interface Run {
  id: string;
  agent: string;
  where: string;
  state: 'running' | 'waiting' | 'stopped' | 'finished';
  /** The approved plan version this run executes. */
  plan: number;
  /** Where a person can watch or take over the session (https or a registered scheme), if the runner exposes one. */
  url?: string;
  /** Only what we saw it do, each line from its own events. */
  events: { text: string; ago: string; kind?: 'read' | 'edit' | 'test' | 'git' | 'ask' | 'fail' }[];
}

export interface Work {
  id: string;
  title: string;
  why: string;
  decision?: string;
  thread?: string;
  repo: string;
  parts: string[];
  owner: PersonId;
  /** Who does it: a person, or a coding agent the room can reach. */
  doer: { kind: 'agent' | 'person'; name: string } | null;
  state: 'draft' | 'proposed' | 'authorized' | 'running' | 'waiting' | 'review' | 'resolved' | 'closed';
  plan: Step[];
  may: string[];
  mayNot: string[];
  askWhen: string[];
  accept: string[];
  authorized?: { by: PersonId; ago: string; scope: string };
  scopeAsk?: { text: string; adds: string; by: string };
  question?: { id: string; text: string; about: string; step?: string; for: PersonId; options: string[]; answer?: { by: PersonId; text: string }; deferred?: boolean };
  runs: Run[];
  prs: PR[];
  /** The plan as a versioned document: what's being edited now is `version`; approved versions are frozen. */
  context: Ref[];
  version: number;
  versions: PlanVersion[];
  revision?: Revision;
  exec: { where: string; prs: 'per-step' | 'grouped' };
  /** Work this depends on (it must merge first), and work that depends on this. */
  dependsOn?: string;
  blocks?: string;
  /** Who changed the plan, newest last. */
  log: { who: PersonId; text: string; ago: string }[];
  finding?: { text: string; by: PersonId; ago: string; evidence?: string[]; offer?: string };
  ago: string;
  resolved?: { by: PersonId; ago: string; ack?: PersonId[] };
  /** Which check verifies each acceptance criterion (criterion text → check name and PRs), as CI reports it. */
  verifiedBy?: Record<string, string>;
}

export interface Notice {
  id: string;
  for: PersonId;
  level: 'blocker' | 'request' | 'info';
  text: string;
  to: { tab: 'discuss' | 'decide' | 'work'; id: string; part?: string; inspect?: boolean };
  ago: string;
  read?: boolean;
}

export interface VoweRecord {
  goal?: { text: string; by: PersonId };
  threads: Thread[];
  decisions: Decision[];
  work: Work[];
  notices: Notice[];
  since?: { lastHere: string; items: { text: string; to: Notice['to']; tone: 'live' | 'needs' | 'quiet' | 'bad'; parts?: string[]; mark?: string }[] };
  /** No call is the normal state; this says whether one is on. */
  call: boolean;
  /** Room membership (Journey's RoomRole), with the member's display name when the record carries it. */
  members: { who: PersonId; role: RoomRole; name?: string }[];
  /** Attention items you've opened or acted on. */
  done: string[];
  /** Vowe is on in this room (off: no AI at all). */
  vowe: boolean;
  /** The agent's displayed name in this organization. */
  agentName?: string;
  /** Is a coding agent reachable from this room at all. */
  agents: { name: string; status: 'connected' | 'not-connected'; note: string }[];
  /** You, as this record names you (your cloud user id), when the reader is known. */
  me?: PersonId;
  /**
   * When things happened, as ISO times, for readers that need real time rather than `ago` (the Inbox). Keys:
   *   <thread id>                       thread started        <thread id>:<reply id>   a reply (the first reply's id is the thread's)
   *   <decision version id>             version written       <dv>:review              signatures requested
   *   <dv>:signed:<person>              that person signed this version              <dv>:agreed  agreed
   *   <work id>                         work created          <work id>:plan           its current plan version written
   *   <work id>:question                the shown question    <work id>:revision       the open suggestion set
   *   <work id>:scope                   the open scope ask    <work id>:authorized     authorized
   *   <work id>:resolved                resolved
   */
  times?: Record<string, string>;
  /** The room's activity log, newest first (who did what to which subject, and when). */
  log?: RecordEvent[];
}

/** One line of the room's activity log, as the database keeps it. */
export interface RecordEvent {
  id: string;
  /** Who did it; null when the system did. */
  by: PersonId | null;
  /** The database's activity kind: thread, reply, decision, amended, signed, review, agreed, changes, work, plan,
   *  authorized, scope, question, finding, resolved, joined, left, removed, role, repository, call-started, call-left. */
  kind: string;
  /** What it was about, in words (a title, or a message's text). */
  text: string;
  /** The subject's id: a thread id, a database decision id (not a version id), a work id; null for the room. */
  subject: string | null;
  version: number | null;
  at: string;
}

/** The agent's person id in every record. Its displayed name comes from the Directory. */
export const AGENT = 'vowe';
