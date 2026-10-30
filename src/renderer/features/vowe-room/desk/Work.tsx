import { h, Fragment, useState } from '../journey.js';
import { BasisGlyph } from '../canvas/faces.js';
import type { PR, VoweRecord, Work } from '../contracts/model.js';
import { approvedOf, isDraft, openChanges } from '../state/plan.js';
import type { WorkSection } from '../state/ui.js';
import { Evidence, PR_STATE, ThreadCard, Who, WorkCard, type DeskProps } from './Desk.js';
import { PlanDoc } from './PlanDoc.js';
import { useNames } from '../state/directory.js';
import { mayWrite } from '../state/permissions.js';

// Work, refined: an objective that owns a versioned plan, the runs that execute an approved version,
// the PRs those runs produce, and the outcome a person signs off. The compact card shows one row for each;
// the widened Desk opens the same object on the section you clicked.

/* ---------------- shared ---------------- */

const SECTION: Record<WorkSection, string> = { plan: 'Plan', run: 'Run', prs: 'Pull requests', outcome: 'Outcome' };
const Chev = () => <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M6 4l4 4-4 4" /></svg>;
const Lock = () => <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 015 0v2" /></svg>;
const Ext = () => <span class="nx-ext" aria-label="opens outside Vowe">↗</span>;

const WORK_LABEL: Partial<Record<Work['state'], string>> = { running: 'Running', waiting: 'Waiting on you' };

export function objectiveState(w: Work, rec: VoweRecord, me: string): { k: string; label: string } {
  if (w.state === 'resolved') return { k: 'resolved', label: 'Resolved' };
  if (w.state === 'closed') return { k: 'closed', label: 'Closed' };
  const q = w.question && !w.question.answer && !w.question.deferred && w.question.for === me;
  if (q || w.scopeAsk) return { k: 'waiting', label: 'Needs you' };
  if (openChanges(w).length) return { k: 'proposed', label: 'Planning · suggestions' };
  if (w.state === 'proposed') return { k: 'proposed', label: w.blocks ? 'Planned with ' + (rec.work.find((x) => x.id === w.blocks)?.title ?? '') : 'Planning' };
  if (w.state === 'review') return { k: 'review', label: w.prs.every((p) => p.state === 'merged' || p.state === 'closed') ? 'Ready to resolve' : 'In review' };
  if (w.state === 'draft') return { k: 'proposed', label: 'Draft plan' };
  const run = w.runs[w.runs.length - 1];
  if (run?.state === 'stopped') return { k: 'review', label: 'In review' };
  const dep = w.dependsOn ? rec.work.find((x) => x.id === w.dependsOn) : undefined;
  const waits = dep && dep.state !== 'resolved' && dep.prs.every((p) => p.state !== 'merged') ? ` · waits on ${dep.title}` : '';
  // Only a run that's going is "running"; an authorized plan nobody has started says so.
  if (!run || run.state === 'finished') return { k: 'proposed', label: (w.state === 'authorized' ? 'Authorized · not started' : WORK_LABEL[w.state] ?? 'Planned') + waits };
  return { k: 'running', label: 'Running' + waits };
}

/** Where a PR stands, the way GitHub groups them. */
export type PrBucket = 'open' | 'draft' | 'merged' | 'closed';
/** The PR's page: its own url, or github.com/<repo>/pull/<num> for a github.com repo. Nothing for other forges. */
export const prUrl = (w: Work, pr: PR): string | null => pr.url ?? (/^github\.com\/[\w.-]+\/[\w.-]+$/.test(w.repo) ? `https://${w.repo}/pull/${pr.num}` : null);
export const bucketOf = (pr: PR): PrBucket => pr.state === 'merged' ? 'merged' : pr.state === 'closed' ? 'closed' : pr.state === 'draft' ? 'draft' : 'open';
const BUCKET_WORD: Record<PrBucket, string> = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' };

