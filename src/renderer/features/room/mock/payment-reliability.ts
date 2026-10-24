import { mockLog } from '../../../shared/mock.js';
import type { CanvasDataSource, IntentDataSource, PartState, ScriptedWorkSource, WorkEvents } from '../data/sources.js';
import type { Scenario } from '../controller.js';
import type {
  BoundDef, Decision, LabelDef, Note, PartDef, Person, PersonId, Rect, StepDef, ViewDef, ViewId, WireDef,
} from '../types.js';

// The Payment Reliability room from the design prototype (Main.dc.html), as local mock data:
// Daniel and John on duplicate charges, Srikar invited for the lease handling, a decision handed to
// Claude Code. Values are the prototype's, verbatim. The room itself, its call and its work context
// live in the workspace mock (features/workspace/mock); this is what the call draws and scripts.

/* ---------- The system, as parts that draw their own state. ---------- */
const PARTS: PartDef[] = [
  { id: 'api', kind: 'service', smart: 'endpoint', name: 'Webhook API', short: 'the webhook API', tech: 'receives provider events' },
  { id: 'queue', kind: 'queue', smart: 'queue', name: 'Retry Queue', short: 'the queue', tech: 'jobs · 30s lease' },
  { id: 'worker', kind: 'service', smart: 'worker', name: 'Payment Worker', short: 'the worker', tech: 'retry-worker' },
  { id: 'workerB', kind: 'service', smart: 'worker', name: 'Payment Worker', short: 'the second worker', tech: 'retry-worker · copy 2', hide: [320, 0, 210, 146] },
  { id: 'provider', kind: 'external', smart: 'calls', name: 'Payment Provider', short: 'the provider', tech: 'external · you don’t run it' },
  { id: 'ledger', kind: 'store', smart: 'table', name: 'Ledger', short: 'the ledger', tech: 'payments db' },
  { id: 'scrPay', kind: 'client', smart: 'screen', name: 'Pay', short: 'the pay screen', tech: 'checkout · idle' },
  { id: 'scrConfirm', kind: 'client', smart: 'screen', name: 'Confirming', short: 'the confirming screen', tech: 'checkout · new state', proposed: true },
  { id: 'scrPaid', kind: 'client', smart: 'screen', name: 'Paid', short: 'the paid screen', tech: 'checkout · paid' },
  { id: 'scrFailed', kind: 'client', smart: 'screen', name: 'Failed', short: 'the failed screen', tech: 'checkout · failed' },
  { id: 'diff', kind: 'code', smart: 'diff', name: 'PaymentStatus.tsx', short: 'the status component', tech: 'web/checkout · proposed change' },
];

const TOPOLOGY_NEIGHBOURS = { api: ['queue'], queue: ['api', 'worker'], worker: ['queue', 'provider', 'ledger'], provider: ['worker'], ledger: ['worker'] };

