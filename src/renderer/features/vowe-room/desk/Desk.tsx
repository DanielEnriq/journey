import { h, Fragment, useEffect, useRef, useState, Avatar } from '../journey.js';
import { Icon, type IconName } from '../../../ui/icons.js';
import { useEvidence } from '../state/semantics.js';
import { BasisGlyph } from '../canvas/faces.js';
import { AGENT, type RoomRole, type About, type Decision, type Line, type Notice, type PR, type Reply, type VoweRecord, type Thread, type Work } from '../contracts/model.js';
import type { Inspect, Tab } from '../state/ui.js';
import { actionable, attention, isSuggestion, tabMark, type Attn } from '../state/attention.js';
import type { PlanOp } from '../state/plan.js';
import type { Step as PStep } from '../contracts/model.js';
import { ObjectiveCard, WorkView, objectiveState } from './Work.js';
import { DecisionDoc } from './DecisionDoc.js';
import { Focus } from './Focus.js';
import { MentionField, withTokens } from './Mention.js';
import type { Scene } from '../../../../shared/canvas/index.js';

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
  addLine(decision: string, kind: Line['kind'], text: string): void;
  newDecision(title: string, line: string): void;
  askFor(decision: string, who: string[]): void;
  everywhere(on: boolean): void;
  editDoc(decision: string, field: 'problem' | 'rationale', text: string): void;
  compare(v: number | null): void;
  depth(d: Depth): void;
  newWork(title: string, objective: string): void;
  draftFrom(thread: string): void;
  /** Full screen: which section Focus shows. */
  fsec(sec: Tab): void;
  markDone(ids: string[]): void;
  askFix(work: string, pr: string, check: string): void;
  stopRun(work: string): void;
  focusAll(): void;
  sinceShow(): void;
  sinceFold(): void;
  /** Rename the assistant for this workspace (owners). */
  renameAgent(name: string): void;
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
  /** Full screen: the section Focus shows, and whether we're inside the full-screen workspace. */
  fsec: Tab;
  shell?: boolean;
  /** The room, for Focus's list head. */
  room?: { name: string; repo: string | null };
  /** The canvas's current view, for Focus's empty Discuss. */
  scene?: Scene | null;
}

/* ---------------- shared pieces ---------------- */

/** A component id as words, where the record names a part only by id (payment-worker → Payment worker). */
const partLabel = (id: string) => { const t = id.replace(/[-_]+/g, ' ').trim(); return t ? t[0].toUpperCase() + t.slice(1) : id; };

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
export function Words({ text, light, act }: { text: string; light(p: string[] | null): void; act?: DeskAct }) {
  const refs = (t: string, k0: number) => {
    const out: (string | h.JSX.Element)[] = [];
    const re = /\[([^|\]]+)\|([^\]]+)\]/g;
    let last = 0, m: RegExpExecArray | null;
    while ((m = re.exec(t))) {
      out.push(t.slice(last, m.index));
      const id = m[2];
      out.push(<span key={`${k0}:${m.index}`} class="nx-ref" onPointerEnter={() => light([id])} onPointerLeave={() => light(null)}>{m[1]}</span>);
      last = m.index + m[0].length;
    }
    out.push(t.slice(last));
    return out;
  };
  return <>{withTokens(text, refs, act)}</>;
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
  if (p.depth === 'focus') return <Focus {...p} />;
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

/** Coming back: one line for what changed while you were away. The details are in Home's Inbox. */
function SinceLine({ items, p }: { items: Attn[]; p: DeskProps }) {
  const info = items.filter((x) => x.kind === 'info');
  if (!info.length) return null;
  return (
    <div class="nx-sinceline" role="status">
      <span><b>{p.rec.since ? `Since ${p.rec.since.lastHere.split(',')[0]}` : 'While you were away'}</b> · {info.length} change{info.length > 1 ? 's' : ''}: {info[0].text}{info.length > 1 ? '…' : ''}</span>
      <button type="button" class="nx-textbtn" onClick={() => { location.hash = '#/home'; }}>See all</button>
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
/* ---------------- Full screen: Focus.tsx; the pieces it shares with the Desk ---------------- */

/** The assistant's displayed name. Owners rename it for the workspace; everyone else sees who renamed it to what. */
export function AgentName({ p }: { p: DeskProps }) {
  const { agentName } = useNames();
  const [editing, setEditing] = useState(false);
  const owner = p.role === 'owner';
  if (!p.rec.vowe) return null;
  return (
    <span class="nx-agentname">
      <i class="nx-agentmark"></i>
      {editing ? (
        <input type="text" aria-label="Assistant name" maxLength={32} value={agentName()} autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') { p.act.renameAgent(e.currentTarget.value.trim()); setEditing(false); }
            if (e.key === 'Escape') setEditing(false);
          }} onBlur={() => setEditing(false)} />
      ) : owner ? (
        <button type="button" class="nx-textbtn" title="Rename the assistant for this workspace" onClick={() => setEditing(true)}>{agentName()}</button>
      ) : <span title="Only the room’s owner can rename the assistant">{agentName()}</span>}
    </span>
  );
}

