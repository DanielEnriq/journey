import { Fragment, h, type ComponentChildren } from '../../vendor/preact.js';
import { useEffect, useMemo, useRef, useState } from '../../vendor/preact-hooks.js';
import {
  Arrow, ClearInk, Cursor, Note as NoteIcon, ToolCircle, ToolComment, ToolDraw, ToolPan, ToolSelect, ZoomIn, ZoomOut,
} from '../../shared/components/icons.js';
import { initials } from '../../shared/account.js';
import { Store, useStore } from '../../shared/store.js';
import {
  componentsOf, viewOf, viewsOf, type Actor, type Annotation, type CanvasRef, type Scene, type SceneNode,
} from '../../../shared/canvas/index.js';
import { srOnly } from '../room/canvas/Part.js';
import { STAGE_H, STAGE_W, toD } from '../room/geometry.js';
import { KIND_LABEL } from '../room/model.js';
import type { CanvasClient } from './client.js';
import { BasisGlyph, Body, glyphFor } from './faces.js';
import { anatomyOf, captionFor } from './faces-model.js';
import {
  askAt, centreOn, circled, edgeOf, erasedBy, ERASE_R, frameOf, HOME, marqueeHits, moved, nearPath, nodeRef, partAt, pathPts,
  refKey, targetsOf, toScreen, wheelZoom, zoomBy, type Cam, type Point,
} from './geometry.js';
import { NO_SEMANTICS, type CanvasSemantics, type Moment, type Scenario } from './semantics.js';
import { captionDue, copiesOn, copiesPlan, forkable, MAX_COPIES, revealGates, scrubbed, shownSteps } from './story.js';

// The one canvas engine. A room's canvas is the semantic document drawn as faces that show what each
// part is (faces.tsx), and every gesture is a Canvas Command about what it touched, never about pixels.
// Camera, tools, gestures, keys, presence, undo, proposals and receipts all live here, once; the room
// surfaces on top of it only choose what to pass in:
//
//   LiveSurface (features/canvas)   Journey's rooms and the harness: local UI state, no record marks.
//   Surface (features/vowe-room)    the Pass 3 room: the room's UI store, record marks, semantics, lens.
//
// The view is the room's (everyone moves together, unless you choose "Just me" in a call); the camera,
// the tool, the scrubber and what you have selected are yours.

export type Tool = 'select' | 'pan' | 'circle' | 'draw' | 'erase' | 'comment';

/** Your own state on the canvas: never saved or shared (what others see of it goes through presence). */
export interface CanvasUiState {
  tool: Tool;
  sel: CanvasRef[];
  /** The part opened in place (its anatomy). */
  open: string | null;
  openTab: 'ports' | 'evidence' | 'code' | 'activity';
  /** The part whose "What if…" scenarios are showing. */
  whatIf: string | null;
  /** Failure flow: how many steps the scrubber shows. */
  reveal: number;
  /** Concurrency: how long the slow call takes (s), when the room's semantics give a lease. */
  latency: number;
  /** The "You circled" card. */
  ask: { id: string; refs: CanvasRef[]; names: string[]; x: number; y: number } | null;
  /** In a call: follow the call's shared view, or a personal one. */
  lens: 'call' | 'mine';
  myView: string | null;
}

export const initialCanvasUi = (): CanvasUiState => ({
  tool: 'select', sel: [], open: null, openTab: 'ports', whatIf: null, reveal: 99, latency: 4, ask: null, lens: 'call', myView: null,
});

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

/** Asking the agent about what you selected or circled: component ids and how the canvas names them. */
export interface CanvasAsk { components: string[]; names: string[]; selected: string[]; circled: string[] }

export interface CanvasSurfaceProps {
  client: CanvasClient;
  ui: Store<CanvasUiState>;
  /** By component id, from the room's record. */
  marks?: Record<string, PartMarks>;
  /** Components something outside the canvas is pointing at (the option or PR you're looking at). */
  lit?: string[];
  /** What the agent has read about the system; absent: plain faces from the document alone. */
  semantics?: CanvasSemantics;
  /** How the agent is named in this organization. */
  agentName?: string;
  /** Show what changed on each part since you were last here (marks' `since`). */
  since?: boolean;
  onAsk?(about: CanvasAsk): void;
  onScenario?(component: string, s: Scenario): void;
  /** Told after the Concurrency instrument changed how many copies run (the canvas already ran the commands). */
  onCopies?(n: number): void;
  onComment?(x: number, y: number, on: { component: string; name: string } | null): void;
  onMarks?(component: string): void;
  anchored?(place: (x: number, y: number) => { x: number; y: number }, width: number, partRect: (component: string) => number[] | null): ComponentChildren;
  /** A person's colour in this room (peer, peer2, …), so their circles are drawn in it; without it, everyone else's are `peer`. */
  toneOf?(personId: string): string | undefined;
  /** Room under the canvas kept clear for captions. */
  reserve?: number;
  /** A call is on: the view can follow the call or be just yours. */
  inCall?: boolean;
  /** Draw the canvas's own empty, loading and failed states (callers that draw their own pass false). */
  states?: boolean;
  children?: ComponentChildren;
}