/* Each view's drawing has its own size; the camera fits that, not the whole sheet. */
const VIEWS: Partial<Record<ViewId, ViewDef>> = {
  arch: {
    name: 'Architecture', question: 'What is this system?', provenance: 'Example data',
    recipe: { arrangement: 'Topology', blocks: ['Endpoint · Webhook API', 'Queue · jobs #4181–4183', 'Service · worker-1', 'External · one charge', 'Store · two rows', 'Boundary · payments service'] },
    layout: { api: [0, 207, 180, 112], queue: [240, 190, 220, 146], worker: [520, 190, 210, 146], provider: [790, 190, 190, 146], ledger: [520, 410, 210, 140] },
    viewBox: [980, 580], neighbours: TOPOLOGY_NEIGHBOURS, cursor: [880, 300], cursor2: [330, 300], peerSelection: 'provider',
  },
  failure: {
    name: 'Failure flow', question: 'What if the worker crashes after charging?', provenance: 'Example · job #4182',
    recipe: { arrangement: 'Sequence over job #4182', blocks: ['Queue · #4182 handed out again', 'Service · worker-1 crashed', 'External · two charges'] },
    layout: { queue: [0, 0, 220, 146], worker: [320, 0, 210, 146], provider: [640, 0, 230, 146] },
    viewBox: [870, 540], neighbours: { queue: ['worker'], worker: ['queue', 'provider'], provider: ['worker'] },
    cursor: [420, 352], cursor2: [100, 90], peerSelection: 'provider',
  },
  alternatives: {
    name: 'Alternatives', question: 'Lock, or idempotency?', provenance: 'Options from the room’s notes',
    recipe: { arrangement: 'Comparison under the worker', blocks: ['Service · the worker', 'Option A · lock, set aside', 'Option B · idempotency'] },
    layout: { worker: [385, 0, 210, 146] },
    viewBox: [980, 500], cursor: [760, 330], cursor2: [200, 380],
  },
  concurrency: {
    name: 'Concurrency', question: 'What if two workers take the same job?', parent: 'failure', provenance: 'Example · job #4182',
    recipe: { arrangement: 'Fork and converge', blocks: ['Queue · #4182 held twice', 'Service · two copies', 'External · two charges'] },
    layout: { queue: [380, 0, 220, 146], worker: [170, 230, 210, 146], workerB: [600, 230, 210, 146], provider: [385, 470, 210, 146] },
    viewBox: [980, 620], neighbours: { queue: ['worker', 'workerB'], worker: ['queue', 'provider'], workerB: ['queue', 'provider'], provider: ['worker', 'workerB'] },
    cursor: [700, 300], cursor2: [480, 60], peerSelection: 'workerB',
  },
  impl: {
    name: 'Implementation', question: 'Does what’s built match what we agreed?', parent: 'arch', provenance: 'From Claude Code’s worktree and tests',
    recipe: { arrangement: 'Evidence over the topology', blocks: ['Evidence · one label per part', 'Store · new attempt_key column', 'Checks · from the signed decision'] },
    layout: { api: [0, 205, 180, 156], queue: [240, 188, 220, 190], worker: [520, 188, 210, 190], provider: [790, 188, 190, 190], ledger: [520, 440, 210, 200] },
    viewBox: [980, 660], neighbours: TOPOLOGY_NEIGHBOURS, cursor: [880, 330], cursor2: [330, 330],
  },
};

