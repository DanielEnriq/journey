import { h, Fragment, useState } from '../journey.js';
import { BasisGlyph } from '../canvas/faces.js';
import { AGENT, type Decision, type Line } from '../contracts/model.js';
import { wordDiff } from '../state/plan.js';
import { DEC_STATE, ThreadCard, Who, type DeskProps } from './Desk.js';
import { By_, Diff, DocLayout, Lock, Prose, Proposed, Rich, Sec } from './Doc.js';
import { MentionField } from './Mention.js';
import { objectiveState } from './Work.js';
import { useNames } from '../state/directory.js';
import { useEvidence } from '../state/semantics.js';
import { mayWrite } from '../state/permissions.js';

// A decision as an engineering argument: the problem, what we'll do, why, what else we considered, what it
// costs, what supports it and what cuts against it, what we're assuming, how we'll know, who has to agree,
// and where it came from and led. Every sentence keeps who wrote it; the agent's words are marked as such.

export function DecisionDoc({ d, p }: { d: Decision; p: DeskProps }) {
  const ev = useEvidence();
  const { nameOf, agentName } = useNames();
  const { rec, me, act } = p;
  const family = rec.decisions.filter((x) => x.title === d.title).sort((a, b) => a.version - b.version);
  const base = p.compare ? family.find((x) => x.version === p.compare) : undefined;
  const from = rec.threads.find((t) => t.id === d.from);
  const work = rec.work.filter((w) => w.decision === d.id || family.some((f) => f.id === w.decision));
  const lineId = p.inspect && p.inspect.kind === 'decision' ? p.inspect.line : undefined;
  const can = d.state === 'draft' && mayWrite(p.role);
  const mine = d.approvers.find((a) => a.who === me);
  const waiting = d.approvers.filter((a) => a.signed !== d.version && !a.changes).map((a) => (a.who === me ? 'you' : nameOf(a.who)));
  const changes = d.approvers.filter((a) => a.changes);
  const lines = (k: Line['kind'][]) => d.lines.filter((l) => k.includes(l.kind));
  const evFor = [...new Set(d.lines.flatMap((l) => l.evidence ?? []))].filter((id) => !d.doc?.against?.includes(id));
  const outline = [
    { id: 'problem', label: 'Problem' }, { id: 'decision', label: 'Decision', note: String(lines(['decide']).length) }, { id: 'why', label: 'Why' },
    { id: 'alts', label: 'Alternatives', note: String(d.alternatives.length) }, { id: 'costs', label: 'Tradeoffs' }, { id: 'evidence', label: 'Evidence' },
    { id: 'unknowns', label: 'Assumptions and questions' }, { id: 'verify', label: 'Verification' }, { id: 'review', label: 'Review', note: d.state === 'agreed' ? 'agreed' : `${d.approvers.filter((a) => a.signed === d.version).length}/${d.approvers.length}` },
    { id: 'history', label: 'History' },
  ];
  const stline = d.state === 'agreed' ? <><Lock /> v{d.version} · agreed by {d.approvers.map((a) => (a.who === me ? 'you' : nameOf(a.who))).join(' and ')}</>
    : d.state === 'superseded' ? <>v{d.version} · superseded by v{d.version + 1}</>
    : d.state === 'review' ? <><b>v{d.version} in review</b> · {changes.length ? `${changes.map((a) => nameOf(a.who)).join(', ')} requested changes` : `waiting on ${waiting.join(' and ')}`}</>
    : d.state === 'suggested' ? <>{agentName()} thinks there’s a decision here · not written yet</>
    : <><b>v{d.version} draft</b> · saved · nobody has been asked to sign yet</>;
  return (
    <DocLayout p={p} outline={outline} docKey={'dec-' + d.id} rail={<DecisionRail d={d} p={p} lineId={lineId} from={from} />}>
      <div class="nx-pdoc nx-ddoc">
        <header class="nx-dhead">
          <span class="nx-eyebrow">Decision{from ? <> · from <button type="button" class="nx-textbtn" onClick={() => { act.tab('discuss'); act.thread(from.id); act.inspect(null); }}>the {from.about.name} thread</button></> : null}</span>
          <h2>{d.title}</h2>
          <div class={'nx-stline ' + (d.state === 'agreed' ? 'ok' : d.state === 'review' ? 'prop' : 'draft')}>{stline}</div>
          {family.length > 1 ? (
            <div class="nx-verline">
              {family.map((v) => <button key={v.id} type="button" class={'nx-vlink' + (v.id === d.id ? ' cur' : '') + (p.compare === v.version ? ' on' : '') + (v.state === 'agreed' || v.state === 'superseded' ? ' ok' : '')} onClick={() => v.id === d.id ? act.compare(null) : v.version < d.version ? act.compare(p.compare === v.version ? null : v.version) : act.inspect({ kind: 'decision', id: v.id })}>v{v.version} {v.state === 'superseded' ? 'superseded' : DEC_STATE[v.state].toLowerCase()}</button>)}
              <span class="nx-vhint">{p.compare ? <>Showing changes since v{p.compare} · <button type="button" class="nx-textbtn" onClick={() => act.compare(null)}>Done</button></> : d.version > 1 ? 'Pick an earlier version to compare' : ''}</span>
            </div>
          ) : null}
        </header>
        {d.revises ? <p class="nx-note2">Revises v{d.revises.version}: <Rich text={d.revises.why} light={act.light} /></p> : null}

        <Sec id="problem" title="Problem">
          {d.doc ? <><Prose text={d.doc.problem.text} can={can} cls="lead" light={act.light} onSave={(t) => act.editDoc(d.id, 'problem', t)} /><By_ by={d.doc.problem.by} /></> : <p class="nx-quiet">No problem statement yet.</p>}
        </Sec>

        <Sec id="decision" title="Decision" note="we will">
          <ol class="nx-dlines">{lines(['decide']).map((l) => <DLine key={l.id} l={l} d={d} p={p} can={can} base={base} on={lineId === l.id} />)}</ol>
          {can ? <AddLine kinds={['decide']} first={!lines(['decide']).length} onAdd={(k, t) => act.addLine(d.id, k, t)} /> : null}
          {base ? base.lines.filter((l) => l.kind === 'decide' && !d.lines.some((x) => x.id === l.id)).map((l) => <p key={l.id} class="nx-was"><del>{l.text}</del></p>) : null}
        </Sec>

        <Sec id="why" title="Why">
          <ul class="nx-dlines plain">{lines(['because']).map((l) => <DLine key={l.id} l={l} d={d} p={p} can={can} base={base} on={lineId === l.id} />)}</ul>
          {can ? <AddLine kinds={['because']} onAdd={(k, t) => act.addLine(d.id, k, t)} /> : null}
          {d.doc?.rationale ? <><Prose text={d.doc.rationale.text} can={can} light={act.light} onSave={(t) => act.editDoc(d.id, 'rationale', t)} /><By_ by={d.doc.rationale.by} /></> : null}
        </Sec>

        <Sec id="alts" title="Alternatives considered">
          {d.alternatives.length ? <ul class="nx-alts2">{d.alternatives.map((a) => <li key={a.id}><b>{a.title}</b><span>{a.state === 'set-aside' ? 'Set aside: ' : 'Still open: '}{a.why}</span></li>)}</ul> : <p class="nx-quiet">None recorded. A decision with no alternative is easy to sign and hard to trust.</p>}
        </Sec>

        <Sec id="costs" title="Tradeoffs and consequences">
          <div class="nx-two">
            <div><span class="nx-bound-k">It costs</span><ul class="nx-plainl">{d.doc?.tradeoffs.map((t, i) => <li key={i}><Rich text={t.text} light={act.light} /> <By_ by={t.by} /></li>)}</ul></div>
            <div><span class="nx-bound-k">It means</span><ul class="nx-plainl">{d.doc?.consequences.map((t, i) => <li key={i}><Rich text={t.text} light={act.light} /> <By_ by={t.by} /></li>)}</ul></div>
          </div>
        </Sec>

        <Sec id="evidence" title="Evidence">
          <ul class="nx-evl">
            {evFor.map((id) => { const e = ev(id)!; return <li key={id}><BasisGlyph b={e.basis} /><span><b>{e.label}</b><small>{e.ref}</small></span><em>supports</em></li>; })}
            {d.doc?.against?.map((id) => { const e = ev(id)!; return <li key={id} class="against"><BasisGlyph b={e.basis} /><span><b>{e.label}</b><small>{e.ref}</small></span><em>cuts against an assumption</em></li>; })}
          </ul>
        </Sec>

        <Sec id="unknowns" title="Assumptions and open questions">
          <ul class="nx-dlines plain">{lines(['assume', 'open', 'scope']).map((l) => <DLine key={l.id} l={l} d={d} p={p} can={can} base={base} on={lineId === l.id} />)}</ul>
          {can ? <AddLine kinds={['assume', 'open', 'scope']} onAdd={(k, t) => act.addLine(d.id, k, t)} /> : null}
        </Sec>

        <Sec id="verify" title="Verification" note="how we’ll know it holds">
          <ul class="nx-plainl check">{d.verify.map((v) => <li key={v} class={base && !base.verify.includes(v) ? 'added' : ''}>{v}{base && !base.verify.includes(v) ? <em class="nx-chtag">new in v{d.version}</em> : null}</li>)}</ul>
        </Sec>

        <Sec id="review" title="Review">
          <Review d={d} p={p} mine={mine} />
        </Sec>

        <Sec id="history" title="History">
          <ul class="nx-plainl">
            {family.map((v) => <li key={v.id}>v{v.version} · {v.by.who === AGENT ? `drafted by ${agentName()}` : `written by ${nameOf(v.by.who)}`} · {DEC_STATE[v.state].toLowerCase()}{v.revises ? ` · revises v${v.revises.version}` : ''}</li>)}
            {work.map((w) => <li key={w.id}>Led to <button type="button" class="nx-textbtn" onClick={() => act.inspect({ kind: 'work', id: w.id, section: 'plan' })}>{w.title}</button> · {objectiveState(w, rec, me).label.toLowerCase()}{w.prs.length ? ` · ${w.prs.filter((x) => x.state !== 'closed').map((x) => '#' + x.num).join(' ')}` : ''}</li>)}
          </ul>
        </Sec>
      </div>
    </DocLayout>
  );
}