/** A conversation at full width: the thread, what it's about on the canvas, and what it led to. */
export function FsThread({ t, p }: { t: Thread; p: DeskProps }) {
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
            : <><p class="nx-quiet">Nothing yet.</p><button type="button" class="nx-btn" disabled={!mayWrite(p.role)} onClick={() => act.draftFrom(t.id)}>Start a decision from this</button></>}
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
        <MentionField p={p} placeholder={focus ? `Start a thread on ${focus.name}…` : 'Start a thread about the system…'} value={draft}
          onInput={setDraft} onSubmit={(t) => { act.newThread(t); setDraft(''); }} />
      </label>
      <div class="nx-dfilter"><button type="button" class={!p.everywhere ? 'on' : ''} onClick={() => act.everywhere(false)}>About the system</button><button type="button" class={p.everywhere ? 'on' : ''} onClick={() => act.everywhere(true)}>Everywhere<em>{all.length}</em></button>{!p.everywhere && elsewhere ? <span>{elsewhere} on decisions, plans and PRs live there</span> : null}</div>
      <span class="nx-hint2">{focus ? `It will be pinned to ${focus.name}.` : 'Select a part first to pin the thread to it.'}{rec.vowe ? ` ${agentName()} only joins if you @mention it.` : ''}</span>
      {open.length === 0 ? <p class="nx-quiet">No conversations yet.</p> : <ThreadList threads={shown} rel={rel} p={p} />}
    </section>
  );
}

/** What a thread is about, as one key: threads with the same key share a group. */
const aboutKey = (a: About) => `${a.kind}:${'decision' in a ? a.decision : 'work' in a ? a.work : 'pr' in a ? a.pr : ''}:${a.id}`;
const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
/** "2 replies · 4m": the time only when the record has one. */
const repliesLine = (t: Thread) => { const n = t.replies.length - 1, ago = t.replies[n].ago; return `${n} ${n === 1 ? 'reply' : 'replies'}${ago ? ` · ${ago}` : ''}`; };

/**
 * Discuss's conversations as a grouped list, the way macOS lists things: one rounded box for each part (or wire,
 * PR, decision) with its conversations as rows split by hairlines, under a heading whose chevron folds the box.
 * A click selects a row and opens its replies under it. With a row focused, ↑ and ↓ move, → and ← open and close
 * the replies (← again folds the group), Return toggles, Esc closes; right-click (or Shift-F10) gives its menu.
 * Groups the canvas focus doesn't touch start folded.
 */
