import type { Entity, EntityKind, Lens, Relation, SystemRegistry } from '../model.js';
import type { FormId, Part, Rect } from './scene.js';

// The form table: which drawing a kind gets, and what that drawing shows inside itself. A form is an
// outline that says what the thing is (a store is a drum of drawers, a bridge a narrow throat, a queue an
// open tray of waiting slots) plus compartments filled from the registry: the entity's children and the
// typed facts in its attrs. Unknown kinds get an honest plain form with their kind written on it.
//
// Parts that stand for a child entity carry that entity's id, so the part you see inside a component is
// the node you land on when you enter it, and the order of compartments here is the arrangement the
// entered level keeps.

/** Kind → form. Declarative on purpose: a new kind is a new row, not new code. */
export const FORM_TABLE: Record<string, FormId> = {
  interface: 'interface', client: 'client', engine: 'engine', store: 'store', table: 'table', service: 'service',
  endpoint: 'endpoint', transport: 'bridge', adapter: 'bridge', queue: 'queue', worker: 'worker', 'event-channel': 'channel',
  external: 'external', system: 'module', subsystem: 'module', module: 'module', function: 'function', method: 'function',
  command: 'command', state: 'state', schema: 'schema', type: 'schema', validator: 'validator', query: 'query',
  class: 'class', file: 'file', test: 'test', interaction: 'interaction', step: 'step', 'store-function': 'store-function',
  column: 'column', unknown: 'unknown',
};

export function formFor(kind: EntityKind, _lens?: Lens): FormId {
  return FORM_TABLE[kind] ?? 'unknown';
}

/** Forms small enough to be a single chip: no compartments, nothing to enter into at this size. */
const CHIP_FORMS = new Set<FormId>(['function', 'command', 'column', 'interaction', 'endpoint', 'step', 'store-function']);

export interface FormInput {
  entity: Entity;
  /** Its children in the registry, sorted by id. */
  children: Entity[];
  registry: SystemRegistry;
  /** Relations touching the entity or any child, by id order. */
  relations: Relation[];
  /** How much each child matters to the view (higher first): the parts on the path or wired to what's drawn. */
  relevance?: (id: string) => number;
}

export interface DrawnForm { form: FormId; w: number; h: number; head: number; outline: string; parts: Part[] }

const HEAD = 44;
const PAD = 12;
const CHIP_H = 18;
const CHIP_GAP = 4;
/** Chips shown per compartment before "+N more": enough to show what it holds, few enough to stay a shape. */
const CAP = 6;

/* ---------- compartment specs per form ---------- */

interface Compartment {
  role: string;
  label: string;
  col: 0 | 1;
  match: (e: Entity) => boolean;
  /** Empty slots drawn as structure (a queue's waiting work, a client's pending tray). */
  slots?: number;
  /** Chips laid out in this many columns. */
  cols?: number;
  /** Strings from attrs to show when there are no matching children. */
  attrs?: string[];
}

const nameIs = (re: RegExp) => (e: Entity) => re.test(e.name);
const kindIs = (...ks: string[]) => (e: Entity) => ks.includes(e.kind);
const any = () => true;