const ADD_LABEL: Record<Line['kind'], { add: string; hint: string }> = {
  decide: { add: 'Add what we will do', hint: 'We will…' },
  because: { add: 'Add a reason', hint: 'Because…' },
  assume: { add: 'Assumption', hint: 'We’re assuming…' },
  open: { add: 'Open question', hint: 'We don’t know yet…' },
  scope: { add: 'Out of scope', hint: 'This doesn’t cover…' },
};

/** Writing a new line into a draft. Signed versions are amended instead, so this only shows on drafts. */
function AddLine({ kinds, first, onAdd }: { kinds: Line['kind'][]; first?: boolean; onAdd(kind: Line['kind'], text: string): void }) {
  const [kind, setKind] = useState<Line['kind'] | null>(first ? kinds[0] : null);
  const [text, setText] = useState('');
  const save = () => { const t = text.trim(); if (!t || !kind) return; onAdd(kind, t); setText(''); if (!first) setKind(null); };
  if (!kind) return <span class="nx-addline">{kinds.map((k) => <button key={k} type="button" class="nx-textbtn add" onClick={() => setKind(k)}>+ {ADD_LABEL[k].add}</button>)}</span>;
  return (
    <span class="nx-addline editing">
      <label class="nx-addline-f"><span class="sr">{ADD_LABEL[kind].add}</span>
        <input type="text" placeholder={`${ADD_LABEL[kind].hint} (Enter to add)`} value={text} onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape' && !first) { setKind(null); setText(''); } }} />
      </label>
      {!first ? <button type="button" class="nx-textbtn" onClick={() => { setKind(null); setText(''); }}>Cancel</button> : null}
    </span>
  );
}