const BOUNDS: BoundDef[] = [
  { v: ['arch'], x: 222, y: 160, w: 526, h: 412, label: 'payments service' },
  { v: ['impl'], x: 222, y: 158, w: 526, h: 500, label: 'payments service' },
  { v: ['concurrency'], x: 150, y: 205, w: 680, h: 195, label: 'two copies of the worker' },
];
const WIRES: WireDef[] = [
  { v: 'arch', c: 'h arrow', x: 180, y: 263, w: 60, h: 1.35 }, { v: 'arch', c: 'h arrow', x: 460, y: 263, w: 60, h: 1.35 },
  { v: 'arch', c: 'h arrow', x: 730, y: 263, w: 60, h: 1.35 }, { v: 'arch', c: 'v varrow', x: 625, y: 336, w: 1.35, h: 74 },
  { v: 'impl', c: 'h arrow', x: 180, y: 283, w: 60, h: 1.35 }, { v: 'impl', c: 'h arrow', x: 460, y: 283, w: 60, h: 1.35 },
  { v: 'impl', c: 'h arrow', x: 730, y: 283, w: 60, h: 1.35 }, { v: 'impl', c: 'v varrow', x: 625, y: 378, w: 1.35, h: 62 },
  { v: 'failure', c: 'h arrow', x: 220, y: 73, w: 100, h: 1.35 }, { v: 'failure', c: 'h arrow', x: 530, y: 73, w: 110, h: 1.35 },
  { v: 'failure', c: 'life', x: 110, y: 146, w: 0, h: 390 }, { v: 'failure', c: 'life', x: 425, y: 146, w: 0, h: 390 }, { v: 'failure', c: 'life', x: 755, y: 146, w: 0, h: 390 },
  { v: 'alternatives', c: 'v', x: 490, y: 146, w: 1.35, h: 24 }, { v: 'alternatives', c: 'h', x: 225, y: 170, w: 531.35, h: 1.35 },
  { v: 'alternatives', c: 'v varrow', x: 225, y: 170, w: 1.35, h: 30 }, { v: 'alternatives', c: 'v varrow', x: 755, y: 170, w: 1.35, h: 30 },
  { v: 'concurrency', c: 'v', x: 490, y: 146, w: 1.35, h: 44, d: 260 }, { v: 'concurrency', c: 'h', x: 275, y: 190, w: 431.35, h: 1.35, d: 300 },
  { v: 'concurrency', c: 'v varrow', x: 275, y: 190, w: 1.35, h: 40, d: 340 }, { v: 'concurrency', c: 'v varrow', x: 705, y: 190, w: 1.35, h: 40, d: 340 },
  { v: 'concurrency', c: 'v hot', x: 275, y: 376, w: 1.35, h: 44, d: 520 }, { v: 'concurrency', c: 'v hot', x: 705, y: 376, w: 1.35, h: 44, d: 580 },
  { v: 'concurrency', c: 'h hot', x: 275, y: 420, w: 431.35, h: 1.35, d: 620 }, { v: 'concurrency', c: 'v varrow hot', x: 490, y: 420, w: 1.35, h: 50, d: 660 },
];
const LABELS: LabelDef[] = [
  { v: 'arch', t: 'enqueue', x: 184, y: 244 }, { v: 'arch', t: 'lease', x: 474, y: 244 }, { v: 'arch', t: 'charge', x: 737, y: 244 }, { v: 'arch', t: 'record', x: 633, y: 362 },
  { v: 'impl', t: 'enqueue', x: 184, y: 264 }, { v: 'impl', t: 'lease', x: 474, y: 264 }, { v: 'impl', t: 'charge + key', x: 731, y: 264 }, { v: 'impl', t: 'record', x: 633, y: 398 },
  { v: 'failure', t: 'lease', x: 252, y: 54 }, { v: 'failure', t: 'charge', x: 563, y: 54 },
  { v: 'concurrency', t: 'same job, leased twice', x: 425, y: 181 }, { v: 'concurrency', t: 'both charge', x: 456, y: 411 },
];
const STEPS: StepDef[] = [
  { n: '1', title: 'Picks up the retry', sub: 'job #4182, 30s lease', short: 'step 1', x: 315, y: 190 },
  { n: '2', title: 'Card charged', sub: 'provider confirms $48.00', short: 'step 2', x: 645, y: 260 },
  { n: '3', title: 'Crashes before ack', sub: 'the ack is never written', short: 'step 3', x: 315, y: 330, tone: 'crash' },
  { n: '4', title: 'Lease runs out', sub: '#4182 is visible again', short: 'step 4', x: 0, y: 400 },
  { n: '5', title: 'Card charged again', sub: 'same payment, twice', short: 'step 5', x: 645, y: 470, tone: 'bad' },
].map((t) => ({ ...t, v: 'failure' as const, id: 's' + t.n }));

/* ---------- The composer ----------
   A view is chosen blocks from the directory, bound to this system, in an arrangement picked for the
   question. The views above were laid out by hand with the same vocabulary; these are the machinery
   Vowe uses to make a new one mid-call. Each view also carries its recipe and where its data came
   from, so nobody mistakes a drawing for evidence. */
interface SequenceSpec {
  name: string; question: string; bound: string; provenance: string;
  actors: string[]; links: string[]; blocks: string[];
  steps: { actor: string; title: string; sub: string; tone?: string }[];
}

