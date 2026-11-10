import { slug, type ComparisonSite, type IndexSymbol } from '../../shared/system/model.js';
import { byString } from '../../shared/system/registry-utils.js';
import { humanName, type Builder } from './builder.js';
import type { Component, Discovery } from './components.js';
import { topOf } from './facts.js';

// What entering a component reveals: an interface's interactions, a client's state and methods and the
// boundary it calls through, an engine's commands and validators, a service's endpoints, a database's
// tables. Built from the same index facts, each element anchored where the code says it is.

export const INTERNAL_RULES: Record<string, string> = {
  'interface.interactions': 'A string-literal union in an interface\'s files whose members are compared against in its handlers (and listed in a declared array) names its interactions.',
  'client.state': 'A client\'s fields typed as a store, array, map or set, or written by its methods, are its state.',
  'client.method-roles': 'A client method is outgoing when it calls through the boundary, pending when it touches a queue field, reconcile when a boundary subscription calls it, optimistic when it runs the engine\'s apply function.',
  'engine.commands': 'Each key of an engine\'s dispatch table is a command, anchored at its handler.',
  'engine.validator': 'A `parse*`/`validate*` function in an engine\'s files that raises a typed error is a validator.',
  'engine.boundary': 'An interface an engine function takes as a parameter and calls two or more methods of is a boundary of the engine.',
  'service.endpoints': 'Each channel a service registers a handler for is an endpoint.',
  'members.elements': 'Members of a component\'s anchor (methods of a class or of the object a factory returns) are its elements.',
  'sql.objects': 'SQL tables, columns and functions are elements of the database (code).',
};

export const cslug = (componentId: string) => componentId.replace(/^component:/, '');

export interface Internals {
  /** Interaction entity id → the comparison sites that establish it. */
  interactionSites: Map<string, ComparisonSite[]>;
  /** Engine command key → command entity id (first engine wins on a clash). */
  commandByKey: Map<string, string>;
  /** Engine component id → (key → command id). */
  commandsOf: Map<string, Map<string, string>>;
  /** Channel literal → endpoint id. */
  endpointByChannel: Map<string, string>;
  /** SQL bare name → table or store-function id. */
  sqlEntity: Map<string, string>;
  /** Boundary interface symbol id → transport entity id. */
  transportOf: Map<string, string>;
  /** Engine apply-function symbol id → engine component id. */
  applyFns: Map<string, string>;
}

/** Records that an entity stands for a symbol (the first, most specific, claim wins). */
const stand = (b: Builder, sym: string, entity: string) => { if (!b.entityForSymbol.has(sym)) b.entityForSymbol.set(sym, entity); };

export function buildInternals(b: Builder, d: Discovery): Internals {
  const F = b.facts;
  const out: Internals = {
    interactionSites: new Map(), commandByKey: new Map(), commandsOf: new Map(), endpointByChannel: new Map(), sqlEntity: new Map(),
    transportOf: new Map(), applyFns: new Map(),
  };
  const comps = [...d.components.values()].sort((a, b2) => byString(a.id, b2.id));

  // Engines first: interactions and clients point at their commands and apply functions.
  for (const c of comps) if (c.role === 'engine') engine(b, d, c, out);
  for (const c of comps) {
    if (c.role === 'client') client(b, d, c, out);
    if (c.role === 'interface') interactions(b, c, out);
    if (c.role === 'service') service(b, d, c, out);
    if (c.role === 'hub' || c.role === 'adapter' || c.role === 'store-adapter' || (c.role === 'service' && c.claims.some((x) => x.rule === 'role.service.served'))) members(b, c);
  }
  if (d.database) database(b, d, out);
  void F;
  return out;
}

/* ---------- interface ---------- */

