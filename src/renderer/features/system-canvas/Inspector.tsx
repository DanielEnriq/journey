import { h } from '../../vendor/preact.js';
import { useEffect, useState } from '../../vendor/preact-hooks.js';
import type { SourceExcerpt } from '../../../shared/system/api.js';
import type { Entity, EntityKind, Evidence, Interpretation, Relation, SystemRegistry } from '../../../shared/system/model.js';
import { grammarFor, PROVENANCE_SAYS, STATUS_SAYS, type SceneEdge, type SceneStub, type SystemScene } from '../../../shared/system/render/index.js';
import { Legend } from './Panels.js';
import type { Sel } from './Stage.js';

// The inspector: what the selected thing is, how we know (provenance, rule, confidence, evidence with the
// source it rests on), where it stands against the code now, and what it connects to — each connection a
// way to travel there. A person can propose a rename or a reclassification; it is saved as a proposed
// interpretation and drawn as such, never applied silently.

export interface InspectorProps {
  registry: SystemRegistry;
  scene: SystemScene;
  sel: Sel | null;
  stale: Set<string>;
  source(file: string, start: number, end: number): Promise<SourceExcerpt>;
  onFollow(id: string): void;
  onSelect(sel: Sel): void;
  onEnter(id: string): void;
  onPropose(i: Interpretation): Promise<void>;
  onClose(): void;
}

export function Inspector(p: InspectorProps) {
  const { registry: reg, sel } = p;
  if (!sel) return <Empty scene={p.scene} />;
  let body: h.JSX.Element;
  if (sel.kind === 'entity') {
    const e = reg.entities[sel.id];
    body = e ? <EntityView {...p} e={e} /> : <Missing id={sel.id} />;
  } else if (sel.kind === 'edge') {
    const e = p.scene.edges.find((x) => x.id === sel.id);
    body = e ? <EdgeView {...p} edge={e} /> : <Missing id={sel.id} />;
  } else if (sel.kind === 'step') {
    body = <StepView {...p} id={sel.id} />;
  } else {
    const s = p.scene.stubs.find((x) => x.id === sel.id);
    body = s ? <StubView {...p} stub={s} /> : <Missing id={sel.id} />;
  }
  return (
    <div class="insp">
      <button type="button" class="insp-close" onClick={p.onClose} aria-label="Close the inspector">×</button>
      {body}
    </div>
  );
}

function Empty({ scene }: { scene: SystemScene }) {
  return (
    <div class="insp insp-empty">
      <p class="insp-kicker">Nothing selected</p>
      <p>Click a part, a line or a step — or press Tab — to see what it is and the code it rests on. Double-click or Enter goes inside a part; Esc comes back out.</p>
      <p class="muted">{scene.nodes.length} parts and {scene.edges.length} connections on this level{scene.stubs.length ? `; ${scene.stubs.reduce((n, s) => n + s.count, 0)} more lead outside the view` : ''}.</p>
      <Legend scene={scene} docked />
    </div>
  );
}

function Missing({ id }: { id: string }) {
  return <div><h2 class="insp-title">{id}</h2><p class="warn">Not in the registry: it was asked for, deleted, or renamed and not matched.</p></div>;
}

function Badge({ p, conf, rule }: { p: Entity['provenance']; conf?: number; rule?: string }) {
  return (
    <span class={`badge prov prov-${p}`} title={PROVENANCE_SAYS[p]}>
      <i class={`pm-glyph g-${p}`} aria-hidden="true"></i>
      {PROVENANCE_SAYS[p]}{conf !== undefined ? ` · ${Math.round(conf * 100)}% match` : ''}{rule ? ` · rule ${rule}` : ''}
    </span>
  );
}

function StatusLine({ status }: { status: Entity['status'] }) {
  if (status === 'current') return <span class="badge st st-current">matches the index</span>;
  return <span class={`badge st st-${status}`}>{status} — {STATUS_SAYS[status]}</span>;
}

