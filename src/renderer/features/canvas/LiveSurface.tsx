import { Fragment, h, type ComponentChildren } from '../../vendor/preact.js';
import { useEffect, useMemo, useRef, useState } from '../../vendor/preact-hooks.js';
import {
  Arrow, ClearInk, Cursor, Note as NoteIcon, ToolCircle, ToolComment, ToolDraw, ToolPan, ToolSelect, ZoomIn, ZoomOut,
} from '../../shared/components/icons.js';
import { initials } from '../../shared/account.js';
import { useStore } from '../../shared/store.js';
import {
  instanceKey, viewOf, viewsOf, type Actor, type Annotation, type CanvasRef, type Scene, type SceneNode,
} from '../../../shared/canvas/index.js';
import { Inside, srOnly } from '../room/canvas/Part.js';
import { inside, STAGE_H, STAGE_W, toD } from '../room/geometry.js';
import { KIND_LABEL } from '../room/model.js';
import type { PartDef, Point } from '../room/types.js';
import type { CanvasClient } from './client.js';

// A room's live canvas: the semantic document drawn with the design's own parts, wires, steps and
// controls (the same markup and classes as room/canvas/Surface.tsx), and every gesture turned into a
// Canvas Command about what it touched, never about pixels. The view is the room's (everyone moves
// together); the camera, the tool and what you have selected are yours.

type Tool = 'select' | 'pan' | 'circle' | 'draw' | 'comment';
interface Cam { x: number; y: number; z: number }

const TOOLS: { id: Tool; label: string; title: string; Icon: () => h.JSX.Element }[] = [
  { id: 'select', label: 'Select', title: 'Select · V', Icon: ToolSelect },
  { id: 'pan', label: 'Pan', title: 'Pan · H', Icon: ToolPan },
  { id: 'circle', label: 'Circle a region', title: 'Circle · O', Icon: ToolCircle },
  { id: 'draw', label: 'Draw', title: 'Draw · P', Icon: ToolDraw },
  { id: 'comment', label: 'Comment', title: 'Comment · C', Icon: ToolComment },
];
const KEYS: Record<string, Tool> = { v: 'select', h: 'pan', o: 'circle', p: 'draw', c: 'comment' };
const STEP_W = 220, STEP_H = 48;
const IGNORE = 'button, input, label, a, .ctx, .lasso-ask, .receipt, .npop, .call, .captions, .pin, .surface-head';

type Drag =
  | { mode: 'pan'; sx: number; sy: number; cam: Cam; s: number }
  | { mode: 'circle' | 'draw'; pts: Point[] }
  | { mode: 'marquee'; a: Point; b: Point; moved: boolean };

/** One thing a gesture can land on: a part (which copy of which component) or a flow step. */
interface Target { key: string; ref: CanvasRef; short: string; x: number; y: number; w: number; h: number }

export const refKey = (r: CanvasRef) => 'step' in r ? `step:${r.view}:${r.step}` : instanceKey(r.component, r.instance);
const nodeRef = (n: SceneNode): CanvasRef => n.instance > 1 ? { component: n.component, instance: n.instance } : { component: n.component };

function targetsOf(scene: Scene | undefined): Target[] {
  if (!scene) return [];
  return [
    ...scene.nodes.map((n) => ({ key: n.key, ref: nodeRef(n), short: n.short, x: n.rect[0], y: n.rect[1], w: n.rect[2], h: n.rect[3] })),
    ...scene.steps.map((s) => ({ key: `step:${scene.view}:${s.id}`, ref: { step: s.id, view: scene.view, component: s.component }, short: s.short, x: s.x, y: s.y, w: STEP_W, h: STEP_H })),
  ];
}

/** What a circle drawn through `pts` is around: every part or step whose centre it encloses. */
export function circled(scene: Scene | undefined, pts: Point[]): { ref: CanvasRef; short: string }[] {
  return targetsOf(scene).filter((t) => inside([t.x + t.w / 2, t.y + t.h / 2], pts)).map(({ ref, short }) => ({ ref, short }));
}

const avatar = (by: Actor, me: Actor) => by.kind === 'agent' ? 'mav vowe' : by.id === me.id ? 'mav' : 'mav peer';

