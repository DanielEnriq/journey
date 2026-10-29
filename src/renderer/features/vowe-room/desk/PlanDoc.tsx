import { h, Fragment, useEffect, useRef, useState } from '../journey.js';
import { BasisGlyph } from '../canvas/faces.js';
import { type Change, type PlanBody, type Step, type Thread, type Work } from '../contracts/model.js';
import { approvedOf, blockedWhy, isDraft, openChanges, widens, wordDiff } from '../state/plan.js';
import { ThreadCard, Who, type DeskProps } from './Desk.js';
import { By_, Diff, DocLayout, Ext, Lock, Prose, Proposed, Rich, Sec } from './Doc.js';
import { MentionField } from './Mention.js';
import { objectiveState } from './Work.js';
import { useNames } from '../state/directory.js';
import { useEvidence } from '../state/semantics.js';
import { mayWrite } from '../state/permissions.js';

// The plan as a technical specification. It reads like a document: a title, a state line, the objective,
// what it stands on, the steps, its boundaries and how it's verified. Execution sits at the end, summarized,
// with the exact context the coding agent will receive. Editing happens in place, keyboard first.

function stateLine(w: Work, me: string, agent: string, nameOf: (id: string) => string) {
  const ap = approvedOf(w);
  const who = (id: string) => (id === me ? 'you' : nameOf(id));
  const oc = openChanges(w);
  if (w.state === 'resolved') return { k: 'ok', text: <>v{ap?.version} · resolved by {who(w.resolved!.by)}</> };
  if (ap && ap.version === w.version && oc.length) return { k: 'prop', text: <>v{ap.version} approved · <b>v{w.version + 1} proposed</b> by {nameOf(w.revision!.by)} · {w.doer?.name ?? agent} keeps running v{ap.version}</> };
  if (ap && ap.version === w.version) return { k: 'ok', text: <><Lock /> v{ap.version} · approved by {who(ap.approved!.by)}, {ap.approved!.ago}{w.runs.some((r) => r.state !== 'finished' && r.plan === ap.version) ? <> · {w.doer?.name} is running it</> : null}</> };
  if (ap) return { k: 'draft', text: <><b>v{w.version} draft</b> · saved · {w.doer?.name} is still running v{ap.version} until v{w.version} is authorized</> };
  if (oc.length) return { k: 'prop', text: <><b>v{w.version} draft</b> · {oc.length} suggested change{oc.length > 1 ? 's' : ''} · not authorized</> };
  return { k: 'draft', text: <><b>v{w.version} draft</b> · saved · not authorized</> };
}