const SPECS: Partial<Record<FormId, { w: number; comps: Compartment[] }>> = {
  interface: { w: 300, comps: [
    { role: 'regions', label: 'interaction regions', col: 0, match: kindIs('interaction'), attrs: ['tools', 'regions', 'members'] },
    { role: 'screen', label: 'renders', col: 1, match: (e) => !['interaction', 'test'].includes(e.kind) },
  ] },
  client: { w: 320, comps: [
    { role: 'state', label: 'state', col: 0, match: (e) => e.kind === 'state' && !/^(saved|reconcile|redraw|sync|reload|refresh)$/i.test(e.name), attrs: ['state'] },
    { role: 'reconcile', label: 'reconcile', col: 0, match: nameIs(/^(saved|reconcile|redraw|sync|reload|refresh)/i) },
    { role: 'pending', label: 'pending — in flight', col: 1, match: nameIs(/queue|pending|outbox|inflight/i), slots: 3, attrs: ['pending'] },
    { role: 'transport', label: 'transport boundary', col: 1, match: (e) => e.kind === 'transport' || e.kind === 'adapter' || /transport/i.test(e.name), attrs: ['transport'] },
    { role: 'operations', label: 'operations', col: 1, match: any },
  ] },
  engine: { w: 340, comps: [
    { role: 'commands', label: 'command set', col: 0, match: kindIs('command'), cols: 2, attrs: ['commands'] },
    { role: 'apply', label: 'apply path', col: 0, match: any },
  ] },
  store: { w: 340, comps: [
    { role: 'tables', label: 'tables', col: 0, match: kindIs('table'), cols: 2, attrs: ['tables'] },
    { role: 'functions', label: 'functions', col: 0, match: kindIs('store-function', 'query'), cols: 2, attrs: ['functions'] },
    { role: 'other', label: 'also', col: 0, match: any },
  ] },
  table: { w: 260, comps: [{ role: 'columns', label: 'columns', col: 0, match: kindIs('column'), attrs: ['columns'] }, { role: 'other', label: 'also', col: 0, match: any }] },
  service: { w: 300, comps: [
    { role: 'endpoints', label: 'endpoints', col: 0, match: kindIs('endpoint'), attrs: ['endpoints'] },
    { role: 'inside', label: 'inside', col: 1, match: any },
  ] },
  bridge: { w: 200, comps: [{ role: 'channels', label: 'channels', col: 0, match: any, attrs: ['channels', 'exposes'] }] },
  queue: { w: 300, comps: [{ role: 'waiting', label: 'waiting work', col: 0, match: kindIs('step', 'command'), slots: 5 }, { role: 'other', label: 'also', col: 0, match: any }] },
  worker: { w: 280, comps: [{ role: 'processing', label: 'work being processed', col: 0, match: kindIs('step'), slots: 2 }, { role: 'handlers', label: 'handlers', col: 0, match: any }] },
  channel: { w: 300, comps: [{ role: 'events', label: 'events', col: 0, match: any, attrs: ['events'] }] },
  external: { w: 260, comps: [{ role: 'received', label: 'calls it receives', col: 0, match: any, attrs: ['operations'] }] },
  module: { w: 300, comps: [{ role: 'parts', label: 'parts', col: 0, match: any, cols: 2 }] },
  class: { w: 280, comps: [
    { role: 'fields', label: 'fields', col: 0, match: kindIs('state', 'type', 'schema', 'column') },
    { role: 'methods', label: 'methods', col: 0, match: any },
  ] },
  state: { w: 260, comps: [{ role: 'fields', label: 'fields', col: 0, match: any, attrs: ['fields', 'keys'] }] },
  schema: { w: 260, comps: [{ role: 'fields', label: 'fields', col: 0, match: any, attrs: ['keys', 'members', 'fields'] }] },
  validator: { w: 260, comps: [{ role: 'checks', label: 'checks', col: 0, match: any, attrs: ['checks', 'keys'] }] },
  query: { w: 240, comps: [{ role: 'reads', label: 'reads', col: 0, match: any }] },
  file: { w: 260, comps: [{ role: 'symbols', label: 'symbols', col: 0, match: any }] },
  test: { w: 260, comps: [{ role: 'cases', label: 'cases', col: 0, match: any }] },
  unknown: { w: 260, comps: [{ role: 'parts', label: 'parts', col: 0, match: any }] },
};

/** What a chip is, by the compartment it sits in: the canvas draws each differently (drawers, pins, tickets). */
const CHIP_ROLE: Record<string, string> = { tables: 'table', endpoints: 'endpoint', regions: 'region', commands: 'command', channels: 'channel', events: 'channel' };

/** Strings from an attr, if it is a list (or a single string). */
function attrList(e: Entity, keys: string[] = []): string[] {
  for (const k of keys) {
    const v = e.attrs[k];
    if (Array.isArray(v) && v.length) return v.map(String);
    if (typeof v === 'string' && v) return [v];
  }
  return [];
}

function specFor(form: FormId): { w: number; comps: Compartment[] } {
  const spec = SPECS[form] ?? SPECS.unknown!;
  // Tests, validators and transports keep their own compartments in every form, ahead of the catch-all.
  const extra: Compartment[] = ([
    { role: 'checks', label: 'checks', col: 0, match: kindIs('validator') },
    { role: 'tests', label: 'verified by', col: spec.comps.some((c) => c.col === 1) ? 1 : 0, match: kindIs('test') },
  ] as Compartment[]).filter((x) => !spec.comps.some((c) => c.role === x.role));
  const last = spec.comps[spec.comps.length - 1];
  const catchAll = last && last.match === any ? [last] : [];
  return { w: spec.w, comps: [...spec.comps.slice(0, spec.comps.length - catchAll.length), ...extra, ...catchAll] };
}

export interface CompartmentContent {
  role: string; label: string; col: 0 | 1; cols: number; slots?: number; kids: Entity[]; strings: string[];
  /** The children this view touches (on its path, wired to what it draws, focused), most relevant first. */
  relevant: Entity[];
}

