import { slug, type EntityKind, type IndexSymbol, type LiteralSite } from '../../shared/system/model.js';
import { byString } from '../../shared/system/registry-utils.js';
import { humanName } from './builder.js';
import { analyseChannels, type Channels } from './channels.js';
import { baseOf, dirOf, topOf, type Facts } from './facts.js';

// Finding the parts a system is made of, from structural signals only: what a module handles, holds,
// calls through, registers and dispatches. Each signal is a named rule (RULES below); a part's name comes
// from the code (its anchor symbol, file or directory), never from a list of known names.

export type Role = 'interface' | 'client' | 'adapter' | 'bridge' | 'service' | 'hub' | 'engine' | 'store-adapter';

export const ROLE_KIND: Record<Role, EntityKind> = {
  interface: 'interface', client: 'client', adapter: 'adapter', bridge: 'adapter', service: 'service', hub: 'service',
  engine: 'engine', 'store-adapter': 'adapter',
};

/** When two roles claim the same anchor, the more specific one wins. */
const PRIORITY: Role[] = ['engine', 'store-adapter', 'client', 'hub', 'adapter', 'bridge', 'service', 'interface'];

export const COMPONENT_RULES: Record<string, string> = {
  'role.interface': 'A UI component that handles pointer/keyboard events (JSX on* handlers) or branches on a set of tool/mode literals is an interface.',
  'role.client': 'A class holding a field typed by an interface whose methods it calls, plus state of its own, is a client of that boundary.',
  'role.adapter': 'A function whose return type is (or a class that implements) a boundary interface a client calls through is an adapter for it.',
  'role.bridge': 'A module that invokes string channels other modules register handlers for is a bridge.',
  'role.service.channels': 'A module registering handlers for string channels or routes is a service; each channel is an endpoint.',
  'role.service.served': 'A module whose exported functions endpoints call is a service behind them.',
  'role.hub': 'An exported function or class that emits named events and calls through a boundary is a hub.',
  'role.engine': 'A dispatch table (object literal) whose keys are the members of a union or the keys of an interface, read by a function, is an engine; each key is a command.',
  'role.store-adapter': 'A module whose call sites name an indexed SQL table or function (`.from(\'t\')`, `.rpc(\'f\')`) is an adapter to the database.',
  'role.database': 'SQL tables and functions form one store component.',
  'group.by-role': 'Interfaces and engines group by directory; clients, adapters, hubs by anchor symbol; bridges and services by file.',
  'group.helper': 'An unclaimed file belongs to the component in its directory that imports it most; an unclaimed symbol in a claimed file to the component it uses most.',
  'group.feature': 'A word that names directories or files of components in three or more top-level areas is a feature subsystem (e.g. `canvas`).',
  'group.area': 'Components outside any feature group under their top-level area (renderer, main, shared, …).',
};

export interface Claim {
  role: Role;
  anchor: IndexSymbol | null;
  file: string;
  score: number;
  rule: string;
  why: string;
  confidence: number;
  /** Role-specific facts the internals rules read. */
  extra: Record<string, string | string[] | undefined>;
}

export interface Component {
  id: string;
  role: Role;
  kind: EntityKind;
  name: string;
  dir: string;
  area: string;
  files: string[];
  claims: Claim[];
  /** Files attached as helpers. */
  helpers: string[];
  feature?: string;
}

export interface Discovery {
  channels: Channels;
  components: Map<string, Component>;
  /** Top-level symbol id → component id. */
  owner: Map<string, string>;
  /** File → its default component id. */
  fileOwner: Map<string, string>;
  /** Boundary interface symbol id → { client component, implementers (symbol ids) }. */
  boundaries: Map<string, { users: string[]; implementers: string[]; via: 'field' | 'param' }>;
  /** Dispatch tables found: table symbol → { keys type, apply fn, keys }. */
  dispatch: { table: IndexSymbol; keysType: IndexSymbol | null; apply: IndexSymbol | null; keys: string[]; component?: string }[];
  /** Endpoint channel literal → serving symbol ids. */
  served: Map<string, { site: LiteralSite; targets: IndexSymbol[] }[]>;
  database?: { id: string; name: string; files: string[] };
  areas: Map<string, string[]>;
  features: Map<string, string[]>;
}