export function PlanDoc({ w, p }: { w: Work; p: DeskProps }) {
  const { nameOf, agentName } = useNames();
  const { rec, me, act } = p;
  const ap = approvedOf(w);
  const oc = openChanges(w);
  const live = !!ap && ap.version === w.version && !oc.length;
  const canEdit = mayWrite(p.role) && w.state !== 'resolved' && w.state !== 'closed' && !live;
  const canRevise = mayWrite(p.role) && live && w.state !== 'resolved';
  const passages = rec.threads.filter((t) => t.about.kind === 'step' && t.about.work === w.id);
  const activeT = p.inspect && p.inspect.kind === 'work' ? p.inspect.thread : undefined;
  const base: PlanBody | undefined = p.compare ? w.versions.find((v) => v.version === p.compare)?.body : undefined;
  const [sel, setSel] = useState<{ step: string; quote: string; x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const st = stateLine(w, me, agentName(), nameOf);
  const focusStep = (i: number) => { const el = root.current?.querySelectorAll<HTMLElement>('.nx-step .nx-step-t')[i]; el?.focus(); };
  const onUp = (s: Step) => {
    const g = window.getSelection(); const q = g?.toString().trim() ?? '';
    if (!q || q.length < 3 || !g?.rangeCount) { setSel(null); return; }
    const r = g.getRangeAt(0).getBoundingClientRect(); const host = root.current!.getBoundingClientRect();
    setSel({ step: s.id, quote: q, x: r.left - host.left + r.width / 2, y: r.top - host.top });
  };
  const adds = (after: string | null) => w.revision?.changes.filter((c) => c.kind === 'add' && c.after === after && c.state !== 'accepted') ?? [];
  const removedSince = base ? base.plan.filter((s) => !w.plan.some((x) => x.id === s.id)) : [];
  const outline = [
    { id: 'objective', label: 'Objective' }, { id: 'context', label: 'Context', note: String(w.context.length) },
    { id: 'approach', label: 'Approach', note: `${w.plan.length} steps` }, { id: 'bounds', label: 'Boundaries' },
    { id: 'verify', label: 'Verification' }, { id: 'exec', label: 'Execution', note: live ? 'approved' : 'not authorized' },
  ];
  return (
    <DocLayout p={p} outline={outline} docKey={'plan-' + w.id} rail={<PlanRail w={w} p={p} passages={passages} activeT={activeT} />}>
      <div class="nx-pdoc" ref={root} onPointerDown={(e) => { if (!(e.target as HTMLElement).closest('.nx-selbtn')) setSel(null); }}>
        <header class="nx-dhead">
          <span class="nx-eyebrow">Plan{w.blocks ? ` · part of ${rec.work.find((x) => x.id === w.blocks)?.title}` : ''}{w.dependsOn ? ` · after ${rec.work.find((x) => x.id === w.dependsOn)?.title}` : ''}</span>
          <h2>{w.title}</h2>
          <div class={'nx-stline ' + st.k}>{st.text}</div>
          <div class="nx-verline">
            {w.versions.map((v) => <button key={v.version} type="button" class={'nx-vlink' + (p.compare === v.version ? ' on' : '') + (v.approved ? ' ok' : '')} title={v.approved ? `Approved by ${nameOf(v.approved.by)}` : `By ${v.by.map(nameOf).join(', ')}`} onClick={() => act.compare(p.compare === v.version || v.version === w.version ? null : v.version)}>{v.approved ? <Lock /> : null}v{v.version}</button>)}
            {isDraft(w) ? <span class="nx-vlink cur">v{w.version} draft</span> : null}
            {w.versions.some((v) => v.version !== w.version) ? <span class="nx-vhint">{p.compare ? <>Showing changes since v{p.compare} · <button type="button" class="nx-textbtn" onClick={() => act.compare(null)}>Done</button></> : 'Pick a version to see what changed since'}</span> : null}
            {canRevise ? <button type="button" class="nx-btn" onClick={() => act.plan(w.id, { op: 'revise' })}>Revise plan</button> : null}
          </div>
        </header>
        {live && w.runs.some((r) => r.state !== 'finished') ? <p class="nx-note2"><Lock /> This is what {w.doer?.name} was authorized to do. Revising starts v{w.version + 1}; v{w.version} stays exactly as approved until someone authorizes the new one.</p> : null}
        {!mayWrite(p.role) ? <p class="nx-note2">You’re a viewer in this room: you can read the plan and comment, not change or authorize it.</p> : null}

        <Sec id="objective" title="Objective">
          <Prose text={w.why} can={canEdit} cls="lead" light={act.light} placeholder="What should be true when this is done?" onSave={(t) => act.plan(w.id, { op: 'objective', text: t })} />
          {base && base.objective !== w.why ? <p class="nx-was"><Diff a={base.objective} b={w.why} diff={wordDiff} /></p> : null}
        </Sec>

        <Sec id="context" title="Context" note="what this plan stands on">
          {w.context.length ? <ul class="nx-ctx">{w.context.map((r) => <CtxRow key={r.id} r={r} p={p} />)}</ul> : <p class="nx-quiet">Nothing linked yet. Link a decision, a thread or a part from their menus.</p>}
        </Sec>

        <Sec id="approach" title="Approach" note={`${w.plan.filter((s) => s.state === 'done').length} of ${w.plan.length} done`}
          action={oc.length && canEdit ? <span class="nx-revbar"><span class="nx-by agent"><i class="nx-agentmark"></i>{oc.length} suggestion{oc.length > 1 ? 's' : ''} from {nameOf(w.revision!.by)}</span><button type="button" class="nx-textbtn strong" onClick={() => act.decideAll(w.id, true)}>Accept all</button></span> : null}>
          {w.revision && w.revision.changes.length ? <p class="nx-revwhy"><Rich text={w.revision.why} light={act.light} /></p> : null}
          <ol class="nx-steps2" onKeyDown={(e) => {
            const t = e.target as HTMLElement; if (!t.classList.contains('nx-step-t')) return;
            const all = [...(root.current?.querySelectorAll<HTMLElement>('.nx-step .nx-step-t') ?? [])]; const i = all.indexOf(t);
            if ((e.key === 'j' || e.key === 'ArrowDown') && !e.altKey) { e.preventDefault(); focusStep(Math.min(all.length - 1, i + 1)); }
            if ((e.key === 'k' || e.key === 'ArrowUp') && !e.altKey) { e.preventDefault(); focusStep(Math.max(0, i - 1)); }
          }}>
            {adds(null).map((c) => <GhostStep key={c.id} c={c} w={w} p={p} />)}
            {w.plan.map((s, i) => (
              <Fragment key={s.id}>
                <StepItem s={s} i={i} w={w} p={p} can={canEdit} threads={passages.filter((t) => t.about.id === s.id)} activeT={activeT}
                  changes={w.revision?.changes.filter((c) => c.step === s.id) ?? []} base={base}
                  dragging={drag === s.id} over={over === i} onUp={() => onUp(s)} focusStep={focusStep}
                  onDrag={(on) => { setDrag(on ? s.id : null); if (!on) setOver(null); }} onOver={() => setOver(i)}
                  onDrop={() => { if (drag && drag !== s.id) act.plan(w.id, { op: 'move', step: drag, to: i }); setDrag(null); setOver(null); }} />
                {adds(s.id).map((c) => <GhostStep key={c.id} c={c} w={w} p={p} />)}
              </Fragment>
            ))}
          </ol>
          {removedSince.length ? <ul class="nx-removed2">{removedSince.map((s) => <li key={s.id}><del>{s.text}</del><em>removed since v{p.compare}</em></li>)}</ul> : null}
          {canEdit ? <button type="button" class="nx-textbtn add" onClick={() => act.plan(w.id, { op: 'add', after: w.plan[w.plan.length - 1]?.id ?? null, text: '' })}>+ Add a step</button> : null}
          {sel && mayWrite(p.role) ? (
            <button type="button" class="nx-selbtn" style={`left:${sel.x}px;top:${sel.y}px`} onClick={() => { act.passage(w.id, sel.step, sel.quote, null); setSel(null); window.getSelection()?.removeAllRanges(); }}>Comment</button>
          ) : null}
        </Sec>

        <Sec id="bounds" title="Boundaries" note={`what ${w.doer?.name ?? 'whoever does it'} may do inside this plan`}>
          <div class="nx-bounds">
            <Bound w={w} p={p} list="may" label="May" can={canEdit} base={base} />
            <Bound w={w} p={p} list="mayNot" label="Must not" can={canEdit} base={base} />
            <Bound w={w} p={p} list="askWhen" label="Asks first when" can={canEdit} base={base} />
          </div>
        </Sec>

        <Sec id="verify" title="Verification" note="done when">
          <Bound w={w} p={p} list="accept" label="" can={canEdit} base={base} source={rec.decisions.find((d) => d.id === w.decision)} />
        </Sec>

        <Execution w={w} p={p} />
      </div>
    </DocLayout>
  );
}

function CtxRow({ r, p }: { r: Work['context'][number]; p: DeskProps }) {
  const ev = useEvidence();
  const [open, setOpen] = useState(false);
  const e = r.kind === 'evidence' ? ev(r.target) : undefined;
  const KIND = { decision: 'Decision', thread: 'Thread', part: 'Canvas', file: 'Code', evidence: 'Evidence', work: 'Work' }[r.kind];
  const go = () => {
    if (r.kind === 'decision') p.act.inspect({ kind: 'decision', id: r.target });
    else if (r.kind === 'thread') { p.act.tab('discuss'); p.act.thread(r.target); }
    else if (r.kind === 'work') p.act.inspect({ kind: 'work', id: r.target, section: 'plan' });
    else if (r.kind === 'part') p.act.light([r.target]);
    else setOpen(!open);
  };
  return (
    <li class={'nx-ctxr k-' + r.kind} onPointerEnter={() => r.kind === 'part' && p.act.light([r.target])} onPointerLeave={() => r.kind === 'part' && p.act.light(null)}>
      <span class="nx-ctxk">{KIND}</span>
      <button type="button" class="nx-ctxl" onClick={go} title={r.kind === 'part' ? 'Light it on the canvas' : r.kind === 'file' ? 'Preview the referenced lines' : 'Open it'}>
        {e ? <BasisGlyph b={e.basis} /> : null}{r.kind === 'file' ? <code class="nx-ic nx-path">{r.label}</code> : <span>{r.label}</span>}
      </button>
      {r.sub ? <span class="nx-ctxs">{r.sub}</span> : null}
      {open && r.kind === 'file' ? (
        <div class="nx-peek2">{r.excerpt ? <pre>{r.excerpt}</pre> : <p class="nx-quiet">No excerpt was captured with this reference.</p>}{r.url ? <button type="button" class="nx-textbtn" onClick={() => p.act.openExternal(r.url!)}>Open<Ext /></button> : null}</div>
      ) : open && e ? <div class="nx-peek2"><b>{e.label}</b><small>{e.ref}</small></div> : null}
    </li>
  );
}

function Highlights({ text, threads, onOpen, activeT, light }: { text: string; threads: Thread[]; onOpen(id: string): void; activeT?: string; light(p: string[] | null): void }) {
  const { nameOf } = useNames();
  const marks = threads.filter((t) => t.quote && text.includes(t.quote));
  const lost = threads.filter((t) => t.quote && !text.includes(t.quote) && t.status === 'open');
  const out: (string | h.JSX.Element)[] = [];
  let rest = text, k = 0;
  for (const t of marks) {
    const i = rest.indexOf(t.quote!); if (i < 0) continue;
    out.push(<Rich key={k++} text={rest.slice(0, i)} light={light} />);
    out.push(<mark key={k++} class={'nx-hl' + (activeT === t.id ? ' on' : '') + (t.status === 'resolved' ? ' done' : '')} onClick={(e) => { e.stopPropagation(); onOpen(t.id); }} title={`${nameOf(t.replies[0].by)}: ${t.replies[0].body}`}>{t.quote}</mark>);
    rest = rest.slice(i + t.quote!.length);
  }
  out.push(<Rich key={k++} text={rest} light={light} />);
  return <>{out}{lost.length ? <button type="button" class="nx-lost" title="The words this comment was on have changed" onClick={(e) => { e.stopPropagation(); onOpen(lost[0].id); }}>{nameOf(lost[0].replies[0].by)}’s comment on earlier wording</button> : null}</>;
}

function StepItem({ s, i, w, p, can, threads, changes, base, dragging, over, onUp, onDrag, onOver, onDrop, activeT, focusStep }: {
  s: Step; i: number; w: Work; p: DeskProps; can: boolean; threads: Thread[]; changes: Change[]; base?: PlanBody; activeT?: string;
  dragging: boolean; over: boolean; onUp(): void; onDrag(on: boolean): void; onOver(): void; onDrop(): void; focusStep(i: number): void;
}) {
  const { act, rec, me } = p;
  const [ed, setEd] = useState(false);
  const [v, setV] = useState(s.text);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (!ed) setV(s.text); }, [s.text, ed]);
  useEffect(() => { if (ed && ref.current) { const t = ref.current; t.focus(); t.setSelectionRange(t.value.length, t.value.length); t.style.height = t.scrollHeight + 'px'; } }, [ed]);
  useEffect(() => { if (!s.text && can) setEd(true); }, []);
  const edit = changes.find((c) => c.kind === 'edit');
  const remove = changes.find((c) => c.kind === 'remove');
  const move = changes.find((c) => c.kind === 'move');
  const promote = changes.find((c) => c.kind === 'promote');
  const promoted = s.promoted ? rec.work.find((x) => x.id === s.promoted) : undefined;
  const run = w.runs[w.runs.length - 1];
  const was = base?.plan.find((x) => x.id === s.id);
  const save = (thenNew = false) => {
    setEd(false);
    if (!v.trim()) { act.plan(w.id, { op: 'remove', step: s.id }); setTimeout(() => focusStep(Math.max(0, i - 1)), 30); return; }
    if (v.trim() !== s.text) act.plan(w.id, { op: 'edit', step: s.id, text: v.trim() });
    if (thenNew) act.plan(w.id, { op: 'add', after: s.id, text: '' });
  };
  const decide = (c: Change, ok: boolean) => act.decide(w.id, c.id, ok);
  const body = s.promoted ? (
    <button type="button" class="nx-promo2" onClick={() => act.inspect({ kind: 'work', id: s.promoted!, section: 'plan' })}>
      <span class="nx-ctxk">Work</span><b>{s.text}</b><span>its own plan and PR · {promoted ? objectiveState(promoted, rec, me).label.toLowerCase() : ''}{promoted?.prs[0] ? ` · #${promoted.prs[0].num}` : ''}</span>
    </button>
  ) : ed ? (
    <textarea ref={ref} class="nx-step-in" value={v} rows={1} placeholder="Describe the step. Use `backticks` for code and paths."
      onInput={(e) => { setV(e.currentTarget.value); e.currentTarget.style.height = 'auto'; e.currentTarget.style.height = e.currentTarget.scrollHeight + 'px'; }}
      onBlur={() => save()}
      onKeyDown={(e) => {
        if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); save(); act.plan(w.id, { op: 'move', step: s.id, to: i + (e.key === 'ArrowUp' ? -1 : 1) }); return; }
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); const at = e.currentTarget.selectionStart; setEd(false); if (v !== s.text) act.plan(w.id, { op: 'edit', step: s.id, text: v }); act.plan(w.id, { op: 'split', step: s.id, at }); return; }
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(true); return; }
        if (e.key === 'Backspace' && !v) { e.preventDefault(); save(); return; }
        if (e.key === 'Escape') { e.stopPropagation(); save(); }
      }} />
  ) : edit && edit.state === 'open' ? (
    <span class="nx-step-t"><Diff a={s.text} b={edit.text!} diff={wordDiff} /></span>
  ) : base && was && was.text !== s.text ? (
    <span class="nx-step-t" tabIndex={0}><Diff a={was.text} b={s.text} diff={wordDiff} /></span>
  ) : (
    <span class={'nx-step-t' + (can ? ' can' : '')} tabIndex={0} onMouseUp={onUp}
      onKeyDown={(e) => {
        if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); act.plan(w.id, { op: 'move', step: s.id, to: i + (e.key === 'ArrowUp' ? -1 : 1) }); setTimeout(() => focusStep(i + (e.key === 'ArrowUp' ? -1 : 1)), 30); return; }
        if (can && (e.key === 'Enter' || e.key === 'e')) { e.preventDefault(); setEd(true); }
        if (e.key === 'c' && mayWrite(p.role)) { e.preventDefault(); act.passage(w.id, s.id, s.text.split(/[.;]/)[0], null); }
      }}
      onClick={(e) => { if (can && !window.getSelection()?.toString() && !(e.target as HTMLElement).closest('mark,.nx-lost,.nx-cref')) setEd(true); }}>
      <Highlights text={s.text} threads={threads} activeT={activeT} light={act.light} onOpen={(id) => act.passage(w.id, s.id, '', id)} />
    </span>
  );
  return (
    <li class={'nx-step ' + s.state + (dragging ? ' drag' : '') + (over ? ' over' : '') + (remove?.state === 'open' ? ' sg-remove' : '') + (base && !was ? ' added' : '') + (ed ? ' editing' : '')}
      onDragOver={(e) => { e.preventDefault(); onOver(); }} onDrop={(e) => { e.preventDefault(); onDrop(); }}>
      <span class="nx-step-n" draggable={can} title={can ? 'Drag to reorder · ⌥↑ ⌥↓' : ''} onDragStart={(e) => { e.dataTransfer?.setData('text/plain', s.id); onDrag(true); }} onDragEnd={() => onDrag(false)}>
        {s.state === 'done' ? '✓' : s.state === 'wont' ? '–' : i + 1}
      </span>
      <div class="nx-step-b">
        {body}
        <span class="nx-step-meta">
          {base && !was ? <b class="nx-chtag">new since v{p.compare}</b> : null}
          <By_ by={s.by} edited={s.edited} />
          {s.pr ? <span class="nx-mono">{s.pr}</span> : null}
          {run && s.state === 'doing' ? <span class="nx-doing"><span class={'nx-rdot ' + run.state}></span>{run.agent} is on this step</span> : null}
          {threads.length ? <button type="button" class="nx-textbtn" onClick={() => act.passage(w.id, s.id, '', threads[0].id)}>{threads.reduce((n, t) => n + t.replies.length, 0)} comment{threads.reduce((n, t) => n + t.replies.length, 0) > 1 ? 's' : ''}</button> : null}
          {can && !s.promoted && !ed ? (
            <span class="nx-step-tools">
              <button type="button" class="nx-textbtn" title="Split in two · ⌘↵ while editing" onClick={() => act.plan(w.id, { op: 'split', step: s.id })}>Split</button>
              <button type="button" class="nx-textbtn" title={s.pr ? 'This step has a PR: mark it won’t do instead' : 'Remove · undo for 6s'} onClick={() => s.pr ? act.plan(w.id, { op: 'state', step: s.id, state: 'wont' }) : act.removeStep(w.id, s, i)}>{s.pr ? 'Won’t do' : 'Remove'}</button>
            </span>
          ) : null}
        </span>
        {edit && edit.state !== 'open' ? <Proposed by={w.revision!.by} state={edit.state} decidedBy={edit.decidedBy} me={me} can={false} onAccept={() => {}} onReject={() => {}} /> : null}
        {edit && edit.state === 'open' ? <Proposed by={w.revision!.by} why="Rewrites this step" state="open" me={me} can={mayWrite(p.role)} onAccept={() => decide(edit, true)} onReject={() => decide(edit, false)} /> : null}
        {remove ? <Proposed by={w.revision!.by} why="Remove this step" state={remove.state} decidedBy={remove.decidedBy} me={me} can={mayWrite(p.role)} onAccept={() => decide(remove, true)} onReject={() => decide(remove, false)} /> : null}
        {move ? <Proposed by={w.revision!.by} why={`Move after step ${w.plan.findIndex((x) => x.id === move.after) + 1}. ${move.note ?? ''}`} state={move.state} decidedBy={move.decidedBy} me={me} can={mayWrite(p.role)} onAccept={() => decide(move, true)} onReject={() => decide(move, false)} /> : null}
        {promote ? (
          <Proposed by={w.revision!.by} why={promote.note} state={promote.state} decidedBy={promote.decidedBy} me={me} can={mayWrite(p.role)} onAccept={() => decide(promote, true)} onReject={() => decide(promote, false)}>
            <span class="nx-prop-body"><span class="nx-ctxk">New work</span><b>{promote.title}</b> — <Rich text={promote.text!} /></span>
          </Proposed>
        ) : null}
      </div>
    </li>
  );
}