function interactions(b: Builder, c: Component, out: Internals) {
  const F = b.facts;
  const files = [...c.files, ...c.helpers];
  const comparisons = files.flatMap((f) => F.comparisonsInFile.get(f) ?? []);
  const candidates: { t: IndexSymbol; members: string[]; hits: Map<string, ComparisonSite[]>; list?: IndexSymbol; items: Record<string, string>[]; score: number }[] = [];
  for (const f of files) for (const t of F.inFile.get(f) ?? []) {
    if (t.kind !== 'type') continue;
    const members = F.keysOf(t).filter((m) => /^[\w-]+$/.test(m));
    if (members.length < 3 || members.length > 40) continue;
    const hits = new Map<string, ComparisonSite[]>();
    for (const cs of comparisons) if (members.includes(cs.literal)) hits.set(cs.literal, [...(hits.get(cs.literal) ?? []), cs]);
    if (hits.size < 2) continue;
    // A declared list of them: an array whose items carry `id`s from the union, or a variable typed by it.
    let list: IndexSymbol | undefined; let items: Record<string, string>[] = [];
    for (const g of files) for (const v of F.inFile.get(g) ?? []) {
      if (v.kind !== 'variable') continue;
      const parsed = F.strings(v, 'items').map((s) => { try { return JSON.parse(s) as Record<string, string>; } catch { return null; } }).filter((x): x is Record<string, string> => !!x);
      const ids = parsed.map((p) => String(p.id ?? p.key ?? p.name ?? ''));
      if (ids.length >= 3 && ids.filter((i) => members.includes(i)).length >= Math.min(3, members.length)) { list = v; items = parsed; break; }
      if (!list && new RegExp(`\\bid:\\s*${t.name}\\b`).test(F.declaredType(v) ?? v.signature ?? '')) list = v;
    }
    candidates.push({ t, members, hits, list, items, score: hits.size + (list ? 3 : 0) });
  }
  // A record mapping keys to members (`{ v: 'select' }`) gives each its key.
  const keyFor = new Map<string, { key: string; sym: IndexSymbol }>();
  for (const f of files) for (const v of F.inFile.get(f) ?? []) {
    const keys = F.strings(v, 'keys'), values = F.strings(v, 'values');
    if (v.kind === 'variable' && keys.length && keys.length === values.length) keys.forEach((k, i) => { if (!keyFor.has(values[i])) keyFor.set(values[i], { key: k, sym: v }); });
  }
  for (const cand of candidates.sort((a, b2) => b2.score - a.score || byString(a.t.id, b2.t.id)).filter((x) => x.score >= 3).slice(0, 2)) {
    const rule = b.rule('interface.interactions', `${INTERNAL_RULES['interface.interactions']} Here: \`${cand.t.name}\` (${cand.members.length} members, ${cand.hits.size} compared${cand.list ? `, listed in \`${cand.list.name}\`` : ''}).`, cand.t.id);
    cand.members.forEach((m, order) => {
      const id = `interaction:${cslug(c.id)}/${slug(m)}`;
      const item = cand.items.find((it) => (it.id ?? it.key ?? it.name) === m);
      const sites = (cand.hits.get(m) ?? []).slice().sort((a, b2) => byString(a.file, b2.file) || a.range.start.line - b2.range.start.line);
      const ev = [rule, b.def(cand.t, `\`${cand.t.name}\` includes '${m}'`), ...(cand.list ? [b.def(cand.list, `\`${cand.list.name}\` lists '${m}'${item?.label ? ` as "${item.label}"` : ''}`)] : [])];
      for (const s of sites.slice(0, 6)) ev.push(b.ev('comparison', `\`${s.subject} === '${m}'\` in \`${s.in.split('#')[1] ?? s.in}\``, { range: s.range, symbol: s.in }));
      const k = keyFor.get(m);
      if (k) ev.push(b.def(k.sym, `\`${k.sym.name}\` maps key '${k.key}' to '${m}'`));
      b.entity({
        id, kind: 'interaction', name: item?.label ?? humanName(m), level: 'element', parent: c.id,
        anchors: [b.anchor(cand.t), ...(cand.list ? [b.anchor(cand.list)] : [])],
        attrs: {
          tool: m, union: cand.t.name, order, compared: sites.length,
          ...(item?.label ? { label: item.label } : {}), ...(item?.title ? { title: item.title } : {}), ...(k ? { key: k.key } : {}),
        },
        provenance: 'inferred', confidence: cand.list ? 0.85 : 0.65, evidence: ev,
        ...(item?.title ? { summary: item.title } : {}),
      });
      out.interactionSites.set(id, sites);
    });
  }
}

