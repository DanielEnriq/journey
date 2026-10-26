import { h, Fragment, useState, Avatar } from '../journey.js';
import { useEvidence } from '../state/semantics.js';
import { BasisGlyph } from '../canvas/faces.js';
import { AGENT, type RoomRole, type About, type Decision, type Notice, type PR, type Reply, type VoweRecord, type Thread, type Work } from '../contracts/model.js';
import type { Inspect, Tab } from '../state/ui.js';
import { actionable, attention, isSuggestion, tabMark, type Attn } from '../state/attention.js';
import type { PlanOp } from '../state/plan.js';
import type { Step as PStep } from '../contracts/model.js';
import { ObjectiveCard, WorkView, objectiveState } from './Work.js';
import { DecisionDoc } from './DecisionDoc.js';

import type { Depth } from '../state/ui.js';
import { useNames, type Names } from '../state/directory.js';
import type { Capabilities } from '../contracts/services.js';
import { mayWrite } from '../state/permissions.js';

// The Desk, Direction A: Journey's "Where we are" column with three surfaces, Discuss, Decide and Work.
// Each is a human surface first (threads, decisions, work items people own) that Vowe takes part in.
// Cards keep Journey's stacked, threaded language. The column can widen into an inspector for the
// heavy moments (a decision's detail, a plan's edits, a PR's checks) and collapse to nothing.

export interface DeskAct {
  tab(t: Tab): void;
  inspect(i: Inspect): void;
  wide(on: boolean): void;
  light(parts: string[] | null): void;
  thread(id: string | null): void;
  reply(thread: string, body: string): void;
  offer(thread: string, reply: string, accept: boolean): void;
  newThread(body: string): void;
  sign(decision: string): void;
  askReview(decision: string): void;
  takeEdit(decision: string, line: string, accept: boolean): void;
  lineThread(decision: string, line: string): void;
  dismissSuggested(decision: string): void;
  restoreDecision(decision: string): void;
  prepareWork(decision: string): void;
  editStep(work: string, step: string, text: string): void;
  chooseDoer(work: string, doer: Work['doer']): void;
  authorize(work: string): void;
  allowScope(work: string, allow: boolean): void;
  answer(work: string, text: string): void;
  defer(work: string): void;
  discussQuestion(work: string): void;
  takeFinding(work: string): void;
  resolve(work: string): void;
  notice(n: Notice | Attn): void;
  plan(work: string, op: PlanOp): void;
  removeStep(work: string, step: PStep, index: number): void;
  decide(work: string, change: string, accept: boolean): void;
  decideAll(work: string, accept: boolean): void;
  passage(work: string, step: string, quote: string, thread: string | null, close?: boolean): void;
  comment(work: string, step: string, quote: string, body: string): void;
  discussCheck(work: string, pr: string, check: string): void;
  /** A short confirmation (copied, undone). Never used to stand in for a missing capability. */
  toast(text: string): void;
  /** Journey's membership dialog (ShareDialog), titled Invite. */
  invite(): void;
  /** Open an https link outside the app (Electron routes https window opens to the system browser). */
  openExternal(url: string): void;
  requestChanges(decision: string, text: string): void;
  amend(decision: string): void;
  editLine(decision: string, line: string, text: string): void;
  newDecision(title: string, line: string): void;
  askFor(decision: string, who: string[]): void;
  everywhere(on: boolean): void;
  editDoc(decision: string, field: 'problem' | 'rationale', text: string): void;
  compare(v: number | null): void;
  depth(d: Depth): void;
  newWork(title: string, objective: string): void;
  draftFrom(thread: string): void;
  fsec(sec: 'foryou' | Tab): void;
  markDone(ids: string[]): void;
  askFix(work: string, pr: string, check: string): void;
  stopRun(work: string): void;
  focusAll(): void;
  sinceShow(): void;
  sinceFold(): void;
}

export interface DeskProps {
  rec: VoweRecord;
  me: string;
  tab: Tab;
  inspect: Inspect;
  openThread: string | null;
  focus: { id: string; name: string } | null;
  focusOn: boolean;
  hereLine: string;
  flash: string | null;
  noticesOpen: boolean;
  sinceOpen: boolean;
  act: DeskAct;
  /** Your role in this room (Journey's RoomRole). */
  role: RoomRole;
  /** What the services can truthfully do (runs, PR sync, notifications). */
  caps: Capabilities;
  /** The widened Desk is narrow enough that its two columns stack. */
  narrow: boolean;
  everywhere: boolean;
  depth: Depth;
  compare: number | null;
  /** Full screen: the section in the rail, and whether we're inside the full-screen workspace. */
  fsec: 'foryou' | Tab;
  shell?: boolean;
}

/* ---------------- shared pieces ---------------- */

const ABOUT_WORD: Record<About['kind'], string> = { part: '', edge: 'wire', scenario: 'failure', decision: 'decision', line: 'decision line', work: 'work', step: 'plan step', pr: 'PR', check: 'check' };
export function AboutGlyph({ a }: { a: About['kind'] }) {
  const d: Record<About['kind'], h.JSX.Element> = {
    part: <rect x="2.5" y="3.5" width="11" height="9" rx="2.2" />,
    edge: <path d="M2 8h12M10 5l3 3-3 3" />,
    scenario: <><path d="M8 2.5l6 11H2z" /><path d="M8 7v3" /></>,
    decision: <path d="M3.5 3.5h9v9h-9zM5.5 8l2 2 3-4" />,
    line: <path d="M3 5h10M3 8h10M3 11h6" />,
    work: <><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3l2 1.5" /></>,
    step: <path d="M3 4.5h2M7 4.5h6M3 8h2M7 8h6M3 11.5h2M7 11.5h6" />,
    pr: <><circle cx="4.5" cy="4" r="1.6" /><circle cx="4.5" cy="12" r="1.6" /><circle cx="11.5" cy="12" r="1.6" /><path d="M4.5 5.6v4.8M11.5 10.4V7.5c0-1.5-1-2.5-2.5-2.5H7" /></>,
    check: <><circle cx="8" cy="8" r="5.5" /><path d="M5.5 8l2 2 3-4" /></>,
  };
  return <svg class="nx-ag" width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">{d[a]}</svg>;
}

export function Who({ id, size = 18 }: { id: string; size?: 16 | 18 | 20 }) {
  const { person } = useNames();
  return <Avatar person={person(id)} size={size} />;
}
export function Evidence({ ids }: { ids?: string[] }) {
  const ev = useEvidence();
  if (!ids?.length) return null;
  return <span class="nx-evrow">{ids.map((id) => { const e = ev(id); return e ? <span key={id} class="nx-evchip" title={`${e.label} · ${e.ref}`}><BasisGlyph b={e.basis} />{id}</span> : null; })}</span>;
}
export function Words({ text, light }: { text: string; light(p: string[] | null): void }) {
  const out: (string | h.JSX.Element)[] = [];
  const re = /\[([^|\]]+)\|([^\]]+)\]/g;
  let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push(text.slice(last, m.index));
    const id = m[2];
    out.push(<span key={m.index} class="nx-ref" onPointerEnter={() => light([id])} onPointerLeave={() => light(null)}>{m[1]}</span>);
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return <>{out}</>;
}