function GhostStep({ c, w, p }: { c: Change; w: Work; p: DeskProps }) {
  return (
    <li class={'nx-step ghost ' + c.state}>
      <span class="nx-step-n">+</span>
      <div class="nx-step-b">
        <Proposed by={w.revision!.by} why="A new step" state={c.state} decidedBy={c.decidedBy} me={p.me} can={mayWrite(p.role)} onAccept={() => p.act.decide(w.id, c.id, true)} onReject={() => p.act.decide(w.id, c.id, false)}>
          <span class="nx-prop-body">{c.state === 'rejected' ? <del>{c.text}</del> : <ins><Rich text={c.text!} /></ins>}</span>
        </Proposed>
      </div>
    </li>
  );
}

function Bound({ w, p, list, label, can, source, base }: { w: Work; p: DeskProps; list: 'may' | 'mayNot' | 'askWhen' | 'accept'; label: string; can: boolean; source?: { version: number; verify: string[] }; base?: PlanBody }) {
  const items = w[list];
  const sugg = w.revision?.changes.filter((c) => ((c.kind === 'bound' && c.list === list) || (c.kind === 'verify' && list === 'accept')) && c.state !== 'accepted') ?? [];
  const [adding, setAdding] = useState(false);
  const gone = base ? base[list].filter((x) => !items.includes(x)) : [];
  return (
    <div class={'nx-bound ' + list}>
      {label ? <span class="nx-bound-k">{label}</span> : null}
      <ul>
        {items.map((x, i) => (
          <li key={x + i} class={base && !base[list].includes(x) ? 'added' : ''}>
            <Prose text={x} can={can} onSave={(t) => p.act.plan(w.id, { op: 'list', list, index: i, text: t || null })} />
            {source?.verify.includes(x) ? <em class="nx-src">from decision v{source.version}</em> : null}
            {base && !base[list].includes(x) ? <em class="nx-chtag">new since v{p.compare}</em> : null}
            {can ? <button type="button" class="nx-x" title="Remove this line" onClick={() => p.act.plan(w.id, { op: 'list', list, index: i, text: null })}>×</button> : null}
          </li>
        ))}
        {gone.map((x) => <li key={'g' + x} class="gone"><del>{x}</del></li>)}
        {sugg.map((c) => (
          <li key={c.id} class="ghost">
            <Proposed by={w.revision!.by} state={c.state} decidedBy={c.decidedBy} me={p.me} can={mayWrite(p.role)} onAccept={() => p.act.decide(w.id, c.id, true)} onReject={() => p.act.decide(w.id, c.id, false)}>
              <span class="nx-prop-body">{c.state === 'rejected' ? <del>{c.text}</del> : <ins><Rich text={c.text!} /></ins>}</span>
            </Proposed>
          </li>
        ))}
        {adding ? <li><Prose text="" can onSave={(t) => { setAdding(false); if (t) p.act.plan(w.id, { op: 'list', list, index: items.length, text: t }); }} placeholder="Add a line…" editing /></li> : null}
      </ul>
      {can && !adding ? <button type="button" class="nx-textbtn add" onClick={() => setAdding(true)}>+ Add</button> : null}
    </div>
  );
}

