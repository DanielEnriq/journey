import {
  REGISTRY_SCHEMA, slug,
  type Interpretation, type RepoIndex, type Sequence, type SystemRegistry,
} from '../../shared/system/model.js';
import { applyInterpretations, byString, sortedRecord, validateRegistry } from '../../shared/system/registry-utils.js';
import { Builder, humanName } from './builder.js';
import { COMPONENT_RULES, discover, type Discovery } from './components.js';
import { Facts } from './facts.js';
import { buildInternals, firstSentence, INTERNAL_RULES } from './internals.js';
import { buildRelations, RELATION_RULES } from './relations.js';
import { buildSequences, SEQUENCE_RULES } from './sequences.js';

// The registry builder: typed system entities and relations from a RepoIndex, by named rules over code
// facts. Nothing here knows any particular repository: parts are found by what code does (handles input,
// calls through a boundary, registers channels, dispatches by name, names SQL tables), and named from the
// code itself. Same index + same rules → same registry, byte for byte.

export const RULES_VERSION = 'vowe.registry-rules/1.0';

/** Every rule, by id, in words: the evidence an inferred entity or relation cites. */
export const RULES: Record<string, string> = { ...COMPONENT_RULES, ...INTERNAL_RULES, ...RELATION_RULES, ...SEQUENCE_RULES };

export interface BuildOptions {
  /** Skip building code-derived sequences (faster, for diffs). */
  sequences?: boolean;
}

export function buildRegistry(index: RepoIndex, interpretations: Interpretation[] = [], opts: BuildOptions = {}): SystemRegistry {
  const F = new Facts(index);
  const b = new Builder(F);
  const d = discover(F);
  structure(b, d);
  const ins = buildInternals(b, d);
  buildRelations(b, d, ins);
  if (opts.sequences !== false) buildSequences(b, d, ins);

  // Entities resting only on files the index couldn't fully read are unknown, said plainly.
  const unreadable = new Set(index.files.filter((f) => f.status === 'error' || f.status === 'partial').map((f) => f.path));
  for (const e of b.entities.values()) if (e.anchors.length && e.anchors.every((a) => unreadable.has(a.file))) e.status = 'unknown';
  for (const e of b.entities.values()) { e.evidence.sort(byString); e.anchors.sort((x, y) => byString(x.file + (x.symbol ?? ''), y.file + (y.symbol ?? ''))); }
  for (const r of b.relations.values()) { r.evidence.sort(byString); r.via?.sort(byString); }

  let reg: SystemRegistry = {
    schema: REGISTRY_SCHEMA,
    revision: index.revision,
    rules: RULES_VERSION,
    entities: sortedRecord(Object.fromEntries(b.entities)),
    relations: sortedRecord(Object.fromEntries(b.relations)),
    evidence: sortedRecord(Object.fromEntries(b.evidence)),
    sequences: sortedRecord(Object.fromEntries(b.sequences)) as Record<string, Sequence>,
    interpretations: {},
    diagnostics: [],
    coverage: index.coverage,
    incomplete: index.incomplete,
  };
  const problems = validateRegistry(reg).filter((p) => p.severity !== 'info');
  reg.diagnostics = [
    ...b.diagnostics,
    ...problems,
    ...(index.incomplete ? [{ severity: 'warning' as const, message: 'The index was incomplete; parts of the system may be missing.' }] : []),
    { severity: 'info', message: `Registry rules ${RULES_VERSION}: ${Object.keys(RULES).length} rules; entities with provenance "inferred" cite theirs.` },
  ];
  if (interpretations.length) reg = applyInterpretations(reg, interpretations);
  return reg;
}