/* ---------- client ---------- */

function client(b: Builder, d: Discovery, c: Component, out: Internals) {
  const F = b.facts;
  for (const claim of c.claims) {
    const cls = claim.anchor;
    const bid = claim.extra.boundary as string | undefined;
    if (!cls || !bid) continue;
    const iface = F.symbols.get(bid)!;
    const tid = transport(b, iface, c.id, out, `\`${cls.name}\` calls through it`);
    const ifaceMembers = new Set(F.memberSymbols(iface.id).map((m) => m.id));
    const subscribeMembers = new Set(F.memberSymbols(iface.id).filter((m) => /^on[A-Z]/.test(m.name)).map((m) => m.id));
    const stateIds = new Set((claim.extra.state as string[] | undefined) ?? []);
    const stateRule = b.rule('client.state', INTERNAL_RULES['client.state'], cls.id);
    for (const sid of [...stateIds].sort(byString)) {
      const f = F.symbols.get(sid)!;
      const type = F.declaredType(f) ?? '';
      const role = /Store</.test(type) ? 'store' : /queue|pending|outbox|inflight/i.test(f.name) || /\[\]|Array</.test(type) ? 'queue' : /Map<|Set<|Record</.test(type) ? 'map' : 'value';
      const id = `state:${cslug(c.id)}/${slug(f.name)}`;
      b.entity({
        id, kind: 'state', name: humanName(f.name), level: 'element', parent: c.id, anchors: [b.anchor(f)],
        attrs: { field: f.name, type, role }, provenance: 'inferred', confidence: 0.75,
        evidence: [stateRule, b.def(f, `\`${cls.name}.${f.name}${type ? `: ${type}` : ''}\``)], ...(f.doc ? { summary: firstSentence(f.doc) } : {}),
      });
      stand(b, f.id, id);
    }
    const applyFns = new Set(out.applyFns.keys());
    const methods = F.memberSymbols(cls.id).filter((m) => m.kind === 'method');
    const queueFields = new Set([...stateIds].filter((s) => /queue|pending|outbox|inflight/i.test(F.symbols.get(s)!.name) || /\[\]|Array</.test(F.declaredType(F.symbols.get(s)!) ?? '')));
    // Calls made on the same line as a boundary subscription: the subscription's callback.
    const reconcilers = new Set<string>();
    for (const m of methods) {
      const refs = F.refsWithin(m.id);
      const subLines = new Set(refs.filter((r) => r.kind === 'call' && subscribeMembers.has(r.to)).map((r) => r.range.start.line));
      for (const r of refs) if (r.kind === 'call' && subLines.has(r.range.start.line) && !ifaceMembers.has(r.to)) reconcilers.add(r.to);
    }
    const roleRule = b.rule('client.method-roles', INTERNAL_RULES['client.method-roles'], cls.id);
    for (const m of methods) {
      const refs = F.refsWithin(m.id);
      const roles: string[] = [];
      if (refs.some((r) => r.kind === 'call' && ifaceMembers.has(r.to) && !subscribeMembers.has(r.to))) roles.push('outgoing');
      if (refs.some((r) => r.kind === 'call' && subscribeMembers.has(r.to))) roles.push('subscribe');
      if (refs.some((r) => queueFields.has(r.to))) roles.push('pending');
      if (reconcilers.has(m.id)) roles.push('reconcile');
      if (refs.some((r) => r.kind === 'call' && applyFns.has(r.to))) roles.push('optimistic');
      const id = `method:${cslug(c.id)}/${slug(m.name)}`;
      const ev = [b.def(m, `\`${cls.name}.${m.name}\`${m.signature ? `: ${m.signature}` : ''}`)];
      if (roles.length) ev.push(roleRule);
      for (const r of refs.filter((r) => r.kind === 'call' && (ifaceMembers.has(r.to) || applyFns.has(r.to) || reconcilers.has(r.to))).slice(0, 4)) {
        ev.push(b.ev('call', `\`${cls.name}.${m.name}\` calls \`${F.symbols.get(r.to)?.name ?? r.to}\``, { range: r.range, symbol: m.id }));
      }
      b.entity({
        id, kind: 'method', name: m.name, level: 'element', parent: c.id, anchors: [b.anchor(m)],
        attrs: { roles, ...(m.signature ? { signature: m.signature } : {}), ...(m.attrs?.private || /^private\b/.test(m.signature ?? '') ? { private: true } : {}) },
        provenance: roles.length ? 'inferred' : 'code', ...(roles.length ? { confidence: 0.75 } : {}), evidence: ev,
        ...(m.doc ? { summary: firstSentence(m.doc) } : {}),
      });
      stand(b, m.id, id);
    }
    void tid; void d;
  }
}