function EntityView(p: InspectorProps & { e: Entity }) {
  const { e, registry: reg } = p;
  const children = Object.values(reg.entities).filter((c) => c.parent === e.id).sort((a, b) => (a.id < b.id ? -1 : 1));
  const out = Object.values(reg.relations).filter((r) => r.from === e.id).sort(byKind);
  const inn = Object.values(reg.relations).filter((r) => r.to === e.id).sort(byKind);
  const ev = e.evidence.map((id) => reg.evidence[id]).filter(Boolean);
  const rule = ev.find((x) => x.kind === 'rule')?.rule;
  const parent = e.parent ? reg.entities[e.parent] : undefined;
  const status = p.stale.has(e.id) && e.status === 'current' ? 'stale' : e.status;
  const interps = (e.interpretations ?? []).map((id) => reg.interpretations[id]).filter(Boolean);
  const node = p.scene.nodes.find((n) => n.id === e.id);
  return (
    <div>
      <p class="insp-kicker">{e.kind}{parent ? <span> · in <a href="#" onClick={(x: Event) => { x.preventDefault(); p.onFollow(parent.id); }}>{parent.name}</a></span> : null}</p>
      <h2 class="insp-title">{e.name}</h2>
      {e.summary && <p class="insp-summary">{e.summary}</p>}
      <div class="badges"><Badge p={e.provenance} conf={e.confidence} rule={rule} /><StatusLine status={status} /></div>
      {reg.fixture && <p class="fixture-note">From a labelled fixture ({reg.fixture.label}) — not evidence about any repository.</p>}
      {children.length > 0 && (
        <section>
          <h3>Inside · {children.length}</h3>
          {node?.enterable && <button type="button" class="btn small" onClick={() => p.onEnter(e.id)}>Enter {e.name}</button>}
          <ul class="chips">{children.slice(0, 24).map((c) => <li key={c.id}><button type="button" class="chip" onClick={() => p.onSelect({ kind: 'entity', id: c.id })}>{c.name} <em>{c.kind}</em></button></li>)}</ul>
          {children.length > 24 && <p class="muted">+{children.length - 24} more</p>}
        </section>
      )}
      <Relations title="Goes out to" rels={out} reg={reg} end="to" onFollow={p.onFollow} />
      <Relations title="Comes in from" rels={inn} reg={reg} end="from" onFollow={p.onFollow} />
      <section>
        <h3>Where it is in the code</h3>
        {e.anchors.length ? <ul class="anchors">{e.anchors.map((a, i) => <li key={i}><code>{a.file}{a.range ? `:${a.range.start.line}` : ''}</code>{a.symbol ? <span class="muted"> {a.symbol.split('#')[1]}</span> : null}</li>)}</ul> : <p class="muted">No anchor in code{e.provenance === 'interpretation' ? ' — this is an interpretation.' : '.'}</p>}
      </section>
      <EvidenceList ev={ev} {...p} />
      <section>
        <h3>Interpretations</h3>
        {interps.length ? <ul class="interps">{interps.map((i) => <li key={i.id}><span class={`badge prov prov-${i.status === 'accepted' ? 'interpretation' : 'proposed'}`}>{i.status}</span> {describeOp(i, reg)} <span class="muted">— {i.by.name}</span></li>)}</ul> : <p class="muted">None yet.</p>}
        <Propose e={e} onPropose={p.onPropose} />
      </section>
    </div>
  );
}

const byKind = (a: Relation, b: Relation) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.id < b.id ? -1 : 1);