function DLine({ l, d, p, can, base, on }: { l: Line; d: Decision; p: DeskProps; can: boolean; base?: Decision; on: boolean }) {
  const ev = useEvidence();
  const { nameOf } = useNames();
  const { rec, act, me } = p;
  const ts = rec.threads.filter((t) => t.about.kind === 'line' && t.about.id === l.id);
  const was = base?.lines.find((x) => x.id === l.id);
  const KIND = { decide: '', because: '', assume: 'Assuming', open: 'Open question', scope: 'Out of scope' }[l.kind];
  return (
    <li class={'nx-dl ' + l.kind + (on ? ' on' : '') + (l.overturned ? ' over' : '') + (base && !was ? ' added' : '')}>
      {KIND ? <span class="nx-dl-k">{KIND}</span> : null}
      <div class="nx-dl-b">
        {base && was && was.text !== l.text ? <span class="nx-dl-t"><Diff a={was.text} b={l.text} diff={wordDiff} /></span>
          : can ? <>{l.was ? <del class="nx-wasline">{l.was}</del> : null}<Prose text={l.text} can light={act.light} onSave={(t) => act.editLine(d.id, l.id, t)} /></>
          : <span class="nx-dl-t">{l.was && !base ? <del class="nx-wasline">{l.was}</del> : null}<Rich text={l.text} light={act.light} /></span>}
        <span class="nx-step-meta">
          {base && !was ? <b class="nx-chtag">new in v{d.version}</b> : null}
          {l.basis && l.by.how !== 'inferred' && l.basis !== 'decided' ? <BasisGlyph b={l.basis} /> : null}<By_ by={l.by} />
          {l.evidence?.map((id) => <span key={id} class="nx-evref" title={ev(id)?.label}>{id}</span>)}
          <button type="button" class="nx-textbtn" onClick={() => act.lineThread(d.id, l.id)}>{ts.length ? `${ts.reduce((n, t) => n + t.replies.length, 0)} comment${ts.reduce((n, t) => n + t.replies.length, 0) > 1 ? 's' : ''}` : 'Comment'}</button>
        </span>
        {l.overturned ? <p class="nx-over2">Overturned by {nameOf(l.overturned.by)}: {l.overturned.why}</p> : null}
        {l.suggest ? (
          <Proposed by={l.suggest.by} why={l.suggest.why} state="open" me={me} can={mayWrite(p.role)} onAccept={() => act.takeEdit(d.id, l.id, true)} onReject={() => act.takeEdit(d.id, l.id, false)}>
            <span class="nx-prop-body"><Diff a={l.text} b={l.suggest.text} diff={wordDiff} /></span>
          </Proposed>
        ) : null}
      </div>
    </li>
  );
}

