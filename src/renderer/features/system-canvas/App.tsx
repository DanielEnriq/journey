import { Fragment, h } from '../../vendor/preact.js';
import { useEffect, useMemo, useRef, useState } from '../../vendor/preact-hooks.js';
import type { Freshness, IndexSummary, RepoChoice } from '../../../shared/system/api.js';
import type { Interpretation, RegistryDiff, SystemRegistry, Trace, ViewRequest, ViewState } from '../../../shared/system/model.js';
import { buildScene, levelKey, type SceneOverflow } from '../../../shared/system/render/index.js';
import { pickSystemApi, type SystemClient } from './api-client.js';
import type { Camera } from './camera.js';
import { Inspector } from './Inspector.js';
import { Harness, Legend, Outline, Player } from './Panels.js';
import { Stage, type Sel, type StageControls } from './Stage.js';
import { LENS_LABEL, presets, resolve } from './views.js';

// The system canvas page: choose a repository (or a labelled fixture), open its registry, choose a view
// (a preset per lens, or a ViewRequest edited in the harness), and explore. Where you are — entered path,
// selection, cameras, pins — is saved with the view, so closing and reopening returns you to it.

type Source = { kind: 'repo'; id: string; name: string } | { kind: 'fixture'; id: string; name: string };
type Mode = 'system' | 'light' | 'dark';
type Motion = 'system' | 'on' | 'off';

const LS = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d; } catch { return d; } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window */ } },
};

const freshState = (view: string, fp: string): ViewState => ({ view, seenFingerprint: fp, entered: [], selection: null, cameras: {}, pinned: {}, expanded: [] });

const toSel = (s: ViewState['selection']): Sel | null =>
  !s ? null : 'entity' in s ? { kind: 'entity', id: s.entity } : 'relation' in s ? { kind: 'edge', id: s.relation } : { kind: 'step', id: s.step };