/** A boundary interface, as a transport element of the component that calls through it. */
function transport(b: Builder, iface: IndexSymbol, parent: string, out: Internals, why: string): string {
  const F = b.facts;
  const existing = out.transportOf.get(iface.id);
  if (existing) return existing;
  const id = `transport:${slug(iface.name)}`;
  const ms = F.memberSymbols(iface.id);
  b.entity({
    id, kind: 'transport', name: humanName(iface.name), level: 'element', parent, anchors: [b.anchor(iface)],
    attrs: { interface: iface.name, methods: ms.map((m) => m.name) }, provenance: 'inferred', confidence: 0.85,
    evidence: [b.rule('role.client', `A boundary: ${why}.`, iface.id), b.def(iface)], ...(iface.doc ? { summary: firstSentence(iface.doc) } : {}),
  });
  stand(b, iface.id, id);
  for (const m of ms) {
    const mid = `method:${slug(iface.name)}.${slug(m.name)}`;
    b.entity({
      id: mid, kind: 'method', name: m.name, level: 'code', parent: id, anchors: [b.anchor(m)],
      attrs: { boundary: iface.name, ...(m.signature ? { signature: m.signature } : {}) }, provenance: 'code', evidence: [b.def(m)],
      ...(m.doc ? { summary: firstSentence(m.doc) } : {}),
    });
    stand(b, m.id, mid);
  }
  out.transportOf.set(iface.id, id);
  return id;
}

/* ---------- engine ---------- */

