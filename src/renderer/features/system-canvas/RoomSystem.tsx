import { Fragment, h, type ComponentChildren } from '../../vendor/preact.js';
import { useEffect, useMemo, useRef, useState } from '../../vendor/preact-hooks.js';
import type { RepoChoice } from '../../../shared/system/api.js';
import type { SystemRegistry, Trace, ViewRequest, ViewState } from '../../../shared/system/model.js';
import { buildScene } from '../../../shared/system/render/index.js';
import { viewsOf } from '../../../shared/canvas/index.js';
import { Store, useStore } from '../../shared/store.js';
import { correct, pointingContext, toSnapshotSelection, type Gesture, type PointingContext, type ReferentTarget } from '../../../shared/system/pointing.js';
import { ToolPan, ToolSelect, ZoomIn, ZoomOut } from '../../shared/components/icons.js';
import type { CanvasClient } from '../canvas/client.js';
import type { SystemClient } from './api-client.js';
import { Inspector } from './Inspector.js';
import { Player } from './Panels.js';
import { Stage, type Sel, type StageControls } from './Stage.js';
import { LENS_LABEL, presets, resolve } from './views.js';

// The system canvas inside a Vowe room: a "System" tab among the room's views. While it's on, the room's
// canvas area draws the room's repository as the registry describes it (the same scene, stage and player
// as the standalone page), under the room's own view tabs and tool rail; the room panel shows what the
// selected part is and the evidence it rests on. Everything comes through SystemApi
// (`window.journey.system` in the app); nothing here writes to the room's canvas document or its record.

export interface RoomSystemSlot {
  on: boolean;
  /** The System tab, drawn after the room's own view tabs. */
  tab: ComponentChildren;
  /** In place of the room's canvas while on; `children` are the room's overlays (call bar, captions). */
  pane(children?: ComponentChildren): ComponentChildren;
  /** What the room panel shows about the selected part; null while nothing on the system canvas is selected. */
  panel: ComponentChildren | null;
}

/**
 * What "this" means on the System view right now, for whatever answers the room's questions: rebuilt on every
 * click, keyboard move and correction, and cleared when nothing is selected. The room's ask flow (and later a
 * voice or pointer agent) reads it from here alongside the canvas snapshot; see INTEGRATION.md.
 */
export const systemPointing = new Store<{ now: { roomId: string; context: PointingContext } | null }>({ now: null });

/** Asking the room's agent about what's pointed at: the room's own entry point (AskVowe.open). */
export interface SystemAsk { selected: string[]; circled: string[]; names: string[]; pointing: PointingContext }

export interface RoomSystemInput {
  /** SystemApi in this window: window.journey.system in the app; absent, the room shows no System tab. */
  api: SystemClient | null | undefined;
  /** The room's repository identity (`github.com/acme/journey`): the indexed repository it maps to locally. */
  repository: string | null;
  /** The room's canvas, for its own view tabs (going back to one turns the System view off). */
  client: CanvasClient;
  ui: Store<{ myView: string | null }>;
  roomId: string;
  /** The room's "Ask about this" (absent: no agent in this room, so no ask button). */
  onAsk?(about: SystemAsk): void;
}

type Load = { state: 'idle' } | { state: 'loading'; what: string } | { state: 'ready' } | { state: 'failed'; error: string };

const fresh = (view: string, fp: string): ViewState => ({ view, seenFingerprint: fp, entered: [], selection: null, cameras: {}, pinned: {}, expanded: [] });
const toSel = (s: ViewState['selection']): Sel | null =>
  !s ? null : 'entity' in s ? { kind: 'entity', id: s.entity } : 'relation' in s ? { kind: 'edge', id: s.relation } : { kind: 'step', id: s.step };

/** Which indexed repository a room's repository identity means: same last path segment, else the only one. */
export function repoFor(identity: string | null, repos: RepoChoice[]): RepoChoice | null {
  const tail = (s: string) => s.replace(/\.git$/, '').split(/[/:]/).filter(Boolean).pop()?.toLowerCase() ?? '';
  if (identity) {
    const want = tail(identity);
    const hit = repos.find((r) => r.id.toLowerCase() === want || r.name.toLowerCase() === want || tail(r.root) === want);
    if (hit) return hit;
  }
  return repos.length === 1 ? repos[0] : null;
}