function Relations({ title, rels, reg, end, onFollow }: { title: string; rels: Relation[]; reg: SystemRegistry; end: 'from' | 'to'; onFollow(id: string): void }) {
  if (!rels.length) return null;
  return (
    <section>
      <h3>{title} · {rels.length}</h3>
      <ul class="rels">
        {rels.slice(0, 30).map((r) => {
          const other = reg.entities[r[end]];
          return (
            <li key={r.id}>
              <span class={`rel-kind k-${r.kind}`} title={grammarFor(r.kind).says}>{r.kind.replace('_', ' ')}</span>
              <button type="button" class="link" onClick={() => onFollow(r[end])} title="Go there">{other?.name ?? r[end]}{!other && <em> (not indexed)</em>}</button>
              {r.label && <code class="rel-label">{r.label}</code>}
              {r.provenance !== 'code' && <span class={`mini prov-${r.provenance}`}>{r.provenance}</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function EvidenceList(p: InspectorProps & { ev: Evidence[] }) {
  if (!p.ev.length) return <section><h3>Evidence</h3><p class="muted">No evidence recorded{p.ev.length === 0 ? '' : ''}.</p></section>;
  return (
    <section>
      <h3>Evidence · {p.ev.length}</h3>
      <ol class="evidence">{p.ev.slice(0, 20).map((x) => <EvidenceItem key={x.id} x={x} source={p.source} />)}</ol>
      {p.ev.length > 20 && <p class="muted">+{p.ev.length - 20} more</p>}
    </section>
  );
}

function EvidenceItem({ x, source }: { x: Evidence; source: InspectorProps['source'] }) {
  const [open, setOpen] = useState(false);
  const [ex, setEx] = useState<SourceExcerpt | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!open || ex || !x.range) return;
    source(x.range.file, x.range.start.line, x.range.end.line).then(setEx, (e: Error) => setErr(e.message));
  }, [open]);
  const changed = ex && x.fileHash && ex.hash && !ex.hash.startsWith(x.fileHash) && !x.fileHash.startsWith(ex.hash);
  return (
    <li class={`ev ev-${x.kind}`}>
      <div class="ev-head">
        <span class="ev-kind">{x.kind}</span>
        <span class="ev-sum">{x.summary}</span>
      </div>
      {x.range && (
        <button type="button" class="link ev-open" aria-expanded={open} onClick={() => setOpen(!open)}>
          {x.range.file}:{x.range.start.line}{x.range.end.line !== x.range.start.line ? `–${x.range.end.line}` : ''} {open ? '▾' : '▸'}
        </button>
      )}
      {open && err && <p class="warn">Couldn’t read the source: {err}</p>}
      {open && ex && (
        <div class="excerpt">
          {changed && <p class="warn">⚠ This file changed since it was indexed — the lines may no longer say this.</p>}
          <pre>{ex.lines.map((l, i) => {
            const n = ex.start + i;
            const hot = n >= ex.focus.start && n <= ex.focus.end;
            return <div key={n} class={hot ? 'hot' : ''}><span class="ln">{n}</span>{l || ' '}</div>;
          })}</pre>
        </div>
      )}
    </li>
  );
}

function describeOp(i: Interpretation, reg: SystemRegistry): string {
  const n = (id: string) => reg.entities[id]?.name ?? id;
  switch (i.op.kind) {
    case 'rename': return `rename ${n(i.op.entity)} → “${i.op.name}”`;
    case 'classify': return `classify ${n(i.op.entity)} as ${i.op.as}`;
    case 'summarise': return `summary: ${i.op.summary}`;
    case 'group': return `group ${i.op.members.length} as ${i.op.name}`;
    case 'relate': return `${n(i.op.from)} ${i.op.relation} ${n(i.op.to)}`;
    case 'reject': return `reject ${i.op.target}`;
  }
}

const KINDS: EntityKind[] = ['interface', 'client', 'adapter', 'transport', 'service', 'endpoint', 'worker', 'queue', 'event-channel', 'store', 'engine', 'module', 'external', 'state', 'schema', 'validator'];

function Propose({ e, onPropose }: { e: Entity; onPropose(i: Interpretation): Promise<void> }) {
  const [mode, setMode] = useState<'rename' | 'classify' | null>(null);
  const [val, setVal] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const submit = async (ev: Event) => {
    ev.preventDefault();
    if (!mode || !val.trim()) return;
    const i: Interpretation = {
      id: `interp:${mode}:${e.id}:${Date.now().toString(36)}`,
      op: mode === 'rename' ? { kind: 'rename', entity: e.id, name: val.trim() } : { kind: 'classify', entity: e.id, as: val },
      by: { kind: 'human', id: 'me', name: 'You' }, at: new Date().toISOString(), status: 'proposed',
    };
    try { await onPropose(i); setNote('Saved as a proposed interpretation.'); setMode(null); setVal(''); }
    catch (err) { setNote(`Not saved: ${(err as Error).message}`); }
  };
  return (
    <div class="propose">
      {!mode && <div class="row"><button type="button" class="btn small" onClick={() => { setMode('rename'); setVal(e.name); }}>Propose a rename</button><button type="button" class="btn small" onClick={() => { setMode('classify'); setVal(String(e.kind)); }}>Propose another kind</button></div>}
      {mode && (
        <form onSubmit={submit} class="propose-form">
          <label>{mode === 'rename' ? 'New name' : 'Should be a'}
            {mode === 'rename'
              ? <input value={val} onInput={(x: Event) => setVal((x.target as HTMLInputElement).value)} />
              : <select value={val} onChange={(x: Event) => setVal((x.target as HTMLSelectElement).value)}>{KINDS.map((k) => <option key={k} value={k}>{k}</option>)}</select>}
          </label>
          <p class="muted">Saved as a proposal (drawn dashed) until someone accepts it. The code is not changed.</p>
          <div class="row"><button type="submit" class="btn small primary">Save proposal</button><button type="button" class="btn small" onClick={() => setMode(null)}>Cancel</button></div>
        </form>
      )}
      {note && <p class="muted" role="status">{note}</p>}
    </div>
  );
}

function EdgeView(p: InspectorProps & { edge: SceneEdge }) {
  const { edge: e, registry: reg } = p;
  const rels = e.relations.map((id) => reg.relations[id]).filter(Boolean);
  const name = (id: string) => reg.entities[id]?.name ?? id;
  const ev = [...new Set(rels.flatMap((r) => r.evidence))].map((id) => reg.evidence[id]).filter(Boolean);
  return (
    <div>
      <p class="insp-kicker">relation · {e.kind.replace('_', ' ')}</p>
      <h2 class="insp-title"><button type="button" class="link" onClick={() => p.onFollow(e.from)}>{name(e.from)}</button> → <button type="button" class="link" onClick={() => p.onFollow(e.to)}>{name(e.to)}</button></h2>
      <p class="insp-summary">{e.grammar.says}.</p>
      <div class="badges"><Badge p={e.provenance} /><StatusLine status={e.status} /></div>
      {e.count > 1 && <p class="muted">Rolled up from {e.count} finer relations between their parts — enter either end to see them.</p>}
      {e.crossings.length > 0 && <p class="muted">Crosses from {e.crossings[0].from} to {e.crossings[0].to}.</p>}
      <section>
        <h3>Relations · {rels.length}</h3>
        <ul class="rels">{rels.map((r) => (
          <li key={r.id}><button type="button" class="link" onClick={() => p.onFollow(r.from)}>{name(r.from)}</button> <span class={`rel-kind k-${r.kind}`}>{r.kind}</span> <button type="button" class="link" onClick={() => p.onFollow(r.to)}>{name(r.to)}</button>{r.label && <code class="rel-label">{r.label}</code>}{r.provenance !== 'code' && <span class={`mini prov-${r.provenance}`}>{r.provenance}{r.confidence !== undefined ? ` ${Math.round(r.confidence * 100)}%` : ''}</span>}</li>
        ))}</ul>
      </section>
      <EvidenceList ev={ev} {...p} />
    </div>
  );
}

function StepView(p: InspectorProps & { id: string }) {
  const seq = p.scene.sequence;
  const s = seq?.steps.find((x) => x.id === p.id);
  if (!seq || !s) return <Missing id={p.id} />;
  const ev = s.evidence.map((id) => p.registry.evidence[id]).filter(Boolean);
  const who = p.registry.entities[s.entity];
  return (
    <div>
      <p class="insp-kicker">step {s.index + 1} of {seq.steps.length} · {seq.title}</p>
      <h2 class="insp-title">{s.label}</h2>
      <p class={`claim ${seq.kind === 'trace' ? 'claim-observed' : 'claim-possible'}`}>{seq.claim}</p>
      {s.detail && <p class="insp-summary">{s.detail}</p>}
      <p>In <button type="button" class="link" onClick={() => p.onFollow(s.entity)}>{who?.name ?? s.entity}</button>{who ? <span class="muted"> · {who.kind}</span> : <em> (not in the registry)</em>}</p>
      {s.ctx.length > 0 && <p class="muted">Inside: {s.ctx.join(' › ')}</p>}
      {s.guard && <p><span class="muted">Only when </span><code>{s.guard}</code></p>}
      {s.next.length > 1 && <p class="muted">Then one of: {s.next.map((n) => seq.steps.find((x) => x.id === n)?.label ?? n).join(' · or · ')}</p>}
      {s.failure && <p class="warn">The view marks this as where it goes wrong.</p>}
      {s.time !== undefined && <p>At <strong>{s.time} ms</strong> from the start of the recording.</p>}
      {s.observed && <dl class="observed">{Object.entries(s.observed).map(([k, v]) => <div key={k}><dt>{k}</dt><dd><code>{String(v)}</code></dd></div>)}</dl>}
      {!s.on && <p class="warn">This step happens in a part not drawn on this level.</p>}
      <EvidenceList ev={ev} {...p} />
    </div>
  );
}

function StubView(p: InspectorProps & { stub: SceneStub }) {
  const s = p.stub;
  return (
    <div>
      <p class="insp-kicker">{s.reason === 'not-indexed' ? 'not indexed' : 'outside this view'}</p>
      <h2 class="insp-title">{s.count} connection{s.count === 1 ? '' : 's'} {s.direction === 'out' ? 'going out' : 'coming in'}</h2>
      <p class="insp-summary">{s.reason === 'not-indexed' ? 'The other end is not in the registry: indexing did not reach it, or it was deleted.' : 'The other end exists but this view left it out. Add it to the view to draw it.'}</p>
      <p class="muted">Kinds: {s.kinds.join(', ')}</p>
      <ul class="rels">{s.others.map((id) => <li key={id}>{p.registry.entities[id] ? <button type="button" class="link" onClick={() => p.onSelect({ kind: 'entity', id })}>{p.registry.entities[id].name}</button> : <code>{id}</code>}</li>)}</ul>
    </div>
  );
}
