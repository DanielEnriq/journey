import type { PartState } from './data/sources.js';
import type { RoomController } from './controller.js';
import { plain, STAGE_H, STAGE_W, toD, upperFirst } from './geometry.js';
import type { NoteKind, PartDef, ViewId, Word } from './types.js';

// What the room shows for its current state: a port of the prototype's renderVals(). Pure apart from
// handing the camera offset back to the controller, which gestures need.

export const KIND_LABEL: Record<NoteKind, string> = { note: 'Note', concern: 'Concern', avoid: 'Avoid', constraint: 'Constraint', question: 'Open question', goal: 'Goal' };
export const CAPTURE_KINDS: NoteKind[] = ['concern', 'question', 'constraint'];
export const VIEW_TABS: ViewId[] = ['arch', 'failure', 'alternatives', 'concurrency', 'ui', 'timeout', 'impl'];
const AGENT_LABEL = { listening: 'Listening', holding: 'Waiting for a pause', thinking: 'Thinking', speaking: 'Speaking' };

export interface AsideAct { label: string; cls: string; go(): void }
export interface Aside { id: string; on: string; from: string; text: string; acts: AsideAct[]; needs?: boolean }

export interface NoteView {
  id: string; kind: string; text: string; who: string; initials: string; avCls: string; cls: string;
  linked: boolean; suggested: boolean; fresh: boolean;
}

export interface NodeView extends PartState {
  id: string; part: PartDef; x: number; y: number; w: number; h: number; sel: boolean; delay: number;
  wrapCls: string; cls: string; peerTab: boolean; meTab: boolean;
  ev: { tone: string; text: string } | null;
  notes: NoteView[]; aside: Aside | null; asideOpen: boolean; asideCls: string; popOpen: boolean; popCls: string; capOpen: boolean;
}

export interface Stamp { cls: string; text: string }

