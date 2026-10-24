import { Store } from '../../shared/store.js';
import type { RoomSources, QuestionState, WorkEvents } from './data/sources.js';
import { inside, parse, plain, STAGE_W, toD } from './geometry.js';
import type {
  AgentState, AgentTarget, Chime, Decision, Note, NoteKind, PartDef, PersonId, Point, Rect, Tool, ViewDef, ViewId, Word,
} from './types.js';

// The room's behaviour, ported from the prototype's component (Main.dc.html): gestures, the camera,
// the scripted voices, notes, the decision and its handoff. Components read `store.state` through
// model.ts and call these methods; nothing here touches the DOM except the surface it is handed.

export interface Cam { x: number; y: number; z: number }
export interface Line { who: PersonId; words: Word[]; n: number }
export interface Spoken { who: PersonId; words: Word[]; cut: boolean }
export interface Circle { d: string; items: { short: string; id: string }[]; x: number; y: number; asked: boolean }
export type Scenario = 'live' | 'returning';
type Offer = 'none' | 'pin' | 'done' | 'dropped';

export interface RoomState {
  side: boolean; desk: boolean; view: ViewId | null; prev: ViewId | null; sel: string[]; hover: string | null; tool: Tool;
  cams: Partial<Record<ViewId, Cam>>; dragging: boolean; lasso: Point[]; stroke: Point[];
  marquee: { x: number; y: number; w: number; h: number } | null; circle: Circle | null;
  ink: Partial<Record<ViewId, string[]>>; pins: Partial<Record<ViewId, { x: number; y: number }[]>>;
  built: boolean; kept: boolean; receipt: boolean; offer: boolean; concAside: 'pin' | 'dropped';
  line: Line | null; last: Spoken | null; liveRef: string | null; agent: AgentState; holdNext: boolean; chime: Chime; partOpen: boolean;
  cc: boolean; muted: boolean; talking: boolean;
  asideOpen: string | null; srikar: 'absent' | 'invited' | 'present'; srikarAside: Offer; offerCatch: boolean; toast: string | null;
  notes: Note[]; capFor: string | null;
  dec: Decision; decOpen: boolean; decMode: 'card' | 'handoff'; target: AgentTarget; handed: boolean; handedTo: string;
  p: number; question: QuestionState; qAnswer: string;
  filesOpen: boolean; brief: boolean; sw: number; sh: number;
  composed: boolean; keptT: boolean; receiptT: boolean; uiComposed: boolean; keptU: boolean; receiptU: boolean; uiAside: Offer;
  composing: number; recipeOpen: boolean; cursorFresh: boolean; timeoutAside: Offer;
}

export interface LaidOut { id: string; n: PartDef; shown: boolean; x: number; y: number; w: number; h: number }

type Drag =
  | { mode: 'pan'; sx: number; sy: number; cam: Cam; s: number }
  | { mode: 'circle'; pts: Point[] }
  | { mode: 'draw'; pts: Point[] }
  | { mode: 'comment'; p: Point }
  | { mode: 'marquee'; a: Point; b: Point; moved: boolean };

export interface RoomOptions {
  scenario: Scenario;
  startView?: ViewId;
}

export class RoomController {
  readonly store: Store<RoomState>;
  /** The camera offset that centres the current view; model.ts sets it each render. */
  ox = 0;
  oy = 0;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private iv: ReturnType<typeof setInterval> | undefined;
  private micT: ReturnType<typeof setTimeout> | undefined;
  private micPressed = false;
  private micHeld = false;
  private lid = 0;
  private nid = 0;
  private drag: Drag | null = null;
  private raf = 0;
  private surf: HTMLElement | null = null;
  private ro: ResizeObserver | null = null;
  private disposed = false;
  /** You are in the call. Outside it, nothing new is said aloud; it waits pinned on the canvas. */
  private present = true;
  private readonly workEvents: WorkEvents;