export interface LiveSurfaceProps {
  client: CanvasClient;
  /** The comment tool: where you clicked, in the surface's own pixels. Absent: no comment tool. */
  onComment?(x: number, y: number): void;
  /** Drawn inside the surface, over the canvas: pins, the empty state, captions, the call bar. */
  children?: ComponentChildren;
}

export function LiveSurface({ client, onComment, children }: LiveSurfaceProps) {
  const s = useStore(client.store);
  const me = client.transport.me();
  const doc = s.doc, view = s.scenes[doc.activeView] ? doc.activeView : 'architecture';
  const scene = s.scenes[view] as Scene | undefined;
  const spec = viewOf(doc, view);

  const [tool, setTool] = useState<Tool>('select');
  const [cams, setCams] = useState<Record<string, Cam>>({});
  const [sel, setSel] = useState<CanvasRef[]>([]);
  const [lasso, setLasso] = useState<Point[]>([]);
  const [stroke, setStroke] = useState<Point[]>([]);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [ask, setAsk] = useState<{ id: string; names: string[]; x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [recipeOpen, setRecipeOpen] = useState(false);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const sec = useRef<HTMLElement>(null);
  const drag = useRef<Drag | null>(null);
  const raf = useRef(0);
  const offset = useRef({ ox: 0, oy: 0 });
  const cursor = useRef<{ x: number; y: number } | null>(null);
  // What the next presence update says; refs, because a pointer move can land before a re-render.
  const now = useRef<{ sel: CanvasRef[]; tool: Tool }>({ sel, tool });

  const cam = cams[view] ?? { x: 0, y: 0, z: 1 };
  const setCam = (c: Cam) => setCams((all) => ({ ...all, [view]: c }));
  const zoomBy = (f: number) => { const z2 = Math.max(0.35, Math.min(2.5, cam.z * f)), k = z2 / cam.z; setCam({ x: cam.x * k, y: cam.y * k, z: z2 }); };
  const run: CanvasClient['run'] = (name, args) => client.run(name, args);
  const show = (id: string) => { if (id !== view) void run('show_view', { view: id }); };

  // Your view, pen and selection go to the call, and to Vowe as what "this" means.
  const share = (c = cursor.current) => {
    const { sel: selection, tool: t } = now.current;
    client.share({ view, cursor: c ? { x: Math.round(c.x), y: Math.round(c.y) } : null, selection, tool: t === 'pan' ? 'select' : t });
  };
  const pickTool = (t: Tool) => { now.current.tool = t; setTool(t); share(); };
  useEffect(() => { now.current.sel = []; setSel([]); setAsk(null); share(); }, [view]);

  useEffect(() => {
    const el = sec.current!;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* Fit the drawing to the free space, as the design does: tool rail left, the call below. */
  const right = 16, bottom = 84, top = 52;
  const vb = scene?.viewBox ?? [STAGE_W, STAGE_H];
  const fit = size.w ? Math.max(0.5, Math.min(1.1, (size.w - 64 - right - 24) / (vb[0] + 20), (size.h - top - bottom - 16) / (vb[1] + 10))) : 1;
  const z = cam.z * fit;
  const ox = (size.w ? (64 - right) / 2 : 0) + (STAGE_W - vb[0]) / 2 * z, oy = (size.w ? (top - bottom) / 2 : 0) + (STAGE_H - vb[1]) / 2 * z;
  offset.current = { ox, oy };

  // Wheel needs a non-passive listener so ⌘-scroll zooms the canvas instead of the page.
  const camRef = useRef(cam);
  camRef.current = cam;
  const setCamRef = useRef(setCam);
  setCamRef.current = setCam;
  useEffect(() => {
    const el = sec.current!;
    const onWheel = (e: WheelEvent) => {
      const r = el.getBoundingClientRect(), k = (r.width / el.offsetWidth) || 1, c = camRef.current, { ox: x0, oy: y0 } = offset.current;
      const W = el.offsetWidth, H = el.offsetHeight;
      if (e.ctrlKey || e.metaKey) {
        const mx = (e.clientX - r.left) / k, my = (e.clientY - r.top) / k;
        const z2 = Math.max(0.35, Math.min(2.5, c.z * Math.exp(-e.deltaY * 0.01))), ratio = z2 / c.z;
        setCamRef.current({ x: mx - W / 2 - (mx - W / 2 - (c.x + x0)) * ratio - x0, y: my - H / 2 - (my - H / 2 - (c.y + y0)) * ratio - y0, z: z2 });
      } else setCamRef.current({ x: c.x - e.deltaX / k, y: c.y - e.deltaY / k, z: c.z });
      if (e.cancelable) e.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  /* Every part any view draws, so moving between views animates instead of redrawing. */
  const home = useMemo(() => {
    const at = new Map<string, SceneNode>();
    Object.values(s.scenes).forEach((sc) => sc.nodes.forEach((n) => { if (!at.has(n.key)) at.set(n.key, n); }));
    return at;
  }, [s.scenes]);
  const here = new Map((scene?.nodes ?? []).map((n) => [n.key, n]));
  const targets = targetsOf(scene);
  const selKeys = new Set(sel.map(refKey));
  const single = sel.length === 1 ? refKey(sel[0]) : null;
  const glance = single && scene?.neighbours[single] ? [single, ...scene.neighbours[single]] : null;
  const lit = new Set(doc.highlight?.components ?? []);
  const peers = Object.values(s.peers).filter((p) => p.presence.view === view);
  const peerOn = (key: string) => peers.find((p) => p.presence.selection.some((r) => refKey(r) === key));
  const notes = Object.values(doc.annotations).filter((a): a is Extract<Annotation, { kind: 'note' }> => a.kind === 'note');
  const marks = Object.values(doc.annotations).filter((a): a is Exclude<Annotation, { kind: 'note' }> => a.kind !== 'note' && a.view === view);
  const mine = marks.filter((a) => a.by.id === me.id);

  const toStage = (e: PointerEvent): Point => {
    const r = sec.current!.querySelector('.stage')!.getBoundingClientRect(), k = r.width / STAGE_W;
    return [(e.clientX - r.left) / k, (e.clientY - r.top) / k];
  };
  const frame = (fn: () => void) => { cancelAnimationFrame(raf.current); raf.current = requestAnimationFrame(fn); };
  const select = (next: CanvasRef[]) => { now.current.sel = next; setSel(next); setAsk(null); share(); };

  /* ---------- Gestures: each ends as a command about what it touched. ---------- */
  const down = (e: PointerEvent) => {
    if (e.button !== 0 || (e.target as Element).closest?.(IGNORE)) return;
    const el = sec.current!, p = toStage(e);
    if (tool === 'comment') { if (onComment) { const r = el.getBoundingClientRect(); onComment(e.clientX - r.left, e.clientY - r.top); } return; }
    try { el.setPointerCapture(e.pointerId); } catch { /* the pointer may already be gone */ }
    if (tool === 'pan') { drag.current = { mode: 'pan', sx: e.clientX, sy: e.clientY, cam, s: (el.getBoundingClientRect().width / el.offsetWidth) || 1 }; setDragging(true); }
    else if (tool === 'circle') { drag.current = { mode: 'circle', pts: [p] }; setLasso([p]); setAsk(null); }
    else if (tool === 'draw') { drag.current = { mode: 'draw', pts: [p] }; setStroke([p]); }
    else drag.current = { mode: 'marquee', a: p, b: p, moved: false };
  };

  const move = (e: PointerEvent) => {
    const p = toStage(e);
    cursor.current = { x: p[0], y: p[1] };
    share();
    const d = drag.current;
    if (!d) return;
    if (d.mode === 'pan') {
      const dx = (e.clientX - d.sx) / d.s, dy = (e.clientY - d.sy) / d.s;
      frame(() => setCam({ x: d.cam.x + dx, y: d.cam.y + dy, z: d.cam.z }));
    } else if (d.mode === 'marquee') {
      d.b = p;
      if (Math.abs(p[0] - d.a[0]) + Math.abs(p[1] - d.a[1]) > 5) d.moved = true;
      if (d.moved) frame(() => setMarquee({ x: Math.min(d.a[0], d.b[0]), y: Math.min(d.a[1], d.b[1]), w: Math.abs(d.b[0] - d.a[0]), h: Math.abs(d.b[1] - d.a[1]) }));
    } else {
      const last = d.pts[d.pts.length - 1];
      if (Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1]) < 3) return;
      d.pts.push(p);
      frame(() => (d.mode === 'circle' ? setLasso : setStroke)(d.pts.slice()));
    }
  };

  const up = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    cancelAnimationFrame(raf.current);
    if (d.mode === 'pan') { setDragging(false); return; }
    if (d.mode === 'draw') {
      setStroke([]);
      if (d.pts.length > 2) void run('draw', { view, kind: 'ink', d: toD(d.pts, false) });
      return;
    }
    if (d.mode !== 'marquee') {
      setLasso([]);
      if (d.pts.length < 6) return;
      const hits = circled(scene, d.pts);
      const xs = d.pts.map((q) => q[0]), ys = d.pts.map((q) => q[1]);
      const at = { x: Math.max(...xs) + 12, y: Math.min(...ys) };
      void run('draw', { view, kind: 'circle', d: toD(d.pts, true), refs: hits.map((t) => t.ref) }).then((r) => {
        if (r.ok) setAsk({ id: r.changed.annotations[0], names: hits.map((t) => t.short), ...at });
      });
      return;
    }
    setMarquee(null);
    if (!d.moved) { select([]); return; }
    const m = { x0: Math.min(d.a[0], d.b[0]), y0: Math.min(d.a[1], d.b[1]), x1: Math.max(d.a[0], d.b[0]), y1: Math.max(d.a[1], d.b[1]) };
    select(targets.filter((t) => !t.key.startsWith('step:') && t.x < m.x1 && t.x + t.w > m.x0 && t.y < m.y1 && t.y + t.h > m.y0).map((t) => t.ref));
  };

  const pick = (ref: CanvasRef, e: MouseEvent) => {
    const k = refKey(ref);
    if (e.shiftKey) select(selKeys.has(k) ? sel.filter((r) => refKey(r) !== k) : sel.concat([ref]));
    else select(single === k ? [] : [ref]);
  };

  /* ---------- Keys: tools, views, zoom, undo. ---------- */
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); void run('undo', {}); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    if (KEYS[k] && (KEYS[k] !== 'comment' || onComment)) { pickTool(KEYS[k]); e.preventDefault(); return; }
    const n = parseInt(k, 10), order = tabs.map((x) => x.id);
    if (n >= 1 && n <= order.length) { show(order[n - 1]); e.preventDefault(); return; }
    if (k === '+' || k === '=') { zoomBy(1.25); e.preventDefault(); return; }
    if (k === '-') { zoomBy(0.8); e.preventDefault(); return; }
    if (k === '0') { setCam({ x: 0, y: 0, z: 1 }); e.preventDefault(); return; }
    if (k === 'Escape') { select([]); setMarquee(null); }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyRef.current(e);
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  /* ---------- What the room shows. ---------- */
  const tabs = viewsOf(doc).filter((v) => s.scenes[v.id]).map((v) => ({
    id: v.id, name: v.name, title: v.question, on: v.id === view, cls: (v.id === view ? 'on' : '') + (v.status === 'proposed' ? ' proposed' : ''),
  }));
  const recipeRows = scene ? [{ k: 'Asked', v: scene.question }, { k: 'Arranged as', v: scene.recipe.arrangement }]
    .concat(scene.recipe.blocks.map((b, i) => ({ k: i === 0 ? 'Blocks' : '', v: b })), [{ k: 'Data', v: scene.provenance }]) : [];
  const proposal = Object.values(doc.proposals).find((p) => p.status === 'open');
  const receipt = spec && spec.status === 'proposed' && spec.by.kind === 'agent'
    ? { text: <>Vowe drew <b>{spec.name}</b> from {spec.parent ? viewOf(doc, spec.parent)?.name ?? 'the room’s system' : 'the room’s system'}</>, undo: 'Undo', keep: 'Keep view',
      onUndo: () => run('remove_view', { view: spec.id }), onKeep: () => run('keep_view', { view: spec.id }) }
    : proposal ? { text: <>{proposal.by.name} proposed <b>{proposal.title}</b></>, undo: 'Reject', keep: 'Accept',
      onUndo: () => run('reject_proposal', { proposal: proposal.id }), onKeep: () => run('accept_proposal', { proposal: proposal.id }) }
    : null;

  const nodes = [...home.values()].map((h0) => {
    const n = here.get(h0.key), shown = !!n, part = n ?? h0;
    // A copy no view is showing waits under its component, so it splits out of it when a view needs it.
    const rect = n?.rect ?? (h0.instance > 1 ? here.get(h0.component)?.rect : undefined) ?? h0.rect;
    const peer = shown ? peerOn(h0.key) : undefined, sel1 = shown && selKeys.has(h0.key);
    const on = notes.filter((a) => a.on === h0.component && h0.instance === 1);
    const popOpen = shown && single === h0.key && on.length > 0;
    const flip = rect[0] + rect[2] + 270 > STAGE_W;
    return {
      key: h0.key, ref: nodeRef(part), part, shown, rect, sel: sel1, peer, notes: shown ? on : [], popOpen, flip,
      wrapCls: 'node' + (shown ? '' : ' gone') + (glance && !glance.includes(h0.key) ? ' far' : '') + (popOpen ? ' raised' : ''),
      cls: 'part kind-' + part.kind + (part.proposed ? ' proposed' : '') + (sel1 ? ' sel' : '') + (peer ? ' peer' : '') + (shown && lit.has(part.component) ? ' agent' : ''),
    };
  });
  const allSteps = Object.values(s.scenes).flatMap((sc) => sc.steps.map((st, i) => {
    const on = sc.view === view, key = `step:${sc.view}:${st.id}`;
    return { ...st, key, on, delay: on ? 180 + (i + 1) * 70 : 0, cls: 'step' + (st.tone ? ' ' + st.tone : '') + (on && (selKeys.has(key) || peerOn(key)) ? ' focus' : '') + (on ? '' : ' gone') };
  }));
  const allWires = Object.values(s.scenes).flatMap((sc) => sc.wires.map((w, i) => ({ ...w, key: `${sc.view}:${i}`, on: sc.view === view })));
  const allLabels = Object.values(s.scenes).flatMap((sc) => sc.labels.map((l, i) => ({ ...l, key: `${sc.view}:${i}`, on: sc.view === view })));
  const allBounds = Object.values(s.scenes).flatMap((sc) => sc.bounds.map((b, i) => ({ ...b, key: `${sc.view}:${i}`, on: sc.view === view })));

  const selBox = nodes.filter((n) => n.sel).reduce<{ x: number; y: number } | null>((b, n) => b ? { x: Math.min(b.x, n.rect[0]), y: Math.min(b.y, n.rect[1]) } : { x: n.rect[0], y: n.rect[1] }, null);
  const ctx = selBox && !ask ? selBox : null;
  const selNames = sel.flatMap((r) => 'step' in r ? [] : [doc.components[r.component]?.name ?? r.component]);

  /* Someone you can't see: their cursor waits on the edge, pointing at them. */
  const edges = !size.w ? [] : peers.flatMap((pr) => {
    const at = pr.presence.cursor;
    if (!at) return [];
    const W = size.w, H = size.h, cxT = cam.x + ox, cyT = cam.y + oy;
    const px = W / 2 + cxT + (at.x - STAGE_W / 2) * z, py = H / 2 + cyT + (at.y - STAGE_H / 2) * z;
    const L0 = 64, R0 = W - 16, T0 = 48, B0 = H - 84;
    if (px >= L0 && px <= R0 && py >= T0 && py <= B0) return [];
    const ex = Math.max(L0 + 6, Math.min(R0 - 74, px)), ey = Math.max(T0 + 6, Math.min(B0 - 30, py));
    return [{
      id: pr.id, name: pr.name, cls: 'edge' + (pr.tone === 'p2' ? ' p2' : ''), x: Math.round(ex), y: Math.round(ey),
      a: Math.round(Math.atan2(py - (ey + 12), px - (ex + 40)) * 180 / Math.PI),
      go: () => setCam({ x: -ox - (at.x - STAGE_W / 2) * z, y: -oy - (at.y - STAGE_H / 2) * z, z: cam.z }),
    }];
  });

  return (
    <section ref={sec} class={'surface tool-' + tool + (dragging ? ' dragging' : '')} tabIndex={0}
      aria-label={`Shared canvas · V select, H pan, O circle, P draw${onComment ? ', C comment' : ''}, 1–${Math.max(1, tabs.length)} views, ⌘Z undo, + − 0 zoom`}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
      onPointerLeave={() => { cursor.current = null; share(null); }}>
      <div class="world" style={`transform: translate(${cam.x + ox}px, ${cam.y + oy}px) scale(${z})`}>
        <div class={'stage' + (z < 0.8 ? ' compact' : '')}>
          {allBounds.map((b) => <div key={b.key} class={'bound' + (b.on ? '' : ' gone')} style={`transform: translate(${b.x}px, ${b.y}px); width: ${b.w}px; height: ${b.h}px`}><span>{b.label}</span></div>)}
          {allWires.map((w) => <div key={w.key} class={'wire ' + w.c + (w.on ? '' : ' gone') + (w.on && glance ? ' faint' : '')} style={`transform: translate(${w.x}px, ${w.y}px); width: ${w.w}px; height: ${w.h}px; transition-delay: ${w.on ? w.d ?? 0 : 0}ms`}></div>)}
          {allLabels.map((l) => <span key={l.key} class={'wlabel' + (l.on ? '' : ' gone')} style={`transform: translate(${l.x}px, ${l.y}px)`}>{l.t}</span>)}
          {allSteps.map((st) => (
            <div key={st.key} class={st.cls} style={`transform: translate(${st.x}px, ${st.y}px); transition-delay: ${st.delay}ms`}
              onClick={st.on ? (e: MouseEvent) => pick({ step: st.id, view, component: st.component }, e) : undefined}>
              <span class="n">{st.n}</span>
              <span class="t"><b>{st.title}</b><span>{st.sub}</span></span>
            </div>
          ))}

          {nodes.map((n) => (
            <div key={n.key} class={n.wrapCls} style={`transform: translate(${n.rect[0]}px, ${n.rect[1]}px); width: ${n.rect[2]}px; transition-delay: ${n.shown ? n.part.delay : 0}ms`}>
              <button class={n.cls} type="button" aria-pressed={n.sel} style={`height: ${n.rect[3]}px`} onClick={(e) => pick(n.ref, e)}>
                <span class="face"><span class="pname">{n.part.name}</span><span class="ptech">{n.part.tech}</span></span>
                <Inside n={{ part: { smart: n.part.smart } as PartDef, ...n.part.state }} />
              </button>
              {n.peer && !n.sel && <span class="tab peer">{n.peer.name}</span>}
              {n.peer && n.sel && sel.length === 1 && <span class="tab me">You</span>}
              {n.notes.length > 0 && (
                <button class="notes-chip" type="button" aria-label={`${n.notes.length} notes on ${n.part.name}`} onClick={() => select([n.ref])}>
                  <NoteIcon />{n.notes.length}
                </button>
              )}
              {n.popOpen && (
                <div class={'npop' + (n.flip ? ' flip' : '')} role="region" aria-label={`Notes on ${n.part.name}`}>
                  {n.notes.map((nt) => (
                    <div key={nt.id} class={'note' + (nt.status === 'suggested' ? ' suggested' : '')}>
                      <span class="nt">{nt.status === 'suggested' ? 'Suggested ' + KIND_LABEL[nt.note].toLowerCase() : KIND_LABEL[nt.note]}</span>
                      <p>{nt.text}</p>
                      <span class="by"><span class={avatar(nt.by, me)}>{nt.by.kind === 'agent' ? '' : initials(nt.by.name)}</span>{nt.status === 'suggested' ? `${nt.by.name} suggests` : nt.by.id === me.id ? 'You' : nt.by.name}</span>
                      {nt.status === 'suggested' && (
                        <span class="acts">
                          <button class="mini" type="button" onClick={() => run('keep_note', { annotation: nt.id })}>Keep</button>
                          <button class="mini ghost" type="button" onClick={() => run('remove_annotation', { annotation: nt.id })}>Dismiss</button>
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}

          <svg class="ink" viewBox={`0 0 ${STAGE_W} 620`} aria-hidden="true">
            {marks.map((a) => <path key={a.id} class={a.kind === 'ink' ? 'stroke' : 'lasso' + (a.by.kind === 'agent' ? ' read' : '')} d={a.d}></path>)}
            <path class="stroke" d={toD(stroke, false)}></path>
            <path class="lasso live" d={toD(lasso, false)}></path>
          </svg>
          {marquee && <div class="marquee" style={`transform: translate(${marquee.x}px, ${marquee.y}px); width: ${marquee.w}px; height: ${marquee.h}px`}></div>}
          {ask && (
            <div class="lasso-ask" style={`transform: translate(${Math.min(ask.x, STAGE_W - 240)}px, ${Math.max(ask.y, -30)}px)`}>
              <span class="lbl">{ask.names.length ? 'You circled' : 'You circled empty space'}</span>
              <div class="items">{ask.names.map((nm, i) => <span key={i} class="tag">{nm}</span>)}</div>
              <div class="row2">
                <button class="mini" type="button" onClick={() => setAsk(null)}>Done</button>
                <button class="mini ghost" type="button" onClick={() => { void run('remove_annotation', { annotation: ask.id }); setAsk(null); }}>Remove</button>
              </div>
            </div>
          )}
          {ctx && (
            <div class="ctx" style={`transform: translate(${ctx.x}px, ${ctx.y - 42}px)`}>
              {sel.length > 1 && <><span class="n">{sel.length} selected</span><span class="sep"></span></>}
              {selNames.length > 0 && <button type="button" onClick={() => run('highlight_component', { components: [...new Set(sel.flatMap((r) => 'step' in r ? [] : [r.component]))] })}>Point everyone here</button>}
              <span class="sep"></span>
              <button type="button" onClick={() => select([])}>Done</button>
            </div>
          )}
          {peers.map((pr) => pr.presence.cursor && (
            <div key={pr.id} class={'cursor live' + (pr.tone === 'p2' ? ' p2' : '')} style={`transform: translate(${pr.presence.cursor.x}px, ${pr.presence.cursor.y}px)`} aria-hidden="true">
              <Cursor color={pr.tone === 'p2' ? 'var(--peer2)' : 'var(--peer)'} />
              <span class="label">{pr.name}</span>
            </div>
          ))}
        </div>
      </div>

      {scene && (
        <div class="surface-head">
          <div class="seg" role="group" aria-label="Views">
            {tabs.map((t) => <button key={t.id} class={t.cls} type="button" title={t.title} aria-pressed={t.on} onClick={() => show(t.id)}>{t.name}</button>)}
          </div>
          <span class="prov">{scene.provenance}</span>
          <div class="recipe-wrap">
            <button class="recipe-btn" type="button" aria-expanded={recipeOpen} onClick={() => setRecipeOpen(!recipeOpen)}><span class="orb"></span>How Vowe drew this</button>
            {recipeOpen && (
              <div class="recipe" role="region" aria-label="How Vowe drew this view">
                {recipeRows.map((r, i) => <div key={i} class="rrow2"><span class="rk2">{r.k}</span><span>{r.v}</span></div>)}
              </div>
            )}
          </div>
        </div>
      )}

      {receipt && (
        <div class="receipt" role="status">
          <span class="orb small"></span>
          <span>{receipt.text}</span>
          <button class="mini ghost" type="button" onClick={() => { void receipt.onUndo(); }}>{receipt.undo}</button>
          <button class="mini" type="button" onClick={() => { void receipt.onKeep(); }}>{receipt.keep}</button>
        </div>
      )}
      {s.error && !receipt && (
        <div class="receipt dropped" role="alert">
          <span class="dot needs"></span><span>Not saved: {s.error}</span>
          <button class="mini ghost" type="button" onClick={() => client.dismissError()}>Dismiss</button>
        </div>
      )}

      {edges.map((ec) => (
        <button key={ec.id} class={ec.cls} type="button" title={`Go to ${ec.name}`} style={`transform: translate(${ec.x}px, ${ec.y}px)`} onClick={ec.go}><Arrow angle={ec.a} />{ec.name}</button>
      ))}

      <div class="tools" role="toolbar" aria-label="Canvas tools" aria-orientation="vertical">
        {TOOLS.filter((t) => t.id !== 'comment' || onComment).map(({ id, label, title, Icon }) => (
          <button key={id} class={tool === id ? 'on' : ''} type="button" aria-label={label} title={title} aria-pressed={tool === id}
            onClick={() => pickTool(id)}><Icon /></button>
        ))}
        {mine.length > 0 && (
          <button type="button" aria-label="Clear your ink in this view" title="Clear your ink" onClick={() => mine.forEach((a) => { void run('remove_annotation', { annotation: a.id }); })}><ClearInk /></button>
        )}
        <span class="rule"></span>
        <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => zoomBy(1.25)}><ZoomIn /></button>
        <button class="zoom" type="button" aria-label="Fit the view" title="Fit" onClick={() => setCam({ x: 0, y: 0, z: 1 })}>{Math.round(z * 100) + '%'}</button>
        <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => zoomBy(0.8)}><ZoomOut /></button>
      </div>
      <span style={srOnly} aria-live="polite">{s.pending ? 'Saving…' : ''}</span>

      {children}
    </section>
  );
}
