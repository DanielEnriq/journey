import { Fragment, h } from '../../vendor/preact.js';
import { useEffect, useRef, useState } from '../../vendor/preact-hooks.js';
import type { SystemRegistry, ViewRequest } from '../../../shared/system/model.js';
import {
  GRAMMAR, outlineFor, PROVENANCE_SAYS, STATUS_SAYS, type FormId, type RelationGrammar, type SceneSequence, type SystemScene,
} from '../../../shared/system/render/index.js';
import { Edge, ProvMark, type DrawOpts } from './draw.js';
import { validateRequest } from './views.js';

/* ---------- the sequence player ---------- */

// Steps a path or a failure one at a time. Playing moves at an even pace that implies no timing: a
// code-derived path never claims how long anything takes, and a recording shows its recorded times as
// numbers beside the steps rather than as speed.

export function Player({ seq, step, onStep, reducedMotion }: { seq: SceneSequence; step: number | null; onStep(i: number | null): void; reducedMotion: boolean }) {
  const [playing, setPlaying] = useState(false);
  const n = seq.steps.length;
  const cur = step ?? -1;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!playing) return;
    if (cur >= n - 1) { setPlaying(false); return; }
    timer.current = setTimeout(() => onStep(cur + 1), reducedMotion ? 1800 : 1400);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [playing, cur]);
  const s = cur >= 0 ? seq.steps[cur] : null;
  const observed = seq.kind === 'trace';
  return (
    <div class={`player ${observed ? 'is-observed' : 'is-possible'}`} role="region" aria-label="Sequence player">
      <div class="player-top">
        <span class={`claim ${observed ? 'claim-observed' : 'claim-possible'}`} title={seq.claim}>
          <i aria-hidden="true" class={`claim-mark ${observed ? 'solid' : 'dashed'}`}></i>
          {observed ? 'Observed' : 'Possible path · derived from code'}
        </span>
        <strong class="player-title">{seq.title}</strong>
        {observed && seq.recorded && <span class="muted player-where">recorded {seq.recorded.where} · {fmtDate(seq.recorded.at)}</span>}
      </div>
      <div class="player-row">
        <button type="button" class="pbtn" onClick={() => { setPlaying(false); onStep(0); }} aria-label="Replay from the start" title="Replay">⏮</button>
        <button type="button" class="pbtn" onClick={() => { setPlaying(false); onStep(Math.max(0, cur - 1)); }} disabled={cur <= 0} aria-label="Previous step" title="Previous step">◀</button>
        <button type="button" class="pbtn play" onClick={() => { if (cur >= n - 1) onStep(0); setPlaying(!playing); }} aria-label={playing ? 'Pause' : 'Play'} aria-pressed={playing} title={playing ? 'Pause' : 'Play'}>{playing ? '❚❚' : '▶'}</button>
        <button type="button" class="pbtn" onClick={() => { setPlaying(false); onStep(Math.min(n - 1, cur + 1)); }} disabled={cur >= n - 1} aria-label="Next step" title="Next step">▶︎|</button>
        <input type="range" class="scrub" min={0} max={n - 1} value={Math.max(0, cur)} aria-label="Step" onInput={(e: Event) => { setPlaying(false); onStep(Number((e.target as HTMLInputElement).value)); }} />
        <span class="player-count">{cur + 1}/{n}</span>
        <button type="button" class="pbtn" onClick={() => { setPlaying(false); onStep(null); }} aria-label="Stop showing steps" title="Hide steps">×</button>
      </div>
      <p class="player-step" aria-live="polite">
        {s ? <span><b>{cur + 1}.</b> {s.label}{s.guard ? <em> — only if <code>{s.guard}</code></em> : null}{s.time !== undefined ? <span class="muted"> · {s.time} ms (recorded)</span> : null}</span> : <span class="muted">{seq.notes[0] ?? 'Press play or step through. Each step can be selected for its evidence.'}</span>}
      </p>
    </div>
  );
}