function composeSequence(id: ViewId, parent: ViewId, spec: SequenceSpec): ViewDef {
  const cw = 220, stride = 320, L: Record<string, Rect> = {};
  spec.actors.forEach((a, i) => { L[a] = [i * stride, 0, cw, 146]; });
  const cx = (a: string) => L[a][0] + cw / 2;
  for (let i = 0; i < spec.actors.length - 1; i++) {
    WIRES.push({ v: id, c: 'h arrow', x: L[spec.actors[i]][0] + cw, y: 73, w: stride - cw, h: 1.35, d: 500 + i * 140 });
    if (spec.links[i]) LABELS.push({ v: id, t: spec.links[i], x: L[spec.actors[i]][0] + cw + 12, y: 54 });
  }
  const end = 190 + spec.steps.length * 70;
  spec.actors.forEach((a) => { WIRES.push({ v: id, c: 'life', x: cx(a), y: 146, w: 0, h: end - 146, d: 900 }); });
  spec.steps.forEach((st, k) => {
    STEPS.push({ v: id, id: id + (k + 1), n: String(k + 1), title: st.title, sub: st.sub, short: 'step ' + (k + 1), x: cx(st.actor) - 110, y: 190 + k * 70, tone: st.tone });
  });
  const neighbours: Record<string, string[]> = {};
  spec.actors.forEach((a, i) => { neighbours[a] = spec.actors.filter((_b, j) => Math.abs(i - j) === 1); });
  return {
    name: spec.name, question: spec.question, parent, provenance: spec.provenance,
    recipe: { arrangement: 'Sequence over ' + spec.bound, blocks: spec.blocks },
    layout: L, viewBox: [(spec.actors.length - 1) * stride + cw, end + 10], neighbours,
    cursor: [cx(spec.actors[1]) + 70, 250], cursor2: [cx(spec.actors[0]) + 40, 90],
  };
}

const TIMEOUT_SPEC: SequenceSpec = {
  name: 'Provider timeout', question: 'What if the provider times out mid-charge?', bound: 'job #4185',
  provenance: 'Example · job #4185', actors: ['queue', 'worker', 'provider'], links: ['lease', 'charge + key'],
  blocks: ['Queue · #4185 leased', 'Service · worker-1 waiting', 'External · a charge whose answer was lost'],
  steps: [
    { actor: 'worker', title: 'Charges #4185', sub: 'with key att_4185' },
    { actor: 'provider', title: 'The charge lands', sub: 'but its answer is lost' },
    { actor: 'worker', title: 'Times out at 10s', sub: 'can’t tell if it landed', tone: 'crash' },
    { actor: 'queue', title: 'Retries #4185', sub: 'same key, att_4185' },
    { actor: 'provider', title: 'Returns the first result', sub: 'no second charge', tone: 'good' },
  ],
};

/* States arrangement: any set of states and transitions (screens, a job, a feature flag), laid out by
   depth from where it starts, with the code that would change it beside them. Same composer for a UI
   change as for a service. */
interface StatesSpec {
  name: string; question: string; provenance: string; start: string; startName: string;
  states: string[]; edges: { from: string; to: string; label: string; hot?: boolean }[];
  side: { id: string; w: number; h: number }[]; blocks: string[];
}