/** The system, its areas and feature subsystems, its components and the database. */
function structure(b: Builder, d: Discovery) {
  const F = b.facts;
  const repo = F.index.revision.repo;
  const sys = `system:${slug(repo.name || 'repository')}`;
  b.entity({
    id: sys, kind: 'system', name: repo.name || 'Repository', level: 'system', anchors: [], provenance: 'code',
    attrs: { head: F.index.revision.head ?? '', branch: F.index.revision.branch ?? '', files: F.index.files.length },
    evidence: [b.ev('definition', `The repository ${repo.name} at ${F.index.revision.head?.slice(0, 10) ?? 'its working tree'}`, {})],
  });
  const areaRule = b.rule('group.area', COMPONENT_RULES['group.area']);
  const featRule = b.rule('group.feature', COMPONENT_RULES['group.feature']);
  const groupOf = new Map<string, string>();
  for (const [word, comps] of [...d.features].sort(([a], [c]) => byString(a, c))) {
    const id = `subsystem:${slug(word)}`;
    b.entity({
      id, kind: 'subsystem', name: humanName(word), level: 'system', parent: sys, anchors: [], provenance: 'inferred', confidence: 0.7,
      attrs: { grouping: 'feature', word, areas: [...new Set(comps.map((c) => d.components.get(c)!.area))].sort(byString), components: comps.length },
      evidence: [featRule],
    });
    for (const c of comps) groupOf.set(c, id);
  }
  const areaId = (area: string) => {
    const id = `area:${slug(area)}`;
    if (!b.entities.has(id)) b.entity({ id, kind: 'subsystem', name: humanName(area), level: 'system', parent: sys, anchors: [], provenance: 'code', attrs: { grouping: 'area', area }, evidence: [areaRule] });
    return id;
  };
  for (const c of [...d.components.values()].sort((a, x) => byString(a.id, x.id))) {
    const parent = groupOf.get(c.id) ?? areaId(c.area);
    const ev: string[] = [];
    for (const cl of c.claims) {
      ev.push(b.rule(cl.rule, `${COMPONENT_RULES[cl.rule] ?? cl.rule} Here: ${cl.why}.`, `${c.id}|${cl.anchor?.id ?? cl.file}`));
      if (cl.anchor) ev.push(b.def(cl.anchor));
    }
    if (c.helpers.length) ev.push(b.rule('group.helper', `${COMPONENT_RULES['group.helper']} Here: ${c.helpers.join(', ')}.`, c.id));
    const lead = c.claims[0];
    b.entity({
      id: c.id, kind: c.kind, name: c.name, level: 'component', parent,
      anchors: [
        ...c.claims.filter((x) => x.anchor).map((x) => b.anchor(x.anchor!)),
        ...[...new Set([...c.files, ...c.helpers])].filter((f) => !c.claims.some((x) => x.anchor?.file === f)).map((f) => ({ file: f, hash: F.fileHash(f) })),
      ],
      attrs: {
        role: c.role, area: c.area, dir: c.dir, files: [...new Set([...c.files, ...c.helpers])].sort(byString), helpers: c.helpers.slice().sort(byString),
        rules: [...new Set(c.claims.map((x) => x.rule))].sort(byString), ...(c.feature ? { feature: c.feature } : {}),
        ...(lead.anchor ? { anchor: lead.anchor.id } : {}),
        ...Object.fromEntries(Object.entries(lead.extra).filter(([k, v]) => v !== undefined && ['events', 'channels', 'also', 'tables'].includes(k)).map(([k, v]) => [k, v as string | string[]])),
      },
      provenance: 'inferred', confidence: Math.max(...c.claims.map((x) => x.confidence)), evidence: ev,
      summary: lead.anchor?.doc ? firstSentence(lead.anchor.doc) : `${lead.why[0].toUpperCase()}${lead.why.slice(1)}.`,
    });
  }
  if (d.database) {
    const db = d.database;
    const area = F.sqlTables.size || F.sqlFunctions.size ? db.files[0].split('/')[0] : 'db';
    b.entity({
      id: db.id, kind: 'store', name: db.name, level: 'component', parent: areaId(area),
      anchors: db.files.map((f) => ({ file: f, hash: F.fileHash(f) })),
      attrs: { role: 'database', engine: 'sql', tables: F.sqlTables.size, functions: F.sqlFunctions.size, files: db.files },
      provenance: 'code', evidence: [b.rule('role.database', COMPONENT_RULES['role.database'], db.id), ...db.files.slice(0, 6).map((f) => b.ev('sql', `${f} defines SQL objects`, { range: { file: f, start: { line: 1, col: 1 }, end: { line: 1, col: 1 } } }))],
      summary: `${F.sqlTables.size} tables and ${F.sqlFunctions.size} functions defined in ${db.files.length} SQL file${db.files.length === 1 ? '' : 's'}.`,
    });
  }
}

export { RULES as REGISTRY_RULES };
export type { Discovery };