const fmtDate = (iso: string) => { const d = new Date(iso); return isNaN(+d) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); };

/* ---------- the view-request harness ---------- */

export function Harness({ request, registry, onApply, onClose }: { request: ViewRequest; registry: SystemRegistry; onApply(r: ViewRequest): void; onClose(): void }) {
  const [text, setText] = useState(() => JSON.stringify(request, null, 2));
  const [errors, setErrors] = useState<string[]>([]);
  useEffect(() => { setText(JSON.stringify(request, null, 2)); setErrors([]); }, [request.id, request.lens]);
  const apply = () => {
    let raw: unknown;
    try { raw = JSON.parse(text); } catch (e) { setErrors([`Not JSON: ${(e as Error).message}`]); return; }
    const v = validateRequest(raw, registry);
    if (!v.ok) { setErrors(v.errors); return; }
    setErrors([]);
    onApply({ ...v.request, source: v.request.source.kind === 'preset' ? { kind: 'harness', id: 'harness', name: 'View request harness' } : v.request.source });
  };
  return (
    <div class="harness" role="dialog" aria-label="View request">
      <header><h2>View request</h2><button type="button" class="insp-close" onClick={onClose} aria-label="Close">×</button></header>
      <p class="muted">What a coding agent would send: a question, a lens and entity ids — never coordinates. Edit and apply to compose the canvas from it.</p>
      <textarea spellcheck={false} value={text} onInput={(e: Event) => setText((e.target as HTMLTextAreaElement).value)} aria-label="ViewRequest JSON" aria-invalid={errors.length > 0} />
      {errors.length > 0 && <ul class="errors" role="alert">{errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      <div class="row">
        <button type="button" class="btn primary" onClick={apply}>Apply</button>
        <button type="button" class="btn" onClick={() => { setText(JSON.stringify(request, null, 2)); setErrors([]); }}>Reset</button>
        <button type="button" class="btn" onClick={() => navigator.clipboard?.writeText(text)}>Copy</button>
      </div>
    </div>
  );
}

/* ---------- legend ---------- */

const SAMPLE: DrawOpts = { lod: 'near', z: 1, selected: null, related: new Set(), hover: null, expanded: new Set(), step: null };

export function Legend({ scene, onClose, docked }: { scene: SystemScene; onClose?(): void; docked?: boolean }) {
  const kinds = scene.legend.relations.length ? scene.legend.relations : [GRAMMAR.calls];
  return (
    <div class={`legend ${docked ? 'docked' : ''}`} role="region" aria-label="Legend">
      <header><h2>How to read this</h2>{onClose && <button type="button" class="insp-close" onClick={onClose} aria-label="Close legend">×</button>}</header>
      <h3>Connections</h3>
      <ul class="lg-rels">{kinds.map((g) => <li key={g.kind}><RelSample g={g} /><span>{g.says}</span></li>)}</ul>
      <p class="muted lg-note">Where a connection crosses from one runtime to another it passes a gate <svg width="16" height="14" class="lg-gate" aria-hidden="true"><path d="M5 0 V14 M11 0 V14" /></svg>. Numbers on a line mean it stands for several finer ones.</p>
      <h3>How we know</h3>
      <ul class="lg-prov">{scene.legend.provenance.map((p) => (
        <li key={p}><svg width="16" height="12" aria-hidden="true"><ProvMark p={p} x={4} y={6} s={8} /></svg><span>{PROVENANCE_SAYS[p]}{p === 'proposed' ? ' — drawn dashed' : p === 'interpretation' ? ' — drawn dash-dot' : p === 'inferred' ? ' — marked ≈ with its rule' : ''}</span></li>
      ))}</ul>
      {scene.legend.status.filter((s) => s !== 'current').length > 0 && <h3>Against the code now</h3>}
      <ul class="lg-status">{scene.legend.status.filter((s) => s !== 'current').map((s) => <li key={s}><span class={`tag st-${s}`}>{s}</span> {STATUS_SAYS[s]}</li>)}</ul>
      <h3>Forms</h3>
      <ul class="lg-forms">{scene.legend.forms.map((f) => <li key={f.form}><FormSample form={f.form} /><span>{f.kinds.join(', ')}</span></li>)}</ul>
      {scene.sequence && <>
        <h3>Paths</h3>
        <ul class="lg-rels">
          <li><svg width="56" height="16" aria-hidden="true" class="seq seq-possible"><path class="seg-line" d="M2 8 H54" /></svg><span>possible path, derived from code (dashed: not a recording)</span></li>
          <li><svg width="56" height="16" aria-hidden="true" class="seq seq-observed"><path class="seg-line" d="M2 8 H54" /></svg><span>observed in a recorded trace</span></li>
        </ul>
      </>}
    </div>
  );
}

function RelSample({ g }: { g: RelationGrammar }) {
  const e = { id: `lg-${g.kind}`, kind: g.kind, from: 'a', to: 'b', relations: [], count: 1, provenance: 'code' as const, provenanceMix: {}, status: 'current' as const, grammar: g, points: [{ x: 4, y: 9 }, { x: 58, y: 9 }], crossings: [], back: false, emphasis: 'context' as const, parts: [null, null] as [null, null] };
  return <svg width="64" height="18" class="lg-sample" aria-hidden="true"><Edge e={e} o={SAMPLE} onSelect={() => {}} onHover={() => {}} /></svg>;
}

function FormSample({ form }: { form: FormId }) {
  const chip = ['function', 'command', 'column', 'interaction', 'endpoint', 'step', 'store-function'].includes(form);
  const [w, hh] = chip ? [44, 14] : form === 'bridge' ? [30, 22] : [44, 26];
  return <svg width="48" height="30" aria-hidden="true" class={`lg-form f-${form}`}><g transform={`translate(${(48 - w) / 2} ${(30 - hh) / 2})`}><path class="n-body" d={outlineFor(form, w, hh)} /></g></svg>;
}

/* ---------- outline: the level as a list ---------- */

export function Outline({ scene, selected, onSelect, onEnter }: { scene: SystemScene; selected: string | null; onSelect(id: string): void; onEnter(id: string): void }) {
  const byId = new Map(scene.nodes.map((n) => [n.id, n]));
  return (
    <nav class="outline" aria-label="Parts on this level, as a list">
      <h2>On this level</h2>
      <ul>
        {scene.outline.map((o) => {
          const n = byId.get(o.id)!;
          return (
            <li key={o.id}>
              <button type="button" class={`ol-item ${selected === o.id ? 'sel' : ''}`} aria-current={selected === o.id} onClick={() => onSelect(o.id)}>
                <span class="ol-name">{o.name}</span> <span class="ol-kind">{o.kindLabel}{n.status !== 'current' ? ` · ${n.status}` : ''}{n.provenance !== 'code' ? ` · ${n.provenance}` : ''}</span>
              </button>
              {n.enterable && <button type="button" class="ol-enter" onClick={() => onEnter(o.id)} aria-label={`Enter ${o.name}`}>enter</button>}
              {o.parts.length > 0 && <ul>{o.parts.map((p) => <li key={p.id}><button type="button" class={`ol-item sub ${selected === p.id ? 'sel' : ''}`} onClick={() => onSelect(p.id)}>{p.label}</button></li>)}</ul>}
            </li>
          );
        })}
        {scene.portals.length > 0 && <li class="ol-sep">Outside, at the edges</li>}
        {scene.portals.map((p) => <li key={p.id}><button type="button" class={`ol-item ${selected === p.id ? 'sel' : ''}`} onClick={() => onSelect(p.id)}>{p.name} <span class="ol-kind">{p.kindLabel} · {p.side}</span></button></li>)}
      </ul>
    </nav>
  );
}