function composeStates(id: ViewId, parent: ViewId, spec: StatesSpec): ViewDef {
  const w = 210, h = 238, stride = 380, gapY = 40, L: Record<string, Rect> = {};
  const depth: Record<string, number> = { [spec.start]: 0 };
  const queue = [spec.start];
  while (queue.length) {
    const a = queue.shift()!;
    spec.edges.forEach((e) => { if (e.from === a && depth[e.to] === undefined) { depth[e.to] = depth[a] + 1; queue.push(e.to); } });
  }
  const cols: Record<number, string[]> = {};
  spec.states.forEach((st) => { const d = depth[st] || 0; (cols[d] = cols[d] || []).push(st); });
  const maxRows = Math.max(...Object.values(cols).map((c) => c.length));
  const tall = maxRows * h + (maxRows - 1) * gapY;
  Object.keys(cols).forEach((k) => {
    const list = cols[Number(k)], colH = list.length * h + (list.length - 1) * gapY, top = (tall - colH) / 2;
    list.forEach((st, i) => { L[st] = [Number(k) * stride, top + i * (h + gapY), w, h]; });
  });
  const lastX = (Object.keys(cols).length - 1) * stride + w + 90;
  spec.side.forEach((sd) => { L[sd.id] = [lastX, (tall - sd.h) / 2, sd.w, sd.h]; });
  spec.edges.forEach((e, i) => {
    const A = L[e.from], B = L[e.to], y1 = A[1] + h / 2, y2 = B[1] + h / 2, x1 = A[0] + w, x2 = B[0];
    const d = 500 + i * 160, hot = e.hot ? ' hot' : '';
    if (Math.abs(y1 - y2) < 1) WIRES.push({ v: id, c: 'h arrow' + hot, x: x1, y: y1, w: x2 - x1, h: 1.35, d });
    else {
      const mx = x1 + (x2 - x1) / 2;
      WIRES.push({ v: id, c: 'h' + hot, x: x1, y: y1, w: mx - x1, h: 1.35, d });
      WIRES.push({ v: id, c: 'v' + hot, x: mx, y: Math.min(y1, y2), w: 1.35, h: Math.abs(y2 - y1), d });
      WIRES.push({ v: id, c: 'h arrow' + hot, x: mx, y: y2, w: x2 - mx, h: 1.35, d });
    }
    LABELS.push({ v: id, t: e.label, x: Math.abs(y1 - y2) < 1 ? x1 + 10 : x1 + (x2 - x1) / 2 + 10, y: (Math.abs(y1 - y2) < 1 ? y1 : y2) - 20 });
  });
  const width = lastX + Math.max(0, ...spec.side.map((sd) => sd.w));
  const neighbours: Record<string, string[]> = {};
  spec.edges.forEach((e) => { (neighbours[e.from] = neighbours[e.from] || []).push(e.to); (neighbours[e.to] = neighbours[e.to] || []).push(e.from); });
  return {
    name: spec.name, question: spec.question, parent, provenance: spec.provenance,
    recipe: { arrangement: 'States, starting at ' + spec.startName, blocks: spec.blocks },
    layout: L, viewBox: [width, tall + 10], neighbours,
    cursor: [L[spec.states[1]][0] + 150, L[spec.states[1]][1] + 120], cursor2: [L[spec.states[0]][0] + 60, L[spec.states[0]][1] + 40],
  };
}

const UI_SPEC: StatesSpec = {
  name: 'Checkout states', question: 'What does the customer see while we retry?',
  provenance: 'From web/checkout · screens are sketches', start: 'scrPay', startName: 'Pay',
  states: ['scrPay', 'scrConfirm', 'scrPaid', 'scrFailed'],
  edges: [
    { from: 'scrPay', to: 'scrConfirm', label: 'tap Pay' },
    { from: 'scrConfirm', to: 'scrPaid', label: 'confirmed' },
    { from: 'scrConfirm', to: 'scrFailed', label: 'declined' },
  ],
  side: [{ id: 'diff', w: 320, h: 238 }],
  blocks: ['Screen · Pay', 'Screen · Confirming (proposed)', 'Screen · Paid', 'Screen · Failed', 'Code change · PaymentStatus.tsx'],
};

/* ---------- What each part draws, given the view and what is happening. This is the part the agent
   composes: a building block, bound to this system's data. ---------- */