/** What exactly the agent receives when this version is authorized: shown, not paraphrased. */
export function payload(w: Work, body: PlanBody, version: number, nameOf: (id: string) => string, approvedBy?: string, rec?: DeskProps['rec']): string {
  const dec = rec?.decisions.find((d) => d.id === w.context.find((x) => x.kind === 'decision')?.target);
  return [
    `# ${w.title} · plan v${version}${approvedBy ? ` (approved by ${nameOf(approvedBy)})` : ' (not yet approved)'}`,
    `Repository: ${w.repo} · ${w.exec.where.replace(/ on .*/, '')} · ${w.exec.prs === 'per-step' ? 'one draft PR per step' : 'one draft PR'}`,
    '', `Objective: ${body.objective}`, '',
    'Steps:', ...body.plan.map((s, i) => `  ${i + 1}. ${s.promoted ? `[separate work item] ${s.text}` : s.text}`), '',
    'You may:', ...body.may.map((x) => `  - ${x}`),
    'You must not:', ...body.mayNot.map((x) => `  - ${x}`),
    'Stop and ask the room when:', ...body.askWhen.map((x) => `  - ${x}`), '',
    'Done when:', ...body.accept.map((x) => `  - ${x}`), '',
    'References:', ...(dec ? [`  - Decision v${dec.version}: ${dec.title}`, ...dec.lines.filter((l) => l.kind === 'decide').map((l) => `      we will: ${l.text}`)] : []),
    ...w.context.filter((x) => x.kind === 'file' || x.kind === 'evidence').map((x) => `  - ${x.label}${x.sub ? ` (${x.sub})` : ''}`),
  ].join('\n');
}