export const DEC_STATE: Record<Decision['state'], string> = { suggested: 'Suggested', draft: 'Draft', review: 'In review', agreed: 'Agreed', superseded: 'Superseded', dismissed: 'Dismissed' };
const WORK_STATE: Record<Work['state'], string> = { draft: 'Draft plan', proposed: 'Proposed', authorized: 'Authorized', running: 'Running', waiting: 'Waiting on you', review: 'In review', resolved: 'Resolved', closed: 'Closed' };
export const PR_STATE: Record<PR['state'], string> = { draft: 'Draft', open: 'Open', review: 'Review requested', changes: 'Changes requested', merged: 'Merged', closed: 'Closed' };

/** What a thread is about, as the parts it touches on the canvas. */
export function partsOf(a: About, rec: VoweRecord): string[] {
  if (a.kind === 'part') return [a.id];
  if (a.kind === 'edge') return a.id.split('--').filter((_, i) => i !== 1);
  if (a.kind === 'decision' || a.kind === 'line') return rec.decisions.find((d) => d.id === (a.kind === 'line' ? a.decision : a.id))?.parts ?? [];
  if (a.kind === 'work' || a.kind === 'step') return rec.work.find((w) => w.id === (a.kind === 'step' ? a.work : a.id))?.parts ?? [];
  if (a.kind === 'pr' || a.kind === 'check') return rec.work.flatMap((w) => w.prs).find((p) => p.id === (a.kind === 'check' ? a.pr : a.id))?.parts ?? [];
  return [];
}
export const needsMe = (rec: VoweRecord, names: Names) => {
  const items = attention(rec, names).filter(actionable);
  return { discuss: items.some((x) => x.tab === 'discuss'), decide: items.some((x) => x.tab === 'decide'), work: items.some((x) => x.tab === 'work') };
};

/* ---------------- the Desk ---------------- */

export function Desk(p: DeskProps) {
  const { rec, tab, act } = p;
  const names = useNames();
  const counts = {
    discuss: rec.threads.filter((t) => t.status === 'open').length,
    decide: rec.decisions.filter((d) => d.state !== 'dismissed' && d.state !== 'superseded').length,
    work: rec.work.filter((w) => w.state !== 'closed' && w.state !== 'resolved').length,
  };
  const items = attention(rec, names);
  if (p.depth === 'focus') return <FullScreen {...p} />;
  if (p.inspect) return <Inspector {...p} />;
  return (
    <div class="rp-panel nx-desk2" aria-label="Where the room is">
      <div class="rp-rhead">
        <span class="rp-eyebrow">Where we are</span>
        <span class="rp-sub">{p.hereLine}</span>
      </div>
      <div class="nx-tabs2" role="tablist" aria-label="Desk">
        {(['discuss', 'decide', 'work'] as Tab[]).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} class={'nx-tab2' + (tab === t ? ' on' : '')} onClick={() => act.tab(t)}>
            {{ discuss: 'Discuss', decide: 'Decide', work: 'Work' }[t]}
            {counts[t] ? <span class="nx-tabn">{counts[t]}</span> : null}
            {tabMark(items, t) === 'needs' ? <i class="nx-tabdot" aria-label="something here needs you"></i> : tabMark(items, t) === 'new' ? <i class="nx-tabring" aria-label="something new to look at"></i> : null}
          </button>
        ))}
      </div>

      <SinceLine items={items} p={p} />
      {p.focus && p.focusOn ? (
        <div class="nx-focus"><span class="nx-focus-dot"></span><span>Showing what’s about <b>{p.focus.name}</b></span><button type="button" onClick={act.focusAll}>Show all</button></div>
      ) : null}

      {tab === 'discuss' ? <DiscussTab {...p} /> : tab === 'decide' ? <DecideTab {...p} /> : <WorkTab {...p} />}
    </div>
  );
}

const KIND_WORD = { respond: 'Answer', approve: 'Approve', review: 'Review', info: 'FYI' };

/** Coming back: one line for what changed while you were away. The details are in For you (full screen). */
function SinceLine({ items, p }: { items: Attn[]; p: DeskProps }) {
  const info = items.filter((x) => x.kind === 'info');
  if (!info.length) return null;
  return (
    <div class="nx-sinceline" role="status">
      <span><b>{p.rec.since ? `Since ${p.rec.since.lastHere.split(',')[0]}` : 'While you were away'}</b> · {info.length} change{info.length > 1 ? 's' : ''}: {info[0].text}{info.length > 1 ? '…' : ''}</span>
      <button type="button" class="nx-textbtn" onClick={() => { p.act.depth('focus'); p.act.fsec('foryou'); }}>See all</button>
      <button type="button" class="nx-textbtn" onClick={p.act.sinceShow}>On the canvas</button>
      <button type="button" class="nx-x2" aria-label="Dismiss" title="Dismiss" onClick={() => p.act.markDone(info.map((x) => x.id))}>×</button>
    </div>
  );
}

/** What in this tab needs you, at the top of the tab: same rows as For you, only this surface's items. */
function NeedsYou({ p, tab }: { p: DeskProps; tab: Tab }) {
  const names = useNames();
  const items = attention(p.rec, names).filter((x) => x.tab === tab && x.kind !== 'info' && !isSuggestion(x));
  if (!items.length) return null;
  return (
    <div class={'nx-foryou nx-needs' + (items.some(actionable) ? ' urgent' : '')} aria-label="Needs you">
      <span class="nx-fy-h">{items.some(actionable) ? 'Needs you' : 'To look at'}</span>
      {items.map((n) => (
        <div key={n.id} class={'nx-fy ' + n.kind}>
          <span class="nx-fy-k">{KIND_WORD[n.kind]}</span>
          <span class="nx-fy-t">{n.text}{n.where ? <span class="nx-fy-w"> · on {n.where}</span> : null}</span>
          <span class="nx-fy-why">{n.why}</span>
          <button type="button" class={'nx-btn' + (actionable(n) ? ' primary' : '')} onClick={() => p.act.notice(n)}>{n.cta ?? 'Open'}</button>
        </div>
      ))}
    </div>
  );
}

/** Decide's Suggested group: things someone (often the agent) thinks should be decided or edited. Act on them
 *  here; nothing becomes a decision until a person drafts and others sign it. */
