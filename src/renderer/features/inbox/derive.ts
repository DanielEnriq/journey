import { AGENT, type Decision, type RecordEvent, type RoomRole, type Thread, type VoweRecord } from '../vowe-room/contracts/model.js';
import { approvedOf, openChanges } from '../vowe-room/state/plan.js';
import { maySign, mayWrite } from '../vowe-room/state/permissions.js';
import type { PersonId } from '../vowe-room/journey.js';
import { UNREAD, type Anchor, type InboxEvent, type InboxItem, type InboxMarks, type InboxView, type Obligation, type Resolved, type SubjectKind } from './model.js';

// Builds the personal Inbox from Journey's real room records. Every rule is structural — who asked whom, who
// signed, who owns, who authorized, who took part — so every item can say exactly why it is yours. Nothing is
// placed by what a message says or by a model's judgement. Pure: no I/O, no clock but `now`.
//
//   Needs you   addressed to you and waiting on you; leaves only when the record shows it discharged.
//   Following   something you wrote, signed, own, authorized or chose to follow moved because of someone else.
//   Activity    everything else in your rooms from the activity log, one digest per room and subject.
//
// Sources Journey doesn't produce (agent runner progress, GitHub PR/CI) are never derived here.

export interface RoomInput {
  id: string;
  name: string;
  /** Your role in the room (RoomSummary.role); falls back to the record's membership. */
  role?: RoomRole | null;
  record: VoweRecord;
}

/** An email invitation waiting for you (Journey's IncomingInvitation). */
export interface InvitationInput { id: string; roomId: string; roomName: string; role: RoomRole; fromName: string; at: string }

export interface DeriveInput {
  me: PersonId;
  now: string;
  /** When you were last here before this session (the away summary); falls back to a day ago. */
  lastHere: string | null;
  rooms: RoomInput[];
  invitations: InvitationInput[];
  marks: InboxMarks;
  /** Done marks kept on the server (attention_done, `inbox:<key>`), merged with the local ones. */
  serverDone?: Iterable<string>;
  /** Display names, for `why` and headlines. Unknown ids render as "Someone". */
  nameOf(id: PersonId): string;
}

/** Following items older than this leave on their own; Activity looks back this far. */
export const FOLLOW_DAYS = 14;
export const ACTIVITY_DAYS = 7;
/** What you discharged within this window shows under Done. */
export const RESOLVED_HOURS = 24;
/** Away long enough for the "Since Friday" summary. */
export const AWAY_HOURS = 12;

const DAY = 86_400_000;
/** The coding agent's person id in the Inbox (records name agents by display name only). */
export const agentPerson = (name: string): PersonId => `agent:${name}`;
/** The inviter's person id (invitations carry a name, not an id). */
export const inviterPerson = (invitationId: string): PersonId => `invite:${invitationId}`;

/** The key a done mark is stored under: the item and its newest event, so something new brings it back. */
export const doneKey = (item: Pick<InboxItem, 'id' | 'at'>) => `${item.id}@${item.at}`;
/** attention_done ids the Inbox owns (the Desk's own For you marks never start with this). */
export const SERVER_DONE_PREFIX = 'inbox:';

