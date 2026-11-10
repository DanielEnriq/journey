import { relationKey, slug, type IndexReference, type Provenance, type RelationKind } from '../../shared/system/model.js';
import { byString } from '../../shared/system/registry-utils.js';
import { EVIDENCE_CAP, humanName, type Builder } from './builder.js';
import { calleeKey, channelKey } from './channels.js';
import type { Discovery } from './components.js';
import { dirOf, topOf, within } from './facts.js';
import { entityOf, type Internals } from './internals.js';

// How the parts relate: calls rolled up from resolved references, channels matched by their literal,
// SQL reads and writes, events, imports, implementations, tests and the commands interactions produce.
// A relation between two components summarises the finer ones between their elements (`via`).

export const RELATION_RULES: Record<string, string> = {
  'relation.calls': 'Resolved call/new references between symbols of different entities, rolled up to their components.',
  'relation.renders': 'A JSX reference from one component\'s UI to another\'s.',
  'relation.sends': 'A channel literal invoked in one place and registered as a handler in another, matched by its exact text.',
  'relation.bridge-api': 'A call like `x.canvas.execute(…)` whose last two names match a channel (`canvas:execute`) a bridge invokes goes through that bridge.',
  'relation.handles': 'What an endpoint\'s handler calls, on the lines of its registration.',
  'relation.sql-literal': 'A call site whose literal is an indexed table (`.from(\'t\')`) reads it — writes when an insert/update/upsert/delete follows on the line — and one naming a SQL function (`.rpc(\'f\')`) calls it.',
  'relation.sql': 'SQL statements in a function body read or write a table (from the SQL reader).',
  'relation.events': 'A literal emitted in one place and subscribed to (or compared as an event type) in another is an event channel.',
  'relation.depends-on': 'An import between components with no call between them.',
  'relation.implements': 'An adapter whose return type or `implements` clause names a boundary interface.',
  'relation.verified-by': 'A test file referencing a component\'s symbols verifies it; a test naming a command literal verifies that command.',
  'relation.produces': 'An engine command literal (`run(\'draw\', …)`) issued inside a branch guarded by an interaction\'s literal (`tool === \'draw\'`) is produced by that interaction.',
  'relation.issues': 'An engine command literal at a call site in an interface\'s files is issued by that interface.',
};