function Suggested({ p }: { p: DeskProps }) {
  const { nameOf, agentName } = useNames();
  const { rec, act, me } = p;
  const offers = rec.threads.flatMap((t) => t.replies.filter((r) => r.offer?.state === 'open' && (r.offer.kind === 'decision' || r.offer.kind === 'revision')).map((r) => ({ t, r })));
  const sugg = rec.decisions.filter((d) => d.state === 'suggested');
  const edits = rec.decisions.filter((d) => d.state !== 'superseded').flatMap((d) => d.lines.filter((l) => l.suggest).map((l) => ({ d, l })));
  if (!offers.length && !sugg.length && !edits.length) return null;
  const seen = (id: string) => rec.done.includes(id);
  return (
    <div class="nx-sugg2" aria-label="Suggested">
      <span class="nx-fy-h">Suggested<em>{offers.length + sugg.length + edits.length}</em></span>
      {offers.map(({ t, r }) => (
        <div key={r.id} class={'nx-sg2' + (seen(`o:${t.id}:${r.id}`) ? '' : ' unread')}>
          <span class="nx-by agent"><i class="nx-agentmark"></i>{nameOf(r.by)} · from the {t.about.name} conversation</span>
          <span class="nx-sg2-t">{r.offer!.text}</span>
          <span class="nx-actrow">
            <button type="button" class="nx-btn primary" onClick={() => act.offer(t.id, r.id, true)}>{r.offer!.kind === 'revision' ? 'Draft v2' : 'Draft the decision'}</button>
            <button type="button" class="nx-textbtn" onClick={() => { act.tab('discuss'); act.thread(t.id); }}>See the conversation</button>
            <button type="button" class="nx-textbtn" onClick={() => act.offer(t.id, r.id, false)}>Not now</button>
          </span>
        </div>
      ))}
      {sugg.map((d) => (
        <div key={d.id} class={'nx-sg2' + (seen(`ds:${d.id}`) ? '' : ' unread')}>
          <span class="nx-by agent"><i class="nx-agentmark"></i>{agentName()} thinks there’s a decision here</span>
          <span class="nx-sg2-t">{d.title}</span>
          <span class="nx-actrow"><button type="button" class="nx-btn primary" onClick={() => act.askReview(d.id)}>Write it up</button><button type="button" class="nx-textbtn" onClick={() => act.dismissSuggested(d.id)}>Dismiss</button></span>
        </div>
      ))}
      {edits.map(({ d, l }) => (
        <div key={l.id} class={'nx-sg2' + (seen(`ls:${d.id}:${l.id}`) ? '' : ' unread')}>
          <span class={'nx-by' + (l.suggest!.by === AGENT ? ' agent' : '')}>{l.suggest!.by === AGENT ? <i class="nx-agentmark"></i> : null}{nameOf(l.suggest!.by)} suggests an edit to {d.title.length > 40 ? d.title.slice(0, 38) + '…' : d.title} v{d.version}</span>
          <span class="nx-sg2-t"><del>{l.text}</del> <ins>{l.suggest!.text}</ins></span>
          <span class="nx-actrow"><button type="button" class="nx-btn primary" onClick={() => act.lineThread(d.id, l.id)}>Review the edit</button>{d.by.who === me || d.approvers.some((a) => a.who === me) ? null : null}</span>
        </div>
      ))}
    </div>
  );
}
/* ---------------- Full screen: every surface, navigable ---------------- */

const SEC_LABEL = { foryou: 'For you', discuss: 'Discuss', decide: 'Decide', work: 'Work' } as const;

/** The full-screen workspace: a section rail (For you, Discuss, Decide, Work), the section's list, and the open
 *  item. The same objects as the compact Desk, with room to read and write. ⌥1–4 switch sections. */
function FullScreen(p: DeskProps) {
  const { rec, act, fsec } = p;
  const names = useNames();
  const items = attention(rec, names);
  const n = needsMe(rec, names);
  const sp: DeskProps = { ...p, shell: true, narrow: false };
  const [writing, setWriting] = useState<'decide' | 'work' | null>(null);
  const threads = rec.threads.filter((t) => t.status === 'open');
  const decisions = rec.decisions.filter((d) => d.state !== 'dismissed');
  const t = fsec === 'discuss' ? rec.threads.find((x) => x.id === p.openThread) : undefined;
  const d = p.inspect?.kind === 'decision' ? rec.decisions.find((x) => x.id === p.inspect!.id) : undefined;
  const w = p.inspect?.kind === 'work' ? rec.work.find((x) => x.id === p.inspect!.id) : undefined;
  const title = fsec === 'discuss' ? t?.about.name : fsec === 'decide' ? d?.title : fsec === 'work' ? w?.title : undefined;
  const counts = { foryou: items.filter((x) => x.kind !== 'info').length, discuss: threads.length, decide: decisions.filter((x) => x.state !== 'superseded').length, work: rec.work.filter((x) => x.state !== 'resolved' && x.state !== 'closed').length };
  const dot = { foryou: items.some(actionable), discuss: n.discuss, decide: n.decide, work: n.work };
  return (
    <div class="nx-fshell">
      <div class="nx-ins-bar">
        <button type="button" class="nx-back" onClick={() => (fsec === 'discuss' ? act.thread(null) : act.inspect(null))}>{SEC_LABEL[fsec]}</button>
        {title ? <><i class="nx-crumbsep">/</i><span class="nx-ins-crumb">{title}</span></> : null}
      </div>
      <nav class="nx-fnav" aria-label="Sections">
        {(['foryou', 'discuss', 'decide', 'work'] as const).map((s, i) => (
          <button key={s} type="button" class={'nx-fnav-i' + (fsec === s ? ' on' : '')} aria-current={fsec === s} title={`${SEC_LABEL[s]} · ⌥${i + 1}`} onClick={() => act.fsec(s)}>
            <span>{SEC_LABEL[s]}</span>{dot[s] ? <i class="nx-tabdot" aria-label="needs you"></i> : null}<em>{counts[s] || ''}</em>
          </button>
        ))}
        <span class="nx-keys"><span><b>⌥1–4</b> sections</span><span><b>⌘[</b> <b>⌘]</b> back, forward</span><span><b>Esc</b> leave</span></span>
      </nav>
      <div class="nx-flist" role="list">
        {fsec === 'foryou' ? <FsForYou p={p} items={items} /> : null}
        {fsec === 'discuss' ? <FsThreads p={p} threads={threads} /> : null}
        {fsec === 'decide' ? <FsDecisions p={p} decisions={decisions} composing={writing === 'decide'} setComposing={(on) => setWriting(on ? 'decide' : null)} /> : null}
        {fsec === 'work' ? <FsWork p={p} composing={writing === 'work'} setComposing={(on) => setWriting(on ? 'work' : null)} /> : null}
      </div>
      <div class="nx-fmain">
        {fsec === 'foryou' ? <FsEmpty text="Pick an item: it opens here, in its own section." /> : null}
        {fsec === 'discuss' ? (t ? <FsThread t={t} p={sp} /> : <FsEmpty text="Pick a conversation, or start one from the list." />) : null}
        {fsec === 'decide' ? (d ? <div class="nx-inspector focus"><DecisionDoc d={d} p={sp} /></div> : decisions.length ? <FsEmpty text="Pick a decision to read, review or sign." /> : <div class="nx-fpad"><DecideEmpty p={sp} write={() => setWriting('decide')} /></div>) : null}
        {fsec === 'work' ? (w ? <div class="nx-inspector focus"><WorkView w={w} p={sp} /></div> : <FsEmpty text={rec.work.length ? 'Pick a piece of work to see its plan, run, pull requests and outcome.' : 'No work yet. Start it from the list, or from a signed decision.'} />) : null}
      </div>
    </div>
  );
}

const FsEmpty = ({ text }: { text: string }) => <div class="nx-fempty">{text}</div>;