  constructor(readonly sources: RoomSources, readonly options: RoomOptions) {
    const { intent } = sources;
    const state: RoomState = {
      side: false, desk: true, view: null, prev: null, sel: [], hover: null, tool: 'select',
      cams: {}, dragging: false, lasso: [], stroke: [], marquee: null, circle: null, ink: {}, pins: {},
      built: false, kept: false, receipt: false, offer: false, concAside: 'pin',
      line: null, last: null, liveRef: null, agent: 'listening', holdNext: false, chime: 'pauses', partOpen: false,
      cc: false, muted: true, talking: false,
      asideOpen: null, srikar: 'absent', srikarAside: 'pin', offerCatch: false, toast: null,
      notes: intent.notes(), capFor: null,
      dec: intent.decision(),
      decOpen: false, decMode: 'card', target: 'claude', handed: false, handedTo: '', p: 0, question: 'none', qAnswer: '',
      filesOpen: false, brief: false, sw: 0, sh: 0,
      composed: false, keptT: false, receiptT: false, uiComposed: false, keptU: false, receiptU: false, uiAside: 'pin',
      composing: 0, recipeOpen: false, cursorFresh: true, timeoutAside: 'none',
    };
    if (options.scenario === 'returning') {
      // Back a few hours later: v3 signed by both and handed to Claude Code, which has one question.
      const base = state.dec.verify, check = intent.suggestedCheck();
      Object.assign(state, {
        handed: true, handedTo: 'Claude Code', built: true, kept: true, p: 3, question: 'open', brief: true, srikarAside: 'dropped', concAside: 'dropped',
        dec: { v: 3, verify: base + '; ' + check, base, sig: { john: 3, daniel: 3 }, amending: false, draft: '', reviewing: false, history: [{ v: 2, verify: base, by: 'John' }] },
      });
    }
    this.store = new Store(state);
    this.workEvents = {
      progress: (stage) => { if (!this.disposed && this.state.p < stage) this.setState({ p: stage }); },
      question: () => { if (!this.disposed) this.raiseQuestion(); },
    };
    this.later(() => this.setState({ cursorFresh: false }), 3200);
  }

  get state() { return this.store.state; }
  setState(patch: Partial<RoomState>) { if (!this.disposed) this.store.setState(patch); }