const slot = (id: string, cls: string, note: string, lease = 0) => ({ id, cls: 'slot ' + cls, note, leased: cls === 'leased', lease });
const inst = (name: string, job: string, state: string) => ({ name, job, g: 'g' + (state ? ' ' + state : ''), cls: 'inst' + (state === 'crashed' ? ' crashed' : '') });
const callRow = (label: string, amt: string, mark: string, cls = '') => ({ label, amt, mark, cls: 'callr' + (cls ? ' ' + cls : '') });
const trow = (a: string, b: string, c: string, cls = '', cCls = '') => ({ a, b, c, cls: 'tr' + (cls ? ' ' + cls : ''), cCls });

const SCREENS: Record<string, { bn: string; bnCls: string; btn: string; btnCls: string; cap: string }> = {
  scrPay: { bn: '', bnCls: '', btn: 'Pay $48.00', btnCls: 'sbtn', cap: 'Customer taps Pay.' },
  scrConfirm: { bn: 'Confirming your payment…', bnCls: 'sbn info', btn: 'Please wait', btnCls: 'sbtn busy', cap: 'Shown while a charge is pending or unknown.' },
  scrPaid: { bn: 'Paid. Receipt sent.', bnCls: 'sbn good', btn: 'Done', btnCls: 'sbtn quiet', cap: 'Only once the provider confirms.' },
  scrFailed: { bn: 'Payment failed', bnCls: 'sbn bad', btn: 'Try again', btnCls: 'sbtn', cap: 'Today it also shows during a retry.' },
};