function engine(b: Builder, d: Discovery, c: Component, out: Internals) {
  const F = b.facts;
  const files = new Set([...c.files, ...c.helpers]);
  const commands = new Map<string, string>();
  out.commandsOf.set(c.id, commands);
  for (const t of d.dispatch.filter((x) => x.component === c.id)) {
    const rule = b.rule('engine.commands', `${INTERNAL_RULES['engine.commands']} Here: \`${t.table.name}\` keyed by \`${t.keysType?.name ?? '?'}\`.`, t.table.id);
    if (t.apply) {
      const fid = `function:${cslug(c.id)}/${slug(t.apply.name)}`;
      b.entity({
        id: fid, kind: 'function', name: t.apply.name, level: 'element', parent: c.id, anchors: [b.anchor(t.apply)],
        attrs: { role: 'apply', table: t.table.name, ...(t.apply.signature ? { signature: t.apply.signature } : {}) }, provenance: 'inferred', confidence: 0.85,
        evidence: [b.rule('role.engine', 'The function that reads the dispatch table applies commands.', t.apply.id), b.def(t.apply)],
        ...(t.apply.doc ? { summary: firstSentence(t.apply.doc) } : {}),
      });
      stand(b, t.apply.id, fid);
      out.applyFns.set(t.apply.id, c.id);
    }
    const handlers = new Map(F.memberSymbols(t.table.id).map((m) => [m.name, m]));
    const decl = new Map(t.keysType ? F.memberSymbols(t.keysType.id).map((m) => [m.name, m]) : []);
    t.keys.forEach((k, order) => {
      let id = `command:${cslug(c.id)}/${slug(k)}`;
      if ([...b.entities.keys()].includes(id)) id = `${id}-${order}`;
      const h = handlers.get(k), dm = decl.get(k);
      b.entity({
        id, kind: 'command', name: k, level: 'element', parent: c.id,
        anchors: [h ? b.anchor(h) : b.anchor(t.table), ...(dm ? [b.anchor(dm)] : [])],
        attrs: { key: k, order, table: t.table.name, ...(dm?.signature ? { args: dm.signature } : {}), ...(h ? { handler: h.id } : {}) },
        provenance: 'code',
        evidence: [rule, h ? b.def(h, `\`${t.table.name}.${k}\` handles '${k}'`) : b.def(t.table, `\`${t.table.name}\` has key '${k}'`), ...(dm ? [b.def(dm, `\`${t.keysType!.name}.${k}\` declares its arguments`)] : [])],
        ...(dm?.doc ? { summary: firstSentence(dm.doc) } : h?.doc ? { summary: firstSentence(h.doc) } : {}),
      });
      if (h) stand(b, h.id, id);
      if (dm) stand(b, dm.id, id);
      commands.set(k, id);
      if (!out.commandByKey.has(k)) out.commandByKey.set(k, id);
    });
  }
  // Validators.
  const vrule = b.rule('engine.validator', INTERNAL_RULES['engine.validator'], c.id);
  for (const f of [...files].sort(byString)) for (const s of F.inFile.get(f) ?? []) {
    if (s.kind !== 'function' || !s.exported || !/^(parse|validate)[A-Z]/.test(s.name)) continue;
    const typed = F.refsWithin(s.id).filter((r) => {
      const t = F.symbols.get(r.to);
      return !!t && (/Error$/.test(t.name) || /^(invalid|fail|reject|assert)/.test(t.name));
    });
    const id = `validator:${cslug(c.id)}/${slug(s.name)}`;
    b.entity({
      id, kind: 'validator', name: s.name, level: 'element', parent: c.id, anchors: [b.anchor(s)],
      attrs: { ...(s.signature ? { signature: s.signature } : {}), raises: [...new Set(typed.map((r) => F.symbols.get(r.to)!.name))].sort(byString) },
      provenance: 'inferred', confidence: typed.length ? 0.85 : 0.55,
      evidence: [vrule, b.def(s), ...typed.slice(0, 2).map((r) => b.ev('reference', `\`${s.name}\` raises through \`${F.symbols.get(r.to)!.name}\``, { range: r.range, symbol: s.id }))],
      ...(s.doc ? { summary: firstSentence(s.doc) } : {}),
    });
    stand(b, s.id, id);
  }
  // Boundaries the engine's functions take as parameters, and the functions that do.
  for (const [bid, bd] of [...d.boundaries].sort(([a], [b2]) => byString(a, b2))) {
    if (bd.via !== 'param') continue;
    const users = bd.users.map((u) => F.symbols.get(u)!).filter((u) => d.owner.get(topOf(u.id)) === c.id || (files.has(u.file) && !d.owner.has(topOf(u.id))));
    if (!users.length) continue;
    const iface = F.symbols.get(bid)!;
    transport(b, iface, c.id, out, `${users.map((u) => `\`${u.name}\``).join(', ')} take${users.length === 1 ? 's' : ''} it as a parameter and call its methods`);
    const brule = b.rule('engine.boundary', INTERNAL_RULES['engine.boundary'], bid);
    for (const u of users) {
      const id = `function:${cslug(c.id)}/${slug(u.name)}`;
      b.entity({
        id, kind: 'function', name: u.name, level: 'element', parent: c.id, anchors: [b.anchor(u)],
        attrs: { role: 'uses-boundary', boundary: iface.name, ...(u.signature ? { signature: u.signature } : {}) }, provenance: 'inferred', confidence: 0.8,
        evidence: [brule, b.def(u)], ...(u.doc ? { summary: firstSentence(u.doc) } : {}),
      });
      stand(b, u.id, id);
    }
  }
}

/* ---------- services ---------- */

function service(b: Builder, d: Discovery, c: Component, out: Internals) {
  const F = b.facts;
  const rule = b.rule('service.endpoints', INTERNAL_RULES['service.endpoints'], c.id);
  for (const [lit, sites] of [...d.channels.handled].sort(([a], [b2]) => byString(a, b2))) {
    const mine = sites.filter((s) => c.files.includes(s.file));
    if (!mine.length) continue;
    let id = `endpoint:${slug(lit)}`;
    if (b.entities.has(id) && b.entities.get(id)!.parent !== c.id) id = `endpoint:${cslug(c.id)}/${slug(lit)}`;
    const site = mine[0];
    b.entity({
      id, kind: 'endpoint', name: lit, level: 'element', parent: c.id,
      anchors: mine.map((s) => ({ file: s.file, symbol: s.in, range: s.range, hash: F.symbols.get(s.in)?.hash })),
      attrs: { channel: lit, registeredWith: site.callee, ...(lit.startsWith('/') ? { route: lit, method: site.method.toUpperCase() } : {}) },
      provenance: 'code', evidence: [rule, ...mine.map((s) => b.ev('literal', `\`${s.callee}('${lit}', …)\` registers a handler`, { range: s.range, symbol: s.in }))],
    });
    if (!out.endpointByChannel.has(lit)) out.endpointByChannel.set(lit, id);
  }
}