function Review({ d, p, mine }: { d: Decision; p: DeskProps; mine?: Decision['approvers'][number] }) {
  const { nameOf, agentName } = useNames();
  const { rec, me, act } = p;
  const [rc, setRc] = useState<string | null>(null);
  const [pick, setPick] = useState(false);
  /** Who you're asking to sign: every member who may sign, until you untick someone. */
  const [skip, setSkip] = useState<string[]>([]);
  const work = rec.work.filter((w) => w.decision === d.id);
  return (
    <div class="nx-review">
      <ul class="nx-sigs2">
        {d.approvers.map((a) => {
          const ok = a.signed === d.version;
          return (
            <li key={a.who} class={ok ? 'ok' : a.changes ? 'changes' : ''}>
              <Who id={a.who} size={18} /><b>{a.who === me ? 'You' : nameOf(a.who)}</b>
              <span>{ok ? `signed v${d.version}` : a.changes ? 'requested changes' : a.signed ? `signed v${a.signed}; not v${d.version} yet` : d.state === 'draft' ? 'not asked yet' : 'hasn’t signed'}</span>
              {a.changes ? <p class="nx-rcq">“{a.changes}”</p> : null}
            </li>
          );
        })}
      </ul>
      {rc !== null ? (
        <label class="rp-cm-reply nx-rcin"><Who id={me} /><span class="rp-sr">What should change</span>
          <MentionField p={p} autoFocus placeholder="What should change before you sign? (Enter to send)" value={rc} onInput={setRc}
            onSubmit={(t) => { act.requestChanges(d.id, t); setRc(null); }} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setRc(null); } }} />
        </label>
      ) : null}
      {pick ? (
        <div class="nx-picker" role="dialog" aria-label="Ask for signatures">
          <span class="nx-rk2">Who should sign v{d.version}?<em>room members</em></span>
          {rec.members.map((m) => <label key={m.who} class={'nx-pk' + (!mayWrite(m.role) ? ' off' : '')}><input type="checkbox" disabled={!mayWrite(m.role) || m.who === me} checked={mayWrite(m.role) && m.who !== me && !skip.includes(m.who)}
            onChange={(e) => setSkip(e.currentTarget.checked ? skip.filter((x) => x !== m.who) : [...skip, m.who])} /><Who id={m.who} size={16} />{m.who === me ? 'You' : nameOf(m.who)}<small>{!mayWrite(m.role) ? 'viewer: can read and comment, can’t sign' : m.who === me ? 'you sign from the decision itself' : m.role}</small></label>)}
          <span class="nx-actrow"><button type="button" class="nx-btn primary" 
            onClick={() => { setPick(false); act.askFor(d.id, rec.members.filter((m) => mayWrite(m.role) && m.who !== me && !skip.includes(m.who)).map((m) => m.who)); }}>{rec.members.some((m) => mayWrite(m.role) && m.who !== me && !skip.includes(m.who)) ? 'Ask them to sign' : 'Put it to review (only you sign)'}</button><button type="button" class="nx-btn" onClick={() => setPick(false)}>Cancel</button><button type="button" class="nx-textbtn" onClick={() => act.invite()}>Invite someone…</button></span>
        </div>
      ) : null}
      <div class="nx-actrow">
        {d.state === 'review' && mine && mine.signed !== d.version && !mine.changes && rc === null ? <><button type="button" class="nx-btn primary" disabled={!mayWrite(p.role)} onClick={() => act.sign(d.id)}>Sign v{d.version}</button><button type="button" class="nx-btn" onClick={() => setRc('')}>Request changes</button></> : null}
        {d.state === 'draft' && !pick ? <button type="button" class="nx-btn primary" disabled={!mayWrite(p.role)} onClick={() => setPick(true)}>Ask for signatures…</button> : null}
        {(d.state === 'review' && d.approvers.some((a) => a.changes)) || d.state === 'agreed' ? <button type="button" class="nx-btn" disabled={!mayWrite(p.role)} onClick={() => act.amend(d.id)}>Amend as v{d.version + 1}</button> : null}
        {d.state === 'agreed' && !work.length ? <button type="button" class="nx-btn primary" onClick={() => act.prepareWork(d.id)}>Plan the work</button> : null}
      </div>
    </div>
  );
}