const describe: CanvasDataSource['describe'] = (n, view, { progress: p, question: q }) => {
  const out: PartState = { cap: '', capCls: 'cap' };
  if (n.smart === 'endpoint') { out.endpoint = 'POST /webhooks/payment'; out.cap = 'payment.failed → enqueue a retry'; }
  if (n.smart === 'queue') {
    if (view === 'timeout') { out.slots = [slot('#4184', 'acked', 'done'), slot('#4185', 'leased', 'worker-1', 88), slot('#4186', 'visible', 'waiting')]; out.cap = '#4185 leased to worker-1; the lease is nearly up.'; }
    else if (view === 'failure') { out.slots = [slot('#4181', 'acked', 'done'), slot('#4182', 'again', 'again'), slot('#4183', 'visible', 'waiting')]; out.cap = 'No ack before the lease ran out, so #4182 goes out again.'; out.capCls = 'cap bad'; }
    else if (view === 'concurrency') { out.slots = [slot('#4181', 'acked', 'done'), slot('#4182', 'twice', 'leased ×2'), slot('#4183', 'visible', 'waiting')]; out.cap = '#4182 is held by two workers at once.'; out.capCls = 'cap bad'; }
    else { out.slots = [slot('#4181', 'acked', 'done'), slot('#4182', 'leased', 'worker-1', view === 'impl' ? 50 : 62), slot('#4183', 'visible', 'waiting')]; out.cap = view === 'impl' ? 'Unchanged by this work.' : '#4182 leased to worker-1.'; }
  }
  if (n.smart === 'worker') {
    if (view === 'timeout') { out.insts = [inst('worker-1', '#4185 · waiting', '')]; out.cap = 'Gave up after 10s. Did the charge land?'; out.capCls = 'cap bad'; }
    else if (n.id === 'workerB') { out.insts = [inst('worker-2', '#4182 · lease 2', '')]; out.cap = 'Charges #4182 as well.'; out.capCls = 'cap bad'; }
    else if (view === 'failure') { out.insts = [inst('worker-1', '#4182', 'crashed')]; out.cap = 'Charge went through; the ack never did.'; out.capCls = 'cap bad'; }
    else if (view === 'concurrency') { out.insts = [inst('worker-1', '#4182 · lease 1', '')]; out.cap = 'Charges #4182.'; }
    else if (view === 'impl') { out.insts = [inst('worker-1', p >= 2 ? 'key att_4182' : '#4182', p >= 3 ? 'ok' : '')]; out.cap = p >= 2 ? 'Reuses the attempt key on every retry.' : 'Not changed yet.'; }
    else if (view === 'alternatives') { out.insts = [inst('worker-1', '#4182', '')]; out.cap = 'Where either option has to live.'; }
    else { out.insts = [inst('worker-1', '#4182', '')]; out.cap = 'Charges, then acks the job.'; }
  }
  if (n.smart === 'calls') {
    if (view === 'timeout') { out.calls = [callRow('charge #4185 · key', '$22.00', '?', 'unk')]; out.cap = 'It charged. Its answer never arrived.'; }
    else if (view === 'failure' || view === 'concurrency') { out.calls = [callRow('charge #4182', '$48.00', '✓'), callRow('charge #4182', '$48.00', '✓', 'dup')]; out.cap = 'The same payment, charged twice.'; out.capCls = 'cap bad'; }
    else if (view === 'impl') {
      out.calls = q === 'open' ? [callRow('charge · key', '$48.00', '✓', 'keyed'), callRow('refund · no key', '$12.00', '?', 'dup')] : [callRow('charge · key', '$48.00', '✓', 'keyed'), callRow('retry · same key', 'first result', '✓', 'keyed')];
      out.cap = q === 'open' ? 'Won’t take a key on refunds.' : 'A repeat returns the first result.'; out.capCls = q === 'open' ? 'cap bad' : 'cap';
    }
    else { out.calls = [callRow('charge #4182', '$48.00', '✓')]; out.cap = 'Charged once.'; }
  }
  if (n.smart === 'table') {
    out.cols = '52px 1fr 1fr';
    if (view === 'impl' && p >= 2) out.rows = [trow('payment', 'status', 'attempt_key'), trow('#4181', 'settled', 'att_4181', '', 'new'), trow('#4182', 'settled', 'att_4182', 'newrow', 'new')];
    else out.rows = [trow('payment', 'amount', 'status'), trow('#4180', '$12.00', 'settled'), trow('#4181', '$30.00', 'settled')];
  }
  if (n.smart === 'screen') {
    const scr = SCREENS[n.id];
    out.screen = scr; out.cap = scr.cap; out.capCls = n.id === 'scrFailed' ? 'cap bad' : 'cap';
  }
  if (n.smart === 'diff') {
    out.diff = [
      { t: 'switch (payment.status) {', cls: 'dl' },
      { t: "  case 'pending': return <Failed />", cls: 'dl del' },
      { t: "  case 'pending':", cls: 'dl add' },
      { t: "  case 'unknown': return <Confirming />", cls: 'dl add' },
      { t: "  case 'paid': return <Paid />", cls: 'dl' },
      { t: "  case 'declined': return <Failed />", cls: 'dl' },
    ];
    out.cap = 'Today a pending retry lands on Failed.'; out.capCls = 'cap bad';
  }
  return out;
};

const canvas: CanvasDataSource = {
  parts: () => PARTS,
  wires: () => WIRES,
  labels: () => LABELS,
  bounds: () => BOUNDS,
  steps: () => STEPS,
  view: (id) => VIEWS[id],
  compose(id, parent) {
    // Drawn once per session; undoing a proposed view only hides its tab.
    const existing = VIEWS[id];
    if (existing) return existing;
    mockLog('canvas', `Vowe composes the "${id}" view (scripted layout, no model call)`);
    const view = id === 'timeout' ? composeSequence(id, parent, TIMEOUT_SPEC) : composeStates(id, parent, UI_SPEC);
    VIEWS[id] = view;
    return view;
  },
  describe,
};

/* ---------- People and rooms. ---------- */
export const PEOPLE: Record<PersonId, Person> = {
  daniel: { name: 'You', full: 'Daniel', initials: 'DE', av: 'mav' },
  john: { name: 'John', full: 'John', initials: 'JM', av: 'mav peer' },
  srikar: { name: 'Srikar', full: 'Srikar', initials: 'SR', av: 'mav p2' },
  vowe: { name: 'Vowe', full: 'Vowe', initials: 'V', av: 'mav vowe' },
};