function FsForYou({ p, items }: { p: DeskProps; items: Attn[] }) {
  const now = items.filter((x) => x.kind !== 'info' && !isSuggestion(x)), sug = items.filter(isSuggestion), info = items.filter((x) => x.kind === 'info');
  const row = (n: Attn) => (
    <button key={n.id} type="button" role="listitem" class={'nx-frow ' + n.kind} onClick={() => p.act.notice(n)}>
      <span class="nx-fy-k">{KIND_WORD[n.kind]}{n.where ? ` · on ${n.where}` : ''}</span>
      <b>{n.text}</b>
      <span class="nx-frow-s">{n.why}{n.cta ? ` · ${n.cta} ›` : ''}</span>
    </button>
  );
  return (
    <>
      <span class="nx-fl-h">Needs you<em>{now.length}</em></span>
      {now.length ? now.map(row) : <p class="nx-quiet nx-fl-pad">Nothing needs you right now.</p>}
      {sug.length ? <><span class="nx-fl-h">Suggested decisions<em>{sug.length}</em></span>{sug.map(row)}</> : null}
      {info.length ? <><span class="nx-fl-h">{p.rec.since ? `Since ${p.rec.since.lastHere}` : 'Worth knowing'}<em>{info.length}</em></span>{info.map(row)}</> : null}
    </>
  );
}

