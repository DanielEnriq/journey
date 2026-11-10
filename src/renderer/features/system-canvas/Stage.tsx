import { h } from '../../vendor/preact.js';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from '../../vendor/preact-hooks.js';
import type { Rect, SceneOverflow, SystemScene } from '../../../shared/system/render/index.js';
import { fit, lerpCamera, lodFor, matchFrame, panBy, reveal, toStage, zoomAt, type Camera, type Viewport } from './camera.js';
import { Edge, EdgeLabel, Frame, Groups, Regions, Node, Overflow, Patterns, Portal, SequenceLayer, Stub, Zones, type DrawOpts } from './draw.js';
import { spatial, tabOrder, type Dir } from './nav.js';

// The stage: one level of the scene under a camera. It owns the gestures (pan, zoom, drag to pin), the
// keyboard (Tab and arrows between parts, Enter to go in, Esc to come out) and the continuity of going in
// and out: entering first flies into the component, then the entered level opens from exactly where the
// component was on screen; coming out lands the component back where the frame was.

export type Sel =
  | { kind: 'entity'; id: string }
  | { kind: 'edge'; id: string }
  | { kind: 'step'; id: string }
  | { kind: 'stub'; id: string };

export interface StageProps {
  scene: SystemScene;
  rootName: string;
  rootKind: string;
  sel: Sel | null;
  step: number | null;
  savedCamera: Camera | null;
  expanded: Set<string>;
  reducedMotion: boolean;
  /** Bumped to ask the camera to travel to an id (following a relation, a search). */
  travel: { id: string; n: number } | null;
  onSelect(sel: Sel | null): void;
  onEnter(id: string): void;
  onExit(): void;
  onCamera(key: string, cam: Camera): void;
  onPin(id: string, at: [number, number]): void;
  onFollow(id: string): void;
  onOverflow(ov: SceneOverflow): void;
  controls?: { current: StageControls | null };
  /** Screen px at the bottom covered by an overlay (the sequence player): fitting and following keep clear of it. */
  insetBottom?: number;
}

export interface StageControls { zoomIn(): void; zoomOut(): void; fit(): void; enter(id: string): void }

const ANIM = 340;

