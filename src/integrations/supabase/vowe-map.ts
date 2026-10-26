import type {
  About, By, Change, Decision, Line, Notice, PlanVersion, PR, RecordEvent, Ref, Reply, Revision, RoomRole, Step, Thread, VoweRecord, Work,
} from '../../shared/vowe/model.js';
import { AGENT } from '../../shared/vowe/model.js';
import { decisionVersionId } from '../../shared/vowe/ids.js';

// Turns the rows public.vowe_record(room) returns (supabase/migrations/*_vowe_room_work.sql) into the
// VoweRecord the Desk draws. Pure: no I/O, no clock except `now`, so it is tested on its own.
//
// Conventions: anything Vowe wrote (author_kind = 'agent') is attributed to AGENT and marked inferred,
// whoever's session saved it. Each decision version is its own Decision (ids from shared/vowe/ids.ts).

type Iso = string;
type Json = unknown;

export interface RawMember { user_id: string; role: RoomRole; name: string | null; email: string | null; avatar_url: string | null }
export interface RawComment {
  id: string; thread_id: string; body: string; created_by: string; created_at: Iso; author_kind: 'human' | 'agent';
  offer: { kind: 'decision' | 'work' | 'revision' | 'edit'; text: string; target?: string } | null;
  offer_state: 'open' | 'accepted' | 'dismissed' | null; offer_by: string | null;
}
export interface RawLink { about_kind: About['kind']; about_id: string; about_parent: string | null; about_name: string }
export interface RawThread {
  id: string; body: string; created_by: string; created_at: Iso; resolved_at: Iso | null;
  anchor_id: string; anchor_name: string; anchor_x: number | null; anchor_y: number | null;
  about_kind: About['kind']; about_parent: string | null; quote: string | null; waiting_on: string | null; author_kind: 'human' | 'agent';
  replies: RawComment[]; links: RawLink[];
}
export interface RawLine {
  id: string; position: number; kind: Line['kind']; text: string; created_by: string; author_kind: 'human' | 'agent';
  how: NonNullable<By['how']>; basis: Line['basis'] | null; evidence: string[] | null; was: string | null;
  suggest: { text: string; by: string; why: string } | null; edited_by: string | null;
}
export interface RawVersion {
  decision_id: string; version: number; title: string; verify: string; proposed_by: string; created_at: Iso;
  state: Decision['state']; revises_version: number | null; revises_why: string | null; doc: Json; author_kind: 'human' | 'agent';
  lines: RawLine[];
  alternatives: { id: string; title: string; why: string; state: 'open' | 'set-aside' }[];
  reviewers: { user_id: string; changes_text: string | null }[];
  signatures: { user_id: string; version: number; signed_at: Iso }[];
}
export interface RawDecision { id: string; title: string; version: number; created_at: Iso; from_thread: string | null; parts: string[] | null; versions: RawVersion[] }
export interface RawPlanVersion {
  version: number; body: Json; doer: Work['doer']; prs: string; shaped_by: string[] | null; created_at: Iso;
  approved: { doer: string; scope: string; includes?: string[] } | null; approved_by: string | null; approved_at: Iso | null;
}
export interface RawChange {
  id: string; position: number; kind: Change['kind']; step: string | null; text: string | null; after: string | null; after_set: boolean;
  list: Change['list'] | null; title: string | null; note: string | null; seed: Json; state: Change['state']; decided_by: string | null;
}
export interface RawRevision {
  id: string; base_version: number; created_by: string; author_kind: 'human' | 'agent'; why: string; from_thread: string | null;
  created_at: Iso; closed_at: Iso | null; changes: RawChange[];
}
export interface RawWork {
  id: string; title: string; why: string; plan: Json; may: Json; may_not: Json; ask_when: Json; accept: Json; context: Json;
  version: number; rev: number; decision_id: string | null; decision_version: number | null; thread_id: string | null; repo: string;
  parts: string[] | null; owner_id: string; doer: Work['doer']; state: Work['state']; depends_on: string | null; blocks: string | null;
  exec: Work['exec']; verified_by: Record<string, string> | null; authorized_by: string | null; authorized_at: Iso | null;
  authorized_version: number | null; authorized_scope: string | null; resolved_by: string | null; resolved_at: Iso | null;
  created_by: string; author_kind: 'human' | 'agent'; created_at: Iso;
  versions: RawPlanVersion[]; revision: RawRevision | null;
  log: { who: string | null; author_kind: 'human' | 'agent'; text: string; at: Iso }[];
  questions: { id: string; text: string; about: string; step: string | null; for_user: string; options: string[] | null; answer: string | null;
               answered_by: string | null; deferred: boolean; created_at: Iso }[];
  scope: { id: string; text: string; adds: string; asked_as: string; state: 'open' | 'allowed' | 'refused'; created_at: Iso }[];
  findings: { id: string; text: string; evidence: string[] | null; offer: string | null; created_by: string; author_kind: 'human' | 'agent'; created_at: Iso }[];
  prs: { id: string; num: number; title: string; state: PR['state']; branch: string; url: string | null; step: string | null; created_by: string; updated_at: Iso }[];
}
export interface RawActivity { id: string; actor_id: string | null; kind: string; subject: string | null; version: number | null; subject_id: string | null; created_at: Iso }
export interface RawVoweRecord {
  me: string | null;
  room: { id: string; goal: string | null; created_by: string; repository: string | null; vowe: boolean; agent_name: string | null };
  members: RawMember[];
  threads: RawThread[];
  decisions: RawDecision[];
  work: RawWork[];
  activity: RawActivity[];
  seen_at: Iso | null;
  done: string[];
}