function Execution({ w, p }: { w: Work; p: DeskProps }) {
  const { nameOf } = useNames();
  const { rec, me, act, role } = p;
  const ap = approvedOf(w);
  const dep = rec.work.find((x) => x.id === w.dependsOn && x.state === 'proposed');
  const why = blockedWhy(w, role);
  const live = !!ap && ap.version === w.version && !openChanges(w).length;
  const wider = ap && !live ? widens(ap.body, w) : [];
  const [change, setChange] = useState(!w.doer && !live);
  const [peekSet, setPeek] = useState<boolean | null>(null);
  const peek = peekSet ?? (p.depth === 'focus' && !!w.doer && w.doer.kind === 'agent' && !live);
  const can = mayWrite(role) && !live && w.state !== 'resolved';
  const opts = [
    ...rec.agents.map((a) => ({ kind: 'agent' as const, name: a.name, sub: a.note, ok: a.status === 'connected' })),
    ...rec.members.filter((m) => mayWrite(m.role)).map((m) => ({ kind: 'person' as const, name: nameOf(m.who), sub: m.who === me ? 'you' : 'a person in this room', ok: true })),
  ];
  const body = live ? ap!.body : { objective: w.why, plan: w.plan, may: w.may, mayNot: w.mayNot, askWhen: w.askWhen, accept: w.accept };
  return (
    <Sec id="exec" title="Execution" note={live ? 'authorized' : 'nothing runs until someone authorizes'}>
      <p class="nx-exsum">
        {w.doer ? <><b>{w.doer.name}</b>{w.doer.kind === 'agent' ? ` · ${w.exec.where}` : ' does it, on their own machine'}</> : <b>Nobody chosen yet</b>}
        {w.doer?.kind === 'agent' ? <> · {w.exec.prs === 'per-step' ? 'one draft PR per step' : 'one draft PR'} · may edit <Rich text={w.may.filter((m) => /^Edit /.test(m)).map((m) => m.replace(/^Edit /, '')).join(', ')} /></> : null}
        {can ? <button type="button" class="nx-textbtn" onClick={() => setChange(!change)}>{change ? 'Done' : 'Change'}</button> : null}
      </p>
      {change && can ? (
        <div class="nx-exedit">
          <div class="nx-doers2" role="radiogroup" aria-label="Who does it">
            {opts.map((o) => (
              <button key={o.name} type="button" role="radio" aria-checked={w.doer?.name === o.name} disabled={!o.ok} class={'nx-doer2' + (w.doer?.name === o.name ? ' on' : '')} onClick={() => act.plan(w.id, { op: 'doer', doer: { kind: o.kind, name: o.name } })}
                title={!o.ok ? `${o.name} isn’t connected to this room` : ''}>
                <span class="nx-radio"></span><span><b>{o.name}</b><small>{o.ok ? o.sub : o.sub || 'Not reachable from this room'}</small></span>
              </button>
            ))}
          </div>
          {w.doer?.kind === 'agent' ? (
            <div class="nx-exrow"><span class="nx-bound-k">Changes arrive as</span>
              <span class="nx-seg">{(['per-step', 'grouped'] as const).map((k) => <button key={k} type="button" class={w.exec.prs === k ? 'on' : ''} onClick={() => act.plan(w.id, { op: 'prs', prs: k })}>{k === 'per-step' ? 'One draft PR per step' : 'One draft PR'}</button>)}</span>
            </div>
          ) : null}
          {w.doer?.kind === 'agent' ? <p class="nx-quiet">Choosing an agent doesn’t give it credentials. It uses what it already has on that machine, inside the boundaries above.</p> : null}
        </div>
      ) : null}
      {w.doer?.kind === 'agent' ? (
        <div class="nx-payload">
          <button type="button" class="nx-textbtn" aria-expanded={peek} onClick={() => setPeek(!peek)}>{peek ? '▾' : '▸'} {live ? `Exactly what ${w.doer.name} received with v${ap!.version}` : `What ${w.doer.name} will receive if you authorize v${w.version}`}</button>
          {peek ? <pre class="nx-pl">{payload(w, body, live ? ap!.version : w.version, nameOf, live ? ap!.approved!.by : undefined, rec)}</pre> : null}
        </div>
      ) : null}
      {live ? (
        <p class="nx-authd2"><Lock /> <span><b>v{ap!.version} authorized</b> by {ap!.approved!.by === me ? 'you' : nameOf(ap!.approved!.by)}, {ap!.approved!.ago} · {ap!.approved!.scope}{ap!.approved!.includes ? ` · included ${ap!.approved!.includes.join(', ')}` : ''}</span>{w.runs.length ? <button type="button" class="nx-textbtn" onClick={() => act.inspect({ kind: 'work', id: w.id, section: 'run' })}>See the run</button> : null}</p>
      ) : w.state !== 'resolved' ? (<>
        {wider.length ? <p class="nx-widens" role="note"><b>v{w.version} gives {w.doer?.name ?? 'whoever does it'} more room than v{ap!.version}:</b> {wider.join('; ')}. Authorize only if that’s intended.</p> : null}
        <div class="nx-authrow">
          <span class="nx-quiet">{why ?? (dep ? `Also authorizes ${dep.title} (v${dep.version}), which this plan waits for.` : ap ? `${w.doer?.name} switches from v${ap.version} to v${w.version} at its next step.` : w.doer?.kind === 'person' ? `${w.doer.name} gets v${w.version}; nothing runs by itself.` : p.caps.agentRuns ? `${w.doer?.name} starts in its worktree, inside these boundaries.` : `Records the approval and freezes v${w.version}.`)}{!why && w.doer?.kind === 'agent' && !p.caps.agentRuns ? ` This app can’t start ${w.doer.name} for you yet: start it yourself with the plan above.` : ''}</span>
          <button class="nx-btn primary" type="button" disabled={!!why} onClick={() => act.authorize(w.id)}>
            {!w.doer ? `Authorize v${w.version}` : w.doer.kind === 'person' ? `Hand v${w.version} to ${w.doer.name}` : p.caps.agentRuns ? `Authorize ${w.doer.name} to run v${w.version}` : `Approve v${w.version} for ${w.doer.name}`}
          </button>
        </div>
      </>) : null}
    </Sec>
  );
}