/** The sheet the system canvas draws with; loaded once, beside the room's own (it is scoped to .sc-root). */
function useSheet() {
  useEffect(() => {
    if (document.querySelector('link[data-system-canvas]')) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = 'features/system-canvas/system-canvas.css';
    l.dataset.systemCanvas = '';
    document.head.appendChild(l);
  }, []);
}

export function useRoomSystem({ api, repository, client, ui, roomId, onAsk }: RoomSystemInput): RoomSystemSlot | null {
  const [on, setOn] = useState(false);
  const [load, setLoad] = useState<Load>({ state: 'idle' });
  const [repo, setRepo] = useState<RepoChoice | null>(null);
  const [registry, setRegistry] = useState<SystemRegistry | null>(null);
  const [traces, setTraces] = useState<Trace[]>([]);
  const [request, setRequest] = useState<ViewRequest | null>(null);
  const [vs, setVs] = useState<ViewState | null>(null);
  const [step, setStep] = useState<number | null>(null);
  const [travel, setTravel] = useState<{ id: string; n: number } | null>(null);
  const controls = useRef<StageControls | null>(null);
  /** How the last pointing was made: a click, or a key (Tab, arrows). */
  const lastInput = useRef<Gesture>('click');
  /** A correction ("not this, that one") replaces the computed context until the selection moves again. */
  const [corrected, setCorrected] = useState<PointingContext | null>(null);
  const cs = useStore(client.store);
  useSheet();

  // Opening the System view the first time reads the repository's registry (the service caches the index).
  useEffect(() => {
    if (!on || !api || load.state !== 'idle') return;
    setLoad({ state: 'loading', what: 'Finding this room’s repository…' });
    (async () => {
      const r = repoFor(repository, await api.repos());
      if (!r) throw new Error(repository ? `${repository} isn’t indexed on this computer.` : 'This room has no repository.');
      setRepo(r);
      setLoad({ state: 'loading', what: r.indexed ? `Reading ${r.name}…` : `Indexing ${r.name}…` });
      const opened = await api.open(r.id);
      const ps = presets(opened.registry);
      setRegistry(opened.registry);
      setRequest(ps[0] ?? null);
      setVs(ps[0] ? fresh(ps[0].id, opened.registry.revision.fingerprint) : null);
      api.traces(r.id).then(setTraces, () => setTraces([]));
      setLoad({ state: 'ready' });
    })().catch((e: Error) => setLoad({ state: 'failed', error: e.message }));
  }, [on, api, load.state]);

  const ps = useMemo(() => (registry ? presets(registry) : []), [registry]);
  const resolved = useMemo(() => (registry && request ? resolve(registry, request) : null), [registry, request]);
  const scene = useMemo(() => (registry && resolved && vs ? buildScene(registry, resolved, vs, { layoutMemory: vs.layout ?? {}, trace: null }) : null),
    [registry, resolved, vs?.entered.join('/'), vs?.pinned, vs?.layout]);
  // Remember where the layout put things, so a later scene on this level keeps them.
  useEffect(() => {
    if (!scene || !vs) return;
    const cur = vs.layout?.[scene.level.key] ?? {};
    const missing = Object.keys(scene.placed).filter((id) => !cur[id]);
    if (missing.length) setVs({ ...vs, layout: { ...(vs.layout ?? {}), [scene.level.key]: { ...cur, ...Object.fromEntries(missing.map((id) => [id, scene.placed[id]])) } } });
  }, [scene]);

  // What "this" means: the selection as the registry names it, with what's next to it as alternatives.
  const pointing = useMemo<PointingContext | null>(() => {
    if (!registry || !scene || !vs?.selection || !request) return null;
    const s0 = vs.selection;
    const target: ReferentTarget | null = 'entity' in s0 ? { kind: 'entity', id: s0.entity }
      : 'relation' in s0 ? (registry.relations[s0.relation] ? { kind: 'relation', id: s0.relation } : null)
      : { kind: 'step', sequence: s0.sequence, step: s0.step };
    if (!target) return null;
    const nearby: ReferentTarget[] = [];
    if (target.kind === 'entity') {
      const holder = scene.nodes.find((n) => n.id !== target.id && n.parts.some((pt) => pt.entity === target.id));
      if (holder) nearby.push({ kind: 'entity', id: holder.id });
      for (const e of scene.edges) {
        const other = e.from === target.id ? e.to : e.to === target.id ? e.from : null;
        if (other && !nearby.some((x) => x.kind === 'entity' && x.id === other)) nearby.push({ kind: 'entity', id: other });
        if (nearby.length >= 3) break;
      }
    }
    return pointingContext(registry, { targets: [target], gesture: lastInput.current, nearby, entered: vs.entered, view: request });
  }, [registry, scene, vs?.selection, request]);
  const ctx = corrected ?? pointing;
  useEffect(() => { setCorrected(null); }, [pointing]);
  useEffect(() => { systemPointing.setState({ now: on && ctx ? { roomId, context: ctx } : null }); }, [on, ctx]);

  if (!api) return null;
  void traces;

  const roomTabs = viewsOf(cs.doc).filter((v) => cs.scenes[v.id]);
  const tab = (
    <button key="system" type="button" class={on ? 'on' : ''} aria-pressed={on} title="This room’s repository, drawn from its code" onClick={() => setOn(true)}>System</button>
  );

  const sel = vs ? toSel(vs.selection) : null;
  const setSel = (s: Sel | null) => {
    if (!vs) return;
    setVs({ ...vs, selection: !s ? null : s.kind === 'entity' ? { entity: s.id } : s.kind === 'edge' ? { relation: s.id } : s.kind === 'step' ? { step: s.id, sequence: scene?.sequence?.id ?? '' } : null });
    if (s?.kind === 'step' && scene?.sequence) setStep(scene.sequence.steps.findIndex((x) => x.id === s.id));
  };
  const choose = (r: ViewRequest) => { if (!registry) return; setRequest(r); setVs(fresh(r.id, registry.revision.fingerprint)); setStep(null); };
  const enter = (id: string) => vs && setVs({ ...vs, entered: [...vs.entered, id], selection: null });
  const exit = () => { if (!vs?.entered.length) return; const out = vs.entered[vs.entered.length - 1]; setVs({ ...vs, entered: vs.entered.slice(0, -1), selection: { entity: out } }); };
  const goLevel = (n: number) => vs && setVs({ ...vs, entered: vs.entered.slice(0, n), selection: vs.entered[n] ? { entity: vs.entered[n] } : null });
  const follow = (id: string) => {
    if (!vs || !registry || !scene) return;
    if (scene.nodes.some((n) => n.id === id || n.parts.some((p) => p.entity === id))) { setSel({ kind: 'entity', id }); setTravel({ id, n: (travel?.n ?? 0) + 1 }); return; }
    const chain: string[] = [];
    let p = registry.entities[id]?.parent;
    while (p) { chain.unshift(p); p = registry.entities[p]?.parent; }
    const enterable = chain.filter((c) => registry.entities[c] && registry.entities[c].kind !== 'system' && registry.entities[c].kind !== 'subsystem');
    setVs({ ...vs, entered: enterable.length > 1 ? enterable.slice(0, -1) : [], selection: { entity: id } });
    setTravel({ id: enterable[enterable.length - 1] ?? id, n: (travel?.n ?? 0) + 1 });
  };
  const pin = (id: string, at: [number, number]) => {
    if (!vs || !scene) return;
    const k = scene.level.key;
    setVs({ ...vs, pinned: { ...vs.pinned, [k]: { ...(vs.pinned[k] ?? {}), [id]: at } } });
  };
  const backToRoom = (view?: string) => { setOn(false); if (view) ui.setState({ myView: view }); };

  const pane = (children?: ComponentChildren) => (
    <section class="surface sc-room-surface" aria-label="System canvas"
      onPointerDownCapture={() => { lastInput.current = 'click'; }} onKeyDownCapture={() => { lastInput.current = 'keyboard'; }}>
      <div class="surface-head">
        <div class="seg" role="group" aria-label="Views">
          {roomTabs.map((v) => <button key={v.id} type="button" title={v.question} aria-pressed={false} onClick={() => backToRoom(v.id)}>{v.name}</button>)}
          {tab}
        </div>
        {ps.length > 0 && request ? (
          <div class="seg sc-lenses" role="group" aria-label="What to look at">
            {ps.map((x) => <button key={x.id} type="button" class={request.id === x.id ? 'on' : ''} aria-pressed={request.id === x.id} title={x.question} onClick={() => choose(x)}>{LENS_LABEL[x.lens]}</button>)}
          </div>
        ) : null}
        {repo && registry ? <span class="prov sc-prov" title={registry.revision.dirty.length ? `${registry.revision.dirty.length} uncommitted files included` : undefined}>{repo.name} · indexed {registry.revision.head?.slice(0, 7) ?? 'no commit'}{registry.revision.dirty.length ? ` · ${registry.revision.dirty.length} uncommitted` : ''}</span> : null}
      </div>
      <div class="sc-root sc-room">
        {scene && vs && request ? (
          <>
            {vs.entered.length > 0 && (
              <nav class="sc-room-crumbs" aria-label="Where you are">
                <button type="button" onClick={() => goLevel(0)}>{repo?.name ?? 'System'}</button>
                {vs.entered.map((id, i) => <span key={id}> › <button type="button" aria-current={i === vs.entered.length - 1 ? 'location' : undefined} onClick={() => goLevel(i + 1)}>{registry!.entities[id]?.name ?? id}</button></span>)}
              </nav>
            )}
            <Stage scene={scene} rootName={scene.level.root ? registry!.entities[scene.level.root]?.name ?? '' : ''} rootKind={scene.level.root ? String(registry!.entities[scene.level.root]?.kind ?? '') : ''}
              sel={sel} step={step} savedCamera={null} expanded={new Set(vs.expanded)} reducedMotion={matchMedia('(prefers-reduced-motion: reduce)').matches}
              travel={travel} controls={controls} insetBottom={scene.sequence ? 150 : 0}
              onSelect={setSel} onEnter={enter} onExit={exit} onCamera={() => {}} onPin={pin} onFollow={follow} onOverflow={() => {}} />
            {scene.sequence && (
              <div class="player-wrap">
                <Player seq={scene.sequence} step={step} reducedMotion={false} onStep={(i) => { setStep(i); if (i !== null && scene.sequence) setVs({ ...vs, selection: { step: scene.sequence.steps[i].id, sequence: scene.sequence.id } }); }} />
              </div>
            )}
          </>
        ) : (
          <div class="sc-room-empty" role="status">
            {load.state === 'failed' ? <><b>Couldn’t draw this room’s system</b><span>{load.error}</span><button type="button" class="mini" onClick={() => setLoad({ state: 'idle' })}>Try again</button></>
              : load.state === 'loading' ? <b>{load.what}</b>
              : !ps.length && registry ? <b>Nothing in this repository’s registry to draw yet.</b> : <b>Opening…</b>}
          </div>
        )}
      </div>
      <div class="tools" role="toolbar" aria-label="System canvas tools" aria-orientation="vertical">
        <button type="button" class="on" aria-label="Select" title="Select · click a part; double-click to go in" aria-pressed="true"><ToolSelect /></button>
        <button type="button" aria-label="Pan" title="Drag the canvas to pan" disabled><ToolPan /></button>
        <span class="rule"></span>
        <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => controls.current?.zoomIn()}><ZoomIn /></button>
        <button class="zoom" type="button" aria-label="Fit" title="Fit" onClick={() => controls.current?.fit()}>Fit</button>
        <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => controls.current?.zoomOut()}><ZoomOut /></button>
      </div>
      {children}
    </section>
  );

  const panel = on && registry && scene && sel && repo ? (
    <div class="sc-root sc-panel" role="region" aria-label="About the selected part of the system">
      <div class="sc-panel-head">
        <button type="button" class="rp-link" onClick={() => setSel(null)}>‹ Back to the room</button>
        <span>System · {repo.name}</span>
      </div>
      {ctx && ctx.referents[0] ? (
        <div class="sc-pointing" role="group" aria-label="What Vowe would take “this” to mean">
          <span class="sc-pt-k">“This” means</span>
          <span class="sc-pt-chip">{ctx.referents[0].name}<em> · {ctx.referents[0].kind}</em></span>
          {ctx.alternatives.length ? (
            <span class="sc-pt-alt">Not this? {ctx.alternatives.slice(0, 2).map((a, i) => <button key={i} type="button" class="rp-link" onClick={() => setCorrected(correct(ctx, i))}>{a.name}</button>)}</span>
          ) : null}
          {onAsk ? <button type="button" class="rp-mini" onClick={() => onAsk({ ...toSnapshotSelection(ctx, registry), names: ctx.referents.map((r) => r.name), pointing: ctx })}>Ask about this</button> : null}
        </div>
      ) : null}
      <Inspector registry={registry} scene={scene} sel={sel} stale={new Set()}
        source={(f, a, b) => api.source(repo.id, f, a, b, 3)}
        onFollow={follow} onSelect={setSel} onEnter={enter} onClose={() => setSel(null)}
        onPropose={async (i) => setRegistry(await api.addInterpretation(repo.id, i))} />
    </div>
  ) : null;

  return { on, tab, pane, panel };
}