/** The pull request mark, drawn for each state: open, draft (dashed), merged, closed. */
export function PrIcon({ b, size = 14 }: { b: PrBucket; size?: number }) {
  return (
    <svg class={'nx-pri ' + b} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-label={BUCKET_WORD[b] + ' pull request'}>
      {b === 'merged' ? (
        <><circle cx="4.5" cy="3.5" r="1.6" /><circle cx="4.5" cy="12.5" r="1.6" /><circle cx="11.5" cy="9" r="1.6" /><path d="M4.5 5.1v5.8M4.5 5.6c0 2.2 2.4 3.4 5.4 3.4" /></>
      ) : (
        <>
          <circle cx="4.5" cy="3.5" r="1.6" /><circle cx="4.5" cy="12.5" r="1.6" />
          <path d="M4.5 5.1v5.8" stroke-dasharray={b === 'draft' ? '1.6 1.6' : undefined} />
          {b === 'closed' ? <path d="M10 2.5l3 3M13 2.5l-3 3M11.5 8v2.9" /> : <><circle cx="11.5" cy="12.5" r="1.6" /><path d="M11.5 10.9V7c0-1.3-.9-2.2-2.2-2.2H7.5" stroke-dasharray={b === 'draft' ? '1.6 1.6' : undefined} /><path d="M8.8 3.3L7.3 4.8l1.5 1.5" /></>}
        </>
      )}
    </svg>
  );
}

/** Counts by state, like GitHub's: open, draft, merged, closed. Used on cards and as the PR view's filter. */
export function PrCounts({ prs, on, pick }: { prs: PR[]; on?: PrBucket | 'all'; pick?(b: PrBucket | 'all'): void }) {
  const n = (b: PrBucket) => prs.filter((x) => bucketOf(x) === b).length;
  const bs = (['open', 'draft', 'merged', 'closed'] as PrBucket[]).filter((b) => n(b) || pick);
  return (
    <span class={'nx-prcounts' + (pick ? ' filter' : '')} role={pick ? 'tablist' : undefined}>
      {pick ? <button type="button" role="tab" aria-selected={on === 'all'} class={on === 'all' ? 'on' : ''} onClick={() => pick('all')}>All <em>{prs.length}</em></button> : null}
      {bs.map((b) => pick
        ? <button key={b} type="button" role="tab" aria-selected={on === b} class={(on === b ? 'on ' : '') + b} disabled={!n(b)} onClick={() => pick(b)}><PrIcon b={b} />{BUCKET_WORD[b]} <em>{n(b)}</em></button>
        : <span key={b} class={'nx-prc ' + b} title={`${n(b)} ${BUCKET_WORD[b].toLowerCase()}`}><PrIcon b={b} />{n(b)}</span>)}
    </span>
  );
}

/* ---------------- the compact card ---------------- */