export const areaOf = (file: string) => { const p = file.split('/'); return p[0] === 'src' && p.length > 2 ? p[1] : p.length > 1 ? p[0] : '(root)'; };

const GENERIC = new Set([
  'src', 'index', 'lib', 'libs', 'util', 'utils', 'shared', 'common', 'features', 'feature', 'components', 'component', 'main', 'renderer',
  'integrations', 'types', 'type', 'model', 'models', 'test', 'tests', 'app', 'core', 'internal', 'public', 'private', 'migrations', 'scripts',
  'preload', 'server', 'client', 'api', 'config', 'store', 'views', 'view', 'helpers', 'system', 'd',
]);

const isUi = (s: IndexSymbol) => s.kind === 'ui-component';
const typeName = (t: string | undefined) => (t ? /([A-Za-z_$][\w$]*)/.exec(t.replace(/^(readonly|private|public|protected)\s+/, ''))?.[1] : undefined);
const STATEY = /Store<|\[\]|Map<|Set<|Array<|Record<|Queue|State\b/;
export const singular = (w: string) => w.replace(/ies$/, 'y').replace(/(s|x|ch|sh)es$/, '$1').replace(/([^aiosu])s$/, '$1');
/** Words that name a role, not a feature. */
const ROLE_WORDS = new Set(['engine', 'service', 'store', 'client', 'adapter', 'bridge', 'hub', 'transport', 'interface', 'surface', 'tool', 'tools', 'source', 'sink', 'provider', 'handler', 'real', 'fake']);
/** Directory words too general to name a part after. */
const NAME_GENERIC = new Set(['src', 'lib', 'libs', 'util', 'utils', 'shared', 'common', 'features', 'feature', 'components', 'component', 'ui', 'core', 'internal', 'app', 'index', 'helpers', 'd']);
/** Lower-cased before slugging, so `IPC` stays one word in ids. */
export const nameSlug = (name: string) => slug(name.toLowerCase());