function DecisionRail({ d, p, lineId, from }: { d: Decision; p: DeskProps; lineId?: string; from?: DeskProps['rec']['threads'][number] }) {
  const { nameOf, agentName } = useNames();
  const { rec, act } = p;
  const line = d.lines.find((l) => l.id === lineId);
  const lt = line ? rec.threads.find((t) => t.about.kind === 'line' && t.about.id === line.id) : undefined;
  const objections = rec.threads.filter((t) => t.about.kind === 'line' && t.about.decision === d.id);
  const [body, setBody] = useState('');
  return (
    <>
      {line ? (
        <div class="nx-rsec">
          <span class="nx-rk2">On this line<button type="button" class="nx-textbtn" onClick={() => act.inspect({ kind: 'decision', id: d.id })}>Close</button></span>
          <blockquote class="nx-quote2">{line.text}</blockquote>
          {lt ? <ThreadCard t={lt} p={p} inline /> : (
            <label class="rp-cm-reply"><Who id={p.me} /><span class="rp-sr">Comment</span>
              <MentionField p={p} autoFocus placeholder={rec.vowe ? `Comment on this line · @${agentName()} to check it` : 'Comment on this line'} value={body} onInput={setBody}
                onSubmit={(t) => { act.reply(`line:${d.id}:${line.id}`, t); setBody(''); }} />
            </label>
          )}
        </div>
      ) : (
        <div class="nx-rsec">
          <span class="nx-rk2">Objections and questions{objections.length ? <em>{objections.filter((t) => t.status === 'open').length} open</em> : null}</span>
          {objections.length ? objections.map((t) => (
            <button key={t.id} type="button" class={'nx-rc' + (t.status === 'resolved' ? ' done' : '')} onClick={() => act.lineThread(d.id, (t.about as { id: string }).id)}>
              <q>{d.lines.find((l) => l.id === (t.about as { id: string }).id)?.text}</q><span><b>{nameOf(t.replies[0].by)}</b> {t.replies[0].body}</span><em>{t.status === 'resolved' ? 'resolved' : `${t.replies.length - 1} repl${t.replies.length === 2 ? 'y' : 'ies'}`}</em>
            </button>
          )) : <p class="nx-quiet">None yet. Press Comment on any line to raise one.</p>}
        </div>
      )}
      {from ? (
        <div class="nx-rsec">
          <span class="nx-rk2">Where it came from</span>
          <button type="button" class="nx-rc" onClick={() => { act.tab('discuss'); act.thread(from.id); act.inspect(null); }}>
            <span><b>{from.about.name}</b> · {from.replies.length} messages</span><span class="nx-quiet">{nameOf(from.replies[0].by)}: {from.replies[0].body.replace(/\[([^|\]]+)\|[^\]]+\]/g, '$1').slice(0, 110)}…</span><em>Open the discussion</em>
          </button>
        </div>
      ) : null}
    </>
  );
}

export { Fragment };