/* ---------- members of an anchor (hub, adapters, served services) ---------- */

function members(b: Builder, c: Component) {
  const F = b.facts;
  const rule = b.rule('members.elements', INTERNAL_RULES['members.elements'], c.id);
  for (const claim of c.claims) {
    const a = claim.anchor;
    if (!a) continue;
    if (claim.rule === 'role.service.served' || (a.kind === 'function' && !F.memberSymbols(a.id).length && c.role === 'service')) {
      const id = `function:${cslug(c.id)}/${slug(a.name)}`;
      b.entity({ id, kind: 'function', name: a.name, level: 'element', parent: c.id, anchors: [b.anchor(a)], attrs: { ...(a.signature ? { signature: a.signature } : {}) }, provenance: 'code', evidence: [b.def(a)], ...(a.doc ? { summary: firstSentence(a.doc) } : {}) });
      stand(b, a.id, id);
    }
    for (const m of F.memberSymbols(a.id)) {
      if (!(m.kind === 'method' || m.kind === 'function' || (m.kind === 'property' && /=>|\(/.test(m.signature ?? '')) || m.kind === 'variable')) continue;
      const type = F.declaredType(m) ?? m.signature ?? '';
      const isState = m.kind === 'variable' && /Map<|Set<|EventEmitter|\[\]|new Map|new Set/.test(type);
      if (m.kind === 'variable' && !isState) continue;
      const id = `${isState ? 'state' : 'method'}:${cslug(c.id)}/${slug(m.name)}`;
      b.entity({
        id, kind: isState ? 'state' : 'method', name: m.name, level: 'element', parent: c.id, anchors: [b.anchor(m)],
        attrs: { ...(m.signature ? { signature: m.signature } : {}), ...(isState ? { type } : {}) }, provenance: 'code',
        evidence: [rule, b.def(m)], ...(m.doc ? { summary: firstSentence(m.doc) } : {}),
      });
      stand(b, m.id, id);
    }
  }
}

/* ---------- the database ---------- */

function database(b: Builder, d: Discovery, out: Internals) {
  const F = b.facts;
  const db = d.database!;
  const rule = b.rule('sql.objects', INTERNAL_RULES['sql.objects'], db.id);
  for (const t of [...F.sqlTables.values()].sort((a, b2) => byString(a.id, b2.id))) {
    const name = t.name.replace(/^public\./, '');
    const id = `table:${slug(name)}`;
    const cols = F.memberSymbols(t.id).filter((m) => m.kind === 'sql-column');
    const keys = cols.filter((m) => m.attrs?.primary || m.attrs?.pk || m.attrs?.key || /primary key/i.test(m.signature ?? '')).map((m) => m.name);
    const refs = cols.filter((m) => /references/i.test(m.signature ?? '') || m.attrs?.references).map((m) => m.name);
    b.entity({
      id, kind: 'table', name, level: 'element', parent: db.id, anchors: [b.anchor(t)],
      attrs: { columns: cols.map((m) => m.name), keys, references: refs, file: t.file }, provenance: 'code', evidence: [rule, b.def(t, `\`create table ${t.name}\``)],
      ...(t.doc ? { summary: firstSentence(t.doc) } : {}),
    });
    stand(b, t.id, id);
    out.sqlEntity.set(name.replace(/^.*\./, ''), id);
    for (const m of cols) {
      const cid = `column:${slug(name)}.${slug(m.name)}`;
      b.entity({
        id: cid, kind: 'column', name: m.name, level: 'code', parent: id, anchors: [b.anchor(m)],
        attrs: { ...(m.signature ? { definition: m.signature } : {}), ...(m.attrs?.type ? { type: String(m.attrs.type) } : {}), key: keys.includes(m.name), references: refs.includes(m.name) },
        provenance: 'code', evidence: [b.def(m)],
      });
      stand(b, m.id, cid);
    }
  }
  for (const f of [...F.sqlFunctions.values()].sort((a, b2) => byString(a.id, b2.id))) {
    const name = f.name.replace(/^public\./, '');
    const id = `store-function:${slug(name)}`;
    b.entity({
      id, kind: 'store-function', name, level: 'element', parent: db.id, anchors: [b.anchor(f)],
      attrs: { ...(f.signature ? { signature: f.signature } : {}), schema: f.name.includes('.') ? f.name.split('.')[0] : 'public' }, provenance: 'code',
      evidence: [rule, b.def(f, `\`create function ${f.name}\``)], ...(f.doc ? { summary: firstSentence(f.doc) } : {}),
    });
    stand(b, f.id, id);
    if (!out.sqlEntity.has(name.replace(/^.*\./, ''))) out.sqlEntity.set(name.replace(/^.*\./, ''), id);
  }
}

export function firstSentence(doc: string): string {
  const t = doc.replace(/\s+/g, ' ').trim();
  const m = /^(.{12,220}?[.!?])(\s|$)/.exec(t);
  return (m ? m[1] : t.slice(0, 220)).trim();
}

/** The most specific registry entity for a symbol: itself, then its containers, then its owner component. */
export function entityOf(b: Builder, d: Discovery, sym: string): string | undefined {
  let cur: string | undefined = sym;
  const F = b.facts;
  while (cur) {
    const e = b.entityForSymbol.get(cur);
    if (e) return e;
    const s = F.symbols.get(cur);
    cur = s ? F.containerOf(s) : undefined;
  }
  return d.owner.get(topOf(sym)) ?? d.fileOwner.get(sym.split('#')[0]);
}