export interface MapOptions {
  /** Coding agents reachable from this machine for this room (main works it out); none by default. */
  agents?: VoweRecord['agents'];
  now?: Date;
}

/** "now", "5m", "3h", "2d", or a date, from an ISO time. */
export function agoOf(iso: Iso | null | undefined, now = new Date()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((now.getTime() - t) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 14) return `${Math.floor(s / 86400)}d`;
  return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** "Tue 3 Nov, 14:20": the Desk shows the part before the comma. */
export function lastHereOf(iso: Iso): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).replace(/,/g, '');
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${day}, ${time}`;
}

const strings = (v: Json): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const objects = (v: Json): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)) : []);
const author = (kind: 'human' | 'agent', who: string | null | undefined): string => (kind === 'agent' ? AGENT : who ?? '');

function aboutOf(kind: About['kind'], id: string, name: string, parent: string | null): About {
  switch (kind) {
    case 'line': return { kind, id, name, decision: parent ?? '' };
    case 'step': return { kind, id, name, work: parent ?? '' };
    case 'check': return { kind, id, name, pr: parent ?? '' };
    default: return { kind, id, name };
  }
}

function stepsOf(v: Json, fallbackWho: string): Step[] {
  return objects(v).map((s) => {
    const by = s.by && typeof s.by === 'object' ? (s.by as By) : { who: fallbackWho, how: 'stated' as const };
    const step: Step = { id: String(s.id), text: typeof s.text === 'string' ? s.text : '', by, state: (s.state as Step['state']) ?? 'todo' };
    if (typeof s.pr === 'string') step.pr = s.pr;
    if (typeof s.edited === 'string') step.edited = s.edited;
    if (typeof s.promoted === 'string') step.promoted = s.promoted;
    return step;
  });
}

function bodyOf(v: Json, fallbackWho: string): PlanVersion['body'] {
  const b = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return {
    objective: typeof b.objective === 'string' ? b.objective : '',
    plan: stepsOf(b.plan, fallbackWho), may: strings(b.may), mayNot: strings(b.mayNot), askWhen: strings(b.askWhen), accept: strings(b.accept),
  };
}

function threadOf(t: RawThread, me: string | null, seenAt: Iso | null, now: Date): Thread {
  const fresh = (by: string, at: Iso) => !!seenAt && by !== me && Date.parse(at) > Date.parse(seenAt);
  const first: Reply = { id: t.id, by: author(t.author_kind, t.created_by), body: t.body, ago: agoOf(t.created_at, now) };
  if (fresh(t.created_by, t.created_at)) first.fresh = true;
  const replies: Reply[] = [first, ...t.replies.map((c) => {
    const r: Reply = { id: c.id, by: author(c.author_kind, c.created_by), body: c.body, ago: agoOf(c.created_at, now) };
    if (fresh(c.created_by, c.created_at)) r.fresh = true;
    if (c.offer && c.offer_state) {
      r.offer = { kind: c.offer.kind, text: c.offer.text, state: c.offer_state };
      if (c.offer_by) r.offer.by = c.offer_by;
      if (c.offer.target) r.offer.target = c.offer.target;
    }
    return r;
  })];
  const out: Thread = {
    id: t.id, about: aboutOf(t.about_kind, t.anchor_id, t.anchor_name, t.about_parent), replies,
    status: t.resolved_at ? 'resolved' : 'open',
  };
  if (t.links.length) out.linked = t.links.map((l) => aboutOf(l.about_kind, l.about_id, l.about_name, l.about_parent));
  if (t.waiting_on) out.waiting = t.waiting_on;
  if (t.quote) out.quote = t.quote;
  if (t.anchor_x !== null && t.anchor_y !== null) out.at = { x: t.anchor_x, y: t.anchor_y };
  return out;
}

function docOf(v: Json): Decision['doc'] {
  if (!v || typeof v !== 'object') return undefined;
  const d = v as Record<string, unknown>;
  const part = (x: unknown) => (x && typeof x === 'object' && typeof (x as { text?: unknown }).text === 'string' ? x as { text: string; by: By } : null);
  const parts = (x: unknown) => objects(x).map(part).filter((p): p is { text: string; by: By } => !!p);
  const problem = part(d.problem) ?? { text: '', by: { who: '' } };
  const doc: NonNullable<Decision['doc']> = { problem, tradeoffs: parts(d.tradeoffs), consequences: parts(d.consequences) };
  const rationale = part(d.rationale);
  if (rationale) doc.rationale = rationale;
  if (Array.isArray(d.against)) doc.against = strings(d.against);
  return doc;
}

function decisionsOf(d: RawDecision, members: RawMember[], workIds: string[], now: Date): Decision[] {
  const signers = members.filter((m) => m.role === 'owner' || m.role === 'member').map((m) => m.user_id);
  const allSignatures = d.versions.flatMap((v) => v.signatures);
  return d.versions.map((v) => {
    // Those asked to sign; a decision nobody was asked about (the older record path) asks every signer.
    const asked = v.reviewers.map((r) => r.user_id);
    const approverIds = asked.length ? asked : v.state === 'review' || v.state === 'agreed' || v.state === 'superseded' ? signers : [];
    const approvers = approverIds.map((who) => {
      const latest = allSignatures.filter((s) => s.user_id === who && s.version <= v.version).reduce<number | null>((m, s) => (m === null || s.version > m ? s.version : m), null);
      const a: Decision['approvers'][number] = { who, signed: latest };
      const changes = v.reviewers.find((r) => r.user_id === who)?.changes_text;
      if (changes && latest !== v.version) a.changes = changes;
      return a;
    });
    const lines: Line[] = v.lines.map((l) => {
      const line: Line = { id: l.id, kind: l.kind, text: l.text, by: { who: author(l.author_kind, l.created_by), how: l.author_kind === 'agent' ? 'inferred' : l.how } };
      if (l.basis) line.basis = l.basis;
      if (l.evidence?.length) line.evidence = l.evidence;
      if (l.suggest) line.suggest = { text: l.suggest.text, by: l.suggest.by, why: l.suggest.why ?? '' };
      if (l.was !== null && l.was !== l.text) line.was = l.was;
      return line;
    });
    const out: Decision = {
      id: decisionVersionId(d.id, v.version), title: v.title, state: v.state, version: v.version, lines,
      verify: v.verify.split(/;|\n/).map((s) => s.trim()).filter(Boolean),
      alternatives: v.alternatives.map((a) => ({ id: a.id, title: a.title, why: a.why, state: a.state })),
      approvers, parts: d.parts ?? [],
      by: { who: author(v.author_kind, v.proposed_by), how: v.author_kind === 'agent' ? 'inferred' : 'stated' },
      ago: agoOf(v.created_at, now),
    };
    if (d.from_thread) out.from = d.from_thread;
    if (workIds.length) out.work = workIds;
    const doc = docOf(v.doc);
    if (doc) out.doc = doc;
    if (asked.length) out.reviewers = asked;
    if (v.revises_version) out.revises = { version: v.revises_version, why: v.revises_why ?? '' };
    else if (v.version > 1) out.revises = { version: v.version - 1, why: 'Amended' };
    return out;
  });
}

function workOf(w: RawWork, now: Date): Work {
  const owner = author(w.author_kind, w.created_by);
  const out: Work = {
    id: w.id, title: w.title, why: w.why, repo: w.repo, parts: w.parts ?? [], owner: w.owner_id, doer: w.doer, state: w.state,
    plan: stepsOf(w.plan, owner), may: strings(w.may), mayNot: strings(w.may_not), askWhen: strings(w.ask_when), accept: strings(w.accept),
    runs: [], // PASS3_BACKEND: no RunService, so no run is ever recorded or shown as running.
    prs: w.prs.map((p) => {
      const pr: PR = { id: p.id, num: p.num, title: p.title, state: p.state, branch: p.branch, by: p.created_by, checks: [], files: [], parts: [], ago: agoOf(p.updated_at, now) };
      if (p.step) pr.step = p.step;
      if (p.url) pr.url = p.url;
      return pr;
    }),
    context: objects(w.context) as unknown as Ref[],
    version: w.version,
    versions: w.versions.map((v) => {
      const pv: PlanVersion = { version: v.version, by: v.shaped_by ?? [], ago: agoOf(v.created_at, now), body: bodyOf(v.body, owner) };
      if (v.approved && v.approved_by) {
        pv.approved = { by: v.approved_by, ago: agoOf(v.approved_at, now), doer: v.approved.doer, scope: v.approved.scope };
        if (v.approved.includes?.length) pv.approved.includes = v.approved.includes;
      }
      return pv;
    }),
    exec: w.exec,
    log: w.log.map((l) => ({ who: author(l.author_kind, l.who), text: l.text, ago: agoOf(l.at, now) })),
    ago: agoOf(w.created_at, now),
  };
  if (w.decision_id) out.decision = decisionVersionId(w.decision_id, w.decision_version ?? 1);
  if (w.thread_id) out.thread = w.thread_id;
  if (w.authorized_by) out.authorized = { by: w.authorized_by, ago: agoOf(w.authorized_at, now), scope: w.authorized_scope ?? '' };
  const ask = w.scope.filter((s) => s.state === 'open').at(-1);
  if (ask) out.scopeAsk = { text: ask.text, adds: ask.adds, by: ask.asked_as };
  const q = w.questions.filter((x) => x.answer === null).at(-1) ?? w.questions.at(-1);
  if (q) {
    out.question = { id: q.id, text: q.text, about: q.about, for: q.for_user, options: q.options ?? [] };
    if (q.step) out.question.step = q.step;
    if (q.answer !== null) out.question.answer = { by: q.answered_by ?? '', text: q.answer };
    if (q.deferred) out.question.deferred = true;
  }
  // The latest suggestion set, unless an authorization since then settled it.
  const r = w.revision;
  if (r && !(w.authorized_at && Date.parse(w.authorized_at) >= Date.parse(r.created_at))) {
    const revision: Revision = {
      id: r.id, by: author(r.author_kind, r.created_by), why: r.why, base: r.base_version,
      changes: r.changes.map((c) => {
        const ch: Change = { id: c.id, kind: c.kind, state: c.state };
        if (c.step !== null) ch.step = c.step;
        if (c.text !== null) ch.text = c.text;
        if (c.after_set) ch.after = c.after;
        if (c.list) ch.list = c.list;
        if (c.title !== null) ch.title = c.title;
        if (c.note !== null) ch.note = c.note;
        if (c.seed && typeof c.seed === 'object') ch.seed = c.seed as Change['seed'];
        if (c.decided_by) ch.decidedBy = c.decided_by;
        return ch;
      }),
    };
    if (r.from_thread) revision.from = r.from_thread;
    out.revision = revision;
  }
  if (w.depends_on) out.dependsOn = w.depends_on;
  if (w.blocks) out.blocks = w.blocks;
  const f = w.findings.at(-1);
  if (f) {
    out.finding = { text: f.text, by: author(f.author_kind, f.created_by), ago: agoOf(f.created_at, now) };
    if (f.evidence?.length) out.finding.evidence = f.evidence;
    if (f.offer) out.finding.offer = f.offer;
  }
  if (w.resolved_by) out.resolved = { by: w.resolved_by, ago: agoOf(w.resolved_at, now) };
  if (w.verified_by) out.verifiedBy = w.verified_by;
  return out;
}

const DECIDE = new Set(['decision', 'amended', 'review', 'agreed', 'changes', 'signed']);
const WORK = new Set(['work', 'plan', 'authorized', 'scope', 'question', 'finding', 'resolved']);
const NEEDS = new Set(['review', 'changes', 'question', 'scope']);
const LIVE = new Set(['agreed', 'authorized', 'resolved']);
const VERB: Record<string, string> = {
  thread: 'started a thread', reply: 'replied', decision: 'drafted a decision', amended: 'amended', review: 'asked for signatures on',
  agreed: 'Agreed:', changes: 'requested changes to', signed: 'signed', work: 'started work on', plan: 'opened a new plan draft for',
  authorized: 'authorized', scope: 'asked about scope:', question: 'asked:', finding: 'found:', resolved: 'resolved',
};

function sinceOf(raw: RawVoweRecord, names: Map<string, string>): VoweRecord['since'] {
  if (!raw.seen_at) return undefined;
  const seen = Date.parse(raw.seen_at);
  const items: NonNullable<VoweRecord['since']>['items'] = [];
  for (const a of raw.activity) {
    if (Date.parse(a.created_at) <= seen || a.actor_id === raw.me || !a.subject_id || !VERB[a.kind]) continue;
    const tab: Notice['to']['tab'] = DECIDE.has(a.kind) ? 'decide' : WORK.has(a.kind) ? 'work' : 'discuss';
    const id = tab === 'decide' ? decisionVersionId(a.subject_id, a.version ?? 1) : a.subject_id;
    const who = a.kind === 'agreed' ? '' : `${(a.actor_id && names.get(a.actor_id)) || 'Someone'} `;
    const subject = (a.subject ?? '').length > 80 ? `${(a.subject ?? '').slice(0, 79)}…` : a.subject ?? '';
    items.push({ text: `${who}${VERB[a.kind]} ${subject}`.trim(), to: { tab, id }, tone: LIVE.has(a.kind) ? 'live' : NEEDS.has(a.kind) ? 'needs' : 'quiet' });
  }
  return items.length ? { lastHere: lastHereOf(raw.seen_at), items: items.slice(0, 20) } : undefined;
}

/** Real times for what the record shows (VoweRecord.times): the Desk reads `ago`, the Inbox reads these. */
export function timesOf(raw: RawVoweRecord): Record<string, string> {
  const at: Record<string, string> = {};
  const latest = (kind: string, subject: string, version?: number) => raw.activity
    .filter((a) => a.kind === kind && a.subject_id === subject && (version === undefined || a.version === version))
    .reduce<string | null>((m, a) => (m === null || Date.parse(a.created_at) > Date.parse(m) ? a.created_at : m), null);
  for (const t of raw.threads) {
    at[t.id] = t.created_at;
    at[`${t.id}:${t.id}`] = t.created_at;
    for (const c of t.replies) at[`${t.id}:${c.id}`] = c.created_at;
    if (t.resolved_at) at[`${t.id}:resolved`] = t.resolved_at;
  }
  for (const d of raw.decisions) {
    for (const v of d.versions) {
      const id = decisionVersionId(d.id, v.version);
      at[id] = v.created_at;
      const review = latest('review', d.id, v.version);
      if (review) at[`${id}:review`] = review;
      const signed = v.signatures.filter((x) => x.version === v.version);
      for (const x of signed) at[`${id}:signed:${x.user_id}`] = x.signed_at;
      const agreed = latest('agreed', d.id, v.version)
        ?? (v.state === 'agreed' || v.state === 'superseded' ? signed.map((x) => x.signed_at).sort().at(-1) ?? null : null);
      if (agreed) at[`${id}:agreed`] = agreed;
    }
  }
  for (const w of raw.work) {
    at[w.id] = w.created_at;
    const plan = w.versions.find((v) => v.version === w.version);
    if (plan) at[`${w.id}:plan`] = plan.created_at;
    const q = w.questions.filter((x) => x.answer === null).at(-1) ?? w.questions.at(-1);
    if (q) at[`${w.id}:question`] = q.created_at;
    if (w.revision) at[`${w.id}:revision`] = w.revision.created_at;
    const ask = w.scope.filter((x) => x.state === 'open').at(-1);
    if (ask) at[`${w.id}:scope`] = ask.created_at;
    if (w.authorized_at) at[`${w.id}:authorized`] = w.authorized_at;
    if (w.resolved_at) at[`${w.id}:resolved`] = w.resolved_at;
  }
  return at;
}

/** The activity log as the record carries it (VoweRecord.log), newest first. */
export function logOf(raw: RawVoweRecord): RecordEvent[] {
  return raw.activity
    .map((a) => ({ id: a.id, by: a.actor_id, kind: a.kind, text: a.subject ?? '', subject: a.subject_id, version: a.version, at: a.created_at }))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || (a.id < b.id ? -1 : 1));
}

export function toVoweRecord(raw: RawVoweRecord, opts: MapOptions = {}): VoweRecord {
  const now = opts.now ?? new Date();
  const names = new Map(raw.members.map((m) => [m.user_id, m.name || m.email || 'Someone']));
  const workByDecision = new Map<string, string[]>();
  for (const w of raw.work) if (w.decision_id) workByDecision.set(w.decision_id, [...(workByDecision.get(w.decision_id) ?? []), w.id]);
  const rec: VoweRecord = {
    threads: raw.threads.map((t) => threadOf(t, raw.me, raw.seen_at, now)),
    decisions: raw.decisions.flatMap((d) => decisionsOf(d, raw.members, workByDecision.get(d.id) ?? [], now)),
    work: raw.work.map((w) => workOf(w, now)),
    notices: [], // PASS3_BACKEND: no NotificationService; For you is derived in the renderer (state/attention.ts).
    call: false,
    members: raw.members.map((m) => (m.name || m.email ? { who: m.user_id, role: m.role, name: (m.name || m.email)! } : { who: m.user_id, role: m.role })),
    done: raw.done,
    vowe: raw.room.vowe,
    agentName: raw.room.agent_name || 'Vowe',
    agents: opts.agents ?? [],
    times: timesOf(raw),
    log: logOf(raw),
  };
  if (raw.me) rec.me = raw.me;
  if (raw.room.goal) rec.goal = { text: raw.room.goal, by: raw.room.created_by };
  const since = sinceOf(raw, names);
  if (since) rec.since = since;
  return rec;
}