export function discover(F: Facts): Discovery {
  const channels = analyseChannels(F);
  const interfacesByName = new Map<string, IndexSymbol[]>();
  for (const s of F.index.symbols) if ((s.kind === 'interface' || s.kind === 'type') && !F.isTest(s.file)) (interfacesByName.get(s.name) ?? interfacesByName.set(s.name, []).get(s.name)!).push(s);
  const resolveType = (name: string | undefined, from: string): IndexSymbol | undefined => {
    if (!name) return undefined;
    const cands = interfacesByName.get(name) ?? [];
    if (cands.length <= 1) return cands[0];
    return cands.find((c) => c.file === from)
      ?? cands.find((c) => (F.importsFrom.get(from) ?? []).some((i) => i.to === c.file && i.names.includes(name)))
      ?? cands.slice().sort((a, b) => byString(a.id, b.id))[0];
  };
  const memberOf = (iface: IndexSymbol) => new Set(F.memberSymbols(iface.id).map((m) => m.id));

  const claims: Claim[] = [];
  const boundaries: Discovery['boundaries'] = new Map();
  const live = (s: IndexSymbol) => !F.isTest(s.file);

  /* ---- interface: UI that handles input ---- */
  for (const s of F.index.symbols) {
    if (!isUi(s) || !live(s)) continue;
    const events = F.strings(s, 'events').filter((e) => /^on(Pointer|Mouse|Key|Click|Wheel|Touch|Drag|Drop|Input|Change|Submit|Focus|Blur|DoubleClick|ContextMenu)/.test(e));
    const elements = F.strings(s, 'elements');
    const svg = elements.some((e) => ['svg', 'path', 'g', 'circle', 'canvas', 'rect'].includes(e));
    const comparisons = (F.comparisonsInFile.get(s.file) ?? []).filter((c) => c.in === s.id || c.in.startsWith(s.id + '.')).length;
    const runs = F.literalsWithin(s.id).length;
    const score = events.length * 2 + (svg ? 3 : 0) + Math.min(comparisons, 12) / 2 + Math.min(runs, 10) / 4 + (s.exported ? 1 : 0);
    if (events.length >= 2 || comparisons >= 3 || (s.exported && runs >= 3)) {
      claims.push({
        role: 'interface', anchor: s, file: s.file, score, rule: 'role.interface', confidence: events.length >= 2 ? 0.8 : 0.55,
        why: `\`${s.name}\` ${events.length ? `handles ${events.slice(0, 4).join(', ')}${events.length > 4 ? '…' : ''}` : `branches on ${comparisons} literal comparisons`}${svg ? ' and draws SVG' : ''}`,
        extra: { events, elements },
      });
    }
  }

  /* ---- client + transport: a class calling through an interface-typed field ---- */
  for (const c of F.index.symbols) {
    if (c.kind !== 'class' || !live(c)) continue;
    const fields = F.memberSymbols(c.id).filter((m) => m.kind === 'property');
    const calls = F.refsWithin(c.id).filter((r) => r.kind === 'call');
    for (const f of fields) {
      const iface = resolveType(typeName(F.declaredType(f)), c.file)
        ?? [...(F.refsFrom.get(f.id) ?? [])].filter((r) => r.kind === 'type').map((r) => F.symbols.get(r.to)).find((t) => t?.kind === 'interface');
      if (!iface || iface.kind !== 'interface') continue;
      const ms = memberOf(iface);
      const used = [...new Set(calls.filter((r) => ms.has(r.to)).map((r) => r.to))];
      if (!used.length) continue;
      const state = fields.filter((g) => g !== f && (STATEY.test(F.declaredType(g) ?? '') || (F.refsTo.get(g.id) ?? []).some((r) => r.kind === 'write')));
      claims.push({
        role: 'client', anchor: c, file: c.file, score: used.length + 2 * state.length, rule: 'role.client', confidence: state.length ? 0.85 : 0.6,
        why: `\`${c.name}\` holds \`${f.name}: ${iface.name}\`, calls ${used.length} of its methods, and keeps ${state.map((g) => `\`${g.name}\``).join(', ') || 'no state'}`,
        extra: { boundary: iface.id, field: f.id, state: state.map((g) => g.id) },
      });
      const b = boundaries.get(iface.id) ?? { users: [], implementers: [], via: 'field' as const };
      b.users.push(c.id);
      boundaries.set(iface.id, b);
    }
  }
  /* A function taking an interface-typed parameter and calling two or more of its methods uses it as a boundary too. */
  for (const fn of F.index.symbols) {
    if (fn.kind !== 'function' || !live(fn)) continue;
    const sig = fn.signature ?? '';
    const params = /\(([^)]*)\)/.exec(sig)?.[1] ?? '';
    for (const m of params.matchAll(/(\w+)\??:\s*([A-Z]\w*)/g)) {
      const iface = resolveType(m[2], fn.file);
      if (!iface || iface.kind !== 'interface') continue;
      const ms = memberOf(iface);
      const used = new Set(F.refsWithin(fn.id).filter((r) => r.kind === 'call' && ms.has(r.to)).map((r) => r.to));
      if (used.size < 2) continue;
      const b = boundaries.get(iface.id) ?? { users: [], implementers: [], via: 'param' as const };
      if (!b.users.includes(fn.id)) b.users.push(fn.id);
      boundaries.set(iface.id, b);
    }
  }

  /* ---- adapters: implementations of a boundary ---- */
  for (const s of F.index.symbols) {
    if (!live(s) || !(s.kind === 'function' || s.kind === 'class' || s.kind === 'variable')) continue;
    const declared = s.kind === 'function' ? F.returnType(s) : s.kind === 'variable' ? F.declaredType(s) : undefined;
    const names = (declared ?? '').split(/[&|<>,\s]+/).filter(Boolean);
    const implementsRefs = (F.refsFrom.get(s.id) ?? []).filter((r) => r.kind === 'implements').map((r) => r.to);
    for (const [bid, b] of boundaries) {
      const iface = F.symbols.get(bid)!;
      if (!(names.includes(iface.name) && resolveType(iface.name, s.file)?.id === bid) && !implementsRefs.includes(bid)) continue;
      if (b.users.includes(s.id)) continue;
      b.implementers.push(s.id);
      claims.push({
        role: 'adapter', anchor: s, file: s.file, score: 3, rule: 'role.adapter', confidence: 0.75,
        why: `\`${s.name}\` ${implementsRefs.includes(bid) ? 'implements' : 'returns'} \`${iface.name}\`, the boundary ${b.users.map((u) => `\`${F.symbols.get(u)?.name}\``).join(', ')} call${b.users.length === 1 ? 's' : ''} through`,
        extra: { implements: bid },
      });
    }
  }

  /* ---- bridge: invokes channels someone else handles ---- */
  const invokedByFile = new Map<string, LiteralSite[]>();
  for (const sites of channels.invoked.values()) for (const l of sites) (invokedByFile.get(l.file) ?? invokedByFile.set(l.file, []).get(l.file)!).push(l);
  for (const [file, sites] of [...invokedByFile].sort(([a], [b]) => byString(a, b))) {
    const elsewhere = sites.filter((l) => (channels.handled.get(l.literal) ?? []).some((h) => h.file !== file));
    if (elsewhere.length < 2) continue;
    const anchor = mostCommon(elsewhere.map((l) => topOf(l.in))).map((id) => F.symbols.get(id)).find(Boolean) ?? null;
    claims.push({
      role: 'bridge', anchor, file, score: elsewhere.length, rule: 'role.bridge', confidence: 0.8,
      why: `${file} invokes ${new Set(elsewhere.map((l) => l.literal)).size} channels handled elsewhere (${[...new Set(elsewhere.map((l) => `'${l.literal}'`))].slice(0, 3).join(', ')}…)`,
      extra: { channels: [...new Set(elsewhere.map((l) => l.literal))].sort(byString) },
    });
  }

  /* ---- services: register channel handlers ---- */
  const handledByFile = new Map<string, LiteralSite[]>();
  for (const sites of channels.handled.values()) for (const l of sites) (handledByFile.get(l.file) ?? handledByFile.set(l.file, []).get(l.file)!).push(l);
  for (const [file, sites] of [...handledByFile].sort(([a], [b]) => byString(a, b))) {
    const anchor = mostCommon(sites.map((l) => topOf(l.in))).map((id) => F.symbols.get(id)).find(Boolean) ?? null;
    claims.push({
      role: 'service', anchor, file, score: sites.length, rule: 'role.service.channels', confidence: 0.85,
      why: `${file} registers handlers for ${sites.length} channel${sites.length === 1 ? '' : 's'} (${sites.slice(0, 3).map((l) => `'${l.literal}'`).join(', ')}${sites.length > 3 ? '…' : ''})`,
      extra: { channels: [...new Set(sites.map((l) => l.literal))].sort(byString) },
    });
  }

  /* ---- what each endpoint calls ---- */
  const served: Discovery['served'] = new Map();
  for (const [lit, sites] of [...channels.handled].sort(([a], [b]) => byString(a, b))) {
    for (const site of sites) served.set(lit, [...(served.get(lit) ?? []), { site, targets: handlerTargets(F, site) }]);
  }

  /* ---- hub: emits named events and calls through a boundary ---- */
  const boundaryMembers = new Set([...boundaries.keys()].flatMap((b) => [...memberOf(F.symbols.get(b)!)]));
  for (const s of F.index.symbols) {
    if (!live(s) || !s.exported || !(s.kind === 'function' || s.kind === 'class')) continue;
    const emits = F.literalsWithin(s.id).filter((l) => /^(emit|broadcast|publish)$/.test(l.method));
    if (!emits.length) continue;
    const through = F.refsWithin(s.id).filter((r) => r.kind === 'call' && boundaryMembers.has(r.to)).length
      + F.refsWithin(s.id).filter((r) => r.kind === 'call' && [...boundaries.values()].some((b) => b.users.includes(r.to))).length;
    if (!through) continue;
    claims.push({
      role: 'hub', anchor: s, file: s.file, score: emits.length + through, rule: 'role.hub', confidence: 0.75,
      why: `\`${s.name}\` emits ${[...new Set(emits.map((l) => `'${l.literal}'`))].join(', ')}${through ? ` and calls through a boundary ${through} time${through === 1 ? '' : 's'}` : ''}`,
      extra: { events: [...new Set(emits.map((l) => l.literal))].sort(byString) },
    });
  }

  /* ---- engine: a dispatch table keyed by a union / interface keys ---- */
  const dispatch: Discovery['dispatch'] = [];
  const keyed = F.index.symbols.filter((t) => (t.kind === 'interface' || t.kind === 'type') && live(t));
  for (const v of F.index.symbols) {
    if (v.kind !== 'variable' || !live(v)) continue;
    let keys = F.strings(v, 'keys');
    let keysType: IndexSymbol | null = null;
    const declared = F.declaredType(v) ?? '';
    const mapped = /\[\s*\w+\s+in\s+(\w+)\s*\]|Record<\s*(\w+)\s*,/.exec(declared);
    if (mapped) {
      const t = resolveType(mapped[1] ?? mapped[2], v.file);
      if (t) {
        const viaKeyof = /keyof\s+(\w+)/.exec(t.signature ?? '');
        const src = viaKeyof ? resolveType(viaKeyof[1], t.file) : t;
        const ks = src ? F.keysOf(src) : [];
        if (ks.length >= 3) { keysType = src ?? t; if (!keys.length) keys = ks; }
      }
    }
    if (!keys.length) keys = F.memberSymbols(v.id).map((m) => m.name);
    if (keys.length < 3) continue;
    // Its entries are handlers (functions), not labels; and the module is not UI.
    const fns = F.memberSymbols(v.id).filter((m) => (m.kind === 'function' || m.kind === 'method') && keys.includes(m.name)).length;
    if (fns < Math.max(3, keys.length * 0.6) || (F.inFile.get(v.file) ?? []).some(isUi)) continue;
    if (!keysType) {
      let best: { t: IndexSymbol; j: number } | null = null;
      for (const t of keyed) {
        const tk = F.keysOf(t);
        if (tk.length < 3) continue;
        const inter = tk.filter((k) => keys.includes(k)).length;
        const j = inter / new Set([...tk, ...keys]).size;
        if (j >= 0.8 && (!best || j > best.j || (j === best.j && byString(t.id, best.t.id) < 0))) best = { t, j };
      }
      keysType = best?.t ?? null;
    }
    if (!keysType) continue;
    const readers = [...new Set((F.refsTo.get(v.id) ?? []).filter((r) => r.from !== v.id && !F.isTest(r.from.split('#')[0])).map((r) => r.from))].map((id) => F.symbols.get(id)).filter((s): s is IndexSymbol => !!s && (s.kind === 'function' || s.kind === 'method'));
    const apply = readers.sort((a, b) => applyRank(a) - applyRank(b) || byString(a.id, b.id))[0] ?? null;
    if (!apply) continue;
    dispatch.push({ table: v, keysType, apply, keys });
    claims.push({
      role: 'engine', anchor: apply, file: v.file, score: keys.length, rule: 'role.engine', confidence: 0.85,
      why: `\`${v.name}\` has one entry per key of \`${keysType.name}\` (${keys.length}), and \`${apply.name}\` dispatches through it`,
      extra: { table: v.id, keysType: keysType.id },
    });
  }

  /* ---- store adapters: call sites naming SQL tables/functions ---- */
  for (const s of F.index.symbols) {
    if (!live(s) || !s.exported || !(s.kind === 'function' || s.kind === 'class' || s.kind === 'variable') || s.file.endsWith('.sql')) continue;
    const sql = F.literalsWithin(s.id).filter((l) => F.sqlTables.has(l.literal) || F.sqlFunctions.has(l.literal));
    if (!sql.length) continue;
    claims.push({
      role: 'store-adapter', anchor: s, file: s.file, score: sql.length + 1, rule: 'role.store-adapter', confidence: 0.8,
      why: `\`${s.name}\` names ${[...new Set(sql.map((l) => `${l.method}('${l.literal}')`))].slice(0, 4).join(', ')}`,
      extra: { tables: [...new Set(sql.map((l) => l.literal))].sort(byString) },
    });
  }

  /* ---- services behind endpoints ---- */
  const claimedFiles = new Set(claims.map((c) => c.file));
  for (const [lit, entries] of served) for (const { targets } of entries) for (const t of targets) {
    const top = F.symbols.get(topOf(t.id)) ?? t;
    if (claimedFiles.has(top.file) || F.isTest(top.file) || claims.some((c) => c.anchor?.id === top.id)) continue;
    claims.push({
      role: 'service', anchor: top, file: top.file, score: 1, rule: 'role.service.served', confidence: 0.6,
      why: `the '${lit}' endpoint calls \`${top.name}\``, extra: { channels: [lit] },
    });
  }

  /* ---- one claim per anchor: the most specific role ---- */
  const byAnchor = new Map<string, Claim>();
  const loose: Claim[] = [];
  for (const c of claims) {
    if (!c.anchor) { loose.push(c); continue; }
    const k = c.anchor.id + (c.role === 'bridge' || c.role === 'service' ? `|${c.role}|${c.rule}` : '');
    const prev = byAnchor.get(k);
    if (!prev || PRIORITY.indexOf(c.role) < PRIORITY.indexOf(prev.role) || (prev.role === c.role && c.score > prev.score)) {
      if (prev && prev.role !== c.role) c.extra = { ...prev.extra, ...c.extra, also: prev.role };
      byAnchor.set(k, c);
    } else if (prev.role !== c.role) prev.extra = { ...c.extra, ...prev.extra, also: c.role };
  }
  const final = [...byAnchor.values(), ...loose].sort((a, b) => byString(groupKey(a), groupKey(b)) || b.score - a.score || byString(a.anchor?.id ?? a.file, b.anchor?.id ?? b.file));

  /* ---- group into components ---- */
  const groups = new Map<string, Claim[]>();
  for (const c of final) (groups.get(groupKey(c)) ?? groups.set(groupKey(c), []).get(groupKey(c))!).push(c);
  const components = new Map<string, Component>();
  const usedIds = new Set<string>();
  for (const [key, cs] of [...groups].sort(([a], [b]) => byString(a, b))) {
    cs.sort((a, b) => b.score - a.score || byString(a.anchor?.id ?? '', b.anchor?.id ?? ''));
    const lead = cs[0];
    const name = componentName(lead, cs);
    let id = `component:${nameSlug(name)}`;
    if (usedIds.has(id)) id = `component:${nameSlug(name + ' ' + dirOf(lead.file).split('/').slice(-2).join(' '))}`;
    for (let n = 2; usedIds.has(id); n++) id = `component:${nameSlug(name)}-${n}`;
    usedIds.add(id);
    const files = [...new Set(cs.map((c) => c.file))].sort(byString);
    components.set(id, { id, role: lead.role, kind: ROLE_KIND[lead.role], name, dir: dirOf(lead.file), area: areaOf(lead.file), files, claims: cs, helpers: [] });
    void key;
  }

  /* ---- ownership: anchors, then helpers ---- */
  const owner = new Map<string, string>();
  const fileClaims = new Map<string, Map<string, number>>();
  for (const comp of components.values()) for (const c of comp.claims) {
    if (c.anchor) owner.set(topOf(c.anchor.id), comp.id);
    const m = fileClaims.get(c.file) ?? fileClaims.set(c.file, new Map()).get(c.file)!;
    m.set(comp.id, (m.get(comp.id) ?? 0) + c.score + 10);
  }
  for (const [bid, b] of boundaries) {
    const user = b.users.map((u) => owner.get(topOf(u))).find(Boolean);
    if (user && !owner.has(topOf(bid))) owner.set(topOf(bid), user);
  }
  for (const d of dispatch) {
    d.component = owner.get(topOf(d.apply?.id ?? d.table.id));
    if (d.component) { owner.set(topOf(d.table.id), d.component); if (d.keysType && !owner.has(topOf(d.keysType.id))) owner.set(topOf(d.keysType.id), d.component); }
  }
  const fileOwner = new Map<string, string>();
  for (const [file, m] of fileClaims) fileOwner.set(file, [...m].sort((a, b) => b[1] - a[1] || byString(a[0], b[0]))[0][0]);

  // Unclaimed files: the component in the same directory that imports them most. Repeated so helpers of helpers attach.
  for (let pass = 0; pass < 3; pass++) {
    for (const f of [...F.files.keys()].sort(byString)) {
      if (fileOwner.has(f) || F.isTest(f) || !/^(ts|tsx|js)$/.test(F.files.get(f)!.lang)) continue;
      const counts = new Map<string, number>();
      for (const i of F.importsTo.get(f) ?? []) {
        if (dirOf(i.from) !== dirOf(f)) continue;
        const o = fileOwner.get(i.from);
        if (o) counts.set(o, (counts.get(o) ?? 0) + 1 + i.names.length / 10);
      }
      // Failing that, the one whose files it imports most (a module that only builds on its neighbours).
      if (!counts.size) for (const i of F.importsFrom.get(f) ?? []) {
        if (!i.to || dirOf(i.to) !== dirOf(f)) continue;
        const o = fileOwner.get(i.to);
        if (o) counts.set(o, (counts.get(o) ?? 0) + 1 + i.names.length / 10);
      }
      const best = [...counts].sort((a, b) => b[1] - a[1] || byString(a[0], b[0]))[0];
      if (best) { fileOwner.set(f, best[0]); components.get(best[0])!.helpers.push(f); }
    }
  }
  // Unclaimed top-level symbols in a claimed file with several components: the one they use most.
  for (const [file, m] of fileClaims) {
    if (m.size < 2) continue;
    for (const s of F.inFile.get(file) ?? []) {
      if (s.id !== topOf(s.id) || owner.has(s.id)) continue;
      const counts = new Map<string, number>();
      for (const r of F.refsWithin(s.id)) { const o = owner.get(topOf(r.to)); if (o) counts.set(o, (counts.get(o) ?? 0) + 1); }
      for (const r of F.refsTo.get(s.id) ?? []) { const o = owner.get(topOf(r.from)); if (o) counts.set(o, (counts.get(o) ?? 0) + 1); }
      const best = [...counts].sort((a, b) => b[1] - a[1] || byString(a[0], b[0]))[0];
      if (best) owner.set(s.id, best[0]);
    }
  }
  // A symbol in a helper (or unclaimed-symbol) file of a different component's directory that is used by one
  // component only: e.g. `execute` in a store module used by the engine's own functions.
  for (const [file, comp] of fileOwner) {
    if ((fileClaims.get(file)?.size ?? 0) >= 2) continue;
    for (const s of F.inFile.get(file) ?? []) {
      if (s.id !== topOf(s.id) || owner.has(s.id) || !(s.kind === 'function' || s.kind === 'class')) continue;
      const out = new Map<string, number>();
      for (const r of F.refsWithin(s.id)) { const o = owner.get(topOf(r.to)) ?? fileOwner.get(r.to.split('#')[0]); if (o) out.set(o, (out.get(o) ?? 0) + 1); }
      const best = [...out].sort((a, b) => b[1] - a[1] || byString(a[0], b[0]))[0];
      const target = components.get(best?.[0] ?? '');
      owner.set(s.id, best && best[0] !== comp && target && target.dir === dirOf(file) ? best[0] : comp);
    }
  }

  /* ---- the database ---- */
  let database: Discovery['database'];
  const sqlFiles = [...new Set([...F.sqlTables.values(), ...F.sqlFunctions.values()].map((s) => s.file))].sort(byString);
  if (sqlFiles.length) {
    const top = sqlFiles[0].split('/')[0];
    const name = /^(db|database|sql|migrations|schema)$/i.test(top) || !sqlFiles[0].includes('/') ? 'Database' : `${humanName(top)} database`;
    database = { id: `component:${slug(name)}`, name, files: sqlFiles };
  }

  /* ---- areas and feature subsystems ---- */
  const areas = new Map<string, string[]>();
  for (const c of components.values()) (areas.get(c.area) ?? areas.set(c.area, []).get(c.area)!).push(c.id);
  const tokensOf = (c: Component) => {
    const words = new Set<string>();
    const paths = c.role === 'interface' || c.role === 'engine' ? [c.dir] : c.files.map((f) => `${dirOf(f)}/${baseOf(f)}`);
    for (const p of paths) for (const seg of p.split('/').slice(p.startsWith('src/') ? 2 : 1)) for (const w of slug(seg).split('-')) if (w.length > 2 && !GENERIC.has(w) && !ROLE_WORDS.has(w)) words.add(singular(w));
    for (const w of nameSlug(c.name).split('-')) if (w.length > 2 && !GENERIC.has(w) && !ROLE_WORDS.has(w) && c.role !== 'service') words.add(singular(w));
    return words;
  };
  const tokenAreas = new Map<string, Set<string>>(), tokenComps = new Map<string, string[]>();
  const compTokens = new Map<string, Set<string>>();
  for (const c of components.values()) {
    const t = tokensOf(c);
    compTokens.set(c.id, t);
    for (const w of t) {
      (tokenAreas.get(w) ?? tokenAreas.set(w, new Set()).get(w)!).add(c.area);
      (tokenComps.get(w) ?? tokenComps.set(w, []).get(w)!).push(c.id);
    }
  }
  const featureWords = [...tokenAreas].filter(([w, a]) => a.size >= 3 && !areas.has(w)).map(([w]) => w);
  const features = new Map<string, string[]>();
  for (const c of components.values()) {
    const mine = featureWords.filter((w) => compTokens.get(c.id)!.has(w)).sort((a, b) => tokenComps.get(b)!.length - tokenComps.get(a)!.length || byString(a, b));
    if (mine[0]) { c.feature = mine[0]; (features.get(mine[0]) ?? features.set(mine[0], []).get(mine[0])!).push(c.id); }
  }
  return { channels, components, owner, fileOwner, boundaries, dispatch, served, database, areas, features };
}