export function App() {
  const api = useMemo<SystemClient>(() => pickSystemApi(), []);
  const [repos, setRepos] = useState<RepoChoice[] | null>(null);
  const [fixtures, setFixtures] = useState<{ id: string; label: string }[]>([]);
  const [source, setSource] = useState<Source | null>(null);
  const [registry, setRegistry] = useState<SystemRegistry | null>(null);
  const [summary, setSummary] = useState<IndexSummary | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState<ViewRequest | null>(null);
  const [vs, setVs] = useState<ViewState | null>(null);
  const [fresh, setFresh] = useState<Freshness | null>(null);
  const [diff, setDiff] = useState<RegistryDiff | null>(null);
  const [traces, setTraces] = useState<Trace[]>([]);
  const [traceId, setTraceId] = useState<string | null>(null);
  const [step, setStep] = useState<number | null>(null);
  const [travel, setTravel] = useState<{ id: string; n: number } | null>(null);
  const [panel, setPanel] = useState<{ inspector: boolean; legend: boolean; outline: boolean; harness: boolean; coverage: boolean }>(() => ({
    inspector: false, legend: LS.get('vowe.system.legend', false), outline: false, harness: false, coverage: false,
  }));
  const [mode, setMode] = useState<Mode>(() => LS.get('vowe.system.theme', 'system'));
  const [motion, setMotion] = useState<Motion>(() => LS.get('vowe.system.motion', 'system'));
  const [sysDark, setSysDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  const [sysStill, setSysStill] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const controls = useRef<StageControls | null>(null);
  const camT = useRefTimer();

  /* ---------- appearance ---------- */
  useEffect(() => {
    const qd = matchMedia('(prefers-color-scheme: dark)'), qm = matchMedia('(prefers-reduced-motion: reduce)');
    const a = () => setSysDark(qd.matches), b = () => setSysStill(qm.matches);
    qd.addEventListener('change', a); qm.addEventListener('change', b);
    return () => { qd.removeEventListener('change', a); qm.removeEventListener('change', b); };
  }, []);
  const dark = mode === 'dark' || (mode === 'system' && sysDark);
  const still = motion === 'off' || (motion === 'system' && sysStill);
  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; LS.set('vowe.system.theme', mode); }, [dark, mode]);
  useEffect(() => { document.documentElement.classList.toggle('reduce-motion', still); LS.set('vowe.system.motion', motion); }, [still, motion]);

  /* ---------- sources ---------- */
  useEffect(() => {
    api.repos().then(setRepos, (e: Error) => { setRepos([]); setError(`Couldn’t reach the system service: ${e.message}`); });
    api.fixtures().then(setFixtures, () => setFixtures([]));
    const last = LS.get<Source | null>('vowe.system.source', null);
    if (last) void open(last);
  }, []);

  const repoKey = (s: Source) => (s.kind === 'repo' ? s.id : `fixture:${s.id}`);

  async function open(s: Source, reindex = false) {
    setBusy(s.kind === 'repo' ? `Indexing ${s.name}…` : `Loading ${s.name}…`);
    setError(null);
    try {
      let reg: SystemRegistry;
      if (s.kind === 'repo') {
        const r = await api.open(s.id, reindex ? { reindex } : undefined);
        reg = r.registry; setSummary(r.summary);
        api.freshness(s.id).then(setFresh, () => setFresh(null));
        api.traces(s.id).then(setTraces, () => setTraces([]));
      } else {
        reg = await api.fixture(s.id); setSummary(null); setFresh(null); setTraces([]);
      }
      setSource(s); setRegistry(reg); setDiff(null); setStep(null); setTraceId(null);
      LS.set('vowe.system.source', s);
      // Reopen the last view of this source where it was left.
      const saved = s.kind === 'repo' ? await api.views(s.id).catch(() => []) : LS.get<{ request: ViewRequest; state: ViewState | null }[]>(`vowe.system.views:${repoKey(s)}`, []);
      const lastView = LS.get<string | null>(`vowe.system.view:${repoKey(s)}`, null);
      const pick = saved.find((v) => v.request.id === lastView) ?? null;
      const ps = presets(reg, s.kind === 'repo' ? [] : []);
      const req = pick?.request ?? ps[0];
      choose(req, reg, s, pick?.state ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(null); }
  }

  function choose(req: ViewRequest, reg = registry!, s = source!, state: ViewState | null = null) {
    setRequest(req);
    const st = state ?? LS.get<ViewState | null>(`vowe.system.state:${repoKey(s)}:${req.id}`, null);
    const v = st && st.view === req.id ? st : freshState(req.id, reg.revision.fingerprint);
    if (!st && req.enter && reg.entities[req.enter]) v.entered = [req.enter];
    setVs(v);
    setStep(null);
    LS.set(`vowe.system.view:${repoKey(s)}`, req.id);
  }

  /* ---------- persistence of where you are ---------- */
  const saveT = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!source || !request || !vs) return;
    if (saveT.current) clearTimeout(saveT.current);
    saveT.current = setTimeout(() => {
      const key = repoKey(source);
      LS.set(`vowe.system.state:${key}:${request.id}`, vs);
      const saved = { request, state: vs, savedAt: new Date().toISOString() };
      if (source.kind === 'repo') api.saveView(source.id, saved).catch(() => {});
      else {
        const list = LS.get<typeof saved[]>(`vowe.system.views:${key}`, []).filter((x) => x.request.id !== request.id);
        LS.set(`vowe.system.views:${key}`, [...list, saved]);
      }
    }, 500);
  }, [vs, request]);

  /* ---------- freshness ---------- */
  useEffect(() => {
    if (source?.kind !== 'repo') return;
    const check = () => api.freshness(source.id).then(setFresh, () => {});
    addEventListener('focus', check);
    const t = setInterval(check, 20000);
    return () => { removeEventListener('focus', check); clearInterval(t); };
  }, [source]);

  async function refresh() {
    if (source?.kind !== 'repo') return;
    setBusy('Re-indexing what changed…');
    try {
      const r = await api.refresh(source.id);
      setRegistry(r.registry); setSummary(r.summary); setDiff(r.registryDiff);
      setFresh(await api.freshness(source.id).catch(() => null));
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  }

  /* ---------- the scene ---------- */
  const ps = useMemo(() => (registry ? presets(registry, fresh?.changed ?? []) : []), [registry, fresh?.changed.join('|')]);
  const resolved = useMemo(() => (registry && request ? resolve(registry, request) : null), [registry, request]);
  const trace = traces.find((t) => t.id === traceId) ?? null;
  // Where the layout put things lives in the view's state (saved with it), so reopening keeps every place.
  const memory = () => vs?.layout ?? {};
  const scene = useMemo(() => {
    if (!registry || !resolved || !vs) return null;
    return buildScene(registry, resolved, vs, { layoutMemory: memory(), stale: fresh?.staleEntities ?? [], diff, trace: request && (request.lens === 'path' || request.lens === 'failure') ? trace : null });
  }, [registry, resolved, vs?.entered.join('/'), vs?.pinned, vs?.layout, fresh, diff, trace]);

  // Remember where everything landed, so the next scene keeps it.
  useEffect(() => {
    if (!scene || !vs) return;
    const all = memory();
    const cur = all[scene.level.key] ?? {};
    const missing = Object.keys(scene.placed).filter((id) => !cur[id]);
    if (!missing.length) return;
    setVs({ ...vs, layout: { ...all, [scene.level.key]: { ...cur, ...Object.fromEntries(missing.map((id) => [id, scene.placed[id]])) } } });
  }, [scene]);

  if (!registry || !request || !vs || !scene) {
    return <Chooser repos={repos} fixtures={fixtures} busy={busy} error={error} onOpen={(s) => void open(s)} />;
  }

  const sel = toSel(vs.selection);
  const setSel = (s: Sel | null) => {
    setVs({ ...vs, selection: !s ? null : s.kind === 'entity' ? { entity: s.id } : s.kind === 'edge' ? { relation: s.id } : s.kind === 'step' ? { step: s.id, sequence: scene.sequence?.id ?? '' } : null });
    if (s?.kind === 'step' && scene.sequence) setStep(scene.sequence.steps.findIndex((x) => x.id === s.id));
    if (s && !panel.inspector) setPanel({ ...panel, inspector: true });
  };
  const enter = (id: string) => setVs({ ...vs, entered: [...vs.entered, id], selection: null });
  const exit = () => {
    if (!vs.entered.length) return;
    const out = vs.entered[vs.entered.length - 1];
    setVs({ ...vs, entered: vs.entered.slice(0, -1), selection: { entity: out } });
  };
  const goLevel = (n: number) => setVs({ ...vs, entered: vs.entered.slice(0, n), selection: vs.entered[n] ? { entity: vs.entered[n] } : null });
  // Following a relation: the camera travels to the other end; if it lives on another level, go there.
  const follow = (id: string) => {
    if (scene.nodes.some((n) => n.id === id) || scene.nodes.some((n) => n.parts.some((p) => p.entity === id))) {
      setSel({ kind: 'entity', id });
      setTravel({ id, n: (travel?.n ?? 0) + 1 });
      return;
    }
    // Find the level where it (or its nearest ancestor) is drawn: its parent chain.
    const chain: string[] = [];
    let p = registry.entities[id]?.parent;
    while (p) { chain.unshift(p); p = registry.entities[p]?.parent; }
    const enterable = chain.filter((c) => registry.entities[c] && registry.entities[c].kind !== 'system' && registry.entities[c].kind !== 'subsystem');
    const entered = enterable.length > 1 ? enterable.slice(0, -1) : [];
    setVs({ ...vs, entered, selection: { entity: id } });
    setTravel({ id: enterable[enterable.length - 1] ?? id, n: (travel?.n ?? 0) + 1 });
  };
  const pin = (id: string, at: [number, number]) => {
    const k = scene.level.key;
    setVs({ ...vs, pinned: { ...vs.pinned, [k]: { ...(vs.pinned[k] ?? {}), [id]: at } } });
  };
  const onCamera = (k: string, c: Camera) => camT(() => setVs((cur) => (cur ? { ...cur, cameras: { ...cur.cameras, [k]: { x: Math.round(c.x), y: Math.round(c.y), z: Math.round(c.z * 1000) / 1000 } } } : cur)));
  const tidy = () => {
    const k = scene.level.key;
    const m = { ...memory() }; delete m[k];
    const pins = { ...vs.pinned }; delete pins[k];
    const cams = { ...vs.cameras }; delete cams[k];
    setVs({ ...vs, layout: m, pinned: pins, cameras: cams });
  };
  const propose = async (i: Interpretation) => {
    if (source?.kind !== 'repo') throw new Error('Fixtures are read-only.');
    setRegistry(await api.addInterpretation(source.id, i));
  };
  const overflow = (ov: SceneOverflow) => {
    const names = ov.hidden.slice(0, 40).map((id) => registry.entities[id]?.name ?? id).join(', ');
    alert(`${ov.hidden.length} more here, not drawn to keep this readable:\n\n${names}\n\nAdd any of them to the view request (include) to draw them.`);
  };

  const rootE = scene.level.root ? registry.entities[scene.level.root] : null;
  const changedN = fresh?.changed.length ?? 0;
  const lensNames = new Set(ps.map((x) => x.lens));
  const isAgent = request.source.kind === 'agent';
  const camSaved = vs.cameras[scene.level.key] ?? null;
  const seqPossible = scene.sequence && scene.sequence.kind === 'code-path';
  const sequenceTraces = request.lens === 'path' || request.lens === 'failure' ? traces : [];

  return (
    <div class={`sc-root sc-app ${panel.inspector ? 'has-insp' : ''} ${panel.outline || panel.harness ? 'has-left' : ''}`}>
      <header class="sc-top">
        <button type="button" class="brand" onClick={() => { setRegistry(null); setRequest(null); setVs(null); LS.set('vowe.system.source', null); }} title="Choose another system">
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M2 4h6v4H2zM10 10h6v4h-6zM8 6h3v6h-1" class="brand-mark" /></svg>
          <span>{source!.name}</span>{source!.kind === 'fixture' && <span class="tag tag-fixture">fixture</span>}
        </button>
        <nav class="lenses" aria-label="Views">
          {ps.map((x) => (
            <button type="button" key={x.id} class={`lens ${request.id === x.id ? 'on' : ''}`} aria-pressed={request.id === x.id} onClick={() => choose(x)} title={x.question}>{LENS_LABEL[x.lens]}</button>
          ))}
          {!ps.some((x) => x.id === request.id) && <button type="button" class="lens on" aria-pressed="true">{request.title}</button>}
          <select class="lens-select" aria-label="View" value={request.id} onChange={(e: Event) => { const x = ps.find((q) => q.id === (e.target as HTMLSelectElement).value); if (x) choose(x); }}>
            {ps.map((x) => <option key={x.id} value={x.id}>{LENS_LABEL[x.lens]}</option>)}
            {!ps.some((x) => x.id === request.id) && <option value={request.id}>{request.title}</option>}
          </select>
        </nav>
        <div class="tools">
          <button type="button" class={`tbtn ${panel.harness ? 'on' : ''}`} onClick={() => setPanel({ ...panel, harness: !panel.harness, outline: false })} aria-pressed={panel.harness} title="Show or edit the view request an agent would send">{'{ }'} <span class="tl">Request</span></button>
          <button type="button" class={`tbtn ${panel.outline ? 'on' : ''}`} onClick={() => setPanel({ ...panel, outline: !panel.outline, harness: false })} aria-pressed={panel.outline} title="This level as a list">☰ <span class="tl">List</span></button>
          <button type="button" class={`tbtn ${panel.legend ? 'on' : ''}`} onClick={() => { LS.set('vowe.system.legend', !panel.legend); setPanel({ ...panel, legend: !panel.legend }); }} aria-pressed={panel.legend} title="How to read the drawing">◩ <span class="tl">Legend</span></button>
          <button type="button" class="tbtn" onClick={() => setMotion(motion === 'off' ? 'on' : motion === 'on' ? 'system' : 'off')} title={`Motion: ${motion}${motion === 'system' ? (sysStill ? ' (reduced)' : ' (full)') : ''}`} aria-label={`Motion ${motion}`}>{still ? '◌' : '◎'} <span class="tl">Motion {motion === 'system' ? 'auto' : motion}</span></button>
          <button type="button" class="tbtn" onClick={() => setMode(mode === 'system' ? (dark ? 'light' : 'dark') : mode === 'dark' ? 'light' : 'system')} title={`Theme: ${mode}`} aria-label={`Theme ${mode}`}>{dark ? '☾' : '☀'}</button>
          <button type="button" class={`tbtn ${panel.inspector ? 'on' : ''}`} onClick={() => setPanel({ ...panel, inspector: !panel.inspector })} aria-pressed={panel.inspector} title="Inspector">ⓘ</button>
        </div>
      </header>

      <div class="sc-fresh" role="status">
        {source!.kind === 'fixture' && registry.fixture
          ? <span class="fr-item"><span class="tag tag-fixture">fixture</span> {registry.fixture.label} — {registry.fixture.note}</span>
          : <span class="fr-item">Indexed <code>{registry.revision.head?.slice(0, 7) ?? 'no commit'}</code>{registry.revision.branch ? ` on ${registry.revision.branch}` : ''} · {ago(registry.revision.indexedAt)}{registry.revision.dirty.length ? ` · ${registry.revision.dirty.length} uncommitted file${registry.revision.dirty.length === 1 ? '' : 's'} included` : ''}{summary?.cached ? ' · from cache' : ''}</span>}
        {changedN > 0 && <span class="fr-item fr-stale"><i class="hatch-swatch" aria-hidden="true"></i>{changedN} file{changedN === 1 ? '' : 's'} changed since indexed{fresh?.headMoved ? ' (new commit)' : ''} — parts drawn hatched may be out of date <button type="button" class="btn small" onClick={() => void refresh()}>Refresh</button></span>}
        {diff && <span class="fr-item fr-diff">After refresh: {diff.entities.added.length} new · {diff.entities.changed.length} changed · {diff.entities.removed.length} gone <button type="button" class="link" onClick={() => setDiff(null)}>clear marks</button></span>}
        {(registry.incomplete || registry.coverage.limits.length > 0) && (
          <span class="fr-item fr-cov"><button type="button" class="link" aria-expanded={panel.coverage} onClick={() => setPanel({ ...panel, coverage: !panel.coverage })}>{registry.incomplete ? '⚠ Incomplete index' : 'Coverage limits'} · {registry.coverage.limits.length}</button></span>
        )}
        {busy && <span class="fr-item fr-busy">{busy}</span>}
        {error && <span class="fr-item warn">{error} <button type="button" class="link" onClick={() => setError(null)}>dismiss</button></span>}
      </div>
      {panel.coverage && (
        <div class="coverage" role="region" aria-label="Coverage">
          <p><strong>What this index can’t establish.</strong> Parts that depend on these are drawn with what is known, and say so.</p>
          <ul>{registry.coverage.limits.map((l) => <li key={l}>{l}</li>)}</ul>
          <p class="muted">{Object.entries(registry.coverage.byLang).map(([k, c]) => `${k}: ${c!.indexed}/${c!.files}${c!.partial ? ` (${c!.partial} partial)` : ''}${c!.unsupported ? ` (${c!.unsupported} not parsed)` : ''}`).join(' · ')}</p>
          {registry.diagnostics.filter((d) => d.severity !== 'info').slice(0, 8).map((d, i) => <p key={i} class="muted">{d.severity}: {d.message}</p>)}
        </div>
      )}

      <main class="sc-main">
        {(panel.outline || panel.harness) && (
          <aside class="sc-left">
            {panel.harness
              ? <Harness request={request} registry={registry} onApply={(r) => choose(r)} onClose={() => setPanel({ ...panel, harness: false })} />
              : <Outline scene={scene} selected={sel?.kind === 'entity' ? sel.id : null} onSelect={(id) => follow(id)} onEnter={enter} />}
          </aside>
        )}
        <section class="sc-canvas" aria-label="Canvas">
          <div class="crumbs-row">
            <nav class="crumbs" aria-label="Where you are">
              <button type="button" class={`crumb ${vs.entered.length === 0 ? 'here' : ''}`} onClick={() => goLevel(0)}>{source!.name}</button>
              {vs.entered.map((id, i) => (
                <span key={id}><span class="crumb-sep" aria-hidden="true">›</span><button type="button" class={`crumb ${i === vs.entered.length - 1 ? 'here' : ''}`} aria-current={i === vs.entered.length - 1 ? 'location' : undefined} onClick={() => goLevel(i + 1)}>{registry.entities[id]?.name ?? id}</button></span>
              ))}
              {vs.entered.length > 0 && <button type="button" class="btn small out" onClick={exit} title="Back out (Esc)">Out ↑</button>}
            </nav>
            <div class={`question ${isAgent ? 'agent' : ''}`}>
              <span class="q-lens">{LENS_LABEL[request.lens]}</span>
              <span class="q-text">{request.question}</span>
              {isAgent && <span class="tag tag-proposed" title="Chosen by an agent: a proposal until a person keeps it">proposed by {request.source.name}</span>}
              <button type="button" class="link q-tidy" onClick={tidy} title="Forget remembered positions and pins on this level">tidy</button>
            </div>
          </div>
          <Stage
            scene={scene} rootName={rootE?.name ?? ''} rootKind={String(rootE?.kind ?? '')} sel={sel} step={step} savedCamera={camSaved}
            expanded={new Set(vs.expanded)} reducedMotion={still} travel={travel} controls={controls}
            insetBottom={scene.sequence ? (sequenceTraces.length ? 190 : 160) : 0}
            onSelect={setSel} onEnter={enter} onExit={exit} onCamera={onCamera} onPin={pin} onFollow={follow} onOverflow={overflow}
          />
          {panel.legend && <Legend scene={scene} onClose={() => { LS.set('vowe.system.legend', false); setPanel({ ...panel, legend: false }); }} />}
          {scene.sequence && (
            <div class="player-wrap">
              {sequenceTraces.length > 0 && (
                <div class="trace-pick" role="group" aria-label="What the path shows">
                  <button type="button" class={!traceId ? 'on' : ''} aria-pressed={!traceId} onClick={() => { setTraceId(null); setStep(null); }}>From code</button>
                  {sequenceTraces.map((t) => <button type="button" key={t.id} class={traceId === t.id ? 'on' : ''} aria-pressed={traceId === t.id} onClick={() => { setTraceId(t.id); setStep(null); }} title={`${t.recorded.where} · ${t.recorded.at}`}>Recorded: {t.title}</button>)}
                </div>
              )}
              <Player seq={scene.sequence} step={step} onStep={(i) => { setStep(i); if (i !== null && scene.sequence) setVs({ ...vs, selection: { step: scene.sequence.steps[i].id, sequence: scene.sequence.id }, playback: { sequence: scene.sequence.id, step: i } }); }} reducedMotion={still} />
              {seqPossible && <span class="sr-only">This path is derived from code and shows what can happen, not a recording.</span>}
            </div>
          )}
          {scene.warnings.length > 0 && <div class="warnings" role="note">{scene.warnings.slice(0, 3).map((w) => <p key={w}>{w}</p>)}</div>}
          {lensNames.size === 0 && null}
        </section>
        {panel.inspector && (
          <aside class="sc-insp" aria-label="Inspector">
            <Inspector
              registry={registry} scene={scene} sel={sel} stale={new Set(fresh?.staleEntities ?? [])}
              source={(f, a, b) => (source!.kind === 'repo' ? api.source(source!.id, f, a, b, 3) : Promise.reject(new Error('Fixtures have no source files.')))}
              onFollow={follow} onSelect={setSel} onEnter={enter} onPropose={propose} onClose={() => setPanel({ ...panel, inspector: false })}
            />
          </aside>
        )}
      </main>
    </div>
  );
}