  /** Watches the canvas size, so each view can be fitted to the free space. */
  observe(el: HTMLElement) {
    this.ro?.disconnect();
    this.ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect, s = this.state;
      if (Math.abs(r.width - s.sw) > 1 || Math.abs(r.height - s.sh) > 1) this.setState({ sw: r.width, sh: r.height });
    });
    this.ro.observe(el);
  }

  dispose() {
    this.ro?.disconnect();
    clearInterval(this.iv);
    clearTimeout(this.micT);
    cancelAnimationFrame(this.raf);
    this.timers.forEach(clearTimeout);
    this.disposed = true;
  }

  private later(fn: () => void, ms: number) { this.timers.push(setTimeout(fn, ms)); }
  curView(): ViewId { return this.state.view || this.options.startView || 'failure'; }
  viewDef(v: ViewId = this.curView()): ViewDef { return this.sources.canvas.view(v)!; }
  cam(v: ViewId = this.curView()): Cam { return this.state.cams[v] || { x: 0, y: 0, z: 1 }; }
  setCam(c: Cam) { this.setState({ cams: { ...this.state.cams, [this.curView()]: c } }); }

  layout(view: ViewId): LaidOut[] {
    const L = this.sources.canvas.view(view)?.layout || {};
    const failure = this.viewDef('failure').layout, arch = this.viewDef('arch').layout;
    return this.sources.canvas.parts().map((n) => {
      const shown = !!L[n.id];
      const p: Rect = L[n.id] || n.hide || failure[n.id] || arch[n.id] || [0, 0, 200, 146];
      return { id: n.id, n, shown, x: p[0], y: p[1], w: p[2], h: p[3] };
    });
  }

  private targets(view: ViewId) {
    const t = this.layout(view).filter((n) => n.shown).map((n) => ({ id: n.id, short: n.n.short, x: n.x, y: n.y, w: n.w, h: n.h }));
    this.sources.canvas.steps().forEach((s) => { if (s.v === view) t.push({ id: s.id, short: s.short, x: s.x, y: s.y, w: 220, h: 48 }); });
    return t;
  }

  private scale() { const el = this.surf!; return (el.getBoundingClientRect().width / el.offsetWidth) || 1; }
  private toStage(e: PointerEvent): Point {
    const r = this.surf!.querySelector('.stage')!.getBoundingClientRect(), k = r.width / STAGE_W;
    return [(e.clientX - r.left) / k, (e.clientY - r.top) / k];
  }
  private frame(fn: () => void) { cancelAnimationFrame(this.raf); this.raf = requestAnimationFrame(fn); }

  /* ---------- Gestures. ---------- */
  down(e: PointerEvent) {
    if (e.button !== 0) return;
    const t = e.target as Element | null;
    if (t?.closest?.('button, input, label, a, .ctx, .lasso-ask, .receipt, .aside, .npop, .decov, .call, .captions')) return;
    this.surf = e.currentTarget as HTMLElement;
    const tool = this.state.tool, p = this.toStage(e);
    try { this.surf.setPointerCapture(e.pointerId); } catch { /* the pointer may already be gone */ }
    if (tool === 'pan') { this.drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, cam: this.cam(), s: this.scale() }; this.setState({ dragging: true }); }
    else if (tool === 'circle') { this.drag = { mode: 'circle', pts: [p] }; this.setState({ lasso: [p], circle: null }); }
    else if (tool === 'draw') { this.drag = { mode: 'draw', pts: [p] }; this.setState({ stroke: [p] }); }
    else if (tool === 'comment') { this.drag = { mode: 'comment', p }; }
    else { this.drag = { mode: 'marquee', a: p, b: p, moved: false }; }
  }

  move(e: PointerEvent) {
    const d = this.drag;
    if (!d) return;
    if (d.mode === 'pan') {
      const dx = (e.clientX - d.sx) / d.s, dy = (e.clientY - d.sy) / d.s;
      this.frame(() => this.setCam({ x: d.cam.x + dx, y: d.cam.y + dy, z: d.cam.z }));
      return;
    }
    const p = this.toStage(e);
    if (d.mode === 'circle' || d.mode === 'draw') {
      const last = d.pts[d.pts.length - 1];
      if (Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1]) < 3) return;
      d.pts.push(p);
      this.frame(() => this.setState(d.mode === 'circle' ? { lasso: d.pts.slice() } : { stroke: d.pts.slice() }));
    } else if (d.mode === 'marquee') {
      d.b = p;
      if (Math.abs(p[0] - d.a[0]) + Math.abs(p[1] - d.a[1]) > 5) d.moved = true;
      if (d.moved) this.frame(() => this.setState({ marquee: { x: Math.min(d.a[0], d.b[0]), y: Math.min(d.a[1], d.b[1]), w: Math.abs(d.b[0] - d.a[0]), h: Math.abs(d.b[1] - d.a[1]) } }));
    }
  }

  up() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    cancelAnimationFrame(this.raf);
    const view = this.curView();
    if (d.mode === 'pan') { this.setState({ dragging: false }); return; }
    if (d.mode === 'circle') {
      if (d.pts.length < 6) { this.setState({ lasso: [] }); return; }
      const hits = this.targets(view).filter((t) => inside([t.x + t.w / 2, t.y + t.h / 2], d.pts));
      const xs = d.pts.map((p) => p[0]), ys = d.pts.map((p) => p[1]);
      this.setState({ lasso: [], sel: [], asideOpen: null, circle: { d: toD(d.pts, true), items: hits.map((h) => ({ short: h.short, id: h.id })), x: Math.max(...xs) + 12, y: Math.min(...ys), asked: false } });
      return;
    }
    if (d.mode === 'draw') { this.setState({ ink: { ...this.state.ink, [view]: (this.state.ink[view] || []).concat([toD(d.pts, false)]) }, stroke: [] }); return; }
    if (d.mode === 'comment') { this.setState({ pins: { ...this.state.pins, [view]: (this.state.pins[view] || []).concat([{ x: d.p[0] - 10, y: d.p[1] - 20 }]) } }); return; }
    if (!d.moved) { this.setState({ sel: [], circle: null, marquee: null, asideOpen: null, capFor: null }); return; }
    const m = { x0: Math.min(d.a[0], d.b[0]), y0: Math.min(d.a[1], d.b[1]), x1: Math.max(d.a[0], d.b[0]), y1: Math.max(d.a[1], d.b[1]) };
    const picked = this.layout(view).filter((n) => n.shown && n.x < m.x1 && n.x + n.w > m.x0 && n.y < m.y1 && n.y + n.h > m.y0).map((n) => n.id);
    this.setState({ sel: picked, marquee: null, circle: null, asideOpen: null });
  }

  wheel(e: WheelEvent) {
    const el = e.currentTarget as HTMLElement, r = el.getBoundingClientRect(), k = (r.width / el.offsetWidth) || 1;
    const cam = this.cam(), W = el.offsetWidth, H = el.offsetHeight, ox = this.ox, oy = this.oy;
    if (e.ctrlKey || e.metaKey) {
      const mx = (e.clientX - r.left) / k, my = (e.clientY - r.top) / k;
      const z2 = Math.max(0.35, Math.min(2.5, cam.z * Math.exp(-e.deltaY * 0.01))), ratio = z2 / cam.z;
      this.setCam({ x: mx - W / 2 - (mx - W / 2 - (cam.x + ox)) * ratio - ox, y: my - H / 2 - (my - H / 2 - (cam.y + oy)) * ratio - oy, z: z2 });
    } else {
      this.setCam({ x: cam.x - e.deltaX / k, y: cam.y - e.deltaY / k, z: cam.z });
    }
    if (e.cancelable) e.preventDefault();
  }

  zoomBy(f: number) {
    const cam = this.cam(), z2 = Math.max(0.35, Math.min(2.5, cam.z * f)), ratio = z2 / cam.z;
    this.setCam({ x: cam.x * ratio, y: cam.y * ratio, z: z2 });
  }

  /** The views in tab order, for the 1–7 keys. */
  viewOrder(): ViewId[] {
    const s = this.state;
    return (['arch', 'failure', 'alternatives'] as ViewId[]).concat(s.built ? ['concurrency'] : [], s.handed ? ['impl'] : [], s.composed ? ['timeout'] : [], s.uiComposed ? ['ui'] : []);
  }

  key(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null, s = this.state, view = this.curView();
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key, tools: Record<string, Tool> = { v: 'select', h: 'pan', o: 'circle', p: 'draw', c: 'comment' };
    if (tools[k]) { this.setState({ tool: tools[k] }); e.preventDefault(); return; }
    if (k === '[') { this.setState({ side: !s.side }); e.preventDefault(); return; }
    if (k === ']') { this.setState({ desk: !s.desk }); e.preventDefault(); return; }
    const order = this.viewOrder(), n = parseInt(k, 10);
    if (n >= 1 && n <= order.length && order[n - 1] !== view) { this.go(order[n - 1]); e.preventDefault(); return; }
    if (k === '+' || k === '=') { this.zoomBy(1.25); e.preventDefault(); return; }
    if (k === '-') { this.zoomBy(0.8); e.preventDefault(); return; }
    if (k === '0') { this.setCam({ x: 0, y: 0, z: 1 }); e.preventDefault(); return; }
    if (k === 'Escape') this.setState({ sel: [], circle: null, partOpen: false, asideOpen: null, capFor: null, decOpen: false, marquee: null });
  }

  go(v: ViewId, extra?: Partial<RoomState>) {
    const view = this.curView(), s = this.state;
    if (v === view) { if (extra) this.setState(extra); return; }
    this.setState({
      view: v, prev: view, sel: [], circle: null, asideOpen: null, capFor: null, cursorFresh: true, recipeOpen: false,
      receipt: s.receipt && v === 'concurrency', receiptT: s.receiptT && v === 'timeout', receiptU: s.receiptU && v === 'ui', ...extra,
    });
    this.later(() => this.setState({ cursorFresh: false }), 3200);
  }

  /** Go to wherever a part can be seen, and point at it. */
  goTo(id: string, extra?: Partial<RoomState>) {
    const view = this.curView(), s = this.state;
    const order: ViewId[] = [view, 'failure', 'arch', 'impl', 'concurrency', 'alternatives'];
    const target = order.filter((v) => this.sources.canvas.view(v)?.layout[id] && (v !== 'concurrency' || s.built) && (v !== 'impl' || s.handed))[0] || view;
    this.go(target, { sel: [id], ...extra });
  }

  /* ---------- Voices. One at a time; a word that names a part points at it. ---------- */
  speak(who: PersonId, str: string, then?: () => void) {
    clearInterval(this.iv);
    const id = ++this.lid, words = parse(str);
    this.setState({ line: { who, words, n: 0 }, liveRef: null, partOpen: false, agent: who === 'vowe' ? 'speaking' : (this.state.holdNext ? 'holding' : 'listening') });
    this.iv = setInterval(() => {
      const L = this.state.line;
      if (!L || this.lid !== id || this.disposed) { clearInterval(this.iv); return; }
      const n = L.n + 1, w = L.words[n - 1], patch: Partial<RoomState> = { line: { who: L.who, words: L.words, n } };
      if (w && w.ref) patch.liveRef = w.ref;
      this.setState(patch);
      if (n >= L.words.length) {
        clearInterval(this.iv);
        this.later(() => {
          if (this.lid !== id) return;
          this.setState({ line: null, last: { who, words: L.words, cut: false }, liveRef: null, agent: this.state.holdNext ? 'holding' : 'listening' });
          then?.();
        }, 1100);
      }
    }, who === 'vowe' ? 210 : 180);
  }

  private think(then: () => void) {
    const id = ++this.lid;
    this.setState({ agent: 'thinking' });
    this.later(() => { if (this.lid === id) then(); }, 750);
  }

  /** You talked over Vowe: it stops mid-word and listens. */
  private interrupt() {
    const L = this.state.line;
    if (!L || L.who !== 'vowe') return;
    clearInterval(this.iv);
    this.lid++;
    this.setState({ line: null, last: { who: 'vowe', words: L.words.slice(0, L.n), cut: true }, liveRef: null, agent: 'listening' });
    this.speak('daniel', 'Right — and I’m mostly worried about two workers running at once.', () => {
      this.think(() => {
        if (this.state.built) this.speak('vowe', 'Then [the Concurrency view|workerB] is the one to keep open.');
        else this.speak('vowe', 'Then it’s worth seeing [two workers|worker] on one job. I’ve pinned that on the worker.', () => this.setState({ offer: true, concAside: 'pin' }));
      });
    });
  }

  converse(items: { short: string; id: string }[]) {
    if (!items.length) items = [{ short: 'this part of the canvas', id: '' }];
    if (items.length === 1 && items[0].id === 'provider' && !this.state.composed) {
      this.speak('daniel', 'What happens to {this|provider} when it fails?', () => {
        this.think(() => this.speak('vowe', 'The hard case is a timeout: the charge may have landed and nobody can tell. Let me draw it.', () => this.compose()));
      });
      return;
    }
    const single = items.length === 1;
    const label = single ? items[0].short.replace(/^the /, '') : items.length + ' parts';
    const refs = items.map((i) => i.id ? '[' + i.short + '|' + i.id + ']' : i.short);
    const refList = refs.length <= 1 ? refs[0] : refs.slice(0, -1).join(', ') + ' and ' + refs[refs.length - 1];
    const mine = single ? 'What happens to {this|' + label + '} when something fails?' : 'Why do we need all of {this|' + label + '}?';
    const reply = single ? 'Looking at ' + refList + ' — do you mean what happens when it fails, or when it runs twice?' : 'Looking at ' + refList + ' — is it what passes between them, or how each behaves on a retry?';
    this.speak('daniel', mine, () => this.think(() => this.speak('vowe', reply)));
  }

  /* ---------- Views Vowe builds or composes mid-call; each is proposed until kept. ---------- */
  build() {
    const view = this.curView();
    this.setState({ built: true, kept: false, receipt: true, offer: false, view: 'concurrency', prev: view, sel: [], circle: null, asideOpen: null, last: null });
    this.later(() => this.speak('vowe', 'Here are [two workers|workerB] holding the same job. Both reach [the provider|provider], so the card is charged twice.'), 700);
  }

  compose() {
    const view = this.curView();
    this.sources.canvas.compose('timeout', 'failure');
    this.setState({ composed: true, keptT: false, receiptT: true, composing: 0, recipeOpen: true, timeoutAside: 'done', view: 'timeout', prev: view, sel: [], circle: null, asideOpen: null, last: null, cursorFresh: true });
    [1, 2, 3, 4].forEach((k) => this.later(() => this.setState({ composing: k }), 250 + k * 420));
    this.later(() => this.setState({ cursorFresh: false }), 4000);
    this.later(() => { if (this.curView() === 'timeout') this.setState({ recipeOpen: false }); }, 4400);
    this.later(() => this.speak('vowe', 'I drew it as a sequence. [The worker|worker] times out without knowing the charge landed, [the queue|queue] retries with the same key, and [the provider|provider] hands back the first result.'), 2100);
  }

  composeUI() {
    const view = this.curView();
    this.sources.canvas.compose('ui', this.state.composed ? 'timeout' : 'arch');
    this.setState({ uiComposed: true, keptU: false, receiptU: true, composing: 0, recipeOpen: true, uiAside: 'done', view: 'ui', prev: view, sel: [], circle: null, asideOpen: null, last: null, cursorFresh: true });
    [1, 2, 3, 4, 5].forEach((k) => this.later(() => this.setState({ composing: k }), 250 + k * 380));
    this.later(() => { if (this.curView() === 'ui') this.setState({ recipeOpen: false }); }, 4600);
    this.later(() => this.speak('vowe', 'Today a pending payment drops straight to [Failed|scrFailed]. I added a [Confirming|scrConfirm] state, dashed because nobody has agreed to it, and [the change|diff] that would make it.'), 2300);
  }

  /** Undo a proposed view: its tab goes, and the room returns to where it was. */
  undoView(which: 'concurrency' | 'timeout' | 'ui') {
    const s = this.state, back = s.prev && s.prev !== which ? s.prev : 'failure';
    const off = which === 'concurrency' ? { built: false, receipt: false } : which === 'timeout' ? { composed: false, receiptT: false, recipeOpen: false } : { uiComposed: false, receiptU: false, recipeOpen: false };
    this.setState({ ...off, view: back, prev: null, sel: [], last: null });
  }

  keepView(which: 'concurrency' | 'timeout' | 'ui') {
    this.setState(which === 'concurrency' ? { kept: true, receipt: false } : which === 'timeout' ? { keptT: true, receiptT: false } : { keptU: true, receiptU: false });
  }

  /* ---------- People. ---------- */
  askSrikar() {
    this.setState({ srikar: 'invited', srikarAside: 'done', asideOpen: 'inv' });
    this.sources.room.invite('srikar').then(() => {
      if (this.disposed) return;
      this.setState({ srikar: 'present', asideOpen: null, toast: 'Srikar joined', holdNext: true });
      this.later(() => this.setState({ toast: null }), 2400);
      if (!this.present) { this.setState({ holdNext: false, offerCatch: true }); return; }
      this.speak('daniel', '…so honestly the lease handling is the part I trust least.', () => {
        if (this.state.chime === 'pauses') this.later(() => this.catchUp(), 400);
        else this.setState({ holdNext: false, agent: 'listening', offerCatch: true });
      });
    });
  }

  catchUp() {
    this.setState({ holdNext: false, offerCatch: false, asideOpen: null });
    this.speak('vowe', 'Srikar, a quick catch-up. We’re on retries in [the payment worker|worker]. If it crashes [after the charge|s3], [the queue|queue] hands the job out again. We’re leaning toward [idempotent processing|decision]; still open is how a lost ack gets noticed.');
  }

  /* ---------- Notes and the decision. ---------- */
  capture(kind: NoteKind, partId: string) {
    const s = this.state, last = s.last || { who: 'vowe' as PersonId, words: [] };
    const text = plain(last.words).replace(/^…/, '') || 'Note';
    const item: Note = { id: 'c' + (++this.nid), kind, text, who: last.who, on: partId, fresh: true };
    this.setState({ notes: s.notes.map((n) => n.fresh ? { ...n, fresh: false } : n).concat([item]), capFor: null });
  }

  keepNote(id: string) { this.setState({ notes: this.state.notes.map((x) => x.id === id ? { ...x, suggested: false } : x) }); }
  dropNote(id: string) { this.setState({ notes: this.state.notes.filter((x) => x.id !== id) }); }

  setDec(patch: Partial<Decision>) { this.setState({ dec: { ...this.state.dec, ...patch } }); }

  signDec() {
    const d = this.state.dec, sig = { john: d.sig.john, daniel: d.v };
    this.setDec({ sig, reviewing: sig.john !== d.v });
    // John reads the new version and signs it a moment later.
    if (sig.john !== d.v) this.later(() => {
      const cur = this.state.dec;
      if (cur.v !== d.v) return;
      this.setDec({ sig: { john: cur.v, daniel: cur.sig.daniel }, reviewing: false });
    }, 2600);
  }

  proposeNext() {
    const d = this.state.dec, next = (d.draft || '').trim();
    if (!next || next === d.verify) { this.setDec({ amending: false }); return; }
    const by = [d.sig.john === d.v ? 'John' : null, d.sig.daniel === d.v ? 'Daniel' : null].filter(Boolean).join(', ') || 'no one';
    this.setDec({ v: d.v + 1, base: d.verify, verify: next, amending: false, reviewing: false, sig: { john: d.sig.john, daniel: 0 }, history: [{ v: d.v, verify: d.verify, by }].concat(d.history) });
    this.later(() => this.speak('vowe', 'Drafted v' + (d.v + 1) + ': [the checks|decision] now cover a provider timeout. John’s v' + d.v + ' signature doesn’t carry over.', () => {
      if (!this.state.composed) this.setState({ timeoutAside: 'pin' });
    }), 300);
  }

  sendHandoff() {
    const s = this.state, name = s.target === 'codex' ? 'Codex' : 'Claude Code';
    this.setState({ handed: true, handedTo: name, decMode: 'card', p: 0, question: 'none' });
    this.sources.work.handoff(s.dec, s.target, this.workEvents);
  }

  private raiseQuestion() {
    if (this.state.question !== 'none') return;
    this.setState({ question: 'open' });
    if (this.state.line || this.state.chime === 'asked' || !this.present) return;
    this.speak('vowe', this.state.handedTo + ' has a question about [the provider|provider]. I’ve pinned it there.');
  }

  answer(text: string) {
    this.setState({ question: 'answered', qAnswer: text, asideOpen: null });
    if (this.state.p < 4) this.sources.work.answer(text, this.workEvents);
  }

  /* ---------- The call. ---------- */
  toggleCc() {
    const cc = !this.state.cc;
    this.setState({ cc });
    this.sources.call.setCaptions(cc);
  }

  /** The mic: click to mute; hold to talk over Vowe (stands in for your voice). */
  micDown() {
    this.micPressed = true;
    this.micHeld = false;
    clearTimeout(this.micT);
    this.micT = setTimeout(() => {
      this.micHeld = true;
      this.setState({ talking: true, muted: false });
      if (this.state.line?.who === 'vowe') this.interrupt();
    }, 260);
  }

  micUp() {
    if (!this.micPressed) return;
    this.micPressed = false;
    clearTimeout(this.micT);
    if (this.micHeld) { this.micHeld = false; this.setState({ talking: false }); return; }
    const muted = !this.state.muted;
    this.setState({ muted });
    this.sources.call.setMuted(muted);
  }

  /**
   * You left the call; the room and its canvas stay as they are for when you come back. Voices stop
   * mid-word (nobody hears them now) and open popovers close; handed-off work keeps going.
   */
  suspend() {
    this.present = false;
    clearInterval(this.iv);
    clearTimeout(this.micT);
    this.lid++;
    this.micPressed = this.micHeld = false;
    const s = this.state, L = s.line;
    this.setState({
      line: null, last: L ? { who: L.who, words: L.words.slice(0, L.n), cut: true } : s.last, liveRef: null,
      agent: 'listening', holdNext: false, talking: false, muted: true, partOpen: false, sel: [], circle: null, capFor: null, marquee: null,
    });
  }

  /** Back in the call, muted, with the canvas where it was left. */
  resume() { this.present = true; }
}
