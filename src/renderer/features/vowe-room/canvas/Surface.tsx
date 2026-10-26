
import {
  h, Fragment, useEffect, useMemo, useRef, useState, useStore, canvas,
  Arrow, ClearInk, Cursor, NoteIcon, ToolCircle, ToolComment, ToolDraw, ToolPan, ToolSelect, ZoomIn, ZoomOut,
  inside, STAGE_H, STAGE_W, toD,
  type CanvasClient, type CanvasRef, type ComponentChildren, type Scene, type SceneNode,
} from '../journey.js';
import type { Scenario } from '../contracts/semantics.js';
import { useSemantics } from '../state/semantics.js';
import type { Ui, Tool } from '../state/ui.js';
import { BasisGlyph, Body, caption, glyphFor, type Moment } from './faces.js';
import { useNames } from '../state/directory.js';

// The room's canvas, as Journey's LiveSurface has it (same camera, tools, gestures, presence and
// Canvas Commands: this file began as a copy of it) with the next renderer drawn on top: faces that
// show what each part is, guarantees on the wires, failure and concurrency as instruments on the parts
// themselves, and anatomy that opens in place. Nothing here replaces a gesture; it adds to them.

type Point = [number, number];
interface Cam { x: number; y: number; z: number }
const TOOLS: { id: Tool; label: string; title: string; Icon: () => h.JSX.Element }[] = [
  { id: 'select', label: 'Select', title: 'Select · V', Icon: ToolSelect },
  { id: 'pan', label: 'Pan', title: 'Pan · H', Icon: ToolPan },
  { id: 'circle', label: 'Circle a region', title: 'Circle · O', Icon: ToolCircle },
  { id: 'draw', label: 'Draw', title: 'Draw · P', Icon: ToolDraw },
  { id: 'erase', label: 'Eraser', title: 'Eraser · E · erases only the strokes you drag across', Icon: ClearInk },
  { id: 'comment', label: 'Comment', title: 'Comment · C', Icon: ToolComment },
];
const KEYS: Record<string, Tool> = { v: 'select', h: 'pan', o: 'circle', p: 'draw', e: 'erase', c: 'comment' };

/** The points a pen path passes through (M/L, as toD writes them). */
const pathPts = (d: string): Point[] => (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number).reduce<Point[]>((a, v, i, all) => (i % 2 ? a : a.concat([[v, all[i + 1]] as Point])), []);
function nearPath(pts: Point[], p: Point, r: number): boolean {
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[i + 1] ?? a;
    const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
    if (Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)) <= r) return true;
  }
  return false;
}
const ERASE_R = 10;
const STEP_W = 220, STEP_H = 48;
const IGNORE = 'button, input, label, a, .ctx, .lasso-ask, .receipt, .npop, .call, .captions, .pin, .surface-head, .nx-anat, .nx-whatif, .nx-dial, .nx-copies';

type Drag = { mode: 'pan'; sx: number; sy: number; cam: Cam; s: number } | { mode: 'circle' | 'draw'; pts: Point[] } | { mode: 'erase'; last: Point } | { mode: 'marquee'; a: Point; b: Point; moved: boolean };
interface Target { key: string; ref: CanvasRef; short: string; x: number; y: number; w: number; h: number }

export const refKey = (r: CanvasRef) => 'step' in r ? `step:${r.view}:${r.step}` : canvas.instanceKey(r.component, r.instance);
const nodeRef = (n: SceneNode): CanvasRef => n.instance > 1 ? { component: n.component, instance: n.instance } : { component: n.component };
function targetsOf(scene: Scene | undefined): Target[] {
  if (!scene) return [];
  return [
    ...scene.nodes.map((n) => ({ key: n.key, ref: nodeRef(n), short: n.short, x: n.rect[0], y: n.rect[1], w: n.rect[2], h: n.rect[3] })),
    ...scene.steps.map((s) => ({ key: `step:${scene.view}:${s.id}`, ref: { step: s.id, view: scene.view, component: s.component }, short: s.short, x: s.x, y: s.y, w: STEP_W, h: STEP_H })),
  ];
}
export function circled(scene: Scene | undefined, pts: Point[]) {
  return targetsOf(scene).filter((t) => inside([t.x + t.w / 2, t.y + t.h / 2], pts)).map(({ ref, short }) => ({ ref, short }));
}

/** What hangs on a part from the room's record: its threads, the agents on it, its PRs, what changed. */
export interface PartMarks {
  threads: number;
  needs?: boolean;
  agent?: { text: string; needs?: boolean };
  prs?: { id: string; state: string }[];
  since?: string;
  governed?: string;
  /** The PR you're looking at changes this part: how. */
  diff?: { pr: string; text: string; files: string };
}

export interface SurfaceProps {
  client: CanvasClient;
  ui: Ui;
  marks: Record<string, PartMarks>;
  /** Components the Desk is pointing at (the option or PR you're looking at). */
  lit?: string[];
  onAsk?(about: { components: string[]; names: string[] }): void;
  onScenario?(component: string, s: Scenario): void;
  onCopies?(n: number): void;
  onComment?(x: number, y: number, on: { component: string; name: string } | null): void;
  onMarks?(component: string): void;
  anchored?(place: (x: number, y: number) => { x: number; y: number }): ComponentChildren;
  /** Room under the canvas kept clear for captions. */
  reserve?: number;
  /** A call is on: the view can follow the call or be just yours. */
  inCall?: boolean;
  children?: ComponentChildren;
}