function FsThreads({ p, threads }: { p: DeskProps; threads: Thread[] }) {
  const { nameOf } = useNames();
  const [draft, setDraft] = useState('');
  const sys = threads.filter((t) => t.about.kind === 'part' || t.about.kind === 'edge' || t.about.kind === 'scenario');
  const other = threads.filter((t) => !sys.includes(t));
  const row = (t: Thread) => {
    const last = t.replies[t.replies.length - 1];
    return (
      <button key={t.id} type="button" role="listitem" class={'nx-frow' + (p.openThread === t.id ? ' on' : '')} onClick={() => p.act.thread(t.id)} onPointerEnter={() => p.act.light(partsOf(t.about, p.rec))} onPointerLeave={() => p.act.light(null)}>
        <span class="nx-fy-k">{ABOUT_WORD[t.about.kind] ? `on ${ABOUT_WORD[t.about.kind]}` : 'on the canvas'}{t.waiting === p.me ? ' · waiting on you' : ''}</span>
        <b>{t.about.name}</b>
        <span class="nx-frow-s">{nameOf(last.by)}: {last.body.replace(/\[([^|\]]+)\|[^\]]+\]/g, '$1').slice(0, 80)}{last.body.length > 80 ? '…' : ''}</span>
      </button>
    );
  };
  return (
    <>
      <label class="rp-cm-reply nx-compose nx-fl-pad"><Who id={p.me} /><span class="rp-sr">New thread</span>
        <input type="text" placeholder="Start a thread about the system…" value={draft} onInput={(e) => setDraft(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter' && draft.trim()) { p.act.newThread(draft.trim()); setDraft(''); } }} />
      </label>
      <span class="nx-fl-h">About the system<em>{sys.length}</em></span>
      {sys.map(row)}
      {other.length ? <><span class="nx-fl-h">On decisions, plans and PRs<em>{other.length}</em></span>{other.map(row)}</> : null}
    </>
  );
}

function FsDecisions({ p, decisions, composing, setComposing }: { p: DeskProps; decisions: Decision[]; composing: boolean; setComposing(on: boolean): void }) {
  const live = decisions.filter((d) => d.state !== 'superseded'), old = decisions.filter((d) => d.state === 'superseded');
  const row = (d: Decision) => {
    const mine = d.approvers.find((a) => a.who === p.me);
    const needs = d.state === 'review' && mine && mine.signed !== d.version && !mine.changes;
    return (
      <button key={d.id} type="button" role="listitem" class={'nx-frow' + (p.inspect?.id === d.id ? ' on' : '')} onClick={() => p.act.inspect({ kind: 'decision', id: d.id })} onPointerEnter={() => p.act.light(d.parts)} onPointerLeave={() => p.act.light(null)}>
        <span class={'nx-st2 ' + (needs ? 'needs' : d.state)}>{needs ? 'Waiting on your signature' : `${DEC_STATE[d.state]} · v${d.version}`}</span>
        <b>{d.title}</b>
        <span class="nx-frow-s">{d.lines.filter((l) => l.kind === 'decide').map((l) => l.text).join(' · ').slice(0, 90)}</span>
      </button>
    );
  };
  return (
    <>
      {composing ? <div class="nx-fl-pad"><NewDecision p={p} done={() => setComposing(false)} /></div> : <button type="button" class="nx-textbtn add nx-fl-pad" disabled={!mayWrite(p.role)} onClick={() => setComposing(true)}>+ Write a decision</button>}
      {live.map(row)}
      {old.length ? <><span class="nx-fl-h">Earlier versions<em>{old.length}</em></span>{old.map(row)}</> : null}
    </>
  );
}

function FsWork({ p, composing, setComposing }: { p: DeskProps; composing: boolean; setComposing(on: boolean): void }) {
  return (
    <>
      {composing ? <div class="nx-fl-pad"><NewWork p={p} done={() => setComposing(false)} /></div> : <button type="button" class="nx-textbtn add nx-fl-pad" disabled={!mayWrite(p.role)} onClick={() => setComposing(true)}>+ New work</button>}
      {p.rec.work.map((w) => {
        const st = objectiveState(w, p.rec, p.me);
        return (
          <button key={w.id} type="button" role="listitem" class={'nx-frow' + (p.inspect?.id === w.id ? ' on' : '')} onClick={() => p.act.inspect({ kind: 'work', id: w.id, section: 'plan' })} onPointerEnter={() => p.act.light(w.parts)} onPointerLeave={() => p.act.light(null)}>
            <span class={'nx-st2 ' + st.k}>{st.label}</span>
            <b>{w.title}</b>
            <span class="nx-frow-s">{w.doer ? w.doer.name : 'Nobody yet'}{w.prs.length ? ` · ${w.prs.filter((x) => x.state !== 'closed').map((x) => '#' + x.num).join(' ')}` : ''}</span>
          </button>
        );
      })}
    </>
  );
}

/** A conversation at full width: the thread, what it's about on the canvas, and what it led to. */
function FsThread({ t, p }: { t: Thread; p: DeskProps }) {
  const { agentName } = useNames();
  const { rec, act } = p;
  const parts = partsOf(t.about, rec);
  const led = rec.decisions.filter((d) => d.from === t.id);
  return (
    <div class="nx-fthread">
      <div class="nx-fthread-main">
        <span class="nx-eyebrow">Conversation · {ABOUT_WORD[t.about.kind] ? `on ${ABOUT_WORD[t.about.kind]}` : 'on the canvas'}</span>
        <h2>{t.about.name}</h2>
        <ThreadCard t={t} p={{ ...p, openThread: t.id }} inline />
      </div>
      <aside class="nx-margin">
        <div class="nx-rsec">
          <span class="nx-rk2">About</span>
          {parts.length ? <button type="button" class="nx-rc" onClick={() => act.light(parts)}><span><b>{t.about.name}</b></span><em>Show on the canvas</em></button> : <p class="nx-quiet">Not pinned to a part.</p>}
          {t.linked?.map((l, i) => <span key={i} class="nx-quiet">Also about {l.name}</span>)}
        </div>
        <div class="nx-rsec">
          <span class="nx-rk2">Led to</span>
          {led.length ? led.map((d) => <button key={d.id} type="button" class="nx-rc" onClick={() => act.inspect({ kind: 'decision', id: d.id })}><span><b>{d.title}</b></span><em>Decision v{d.version} · {DEC_STATE[d.state].toLowerCase()}</em></button>)
            : <><p class="nx-quiet">Nothing yet.</p><button type="button" class="nx-btn" disabled={!mayWrite(p.role)} onClick={() => act.draftFrom(t.id)}>{rec.vowe ? `Ask ${agentName()} to draft a decision` : 'Start a decision from this'}</button></>}
        </div>
      </aside>
    </div>
  );
}

/* ---------------- Discuss ---------------- */

function DiscussTab(p: DeskProps) {
  const { agentName } = useNames();
  const { rec, me, act, focus, focusOn } = p;
  const [draft, setDraft] = useState('');
  const sys = (t: Thread) => t.about.kind === 'part' || t.about.kind === 'edge' || t.about.kind === 'scenario';
  const all = rec.threads.filter((t) => t.status === 'open');
  const open = p.everywhere ? all : all.filter((t) => sys(t) || t.waiting === me);
  const elsewhere = all.filter((t) => !sys(t)).length;
  const rel = (t: Thread) => !focus || !focusOn || partsOf(t.about, rec).includes(focus.id);
  const order = [...open].reverse().sort((a, b) => Number(b.id === p.openThread) - Number(a.id === p.openThread));
  const shown = [...order.filter(rel), ...order.filter((t) => !rel(t))];
  return (
    <section class="rp-sec nx-tabbody">
      <NeedsYou p={p} tab="discuss" />
      <label class="rp-cm-reply nx-compose">
        <Who id={me} /><span class="rp-sr">New thread</span>
        <input type="text" placeholder={focus ? `Start a thread on ${focus.name}…` : 'Start a thread about the system…'} value={draft}
          onInput={(e) => setDraft(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter' && draft.trim()) { act.newThread(draft.trim()); setDraft(''); } }} />
      </label>
      <div class="nx-dfilter"><button type="button" class={!p.everywhere ? 'on' : ''} onClick={() => act.everywhere(false)}>About the system</button><button type="button" class={p.everywhere ? 'on' : ''} onClick={() => act.everywhere(true)}>Everywhere<em>{all.length}</em></button>{!p.everywhere && elsewhere ? <span>{elsewhere} on decisions, plans and PRs live there</span> : null}</div>
      <span class="nx-hint2">{focus ? `It will be pinned to ${focus.name}.` : 'Select a part first to pin the thread to it.'}{rec.vowe ? ` ${agentName()} only joins if you @mention it.` : ''}</span>
      {open.length === 0 ? <p class="nx-quiet">No conversations yet.</p> : null}
      <div class="rp-tgroups">
        {shown.map((t) => <ThreadCard key={t.id} t={t} p={p} dim={!rel(t)} />)}
      </div>
    </section>
  );
}

export function ThreadCard({ t, p, dim, inline }: { t: Thread; p: DeskProps; dim?: boolean; inline?: boolean }) {
  const { nameOf, agentName } = useNames();
  const { rec, me, act } = p;
  const [text, setText] = useState('');
  const expanded = inline || p.openThread === t.id;
  const root = t.replies[0];
  const parts = partsOf(t.about, rec);
  const offer = t.replies.find((r) => r.offer?.state === 'open');
  if (dim && !expanded) {
    return (
      <div class="rp-tg nx-dim">
        <button class="rp-tg-head" type="button" onClick={() => act.thread(t.id)}><AboutGlyph a={t.about.kind} /><span class="rp-tg-name">{t.about.name}</span><span class="rp-tg-n">{t.replies.length} {t.replies.length === 1 ? 'message' : 'messages'}</span></button>
      </div>
    );
  }
  return (
    <div class={'rp-tg rp-open' + (p.flash === `thread:${t.id}` ? ' nx-flash' : '')}>
      {!inline ? (
        <button class="rp-tg-head" type="button" onPointerEnter={() => act.light(parts)} onPointerLeave={() => act.light(null)} onClick={() => act.thread(expanded ? null : t.id)}>
          <AboutGlyph a={t.about.kind} /><span class="rp-tg-name">{t.about.name}</span>
          {ABOUT_WORD[t.about.kind] ? <span class="nx-akind">on {ABOUT_WORD[t.about.kind]}</span> : null}{t.waiting === me ? <span class="nx-waits">waiting on you</span> : null}
          <span class="rp-tg-n">{t.replies.length} {t.replies.length === 1 ? 'message' : 'messages'}</span>
        </button>
      ) : null}
      <div class="rp-tstack">
        <div class={'rp-cm' + (expanded ? ' rp-expanded' : '') + (offer && !expanded ? ' nx-has-offer' : '')}>
          <button class="rp-cm-main" type="button" aria-expanded={expanded} onClick={() => !inline && act.thread(expanded ? null : t.id)}>
            <span class="rp-cm-head"><Who id={root.by} /><b>{root.by === me ? 'You' : nameOf(root.by)}</b><span class="rp-cm-time">{root.ago}</span>{root.spoken ? <span class="nx-spoken">said in the call</span> : null}{t.title ? <span class="rp-cm-kind">{t.title}</span> : null}</span>
            <span class="rp-cm-body"><Words text={root.body} light={act.light} /></span>
            {root.evidence ? <Evidence ids={root.evidence} /> : null}
          </button>
          <div class="rp-cm-foot">
            {t.replies.length > 1 ? <span class="rp-cm-replies"><span class="rp-avstack">{[...new Set(t.replies.slice(1).map((r) => r.by))].map((id) => <Who key={id} id={id} size={16} />)}</span>{t.replies.length - 1} {t.replies.length === 2 ? 'reply' : 'replies'} · {t.replies[t.replies.length - 1].ago}</span> : <span class="rp-cm-replies rp-quiet">No replies</span>}
            {t.presence ? <span class="rp-pres rp-busy"><Who id={t.presence.personId} size={16} />{nameOf(t.presence.personId)} is {t.presence.mode === 'typing' ? 'writing' : 'reading'}</span> : offer && !expanded ? <span class="nx-offer-tag">{agentName()} suggests a decision</span> : null}
          </div>
          {expanded ? (
            <div class="rp-cm-thread">
              {t.replies.slice(1).map((r) => <ReplyRow key={r.id} r={r} t={t} p={p} />)}
              {t.presence?.mode === 'typing' ? <div class="rp-cm-typing"><Who id={t.presence.personId} /><span class="rp-bubble"><span class="rp-dots"><i /><i /><i /></span></span></div> : null}
              <label class="rp-cm-reply">
                <Who id={me} /><span class="rp-sr">Reply</span>
                <input type="text" placeholder={rec.vowe ? `Reply, @${agentName()} to ask it, or just say it on the call` : 'Reply, or @ someone in the room'} value={text} onInput={(e) => setText(e.currentTarget.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) { act.reply(t.id, text.trim()); setText(''); } }} />
              </label>
              <span class="nx-thread-foot">
                {parts.length ? <button class="rp-link" type="button" onClick={() => act.light(parts)}>Show on canvas</button> : null}
                {t.linked?.map((l, i) => <span key={i} class="nx-linked"><AboutGlyph a={l.kind} />also on {l.name}</span>)}
              </span>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ReplyRow({ r, t, p }: { r: Reply; t: Thread; p: DeskProps }) {
  const { nameOf } = useNames();
  const { me, act } = p;
  return (
    <div class={`rp-cm-r${r.fresh ? ' rp-fresh' : ''}${r.by === AGENT ? ' nx-vowe-r' : ''}`}>
      <span class="rp-cm-head"><Who id={r.by} /><b>{r.by === me ? 'You' : nameOf(r.by)}</b><span class="rp-cm-time">{r.ago}</span>{r.spoken ? <span class="nx-spoken">said in the call</span> : null}</span>
      <span class="rp-cm-body" onPointerEnter={() => r.points && act.light(r.points)} onPointerLeave={() => r.points && act.light(null)}><Words text={r.body} light={act.light} /></span>
      {r.evidence ? <Evidence ids={r.evidence} /> : null}
      {r.offer ? (
        <div class={'nx-offer2 ' + r.offer.state}>
          <span class="nx-offer-t">{r.offer.state === 'open' ? 'Offer: ' : r.offer.state === 'accepted' ? `${nameOf(r.offer.by ?? me) === nameOf(me) ? 'You' : nameOf(r.offer.by ?? me)} accepted: ` : 'Not now: '}{r.offer.text}</span>
          {r.offer.state === 'open' ? (
            <span class="nx-offer-a2">
              <button type="button" class="nx-textbtn strong" onClick={() => act.offer(t.id, r.id, true)}>{r.offer.kind === 'decision' ? 'Draft the decision' : r.offer.kind === 'work' ? (t.about.kind === 'step' ? 'Show me the split' : 'Draft the plan') : r.offer.kind === 'revision' ? 'Draft v2' : 'Take the edit'}</button>
              <button type="button" class="nx-textbtn" onClick={() => act.offer(t.id, r.id, false)}>Not now</button>
            </span>
          ) : r.offer.state === 'dismissed' ? <button type="button" class="nx-textbtn" onClick={() => act.offer(t.id, r.id, true)}>Draft it anyway</button>
            : r.offer.target ? <button type="button" class="nx-textbtn" onClick={() => r.offer!.target!.startsWith('d') ? act.inspect({ kind: 'decision', id: r.offer!.target! }) : act.inspect({ kind: 'work', id: r.offer!.target!.split(':')[0], section: 'plan' })}>{r.offer.kind === 'work' ? 'Open the plan' : 'Open the decision'}</button> : null}
        </div>
      ) : null}
    </div>
  );
}

/* ---------------- Decide ---------------- */

function DecideTab(p: DeskProps) {
  const { rec, focus, focusOn } = p;
  const live = rec.decisions.filter((d) => d.state !== 'dismissed' && d.state !== 'superseded' && d.state !== 'suggested');
  const old = rec.decisions.filter((d) => d.state === 'dismissed' || d.state === 'superseded');
  const [composing, setComposing] = useState(false);
  const [hist, setHist] = useState(false);
  const rel = (d: Decision) => !focus || !focusOn || d.parts.includes(focus.id);
  const order = [...live].sort((a, b) => Number(!rel(a)) - Number(!rel(b)) || ['review', 'draft', 'suggested', 'agreed'].indexOf(a.state) - ['review', 'draft', 'suggested', 'agreed'].indexOf(b.state));
  return (
    <section class="rp-sec nx-tabbody">
      <NeedsYou p={p} tab="decide" />
      <Suggested p={p} />
      {composing ? <NewDecision p={p} done={() => setComposing(false)} /> : null}
      {!live.length && !composing ? <DecideEmpty p={p} write={() => setComposing(true)} /> : null}
      {order.map((d) => <DecisionMini key={d.id} d={d} p={p} dim={!rel(d)} />)}
      {live.length && !composing ? <button type="button" class="nx-textbtn add" disabled={!mayWrite(p.role)} onClick={() => setComposing(true)}>+ Write a decision</button> : null}
      {old.length ? <button type="button" class="nx-textbtn" onClick={() => setHist(!hist)}>{hist ? 'Hide' : 'Show'} {old.length} earlier</button> : null}
      {hist ? old.map((d) => <DecisionMini key={d.id} d={d} p={p} dim />) : null}
    </section>
  );
}

function NewDecision({ p, done, from }: { p: DeskProps; done(): void; from?: Thread }) {
  const [t, setT] = useState('');
  const [l, setL] = useState('');
  const go = () => { if (!t.trim()) return; p.act.newDecision(t.trim(), l.trim()); done(); };
  return (
    <div class="nx-newdoc">
      <span class="nx-eyebrow">New decision · a draft until people sign it</span>
      <input class="nx-newdoc-t" type="text" ref={(el) => { if (el && !el.dataset.f) { el.dataset.f = '1'; el.focus(); } }} placeholder="What are we deciding?" value={t} onInput={(e) => setT(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Escape') done(); }} />
      <input class="nx-newdoc-l" type="text" placeholder="We will… (the first commitment; you can add more in the document)" value={l} onInput={(e) => setL(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter') go(); if (e.key === 'Escape') done(); }} />
      {from ? <span class="nx-quiet">From the {from.about.name} thread</span> : null}
      <span class="nx-actrow"><button type="button" class="nx-btn primary" disabled={!t.trim()} onClick={go}>Create the draft</button><button type="button" class="nx-btn" onClick={done}>Cancel</button></span>
    </div>
  );
}

function DecideEmpty({ p, write }: { p: DeskProps; write(): void }) {
  const { nameOf, agentName } = useNames();
  const { rec, act } = p;
  const threads = rec.threads.filter((t) => t.status === 'open' && (t.about.kind === 'part' || t.about.kind === 'scenario')).slice(0, 3);
  return (
    <div class="nx-empty2">
      <b>No decisions yet</b>
      <p>A decision is what the room agrees to do and why. It counts once the people asked have signed it.</p>
      <button type="button" class="nx-btn primary" disabled={!mayWrite(p.role)} onClick={write}>Write a decision</button>
      {threads.length ? <span class="nx-empty2-k">Or start from a conversation</span> : null}
      {threads.map((t) => (
        <div key={t.id} class="nx-empty2-row">
          <span><b>{t.about.name}</b> · {nameOf(t.replies[0].by)}: {t.replies[t.replies.length - 1].body.replace(/\[([^|\]]+)\|[^\]]+\]/g, '$1').slice(0, 64)}…</span>
          <button type="button" class="nx-textbtn strong" onClick={() => act.draftFrom(t.id)}>{rec.vowe ? `Ask ${agentName()} to draft` : 'Start from this'}</button>
        </div>
      ))}
    </div>
  );
}

/** A decision in the compact Desk: what it is, where it stands, what it needs from you. */
export function DecisionMini({ d, p, dim }: { d: Decision; p: DeskProps; dim?: boolean }) {
  const { nameOf, agentName } = useNames();
  const { me, act } = p;
  const mine = d.approvers.find((a) => a.who === me);
  const needs = d.state === 'review' && mine && mine.signed !== d.version && !mine.changes;
  const changes = d.approvers.filter((a) => a.changes);
  const we = d.lines.filter((l) => l.kind === 'decide');
  const sugg = d.lines.filter((l) => l.suggest).length;
  const status = d.state === 'agreed' ? `Agreed · v${d.version}` : d.state === 'review' ? (changes.length ? `${nameOf(changes[0].who)} requested changes` : needs ? 'Waiting on your signature' : `Waiting on ${d.approvers.filter((a) => a.signed !== d.version).map((a) => nameOf(a.who)).join(', ')}`) : d.state === 'draft' ? `Draft · v${d.version}` : d.state === 'suggested' ? `${agentName()} thinks there’s a decision here` : DEC_STATE[d.state];
  return (
    <div class={'nx-dmini ' + d.state + (dim ? ' nx-dim' : '') + (p.flash === `decision:${d.id}` ? ' nx-flash' : '')} onPointerEnter={() => act.light(d.parts)} onPointerLeave={() => act.light(null)}>
      <button type="button" class="nx-dmini-main" onClick={() => act.inspect({ kind: 'decision', id: d.id })}>
        <span class={'nx-st2 ' + (needs || changes.length ? 'needs' : d.state)}>{status}</span>
        <b>{d.title}</b>
        {we.slice(0, 2).map((l) => <span key={l.id} class="nx-dmini-l">{l.text}</span>)}
        {sugg ? <span class="nx-dmini-s">{sugg} suggested edit{sugg > 1 ? 's' : ''} to review</span> : null}
      </button>
      <span class="nx-dmini-f">
        <span class="nx-sigdots">{d.approvers.map((a) => <span key={a.who} class={'nx-sigdot' + (a.signed === d.version ? ' ok' : a.changes ? ' ch' : '')} title={`${nameOf(a.who)}: ${a.signed === d.version ? 'signed' : a.changes ? 'requested changes' : 'not signed'}`}><Who id={a.who} size={16} /></span>)}</span>
        {needs ? <button type="button" class="nx-btn primary" onClick={() => act.inspect({ kind: 'decision', id: d.id })}>Read and sign</button> : <button type="button" class="nx-textbtn" onClick={() => act.inspect({ kind: 'decision', id: d.id })}>Open</button>}
      </span>
    </div>
  );
}

/* ---------------- Work ---------------- */

function WorkTab(p: DeskProps) {
  const { agentName } = useNames();
  const { rec, focus, focusOn, act } = p;
  const [composing, setComposing] = useState(false);
  const rel = (w: Work) => !focus || !focusOn || w.parts.includes(focus.id);
  const rank = (w: Work) => ({ waiting: 0, review: 1, proposed: 2, running: 3, resolved: 5, closed: 6 } as Record<string, number>)[objectiveState(w, rec, p.me).k] ?? 4;
  const list = [...rec.work].sort((a, b) => Number(!rel(a)) - Number(!rel(b)) || rank(a) - rank(b));
  const noAgent = rec.agents.every((a) => a.status !== 'connected');
  const ready = rec.decisions.filter((d) => d.state === 'agreed' && !rec.work.some((w) => w.decision === d.id));
  return (
    <section class="rp-sec nx-tabbody">
      <NeedsYou p={p} tab="work" />
      {composing ? <NewWork p={p} done={() => setComposing(false)} /> : null}
      {!list.length && !composing ? (
        <div class="nx-empty2">
          <b>No work yet</b>
          <p>Work is an objective with a plan. A person or a connected coding agent does it, and its PRs stay together here.{noAgent ? ' No coding agent is connected to this room, so a person would do it.' : ''}</p>
          <button type="button" class="nx-btn primary" disabled={!mayWrite(p.role)} onClick={() => setComposing(true)}>New work</button>
          {ready.length ? <span class="nx-empty2-k">Or start from a signed decision</span> : null}
          {ready.map((d) => <div key={d.id} class="nx-empty2-row"><span><b>{d.title}</b> · v{d.version}</span><button type="button" class="nx-textbtn strong" onClick={() => act.prepareWork(d.id)}>{rec.vowe ? `Plan it (${agentName()} drafts)` : 'Plan it'}</button></div>)}
        </div>
      ) : null}
      {list.map((w) => <ObjectiveCard key={w.id} w={w} p={p} dim={!rel(w)} />)}
      {list.length && !composing ? <button type="button" class="nx-textbtn add" disabled={!mayWrite(p.role)} onClick={() => setComposing(true)}>+ New work</button> : null}
    </section>
  );
}

function NewWork({ p, done }: { p: DeskProps; done(): void }) {
  const [t, setT] = useState('');
  const [o, setO] = useState('');
  const go = () => { if (!t.trim()) return; p.act.newWork(t.trim(), o.trim()); done(); };
  return (
    <div class="nx-newdoc">
      <span class="nx-eyebrow">New work · you write the plan next</span>
      <input class="nx-newdoc-t" type="text" ref={(el) => { if (el && !el.dataset.f) { el.dataset.f = '1'; el.focus(); } }} placeholder="Name it, e.g. Webhook signatures" value={t} onInput={(e) => setT(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Escape') done(); }} />
      <input class="nx-newdoc-l" type="text" placeholder="What should be true when it’s done?" value={o} onInput={(e) => setO(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter') go(); if (e.key === 'Escape') done(); }} />
      <span class="nx-actrow"><button type="button" class="nx-btn primary" disabled={!t.trim()} onClick={go}>Create and write the plan</button><button type="button" class="nx-btn" onClick={done}>Cancel</button></span>
    </div>
  );
}

function Prs({ prs, p }: { prs: PR[]; p: DeskProps }) {
  const { nameOf } = useNames();
  return (
    <div class="nx-prs">
      {[...prs].sort((a, b) => ['changes', 'open', 'review', 'draft', 'merged', 'closed'].indexOf(a.state) - ['changes', 'open', 'review', 'draft', 'merged', 'closed'].indexOf(b.state)).map((pr) => {
        const failing = pr.checks.filter((c) => c.state === 'fail');
        const running = pr.checks.some((c) => c.state === 'running');
        return (
          <div key={pr.id} class={'nx-pr ' + pr.state + (p.flash === `pr:${pr.id}` ? ' nx-flash' : '')} onPointerEnter={() => p.act.light(pr.parts)} onPointerLeave={() => p.act.light(null)}>
            <button type="button" class="nx-pr-main" onClick={(e) => { e.stopPropagation(); p.act.inspect({ kind: 'work', id: p.rec.work.find((w) => w.prs.includes(pr))!.id, pr: pr.id }); }}>
              <span class="nx-pr-id">#{pr.num}</span>
              <span class="nx-pr-t">{pr.state === 'closed' ? <s>{pr.title}</s> : pr.title}</span>
              <span class={'nx-pr-st ' + pr.state}>{PR_STATE[pr.state]}</span>
            </button>
            <span class="nx-pr-meta">
              <span class={'nx-ci ' + (failing.length ? 'fail' : running ? 'running' : pr.checks.length ? 'pass' : 'none')}>{failing.length ? `${failing.length} check failing` : running ? 'checks running' : pr.checks.length ? `${pr.checks.length} checks pass` : 'no checks yet'}</span>
              {pr.dependsOn ? <span>after #{pr.dependsOn}</span> : null}
              {pr.supersededBy ? <span>replaced by #{pr.supersededBy}</span> : null}
              {pr.review ? <span class={'nx-rv ' + pr.review.state}>{nameOf(pr.review.by)} {pr.review.state === 'requested' ? 'asked to review' : pr.review.state === 'changes' ? 'requested changes' : pr.review.state}</span> : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function WorkCard({ w, p, dim, bare }: { w: Work; p: DeskProps; dim?: boolean; bare?: boolean }) {
  const { nameOf } = useNames();
  const { rec, me, act } = p;
  const [ans, setAns] = useState('');
  const dec = rec.decisions.find((d) => d.id === w.decision);
  const done = w.plan.filter((s) => s.state === 'done').length;
  const run = w.runs[w.runs.length - 1];
  const attention = (
    <>
      {w.scopeAsk ? (
        <div class="nx-q nx-scope">
          <span class="nx-q-h">{w.scopeAsk.by} needs permission to go further</span>
          <p>{w.scopeAsk.text}</p>
          <span class="nx-scope-add">Adds: <code>{w.scopeAsk.adds}</code></span>
          <span class="nx-offer-a"><button type="button" class="nx-btn primary" onClick={() => act.allowScope(w.id, true)}>Allow this</button><button type="button" class="rp-mini rp-ghost" onClick={() => act.allowScope(w.id, false)}>Keep the old scope</button></span>
        </div>
      ) : null}
      {w.question && !w.question.answer ? (
        <div class={'nx-q' + (w.question.deferred ? ' nx-deferred' : '')}>
          <span class="nx-q-h">{w.question.deferred ? 'Deferred' : `${w.doer?.name ?? 'The agent'} asks ${w.question.for === me ? 'you' : nameOf(w.question.for)}`} · about <button type="button" class="nx-inl" onClick={() => act.light([w.question!.about])}>{w.question.about === 'idempotency-keys' ? 'Idempotency keys' : w.question.about}</button></span>
          <p>{w.question.text}</p>
          <span class="nx-qopts">{w.question.options.map((o) => <button key={o} type="button" class="rp-mini" onClick={() => act.answer(w.id, o)}>{o}</button>)}</span>
          <label class="rp-cm-reply nx-q-in"><span class="rp-sr">Answer</span><input type="text" placeholder="Or answer in your own words…" value={ans} onInput={(e) => setAns(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter' && ans.trim()) { act.answer(w.id, ans.trim()); setAns(''); } }} /></label>
          <span class="nx-q-more"><button type="button" class="rp-link" onClick={() => act.discussQuestion(w.id)}>Discuss in a thread</button>{!w.question.deferred ? <button type="button" class="rp-link" onClick={() => act.defer(w.id)}>Defer; it can work on step 2 meanwhile</button> : null}</span>
        </div>
      ) : w.question?.answer ? <span class="nx-q-a"><Who id={w.question.answer.by} size={16} />Answered: {w.question.answer.text}</span> : null}
      {w.finding ? (
        <div class="nx-finding">
          <span class="nx-q-h nx-fh"><span class="orb"></span>{nameOf(w.finding.by)} · {w.finding.ago}</span>
          <p>{w.finding.text}</p>
          <Evidence ids={w.finding.evidence} />
          {w.finding.offer && p.caps.agentRuns ? <span class="nx-offer-a"><button type="button" class="rp-mini" onClick={() => act.takeFinding(w.id)}>{w.finding.offer}</button></span> : null}
        </div>
      ) : null}
    </>
  );
  if (bare) return <div class="nx-attn">{attention}</div>;
  return (
    <div class={'rp-stream nx-work ' + w.state + (dim ? ' nx-dim' : '') + (p.flash === `work:${w.id}` ? ' nx-flash' : '')} onPointerEnter={() => act.light(w.parts)} onPointerLeave={() => act.light(null)}>
      <div class="nx-w-top">
        <span class={'nx-state ' + w.state}>{WORK_STATE[w.state]}</span>
        <span class="nx-w-t">{w.title}</span>
        <button type="button" class="rp-dc-open nx-open" onClick={() => act.inspect({ kind: 'work', id: w.id })}>Open<svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M6 4l4 4-4 4" /></svg></button>
      </div>
      <span class="nx-w-meta">
        {dec ? <>From <button type="button" class="nx-inl" onClick={() => act.tab('decide')}>{dec.title.length > 34 ? dec.title.slice(0, 32) + '…' : dec.title} v{dec.version}</button> · </> : null}
        <span class="nx-mono">{w.repo}</span> · owner {w.owner === me ? 'you' : nameOf(w.owner)}
      </span>
      <span class="nx-w-doer">
        {w.doer ? <><span class={'nx-doer ' + w.doer.kind}>{w.doer.kind === 'agent' ? 'Agent' : 'Person'}</span>{w.doer.name}</> : <span class="nx-doer none">Nobody yet</span>}
        {w.authorized ? <em>authorized by {w.authorized.by === me ? 'you' : nameOf(w.authorized.by)} · {w.authorized.scope}</em> : w.state === 'proposed' ? <em>not authorized: nothing runs until someone approves the plan</em> : null}
      </span>
      <div class="nx-plan">
        <span class="nx-plan-h">Plan · {done} of {w.plan.length} done</span>
        {w.plan.map((s, i) => (
          <div key={s.id} class={'nx-step2 ' + s.state}>
            <span class="nx-si">{s.state === 'done' ? '✓' : i + 1}</span>
            <span class="nx-st">{s.text}{s.pr ? <span class="nx-spr">{s.pr}</span> : null}</span>
          </div>
        ))}
      </div>
      {attention}
      {run && (run.state === 'running' || run.state === 'waiting') ? <span class="nx-eff-last"><BasisGlyph b="observed" title="Observed: the agent's own event" />{run.events[run.events.length - 1]?.text}<em>{run.events[run.events.length - 1]?.ago}</em></span> : null}
      {w.prs.length ? <Prs prs={w.prs} p={p} /> : null}
      <div class="rp-stream-acts nx-w-acts">
        {w.state === 'proposed' ? <button class="rp-mini nx-ink" type="button" onClick={() => act.inspect({ kind: 'work', id: w.id })}>Review the plan</button> : null}
        {w.state === 'review' && w.prs.every((x) => x.state === 'merged' || x.state === 'closed') ? <button class="nx-btn primary" type="button" onClick={() => act.resolve(w.id)}>Mark resolved</button> : null}
        {w.resolved ? <span class="nx-resolved">✓ Resolved by {w.resolved.by === me ? 'you' : nameOf(w.resolved.by)} · {w.resolved.ago}{w.resolved.ack?.length ? ` · ${w.resolved.ack.map(nameOf).join(', ')} agreed` : ''}</span> : null}
      </div>
    </div>
  );
}

/* ---------------- Inspector: the Desk, widened ---------------- */

function Inspector(p: DeskProps) {
  const { rec, act, inspect } = p;
  if (!inspect) return null;
  const d = inspect.kind === 'decision' ? rec.decisions.find((x) => x.id === inspect.id) : undefined;
  const w = inspect.kind === 'work' ? rec.work.find((x) => x.id === inspect.id) : undefined;
  return (
    <div class={'nx-inspector' + (p.narrow ? ' narrow' : '') + (p.depth === 'focus' ? ' focus' : '')} aria-label={d ? 'Decision' : 'Work'}>
      <div class="nx-ins-bar">
        <button type="button" class="nx-back" title={`All of ${inspect.kind === 'decision' ? 'Decide' : 'Work'}`} onClick={() => act.inspect(null)}>{inspect.kind === 'decision' ? 'Decide' : 'Work'}</button><i class="nx-crumbsep">/</i>
        <span class="nx-ins-crumb">{d ? d.title : w?.title}</span>
      </div>
      {d ? <DecisionDoc d={d} p={p} /> : w ? <WorkView w={w} p={p} /> : null}
    </div>
  );
}