/** Srikar, asked in from the canvas, joins a moment later. */
export function invite(person: PersonId): Promise<void> {
  mockLog('room', `invite ${person}; they join in 2.4s`);
  return new Promise((resolve) => setTimeout(resolve, 2400));
}

export const people = () => PEOPLE;

/* ---------- Intent: what people meant, in their words, on the part it is about. ---------- */
const NOTES: Note[] = [
  { id: 'n2', kind: 'concern', text: 'If the worker crashes after the charge, the job is redelivered and charged again.', who: 'daniel', on: 'worker', linked: true },
  { id: 'n3', kind: 'avoid', text: 'A distributed lock, unless new evidence says we need one.', who: 'daniel', on: 'worker' },
  { id: 'n4', kind: 'constraint', text: 'Retries stay reliable.', who: 'john', on: 'queue' },
  { id: 'n5', kind: 'question', text: 'How do we notice an acknowledgment that never arrived?', who: 'vowe', on: 'queue', suggested: true },
];

const intent: IntentDataSource = {
  goal: () => ({ text: 'Retries can never produce a duplicate charge.', by: 'john' }),
  notes: () => NOTES.slice(),
  decision: (): Decision => ({ v: 2, verify: 'Concurrent pickup; worker crash after charge', base: null, sig: { john: 2, daniel: 0 }, amending: false, draft: '', reviewing: false, history: [] }),
  decisionText: () => ({
    what: 'Use idempotent processing for concurrent worker execution.',
    goal: 'Prevent duplicate payment processing',
    avoid: 'Distributed locking unless evidence shows it’s required',
    because: 'Simpler coordination with reliable deduplication',
    why: 'If the worker crashes after the charge, the job is redelivered and charged again. (Daniel)',
  }),
  suggestedCheck: () => 'provider timeout mid-charge',
};

/* ---------- Coding agents. ---------- */
/**
 * The retry worker's last test run, which the call's panel and the room's preview both show: still
 * failing during the live call, passing by the time you come back.
 */
export const retryTests = (scenario: Scenario) => scenario === 'returning' ? '22 of 22 passed' : '14 of 22 passed';

/** The scripted coding agent behind the call: what was running, and the handoff of the decision. */
export const script: Omit<ScriptedWorkSource, 'context' | 'share' | 'transcript'> = {
  running: (scenario) => [{ title: 'Retry worker', agent: 'Claude Code', meta: `payments/retry-worker · tests ${retryTests(scenario)}`, state: scenario === 'returning' ? 'done' : 'running' }],
  stages: () => ['Creating the worktree and reading the decision.', 'Reading the retry path and the ledger schema.', 'Adding an attempt key to every charge.', 'Running the checks from the decision.', 'All checks pass. Ready for review.'],
  files: () => [
    { path: 'payments/retry/worker.ts', a: '48', d: '−12' }, { path: 'payments/retry/idempotency.ts', a: '96', d: '' },
    { path: 'db/migrations/0042_attempt_key.sql', a: '14', d: '' }, { path: 'payments/retry/worker.test.ts', a: '120', d: '−4' },
  ],
  branch: () => 'payments/idempotency',
  handoff(decision, target, events) {
    mockLog('work', `handoff of decision v${decision.v} to ${target} (no agent runs; scripted progress and one question)`, decision);
    ([[1, 1600], [2, 4200], [3, 7400]] as const).forEach(([stage, ms]) => setTimeout(() => events.progress(stage), ms));
    setTimeout(() => events.question(), 10400);
  },
  answer(text, events: WorkEvents) {
    mockLog('work', `room answered the agent: "${text}"`);
    setTimeout(() => events.progress(4), 3200);
  },
};

export { canvas, intent };