export function Stage(p: StageProps) {
  const host = useRef<HTMLDivElement>(null);
  const [v, setV] = useState<Viewport>({ w: 1000, h: 700 });
  const [cam, setCam] = useState<Camera | null>(null);
  const camRef = useRef<Camera | null>(null);
  /** Whether the person has moved the camera on this level; until then a resize refits. */
  const touched = useRef(false);
  camRef.current = cam;
  const anim = useRef<number | null>(null);
  const prev = useRef<SystemScene | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [fade, setFade] = useState(0);
  const drag = useRef<{ kind: 'pan' | 'node'; id?: string; sx: number; sy: number; moved: boolean; start: Camera; origin?: [number, number] } | null>(null);

  useLayoutEffect(() => {
    const el = host.current!;
    const ro = new ResizeObserver(() => setV({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setV({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const stop = () => { if (anim.current) cancelAnimationFrame(anim.current); anim.current = null; };
  const animateTo = (to: Camera, done?: () => void, from?: Camera) => {
    stop();
    const a = from ?? camRef.current ?? to;
    if (p.reducedMotion) { setCam(to); done?.(); return; }
    const t0 = performance.now();
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / ANIM);
      setCam(lerpCamera(a, to, k));
      if (k < 1) anim.current = requestAnimationFrame(tick);
      else { anim.current = null; done?.(); }
    };
    anim.current = requestAnimationFrame(tick);
  };

  const s = p.scene;
  const key = s.level.key;
  // Opening a level shows what the view is about, legibly: the focus and the path, not every neighbour.
  const inset = p.insetBottom ?? 0;
  // Fit into the part of the stage nothing covers: the rect is fitted above the player and centred there.
  const fitFree = (r: Rect, max = 1.1) => {
    const f = fit(r, { w: v.w, h: Math.max(120, v.h - inset) }, 40, max);
    return { ...f, y: f.y + inset / 2 / f.z };
  };
  const home = () => {
    if (s.level.root) return fitFree(s.bounds);
    const lead = s.nodes.filter((n) => n.emphasis === 'primary' || n.why === 'focus' || n.why === 'sequence');
    if (!lead.length || lead.length === s.nodes.length) lead.splice(0, lead.length, ...s.nodes);
    const xs = lead.map((n) => n.rect);
    const r = { x: Math.min(...xs.map((q) => q.x)) - 60, y: Math.min(...xs.map((q) => q.y)) - 90, w: 0, h: 0 };
    r.w = Math.max(...xs.map((q) => q.x + q.w)) + 60 - r.x; r.h = Math.max(...xs.map((q) => q.y + q.h)) + 60 - r.y;
    const f = fitFree(r);
    // A small window can't hold the whole view legibly: start at the beginning of it, readable, and pan from there.
    if (f.z < 0.24 && s.outline[0]) {
      const first = s.nodes.find((n) => n.id === s.outline[0].id)!.rect;
      const z = 0.3;
      return { x: Math.max(r.x + v.w / 2 / z - 40 / z, first.x + first.w / 2), y: r.y + v.h / 2 / z - 40 / z, z };
    }
    return f;
  };

  // A new level: open it from where the component was (entering) or put the component back where the
  // frame was (coming out). Same level with a new scene: keep the camera.
  useLayoutEffect(() => {
    const before = prev.current;
    prev.current = s;
    if (v.w < 10) return;
    const target = p.savedCamera ?? home();
    if (!before || !camRef.current) { setCam(target); return; }
    // Another view: open it fresh (or where it was left), never on the last view's camera.
    if (before.view !== s.view) { stop(); setCam(target); return; }
    if (before.level.key === key) return;
    const now = camRef.current;
    const e0 = before.level.entered, e1 = s.level.entered;
    setFade((f) => f + 1);
    if (e1.length === e0.length + 1 && e0.every((id, i) => e1[i] === id)) {
      const was = before.nodes.find((n) => n.id === e1[e1.length - 1]);
      if (was && s.level.frame) { animateTo(target, undefined, matchFrame(now, v, was.rect, s.level.frame)); return; }
    }
    if (e0.length === e1.length + 1 && e1.every((id, i) => e0[i] === id)) {
      const back = s.nodes.find((n) => n.id === e0[e0.length - 1]);
      if (back && before.level.frame) { animateTo(target, undefined, matchFrame(now, v, before.level.frame, back.rect)); return; }
    }
    animateTo(target);
  }, [s, v.w > 10]);

  useEffect(() => { if (!touched.current && !p.savedCamera && v.w > 10) setCam(home()); }, [v.w, v.h]);
  useEffect(() => { touched.current = !!p.savedCamera; }, [s.view, key]);

  // Report the camera (debounced by the caller) so it is saved per level.
  useEffect(() => { if (cam && !anim.current) p.onCamera(key, cam); }, [cam, key]);

  // Travel: the camera goes to the other end of a followed relation, keeping zoom when it can.
  useEffect(() => {
    if (!p.travel || !camRef.current) return;
    const r = rectOf(s, p.travel.id);
    if (r) animateTo(reveal(camRef.current, v, pad(r, 60), 80));
  }, [p.travel?.n]);

  // The playing step stays in view.
  useEffect(() => {
    if (p.step === null || !s.sequence || !camRef.current) return;
    const st = s.sequence.steps[p.step];
    // Keep the station (and the words around it) clear of the player: pretend the area under it is taller.
    if (st && st.on) animateTo(reveal(camRef.current, v, { x: st.at.x - 220, y: st.at.y - 110, w: 480, h: 220 + inset / camRef.current.z }, 60));
  }, [p.step]);

  const c = cam ?? home();
  const lod = lodFor(c.z);
  const selId = p.sel ? p.sel.id : null;
  const related = useMemo(() => {
    const r = new Set<string>();
    if (!p.sel) return r;
    if (p.sel.kind === 'entity') for (const e of s.edges) if (e.from === p.sel.id || e.to === p.sel.id) { r.add(e.id); r.add(e.from); r.add(e.to); }
    if (p.sel.kind === 'edge') { const e = s.edges.find((x) => x.id === p.sel!.id); if (e) { r.add(e.from); r.add(e.to); } }
    return r;
  }, [s, p.sel]);
  // Inside a component, calls between its own parts are drawn when one end is selected or hovered; its
  // structure (writes into state, the transport, what crosses its edge) stays drawn all the time.
  const quiet = (e: SystemScene['edges'][number]) => !!s.level.root && ((!e.portal && e.kind === 'calls') || e.kind === 'depends_on' || e.kind === 'implements' || e.kind === 'verified_by')
    && !(selId && (e.from === selId || e.to === selId || e.id === selId)) && !(hover && (e.from === hover || e.to === hover || e.id === hover));
  const o: DrawOpts = { lod, lens: s.lens, z: c.z, selected: selId, related, hover, expanded: p.expanded, step: p.step };

  /* ---------- gestures ---------- */

  const enter = (id: string) => {
    const n = s.nodes.find((x) => x.id === id);
    if (!n || !n.enterable) return;
    // Fly into the component first; the entered level then opens from where it fills the screen.
    animateTo(fit(n.rect, v, 8, 6), () => p.onEnter(id));
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    stop();
    drag.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, moved: false, start: c };
  };
  const nodeDown = (id: string, e: PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    // No pointer capture yet: a click (or double-click to enter) must still reach the part.
    stop();
    const n = s.nodes.find((x) => x.id === id);
    drag.current = { kind: 'node', id, sx: e.clientX, sy: e.clientY, moved: false, start: c, origin: n ? [n.rect.x, n.rect.y] : undefined };
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    if (!d.moved) (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    d.moved = true;
    touched.current = true;
    if (d.kind === 'pan') setCam(panBy(d.start, dx, dy));
    else if (d.id && d.origin) p.onPin(d.id, [Math.round(d.origin[0] + dx / c.z), Math.round(d.origin[1] + dy / c.z)]);
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved && d.kind === 'pan') p.onSelect(null);
    if (d?.moved && camRef.current) p.onCamera(key, camRef.current);
  };
  // Pinch and ctrl/⌘-wheel zoom; a mouse wheel (line steps) zooms; a trackpad's two-finger scroll pans.
  useEffect(() => {
    const el = host.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      stop();
      touched.current = true;
      const r = el.getBoundingClientRect();
      const at = { x: e.clientX - r.left, y: e.clientY - r.top };
      const cur = camRef.current ?? home();
      if (e.ctrlKey || e.metaKey || e.deltaMode === 1) setCam(zoomAt(cur, v, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0075)), at));
      else setCam(panBy(cur, -e.deltaX, -e.deltaY));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [v]);

  /* ---------- keyboard ---------- */

  const selectId = (id: string | null) => {
    if (!id) return;
    p.onSelect({ kind: 'entity', id });
    const r = rectOf(s, id);
    if (r && camRef.current) animateTo(reveal(camRef.current, v, pad(r, 40), 60));
  };
  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input,textarea,select,button')) return;
    const cur = p.sel?.kind === 'entity' ? p.sel.id : null;
    const k = e.key;
    const zoom = (f: number) => animateTo(zoomAt(c, v, f, { x: v.w / 2, y: v.h / 2 }));
    if (k === 'Tab') { e.preventDefault(); selectId(tabOrder(s, cur, e.shiftKey)); }
    else if (k.startsWith('Arrow')) { e.preventDefault(); selectId(spatial(s, cur, k.slice(5).toLowerCase() as Dir)); }
    else if (k === 'Enter' && cur) {
      e.preventDefault();
      if (s.portals.some((x) => x.id === cur)) p.onFollow(cur); else enter(cur);
    } else if (k === 'Escape' || k === 'Backspace') {
      e.preventDefault();
      if (p.sel && k === 'Escape' && !s.level.root) p.onSelect(null); else if (s.level.root) p.onExit(); else p.onSelect(null);
    } else if (k === '+' || k === '=') { e.preventDefault(); zoom(1.25); }
    else if (k === '-' || k === '_') { e.preventDefault(); zoom(0.8); }
    else if (k === '0' || k === 'f') { e.preventDefault(); animateTo(home()); }
  };

  if (p.controls) p.controls.current = {
    zoomIn: () => animateTo(zoomAt(c, v, 1.25, { x: v.w / 2, y: v.h / 2 })),
    zoomOut: () => animateTo(zoomAt(c, v, 0.8, { x: v.w / 2, y: v.h / 2 })),
    fit: () => animateTo(home()),
    enter,
  };

  const T = `translate(${v.w / 2 - c.x * c.z} ${v.h / 2 - c.y * c.z}) scale(${c.z})`;
  const nodeOn = { select: (id: string) => p.onSelect({ kind: 'entity', id }), enter, down: nodeDown, hover: setHover };
  const pct = Math.round(c.z * 100);
  return (
    <div class={`stage lod-${lod} ${p.reducedMotion ? 'still' : ''}`} ref={host} tabIndex={0} onKeyDown={onKey}
      role="application" aria-roledescription="system canvas"
      aria-label={`${s.level.root ? `Inside ${p.rootName}` : 'System overview'}: ${s.nodes.length} parts. Tab or arrows move between them, Enter goes in, Escape comes out.`}>
      <svg width={v.w} height={v.h} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
        <Patterns />
        <rect class="grid" width={v.w} height={v.h} />
        <g transform={T} key={`lvl-${key}-${fade}`} class="level">
          <Zones zones={s.zones} flow={s.flow} z={c.z} />
          {s.level.frame && <Frame scene={s} z={c.z} name={p.rootName} kind={p.rootKind} />}
          {/* Subsystem hulls only where no runtime walls already say where things are. */}
          {s.zones.length < 2 && <Groups groups={s.groups} z={c.z} />}
          <Regions regions={s.regions} z={c.z} />
          <g class="edges">{s.edges.filter((e) => !quiet(e)).map((e) => <Edge key={e.id} e={e} o={o} onSelect={(id) => p.onSelect({ kind: 'edge', id })} onHover={setHover} />)}</g>
          <g class="stubs">{s.stubs.map((x) => <Stub key={x.id} s={x} o={o} onSelect={(id) => p.onSelect({ kind: 'stub', id })} />)}</g>
          <g class="portals">{s.portals.map((x) => <Portal key={x.id} p={x} o={o} on={{ select: (id) => p.onSelect({ kind: 'entity', id }), follow: p.onFollow }} />)}</g>
          <g class="nodes">{s.nodes.map((n) => <Node key={n.id} n={n} o={o} on={nodeOn} />)}</g>
          {s.overflow.map((ov) => <Overflow key={ov.id} ov={ov} z={c.z} onOpen={p.onOverflow} />)}
          <g class="edge-labels">{s.edges.filter((e) => !quiet(e)).map((e) => <EdgeLabel key={e.id} e={e} o={o} />)}</g>
          {s.sequence && <SequenceLayer seq={s.sequence} o={o} onSelect={(id) => p.onSelect({ kind: 'step', id })} />}
        </g>
      </svg>
      <div class="zoombar" role="group" aria-label="Zoom">
        <button type="button" onClick={() => animateTo(zoomAt(c, v, 0.8, { x: v.w / 2, y: v.h / 2 }))} aria-label="Zoom out" title="Zoom out (−)">−</button>
        <span class="zoom-pct" aria-live="off">{pct}%</span>
        <button type="button" onClick={() => animateTo(zoomAt(c, v, 1.25, { x: v.w / 2, y: v.h / 2 }))} aria-label="Zoom in" title="Zoom in (+)">+</button>
        <button type="button" onClick={() => animateTo(home())} title="Fit (0)" aria-label="Fit to screen">Fit</button>
        <span class="lod-word" title="How much each part shows at this zoom">{lod === 'far' ? 'outline' : lod === 'mid' ? 'names' : 'detail'}</span>
      </div>
    </div>
  );
}

function rectOf(s: SystemScene, id: string): Rect | null {
  const n = s.nodes.find((x) => x.id === id);
  if (n) return n.rect;
  const pt = s.portals.find((x) => x.id === id);
  if (pt) return pt.rect;
  for (const n2 of s.nodes) {
    const part = n2.parts.find((x) => x.entity === id);
    if (part) return { x: n2.rect.x + part.rect.x, y: n2.rect.y + part.rect.y, w: part.rect.w, h: part.rect.h };
  }
  const e = s.edges.find((x) => x.id === id);
  if (e) {
    const xs = e.points.map((q) => q.x), ys = e.points.map((q) => q.y);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }
  return null;
}

const pad = (r: Rect, n: number): Rect => ({ x: r.x - n, y: r.y - n, w: r.w + n * 2, h: r.h + n * 2 });

export { toStage };