export function buildRelations(b: Builder, d: Discovery, ins: Internals) {
  const F = b.facts;
  const E = b.entities;
  const ent = (sym: string) => { const e = entityOf(b, d, sym); return e && E.has(e) ? e : undefined; };
  const compOf = (id: string): string | undefined => { let cur: string | undefined = id; while (cur) { const e = E.get(cur); if (!e) return undefined; if (e.level === 'component') return cur; cur = e.parent; } return undefined; };

  /** A relation between the finest entities, and its roll-up between their components. */
  const rolled = (kind: RelationKind, from: string, to: string, ev: string[], prov: Provenance, conf: number | undefined, label?: string, rollKind: RelationKind = kind) => {
    const fc = compOf(from), tc = compOf(to);
    let fine: string | undefined;
    if (!(from === fc && to === tc)) fine = b.relate({ kind, from, to, label, provenance: prov, confidence: conf, evidence: ev })?.id;
    if (fc && tc && fc !== tc) {
      const r = b.relate({ kind: rollKind, from: fc, to: tc, provenance: prov, confidence: conf, evidence: [], ...(fine ? { via: [fine] } : {}), ...(label && rollKind !== 'calls' ? { label } : {}) });
      if (r) for (const e of ev) if (r.evidence.length < EVIDENCE_CAP && !r.evidence.includes(e)) r.evidence.push(e);
    }
  };

  /* contains: every parent link */
  for (const e of [...E.values()].sort((a, c) => byString(a.id, c.id))) {
    if (!e.parent || !E.has(e.parent)) continue;
    const fromSymbol = e.anchors[0]?.symbol && E.get(e.parent)!.anchors.some((a) => a.symbol && F.symbols.get(e.anchors[0].symbol!)?.container && F.containerOf(F.symbols.get(e.anchors[0].symbol!)!) === a.symbol);
    b.contains(e.parent, e.id, e.evidence.slice(0, 2), fromSymbol ? 'code' : e.provenance === 'code' && e.level !== 'component' ? 'code' : 'inferred', fromSymbol ? undefined : e.confidence ?? 0.8);
  }

  /* calls / renders from resolved references */
  const callRefs = F.index.references
    .filter((r) => (r.kind === 'call' || r.kind === 'new' || r.kind === 'jsx') && !F.isTest(r.range.file))
    .sort((a, c) => byString(a.range.file, c.range.file) || a.range.start.line - c.range.start.line || a.range.start.col - c.range.start.col || byString(a.to, c.to));
  for (const r of callRefs) {
    const fe = ent(r.from), te = ent(r.to);
    if (!fe || !te || fe === te) continue;
    // A component calling into its own elements (or the other way) is composition, not a relation worth drawing.
    if (compOf(fe) === compOf(te) && (E.get(fe)!.level === 'component' || E.get(te)!.level === 'component')) continue;
    const kind: RelationKind = r.kind === 'jsx' ? 'renders' : 'calls';
    const ev = b.ev(r.kind === 'jsx' ? 'reference' : 'call', describeRef(b, r), { range: r.range, symbol: r.from });
    rolled(kind, fe, te, [ev], 'code', undefined);
  }

  /* sends: invoked channel → endpoint */
  for (const [lit, sites] of [...d.channels.invoked].sort(([a], [c]) => byString(a, c))) {
    const ep = ins.endpointByChannel.get(lit);
    if (!ep) continue;
    for (const s of sites) {
      const fe = ent(s.in);
      if (!fe) continue;
      rolled('sends', fe, ep, [b.ev('literal', `\`${s.callee}('${lit}', …)\` invokes the channel`, { range: s.range, symbol: s.in })], 'code', undefined, lit);
    }
  }
  /* calls through a bridge API named like a channel: `j.canvas.execute` ↔ 'canvas:execute' */
  const bridgeFor = new Map<string, { comp: string; lit: string }>();
  for (const c of d.components.values()) if (c.role === 'bridge') for (const lit of (c.claims[0].extra.channels as string[] | undefined) ?? []) {
    const k = channelKey(lit);
    if (k && !bridgeFor.has(k)) bridgeFor.set(k, { comp: c.id, lit });
  }
  const bridgeRule = b.rule('relation.bridge-api', RELATION_RULES['relation.bridge-api']);
  for (const flow of [...F.index.flows].sort((a, c) => byString(a.symbol, c.symbol))) {
    if (F.isTest(flow.symbol.split('#')[0])) continue;
    for (const st of flow.steps) {
      const k = calleeKey(st.callee);
      const hit = k ? bridgeFor.get(k) : undefined;
      if (!hit) continue;
      const fe = ent(flow.symbol);
      if (!fe || compOf(fe) === hit.comp) continue;
      rolled('calls', fe, hit.comp, [bridgeRule, b.ev('flow', `\`${st.callee}(…)\` reaches the bridge's '${hit.lit}'`, { range: st.range, symbol: flow.symbol })], 'inferred', 0.7, hit.lit);
    }
  }

  /* handles: endpoint → what serves it */
  const hrule = b.rule('relation.handles', RELATION_RULES['relation.handles']);
  for (const [lit, entries] of [...d.served].sort(([a], [c]) => byString(a, c))) {
    const ep = ins.endpointByChannel.get(lit);
    if (!ep) continue;
    for (const { site, targets } of entries) for (const t of targets) {
      const te = ent(t.id);
      if (!te) continue;
      rolled('handles', ep, te, [hrule, b.ev('call', `the '${lit}' handler calls \`${t.name}\``, { range: site.range, symbol: site.in })], 'inferred', 0.75, lit, 'calls');
    }
  }

  /* reads / writes / calls into SQL from literal sites */
  const sqlRule = b.rule('relation.sql-literal', RELATION_RULES['relation.sql-literal']);
  for (const l of [...F.index.literals].sort((a, c) => byString(a.file, c.file) || a.range.start.line - c.range.start.line)) {
    if (F.isTest(l.file) || l.file.endsWith('.sql')) continue;
    const target = ins.sqlEntity.get(l.literal);
    if (!target) continue;
    const fe = ent(l.in);
    if (!fe) continue;
    const isFn = target.startsWith('store-function:');
    const sameLine = (F.flows.get(l.in)?.steps ?? []).filter((s) => s.range.start.line === l.range.start.line).map((s) => s.callee).join(' ');
    const write = /\.(insert|update|upsert|delete)\b/.test(sameLine) || /^(insert|update|upsert|delete)$/.test(l.method);
    const kind: RelationKind = isFn ? 'calls' : write ? 'writes' : 'reads';
    rolled(kind, fe, target, [sqlRule, b.ev('literal', `\`${l.callee}('${l.literal}')\``, { range: l.range, symbol: l.in })], isFn ? 'code' : write ? 'code' : 'inferred', isFn || write ? undefined : 0.7, l.literal);
  }
  /* SQL bodies */
  for (const r of F.index.references) {
    if (!(r.kind === 'sql-read' || r.kind === 'sql-write' || r.kind === 'sql-call')) continue;
    const fe = ent(r.from), te = ent(r.to);
    if (!fe || !te || fe === te) continue;
    const kind: RelationKind = r.kind === 'sql-write' ? 'writes' : r.kind === 'sql-read' ? 'reads' : 'calls';
    b.relate({ kind, from: fe, to: te, provenance: 'code', evidence: [b.ev('sql', `\`${F.symbols.get(r.from)?.name ?? r.from}\` ${kind === 'calls' ? 'calls' : kind} \`${F.symbols.get(r.to)?.name ?? r.to}\``, { range: r.range, symbol: r.from })] });
  }

  /* events */
  const erule = b.rule('relation.events', RELATION_RULES['relation.events']);
  for (const [lit, ch] of [...d.channels.events].sort(([a], [c]) => byString(a, c))) {
    const pubs = ch.publishers.map((s) => ({ e: ent(s.in), s })).filter((x) => x.e);
    const subs = [...ch.subscribers.map((s) => ({ e: ent(s.in), r: s.range, in: s.in, how: `\`${s.callee}('${lit}', …)\` subscribes` })),
      ...ch.comparisons.map((c) => ({ e: ent(c.in), r: c.range, in: c.in, how: `\`${c.subject} === '${lit}'\` picks it out` }))].filter((x) => x.e);
    if (!pubs.length || !subs.length) continue;
    const pubComps = [...new Set(pubs.map((p) => compOf(p.e!)).filter(Boolean))] as string[];
    const subComps = [...new Set(subs.map((p) => compOf(p.e!)).filter(Boolean))] as string[];
    if (!pubComps.length || !subComps.length || (pubComps.length === 1 && subComps.length === 1 && pubComps[0] === subComps[0])) continue;
    const id = `event-channel:${slug(lit)}`;
    const home = E.get(pubComps.sort(byString)[0])!;
    b.entity({
      id, kind: 'event-channel', name: lit, level: 'component', parent: home.parent, anchors: ch.publishers.slice(0, 3).map((s) => ({ file: s.file, symbol: s.in, range: s.range })),
      attrs: { event: lit, publishers: pubComps.length, subscribers: subComps.length }, provenance: 'inferred', confidence: /[:/.]/.test(lit) ? 0.8 : 0.55,
      evidence: [erule, ...ch.publishers.slice(0, 3).map((s) => b.ev('literal', `\`${s.callee}('${lit}', …)\` emits it`, { range: s.range, symbol: s.in }))],
    });
    if (home.parent) b.contains(home.parent, id, [erule], 'inferred', 0.7);
    for (const p of pubs) rolled('publishes', p.e!, id, [b.ev('literal', `\`${p.s.callee}('${lit}', …)\` emits it`, { range: p.s.range, symbol: p.s.in })], 'inferred', 0.8, lit);
    for (const s of subs) rolled('consumes', s.e!, id, [b.ev(s.how.includes('===') ? 'comparison' : 'literal', s.how, { range: s.r, symbol: s.in })], 'inferred', 0.75, lit);
  }

  /* implements: adapters → the boundary they implement */
  for (const c of [...d.components.values()].sort((a, x) => byString(a.id, x.id))) for (const cl of c.claims) {
    const bid = cl.extra.implements as string | undefined;
    if (!bid || !cl.anchor) continue;
    const t = ins.transportOf.get(bid);
    if (!t) continue;
    b.relate({ kind: 'implements', from: c.id, to: t, provenance: 'code', evidence: [b.def(cl.anchor, `\`${cl.anchor.signature ?? cl.anchor.name}\``), b.rule('relation.implements', RELATION_RULES['relation.implements'])] });
    // Its members, matched by name to the boundary's.
    const boundaryMembers = new Map(F.memberSymbols(bid).map((m) => [m.name, m]));
    for (const m of F.memberSymbols(cl.anchor.id)) {
      const bm = boundaryMembers.get(m.name);
      const me = ent(m.id), be = bm ? ent(bm.id) : undefined;
      if (me && be && me !== c.id) b.relate({ kind: 'implements', from: me, to: be, provenance: 'code', evidence: [b.def(m)] });
    }
  }

  /* depends_on: imports without calls */
  const imps = new Map<string, string[]>();
  for (const i of F.index.imports) {
    if (!i.to || F.isTest(i.from)) continue;
    const fc = d.fileOwner.get(i.from), tc = d.fileOwner.get(i.to);
    if (!fc || !tc || fc === tc || !E.has(fc) || !E.has(tc)) continue;
    const k = `${fc}|${tc}`;
    const ev = b.ev('import', `${i.from} imports ${i.names.slice(0, 4).join(', ')}${i.names.length > 4 ? '…' : ''} from ${i.to}`, { range: i.range });
    imps.set(k, [...(imps.get(k) ?? []), ev]);
  }
  const drule = b.rule('relation.depends-on', RELATION_RULES['relation.depends-on']);
  for (const [k, evs] of [...imps].sort(([a], [c]) => byString(a, c))) {
    const [fc, tc] = k.split('|');
    const linked = ['calls', 'renders', 'sends', 'reads', 'writes', 'implements', 'publishes', 'consumes'].some((kind) => b.relations.has(relationKey(fc, kind, tc)));
    if (linked) continue;
    b.relate({ kind: 'depends_on', from: fc, to: tc, provenance: 'code', evidence: [drule, ...evs.slice(0, EVIDENCE_CAP - 1)] });
  }

  /* produces: interaction → command; issues: interface → command */
  const prule = b.rule('relation.produces', RELATION_RULES['relation.produces']);
  const irule = b.rule('relation.issues', RELATION_RULES['relation.issues']);
  for (const [iid, sites] of [...ins.interactionSites].sort(([a], [c]) => byString(a, c))) {
    const iface = E.get(iid)!.parent!;
    const commands = new Map([...ins.commandByKey]);
    for (const cs of sites) {
      if (!cs.branch) continue;
      for (const l of F.literalsInFile.get(cs.file) ?? []) {
        const cmd = commands.get(l.literal);
        if (!cmd || !within(l.range, cs.branch)) continue;
        rolled('produces', iid, cmd, [prule, b.ev('comparison', `\`${cs.subject} === '${cs.literal}'\` guards the branch`, { range: cs.range, symbol: cs.in }), b.ev('literal', `\`${l.callee}('${l.literal}', …)\` issues the command`, { range: l.range, symbol: l.in })], 'inferred', 0.8, l.literal);
      }
    }
    void iface;
  }
  for (const c of [...d.components.values()].filter((x) => x.role === 'interface').sort((a, x) => byString(a.id, x.id))) {
    for (const f of [...c.files, ...c.helpers]) for (const l of F.literalsInFile.get(f) ?? []) {
      const cmd = ins.commandByKey.get(l.literal);
      if (!cmd || l.argIndex !== 0 || compOf(cmd) === c.id) continue;
      b.relate({ kind: 'produces', from: c.id, to: cmd, label: l.literal, provenance: 'inferred', confidence: 0.7, evidence: [irule, b.ev('literal', `\`${l.callee}('${l.literal}', …)\` in \`${l.in.split('#')[1] || l.file}\``, { range: l.range, symbol: l.in })] });
    }
  }

  /* verified_by: tests */
  const vrule = b.rule('relation.verified-by', RELATION_RULES['relation.verified-by']);
  for (const tf of [...F.tests].sort(byString)) {
    const counts = new Map<string, { n: number; ev: string[] }>();
    const note = (comp: string | undefined, ev: () => string) => {
      if (!comp) return;
      const c = counts.get(comp) ?? counts.set(comp, { n: 0, ev: [] }).get(comp)!;
      c.n++;
      if (c.ev.length < 4) c.ev.push(ev());
    };
    for (const r of F.index.references) {
      if (r.range.file !== tf || F.isTest(r.to.split('#')[0])) continue;
      const te = ent(r.to);
      note(te ? compOf(te) : undefined, () => b.ev('test', `${tf} uses \`${F.symbols.get(r.to)?.name ?? r.to}\``, { range: r.range, symbol: r.from }));
    }
    if (!counts.size) continue;
    const ranked = [...counts].sort((a, c) => c[1].n - a[1].n || byString(a[0], c[0]));
    const cases = (F.inFile.get(tf) ?? []).filter((s) => s.kind === 'test-case');
    const id = `test:${slug(tf.replace(/\.[^.]+$/, ''))}`;
    b.entity({
      id, kind: 'test', name: humanName(tf.split('/').pop()!.replace(/\.test\.[^.]+$/, '')) + ' tests', level: 'element', parent: ranked[0][0],
      anchors: [{ file: tf, hash: F.fileHash(tf) }], attrs: { file: tf, cases: cases.length, caseNames: cases.slice(0, 40).map((c) => c.name) },
      provenance: 'code', evidence: [b.ev('test', `${tf} (${cases.length} test cases)`, { range: { file: tf, start: { line: 1, col: 1 }, end: { line: 1, col: 1 } } })],
    });
    for (const s of cases) b.entityForSymbol.set(s.id, id);
    for (const [comp, { n, ev }] of ranked) {
      if (n < 2 && comp !== ranked[0][0]) continue;
      b.relate({ kind: 'verified_by', from: comp, to: id, provenance: 'inferred', confidence: n >= 5 ? 0.85 : 0.6, evidence: [vrule, ...ev] });
    }
    for (const l of F.literalsInFile.get(tf) ?? []) {
      const cmd = ins.commandByKey.get(l.literal);
      if (!cmd) continue;
      b.relate({ kind: 'verified_by', from: cmd, to: id, provenance: 'inferred', confidence: 0.6, evidence: [vrule, b.ev('test', `${tf} issues '${l.literal}' (\`${l.callee}\`)`, { range: l.range, symbol: l.in })] });
    }
  }
  void topOf; void dirOf;
}

function describeRef(b: Builder, r: IndexReference): string {
  const F = b.facts;
  const from = F.symbols.get(r.from)?.id.split('#')[1] || r.from.split('#')[0];
  const to = F.symbols.get(r.to)?.id.split('#')[1] ?? r.to;
  return r.kind === 'jsx' ? `\`${from}\` renders <${to}>` : r.kind === 'new' ? `\`${from}\` constructs \`${to}\`` : `\`${from}\` calls \`${to}\``;
}