const TOOLS: { id: Tool; label: string; title: string; Icon: () => h.JSX.Element }[] = [
  { id: 'select', label: 'Select', title: 'Select · V', Icon: ToolSelect },
  { id: 'pan', label: 'Pan', title: 'Pan · H', Icon: ToolPan },
  { id: 'circle', label: 'Circle a region', title: 'Circle · O', Icon: ToolCircle },
  { id: 'draw', label: 'Draw', title: 'Draw · P', Icon: ToolDraw },
  { id: 'erase', label: 'Eraser', title: 'Eraser · E · erases only your strokes you drag across', Icon: ClearInk },
  { id: 'comment', label: 'Comment', title: 'Comment · C', Icon: ToolComment },
];
const KEYS: Record<string, Tool> = { v: 'select', h: 'pan', o: 'circle', p: 'draw', e: 'erase', c: 'comment' };
const IGNORE = 'button, input, label, a, textarea, [role="slider"], .ctx, .lasso-ask, .receipt, .npop, .call, .captions, .pin, .surface-head, .nx-anat, .nx-whatif, .nx-dial, .nx-copies, .fresh-empty';
const TAB_NAME = { ports: 'Interfaces', evidence: 'Evidence', code: 'Code', activity: 'Activity' } as const;

type Drag =
  | { mode: 'pan'; sx: number; sy: number; cam: Cam; s: number }
  | { mode: 'circle' | 'draw'; pts: Point[] }
  | { mode: 'erase'; last: Point }
  | { mode: 'marquee'; a: Point; b: Point; moved: boolean };
type Note = Extract<Annotation, { kind: 'note' }>;
type Mark = Exclude<Annotation, { kind: 'note' }>;

const avatar = (by: Actor, me: Actor) => by.kind === 'agent' ? 'mav vowe' : by.id === me.id ? 'mav' : 'mav peer';
const presenceTool = (t: Tool) => t === 'pan' ? 'select' : t === 'erase' ? 'draw' : t;