/** Interfaces and engines group by directory; bridges and services by file; everything else by its anchor. */
function groupKey(c: Claim): string {
  switch (c.role) {
    case 'interface': case 'engine': return `${c.role}|${dirOf(c.file)}`;
    case 'bridge': case 'service': return `${c.role}|${c.file}`;
    case 'store-adapter': return `${c.role}|${c.file}`;
    case 'adapter': return `${c.role}|${c.file}|${c.extra.implements ?? ''}`;
    default: return `${c.role}|${c.anchor?.id ?? c.file}`;
  }
}

function componentName(lead: Claim, all: Claim[]): string {
  const dirWord = dirOf(lead.file).split('/').pop() ?? '';
  const fileWord = baseOf(lead.file) === 'index' ? dirWord : baseOf(lead.file);
  const withDir = (n: string) => {
    const h = humanName(n);
    return dirWord && !NAME_GENERIC.has(dirWord) && !/^(pass\d+|v\d+)$/.test(dirWord) && !nameSlug(h).split('-').map(singular).includes(singular(slug(dirWord))) ? `${humanName(dirWord)} ${/^[A-Z][a-z]/.test(h) ? h[0].toLowerCase() + h.slice(1) : h}` : h;
  };
  switch (lead.role) {
    case 'engine': return `${humanName(dirWord || fileWord)} engine`;
    case 'bridge': return `${humanName(fileWord)} bridge`;
    case 'service': {
      if (lead.rule === 'role.service.served') return humanName(`${dirWord} ${fileWord}`.trim());
      return dirWord && dirWord !== fileWord && !NAME_GENERIC.has(dirWord) ? humanName(`${dirWord} ${fileWord}`) : humanName(fileWord);
    }
    case 'store-adapter': {
      const anchors = new Set(all.map((c) => c.anchor?.id));
      return anchors.size === 1 && lead.anchor ? withDir(lead.anchor.name) : withDir(fileWord);
    }
    case 'interface': return lead.anchor ? humanName(lead.anchor.name) : humanName(fileWord);
    case 'adapter': {
      const anchors = new Set(all.map((c) => c.anchor?.id));
      return anchors.size === 1 && lead.anchor ? withDir(lead.anchor.name) : withDir(fileWord);
    }
    default: return lead.anchor ? withDir(lead.anchor.name) : humanName(fileWord);
  }
}