const listNames = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const plain = (s: string) => s.replace(/\[([^|\]]+)\|[^\]]+\]/g, '$1').replace(/`/g, '').trim();
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const short = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const newest = (xs: (string | undefined | null)[]) => xs.filter((x): x is string => !!x).sort().at(-1) ?? null;
const byIso = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Which thread's place in the room an anchor lands on. */
function threadAnchor(roomId: string, r: VoweRecord, t: Thread): Anchor {
  const about = t.about;
  if (about.kind === 'line') {
    const d = r.decisions.find((x) => x.id === about.decision);
    return { roomId, tab: 'decide', inspect: { kind: 'decision', id: about.decision, line: about.id }, thread: t.id, parts: d?.parts.length ? d.parts : undefined, label: `Decide · ${d?.title ?? 'a decision'} · the line` };
  }
  if (about.kind === 'step') {
    const w = r.work.find((x) => x.id === about.work);
    return { roomId, tab: 'work', inspect: { kind: 'work', id: about.work, section: 'plan', thread: t.id }, thread: t.id, label: `Work · ${w?.title ?? 'a plan'} · the step` };
  }
  if (about.kind === 'pr' || about.kind === 'check') {
    const pr = about.kind === 'pr' ? about.id : about.pr;
    const w = r.work.find((x) => x.prs.some((p) => p.id === pr));
    if (w) return { roomId, tab: 'work', inspect: { kind: 'work', id: w.id, section: 'prs', pr }, thread: t.id, label: `Work · ${w.title} · pull requests` };
  }
  if (about.kind === 'decision') return { roomId, tab: 'decide', inspect: { kind: 'decision', id: about.id }, thread: t.id, label: `Decide · ${about.name}` };
  if (about.kind === 'work') return { roomId, tab: 'work', inspect: { kind: 'work', id: about.id, section: 'plan' }, thread: t.id, label: `Work · ${about.name}` };
  return { roomId, tab: 'discuss', thread: t.id, parts: about.kind === 'part' && about.id !== 'canvas' ? [about.id] : undefined, label: `Discuss · ${t.title ?? about.name}` };
}

const aboutWords = (r: VoweRecord, t: Thread) => {
  if (t.about.kind === 'line') { const id = t.about.decision; return `a line in “${r.decisions.find((d) => d.id === id)?.title ?? 'a decision'}”`; }
  return t.about.name || 'the room';
};

/** The decision family's earlier versions you signed. */
const signedFamily = (r: VoweRecord, d: Decision, me: PersonId) =>
  r.decisions.filter((o) => o.title === d.title && o.approvers.some((a) => a.who === me && a.signed === o.version));

interface Ctx {
  x: DeriveInput;
  room: RoomInput;
  r: VoweRecord;
  R: { id: string; name: string };
  role: RoomRole | null;
  when(key: string): string | null;
}

/* ---------------- Needs you ---------------- */

function needs(c: Ctx, out: InboxItem[], resolved: Resolved[]) {
  const { x, r, R, role } = c;
  const me = x.me;
  const nameOf = x.nameOf;
  const base = (id: string, obligation: Obligation, subject: { kind: SubjectKind; id: string; title: string }) =>
    ({ id, tier: 'needs' as const, obligation, source: 'record' as const, subject, room: R, unseen: 0 });

  for (const d of r.decisions) {
    const mine = d.approvers.find((a) => a.who === me);
    if (!mine || !maySign(role)) continue;
    const id = `sign:${R.id}:${d.id}:v${d.version}`;
    const anchor: Anchor = { roomId: R.id, tab: 'decide', inspect: { kind: 'decision', id: d.id }, parts: d.parts.length ? d.parts : undefined, label: `Decide · ${d.title}, v${d.version}` };
    const othersSigned = d.approvers.filter((a) => a.who !== me && a.signed === d.version);
    const asked = c.when(`${d.id}:review`) ?? c.when(d.id);
    if (d.state === 'review' && mine.signed !== d.version && !mine.changes) {
      const waitingWork = r.work.find((w) => w.decision === d.id && w.state !== 'resolved' && w.state !== 'closed');
      const challenged = d.lines.filter((l) => l.overturned).length;
      const events: InboxEvent[] = othersSigned
        .map((a) => ({ id: `${d.id}:signed:${a.who}`, at: c.when(`${d.id}:signed:${a.who}`) ?? asked ?? x.now, by: a.who, text: `${nameOf(a.who)} signed v${d.version}`, source: 'record' as const }))
        .sort((a, b) => byIso(b.at, a.at));
      const at = newest([asked, ...events.map((e) => e.at)]) ?? x.now;
      out.push({
        ...base(id, 'sign', { kind: 'decision', id: d.id, title: d.title }),
        path: [R.name, 'Decide', `Decision v${d.version}`], actor: d.by.who, headline: d.title,
        why: `${nameOf(d.by.who)} asked you to sign v${d.version}${othersSigned.length ? ` · ${listNames(othersSigned.map((a) => nameOf(a.who)))} signed` : ''}`,
        whyShort: `asked you to sign v${d.version}`,
        blocks: waitingWork ? `${waitingWork.title}: its plan can’t be authorized until this is agreed` : undefined,
        raised: challenged ? `${challenged} assumption${challenged > 1 ? 's are' : ' is'} challenged in this version` : undefined,
        at, waitingSince: asked ?? at, events, anchor,
      });
    } else if (mine.signed === d.version && (d.state === 'review' || d.state === 'agreed' || d.state === 'superseded')) {
      const signedAt = c.when(`${d.id}:signed:${me}`);
      if (signedAt) resolved.push(resolvedItem(c, {
        ...base(id, 'sign', { kind: 'decision', id: d.id, title: d.title }), path: [R.name, 'Decide', `Decision v${d.version}`], actor: d.by.who,
        headline: d.title, why: `You were asked to sign v${d.version}`, at: signedAt, waitingSince: asked ?? signedAt, events: [], anchor,
      }, `You signed v${d.version}`, signedAt));
    }
  }

  for (const t of r.threads) {
    if (t.waiting !== me || !t.replies.length) continue;
    const last = t.replies[t.replies.length - 1];
    const about = aboutWords(r, t);
    const anchor = threadAnchor(R.id, r, t);
    if (t.status === 'open' && last.by !== me) {
      const at = c.when(`${t.id}:${last.id}`) ?? c.when(t.id) ?? x.now;
      // Since the first message by someone else after your last word in it.
      const myLast = t.replies.map((p) => p.by).lastIndexOf(me);
      const firstWaiting = t.replies[myLast + 1] ?? last;
      const since = c.when(`${t.id}:${firstWaiting.id}`) ?? at;
      const work = t.about.kind === 'step' ? r.work.find((w) => w.id === (t.about as { work: string }).work)
        : t.about.kind === 'work' ? r.work.find((w) => w.id === t.about.id) : r.work.find((w) => w.thread === t.id);
      out.push({
        ...base(`answer:${R.id}:${t.id}:${t.replies.length}`, 'reply', { kind: 'thread', id: t.id, title: t.title ?? about }),
        path: [R.name, about], actor: last.by, headline: short(cap(plain(last.body).replace(/^@\S+\s*/, ''))) || 'A reply',
        excerpt: { by: last.by, text: plain(last.body) }, why: `${nameOf(last.by)} is waiting on your reply`,
        whyShort: 'waiting on your reply',
        blocks: work && (work.state === 'waiting' || work.state === 'running') ? `${work.title} is waiting on this` : undefined,
        at, waitingSince: since,
        events: t.replies.slice(myLast + 1).filter((p) => p.by !== me).map((p) => ({ id: `${t.id}:${p.id}`, at: c.when(`${t.id}:${p.id}`) ?? at, by: p.by, text: plain(p.body), source: 'record' as const })).reverse(),
        anchor,
      });
    } else if (last.by === me) {
      const at = c.when(`${t.id}:${last.id}`);
      const before = t.replies.length - 1;
      if (at && before > 0 && t.replies[before - 1].by !== me) resolved.push(resolvedItem(c, {
        ...base(`answer:${R.id}:${t.id}:${before}`, 'reply', { kind: 'thread', id: t.id, title: t.title ?? about }),
        path: [R.name, about], actor: t.replies[before - 1].by, headline: short(cap(plain(t.replies[before - 1].body))), why: 'It was waiting on your reply',
        at, events: [], anchor,
      }, 'You replied', at));
    }
  }

  for (const w of r.work) {
    const doer = w.doer?.kind === 'agent' ? agentPerson(w.doer.name) : w.owner;
    const doerName = w.doer?.name ?? nameOf(w.owner);
    const workAnchor = (section: 'plan' | 'run', label: string, parts?: string[]): Anchor => ({ roomId: R.id, tab: 'work', inspect: { kind: 'work', id: w.id, section }, parts, label: `Work · ${w.title}${label}` });
    const q = w.question;
    if (q && q.for === me && mayWrite(role)) {
      const step = q.step ? w.plan.findIndex((s) => s.id === q.step) + 1 : 0;
      const asked = c.when(`${w.id}:question`) ?? c.when(w.id) ?? x.now;
      const item: InboxItem = {
        ...base(`q:${R.id}:${w.id}:${q.id}`, 'answer', { kind: 'question', id: q.id, title: w.title }),
        path: [R.name, w.title, `Plan v${w.version}${step ? ` · step ${step}` : ''}`], actor: doer,
        headline: short(plain(q.text)), excerpt: { by: doer, text: plain(q.text) },
        why: `${doerName} stopped to ask you${w.authorized?.by === me ? ' · you authorized it' : w.owner === me ? ' · you own this plan' : ''}`,
        whyShort: 'stopped to ask you',
        blocks: step ? `Step ${step} is paused until you answer` : undefined,
        at: asked, waitingSince: asked, events: [],
        anchor: workAnchor('run', ' · the question', q.about ? [q.about] : undefined),
      };
      if (!q.answer && !q.deferred) out.push(item);
      else if (q.answer?.by === me) resolved.push(resolvedItem(c, item, 'You answered', asked));
    }
    const governs = w.owner === me || w.authorized?.by === me;
    if (w.scopeAsk && governs && maySign(role)) {
      const asked = c.when(`${w.id}:scope`) ?? x.now;
      out.push({
        ...base(`scope:${R.id}:${w.id}:${w.scopeAsk.adds}`, 'allow', { kind: 'plan', id: w.id, title: w.title }),
        path: [R.name, w.title], actor: agentPerson(w.scopeAsk.by), headline: short(plain(w.scopeAsk.text)),
        why: `${w.scopeAsk.by} hit the edge of what ${w.authorized?.by === me ? 'you authorized' : 'its plan allows'}`, whyShort: 'asks for more scope',
        blocks: `${w.title} can’t go past this until you decide`, at: asked, waitingSince: asked, events: [], anchor: workAnchor('run', ' · scope'),
      });
    }
    const oc = openChanges(w);
    if (oc.length && w.revision && w.revision.by !== me && w.owner === me && mayWrite(role)) {
      const at = c.when(`${w.id}:revision`) ?? x.now;
      out.push({
        ...base(`rv:${R.id}:${w.id}:${w.revision.id}`, 'review', { kind: 'plan', id: w.id, title: w.title }),
        path: [R.name, w.title, `Plan v${w.version} · suggested changes`], actor: w.revision.by,
        headline: `${oc.length} suggested change${oc.length > 1 ? 's' : ''} to the plan`, why: `${nameOf(w.revision.by)} suggested them; you own this plan`, whyShort: 'suggested changes to your plan',
        at, waitingSince: at,
        events: oc.map((ch) => ({ id: ch.id, at, by: w.revision!.by, text: ch.text ?? ch.title ?? ch.kind, source: 'record' as const })),
        anchor: workAnchor('plan', ' · plan'),
      });
    }
    // Ready to authorize: you own it, a doer is chosen, nothing is suggested, and its decision (if any) is agreed.
    if (w.owner === me && w.doer && !oc.length && maySign(role) && w.state !== 'resolved' && w.state !== 'closed') {
      const dec = w.decision ? r.decisions.find((d) => d.id === w.decision) : undefined;
      const ap = approvedOf(w);
      const ready = (w.state === 'proposed' && (!w.decision || dec?.state === 'agreed'))
        || (!!ap && ap.version !== w.version && w.log[w.log.length - 1]?.who !== AGENT && w.versions.some((v) => v.version === w.version));
      const item: InboxItem = {
        ...base(`au:${R.id}:${w.id}:v${w.version}`, 'authorize', { kind: 'plan', id: w.id, title: w.title }),
        path: [R.name, w.title, `Plan v${w.version}`], actor: w.doer.kind === 'agent' ? agentPerson(w.doer.name) : w.owner,
        headline: `${w.doer.name} is ready to run plan v${w.version}`,
        why: ap && ap.version !== w.version ? `You own this plan; ${w.doer.name} is still on v${ap.version}` : 'You own this plan; nothing runs until you authorize it',
        whyShort: 'ready for you to authorize',
        at: c.when(`${w.id}:plan`) ?? c.when(w.id) ?? x.now, waitingSince: c.when(`${w.id}:plan`) ?? c.when(w.id) ?? x.now, events: [],
        anchor: workAnchor('plan', ` · plan v${w.version}`),
      };
      if (ready) out.push(item);
    }
    if (w.authorized?.by === me && approvedOf(w)?.version === w.version) {
      const at = c.when(`${w.id}:authorized`);
      if (at && w.doer) resolved.push(resolvedItem(c, {
        ...base(`au:${R.id}:${w.id}:v${w.version}`, 'authorize', { kind: 'plan', id: w.id, title: w.title }), path: [R.name, w.title, `Plan v${w.version}`],
        actor: w.owner, headline: `${w.doer.name} is ready to run plan v${w.version}`, why: 'You own this plan', at, events: [], anchor: workAnchor('plan', ` · plan v${w.version}`),
      }, `You authorized plan v${w.version}`, at));
    }
  }
}
function resolvedItem(c: Ctx, item: InboxItem, how: string, at: string): Resolved {
  return { item: { ...item, unseen: 0 }, how, at };
}

/* ---------------- Following ---------------- */

function following(c: Ctx, out: InboxItem[], needsIds: Set<string>) {
  const { x, r, R } = c;
  const me = x.me, nameOf = x.nameOf;
  const fresh = (iso: string | null) => !!iso && Date.parse(x.now) - Date.parse(iso) <= FOLLOW_DAYS * DAY;
  const base = (id: string, subject: { kind: SubjectKind; id: string; title: string }) => ({ id, tier: 'following' as const, source: 'record' as const, subject, room: R });

  for (const t of r.threads) {
    if (t.status !== 'open' || !t.replies.length) continue;
    if (needsIds.has(t.id) || x.marks.follow[t.id] === false) continue;
    const myLast = t.replies.map((p) => p.by).lastIndexOf(me);
    const tookPart = myLast >= 0;
    const lineDecision = t.about.kind === 'line' ? r.decisions.find((d) => d.id === (t.about as { decision: string }).decision) : undefined;
    const signedLine = !!lineDecision && signedFamily(r, lineDecision, me).length > 0;
    const follows = x.marks.follow[t.id] === true;
    if (!tookPart && !signedLine && !follows) continue;
    // What others said since your last word in it (or all of it, when you follow it without having spoken).
    const moved = t.replies.slice(myLast + 1).filter((p) => p.by !== me);
    const last = moved[moved.length - 1];
    if (!last) continue;
    const at = c.when(`${t.id}:${last.id}`);
    if (!fresh(at)) continue;
    const about = aboutWords(r, t);
    const who = [...new Set(moved.map((p) => nameOf(p.by)))];
    out.push({
      ...base(`thread:${R.id}:${t.id}`, { kind: 'thread', id: t.id, title: t.title ?? about }),
      path: [R.name, about], actor: last.by,
      headline: signedLine && !tookPart ? `${who[0]} challenged a line you signed` : `${listNames(who)} replied ${t.replies[0].by === me ? 'to your thread' : 'in a thread you’re in'}`,
      excerpt: { by: last.by, text: plain(last.body) },
      why: signedLine ? 'It’s on a decision you signed' : t.replies[0].by === me ? 'You started it' : tookPart ? 'You took part' : 'You follow it',
      whyShort: signedLine ? 'on a decision you signed' : tookPart ? 'you took part' : 'you follow it',
      raised: signedLine ? 'Challenges a decision you signed' : undefined,
      at: at!, events: moved.map((p) => ({ id: `${t.id}:${p.id}`, at: c.when(`${t.id}:${p.id}`) ?? at!, by: p.by, text: plain(p.body), source: 'record' as const })).reverse(),
      unseen: moved.length, anchor: threadAnchor(R.id, r, t),
    });
  }

  for (const d of r.decisions) {
    const mine = d.approvers.find((a) => a.who === me);
    const signedEarlier = signedFamily(r, d, me).some((o) => o.version < d.version);
    if (!mine && !signedEarlier && x.marks.follow[d.id] !== true) continue;
    const anchor: Anchor = { roomId: R.id, tab: 'decide', inspect: { kind: 'decision', id: d.id }, parts: d.parts.length ? d.parts : undefined, label: `Decide · ${d.title}` };
    // Agreed by someone else's signature (yours wasn't the last one).
    if (d.state === 'agreed') {
      const at = c.when(`${d.id}:agreed`);
      const lastSigner = d.approvers.filter((a) => a.signed === d.version).sort((a, b) => byIso(c.when(`${d.id}:signed:${a.who}`) ?? '', c.when(`${d.id}:signed:${b.who}`) ?? '')).at(-1);
      if (fresh(at) && lastSigner && lastSigner.who !== me) {
        out.push({
          ...base(`agreed:${R.id}:${d.id}`, { kind: 'decision', id: d.id, title: d.title }), path: [R.name, 'Decide', `Decision v${d.version}`], actor: lastSigner.who,
          headline: `Agreed: ${d.title}`, why: mine?.signed === d.version ? 'You signed it; everyone asked has now signed' : 'You’re one of the people it asked',
          whyShort: 'agreed', at: at!,
          events: [{ id: `${d.id}:agreed`, at: at!, by: lastSigner.who, text: `v${d.version} agreed by ${listNames(d.approvers.filter((a) => a.signed === d.version).map((a) => (a.who === me ? 'you' : nameOf(a.who))))}`, source: 'record' }],
          unseen: 1, anchor,
        });
      }
    }
    // A line you signed, overturned by someone else.
    if (mine?.signed === d.version) {
      const over = d.lines.filter((l) => l.overturned && l.overturned.by !== me);
      if (over.length) {
        const at = c.when(`${d.id}:signed:${me}`) ?? c.when(d.id);
        if (at) out.push({
          ...base(`challenged:${R.id}:${d.id}:${over.map((l) => l.id).join(',')}`, { kind: 'decision', id: d.id, title: d.title }), path: [R.name, 'Decide', `Decision v${d.version}`],
          actor: over[0].overturned!.by, headline: `${nameOf(over[0].overturned!.by)} challenged ${over.length > 1 ? `${over.length} lines` : 'a line'} you signed`,
          excerpt: { by: over[0].overturned!.by, text: plain(over[0].overturned!.why) }, why: `You signed v${d.version}`, whyShort: 'a line you signed', raised: 'Challenges a decision you signed',
          at, events: over.map((l) => ({ id: `${d.id}:${l.id}`, at, by: l.overturned!.by, text: plain(l.overturned!.why), source: 'record' as const })), unseen: over.length,
          anchor: { ...anchor, inspect: { kind: 'decision', id: d.id, line: over[0].id }, label: `Decide · ${d.title} · the challenged line` },
        });
      }
    }
  }

  for (const w of r.work) {
    const authorizedByMe = w.authorized?.by === me;
    const oc = openChanges(w);
    const anchor: Anchor = { roomId: R.id, tab: 'work', inspect: { kind: 'work', id: w.id, section: 'plan' }, label: `Work · ${w.title} · plan` };
    if (oc.length && w.revision && w.revision.by !== me && w.owner !== me && (authorizedByMe || x.marks.follow[w.id] === true)) {
      const at = c.when(`${w.id}:revision`);
      if (fresh(at)) out.push({
        ...base(`rvf:${R.id}:${w.id}:${w.revision.id}`, { kind: 'plan', id: w.id, title: w.title }), path: [R.name, w.title, `Plan v${w.version} · suggested changes`],
        actor: w.revision.by, headline: `${nameOf(w.revision.by)} suggested ${oc.length} change${oc.length > 1 ? 's' : ''} to ${w.title}`,
        why: authorizedByMe ? `You authorized v${approvedOf(w)?.version ?? w.version}; changing it needs authorizing again` : 'You follow this plan', whyShort: authorizedByMe ? 'a plan you authorized' : 'you follow it',
        raised: authorizedByMe ? 'Changes a plan you authorized' : undefined,
        at: at!, events: oc.map((ch) => ({ id: ch.id, at: at!, by: w.revision!.by, text: ch.text ?? ch.title ?? ch.kind, source: 'record' as const })), unseen: oc.length, anchor,
      });
    }
    if (w.resolved && w.resolved.by !== me && (w.owner === me || authorizedByMe)) {
      const at = c.when(`${w.id}:resolved`);
      if (fresh(at)) out.push({
        ...base(`resolved:${R.id}:${w.id}`, { kind: 'plan', id: w.id, title: w.title }), path: [R.name, w.title], actor: w.resolved.by,
        headline: `${nameOf(w.resolved.by)} resolved ${w.title}`, why: w.owner === me ? 'You own this work' : 'You authorized it', whyShort: w.owner === me ? 'your work' : 'you authorized it',
        at: at!, events: [{ id: `${w.id}:resolved`, at: at!, by: w.resolved.by, text: `Resolved ${w.title}`, source: 'record' }], unseen: 1,
        anchor: { roomId: R.id, tab: 'work', inspect: { kind: 'work', id: w.id, section: 'outcome' }, label: `Work · ${w.title} · outcome` },
      });
    }
  }
}

/* ---------------- Activity ---------------- */

const DECIDE_KINDS = new Set(['decision', 'amended', 'review', 'agreed', 'changes', 'signed']);
const WORK_KINDS = new Set(['work', 'plan', 'authorized', 'scope', 'question', 'finding', 'resolved']);
const THREAD_KINDS = new Set(['thread', 'reply']);
/** What each kind of event adds up to in a digest ("3 replies"). */
const DIGEST: Record<string, [string, string]> = {
  thread: ['thread started', 'threads started'], reply: ['reply', 'replies'], decision: ['draft', 'drafts'], amended: ['new version', 'new versions'],
  review: ['signature request', 'signature requests'], signed: ['signature', 'signatures'], agreed: ['agreed', 'agreed'], changes: ['change request', 'change requests'],
  work: ['new work', 'new work'], plan: ['plan version', 'plan versions'], authorized: ['authorization', 'authorizations'], scope: ['scope change', 'scope changes'],
  question: ['question', 'questions'], finding: ['finding', 'findings'], resolved: ['resolved', 'resolved'],
  joined: ['joined', 'joined'], left: ['left', 'left'], removed: ['removed', 'removed'], role: ['role change', 'role changes'], repository: ['repository change', 'repository changes'],
  'call-started': ['call', 'calls'], 'call-left': ['left a call', 'left a call'],
  // A sentence already written in full; shown verbatim, about the room.
  note: ['update', 'updates'],
};
const VERB: Record<string, string> = {
  thread: 'started a thread:', reply: 'replied:', decision: 'drafted a decision:', amended: 'amended', review: 'asked for signatures on', agreed: 'Agreed:',
  changes: 'requested changes to', signed: 'signed', work: 'started work on', plan: 'wrote a new plan version for', authorized: 'authorized', scope: 'scope:',
  question: 'asked:', finding: 'found:', resolved: 'resolved', joined: 'joined the room', left: 'left the room', removed: 'removed someone', role: 'changed a role',
  repository: 'changed the repository', 'call-started': 'started a call', 'call-left': 'left the call',
};

function subjectOf(r: VoweRecord, roomId: string, roomName: string, e: RecordEvent): { kind: SubjectKind; id: string; title: string; anchor: Anchor } {
  if (THREAD_KINDS.has(e.kind) && e.subject) {
    const t = r.threads.find((x) => x.id === e.subject);
    const title = t ? t.title ?? aboutWords(r, t) : short(plain(e.text), 60);
    return { kind: 'thread', id: e.subject, title, anchor: t ? threadAnchor(roomId, r, t) : { roomId, tab: 'discuss', thread: e.subject, label: `Discuss · ${title}` } };
  }
  if (DECIDE_KINDS.has(e.kind) && e.subject) {
    // The newest version the record still holds of this database decision.
    const versions = r.decisions.filter((d) => d.id === e.subject || d.id.startsWith(`${e.subject}.v`)).sort((a, b) => b.version - a.version);
    const d = versions[0];
    const title = d?.title ?? e.text;
    return { kind: 'decision', id: e.subject, title, anchor: { roomId, tab: 'decide', ...(d ? { inspect: { kind: 'decision' as const, id: d.id } } : {}), parts: d?.parts.length ? d.parts : undefined, label: `Decide · ${title}` } };
  }
  if (WORK_KINDS.has(e.kind) && e.subject) {
    const w = r.work.find((x) => x.id === e.subject);
    const title = w?.title ?? e.text;
    return { kind: 'plan', id: e.subject, title, anchor: w ? { roomId, tab: 'work', inspect: { kind: 'work', id: w.id, section: 'plan' }, label: `Work · ${title}` } : { roomId, tab: 'work', label: `Work · ${title}` } };
  }
  return { kind: 'room', id: roomId, title: roomName, anchor: { roomId, tab: 'discuss', label: `Open ${roomName}` } };
}

function activity(c: Ctx, out: InboxItem[], taken: Set<string>) {
  const { x, r, R } = c;
  if (x.marks.mutedRooms.includes(R.id)) return;
  const groups = new Map<string, { s: ReturnType<typeof subjectOf>; evs: RecordEvent[] }>();
  for (const e of r.log ?? []) {
    if (e.by === x.me || !DIGEST[e.kind]) continue;
    if (Date.parse(x.now) - Date.parse(e.at) > ACTIVITY_DAYS * DAY) continue;
    const s = subjectOf(r, R.id, R.name, e);
    if (taken.has(`${s.kind}:${s.id}`)) continue;
    const k = `${s.kind}:${s.id}`;
    const g = groups.get(k);
    if (g) g.evs.push(e); else groups.set(k, { s, evs: [e] });
  }
  for (const [k, { s, evs }] of groups) {
    const sorted = [...evs].sort((a, b) => byIso(b.at, a.at) || (a.id < b.id ? -1 : 1));
    const top = sorted[0];
    const counts = new Map<string, number>();
    for (const e of sorted) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
    const who = top.by ? x.nameOf(top.by) : '';
    const text = (e: RecordEvent) => {
      const by = e.by ? `${x.nameOf(e.by)} ` : '';
      if (e.kind === 'note') return short(plain(e.text), 120);
      return e.kind === 'agreed' ? `Agreed: ${e.text}` : `${by}${VERB[e.kind]}${e.text && !['joined', 'left', 'removed', 'role', 'repository', 'call-started', 'call-left'].includes(e.kind) ? ` ${short(plain(e.text), 80)}` : ''}`.trim();
    };
    out.push({
      id: `act:${R.id}:${k}`, tier: 'activity', source: 'record', subject: { kind: s.kind, id: s.id, title: s.title }, room: R,
      path: s.kind === 'room' ? [R.name] : [R.name, s.title], actor: top.by,
      headline: sorted.length === 1 ? text(top) : `${s.kind === 'room' ? R.name : s.title}: ${[...counts].map(([kind, n]) => `${n} ${DIGEST[kind][n === 1 ? 0 : 1]}`).join(', ')}`,
      why: `In ${R.name}`, whyShort: who ? `${who} and others` : undefined,
      at: top.at, events: sorted.map((e) => ({ id: e.id, at: e.at, by: e.by, text: text(e), source: 'record' as const })),
      unseen: sorted.filter((e) => e.at > (x.lastHere ?? '')).length,
      digest: [...counts].map(([kind, n]) => ({ label: DIGEST[kind][n === 1 ? 0 : 1], n })),
      anchor: s.anchor,
    });
  }
}

/* ---------------- The view ---------------- */

const roleOf = (room: RoomInput, me: PersonId): RoomRole | null => room.role ?? room.record.members.find((m) => m.who === me)?.role ?? null;

export function derive(x: DeriveInput): InboxView {
  const items: InboxItem[] = [];
  const resolved: Resolved[] = [];
  const lastHere = x.lastHere ?? new Date(Date.parse(x.now) - DAY).toISOString();
  const input = { ...x, lastHere };

  for (const room of [...x.rooms].sort((a, b) => byIso(a.id, b.id))) {
    const r = room.record;
    const times = r.times ?? {};
    const c: Ctx = { x: input, room, r, R: { id: room.id, name: room.name }, role: roleOf(room, x.me), when: (k) => times[k] ?? null };
    const needed: InboxItem[] = [];
    needs(c, needed, resolved);
    const needsIds = new Set(needed.filter((i) => i.subject.kind === 'thread').map((i) => i.subject.id));
    const followed: InboxItem[] = [];
    following(c, followed, needsIds);
    // Activity is what's left: a subject already in Needs you or Following isn't repeated there.
    const taken = new Set<string>();
    for (const i of [...needed, ...followed]) {
      taken.add(`${i.subject.kind}:${i.subject.id}`);
      if (i.subject.kind === 'question') taken.add(`plan:${i.anchor.inspect?.id ?? ''}`);
      // Decisions in the log are named by their database id (the record's version-1 id, before any '.v').
      if (i.subject.kind === 'decision') taken.add(`decision:${i.subject.id.split('.v')[0]}`);
    }
    activity(c, followed, taken);
    items.push(...needed, ...followed);
  }

  for (const inv of x.invitations) {
    const from = inviterPerson(inv.id);
    items.push({
      id: `inv:${inv.id}`, tier: 'needs', obligation: 'accept', source: 'access', subject: { kind: 'invitation', id: inv.id, title: inv.roomName },
      room: { id: inv.roomId, name: inv.roomName }, path: [inv.roomName, `as ${inv.role}`], actor: from,
      headline: `${inv.fromName} invited you to ${inv.roomName}`, why: `An invitation to join as ${inv.role}`, whyShort: `invited you as ${inv.role}`,
      at: inv.at, waitingSince: inv.at, events: [], unseen: 0, anchor: { roomId: inv.roomId, tab: 'discuss', label: `Open ${inv.roomName}` },
    });
  }

  /* Your marks: seen, done, snoozed. */
  const done = new Set<string>([...Object.keys(x.marks.done)]);
  for (const id of x.serverDone ?? []) if (id.startsWith(SERVER_DONE_PREFIX)) done.add(id.slice(SERVER_DONE_PREFIX.length));
  const visible: InboxItem[] = [];
  const snoozed: InboxItem[] = [];
  for (const it of items) {
    const seen = x.marks.seen[it.id];
    // Needs you is unread until you've looked at it once; the rest count the events since you last looked.
    const unseen = seen === UNREAD ? Math.max(1, it.tier === 'needs' ? 1 : it.unseen)
      : it.tier === 'needs' ? (seen === undefined ? 1 : 0) : seen === undefined ? it.unseen : Math.max(0, it.events.length - seen);
    const item = { ...it, unseen };
    const sn = x.marks.snoozed[it.id];
    if (sn && sn.until > x.now) { snoozed.push(item); continue; }
    // Needs you is never marked done: it leaves when the record shows it discharged.
    if (it.tier !== 'needs' && done.has(doneKey(it))) continue;
    visible.push(item);
  }
  const tie = (a: InboxItem, b: InboxItem) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const needsList = visible.filter((i) => i.tier === 'needs')
    .sort((a, b) => (!!b.blocks === !!a.blocks ? 0 : a.blocks ? -1 : 1) || byIso(a.waitingSince ?? a.at, b.waitingSince ?? b.at) || tie(a, b));
  const followingList = visible.filter((i) => i.tier === 'following')
    .sort((a, b) => (!!b.raised === !!a.raised ? 0 : a.raised ? -1 : 1) || byIso(b.at, a.at) || tie(a, b));
  const activityList = visible.filter((i) => i.tier === 'activity').sort((a, b) => byIso(b.at, a.at) || tie(a, b));
  snoozed.sort((a, b) => byIso(x.marks.snoozed[a.id].until, x.marks.snoozed[b.id].until) || tie(a, b));

  const since = Date.parse(x.now) - RESOLVED_HOURS * 3_600_000;
  const resolvedList = resolved.filter((r) => Date.parse(r.at) >= since).sort((a, b) => byIso(b.at, a.at) || tie(a.item, b.item));

  const awayHours = x.lastHere ? (Date.parse(x.now) - Date.parse(x.lastHere)) / 3_600_000 : 0;
  const moved = followingList.filter((f) => f.subject.kind === 'thread').length;
  const agreed = followingList.filter((f) => f.id.startsWith('agreed:')).length;
  const away = x.lastHere && awayHours >= AWAY_HOURS ? {
    since: x.lastHere,
    label: awayLabel(x.lastHere, x.now),
    summary: [
      needsList.length ? `${needsList.length} ${needsList.length === 1 ? 'thing needs' : 'things need'} you` : 'nothing needs you',
      moved ? `${moved} conversation${moved > 1 ? 's' : ''} moved` : '',
      agreed ? `${agreed} decision${agreed > 1 ? 's' : ''} agreed` : '',
    ].filter(Boolean).join(' · '),
  } : null;
  return { needs: needsList, following: followingList, activity: activityList, resolved: resolvedList, snoozed, away };
}

/** "Since Friday 6:10 pm" (or "Since yesterday 9:00 am"), in the machine's own time zone. */
export function awayLabel(lastHere: string, now: string): string {
  const d = new Date(lastHere);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase();
  const days = Math.round((Date.parse(new Date(now).toDateString()) - Date.parse(d.toDateString())) / DAY);
  const day = days === 1 ? 'yesterday' : days < 7 ? d.toLocaleDateString('en-US', { weekday: 'long' }) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `Since ${day} ${time}`;
}

/* ---------------- time, as the Inbox says it ---------------- */

export function ago(iso: string, now: string): string {
  const m = Math.round((Date.parse(now) - Date.parse(iso)) / 60_000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 12) return `${h}h`;
  const day = new Date(iso), today = new Date(now);
  const days = Math.floor((Date.parse(today.toDateString()) - Date.parse(day.toDateString())) / DAY);
  if (days === 0) return day.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase();
  if (days === 1) return 'Yesterday';
  if (days < 7) return day.toLocaleDateString('en-US', { weekday: 'short' });
  return day.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** "waiting 41m", "since Sat". */
export function waiting(iso: string, now: string): string {
  const a = ago(iso, now);
  return /^\d/.test(a) ? `waiting ${a}` : `since ${a}`;
}
