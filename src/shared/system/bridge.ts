import type { CommandArgs, ComponentInput, ConnectionInput } from '../canvas/commands.js';
import { ID_MAX, ID_PATTERN, type ComponentKind, type RelationshipKind } from '../canvas/model.js';
import type { Entity, ResolvedView, SystemRegistry } from './model.js';
import { byString } from './registry-utils.js';

// From the system canvas to a room's existing canvas: a resolved view as the arguments of the room canvas's
// `load_system` command (shared/canvas/commands.ts), so a selection can be put in front of a room without
// changing the room canvas's schema. The room canvas knows seven component kinds and six relationship
// kinds, with rules (a call never goes to a database, events live in queues…); this maps onto them and
// drops what it can't say, rather than bending its meaning.

const KIND: Record<string, ComponentKind> = {
  store: 'database', table: 'database', 'store-function': 'database', database: 'database',
  queue: 'queue', 'event-channel': 'queue',
  worker: 'worker', external: 'external',
  system: 'boundary', subsystem: 'boundary',
};
const kindFor = (e: Entity): ComponentKind => KIND[e.kind] ?? 'service';

/** A registry id as a room canvas id: `component:canvas-client` → `canvas-client`, unique, ≤ 64. */
function roomId(id: string, used: Map<string, string>): string {
  const prev = used.get(id);
  if (prev) return prev;
  let base = id.replace(/^(component|subsystem|area|system):/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!/^[a-z]/.test(base)) base = `x-${base}`;
  base = base.slice(0, ID_MAX).replace(/-+$/, '') || 'x';
  let out = base;
  const taken = new Set(used.values());
  for (let n = 2; taken.has(out); n++) out = `${base.slice(0, ID_MAX - String(n).length - 1).replace(/-+$/, '')}-${n}`;
  if (!ID_PATTERN.test(out)) out = `x-${Math.abs([...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7))}`;
  used.set(id, out);
  return out;
}

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/**
 * The view's components (and the subsystems they sit in, as boundaries) and the relations between them,
 * rolled up to component level. Elements in the view become facts on their component.
 */
export function toRoomCanvasSystem(reg: SystemRegistry, view: ResolvedView, opts: { replace?: boolean } = {}): CommandArgs['load_system'] {
  const E = reg.entities;
  const inView = new Set(view.entities);
  const up = (id: string): string | undefined => {
    for (let cur: string | undefined = id; cur; cur = E[cur]?.parent) if (E[cur]?.level === 'component') return cur;
    return undefined;
  };
  const comps = [...new Set(view.entities.map(up).filter((x): x is string => !!x))].sort(byString).slice(0, 180);
  const compSet = new Set(comps);
  const boundaries = [...new Set(comps.map((c) => E[c].parent).filter((p): p is string => !!p && !!E[p] && (E[p].kind === 'subsystem' || E[p].kind === 'system') && inView.has(p)))].sort(byString).slice(0, 20);
  const used = new Map<string, string>();
  const components: ComponentInput[] = [];
  for (const b of boundaries) components.push({ id: roomId(b, used), kind: 'boundary', name: cut(E[b].name, 80), tech: cut(`${E[b].kind} · ${E[b].provenance}`, 120) });
  for (const id of comps) {
    const e = E[id];
    const kind = kindFor(e);
    const inner = view.entities.filter((x) => x !== id && up(x) === id).map((x) => E[x]);
    const facts: Record<string, string> = { registry: cut(e.id, 200), provenance: e.provenance };
    if (e.confidence !== undefined) facts.confidence = String(e.confidence);
    const byKind = new Map<string, string[]>();
    for (const x of inner) (byKind.get(x.kind) ?? byKind.set(x.kind, []).get(x.kind)!).push(x.name);
    for (const [k, names] of [...byKind].sort(([a], [b]) => byString(a, b)).slice(0, 9)) facts[k.replace(/[^a-zA-Z0-9_]/g, '_')] = cut(names.join(', '), 200);
    const parent = e.parent && boundaries.includes(e.parent) && kind !== 'queue' ? roomId(e.parent, used) : undefined;
    const c: ComponentInput = {
      id: roomId(id, used), kind, name: cut(e.name, 80), tech: cut(`${e.kind}${e.attrs.dir ? ` · ${e.attrs.dir}` : ''}`, 120),
      ...(e.summary ? { note: cut(e.summary, 240) } : {}), facts,
      ...(parent ? { parent } : {}),
    };
    if (kind === 'database') {
      const tables = Object.values(E).filter((t) => t.parent === id && t.kind === 'table' && (inView.has(t.id) || inner.length === 0)).sort((a, b) => byString(a.id, b.id)).slice(0, 29);
      if (tables.length) c.rows = [['table', 'columns'], ...tables.map((t) => [cut(t.name, 80), cut(((t.attrs.columns as string[] | undefined) ?? []).join(', '), 80)])];
    }
    if (kind === 'service') {
      const ep = inner.find((x) => x.kind === 'endpoint');
      if (ep) c.endpoint = cut(ep.name, 120);
    }
    components.push(c);
  }

  // Relations, rolled up to the components on the room canvas and mapped to what it can say.
  const kindOf = new Map(components.map((c) => [c.id, c.kind]));
  const rels = new Map<string, ConnectionInput>();
  for (const rid of view.relations) {
    const r = reg.relations[rid];
    if (!r) continue;
    const from = up(r.from), to = up(r.to);
    if (!from || !to || from === to || !compSet.has(from) || !compSet.has(to)) continue;
    const f = roomId(from, used), t = roomId(to, used);
    const tk = kindOf.get(t)!, fk = kindOf.get(f)!;
    if (fk === 'boundary' || fk === 'event') continue;
    let kind: RelationshipKind | null;
    switch (r.kind) {
      case 'reads': case 'writes': kind = tk === 'database' ? 'reads_writes' : 'calls'; break;
      case 'publishes': kind = tk === 'queue' ? 'publishes' : 'calls'; break;
      case 'consumes': kind = tk === 'queue' ? 'consumes' : 'depends_on'; break;
      case 'calls': case 'sends': case 'handles': case 'renders': case 'produces':
        kind = tk === 'database' ? 'reads_writes' : tk === 'queue' ? 'publishes' : 'calls'; break;
      case 'depends_on': case 'implements': kind = 'depends_on'; break;
      default: kind = null;
    }
    if (!kind || (kind === 'calls' && (tk === 'boundary' || tk === 'event'))) continue;
    const key = `${f}--${kind}--${t}`;
    if (rels.has(key)) continue;
    rels.set(key, { from: f, to: t, kind, ...(r.label ? { label: cut(r.label, 40) } : {}) });
  }
  return { components, relationships: [...rels.values()].sort((a, b) => byString(`${a.from}${a.kind}${a.to}`, `${b.from}${b.kind}${b.to}`)).slice(0, 400), ...(opts.replace !== undefined ? { replace: opts.replace } : {}) };
}