function useRefTimer() {
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  return (fn: () => void) => { if (t.current) clearTimeout(t.current); t.current = setTimeout(fn, 400); };
}

function ago(iso: string) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!isFinite(s)) return iso;
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

function Chooser({ repos, fixtures, busy, error, onOpen }: { repos: RepoChoice[] | null; fixtures: { id: string; label: string }[]; busy: string | null; error: string | null; onOpen(s: Source): void }) {
  return (
    <div class="sc-root chooser">
      <div class="chooser-card">
        <h1>System canvas</h1>
        <p class="lede">A drawing of a real system you can enter: its parts, how they connect, and the code each one rests on.</p>
        {busy && <p class="busy" role="status">{busy}</p>}
        {error && <p class="warn" role="alert">{error}</p>}
        <h2>Repositories</h2>
        {repos === null ? <p class="muted">Looking…</p> : repos.length === 0 ? <p class="muted">None available.</p> : (
          <ul class="choices">{repos.map((r) => (
            <li key={r.id}><button type="button" class="choice" disabled={!!busy} onClick={() => onOpen({ kind: 'repo', id: r.id, name: r.name })}>
              <strong>{r.name}</strong><span class="muted">{r.root}</span><span class="muted">{r.indexed ? `indexed ${ago(r.indexed.indexedAt)}` : 'not indexed yet — opening indexes it'}</span>
            </button></li>
          ))}</ul>
        )}
        {fixtures.length > 0 && <>
          <h2>Fixtures <span class="tag tag-fixture">labelled</span></h2>
          <p class="muted">Hand-made systems for demonstration. They describe no repository.</p>
          <ul class="choices">{fixtures.map((f) => (
            <li key={f.id}><button type="button" class="choice" disabled={!!busy} onClick={() => onOpen({ kind: 'fixture', id: f.id, name: f.label })}><strong>{f.label}</strong><span class="muted">fixture</span></button></li>
          ))}</ul>
        </>}
      </div>
    </div>
  );
}