function ThreadList({ threads, rel, p }: { threads: Thread[]; rel(t: Thread): boolean; p: DeskProps }) {
  const { me, act, rec } = p;
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const [sel, setSel] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ t: Thread; x: number; y: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const groups: { key: string; about: About; list: Thread[]; dim: boolean }[] = [];
  for (const t of threads) {
    const key = aboutKey(t.about);
    let g = groups.find((x) => x.key === key);
    if (!g) groups.push(g = { key, about: t.about, list: [], dim: !rel(t) });
    g.list.push(t);
  }
  const isOpen = (g: typeof groups[number]) => !(folded[g.key] ?? (g.dim && !g.list.some((t) => t.id === p.openThread)));
  const fold = (key: string, on: boolean) => setFolded((f) => ({ ...f, [key]: on }));
  const rows = groups.flatMap((g) => isOpen(g) ? g.list : []);
  const focusRow = (id: string) => box.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"] > .nx-dl-main`)?.focus();
  const openMenu = (t: Thread, x: number, y: number) => { setSel(t.id); setMenu({ t, x, y }); };

  const key = (e: KeyboardEvent) => {
    if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey || menu) return;
    const row = (e.target as HTMLElement).closest<HTMLElement>('.nx-dl-row');
    const t = row ? rows.find((x) => x.id === row.dataset.id) : undefined;
    if (!t) return;
    const open = p.openThread === t.id;
    const k = e.key;
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      e.preventDefault();
      const next = rows[rows.indexOf(t) + (k === 'ArrowDown' ? 1 : -1)];
      if (next) { setSel(next.id); focusRow(next.id); }
    } else if (k === 'ArrowRight' && !open) { e.preventDefault(); act.thread(t.id); }
    else if (k === 'ArrowLeft') {
      e.preventDefault();
      if (open) act.thread(null);
      else { fold(aboutKey(t.about), true); setSel(null); box.current?.querySelector<HTMLElement>(`[data-group="${CSS.escape(aboutKey(t.about))}"]`)?.focus(); }
    } else if (k === 'Escape' && open) { e.preventDefault(); act.thread(null); }
    else if (k === 'F10' && e.shiftKey || k === 'ContextMenu') {
      e.preventDefault();
      const r = (e.target as HTMLElement).getBoundingClientRect();
      openMenu(t, r.left + 24, r.top + 24);
    }
  };

  return (
    <div class="nx-dlist" ref={box} onKeyDown={key}>
      {groups.map((g) => {
        const o = isOpen(g);
        const parts = partsOf(g.about, rec);
        return (
          <div key={g.key} class={'nx-dl' + (g.dim ? ' nx-dim' : '')}>
            <button type="button" class="nx-dl-head" data-group={g.key} aria-expanded={o} onClick={() => fold(g.key, o)}
              onPointerEnter={() => act.light(parts)} onPointerLeave={() => act.light(null)}
              onKeyDown={(e) => { if (e.key === 'ArrowRight' && !o) { e.preventDefault(); fold(g.key, false); } else if (e.key === 'ArrowLeft' && o) { e.preventDefault(); fold(g.key, true); } }}>
              <span class="nx-dl-chev" aria-hidden="true"><Icon name="chevron-r" size={14} /></span>
              <AboutGlyph a={g.about.kind} />
              <span class="nx-dl-name">{g.about.name}</span>
              {ABOUT_WORD[g.about.kind] ? <span class="nx-akind">on {ABOUT_WORD[g.about.kind]}</span> : null}
              {g.list.some((t) => t.waiting === me) ? <span class="nx-waits">Waiting on you</span> : null}
              {g.list.length > 1 || !o ? <span class="nx-dl-n">{g.list.length}</span> : null}
            </button>
            {o ? (
              <div class="nx-dl-box" role="list" aria-label={g.about.name}>
                {g.list.map((t) => (
                  <ThreadRow key={t.id} t={t} p={p} selected={sel === t.id} onSelect={() => setSel(t.id)}
                    onMenu={(e) => { e.preventDefault(); focusRow(t.id); openMenu(t, e.clientX, e.clientY); }} />
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
      {menu ? <ThreadMenu t={menu.t} p={p} at={menu} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}

/** One conversation in the list: who started it, what they said, how far it got; its replies open under it. */
function ThreadRow({ t, p, selected, onSelect, onMenu }: { t: Thread; p: DeskProps; selected: boolean; onSelect(): void; onMenu(e: MouseEvent): void }) {
  const { nameOf, agentName } = useNames();
  const { me, act } = p;
  const expanded = p.openThread === t.id;
  const root = t.replies[0];
  const offer = t.replies.find((r) => r.offer?.state === 'open');
  return (
    <div role="listitem" data-id={t.id} onContextMenu={onMenu}
      class={'nx-dl-row' + (selected ? ' is-sel' : '') + (expanded ? ' is-open' : '') + (p.flash === `thread:${t.id}` ? ' nx-flash' : '')}>
      <button type="button" class="nx-dl-main" aria-expanded={expanded} onFocus={onSelect} onClick={() => { onSelect(); act.thread(expanded ? null : t.id); }}>
        <span class="rp-cm-head">
          <Who id={root.by} /><b>{root.by === me ? 'You' : nameOf(root.by)}</b>
          {t.title ? <span class="nx-dl-title">{t.title}</span> : null}
          <span class="rp-cm-time">{root.ago}</span>
        </span>
        <span class="rp-cm-body"><Words text={root.body} light={act.light} act={act} /></span>
        {root.evidence ? <Evidence ids={root.evidence} /> : null}
        <span class="nx-dl-meta">
          {t.replies.length > 1 ? <span class="rp-cm-replies"><span class="rp-avstack">{[...new Set(t.replies.slice(1).map((r) => r.by))].map((id) => <Who key={id} id={id} size={16} />)}</span>{repliesLine(t)}</span> : <span class="rp-cm-replies rp-quiet">No replies</span>}
          {root.spoken ? <span class="nx-spoken">said in the call</span> : null}
          {t.presence ? <span class="rp-pres rp-busy"><Who id={t.presence.personId} size={16} />{nameOf(t.presence.personId)} is {t.presence.mode === 'typing' ? 'writing' : 'reading'}</span> : offer && !expanded ? <span class="nx-offer-tag">{agentName()} suggests a decision</span> : null}
        </span>
      </button>
      {expanded ? <ThreadReplies t={t} p={p} /> : null}
    </div>
  );
}

/** A conversation's right-click menu, in the app's menu style; focus moves in, Esc or a click outside closes it. */
function ThreadMenu({ t, p, at, onClose }: { t: Thread; p: DeskProps; at: { x: number; y: number }; onClose(): void }) {
  const { act, rec } = p;
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); back?.focus(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation();
        const items = [...(box.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
        const i = items.indexOf(document.activeElement as HTMLElement);
        items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
      }
    };
    const down = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) onClose(); };
    addEventListener('keydown', key, true);
    addEventListener('pointerdown', down, true);
    return () => { removeEventListener('keydown', key, true); removeEventListener('pointerdown', down, true); };
  }, []);
  const parts = partsOf(t.about, rec);
  const plain = t.replies[0].body.replace(/\[([^|\]]+)\|[^\]]+\]/g, '$1');
  const item = (icon: IconName, label: string, f: () => void, disabled = false) => (
    <button type="button" role="menuitem" class="v-menu-item" disabled={disabled} onClick={() => { onClose(); f(); }}><Icon name={icon} /><span>{label}</span></button>
  );
  const reply = () => {
    act.thread(t.id);
    requestAnimationFrame(() => document.querySelector<HTMLInputElement>(`[data-id="${CSS.escape(t.id)}"] .rp-cm-reply input`)?.focus());
  };
  return (
    <div ref={box} class="v-menu nx-dl-menu" role="menu" aria-label={t.about.name}
      style={`left:${Math.min(at.x, innerWidth - 236)}px;top:${Math.min(at.y, innerHeight - 170)}px`}>
      {item('comment', 'Reply', reply)}
      {parts.length ? item('canvas', 'Show on canvas', () => act.light(parts)) : null}
      {item('copy', 'Copy text', () => { void navigator.clipboard.writeText(plain).then(() => act.toast('Copied')); })}
      <div class="v-menu-sep" role="separator" />
      {item('decision', 'Start a decision from this', () => act.draftFrom(t.id), !mayWrite(p.role))}
    </div>
  );
}

export function ThreadCard({ t, p, dim, inline }: { t: Thread; p: DeskProps; dim?: boolean; inline?: boolean }) {
  const { nameOf, agentName } = useNames();
  const { rec, me, act } = p;
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
            <span class="rp-cm-body"><Words text={root.body} light={act.light} act={act} /></span>
            {root.evidence ? <Evidence ids={root.evidence} /> : null}
          </button>
          <div class="rp-cm-foot">
            {t.replies.length > 1 ? <span class="rp-cm-replies"><span class="rp-avstack">{[...new Set(t.replies.slice(1).map((r) => r.by))].map((id) => <Who key={id} id={id} size={16} />)}</span>{repliesLine(t)}</span> : <span class="rp-cm-replies rp-quiet">No replies</span>}
            {t.presence ? <span class="rp-pres rp-busy"><Who id={t.presence.personId} size={16} />{nameOf(t.presence.personId)} is {t.presence.mode === 'typing' ? 'writing' : 'reading'}</span> : offer && !expanded ? <span class="nx-offer-tag">{agentName()} suggests a decision</span> : null}
          </div>
          {expanded ? <ThreadReplies t={t} p={p} /> : null}
        </div>
      </div>
    </div>
  );
}

/** An open conversation's replies, someone writing, the reply field and where it points. */
function ThreadReplies({ t, p }: { t: Thread; p: DeskProps }) {
  const { agentName } = useNames();
  const { rec, me, act } = p;
  const [text, setText] = useState('');
  const parts = partsOf(t.about, rec);
  return (
    <div class="rp-cm-thread">
      {t.replies.slice(1).map((r) => <ReplyRow key={r.id} r={r} t={t} p={p} />)}
      {t.presence?.mode === 'typing' ? <div class="rp-cm-typing"><Who id={t.presence.personId} /><span class="rp-bubble"><span class="rp-dots"><i /><i /><i /></span></span></div> : null}
      <label class="rp-cm-reply">
        <Who id={me} /><span class="rp-sr">Reply</span>
        <MentionField p={p} placeholder={rec.vowe ? `Reply, @${agentName()} to ask it, or just say it on the call` : 'Reply, or @ someone in the room'} value={text}
          onInput={setText} onSubmit={(b) => { act.reply(t.id, b); setText(''); }} />
      </label>
      <span class="nx-thread-foot">
        {parts.length ? <button class="rp-link" type="button" onClick={() => act.light(parts)}>Show on canvas</button> : null}
        {t.linked?.map((l, i) => <span key={i} class="nx-linked"><AboutGlyph a={l.kind} />also on {l.name}</span>)}
      </span>
    </div>
  );
}

function ReplyRow({ r, t, p }: { r: Reply; t: Thread; p: DeskProps }) {
  const { nameOf } = useNames();
  const { me, act } = p;
  return (
    <div class={`rp-cm-r${r.fresh ? ' rp-fresh' : ''}${r.by === AGENT ? ' nx-vowe-r' : ''}`}>
      <span class="rp-cm-head"><Who id={r.by} /><b>{r.by === me ? 'You' : nameOf(r.by)}</b><span class="rp-cm-time">{r.ago}</span>{r.spoken ? <span class="nx-spoken">said in the call</span> : null}</span>
      <span class="rp-cm-body" onPointerEnter={() => r.points && act.light(r.points)} onPointerLeave={() => r.points && act.light(null)}><Words text={r.body} light={act.light} act={act} /></span>
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

export function NewDecision({ p, done, from }: { p: DeskProps; done(): void; from?: Thread }) {
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

export function DecideEmpty({ p, write }: { p: DeskProps; write(): void }) {
  const { nameOf } = useNames();
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
          <button type="button" class="nx-textbtn strong" onClick={() => act.draftFrom(t.id)}>Start a draft from this</button>
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
          {ready.map((d) => <div key={d.id} class="nx-empty2-row"><span><b>{d.title}</b> · v{d.version}</span><button type="button" class="nx-textbtn strong" onClick={() => act.prepareWork(d.id)}>Plan it</button></div>)}
        </div>
      ) : null}
      {list.map((w) => <ObjectiveCard key={w.id} w={w} p={p} dim={!rel(w)} />)}
      {list.length && !composing ? <button type="button" class="nx-textbtn add" disabled={!mayWrite(p.role)} onClick={() => setComposing(true)}>+ New work</button> : null}
    </section>
  );
}

export function NewWork({ p, done }: { p: DeskProps; done(): void }) {
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
          <span class="nx-q-h">{w.question.deferred ? 'Deferred' : `${w.doer?.name ?? 'The agent'} asks ${w.question.for === me ? 'you' : nameOf(w.question.for)}`} · about <button type="button" class="nx-inl" onClick={() => act.light([w.question!.about])}>{partLabel(w.question.about)}</button></span>
          <p>{w.question.text}</p>
          <span class="nx-qopts">{w.question.options.map((o) => <button key={o} type="button" class="rp-mini" onClick={() => act.answer(w.id, o)}>{o}</button>)}</span>
          <label class="rp-cm-reply nx-q-in"><span class="rp-sr">Answer</span><input type="text" placeholder="Or answer in your own words…" value={ans} onInput={(e) => setAns(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter' && ans.trim()) { act.answer(w.id, ans.trim()); setAns(''); } }} /></label>
          <span class="nx-q-more"><button type="button" class="rp-link" onClick={() => act.discussQuestion(w.id)}>Discuss in a thread</button>{!w.question.deferred ? <button type="button" class="rp-link" onClick={() => act.defer(w.id)}>Defer; it can keep going on other steps</button> : null}</span>
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