export function Surface({ client, ui, marks, lit = [], onAsk, onScenario, onCopies, onComment, onMarks, anchored, reserve = 0, inCall = false, children }: SurfaceProps) {
  const { agentName } = useNames();
  const sem = useSemantics();
  const s = useStore(client.store);
  const u = useStore(ui);
  const me = client.transport.me();
  const doc = s.doc;
  // Lenses: in a call, switching views moves everyone (Journey's shared activeView). "Just me" keeps a
  // personal lens: your view changes, nobody else's does, and nothing is saved.
  const personal = u.lens === 'mine' || !inCall;
  const shared = s.scenes[doc.activeView] ? doc.activeView : 'architecture';
  const view = personal && u.myView && s.scenes[u.myView] ? u.myView : shared;
  const scene = s.scenes[view] as Scene | undefined;
  const spec = canvas.viewOf(doc, view);
  const tool = u.tool, sel = u.sel;

  const [cams, setCams] = useState<Record<string, Cam>>({});
  const [lasso, setLasso] = useState<Point[]>([]);
  const [stroke, setStroke] = useState<Point[]>([]);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const sec = useRef<HTMLElement>(null);
  const drag = useRef<Drag | null>(null);
  const raf = useRef(0);
  const offset = useRef({ ox: 0, oy: 0 });
  const cursor = useRef<{ x: number; y: number } | null>(null);
  const now = useRef<{ sel: CanvasRef[]; tool: Tool }>({ sel, tool });
  now.current = { sel, tool };

  const cam = cams[view] ?? { x: 0, y: 0, z: 1 };
  const setCam = (c: Cam) => setCams((all) => ({ ...all, [view]: c }));
  const zoomBy = (f: number) => { const z2 = Math.max(0.35, Math.min(2.5, cam.z * f)), k = z2 / cam.z; setCam({ x: cam.x * k, y: cam.y * k, z: z2 }); };
  const run: CanvasClient['run'] = (name, args) => client.run(name, args);
  const show = (id: string) => { if (id === view) return; if (personal && inCall) ui.setState({ myView: id }); else { if (!inCall) ui.setState({ myView: null }); void run('show_view', { view: id }); } };
  const share = (c = cursor.current) => {
    const { sel: selection, tool: t } = now.current;
    client.share({ view, cursor: c ? { x: Math.round(c.x), y: Math.round(c.y) } : null, selection, tool: t === 'pan' ? 'select' : t === 'erase' ? 'draw' : t });
  };
  const pickTool = (t: Tool) => { ui.setState({ tool: t }); share(); };
  const select = (next: CanvasRef[]) => { ui.setState({ sel: next, ask: null, whatIf: null, open: u.open && next.some((r) => !('step' in r) && r.component === u.open) ? u.open : null }); share(); };
  useEffect(() => { ui.setState({ sel: [], ask: null, whatIf: null, open: null }); }, [view]);

  useEffect(() => {
    const el = sec.current!;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const right = 16, bottom = 84 + reserve, top = 52;
  const vb = scene?.viewBox ?? [STAGE_W, STAGE_H];
  const fit = size.w ? Math.max(0.5, Math.min(1.1, (size.w - 64 - right - 24) / (vb[0] + 20), (size.h - top - bottom - 16) / (vb[1] + 10))) : 1;
  const z = cam.z * fit;
  const ox = (size.w ? (64 - right) / 2 : 0) + (STAGE_W - vb[0]) / 2 * z, oy = (size.w ? (top - bottom) / 2 : 0) + (STAGE_H - vb[1]) / 2 * z;
  offset.current = { ox, oy };

  const camRef = useRef(cam); camRef.current = cam;
  const setCamRef = useRef(setCam); setCamRef.current = setCam;
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
  const vlit = new Set(doc.highlight?.components ?? []);
  const dlit = new Set(lit);
  const peers = Object.values(s.peers).filter((p) => p.presence.view === view);
  const peerOn = (key: string) => peers.find((p) => p.presence.selection.some((r) => refKey(r) === key));
  const notes = Object.values(doc.annotations).filter((a): a is Extract<canvas.Annotation, { kind: 'note' }> => a.kind === 'note');
  const pen = Object.values(doc.annotations).filter((a): a is Exclude<canvas.Annotation, { kind: 'note' }> => a.kind !== 'note' && a.view === view);
  const mine = pen.filter((a) => a.by.id === me.id);
  const m: Moment = { view: (scene?.type ?? 'architecture') as Moment['view'], reveal: u.reveal, latency: u.latency };

  const toStage = (e: PointerEvent): Point => {
    const r = sec.current!.querySelector('.stage')!.getBoundingClientRect(), k = r.width / STAGE_W;
    return [(e.clientX - r.left) / k, (e.clientY - r.top) / k];
  };
  /* The eraser: removes only the strokes it passes over (your ink and circles), one by one. Parts,
     comments, notes and other people's strokes are never touched. */
  const [rub, setRub] = useState<Point | null>(null);
  const erased = useRef(new Set<string>());
  for (const id of [...erased.current]) if (!doc.annotations[id]) erased.current.delete(id);
  const eraseAt = (a: Point, b: Point) => {
    const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 4));
    for (const m of mine) {
      if (erased.current.has(m.id)) continue;
      const pts = pathPts(m.d);
      for (let i = 0; i <= steps; i++) {
        const q: Point = [a[0] + (b[0] - a[0]) * i / steps, a[1] + (b[1] - a[1]) * i / steps];
        if (nearPath(pts, q, ERASE_R)) { erased.current.add(m.id); void run('remove_annotation', { annotation: m.id }); break; }
      }
    }
  };
  const under = tool === 'erase' && rub ? new Set(mine.filter((m) => nearPath(pathPts(m.d), rub, ERASE_R)).map((m) => m.id)) : null;
  const frame = (fn: () => void) => { cancelAnimationFrame(raf.current); raf.current = requestAnimationFrame(fn); };

  const down = (e: PointerEvent) => {
    if (e.button !== 0 || (e.target as Element).closest?.(IGNORE)) return;
    const el = sec.current!, p = toStage(e);
    if (tool === 'comment') {
      const hit = targets.find((t) => !('step' in t.ref) && p[0] >= t.x && p[0] <= t.x + t.w && p[1] >= t.y && p[1] <= t.y + t.h);
      onComment?.(p[0], p[1], hit && !('step' in hit.ref) ? { component: hit.ref.component, name: hit.short } : null);
      return;
    }
    try { el.setPointerCapture(e.pointerId); } catch { /* gone */ }
    if (tool === 'pan') { drag.current = { mode: 'pan', sx: e.clientX, sy: e.clientY, cam, s: (el.getBoundingClientRect().width / el.offsetWidth) || 1 }; setDragging(true); }
    else if (tool === 'circle') { drag.current = { mode: 'circle', pts: [p] }; setLasso([p]); ui.setState({ ask: null }); }
    else if (tool === 'draw') { drag.current = { mode: 'draw', pts: [p] }; setStroke([p]); }
    else if (tool === 'erase') { drag.current = { mode: 'erase', last: p }; eraseAt(p, p); }
    else drag.current = { mode: 'marquee', a: p, b: p, moved: false };
  };
  const move = (e: PointerEvent) => {
    const p = toStage(e);
    cursor.current = { x: p[0], y: p[1] };
    share();
    if (tool === 'erase') setRub(p);
    const d = drag.current;
    if (!d) return;
    if (d.mode === 'erase') { eraseAt(d.last, p); d.last = p; return; }
    if (d.mode === 'pan') { const dx = (e.clientX - d.sx) / d.s, dy = (e.clientY - d.sy) / d.s; frame(() => setCam({ x: d.cam.x + dx, y: d.cam.y + dy, z: d.cam.z })); }
    else if (d.mode === 'marquee') {
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
    if (d.mode === 'erase') return;
    if (d.mode === 'draw') { setStroke([]); if (d.pts.length > 2) void run('draw', { view, kind: 'ink', d: toD(d.pts, false) }); return; }
    if (d.mode !== 'marquee') {
      setLasso([]);
      if (d.pts.length < 6) return;
      const hits = circled(scene, d.pts);
      const xs = d.pts.map((q) => q[0]), ys = d.pts.map((q) => q[1]);
      const at = { x: Math.max(...xs) + 12, y: Math.min(...ys) };
      void run('draw', { view, kind: 'circle', d: toD(d.pts, true), refs: hits.map((t) => t.ref) }).then((r) => {
        if (r.ok) ui.setState({ ask: { id: r.changed.annotations[0], refs: hits.map((t) => t.ref), names: hits.map((t) => t.short), ...at } });
      });
      return;
    }
    setMarquee(null);
    if (!d.moved) { select([]); return; }
    const mq = { x0: Math.min(d.a[0], d.b[0]), y0: Math.min(d.a[1], d.b[1]), x1: Math.max(d.a[0], d.b[0]), y1: Math.max(d.a[1], d.b[1]) };
    select(targets.filter((t) => !t.key.startsWith('step:') && t.x < mq.x1 && t.x + t.w > mq.x0 && t.y < mq.y1 && t.y + t.h > mq.y0).map((t) => t.ref));
  };
  const pick = (ref: CanvasRef, e: MouseEvent) => {
    const k = refKey(ref);
    if (e.shiftKey) select(selKeys.has(k) ? sel.filter((r) => refKey(r) !== k) : sel.concat([ref]));
    else select(single === k ? [] : [ref]);
  };

  const tabs = canvas.viewsOf(doc).filter((v) => s.scenes[v.id]).map((v) => ({ id: v.id, name: v.name, title: v.question, on: v.id === view, cls: (v.id === view ? 'on' : '') + (v.status === 'proposed' ? ' proposed' : '') }));
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); void run('undo', {}); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    if (KEYS[k]) { pickTool(KEYS[k]); e.preventDefault(); return; }
    const n = parseInt(k, 10), order = tabs.map((x) => x.id);
    if (n >= 1 && n <= order.length) { show(order[n - 1]); e.preventDefault(); return; }
    if (k === '+' || k === '=') { zoomBy(1.25); e.preventDefault(); return; }
    if (k === '-') { zoomBy(0.8); e.preventDefault(); return; }
    if (k === '0') { setCam({ x: 0, y: 0, z: 1 }); e.preventDefault(); return; }
    if (k === 'Escape') { select([]); setMarquee(null); }
    if (k === 'Enter' && single && !single.startsWith('step:')) ui.setState({ open: single.split('#')[0] });
    if (scene?.type === 'failure-flow' && (k === 'ArrowRight' || k === 'ArrowLeft')) { scrub(k === 'ArrowRight' ? 1 : -1); e.preventDefault(); }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyRef.current(e);
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  const stepsTotal = scene?.steps.length ?? 0;
  const shownSteps = Math.min(u.reveal, stepsTotal);
  const scrub = (d: number) => ui.setState({ reveal: Math.max(1, Math.min(stepsTotal, shownSteps + d)) });

  const proposal = Object.values(doc.proposals).find((p) => p.status === 'open');
  const receipt = spec && spec.status === 'proposed' && spec.by.kind === 'agent'
    ? { text: <>{agentName()} drew <b>{spec.name}</b> for this conversation. It isn’t in the room until someone saves it.</>, undo: 'Discard', keep: 'Save to the room', onUndo: () => run('remove_view', { view: spec.id }), onKeep: () => run('keep_view', { view: spec.id }) }
    : proposal ? { text: <>{proposal.by.kind === 'agent' ? agentName() : proposal.by.name} proposed adding <b>{proposal.title}</b> to the system model.</>, undo: 'Reject', keep: 'Add to the system', onUndo: () => run('reject_proposal', { proposal: proposal.id }), onKeep: () => run('accept_proposal', { proposal: proposal.id }) }
    : null;

  const nodes = [...home.values()].map((h0) => {
    const n = here.get(h0.key), shown = !!n, part = n ?? h0;
    const rect = n?.rect ?? (h0.instance > 1 ? here.get(h0.component)?.rect : undefined) ?? h0.rect;
    const peer = shown ? peerOn(h0.key) : undefined, sel1 = shown && selKeys.has(h0.key);
    const pm = h0.instance === 1 ? marks[h0.component] : undefined;
    const flip = rect[0] + rect[2] + 300 > Math.max(vb[0], 760);
    const isOpen = shown && u.open === h0.component && h0.instance === 1;
    const on = shown && h0.instance === 1 ? notes.filter((a) => a.on === h0.component) : [];
    const popOpen = shown && single === h0.key && on.length > 0 && !u.whatIf;
    return {
      key: h0.key, ref: nodeRef(part), part, shown, rect, sel: sel1, peer, pm, flip, isOpen, notes: on, popOpen,
      wrapCls: 'node nx-wrap' + (shown ? '' : ' gone') + (glance && !glance.includes(h0.key) ? ' far' : '') + (isOpen || popOpen || (sel1 && u.whatIf) ? ' raised' : ''),
      cls: 'part nx-part kind-' + part.kind + ' smart-' + part.smart + (part.proposed ? ' proposed' : '') + (sel1 ? ' sel' : '') + (peer ? ' peer' : '')
        + (shown && vlit.has(part.component) ? ' agent' : '') + (shown && dlit.has(part.component) ? ' nx-lit' : '') + (pm?.since && u.since ? ' nx-changed' : '') + (pm?.diff ? ' nx-diffed' : ''),
    };
  });
  const allSteps = Object.values(s.scenes).flatMap((sc) => sc.steps.map((st, i) => {
    const on = sc.view === view, key = `step:${sc.view}:${st.id}`, shownStep = on && i < shownSteps;
    return { ...st, key, on: shownStep, i, delay: on ? 120 + i * 60 : 0, cls: 'step nx-step' + (st.tone ? ' ' + st.tone : '') + (shownStep && (selKeys.has(key) || peerOn(key)) ? ' focus' : '') + (shownStep ? '' : ' gone') + (on && i === shownSteps - 1 ? ' nx-now' : '') };
  }));
  const allWires = Object.values(s.scenes).flatMap((sc) => sc.wires.map((w, i) => ({ ...w, key: `${sc.view}:${i}`, on: sc.view === view })));
  const allLabels = Object.values(s.scenes).flatMap((sc) => sc.labels.map((l, i) => ({ ...l, key: `${sc.view}:${i}`, on: sc.view === view })));
  const allBounds = Object.values(s.scenes).flatMap((sc) => sc.bounds.map((b, i) => ({ ...b, key: `${sc.view}:${i}`, on: sc.view === view })));

  const selNodes = nodes.filter((n) => n.sel);
  const selBox = selNodes.reduce<{ x: number; y: number } | null>((b, n) => b ? { x: Math.min(b.x, n.rect[0]), y: Math.min(b.y, n.rect[1]) } : { x: n.rect[0], y: n.rect[1] }, null);
  const ctx = selBox && !u.ask && !u.open ? selBox : null;
  const selComps = [...new Set(sel.flatMap((r) => 'step' in r ? [] : [r.component]))];
  const selNames = selComps.map((c) => doc.components[c]?.name ?? c);
  const one = selComps.length === 1 && sel.length === 1 ? selComps[0] : null;
  const scen = one ? sem.scenarios[one] ?? [] : [];

  const edges = !size.w ? [] : peers.flatMap((pr) => {
    const at = pr.presence.cursor;
    if (!at) return [];
    const W = size.w, H = size.h, cxT = cam.x + ox, cyT = cam.y + oy;
    const px = W / 2 + cxT + (at.x - STAGE_W / 2) * z, py = H / 2 + cyT + (at.y - STAGE_H / 2) * z;
    const L0 = 64, R0 = W - 16, T0 = 48, B0 = H - 84;
    if (px >= L0 && px <= R0 && py >= T0 && py <= B0) return [];
    const ex = Math.max(L0 + 6, Math.min(R0 - 74, px)), ey = Math.max(T0 + 6, Math.min(B0 - 30, py));
    return [{ id: pr.id, name: pr.name, cls: 'edge' + (pr.tone === 'p2' ? ' p2' : ''), x: Math.round(ex), y: Math.round(ey), a: Math.round(Math.atan2(py - (ey + 12), px - (ex + 40)) * 180 / Math.PI), go: () => setCam({ x: -ox - (at.x - STAGE_W / 2) * z, y: -oy - (at.y - STAGE_H / 2) * z, z: cam.z }) }];
  });

  const firstWorker = scene?.nodes.find((n) => n.smart === 'worker')?.component;
  const workerCopies = scene?.nodes.filter((n) => n.component === firstWorker).length || 1;
  const anat = u.open ? sem.anatomy[u.open] ?? null : null;
  const openNode = nodes.find((n) => n.isOpen);

  return (
    <section ref={sec} class={'surface nx-surface tool-' + tool + (dragging ? ' dragging' : '') + ' view-' + (scene?.type ?? 'none')} tabIndex={0}
      aria-label={`Shared canvas · V select, H pan, O circle, P draw, C comment, Enter open, 1–${Math.max(1, tabs.length)} views, ⌘Z undo, + − 0 zoom`}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerLeave={() => { cursor.current = null; setRub(null); share(null); }}>
      <div class="world" style={`transform: translate(${cam.x + ox}px, ${cam.y + oy}px) scale(${z})`}>
        <div class={'stage' + (z < 0.8 ? ' compact' : '')}>
          {allBounds.map((b) => <div key={b.key} class={'bound' + (b.on ? '' : ' gone')} style={`transform: translate(${b.x}px, ${b.y}px); width: ${b.w}px; height: ${b.h}px`}><span>{b.label}</span></div>)}
          {allWires.map((w) => <div key={w.key} class={'wire ' + w.c + (w.on ? '' : ' gone') + (w.on && glance ? ' faint' : '')} style={`transform: translate(${w.x}px, ${w.y}px); width: ${w.w}px; height: ${w.h}px; transition-delay: ${w.on ? w.d ?? 0 : 0}ms`}></div>)}
          {allLabels.map((l) => {
            const g = sem.wires[l.t];
            return (
              <span key={l.key} class={'wlabel nx-wl' + (l.on ? '' : ' gone')} style={`transform: translate(${l.x}px, ${l.y - 4}px)`}>
                {l.t}{g && g.tone && l.on && scene?.type === 'architecture' ? <span class={'nx-gtee' + (g.tone ? ' ' + g.tone : '')}><BasisGlyph b={g.basis} />{g.text}</span> : null}
              </span>
            );
          })}
          {allSteps.map((st) => (
            <div key={st.key} class={st.cls} style={`transform: translate(${st.x}px, ${st.y}px); transition-delay: ${st.delay}ms`}
              onClick={st.on ? (e: MouseEvent) => { pick({ step: st.id, view, component: st.component }, e); ui.setState({ reveal: st.i + 1 }); } : undefined}>
              <span class="n">{st.n}</span>
              <span class="t"><b>{st.title}</b><span>{st.sub}</span></span>
              {st.tone === 'crash' || st.tone === 'bad' ? <BasisGlyph b="inferred" title="Inferred: a step the agent drew, not one it observed" /> : null}
            </div>
          ))}

          {nodes.map((n) => {
            const cap = n.shown ? caption(n.part, m, sem) : null;
            const copy = n.part.instance;
            return (
              <div key={n.key} class={n.wrapCls} style={`transform: translate(${n.rect[0]}px, ${n.rect[1]}px); width: ${n.rect[2]}px; transition-delay: ${n.shown ? n.part.delay : 0}ms`}>
                <button class={n.cls} type="button" aria-pressed={n.sel} style={`min-height: ${n.rect[3]}px`} onClick={(e) => pick(n.ref, e)}
                  onDblClick={() => { if (!n.part.proposed || true) ui.setState({ open: n.part.component, sel: [n.ref] }); }}>
                  <span class="nx-head"><span class="nx-glyph">{glyphFor(n.part)}</span><span class="pname">{n.part.name}{copy > 1 ? <em> · copy {copy}</em> : null}</span></span>
                  <span class="ptech">{n.part.tech}</span>
                  <Body n={n.part} m={m} copy={copy} lease={sem.lease} onLatency={(v) => ui.setState({ latency: v })} />
                  {cap ? <span class={'nx-cap ' + cap.tone}>{cap.text}</span> : null}
                  {n.part.kind === 'external' ? <span class="nx-own" aria-hidden="true"></span> : null}
                </button>
                {n.part.smart === 'worker' && copy === 1 && n.shown && onCopies && scene?.type !== 'failure-flow' && !u.since && (
                  <span class="nx-copies" role="group" aria-label="Copies running">
                    <button type="button" aria-label="One copy" class={workerCopies === 1 ? 'on' : ''} onClick={() => onCopies(1)}>1</button>
                    <button type="button" aria-label="Two copies at once" class={workerCopies === 2 ? 'on' : ''} onClick={() => onCopies(2)}>2</button>
                    <span>at once</span>
                  </span>
                )}
                {n.peer && !n.sel && <span class="tab peer">{n.peer.name}</span>}
                {n.peer && n.sel && sel.length === 1 && <span class="tab me">You</span>}
                {n.shown && n.pm && (n.pm.threads > 0 || n.pm.prs?.length || n.pm.agent || n.pm.governed) ? (
                  <span class="nx-marks" onPointerDown={(e) => e.stopPropagation()}>
                    {n.pm.threads > 0 && <button class={'notes-chip nx-chip' + (n.pm.needs ? ' needs' : '')} type="button" aria-label={`${n.pm.threads} threads on ${n.part.name}`} onClick={() => onMarks?.(n.part.component)}><NoteIcon />{n.pm.threads}</button>}
                    {n.pm.governed && <button class="nx-chip dec" type="button" onClick={() => onMarks?.(n.part.component)} title="The decision that governs this part">{n.pm.governed}</button>}
                    {n.pm.agent && <button class={'nx-chip agent' + (n.pm.agent.needs ? ' needs' : '')} type="button" onClick={() => onMarks?.(n.part.component)}><i></i>{n.pm.agent.text}</button>}
                    {n.pm.prs?.map((p) => <button key={p.id} class={'nx-chip pr ' + p.state} type="button" onClick={() => onMarks?.(n.part.component)}>{p.id}</button>)}
                  </span>
                ) : null}
                {n.notes.length > 0 && !n.pm?.threads && (
                  <span class="nx-marks nx-notes"><button class="notes-chip nx-chip" type="button" aria-label={`${n.notes.length} notes on ${n.part.name}`} onClick={() => select([n.ref])}><NoteIcon />{n.notes.length}</button></span>
                )}
                {n.popOpen && (
                  <div class={'npop' + (n.flip ? ' nx-below' : '')} role="region" aria-label={`Notes on ${n.part.name}`}>
                    {n.notes.map((nt) => (
                      <div key={nt.id} class={'note' + (nt.status === 'suggested' ? ' suggested' : '')}>
                        <span class="nt">{nt.status === 'suggested' ? 'Suggested ' + nt.note : nt.note}</span>
                        <p>{nt.text}</p>
                        <span class="by"><span class={nt.by.kind === 'agent' ? 'mav vowe' : nt.by.id === me.id ? 'mav' : 'mav peer'}>{nt.by.kind === 'agent' ? '' : nt.by.name.slice(0, 1)}</span>{nt.status === 'suggested' ? `${nt.by.name} suggests` : nt.by.id === me.id ? 'You' : nt.by.name}</span>
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
                {n.shown && n.pm?.since && u.since && !n.pm.diff && <span class="nx-since" title={n.pm.since}><i></i>{n.pm.since}</span>}
                {n.shown && n.pm?.diff && <span class="nx-diff"><b>{n.pm.diff.pr}</b><span>{n.pm.diff.text}</span><code>{n.pm.diff.files}</code></span>}
              </div>
            );
          })}

          <svg class="ink" viewBox={`0 0 ${STAGE_W} 620`} aria-hidden="true">
            {pen.filter((a) => !erased.current.has(a.id)).map((a) => <path key={a.id} class={(a.kind === 'ink' ? 'stroke' : 'lasso' + (a.by.kind === 'agent' ? ' read' : a.by.id !== me.id ? ' peer' : '')) + (under?.has(a.id) ? ' nx-rub' : '')} d={a.d}></path>)}
            <path class="stroke" d={toD(stroke, false)}></path>
            <path class="lasso live" d={toD(lasso, false)}></path>
            {tool === 'erase' && rub ? <circle class="nx-eraser" cx={rub[0]} cy={rub[1]} r={ERASE_R}></circle> : null}
          </svg>
          {marquee && <div class="marquee" style={`transform: translate(${marquee.x}px, ${marquee.y}px); width: ${marquee.w}px; height: ${marquee.h}px`}></div>}
          {u.ask && (
            <div class="lasso-ask" style={`transform: translate(${Math.min(u.ask.x, STAGE_W - 240)}px, ${Math.max(u.ask.y, -30)}px)`}>
              <span class="lbl">{u.ask.names.length ? 'You circled' : 'You circled empty space'}</span>
              <div class="items">{u.ask.names.map((nm, i) => <span key={i} class="tag">{nm}</span>)}</div>
              <div class="row2">
                {onAsk && u.ask.names.length > 0 ? (
                  <button class="mini ask" type="button" onClick={() => { onAsk({ components: canvas.componentsOf(u.ask!.refs), names: u.ask!.names }); ui.setState({ ask: null }); }}>Ask {agentName()} about this</button>
                ) : <button class="mini" type="button" onClick={() => ui.setState({ ask: null })}>Done</button>}
                <button class="mini ghost" type="button" onClick={() => { void run('remove_annotation', { annotation: u.ask!.id }); ui.setState({ ask: null }); }}>Remove</button>
              </div>
            </div>
          )}
          {ctx && (
            <div class="ctx nx-ctx" style={`transform: translate(${Math.min(ctx.x, vb[0] - 330)}px, ${ctx.y - 42}px)`}>
              {sel.length > 1 && <><span class="n">{sel.length} selected</span><span class="sep"></span></>}
              {onAsk && selNames.length > 0 && <><button type="button" onClick={() => onAsk({ components: selComps, names: selNames })}>{sel.length > 1 ? 'Ask about these' : 'Ask about this'}</button><span class="sep"></span></>}
              {scen.length > 0 && <><button type="button" class={u.whatIf ? 'on' : ''} aria-expanded={!!u.whatIf} onClick={() => ui.setState({ whatIf: u.whatIf ? null : one })}>What if…</button><span class="sep"></span></>}
              {one && sem.anatomy[one] && <><button type="button" onClick={() => ui.setState({ open: one })}>Open</button><span class="sep"></span></>}
              {selNames.length > 0 && <button type="button" onClick={() => run('highlight_component', { components: selComps })}>Point everyone here</button>}
              <span class="sep"></span>
              <button type="button" onClick={() => select([])}>Done</button>
            </div>
          )}
          {ctx && u.whatIf && one && selNodes[0] && (
            <div class="nx-whatif" role="menu" style={`transform: translate(${selNodes[0].flip ? selNodes[0].rect[0] - 312 : selNodes[0].rect[0] + selNodes[0].rect[2] + 12}px, ${selNodes[0].rect[1]}px)`}>
              <span class="nx-wi-h"><span class="orb"></span>What {agentName()} found could go wrong here</span>
              {scen.map((sc) => (
                <button key={sc.id} type="button" role="menuitem" onClick={() => { ui.setState({ whatIf: null }); onScenario?.(one, sc); }}>
                  <BasisGlyph b={sc.basis} /><b>{sc.title}</b><span>{sc.sub}</span>
                </button>
              ))}
            </div>
          )}
          {anat && openNode && (
            <div class={'nx-anat' + (openNode.flip ? ' flip' : '')} role="dialog" aria-label={`${openNode.part.name}, opened`}
              style={`transform: translate(${openNode.flip ? openNode.rect[0] - 318 : openNode.rect[0] + openNode.rect[2] + 14}px, ${Math.max(-20, openNode.rect[1] - 10)}px)`}>
              <div class="nx-anat-h"><span class="nx-glyph">{glyphFor(openNode.part)}</span><b>{openNode.part.name}</b><button class="nx-x" type="button" aria-label="Close" onClick={() => ui.setState({ open: null })}>×</button></div>
              <p class="nx-does">{anat.does}</p>
              <div class="nx-tabs" role="tablist">
                {(['ports', 'evidence', 'code', 'activity'] as const).map((t) => <button key={t} type="button" role="tab" aria-selected={u.openTab === t} class={u.openTab === t ? 'on' : ''} onClick={() => ui.setState({ openTab: t })}>{{ ports: 'Interfaces', evidence: 'Evidence', code: 'Code', activity: 'Activity' }[t]}</button>)}
              </div>
              {u.openTab === 'ports' && (
                <div class="nx-ports">
                  {anat.ports.map((p) => (
                    <div key={p.name} class={'nx-port ' + p.dir}>
                      <span class="nx-pdir">{p.dir === 'in' ? '→' : '←'}</span>
                      <span class="nx-psig"><code>{p.sig}</code><small>{p.dir === 'in' ? 'from' : 'to'} {doc.components[p.peer]?.name ?? p.peer}</small></span>
                      <span class={'nx-pg' + (p.guarantee.startsWith('no ') || p.guarantee.includes('lost') ? ' bad' : '')}><BasisGlyph b={p.basis} />{p.guarantee}{p.evidence ? <em>{p.evidence}</em> : null}</span>
                    </div>
                  ))}
                  {anat.state?.map((r) => <div key={r.k} class="nx-kv"><span>{r.k}</span><b>{r.v}</b><BasisGlyph b={r.basis} /></div>)}
                </div>
              )}
              {u.openTab === 'evidence' && (
                <div class="nx-evs">
                  {anat.evidence.length ? anat.evidence.map((id) => { const e = sem.evidence.find((x) => x.id === id); if (!e) return null; return <div key={id} class="nx-ev"><BasisGlyph b={e.basis} /><span><b>{e.label}</b><small>{e.ref}</small></span><em>{e.id}</em></div>; }) : <p class="nx-quiet">Nothing read yet. Ask {agentName()} to look.</p>}
                </div>
              )}
              {u.openTab === 'code' && (
                <div class="nx-evs">
                  {anat.code.length ? anat.code.map((c) => <div key={c.path} class="nx-ev code"><span><b>{c.path}</b><small>{c.lines} · {c.what}</small></span></div>) : <p class="nx-quiet">Not in the code yet: this part is proposed.</p>}
                </div>
              )}
              {u.openTab === 'activity' && (
                <div class="nx-evs">
                  {openNode.pm?.threads ? <div class="nx-ev"><NoteIcon /><span><b>{openNode.pm.threads} open {openNode.pm.threads === 1 ? 'thread' : 'threads'}</b><small>in the Desk, lit while this is open</small></span></div> : null}
                  {openNode.pm?.governed ? <div class="nx-ev"><span><b>Governed by {openNode.pm.governed}</b><small>the room’s decision</small></span></div> : null}
                  {openNode.pm?.agent ? <div class="nx-ev"><i class="nx-agentdot"></i><span><b>{openNode.pm.agent.text}</b><small>In its own worktree</small></span></div> : null}
                  {openNode.pm?.prs?.map((p) => <div key={p.id} class="nx-ev"><span><b>{p.id}</b><small>{p.state}</small></span></div>)}
                  {!openNode.pm?.threads && !openNode.pm?.agent && !openNode.pm?.governed && <p class="nx-quiet">Nothing open on this part.</p>}
                </div>
              )}
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
          {scene.type === 'failure-flow' && stepsTotal > 0 ? (
            <div class="nx-scrub" role="group" aria-label="Step through the failure">
              <button type="button" aria-label="Back a step" disabled={shownSteps <= 1} onClick={() => scrub(-1)}>‹</button>
              {scene.steps.map((st, i) => <button key={st.id} type="button" class={'nx-sd' + (i < shownSteps ? ' on' : '') + (st.tone ? ' ' + st.tone : '')} aria-label={`Step ${i + 1}: ${st.title}`} onClick={() => ui.setState({ reveal: i + 1 })}></button>)}
              <button type="button" aria-label="Forward a step" disabled={shownSteps >= stepsTotal} onClick={() => scrub(1)}>›</button>
              <span>{shownSteps} of {stepsTotal}</span>
            </div>
          ) : scene.type === 'concurrency' ? (
            <span class="nx-scrub nx-hint">Drag how long the slow call takes</span>
          ) : <span class="prov">{scene.provenance}</span>}
          {inCall ? (
            <div class="nx-lens" role="group" aria-label="Who sees your view">
              <button type="button" class={!personal ? 'on' : ''} title="Switching views moves everyone in the call" onClick={() => ui.setState({ lens: 'call', myView: null })}>Follow the call</button>
              <button type="button" class={personal ? 'on' : ''} title="Explore on your own; nobody else’s view changes, nothing is saved" onClick={() => ui.setState({ lens: 'mine', myView: view })}>Just me</button>
              {personal && view !== shared ? <span class="nx-lens-note">The call is on {canvas.viewOf(doc, shared)?.name ?? 'Architecture'} · <button type="button" class="rp-link" onClick={() => ui.setState({ lens: 'call', myView: null })}>Rejoin</button></span> : null}
            </div>
          ) : null}
        </div>
      )}

      {receipt && (
        <div class="receipt" role="status">
          <span class="orb small"></span><span>{receipt.text}</span>
          <button class="mini ghost" type="button" onClick={() => { void receipt.onUndo(); }}>{receipt.undo}</button>
          <button class="mini" type="button" onClick={() => { void receipt.onKeep(); }}>{receipt.keep}</button>
        </div>
      )}
      {s.error && !receipt && (
        <div class="receipt dropped" role="alert"><span class="dot needs"></span><span>Not saved: {s.error}</span><button class="mini ghost" type="button" onClick={() => client.dismissError()}>Dismiss</button></div>
      )}
      {edges.map((ec) => <button key={ec.id} class={ec.cls} type="button" title={`Go to ${ec.name}`} style={`transform: translate(${ec.x}px, ${ec.y}px)`} onClick={ec.go}><Arrow angle={ec.a} />{ec.name}</button>)}

      <div class="tools" role="toolbar" aria-label="Canvas tools" aria-orientation="vertical">
        {TOOLS.filter((t) => t.id !== 'comment' || onComment).map(({ id, label, title, Icon }) => (
          <button key={id} class={tool === id ? 'on' : ''} type="button" aria-label={label} title={title} aria-pressed={tool === id} onClick={() => pickTool(id)}><Icon /></button>
        ))}
        <span class="rule"></span>
        <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => zoomBy(1.25)}><ZoomIn /></button>
        <button class="zoom" type="button" aria-label="Fit the view" title="Fit" onClick={() => setCam({ x: 0, y: 0, z: 1 })}>{Math.round(z * 100) + '%'}</button>
        <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => zoomBy(0.8)}><ZoomOut /></button>
      </div>

      {anchored?.((x, y) => ({ x: size.w / 2 + cam.x + ox + (x - STAGE_W / 2) * z, y: size.h / 2 + cam.y + oy + (y - STAGE_H / 2) * z }))}
      {s.status === 'loading' || Object.keys(doc.components).length ? null : (
        <div class="fresh-empty">
          <span class="orb"></span>
          <b>{s.status === 'failed' ? 'Couldn’t read this room’s canvas' : 'Nothing drawn yet'}</b>
          {s.status === 'failed' ? <span>{s.error}</span> : (
            <>
              <span>What the room sketches lands here for everyone, saved with the room. Circle, draw and pin comments on it together.</span>
              {onAsk ? <><span class="fine">Ask {agentName()} about the system and it can sketch it here; structural changes wait for someone to accept them.</span><button class="mini ask" type="button" onClick={() => onAsk({ components: [], names: [] })}>Ask {agentName()}</button></> : null}
            </>
          )}
        </div>
      )}
      {children}
    </section>
  );
}