export function CanvasSurface(p: CanvasSurfaceProps) {
  const { client, ui, marks = {}, lit = [], semantics: sem = NO_SEMANTICS, agentName = 'Vowe', since = false, onAsk, onScenario, onCopies, onComment, onMarks, anchored, toneOf, reserve = 0, inCall = false, states = true, children } = p;
  const s = useStore(client.store);
  const u = useStore(ui);
  const me = client.transport.me();
  const doc = s.doc;
  // Lenses: in a call, switching views moves everyone (the document's shared activeView). "Just me" keeps
  // a personal lens: your view changes, nobody else's does, and nothing is saved.
  const personal = u.lens === 'mine' && inCall;
  const shared = s.scenes[doc.activeView] ? doc.activeView : 'architecture';
  const view = personal && u.myView && s.scenes[u.myView] ? u.myView : shared;
  const scene = s.scenes[view] as Scene | undefined;
  const spec = viewOf(doc, view);
  const tool = u.tool, sel = u.sel;

  const [cams, setCams] = useState<Record<string, Cam>>({});
  const [lasso, setLasso] = useState<Point[]>([]);
  const [stroke, setStroke] = useState<Point[]>([]);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [rub, setRub] = useState<Point | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const sec = useRef<HTMLElement>(null);
  const drag = useRef<Drag | null>(null);
  const raf = useRef(0);
  const cursor = useRef<{ x: number; y: number } | null>(null);
  const erased = useRef(new Set<string>());

  const cam = cams[view] ?? HOME;
  const setCam = (c: Cam) => setCams((all) => ({ ...all, [view]: c }));
  const run: CanvasClient['run'] = (name, args) => client.run(name, args);

  // Your view, pen and selection go to the call, and to the agent as what "this" means. Read from the
  // store, not this render, because a pointer move can land before the re-render.
  const share = (c = cursor.current) => {
    const { sel: selection, tool: t } = ui.state;
    client.share({ view, cursor: c ? { x: Math.round(c.x), y: Math.round(c.y) } : null, selection, tool: presenceTool(t) });
  };
  const show = (id: string) => {
    if (id === view) return;
    if (personal) { ui.setState({ myView: id }); return; }
    if (u.myView) ui.setState({ myView: null });
    void run('show_view', { view: id });
  };
  const pickTool = (t: Tool) => { ui.setState({ tool: t }); share(); };
  const select = (next: CanvasRef[]) => {
    ui.setState({ sel: next, ask: null, whatIf: null, open: u.open && next.some((r) => !('step' in r) && r.component === u.open) ? u.open : null });
    share();
  };
  useEffect(() => { ui.setState({ sel: [], ask: null, whatIf: null, open: null }); share(); }, [view]);

  useEffect(() => {
    const el = sec.current!;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* Fit the drawing to the free space, as the design does: tool rail left, the call below. */
  const vb = scene?.viewBox ?? [STAGE_W, STAGE_H];
  const frame = frameOf(size, vb, cam, reserve);
  const z = frame.z;
  const place = (x: number, y: number) => toScreen(size, cam, frame, x, y);
  /** Where a part is drawn in this view (stage units), for things anchored to it; null when the view leaves it out. */
  const partRect = (component: string) => scene?.nodes.find((n) => n.component === component && !n.key.includes('#'))?.rect ?? null;

  // Wheel needs a non-passive listener so ⌘-scroll zooms the canvas instead of the page.
  const live = useRef({ cam, frame, setCam });
  live.current = { cam, frame, setCam };
  useEffect(() => {
    const el = sec.current!;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as Element).closest?.('.nx-anat, .npop, .nx-whatif')) return;
      const r = el.getBoundingClientRect(), k = (r.width / el.offsetWidth) || 1, { cam: c, frame: f, setCam: set } = live.current;
      if (e.ctrlKey || e.metaKey) set(wheelZoom(c, f, { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k }, { w: el.offsetWidth, h: el.offsetHeight }, e.deltaY));
      else set({ x: c.x - e.deltaX / k, y: c.y - e.deltaY / k, z: c.z });
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
  const vlit = new Set(doc.highlight?.components ?? []);
  const dlit = new Set(lit);
  const peers = Object.values(s.peers).filter((pr) => pr.presence.view === view);
  const peerOn = (key: string) => peers.find((pr) => pr.presence.selection.some((r) => refKey(r) === key));
  const notes = Object.values(doc.annotations).filter((a): a is Note => a.kind === 'note');
  const pen = Object.values(doc.annotations).filter((a): a is Mark => a.kind !== 'note' && a.view === view);
  const mine = pen.filter((a) => a.by.id === me.id);
  for (const id of [...erased.current]) if (!doc.annotations[id]) erased.current.delete(id);

  /* The story so far: the scrubber's step on a Failure flow, the slow call's latency on Concurrency. */
  const gates = useMemo(() => revealGates(scene), [scene]);
  const stepsTotal = gates.total;
  const shown = shownSteps(u.reveal, stepsTotal);
  const m: Moment = { view: (scene?.type ?? 'architecture'), reveal: shown, latency: u.latency };
  const scrub = (by: number) => ui.setState({ reveal: scrubbed(u.reveal, stepsTotal, by) });
  // PASS3_BACKEND: CanvasSemantics.lease (the lease a job is held for). Without it the Concurrency face
  // draws no timeline and offers no latency dial: the engine never guesses timing.
  const lease = sem.lease;

  const toStage = (e: PointerEvent): Point => {
    const r = sec.current!.querySelector('.stage')!.getBoundingClientRect(), k = r.width / STAGE_W;
    return [(e.clientX - r.left) / k, (e.clientY - r.top) / k];
  };
  /* The eraser removes only the strokes it passes over (your ink and circles), one by one. Parts,
     comments, notes and other people's strokes are never touched. */
  const eraseAt = (a: Point, b: Point) => {
    for (const id of erasedBy(mine, a, b, erased.current)) { erased.current.add(id); void run('remove_annotation', { annotation: id }); }
  };
  const under = tool === 'erase' && rub ? new Set(mine.filter((a) => nearPath(pathPts(a.d), rub, ERASE_R)).map((a) => a.id)) : null;
  const later = (fn: () => void) => { cancelAnimationFrame(raf.current); raf.current = requestAnimationFrame(fn); };

  /* ---------- Gestures: each ends as a command about what it touched. ---------- */
  const down = (e: PointerEvent) => {
    if (e.button !== 0 || (e.target as Element).closest?.(IGNORE)) return;
    const el = sec.current!, at = toStage(e);
    if (tool === 'comment') { if (onComment) onComment(at[0], at[1], partAt(targets, at)); return; }
    try { el.setPointerCapture(e.pointerId); } catch { /* the pointer may already be gone */ }
    if (tool === 'pan') { drag.current = { mode: 'pan', sx: e.clientX, sy: e.clientY, cam, s: (el.getBoundingClientRect().width / el.offsetWidth) || 1 }; setDragging(true); }
    else if (tool === 'circle') { drag.current = { mode: 'circle', pts: [at] }; setLasso([at]); ui.setState({ ask: null }); }
    else if (tool === 'draw') { drag.current = { mode: 'draw', pts: [at] }; setStroke([at]); }
    else if (tool === 'erase') { drag.current = { mode: 'erase', last: at }; eraseAt(at, at); }
    else drag.current = { mode: 'marquee', a: at, b: at, moved: false };
  };

  const move = (e: PointerEvent) => {
    const at = toStage(e);
    cursor.current = { x: at[0], y: at[1] };
    share();
    if (tool === 'erase') setRub(at);
    const d = drag.current;
    if (!d) return;
    if (d.mode === 'erase') { eraseAt(d.last, at); d.last = at; return; }
    if (d.mode === 'pan') {
      const dx = (e.clientX - d.sx) / d.s, dy = (e.clientY - d.sy) / d.s;
      later(() => setCam({ x: d.cam.x + dx, y: d.cam.y + dy, z: d.cam.z }));
    } else if (d.mode === 'marquee') {
      d.b = at;
      if (moved(d.a, at)) d.moved = true;
      if (d.moved) later(() => setMarquee({ x: Math.min(d.a[0], d.b[0]), y: Math.min(d.a[1], d.b[1]), w: Math.abs(d.b[0] - d.a[0]), h: Math.abs(d.b[1] - d.a[1]) }));
    } else {
      const last = d.pts[d.pts.length - 1];
      if (!moved(last, at, 3)) return;
      d.pts.push(at);
      later(() => (d.mode === 'circle' ? setLasso : setStroke)(d.pts.slice()));
    }
  };

  const up = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    cancelAnimationFrame(raf.current);
    if (d.mode === 'pan') { setDragging(false); return; }
    if (d.mode === 'erase') return;
    if (d.mode === 'draw') {
      setStroke([]);
      if (d.pts.length > 2) void run('draw', { view, kind: 'ink', d: toD(d.pts, false) });
      return;
    }
    if (d.mode !== 'marquee') {
      setLasso([]);
      if (d.pts.length < 6) return;
      const hits = circled(scene, d.pts), at = askAt(d.pts);
      void run('draw', { view, kind: 'circle', d: toD(d.pts, true), refs: hits.map((t) => t.ref) }).then((r) => {
        if (r.ok) ui.setState({ ask: { id: r.changed.annotations[0], refs: hits.map((t) => t.ref), names: hits.map((t) => t.short), ...at } });
      });
      return;
    }
    setMarquee(null);
    if (!d.moved) { select([]); return; }
    select(marqueeHits(targets, d.a, d.b));
  };

  const pick = (ref: CanvasRef, e: MouseEvent) => {
    const k = refKey(ref);
    if (e.shiftKey) select(selKeys.has(k) ? sel.filter((r) => refKey(r) !== k) : sel.concat([ref]));
    else select(single === k ? [] : [ref]);
  };
  const openPart = (component: string, ref: CanvasRef) => ui.setState({ open: component, sel: [ref], whatIf: null, ask: null });

  /* ---------- The Concurrency instrument: copies of one part on one job, as commands. ---------- */
  const setCopies = async (focus: string, n: number) => {
    const plan = copiesPlan(doc, spec, focus, n);
    if (!plan) return;
    if (plan.kind === 'show') show(plan.view);
    else if (plan.kind === 'set') {
      const r = await run('set_instances', { view: plan.view, instances: plan.instances });
      if (r.ok && plan.show) show(plan.view);
    } else if (personal) {
      // Exploring on your own: draw the view without moving the call to it.
      const r = await run('create_view', { type: 'concurrency', focus: plan.focus, instances: plan.instances, show: false });
      if (r.ok && r.changed.views[0]) ui.setState({ myView: r.changed.views[0] });
    } else await run('show_view', { view: 'concurrency', focus: plan.focus, instances: plan.instances });
    onCopies?.(n);
  };

  /* ---------- Keys: tools, views, zoom, undo, open, scrub. ---------- */
  const tabs = viewsOf(doc).filter((v) => s.scenes[v.id]).map((v) => ({
    id: v.id, name: v.name, title: v.question, on: v.id === view, cls: (v.id === view ? 'on' : '') + (v.status === 'proposed' ? ' proposed' : ''),
  }));
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); void run('undo', {}); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    if (KEYS[k] && (KEYS[k] !== 'comment' || onComment)) { pickTool(KEYS[k]); e.preventDefault(); return; }
    const n = parseInt(k, 10), order = tabs.map((x) => x.id);
    if (n >= 1 && n <= order.length) { show(order[n - 1]); e.preventDefault(); return; }
    if (k === '+' || k === '=') { setCam(zoomBy(cam, 1.25)); e.preventDefault(); return; }
    if (k === '-') { setCam(zoomBy(cam, 0.8)); e.preventDefault(); return; }
    if (k === '0') { setCam(HOME); e.preventDefault(); return; }
    if (k === 'Escape') { if (u.open) ui.setState({ open: null }); else { select([]); setMarquee(null); } return; }
    if (k === 'Enter' && single && !single.startsWith('step:') && sel[0] && !('step' in sel[0])) { openPart(sel[0].component, sel[0]); e.preventDefault(); return; }
    if (scene?.type === 'failure-flow' && (k === 'ArrowRight' || k === 'ArrowLeft')) { scrub(k === 'ArrowRight' ? 1 : -1); e.preventDefault(); }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyRef.current(e);
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  /* ---------- What the room shows. ---------- */
  const proposal = Object.values(doc.proposals).find((x) => x.status === 'open');
  const receipt = spec && spec.status === 'proposed' && spec.by.kind === 'agent'
    ? { text: <>{agentName} drew <b>{spec.name}</b> for this conversation. It isn’t in the room until someone saves it.</>, undo: 'Discard', keep: 'Save to the room',
      onUndo: () => run('remove_view', { view: spec.id }), onKeep: () => run('keep_view', { view: spec.id }) }
    : proposal ? { text: <>{proposal.by.kind === 'agent' ? agentName : proposal.by.name} proposed adding <b>{proposal.title}</b> to the system model.</>, undo: 'Reject', keep: 'Add to the system',
      onUndo: () => run('reject_proposal', { proposal: proposal.id }), onKeep: () => run('accept_proposal', { proposal: proposal.id }) }
    : null;

  const nodes = [...home.values()].map((h0) => {
    const n = here.get(h0.key), on = !!n, part = n ?? h0;
    // A copy no view is showing waits under its component, so it splits out of it when a view needs it.
    const rect = n?.rect ?? (h0.instance > 1 ? here.get(h0.component)?.rect : undefined) ?? h0.rect;
    const peer = on ? peerOn(h0.key) : undefined, sel1 = on && selKeys.has(h0.key);
    const pm = h0.instance === 1 ? marks[h0.component] : undefined;
    const flip = rect[0] + rect[2] + 300 > Math.max(vb[0], 760);
    const isOpen = on && u.open === h0.component && h0.instance === 1;
    const its = on && h0.instance === 1 ? notes.filter((a) => a.on === h0.component) : [];
    const popOpen = on && single === h0.key && its.length > 0 && !u.whatIf && !isOpen;
    return {
      key: h0.key, ref: nodeRef(part), part, shown: on, rect, sel: sel1, peer, pm, flip, isOpen, notes: its, popOpen,
      marked: !!(on && pm && (pm.threads > 0 || pm.prs?.length || pm.agent || pm.governed)),
      wrapCls: 'node nx-wrap' + (on ? '' : ' gone') + (glance && !glance.includes(h0.key) ? ' far' : '') + (isOpen || popOpen || (sel1 && u.whatIf) ? ' raised' : ''),
      cls: 'part nx-part kind-' + part.kind + ' smart-' + part.smart + (part.proposed ? ' proposed' : '') + (sel1 ? ' sel' : '') + (peer ? ' peer' : '')
        + (on && vlit.has(part.component) ? ' agent' : '') + (on && dlit.has(part.component) ? ' nx-lit' : '') + (pm?.since && since ? ' nx-changed' : '') + (pm?.diff ? ' nx-diffed' : ''),
    };
  });
  const allSteps = Object.values(s.scenes).flatMap((sc) => sc.steps.map((st, i) => {
    const here1 = sc.view === view, key = `step:${sc.view}:${st.id}`, on = here1 && i < shown;
    return {
      ...st, key, on, i, delay: here1 ? 120 + i * 60 : 0,
      cls: 'step nx-step' + (st.tone ? ' ' + st.tone : '') + (on && (selKeys.has(key) || peerOn(key)) ? ' focus' : '') + (on ? '' : ' gone') + (here1 && i === shown - 1 ? ' nx-now' : ''),
    };
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
  // PASS3_BACKEND: CanvasSemantics.scenarios (what could go wrong at a part, found by the agent).
  const scen = one ? sem.scenarios[one] ?? [] : [];

  /* Someone you can't see: their cursor waits on the edge, pointing at them. */
  const edges = peers.flatMap((pr) => {
    const at = pr.presence.cursor, e = at && edgeOf(size, cam, frame, at, reserve);
    return at && e ? [{ id: pr.id, name: pr.name, cls: 'edge' + (pr.tone === 'p2' ? ' p2' : ''), ...e, go: () => setCam(centreOn(cam, frame, at)) }] : [];
  });

  /* The Concurrency instrument's subject: the view's focus there, the first part that can fork elsewhere. */
  const copiesFocus = scene?.type === 'concurrency' ? spec?.focus
    : scene?.type === 'architecture' ? scene.nodes.find((n) => n.smart === 'worker' && n.instance === 1 && forkable(doc, n.component))?.component : undefined;
  const copies = copiesOn(spec, copiesFocus);
  const anat = u.open ? anatomyOf(doc, u.open, sem) : null;
  const openNode = nodes.find((n) => n.isOpen);
  const empty = !Object.keys(doc.components).length;

  return (
    <section ref={sec} class={'surface nx-surface tool-' + tool + (dragging ? ' dragging' : '') + ' view-' + (scene?.type ?? 'none')} tabIndex={0}
      aria-label={`Shared canvas · V select, H pan, O circle, P draw, E erase${onComment ? ', C comment' : ''}, Enter open, 1–${Math.max(1, tabs.length)} views, ⌘Z undo, + − 0 zoom`}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
      onPointerLeave={() => { cursor.current = null; setRub(null); share(null); }}>
      <div class="world" style={`transform: translate(${cam.x + frame.ox}px, ${cam.y + frame.oy}px) scale(${z})`}>
        <div class={'stage' + (z < 0.8 ? ' compact' : '')}>
          {allBounds.map((b) => <div key={b.key} class={'bound' + (b.on ? '' : ' gone')} style={`transform: translate(${b.x}px, ${b.y}px); width: ${b.w}px; height: ${b.h}px`}><span>{b.label}</span></div>)}
          {allWires.map((w) => <div key={w.key} class={'wire ' + w.c + (w.on ? '' : ' gone') + (w.on && glance ? ' faint' : '')} style={`transform: translate(${w.x}px, ${w.y}px); width: ${w.w}px; height: ${w.h}px; transition-delay: ${w.on ? w.d ?? 0 : 0}ms`}></div>)}
          {allLabels.map((l) => {
            // PASS3_BACKEND: CanvasSemantics.wires (the guarantee each wire carries, by its verb).
            const g = l.on && scene?.type === 'architecture' ? sem.wires[l.t] : undefined;
            return (
              <span key={l.key} class={'wlabel nx-wl' + (l.on ? '' : ' gone')} style={`transform: translate(${l.x}px, ${l.y - (g ? 4 : 0)}px)`}>
                {l.t}{g ? <span class={'nx-gtee' + (g.tone ? ' ' + g.tone : '')}><BasisGlyph b={g.basis} />{g.text}</span> : null}
              </span>
            );
          })}
          {allSteps.map((st) => (
            <div key={st.key} class={st.cls} style={`transform: translate(${st.x}px, ${st.y}px); transition-delay: ${st.delay}ms`}
              onClick={st.on ? (e: MouseEvent) => { pick({ step: st.id, view, component: st.component }, e); ui.setState({ reveal: st.i + 1 }); } : undefined}>
              <span class="n">{st.n}</span>
              <span class="t"><b>{st.title}</b><span>{st.sub}</span></span>
            </div>
          ))}

          {nodes.map((n) => {
            const cap = n.shown && captionDue(scene?.type, gates, n.part.component, shown) ? captionFor(n.part, m, sem) : null;
            const copy = n.part.instance;
            return (
              <div key={n.key} class={n.wrapCls} style={`transform: translate(${n.rect[0]}px, ${n.rect[1]}px); width: ${n.rect[2]}px; transition-delay: ${n.shown ? n.part.delay : 0}ms`}>
                <button class={n.cls} type="button" aria-pressed={n.sel} style={`min-height: ${n.rect[3]}px`} onClick={(e) => pick(n.ref, e)}
                  onDblClick={() => openPart(n.part.component, n.ref)}>
                  <span class="nx-head"><span class="nx-glyph">{glyphFor(n.part)}</span><span class="pname">{n.part.name}{copy > 1 ? <em> · copy {copy}</em> : null}</span></span>
                  <span class="ptech">{n.part.tech}</span>
                  <Body n={n.part} m={m} gates={gates} copy={copy} lease={lease} onLatency={(v) => ui.setState({ latency: v })} />
                  {cap ? <span class={'nx-cap ' + cap.tone}>{cap.text}</span> : null}
                  {n.part.kind === 'external' ? <span class="nx-own" aria-hidden="true"></span> : null}
                </button>
                {n.shown && copy === 1 && n.part.component === copiesFocus && scene?.type === 'architecture' && !since && (
                  <span class="nx-copies" role="group" aria-label={`Copies of ${n.part.name} on one job`}>
                    <button type="button" aria-pressed={copies === 1} class={copies === 1 ? 'on' : ''} title="One copy" onClick={() => { void setCopies(n.part.component, 1); }}>1</button>
                    <button type="button" aria-pressed={copies === 2} class={copies === 2 ? 'on' : ''} title="Two copies take the same job" onClick={() => { void setCopies(n.part.component, 2); }}>2</button>
                    <span>at once</span>
                  </span>
                )}
                {n.peer && !n.sel && <span class="tab peer">{n.peer.name}</span>}
                {n.peer && n.sel && sel.length === 1 && <span class="tab me">You</span>}
                {n.marked && n.pm ? (
                  <span class="nx-marks" onPointerDown={(e) => e.stopPropagation()}>
                    {n.notes.length > 0 && !n.pm.threads && <button class="notes-chip nx-chip" type="button" aria-label={`${n.notes.length} notes on ${n.part.name}`} onClick={() => select([n.ref])}><NoteIcon />{n.notes.length}</button>}
                    {n.pm.threads > 0 && <button class={'notes-chip nx-chip' + (n.pm.needs ? ' needs' : '')} type="button" aria-label={`${n.pm.threads} threads on ${n.part.name}`} onClick={() => onMarks?.(n.part.component)}><NoteIcon />{n.pm.threads}</button>}
                    {n.pm.governed && <button class="nx-chip dec" type="button" onClick={() => onMarks?.(n.part.component)} title="The decision that governs this part">{n.pm.governed}</button>}
                    {n.pm.agent && <button class={'nx-chip agent' + (n.pm.agent.needs ? ' needs' : '')} type="button" onClick={() => onMarks?.(n.part.component)}><i></i>{n.pm.agent.text}</button>}
                    {n.pm.prs?.map((pr) => <button key={pr.id} class={'nx-chip pr ' + pr.state} type="button" onClick={() => onMarks?.(n.part.component)}>{pr.id}</button>)}
                  </span>
                ) : null}
                {/* Notes alone get their own chip; next to other marks they join that row (above), so the two never overlap. */}
                {n.notes.length > 0 && !n.marked && (
                  <span class="nx-marks nx-notes"><button class="notes-chip nx-chip" type="button" aria-label={`${n.notes.length} notes on ${n.part.name}`} onClick={() => select([n.ref])}><NoteIcon />{n.notes.length}</button></span>
                )}
                {n.popOpen && (
                  <div class={'npop' + (n.flip ? ' flip nx-below' : '')} role="region" aria-label={`Notes on ${n.part.name}`}>
                    {n.notes.map((nt) => (
                      <div key={nt.id} class={'note' + (nt.status === 'suggested' ? ' suggested' : '')}>
                        <span class="nt">{nt.status === 'suggested' ? 'Suggested ' + KIND_LABEL[nt.note].toLowerCase() : KIND_LABEL[nt.note]}</span>
                        <p>{nt.text}</p>
                        <span class="by"><span class={avatar(nt.by, me)}>{nt.by.kind === 'agent' ? '' : initials(nt.by.name)}</span>{nt.status === 'suggested' ? `${nt.by.kind === 'agent' ? agentName : nt.by.name} suggests` : nt.by.id === me.id ? 'You' : nt.by.name}</span>
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
                {n.shown && n.pm?.since && since && !n.pm.diff && <span class="nx-since" title={n.pm.since}><i></i>{n.pm.since}</span>}
                {n.shown && n.pm?.diff && <span class="nx-diff"><b>{n.pm.diff.pr}</b><span>{n.pm.diff.text}</span><code>{n.pm.diff.files}</code></span>}
              </div>
            );
          })}

          <svg class="ink" viewBox={`0 0 ${STAGE_W} 620`} aria-hidden="true">
            {pen.filter((a) => !erased.current.has(a.id)).map((a) => (
              <path key={a.id} class={(a.kind === 'ink' ? 'stroke' : 'lasso' + (a.by.kind === 'agent' ? ' read' : a.by.id !== me.id ? ' ' + (toneOf?.(a.by.id) ?? 'peer') : '')) + (under?.has(a.id) ? ' nx-rub' : '')} d={a.d}></path>
            ))}
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
                  <button class="mini ask" type="button" onClick={() => { const c = componentsOf(u.ask!.refs); onAsk({ components: c, circled: c, selected: [], names: u.ask!.names }); ui.setState({ ask: null }); }}>Ask {agentName} about this</button>
                ) : <button class="mini" type="button" onClick={() => ui.setState({ ask: null })}>Done</button>}
                <button class="mini ghost" type="button" onClick={() => { void run('remove_annotation', { annotation: u.ask!.id }); ui.setState({ ask: null }); }}>Remove</button>
              </div>
            </div>
          )}
          {ctx && (
            <div class="ctx nx-ctx" style={`transform: translate(${Math.max(0, Math.min(ctx.x, vb[0] - 330))}px, ${ctx.y - 42}px)`}>
              {sel.length > 1 && <><span class="n">{sel.length} selected</span><span class="sep"></span></>}
              {onAsk && selNames.length > 0 && <><button type="button" onClick={() => onAsk({ components: selComps, selected: selComps, circled: [], names: selNames })}>{sel.length > 1 ? 'Ask about these' : 'Ask about this'}</button><span class="sep"></span></>}
              {scen.length > 0 && <><button type="button" class={u.whatIf ? 'on' : ''} aria-expanded={!!u.whatIf} onClick={() => ui.setState({ whatIf: u.whatIf ? null : one })}>What if…</button><span class="sep"></span></>}
              {one && sel[0] && !('step' in sel[0]) && <><button type="button" onClick={() => openPart(one, sel[0])}>Open</button><span class="sep"></span></>}
              {selNames.length > 0 && <button type="button" onClick={() => run('highlight_component', { components: selComps })}>Point everyone here</button>}
              <span class="sep"></span>
              <button type="button" onClick={() => select([])}>Done</button>
            </div>
          )}
          {ctx && u.whatIf && one && selNodes[0] && (
            <div class="nx-whatif" role="menu" style={`transform: translate(${selNodes[0].flip ? selNodes[0].rect[0] - 312 : selNodes[0].rect[0] + selNodes[0].rect[2] + 12}px, ${selNodes[0].rect[1]}px)`}>
              <span class="nx-wi-h"><span class="orb"></span>What {agentName} found could go wrong here</span>
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
              {anat.does ? <p class="nx-does">{anat.does}</p> : null}
              {anat.source === 'document' ? <p class="nx-quiet nx-anat-src">From the canvas only. {agentName} hasn’t read this part’s code yet.</p> : null}
              <div class="nx-tabs" role="tablist">
                {(['ports', 'evidence', 'code', 'activity'] as const).map((t) => <button key={t} type="button" role="tab" aria-selected={u.openTab === t} class={u.openTab === t ? 'on' : ''} onClick={() => ui.setState({ openTab: t })}>{TAB_NAME[t]}</button>)}
              </div>
              {u.openTab === 'ports' && (
                <div class="nx-ports">
                  {anat.ports.map((pt, i) => (
                    <div key={i} class={'nx-port ' + pt.dir}>
                      <span class="nx-pdir">{pt.dir === 'in' ? '→' : '←'}</span>
                      <span class="nx-psig"><code>{pt.sig}</code><small>{pt.dir === 'in' ? 'from' : 'to'} {doc.components[pt.peer]?.name ?? pt.peer}</small></span>
                      {pt.guarantee
                        ? <span class={'nx-pg' + (pt.guarantee.bad ? ' bad' : '')}><BasisGlyph b={pt.guarantee.basis} />{pt.guarantee.text}{pt.guarantee.evidence ? <em>{pt.guarantee.evidence}</em> : null}</span>
                        : <span class="nx-pg nx-unread">not read yet</span>}
                    </div>
                  ))}
                  {!anat.ports.length ? <p class="nx-quiet">Nothing connects to it yet.</p> : null}
                  {anat.state.map((r) => <div key={r.k} class="nx-kv"><span>{r.k}</span><b>{r.v}</b>{r.basis ? <BasisGlyph b={r.basis} /> : null}</div>)}
                </div>
              )}
              {u.openTab === 'evidence' && (
                <div class="nx-evs">
                  {anat.evidence?.length ? anat.evidence.map((e) => <div key={e.id} class="nx-ev"><BasisGlyph b={e.basis} /><span><b>{e.label}</b><small>{e.ref}</small></span><em>{e.id}</em></div>)
                    : <p class="nx-quiet">Nothing read yet.{onAsk ? <> <button type="button" class="rp-link" onClick={() => onAsk({ components: [openNode.part.component], selected: [openNode.part.component], circled: [], names: [openNode.part.name] })}>Ask {agentName} to look</button></> : ` Ask ${agentName} to look.`}</p>}
                </div>
              )}
              {u.openTab === 'code' && (
                <div class="nx-evs">
                  {anat.code?.length ? anat.code.map((c) => <div key={c.path} class="nx-ev code"><span><b>{c.path}</b><small>{c.lines} · {c.what}</small></span></div>)
                    : <p class="nx-quiet">{openNode.part.proposed ? 'Not in the code yet: this part is proposed.' : 'Not read yet.'}</p>}
                </div>
              )}
              {u.openTab === 'activity' && (
                <div class="nx-evs">
                  {openNode.pm?.threads ? <div class="nx-ev"><NoteIcon /><span><b>{openNode.pm.threads} open {openNode.pm.threads === 1 ? 'thread' : 'threads'}</b><small>in the Desk, lit while this is open</small></span></div> : null}
                  {openNode.pm?.governed ? <div class="nx-ev"><span><b>Governed by {openNode.pm.governed}</b><small>the room’s decision</small></span></div> : null}
                  {openNode.pm?.agent ? <div class="nx-ev"><i class="nx-agentdot"></i><span><b>{openNode.pm.agent.text}</b><small>In its own worktree</small></span></div> : null}
                  {openNode.pm?.prs?.map((pr) => <div key={pr.id} class="nx-ev"><span><b>{pr.id}</b><small>{pr.state}</small></span></div>)}
                  {openNode.notes.map((nt) => <div key={nt.id} class="nx-ev"><NoteIcon /><span><b>{KIND_LABEL[nt.note]}</b><small>{nt.text}</small></span></div>)}
                  {!openNode.pm?.threads && !openNode.pm?.agent && !openNode.pm?.governed && !openNode.pm?.prs?.length && !openNode.notes.length && <p class="nx-quiet">Nothing open on this part.</p>}
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
              <button type="button" aria-label="Back a step" disabled={shown <= 1} onClick={() => scrub(-1)}>‹</button>
              {scene.steps.map((st, i) => <button key={st.id} type="button" class={'nx-sd' + (i < shown ? ' on' : '') + (st.tone ? ' ' + st.tone : '')} aria-label={`Step ${i + 1}: ${st.title}`} aria-current={i === shown - 1 ? 'step' : undefined} onClick={() => ui.setState({ reveal: i + 1 })}></button>)}
              <button type="button" aria-label="Forward a step" disabled={shown >= stepsTotal} onClick={() => scrub(1)}>›</button>
              <span aria-live="polite">{shown} of {stepsTotal}</span>
            </div>
          ) : scene.type === 'concurrency' && copiesFocus ? (
            <div class="nx-copies nx-copies-head" role="group" aria-label={`Copies of ${doc.components[copiesFocus]?.name ?? copiesFocus} on one job`}>
              <span>Copies at once</span>
              {Array.from({ length: MAX_COPIES }, (_, i) => i + 1).map((k) => (
                <button key={k} type="button" aria-pressed={copies === k} class={copies === k ? 'on' : ''} title={k === 1 ? 'Back to one copy (Architecture)' : `${k} copies take the same job`} onClick={() => { void setCopies(copiesFocus, k); }}>{k}</button>
              ))}
              {lease !== undefined ? <em>· drag how long the slow call takes</em> : null}
            </div>
          ) : <span class="prov">{scene.provenance}</span>}
          {inCall ? (
            <div class="nx-lens" role="group" aria-label="Who sees your view">
              <button type="button" class={!personal ? 'on' : ''} aria-pressed={!personal} title="Switching views moves everyone in the call" onClick={() => ui.setState({ lens: 'call', myView: null })}>Follow the call</button>
              <button type="button" class={personal ? 'on' : ''} aria-pressed={personal} title="Explore on your own; nobody else’s view changes" onClick={() => ui.setState({ lens: 'mine', myView: view })}>Just me</button>
              {personal && view !== shared ? <span class="nx-lens-note">The call is on {viewOf(doc, shared)?.name ?? 'Architecture'} · <button type="button" class="rp-link" onClick={() => ui.setState({ lens: 'call', myView: null })}>Rejoin</button></span> : null}
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
      {s.error && !receipt && s.status !== 'failed' && (
        <div class="receipt dropped" role="alert">
          <span class="dot needs"></span><span>Not saved: {s.error}</span>
          <button class="mini ghost" type="button" onClick={() => client.dismissError()}>Dismiss</button>
        </div>
      )}
      {edges.map((ec) => <button key={ec.id} class={ec.cls} type="button" title={`Go to ${ec.name}`} style={`transform: translate(${ec.x}px, ${ec.y}px)`} onClick={ec.go}><Arrow angle={ec.a} />{ec.name}</button>)}

      <div class="tools" role="toolbar" aria-label="Canvas tools" aria-orientation="vertical">
        {TOOLS.filter((t) => t.id !== 'comment' || onComment).map(({ id, label, title, Icon }) => (
          <button key={id} class={tool === id ? 'on' : ''} type="button" aria-label={label} title={title} aria-pressed={tool === id} onClick={() => pickTool(id)}><Icon /></button>
        ))}
        {tool === 'erase' && mine.length > 0 && (
          <button class="nx-clearall" type="button" aria-label="Clear all your ink in this view" title="Clear all your ink in this view"
            onClick={() => mine.forEach((a) => { erased.current.add(a.id); void run('remove_annotation', { annotation: a.id }); })}>All</button>
        )}
        <span class="rule"></span>
        <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => setCam(zoomBy(cam, 1.25))}><ZoomIn /></button>
        <button class="zoom" type="button" aria-label="Fit the view" title="Fit" onClick={() => setCam(HOME)}>{Math.round(z * 100) + '%'}</button>
        <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => setCam(zoomBy(cam, 0.8))}><ZoomOut /></button>
      </div>
      <span style={srOnly} aria-live="polite">{s.pending ? 'Saving…' : ''}</span>

      {anchored?.(place, size.w, partRect)}
      {states && s.status === 'loading' && empty ? (
        <div class="fresh-empty nx-loading" role="status"><span class="orb"></span><b>Opening this room’s canvas…</b></div>
      ) : states && empty ? (
        <div class="fresh-empty">
          <span class="orb"></span>
          <b>{s.status === 'failed' ? 'Couldn’t read this room’s canvas' : 'Nothing drawn yet'}</b>
          {s.status === 'failed' ? (
            <><span>{s.error}</span><button class="mini" type="button" onClick={() => { void client.reload(); }}>Try again</button></>
          ) : (
            <>
              <span>What the room sketches lands here for everyone, saved with the room. Circle, draw and pin comments on it together.</span>
              {onAsk ? <><span class="fine">Ask {agentName} about the system and it can sketch it here; structural changes wait for someone to accept them.</span><button class="mini ask" type="button" onClick={() => onAsk({ components: [], selected: [], circled: [], names: [] })}>Ask {agentName}</button></> : null}
            </>
          )}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** A canvas UI store for surfaces that keep their own (Journey's rooms, the harness). */
export const makeCanvasUi = () => new Store<CanvasUiState>(initialCanvasUi());