const applyRank = (s: IndexSymbol) => (/^(apply|execute|dispatch|run|handle|reduce)/i.test(s.name) ? 0 : 1) + (s.exported ? 0 : 0.5);

function mostCommon(ids: string[]): string[] {
  const n = new Map<string, number>();
  for (const id of ids) n.set(id, (n.get(id) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1] || byString(a[0], b[0])).map(([id]) => id);
}

/**
 * What a handler registration calls: the calls made from the registering symbol on the lines from the
 * registration to the next one, preferring targets in other files (the handler's real work).
 */
export function handlerTargets(F: Facts, site: LiteralSite): IndexSymbol[] {
  const siblings = (F.literalsIn.get(site.in) ?? []).filter((l) => l.method === site.method && l.argIndex === 0).map((l) => l.range.start.line).sort((a, b) => a - b);
  const start = site.range.start.line;
  const next = siblings.find((l) => l > start) ?? Infinity;
  const end = Math.min(next - 1, start + 12);
  const calls = F.refsWithin(site.in)
    .filter((r) => (r.kind === 'call' || r.kind === 'new') && r.range.start.line >= start && r.range.start.line <= end)
    .sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.col - b.range.start.col)
    .map((r) => F.symbols.get(r.to)).filter((s): s is IndexSymbol => !!s);
  const away = calls.filter((s) => s.file !== site.file && !F.isTest(s.file));
  const pick = away.length ? away : calls.filter((s) => s.id !== site.in);
  return pick.slice(0, 1);
}