/** Which of an entity's children go in which compartment of its form (all of them, most relevant first). */
export function compartments(input: FormInput, lens?: Lens): CompartmentContent[] {
  const form = formFor(input.entity.kind, lens);
  if (CHIP_FORMS.has(form) || form === 'channel') return [];
  const used = new Set<string>();
  const out: CompartmentContent[] = [];
  const rel = input.relevance;
  for (const c of specFor(form).comps) {
    // Unclaimed children that fit, the ones that matter to this view first (stable: then by id).
    const kids = input.children.filter((k) => !used.has(k.id) && c.match(k))
      .sort((a, b) => declared(a, b) || (rel ? rel(b.id) - rel(a.id) : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    kids.forEach((k) => used.add(k.id));
    const strings = kids.length ? [] : attrList(input.entity, c.attrs);
    if (!kids.length && !strings.length && !c.slots) continue;
    // What the view touches, most relevant first (a toolbar keeps its order for drawing, not for this).
    let relevant = rel ? kids.filter((k) => rel(k.id) > 0).sort((a, b) => rel(b.id) - rel(a.id) || (a.id < b.id ? -1 : 1)) : [];
    // When the view follows a path or names a focus, only what it passes through counts as touched.
    if (rel && relevant.some((k) => rel(k.id) >= 100)) relevant = relevant.filter((k) => rel(k.id) >= 100);
    out.push({ role: c.role, label: c.label, col: c.col, cols: c.cols ?? 1, slots: c.slots, kids, strings, relevant });
  }
  return out;
}

/** The order the code declares things in (a toolbar's tools), when the registry recorded it. */
const order = (e: Entity) => (typeof e.attrs.order === 'number' ? e.attrs.order : 1e6);
/** Declared order wins between two things that both have one (tools keep their toolbar order). */
const declared = (a: Entity, b: Entity) => (a.kind === 'interaction' && b.kind === 'interaction' && order(a) < 1e6 && order(b) < 1e6 ? order(a) - order(b) : 0);

/** Lays a form out: its size, outline, and parts. Pure and deterministic. */
export function drawForm(input: FormInput, lens?: Lens): DrawnForm {
  const { entity } = input;
  const form = formFor(entity.kind, lens);
  if (CHIP_FORMS.has(form)) return chipForm(form, input);
  if (form === 'channel') {
    // A bus: one line that events travel along, with whoever publishes and subscribes tapping it.
    const w = 280, h = 74;
    const ev = typeof entity.attrs.event === 'string' ? entity.attrs.event : undefined;
    return { form, w, h, head: HEAD, outline: outlineFor(form, w, h), parts: [
      { key: `${entity.id}:bus`, role: 'bus', label: ev, rect: { x: 14, y: 52, w: w - 28, h: 8 }, lod: 'far' },
    ] };
  }
  const spec = specFor(form);
  const parts: Part[] = [];
  const twoCol = spec.comps.some((c) => c.col === 1);
  const inner = spec.w - PAD * 2;
  const colW = twoCol ? (inner - PAD) / 2 : inner;
  const colX = [PAD, PAD + colW + PAD];
  const colY = [HEAD, HEAD];
  const relNote = notesFor(input);

  for (const c of compartments(input, lens)) {
    const x = colX[c.col], y = colY[c.col];
    const cols = c.cols;
    const cw = (colW - 8 - (cols - 1) * CHIP_GAP) / cols;
    const items: { key: string; entity?: string; label: string; detail?: string; e?: Entity }[] = [
      ...c.kids.map((k) => ({ key: k.id, entity: k.id, label: k.name, detail: k.kind, e: k })),
      ...c.strings.map((str, i) => ({ key: `${entity.id}:${c.role}:${i}`, label: str })),
    ];
    const shown = items.slice(0, items.length > CAP * cols ? CAP * cols - 1 : CAP * cols);
    const more = items.length - shown.length;
    let cy = y + 18;
    if (c.slots) {
      // Structure only: the places where work would wait. A recorded trace is the only thing that fills them.
      const sw = (colW - 8 - (c.slots - 1) * 4) / c.slots;
      for (let i = 0; i < c.slots; i++) {
        parts.push({ key: `${entity.id}:${c.role}:slot${i}`, role: 'slot', rect: { x: x + 4 + i * (sw + 4), y: cy, w: sw, h: 16 }, lod: 'far', empty: true });
      }
      cy += 16 + CHIP_GAP;
    }
    shown.forEach((it, i) => {
      const r = Math.floor(i / cols), col = i % cols;
      const e = it.e;
      parts.push({
        key: it.key, entity: it.entity, role: CHIP_ROLE[c.role] ?? 'element', label: it.label, detail: it.detail,
        rect: { x: x + 4 + col * (cw + CHIP_GAP), y: cy + r * (CHIP_H + CHIP_GAP), w: cw, h: CHIP_H }, lod: 'far',
        note: it.entity ? relNote.get(it.entity) : undefined, provenance: e?.provenance, status: e?.status,
      });
    });
    cy += Math.ceil(shown.length / cols) * (CHIP_H + CHIP_GAP);
    if (more > 0) {
      parts.push({ key: `${entity.id}:${c.role}:more`, role: 'more', label: `+${more} more`, rect: { x: x + 4, y: cy, w: colW - 8, h: 16 }, lod: 'near' });
      cy += 16 + CHIP_GAP;
    }
    const h = cy - y + 4;
    // The compartment itself goes first so it is drawn under its chips.
    parts.splice(parts.length - (shown.length + (more > 0 ? 1 : 0) + (c.slots ?? 0)), 0,
      { key: `${entity.id}:${c.role}`, role: `compartment:${c.role}`, label: c.label, count: items.length, detail: items.slice(0, 3).map((it) => it.label).join(' · '), named: c.relevant.slice(0, 3).map((k) => k.name), rect: { x, y, w: colW, h }, lod: 'far' });
    colY[c.col] = y + h + 8;
  }
  if (!parts.length) {
    // Nothing inside that the registry knows of: a compact form, not an empty box pretending to hold something.
    const w = Math.min(spec.w, 230), h = form === 'bridge' ? 84 : 62;
    return { form, w, h, head: h, outline: outlineFor(form, w, h), parts: [] };
  }

  let h = Math.max(colY[0], colY[1]) + PAD - 8;
  h = Math.max(h, form === 'bridge' ? 120 : 92);
  const w = spec.w;
  if (form === 'store') h += 10; // the drum's lower rim
  if (form === 'client') parts.push({ key: `${entity.id}:plug`, role: 'plug', rect: { x: w - 2, y: h / 2 - 12, w: 12, h: 24 }, lod: 'far' });
  if (form === 'service') parts.push({ key: `${entity.id}:wall`, role: 'boundary', rect: { x: 0, y: 0, w: 5, h }, lod: 'far' });
  return { form, w, h, head: HEAD, outline: outlineFor(form, w, h), parts };
}

function chipForm(form: FormId, input: FormInput): DrawnForm {
  const w = form === 'step' ? 160 : 210, h = 56;
  const parts: Part[] = [];
  const sig = input.entity.attrs.signature;
  if (typeof sig === 'string') parts.push({ key: `${input.entity.id}:sig`, role: 'signature', label: sig, rect: { x: 12, y: 36, w: w - 24, h: 14 }, lod: 'near' });
  // A tool's key, as the interface declares it (`Draw · P`): the hint a person actually sees.
  const key = input.entity.attrs.key;
  if (typeof key === 'string' && key.length <= 3) parts.push({ key: `${input.entity.id}:key`, role: 'key', label: key.toUpperCase(), rect: { x: w - 34, y: 10, w: 22, h: 20 }, lod: 'far' });
  return { form, w, h, head: h, outline: outlineFor(form, w, h), parts };
}

/** "written by Canvas hub · read by Canvas client": who reaches each child, by relation kind. */
function notesFor(input: FormInput): Map<string, string> {
  const name = (id: string) => input.registry.entities[id]?.name ?? id;
  const by = new Map<string, string[]>();
  for (const r of input.relations) {
    if (r.kind === 'writes' || r.kind === 'reads' || r.kind === 'handles' || r.kind === 'consumes') {
      const verb = r.kind === 'writes' ? 'written by' : r.kind === 'reads' ? 'read by' : r.kind === 'handles' ? 'handled by' : 'consumed by';
      const target = r.kind === 'handles' ? r.from : r.to;
      const who = r.kind === 'handles' ? r.to : r.from;
      const list = by.get(target) ?? [];
      const s = `${verb} ${name(who)}`;
      if (!list.includes(s)) list.push(s);
      by.set(target, list);
    }
  }
  return new Map([...by].map(([k, v]) => [k, v.join(' · ')]));
}

/* ---------- outlines: the silhouette is the first thing that says what it is ---------- */

const f = (n: number) => Math.round(n * 10) / 10;

export function outlineFor(form: FormId, w: number, h: number): string {
  const W = f(w), H = f(h);
  switch (form) {
    case 'store': {
      const e = 10;
      return `M0 ${e} A${f(w / 2)} ${e} 0 0 1 ${W} ${e} V${f(h - e)} A${f(w / 2)} ${e} 0 0 1 0 ${f(h - e)} Z M0 ${e} A${f(w / 2)} ${e} 0 0 0 ${W} ${e}`;
    }
    case 'bridge': return `M0 0 H${W} L${f(w - 22)} ${f(h / 2)} L${W} ${H} H0 L22 ${f(h / 2)} Z`;
    case 'engine': { const c = 12; return `M${c} 0 H${f(w - c)} L${W} ${c} V${f(h - c)} L${f(w - c)} ${H} H${c} L0 ${f(h - c)} V${c} Z`; }
    case 'queue': { const r = 18; return `M0 0 H${f(w - r)} A${r} ${r} 0 0 1 ${W} ${r} V${f(h - r)} A${r} ${r} 0 0 1 ${f(w - r)} ${H} H0 M0 0 V${f(h * 0.3)} M0 ${f(h * 0.7)} V${H}`; }
    case 'worker': { let p = `M0 6 Q0 0 6 0`; for (let x = 24; x < w - 24; x += 28) p += ` H${x} v-5 h10 v5`; return p + ` H${f(w - 6)} Q${W} 0 ${W} 6 V${f(h - 6)} Q${W} ${H} ${f(w - 6)} ${H} H6 Q0 ${H} 0 ${f(h - 6)} Z`; }
    case 'channel': return roundRect(w, h, Math.min(22, h / 2));
    case 'external': { const c = 16; return `M0 0 H${f(w - c)} L${W} ${c} V${H} H0 Z M${f(w - c)} 0 V${c} H${W}`; }
    case 'module': return `M0 10 Q0 4 6 4 H${f(Math.min(110, w * 0.4))} L${f(Math.min(120, w * 0.4) + 6)} 12 H${f(w - 6)} Q${W} 12 ${W} 18 V${f(h - 6)} Q${W} ${H} ${f(w - 6)} ${H} H6 Q0 ${H} 0 ${f(h - 6)} Z`;
    case 'function': case 'store-function': return `M12 0 H${f(w - 12)} L${W} ${f(h / 2)} L${f(w - 12)} ${H} H12 L0 ${f(h / 2)} Z`;
    case 'command': { const r = 7; return `M0 0 H${W} V${f(h / 2 - r)} A${r} ${r} 0 0 0 ${W} ${f(h / 2 + r)} V${H} H0 V${f(h / 2 + r)} A${r} ${r} 0 0 0 0 ${f(h / 2 - r)} Z`; }
    case 'endpoint': { const r = 9; return `M0 0 H${W} V${H} H0 V${f(h / 2 + r)} A${r} ${r} 0 0 0 0 ${f(h / 2 - r)} Z`; }
    case 'validator': return `M0 0 H${W} L${f(w - 18)} ${H} H18 Z`;
    case 'query': return `M${f(h / 2)} 0 H${W} V${H} H${f(h / 2)} A${f(h / 2)} ${f(h / 2)} 0 0 1 ${f(h / 2)} 0 Z`;
    case 'file': return `M0 0 H${f(w - 16)} L${W} 16 V${H} H0 Z M${f(w - 16)} 0 V16 H${W}`;
    case 'schema': return `M0 8 H${f(w * 0.35)} L${f(w * 0.35 + 8)} 0 H${W} V${H} H0 Z`;
    case 'interface': return roundRect(w, h, 12) + ` M0 30 H${W}`;
    case 'step': case 'interaction': return roundRect(w, h, Math.min(h / 2, 14));
    case 'client': return roundRect(w, h, 6);
    case 'table': return `M0 0 H${W} V${H} H0 Z M0 30 H${W}`;
    case 'column': case 'state': case 'service': case 'class': case 'test': case 'unknown':
    default: return roundRect(w, h, 3);
  }
}

function roundRect(w: number, h: number, r: number): string {
  const W = f(w), H = f(h), R = f(r);
  return `M${R} 0 H${f(w - r)} Q${W} 0 ${W} ${R} V${f(h - r)} Q${W} ${H} ${f(w - r)} ${H} H${R} Q0 ${H} 0 ${f(h - r)} V${R} Q0 0 ${R} 0 Z`;
}

export const isChipForm = (form: FormId) => CHIP_FORMS.has(form);

/** Where a part sits on the node's outline, for ports: its vertical centre (or horizontal for 'down'). */
export function partCentre(r: Rect) { return { x: r.x + r.w / 2, y: r.y + r.h / 2 }; }