function PlanRail({ w, p, passages, activeT }: { w: Work; p: DeskProps; passages: Thread[]; activeT?: string }) {
  const { nameOf, agentName } = useNames();
  const { act, rec } = p;
  const t = passages.find((x) => x.id === activeT);
  const peer = rec.members.find((m) => m.who !== p.me)?.who;
  const draft = p.inspect && p.inspect.kind === 'work' && p.inspect.step && !activeT ? { step: p.inspect.step, quote: p.inspect.quote ?? '' } : null;
  const [body, setBody] = useState('');
  const open = passages.filter((x) => x.status === 'open');
  return (
    <>
      {draft ? (
        <div class="nx-rsec">
          <span class="nx-rk2">New comment<button type="button" class="nx-textbtn" onClick={() => act.passage(w.id, '', '', null, true)}>Cancel</button></span>
          {draft.quote ? <blockquote class="nx-quote2">{draft.quote}</blockquote> : null}
          <label class="rp-cm-reply"><Who id={p.me} /><span class="rp-sr">Comment</span>
            <MentionField p={p} autoFocus placeholder={`Comment${peer ? ` · @${nameOf(peer)} to ask them` : ''}${rec.vowe ? ` · @${agentName()} to check it` : ''}`} value={body} onInput={setBody}
              onSubmit={(t) => { act.comment(w.id, draft.step, draft.quote, t); setBody(''); }} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); act.passage(w.id, '', '', null, true); } }} />
          </label>
        </div>
      ) : t ? (
        <div class="nx-rsec">
          <span class="nx-rk2">On step {w.plan.findIndex((s) => s.id === t.about.id) + 1}<button type="button" class="nx-textbtn" onClick={() => act.passage(w.id, '', '', null, true)}>Close</button></span>
          {t.quote ? <blockquote class="nx-quote2">{t.quote}{!w.plan.find((s) => s.id === t.about.id)?.text.includes(t.quote) ? <small>These words have since changed.</small> : null}</blockquote> : null}
          <ThreadCard t={t} p={p} inline />
        </div>
      ) : (
        <div class="nx-rsec">
          <span class="nx-rk2">Comments{open.length ? <em>{open.length} open</em> : null}</span>
          {passages.length ? passages.map((x) => (
            <button key={x.id} type="button" class={'nx-rc' + (x.status === 'resolved' ? ' done' : '')} onClick={() => act.passage(w.id, x.about.id, '', x.id)}>
              {x.quote ? <q>{x.quote}</q> : null}<span><b>{nameOf(x.replies[0].by)}</b> {x.replies[0].body}</span><em>{x.status === 'resolved' ? 'resolved' : `${x.replies.length - 1} repl${x.replies.length === 2 ? 'y' : 'ies'}`}</em>
            </button>
          )) : <p class="nx-quiet">Select words in a step and press Comment, or focus a step and press C.</p>}
        </div>
      )}
      <div class="nx-rsec">
        <span class="nx-rk2">History</span>
        <ul class="nx-hist2">{[...w.log].reverse().slice(0, 7).map((l, i) => <li key={i}><span><b>{nameOf(l.who)}</b> {l.text.charAt(0).toLowerCase() + l.text.slice(1)}</span><em>{l.ago}</em></li>)}</ul>
      </div>
    </>
  );
}