export function deriveRoom(ctrl: RoomController) {
  const s = ctrl.state, { canvas, room, intent, work } = ctrl.sources;
  const view = ctrl.curView(), def = ctrl.viewDef(view), cam = ctrl.cam(view), lay = ctrl.layout(view), d = s.dec;
  const people = room.people();
  const approved = d.sig.john === d.v && d.sig.daniel === d.v;
  // Vowe's focus: what its words point at, or the crash step while nobody is talking.
  const agentRef = s.liveRef ? s.liveRef : (s.line || s.last ? null : (view === 'failure' ? 's3' : null));
  const focusId = s.sel.length === 1 ? s.sel[0] : null;
  const neigh = def.neighbours;
  const glance = focusId && !s.asideOpen && neigh && neigh[focusId] ? [focusId].concat(neigh[focusId]) : null;
  const qOpen = s.handed && s.question === 'open';
  const close = (patch: object) => () => ctrl.setState({ ...patch, asideOpen: null });

  /* Vowe's asides, each pinned to the part it is about. */
  const asides: Aside[] = [];
  if (!s.built && s.concAside !== 'dropped') asides.push({
    id: 'conc', on: 'worker', from: s.offer ? 'Vowe' : 'From John’s question',
    text: s.offer ? 'Want me to build a view of two workers on the same job?' : 'John asked what happens when two workers take the same job. I can show it.',
    acts: [{ label: 'Show it', cls: 'mini ask', go: () => ctrl.build() }, { label: 'Not now', cls: 'mini ghost', go: close({ concAside: 'dropped', offer: false }) }],
  });
  if (s.uiAside === 'pin' && !s.uiComposed) asides.push({
    id: 'ui', on: s.composed ? 'worker' : 'api', from: 'Vowe',
    text: s.composed ? 'While the worker waits those 10s, checkout says “Payment failed”. Want to see what the customer sees?' : 'Checkout says “Payment failed” while a retry is still running. Want to see what the customer sees?',
    acts: [{ label: 'Show it', cls: 'mini ask', go: () => ctrl.composeUI() }, { label: 'Not now', cls: 'mini ghost', go: close({ uiAside: 'dropped' }) }],
  });
  if (s.timeoutAside === 'pin' && !s.composed) asides.push({
    id: 'tmo', on: 'provider', from: 'Vowe', text: 'Want to see what a timeout mid-charge looks like before you sign v' + d.v + '?',
    acts: [{ label: 'Show it', cls: 'mini ask', go: () => ctrl.compose() }, { label: 'Not now', cls: 'mini ghost', go: close({ timeoutAside: 'dropped' }) }],
  });
  if (s.srikar === 'absent' && s.srikarAside !== 'dropped') asides.push({
    id: 'srikar', on: 'queue', from: 'Vowe', text: 'Srikar wrote the lease handling on this queue. Ask him to join?',
    acts: [{ label: 'Ask Srikar', cls: 'mini ask', go: () => ctrl.askSrikar() }, { label: 'Not now', cls: 'mini ghost', go: close({ srikarAside: 'dropped' }) }],
  });
  if (s.srikar === 'invited') asides.push({ id: 'inv', on: 'queue', from: 'Vowe', text: 'Asked Srikar. He’ll see it when he has a moment.', acts: [] });
  if (s.offerCatch) asides.push({ id: 'catch', on: 'queue', from: 'Vowe', text: 'Srikar just joined. Catch him up?', acts: [{ label: 'Catch him up', cls: 'mini ask', go: () => ctrl.catchUp() }] });
  if (qOpen) asides.push({
    id: 'q', on: 'provider', needs: true, from: s.handedTo + ' is asking',
    text: 'The provider won’t take an idempotency key on refunds. Leave refunds out of this change, or check the ledger first?',
    acts: [
      { label: 'Leave refunds out', cls: 'mini strong', go: () => ctrl.answer('leave refunds out of this change.') },
      { label: 'Check the ledger', cls: 'mini', go: () => ctrl.answer('check the ledger before any refund.') },
      { label: 'Talk it through', cls: 'mini ask', go: () => { ctrl.setState({ asideOpen: null }); ctrl.speak('vowe', '[The provider|provider] takes keys on charges but not refunds. The decision only covers charges, so refunds could stay out, or [the ledger|ledger] could guard them.'); } },
    ],
  });
  const asideOn: Record<string, Aside> = {};
  asides.forEach((a) => { if (!asideOn[a.on]) asideOn[a.on] = a; });

  const notesOn: Record<string, typeof s.notes> = {};
  s.notes.forEach((n) => { if (n.on) (notesOn[n.on] = notesOn[n.on] || []).push(n); });
  const peerSel = def.peerSelection;
  let selBox: { x: number; y: number } | null = null;
  const single = s.sel.length === 1 ? s.sel[0] : null;

  const nodes: NodeView[] = lay.map((l) => {
    const n = l.n, id = l.id, sm = canvas.describe(n, view, { progress: s.p, question: s.question });
    const sel = l.shown && s.sel.includes(id), peer = l.shown && peerSel === id;
    if (sel) selBox = selBox ? { x: Math.min(selBox.x, l.x), y: Math.min(selBox.y, l.y) } : { x: l.x, y: l.y };
    const a = asideOn[id] || null, open = !!a && s.asideOpen === a.id && l.shown;
    const list = notesOn[id] || [];
    const popOpen = l.shown && (single === id || s.capFor === id) && !open;
    const flip = l.x + l.w + 270 > STAGE_W;
    // In Implementation, every part says what the coding agent has done to it, and how sure we are.
    const evm: Record<string, [string, string]> | null = view === 'impl' ? {
      api: ['quiet', 'unchanged'], queue: ['quiet', 'unchanged'],
      worker: s.p >= 3 ? ['verified', 'changed · tested'] : s.p >= 2 ? ['changed', 'changed, not tested'] : ['quiet', 'not started'],
      provider: qOpen ? ['needs', 'question · refunds'] : ['assumed', 'assumed, not checked'],
      ledger: s.p >= 2 ? ['changed', 'changed · migration 0042'] : ['quiet', 'not started'],
    } : null;
    const ev = evm && evm[id] && l.shown ? { tone: 'evt ' + evm[id][0], text: evm[id][1] } : null;
    const delay = view === 'concurrency' && !s.kept ? (id === 'workerB' ? 140 : id === 'provider' ? 80 : 0)
      : view === 'timeout' && !s.keptT ? (({ queue: 0, worker: 180, provider: 360 } as Record<string, number>)[id] || 0)
      : view === 'ui' && !s.keptU ? (({ scrPay: 0, scrConfirm: 160, scrPaid: 320, scrFailed: 400, diff: 600 } as Record<string, number>)[id] || 0) : 0;
    return {
      ...sm, id, part: n, x: l.x, y: l.y, w: l.w, h: l.h, sel, delay,
      wrapCls: 'node' + (l.shown ? '' : ' gone') + (glance && !glance.includes(id) ? ' far' : '') + (open || popOpen ? ' raised' : ''),
      cls: 'part kind-' + n.kind + (n.proposed ? ' proposed' : '') + (sel ? ' sel' : '') + (peer ? ' peer' : '') + (l.shown && agentRef === id ? ' agent' : ''),
      peerTab: peer && !sel, meTab: sel && peer && s.sel.length === 1, ev,
      notes: l.shown ? list.map((nt) => {
        const who = people[nt.who];
        return {
          id: nt.id, kind: upperFirst((nt.suggested ? 'Suggested ' : '') + KIND_LABEL[nt.kind].toLowerCase()),
          text: nt.text, who: nt.suggested ? 'Vowe suggests' : who.full, initials: who.initials, avCls: who.av,
          cls: 'note' + (nt.suggested ? ' suggested' : '') + (nt.fresh ? ' fresh' : ''),
          linked: !!nt.linked, suggested: !!nt.suggested, fresh: !!nt.fresh,
        };
      }) : [],
      aside: a && l.shown ? a : null, asideOpen: open, asideCls: 'aside' + (flip ? ' flip' : '') + (a && a.needs ? ' needs' : ''),
      popOpen, popCls: 'npop' + (flip ? ' flip' : ''), capOpen: s.capFor === id,
    };
  });

  const stepIdx: Record<string, number> = {};
  const steps = canvas.steps().map((t) => {
    const on = t.v === view, k = stepIdx[t.v] = (stepIdx[t.v] || 0) + 1;
    const f = on && agentRef === t.id, fresh = t.v === 'timeout' && !s.keptT;
    return { key: t.id, n: t.n, title: t.title, sub: t.sub, x: t.x, y: t.y, delay: on ? (fresh ? 1000 + k * 170 : 180 + k * 70) : 0, cls: 'step' + (t.tone ? ' ' + t.tone : '') + (f ? ' focus' : '') + (on ? '' : ' gone') };
  });
  const wires = canvas.wires().map((w) => { const on = w.v === view; return { x: w.x, y: w.y, w: w.w, h: w.h, delay: on ? (w.d || 0) : 0, cls: 'wire ' + w.c + (on ? '' : ' gone') + (on && glance ? ' faint' : '') }; });
  const wlabels = canvas.labels().map((l) => ({ t: l.t, x: l.x, y: l.y, cls: 'wlabel' + (l.v === view ? '' : ' gone') }));
  const bounds = canvas.bounds().map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h, label: b.label, cls: 'bound' + (b.v.includes(view) ? '' : ' gone') }));

  /* The decision's checks, as the coding agent's tests make them pass. */
  const vcases = d.verify.split(';').map((t) => t.trim()).filter(Boolean).map((t) => {
    const timeout = t.includes('timeout');
    const st = timeout ? (s.p >= 4 ? 'pass' : s.p >= 3 ? 'running' : 'none') : (s.p >= 3 ? 'pass' : s.p >= 2 ? 'written' : 'none');
    return { text: upperFirst(t), status: { pass: 'passes · worker.test.ts', running: 'running…', written: 'test written, not run', none: 'no test yet' }[st], cls: 'vc ' + st };
  });
  const passing = vcases.filter((c) => c.cls === 'vc pass').length;

  const selNamed = lay.filter((x) => x.shown && s.sel.includes(x.id));
  const circle = s.circle, inkList = s.ink[view] || [];
  const speaker = s.line ? s.line.who : null;
  const L = s.line, shownLine = L ? { who: L.who, words: L.words.slice(0, L.n), cut: false } : s.last;

  /* Fit the drawing to the free space: tool rail left, the call below. */
  const right = 16, bottom = 84, top = 52;
  const vb = def.viewBox || [STAGE_W, STAGE_H];
  const fit = s.sw ? Math.max(0.5, Math.min(1.1, (s.sw - 64 - right - 24) / (vb[0] + 20), (s.sh - top - bottom - 16) / (vb[1] + 10))) : 1;
  const z = cam.z * fit;
  const ox = (s.sw ? (64 - right) / 2 : 0) + (STAGE_W - vb[0]) / 2 * z, oy = (s.sw ? (top - bottom) / 2 : 0) + (STAGE_H - vb[1]) / 2 * z;
  ctrl.ox = ox;
  ctrl.oy = oy;

  /* Someone you can't see: their cursor waits on the edge, pointing at them. */
  const edgeCursors: { name: string; cls: string; x: number; y: number; a: number; go(): void }[] = [];
  if (s.sw) {
    const W = s.sw, H = s.sh, cxT = cam.x + ox, cyT = cam.y + oy;
    const peers = [{ name: 'John', cls: 'edge', at: def.cursor }].concat(s.srikar === 'present' ? [{ name: 'Srikar', cls: 'edge p2', at: def.cursor2 }] : []);
    peers.forEach((pr) => {
      const px = W / 2 + cxT + (pr.at[0] - STAGE_W / 2) * z, py = H / 2 + cyT + (pr.at[1] - STAGE_H / 2) * z;
      const L0 = 64, R0 = W - 16, T0 = 48, B0 = H - 84;
      if (px >= L0 && px <= R0 && py >= T0 && py <= B0) return;
      const ex = Math.max(L0 + 6, Math.min(R0 - 74, px)), ey = Math.max(T0 + 6, Math.min(B0 - 30, py));
      const ang = Math.atan2(py - (ey + 12), px - (ex + 40)) * 180 / Math.PI;
      edgeCursors.push({
        name: pr.name, cls: pr.cls, x: Math.round(ex), y: Math.round(ey), a: Math.round(ang),
        go: () => ctrl.setCam({ x: -ox - (pr.at[0] - STAGE_W / 2) * z, y: -oy - (pr.at[1] - STAGE_H / 2) * z, z: cam.z }),
      });
    });
  }

  const needsSign = !approved && !d.amending && d.sig.daniel !== d.v && !s.handed;
  const signalItems = (qOpen ? 1 : 0) + (needsSign ? 1 : 0);
  const johnStamp: Stamp = d.sig.john === d.v ? { cls: 'stamp ok', text: 'John · signed v' + d.v } : d.reviewing ? { cls: 'stamp wait', text: 'John · reviewing v' + d.v } : d.sig.john ? { cls: 'stamp stale', text: 'John · signed v' + d.sig.john } : { cls: 'stamp wait', text: 'John · not yet' };
  const youStamp: Stamp = d.sig.daniel === d.v ? { cls: 'stamp ok', text: 'You · signed v' + d.v } : { cls: 'stamp wait', text: 'You · not yet' };
  const statusLabel = s.handed ? 'with ' + s.handedTo : d.amending ? 'being amended' : approved ? 'agreed' : d.sig.daniel === d.v ? 'waiting on John' : 'waiting on you';
  const diffHas = !!d.base && d.verify.startsWith(d.base) && d.verify !== d.base;
  const openNotes = s.notes.filter((n) => n.on);
  const nodeName: Record<string, string> = {};
  canvas.parts().forEach((n) => { nodeName[n.id] = n.name; });
  const suggestion = intent.suggestedCheck();
  const stageLines = work.stages();

  /* How Vowe drew this view: rows appear one by one while a composed view is still being drawn. */
  const recipe = def.recipe;
  const recipeAnim = (view === 'timeout' && !s.keptT) || (view === 'ui' && !s.keptU);
  const recipeRows = [{ k: 'Asked', v: def.question }, { k: 'Arranged as', v: recipe.arrangement }]
    .concat(recipe.blocks.map((bk, i) => ({ k: i === 0 ? 'Blocks' : '', v: bk })))
    .concat([{ k: 'Data', v: def.provenance }])
    .map((row, i) => ({ ...row, cls: 'rrow2' + (recipeAnim && i > s.composing + 1 ? ' pending' : '') }));

  const tabShown: Record<ViewId, boolean> = { arch: true, failure: true, alternatives: true, concurrency: s.built, ui: s.uiComposed, timeout: s.composed, impl: s.handed };
  const tabs = VIEW_TABS.filter((v) => tabShown[v]).map((v) => {
    const proposed = (v === 'concurrency' && !s.kept) || (v === 'timeout' && !s.keptT) || (v === 'ui' && !s.keptU);
    return { id: v, name: canvas.view(v)!.name, title: v === 'concurrency' ? undefined : canvas.view(v)!.question, on: v === view, cls: (v === view ? 'on' : '') + (proposed ? ' proposed' : '') };
  });
  const receipt = view === 'concurrency' && s.receipt ? { which: 'concurrency' as const, verb: 'built', name: 'Concurrency', how: 'from Failure flow: split the worker, traced both charges' }
    : view === 'timeout' && s.receiptT ? { which: 'timeout' as const, verb: 'drew', name: 'Provider timeout', how: 'from the building blocks: a sequence over job #4185' }
    : view === 'ui' && s.receiptU ? { which: 'ui' as const, verb: 'drew', name: 'Checkout states', how: 'from the building blocks: four screens and the change between them' } : null;

  const wordView = (w: Word) => ({ t: w.t, tail: w.tail || '', chip: !!w.chip, chipTo: w.chipTo || '', cls: 'wd' + (w.ref ? ' ref' : '') + (w.chip ? ' chipref' : '') });

  return {
    view, def, people, approved, qOpen, needsSign,
    winClass: (s.side ? 'side-open ' : '') + (s.desk ? 'desk-open' : ''),
    deskUnseen: !s.desk && signalItems > 0,
    parentName: def.parent ? canvas.view(def.parent)!.name : '',
    provCls: 'prov' + (view === 'impl' ? ' real' : ''),
    recipeRows, tabs, receipt,
    stageCls: z < 0.8 ? 'compact' : '',
    cursorLabelCls: 'label' + (s.cursorFresh ? '' : ' idle'),
    ring: {
      daniel: speaker === 'daniel' || s.talking ? 'speaking' : '', john: speaker === 'john' ? 'speaking' : '',
      srikar: speaker === 'srikar' ? 'speaking' : '', vowe: speaker === 'vowe' ? 'speaking' : '',
    },
    surfaceCls: 'surface tool-' + s.tool + (s.dragging ? ' dragging' : ''),
    camX: cam.x + ox, camY: cam.y + oy, camZ: z, zoomPct: Math.round(cam.z * fit * 100) + '%',
    edgeCursors, bounds, wires, wlabels, steps, nodes,
    altCls: view === 'alternatives' ? '' : 'gone',
    verifyCls: view === 'impl' ? '' : 'gone', vcases, verifyCount: passing + ' of ' + vcases.length + ' pass',
    capQuote: s.last ? plain(s.last.words).replace(/^…/, '').slice(0, 90) : 'nothing said yet',
    inkD: inkList.join(' '), strokeD: toD(s.stroke, false), lassoD: toD(s.lasso, false),
    hasInk: inkList.length > 0 || (s.pins[view] || []).length > 0,
    pins: s.pins[view] || [],
    circleCls: 'lasso' + (circle && circle.asked ? ' read' : ''),
    circleX: circle ? Math.min(circle.x, STAGE_W - 240) : 0, circleY: circle ? Math.max(circle.y, -30) : 0,
    circleLabel: circle ? (circle.items.length ? 'You circled' : 'You circled empty space') : '',
    ctx: selBox && !circle ? { x: (selBox as { x: number }).x, y: (selBox as { y: number }).y - 42 } : null,
    ctxCount: selNamed.length, ctxAsk: selNamed.length > 1 ? 'Ask about these' : 'Ask about this',
    askSel: () => ctrl.converse(selNamed.map((x) => ({ short: x.n.short, id: x.id }))),
    backLabel: s.prev && s.prev !== view && (s.prev !== 'concurrency' || s.built) ? 'Back to ' + canvas.view(s.prev)!.name : '',

    decovCls: 'decov' + (approved || s.handed ? '' : ' proposed') + (s.liveRef === 'decision' ? ' pointed' : ''),
    statusLabel, statusTagCls: 'tag ' + (approved || s.handed ? 'good' : d.amending ? '' : needsSign ? 'needs' : 'ask'),
    decisionText: intent.decisionText(), suggestion,
    suggShow: !(d.draft || '').includes(suggestion) && !d.verify.includes(suggestion),
    diffKeep: diffHas ? d.base! : d.verify, diffAdd: diffHas ? d.verify.slice(d.base!.length) : '', diffHas,
    johnStamp, youStamp, youCanSign: d.sig.daniel !== d.v && !s.handed,
    canHand: approved && !s.handed && !d.amending, canAmend: !s.handed && !d.amending,
    targetName: s.target === 'codex' ? 'Codex' : 'Claude Code',

    ccShow: s.cc && !!shownLine,
    prev: L && s.last ? { who: people[s.last.who].name, text: plain(s.last.words) + (s.last.cut ? ' —' : '') } : null,
    lineName: shownLine ? people[shownLine.who].name : '', lineWords: shownLine ? shownLine.words.map(wordView) : [], lineCut: !L && !!s.last && !!s.last.cut,
    voweCls: 'vowe-btn ' + s.agent, agentLabel: AGENT_LABEL[s.agent],
    micCls: 'cbtn' + (s.muted ? ' muted' : '') + (s.talking ? ' talking' : ''), micLabel: s.muted ? 'Unmute' : 'Mute',
    ccCls: 'cbtn' + (s.cc ? ' on' : ''),

    goal: intent.goal(),
    // Coming back later, nobody else is in the call (as the room's preview says).
    roomSub: ctrl.options.scenario === 'returning' ? 'You and Vowe' : s.srikar === 'present' ? '4 here' : '3 here',
    rdecCls: 'rdec' + (approved || s.handed ? '' : ' proposed') + (s.liveRef === 'decision' ? ' pointed' : ''),
    rdecMeta: 'v' + d.v + ' · ' + (s.handed ? 'agreed and handed off' : approved ? 'both signed' : d.amending ? 'being amended' : d.sig.daniel === d.v ? 'you signed · John reviewing' : 'John signed · your signature next'),
    openRows: openNotes.map((n) => ({
      id: n.id, on: n.on, text: n.text, kind: KIND_LABEL[n.kind], onName: nodeName[n.on], who: n.suggested ? 'suggested by Vowe' : people[n.who].full, cls: 'rrow' + (n.suggested ? ' suggested' : ''),
    })),
    running: work.running(ctrl.options.scenario),
    idemCls: 'stream' + (qOpen ? ' needs' : ''), idemDot: 'dot ' + (qOpen ? 'needs' : s.p >= 4 ? 'live' : 'run'),
    idemLine: qOpen ? 'Paused on one question, pinned on the provider.' : stageLines[s.p],
    files: work.files(), branch: work.branch(),
    hasFiles: s.handed && s.p >= 2, overlap: s.handed && s.p >= 2,
  };
}

export type RoomModel = ReturnType<typeof deriveRoom>;