export function ObjectiveCard({ w, p, dim }: { w: Work; p: DeskProps; dim?: boolean }) {
  const { nameOf, agentName } = useNames();
  const { rec, me, act } = p;
  const st = objectiveState(w, rec, me);
  const ap = approvedOf(w);
  const oc = openChanges(w);
  const done = w.plan.filter((s) => s.state === 'done').length;
  const run = w.runs[w.runs.length - 1];
  const dec = rec.decisions.find((d) => d.id === w.decision);
  const dep = rec.work.find((x) => x.id === w.dependsOn);
  const blocks = rec.work.find((x) => x.id === w.blocks);
  const open = (section: WorkSection) => act.inspect({ kind: 'work', id: w.id, section });
  const last = run?.events[run.events.length - 1];
  const needs = (w.question && !w.question.answer) || w.scopeAsk || w.finding;
  return (
    <div class={'rp-stream nx-work nx-obj ' + st.k + (dim ? ' nx-dim' : '') + (p.flash === `work:${w.id}` ? ' nx-flash' : '')} onPointerEnter={() => act.light(w.parts)} onPointerLeave={() => act.light(null)}>
      <div class="nx-w-top">
        <span class="nx-w-t">{w.title}</span>
        <span class={'nx-st2 ' + st.k}>{st.label}</span>
        <button type="button" class="rp-dc-open nx-open" onClick={() => open(oc.length || w.state === 'proposed' ? 'plan' : needs ? 'run' : 'plan')}>Open<Chev /></button>
      </div>
      <span class="nx-w-meta">
        {dec ? <>From <button type="button" class="nx-inl" onClick={() => act.inspect({ kind: 'decision', id: dec.id })}>decision v{dec.version}</button> · </> : null}
        owner {w.owner === me ? 'you' : nameOf(w.owner)}
        {dep ? <> · {dep.state === 'resolved' ? 'after' : 'waits for'} <button type="button" class="nx-inl" onClick={() => act.inspect({ kind: 'work', id: dep.id, section: 'plan' })}>{dep.title}</button>{dep.state === 'resolved' ? ' ✓' : ''}</> : null}
        {blocks && w.state !== 'resolved' ? <> · <b class="nx-blocks">{blocks.title} waits for this</b></> : null}
      </span>
      <div class="nx-orows">
        <button type="button" class="nx-orow" onClick={() => open('plan')}>
          <span class="nx-ok">Plan</span>
          <span class="nx-ov">
            {oc.length ? <><b class="nx-vchip draft">v{w.version} draft</b>{rec.vowe ? `${agentName()} suggests` : 'Suggested:'} {oc.length} change{oc.length > 1 ? 's' : ''}</>
              : ap && ap.version === w.version ? <><b class="nx-vchip ok"><Lock />v{ap.version}</b>approved by {ap.approved!.by === me ? 'you' : nameOf(ap.approved!.by)} · {done}/{w.plan.length} step{w.plan.length === 1 ? "" : "s"}</>
              : ap ? <><b class="nx-vchip draft">v{w.version} draft</b>{w.doer?.name} still runs v{ap.version}</>
              : <><b class="nx-vchip draft">v{w.version}{isDraft(w) ? ' draft' : ''}</b>{w.plan.length} step{w.plan.length === 1 ? "" : "s"} · not authorized</>}
          </span>
        </button>
        {run || w.doer?.kind === 'person' ? (
          <button type="button" class="nx-orow" onClick={() => open('run')}>
            <span class="nx-ok">Run</span>
            <span class="nx-ov">{run ? <><span class={'nx-rdot ' + run.state}></span>{run.agent} · plan v{run.plan} · {run.state}{last && run.state !== 'finished' ? <em class="nx-olast"><BasisGlyph b="observed" />{last.text}</em> : null}</> : <>{w.doer?.name} · {w.state === 'proposed' || w.state === 'draft' || w.state === 'authorized' ? 'not started' : WORK_LABEL[w.state]?.toLowerCase() ?? w.state}</>}</span>
          </button>
        ) : null}
        {w.prs.length ? (
          <button type="button" class="nx-orow" onClick={() => open('prs')}>
            <span class="nx-ok">PRs</span>
            <span class="nx-ov nx-prmini">{w.prs.map((pr) => <span key={pr.id} class={'nx-pm ' + bucketOf(pr)} title={`#${pr.num} · ${PR_STATE[pr.state]}`}><PrIcon b={bucketOf(pr)} size={12} />#{pr.num}{pr.checks.some((c) => c.state === 'fail') ? <em class="bad">×</em> : null}</span>)}</span>
          </button>
        ) : null}
        {w.state === 'resolved' || (w.state === 'review' && w.prs.every((x) => x.state === 'merged' || x.state === 'closed')) ? (
          <button type="button" class="nx-orow" onClick={() => open('outcome')}>
            <span class="nx-ok">Outcome</span>
            <span class="nx-ov">{w.resolved ? `✓ Resolved by ${w.resolved.by === me ? 'you' : nameOf(w.resolved.by)}` : `${w.accept.length} of ${w.accept.length} checks met · waiting for a person to resolve`}</span>
          </button>
        ) : null}
      </div>
      {needs ? <WorkCard w={w} p={p} bare /> : null}
      {w.state === 'review' && !w.resolved && w.prs.every((x) => x.state === 'merged' || x.state === 'closed') ? <div class="rp-stream-acts nx-w-acts"><button class="nx-btn primary" type="button" onClick={() => act.resolve(w.id)}>Mark resolved</button></div> : null}
    </div>
  );
}

/* ---------------- the widened Work view ---------------- */

export function WorkView({ w, p }: { w: Work; p: DeskProps }) {
  const { act, inspect, rec } = p;
  const sec: WorkSection = (inspect && inspect.kind === 'work' && inspect.section) || (inspect && 'pr' in inspect && inspect.pr ? 'prs' : 'plan');
  const st = objectiveState(w, rec, p.me);
  const has: Record<WorkSection, boolean> = { plan: true, run: !!w.runs.length || w.doer?.kind === 'person', prs: !!w.prs.length, outcome: w.state === 'review' || w.state === 'resolved' };
  return (
    <div class="nx-wv">
      <div class="nx-wv-head">
        {sec !== 'plan' ? <h3>{w.title}</h3> : null}
        <nav class="nx-wv-tabs" aria-label="Work sections">
          {(['plan', 'run', 'prs', 'outcome'] as WorkSection[]).map((s) => (
            <button key={s} type="button" class={sec === s ? 'on' : ''} disabled={!has[s]} title={has[s] ? '' : s === 'run' ? 'Nothing has run yet' : s === 'prs' ? 'No pull requests yet' : 'Not finished yet'} onClick={() => act.inspect({ kind: 'work', id: w.id, section: s })}>
              {SECTION[s]}{s === 'prs' && w.prs.length ? <em>{w.prs.length + (rec.work.find((x) => x.id === w.dependsOn)?.prs.length ?? 0)}</em> : null}{s === 'plan' && openChanges(w).length ? <i class="nx-tabdot"></i> : null}{s === 'run' && w.question && !w.question.answer ? <i class="nx-tabdot"></i> : null}
            </button>
          ))}
        </nav>
        <span class={'nx-st2 ' + st.k}>{st.label}</span>
      </div>
      {sec === 'plan' ? <PlanDoc w={w} p={p} /> : sec === 'run' ? <RunView w={w} p={p} /> : sec === 'prs' ? <PrStack w={w} p={p} /> : <Outcome w={w} p={p} />}
    </div>
  );
}

/* ---------------- run ---------------- */

const EV_GLYPH: Record<string, string> = { read: '◌', edit: '✎', test: '✓', git: '⎇', ask: '?', fail: '×' };

function RunView({ w, p }: { w: Work; p: DeskProps }) {
  const { nameOf } = useNames();
  const { act, me } = p;
  const run = w.runs[w.runs.length - 1];
  const ap = approvedOf(w);
  const v = run ? w.versions.find((x) => x.version === run.plan) : ap;
  const steps = v?.body.plan ?? w.plan;
  if (!run && w.doer?.kind === 'person') {
    return (
      <div class="nx-pe-cols narrow"><div class="nx-ped">
        <div class="nx-runhead"><b>{w.doer.name} is doing this work</b><span>from plan v{ap?.version ?? w.version}{ap ? <> · handed over by {nameOf(ap.approved!.by)}</> : null}</span></div>
        <p class="nx-honest">No agent: the steps are marked by whoever does them, and PRs are linked by hand until the GitHub integration exists.</p>
        <ol class="nx-steps">{w.plan.map((s, i) => (
          <li key={s.id} class={'nx-ps ' + s.state}><span class="nx-ps-h"></span><span class="nx-si">{s.state === 'done' ? '✓' : i + 1}</span><div class="nx-ps-b"><span class="nx-ps-t">{s.text}</span><span class="nx-ps-meta">{s.pr ? <span class="nx-spr">{s.pr}</span> : null}{s.state !== 'done' ? <button type="button" class="rp-link" onClick={() => act.plan(w.id, { op: 'state', step: s.id, state: 'done' })}>Mark done</button> : <span>done</span>}</span></div></li>
        ))}</ol>
      </div></div>
    );
  }
  if (!run) return <p class="nx-empty">Nothing has run. Authorize the plan to start a run.</p>;
  return (
    <div class={'nx-pe-cols' + (p.narrow ? ' narrow' : '')}>
      <div class="nx-ped">
        <div class="nx-runhead">
          <span class={'nx-rdot ' + run.state}></span><b>{run.agent}</b><span>· {run.state} · in {run.where}</span>
          <span class="nx-vchip ok"><Lock />plan v{run.plan}</span>
          {ap && ap.version !== run.plan ? <span class="nx-vchip draft">v{ap.version} approved; switches at next step</span> : null}
        </div>
        <span class="nx-w-meta">Authorized by {ap?.approved?.by === me ? 'you' : nameOf(ap?.approved?.by ?? '')} · {ap?.approved?.scope}</span>
        <div class="nx-runacts">
          {run.url ? <button type="button" class="nx-btn" onClick={() => act.openExternal(run.url!)}>Open the session<Ext /></button> : null}
          {p.caps.agentRuns && (run.state === 'running' || run.state === 'waiting') ? <button type="button" class="nx-btn" onClick={() => act.stopRun(w.id)}>Stop after this step</button> : null}
        </div>
        <h5 class="nx-h5">Steps of v{run.plan}</h5>
        <ol class="nx-steps ro">{steps.map((s, i) => {
          const cur = w.plan.find((x) => x.id === s.id) ?? s;
          return <li key={s.id} class={'nx-ps ' + cur.state}><span class="nx-ps-h"></span><span class="nx-si">{cur.state === 'done' ? '✓' : i + 1}</span><div class="nx-ps-b"><span class="nx-ps-t">{s.text}</span><span class="nx-ps-meta">{cur.pr ? <span class="nx-spr">{cur.pr}</span> : null}{cur.state === 'doing' ? <span class="nx-doing"><span class={'nx-rdot ' + run.state}></span>now</span> : null}{s.promoted ? <span>its own work item</span> : null}</span></div></li>;
        })}</ol>
        <h5 class="nx-h5">What it was seen doing<em>observed events only, newest first</em></h5>
        <ul class="nx-evlog">{[...run.events].reverse().map((e, i) => <li key={i} class={e.kind ?? ''}><i>{EV_GLYPH[e.kind ?? 'read']}</i><span>{e.text}</span><em>{e.ago}</em></li>)}</ul>
      </div>
      <div class="nx-pside">
        {(w.question && !w.question.answer) || w.scopeAsk || w.finding ? <div class="nx-ins-sec"><span class="rp-rk">Needs attention</span><WorkCard w={w} p={p} bare /></div> : <div class="nx-ins-sec"><span class="rp-rk">Needs attention</span><p class="nx-quiet">Nothing. {run.agent} asks here when it hits a boundary or a question.</p></div>}
        {w.question?.answer ? <div class="nx-ins-sec"><span class="rp-rk">Answered</span><span class="nx-q-a"><Who id={w.question.answer.by} size={16} />{w.question.text.split('?')[0]}? <b>{w.question.answer.text}</b></span></div> : null}
      </div>
    </div>
  );
}

/* ---------------- PRs ---------------- */

function PrStack({ w, p }: { w: Work; p: DeskProps }) {
  const { nameOf } = useNames();
  const { act, rec } = p;
  const all = [...(rec.work.find((x) => x.id === w.dependsOn)?.prs ?? []), ...w.prs];
  const order: PR[] = [];
  const add = (pr: PR) => { if (!order.includes(pr)) order.push(pr); all.filter((x) => x.dependsOn === pr.num).forEach(add); };
  all.filter((x) => !x.dependsOn || !all.some((y) => y.num === x.dependsOn)).forEach(add);
  all.forEach(add);
  const [view, setView] = useState<PrBucket | 'all'>('all');
  const shown = order.filter((x) => view === 'all' || bucketOf(x) === view);
  const selId = p.inspect && 'pr' in p.inspect ? p.inspect.pr : undefined;
  const sel = shown.find((x) => x.id === selId) ?? shown.find((x) => x.checks.some((c) => c.state === 'fail') || x.state === 'changes') ?? shown[0];
  return (
    <div class={'nx-pe-cols' + (p.narrow ? ' narrow' : '')}>
      <div class="nx-ped">
        <PrCounts prs={all} on={view} pick={setView} />
        {p.caps.githubSync ? <p class="nx-honest nx-gh">As GitHub reports them. <b>GitHub owns this state</b>; Vowe links it to the plan, the decision and the canvas.</p> : <p class="nx-honest nx-gh">Linked in the room by hand. <b>Not synced from GitHub</b>: states and checks are as last entered.</p>}
        {!shown.length ? <p class="nx-quiet">No {view === 'all' ? '' : BUCKET_WORD[view as PrBucket].toLowerCase() + ' '}pull requests.</p> : null}
        <ol class={'nx-stack' + (view === 'all' ? '' : ' flat')}>
          {shown.map((pr) => {
            const f = pr.checks.filter((c) => c.state === 'fail');
            const own = w.prs.includes(pr);
            return (
              <li key={pr.id} class={'nx-sk ' + bucketOf(pr) + (f.length ? ' bad' : '') + (sel === pr ? ' on' : '')} onPointerEnter={() => act.light(pr.parts)} onPointerLeave={() => act.light(null)}>
                <i class="nx-sk-node"><PrIcon b={bucketOf(pr)} /></i>
                <button type="button" class="nx-sk-main" onClick={() => act.inspect({ kind: 'work', id: w.id, section: 'prs', pr: pr.id })}>
                  <span class="nx-sk-1"><b>#{pr.num}</b><span>{pr.title}</span><span class={'nx-prstate ' + bucketOf(pr)}><PrIcon b={bucketOf(pr)} size={12} />{bucketOf(pr) === 'open' && pr.state !== 'open' ? PR_STATE[pr.state] : BUCKET_WORD[bucketOf(pr)]}</span></span>
                  <span class="nx-sk-2"><span class="nx-mono">{pr.branch}</span>{pr.dependsOn ? <span>on top of #{pr.dependsOn}</span> : <span>on main</span>}{!own ? <span>from {rec.work.find((x) => x.prs.includes(pr))?.title}</span> : pr.step ? <span>step {w.plan.findIndex((s) => s.id === pr.step) + 1 || '–'}</span> : null}{pr.supersededBy ? <span>replaced by #{pr.supersededBy}</span> : null}</span>
                  <span class="nx-sk-3">{pr.checks.map((c) => <span key={c.name} class={'nx-ckdot ' + c.state} title={`${c.name}: ${c.state}`}></span>)}{f.length ? <em class="bad">{f.map((c) => c.name).join(', ')} failing</em> : pr.checks.some((c) => c.state === 'running' || c.state === 'queued') ? <em>checks running</em> : null}{pr.review ? <em class={'nx-rv ' + pr.review.state}>{nameOf(pr.review.by)} {pr.review.state === 'requested' ? 'asked to review' : pr.review.state === 'changes' ? 'requested changes' : pr.review.state}</em> : null}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>
      <div class="nx-pside">{sel ? <PrDetail2 pr={sel} w={rec.work.find((x) => x.prs.includes(sel))!} p={p} /> : null}</div>
    </div>
  );
}

function PrDetail2({ pr, w, p }: { pr: PR; w: Work; p: DeskProps }) {
  const { nameOf } = useNames();
  const { act, rec } = p;
  const t = rec.threads.find((x) => (x.about.kind === 'pr' && x.about.id === pr.id) || (x.about.kind === 'check' && x.about.pr === pr.id));
  const run = w.runs[w.runs.length - 1];
  const canAsk = p.caps.agentRuns && run && run.state !== 'finished' && pr.state !== 'merged' && pr.state !== 'closed';
  return (
    <div class="nx-ins-sec nx-prd">
      <span class={'nx-prstate big ' + bucketOf(pr)}><PrIcon b={bucketOf(pr)} />{PR_STATE[pr.state]} · #{pr.num}</span>
      <b class="nx-prd-t">{pr.title}</b>
      <span class="nx-w-meta"><span class="nx-mono">{pr.branch}</span> · by {nameOf(pr.by)} · {pr.ago}</span>
      <div class="nx-checks2">
        {pr.checks.map((c) => (
          <div key={c.name} class={'nx-ck ' + c.state}>
            <span class="nx-ck-h"><i>{c.state === 'pass' ? '✓' : c.state === 'fail' ? '×' : '…'}</i><b>{c.name}</b>{c.took ? <em>{c.took}</em> : null}</span>
            {c.state === 'fail' ? (
              <>
                {c.detail ? <span class="nx-cd">{c.detail}</span> : null}
                {c.log ? <pre class="nx-log2">{c.log.join('\n')}</pre> : null}
                <span class="nx-ck-a">
                  <button type="button" class="nx-btn" onClick={() => act.discussCheck(w.id, pr.id, c.name)}>Discuss in the room</button>
                  {canAsk ? <button type="button" class="nx-btn" onClick={() => act.askFix(w.id, pr.id, c.name)}>Ask {run!.agent} to fix it</button> : null}
                  {c.url ? <button type="button" class="nx-btn" onClick={() => act.openExternal(c.url!)}>Full log<Ext /></button> : null}
                </span>
              </>
            ) : null}
          </div>
        ))}
      </div>
      <div class="nx-files">{pr.files.map((f) => <span key={f.path} class="nx-file"><code title={f.path}>{f.path}</code><em class="a">+{f.add}</em><em class="d">−{f.del}</em></span>)}</div>
      {pr.review ? <span class="nx-pr-rev"><Who id={pr.review.by} size={16} />{nameOf(pr.review.by)}: {pr.review.text ?? pr.review.state}</span> : null}
      <span class="nx-offer-a">
        {prUrl(w, pr) ? <button type="button" class="nx-btn" onClick={() => act.openExternal(prUrl(w, pr)!)}>Review on GitHub<Ext /></button> : null}
        <button type="button" class="nx-btn" onClick={() => { void navigator.clipboard?.writeText(`gh pr checkout ${pr.num}`).catch(() => {}); act.toast(`Copied: gh pr checkout ${pr.num}`); }}>Copy checkout command</button>
        <button type="button" class="nx-btn" onClick={() => act.show(pr.parts)}>Show on canvas</button>
      </span>
      {t ? <><span class="rp-rk nx-mt">Conversation in the room</span><ThreadCard t={t} p={p} inline /></> : null}
    </div>
  );
}

/* ---------------- outcome ---------------- */

function Outcome({ w, p }: { w: Work; p: DeskProps }) {
  const { nameOf } = useNames();
  const { act, me } = p;
  const ap = approvedOf(w);
  const all = w.prs.filter((x) => x.state !== 'closed');
  const met = all.length > 0 && all.every((x) => x.state === 'merged');
  return (
    <div class="nx-pe-cols narrow"><div class="nx-ped">
      <section class="nx-psec"><h4>Objective</h4><p class="nx-objtext">{w.why}</p></section>
      <section class="nx-psec"><h4>Verification<em>from plan v{ap?.version}</em></h4>
        <ul class="nx-verif">{(ap?.body.accept ?? w.accept).map((a) => <li key={a} class={met ? 'ok' : 'wait'}><i>{met ? '✓' : '…'}</i><span>{a}</span><em>{w.verifiedBy?.[a] ?? 'checked by a person'}</em></li>)}</ul>
      </section>
      {w.resolved ? <div class="nx-authd"><span><b>✓ Resolved</b> by {w.resolved.by === me ? 'you' : nameOf(w.resolved.by)} · {w.resolved.ago}{w.resolved.ack?.length ? ` · ${w.resolved.ack.map(nameOf).join(', ')} agreed` : ''}</span></div>
        : <div class="nx-authrow"><span class="nx-quiet">{met ? 'Every check passes. Resolving is a person’s call.' : 'Not everything has merged yet.'}</span><button class="nx-btn primary" type="button" disabled={!met || !mayWrite(p.role)} onClick={() => act.resolve(w.id)}>Mark resolved</button></div>}
    </div></div>
  );
}

export { Evidence };
