import { LENSES, RELATION_KINDS, VIEW_SCHEMA, type Entity, type EntityLevel, type Interpretation, type Relation, type SystemRegistry, type ViewRequest } from './model.js';
import { byString, entityId, obj, only, str, SystemInputError } from './registry-utils.js';
import { LENS_RELATIONS, parseViewRequest, presetViews, proposedEntity, proposedRelation } from './view.js';

// What a coding agent reads and does with a registry: a compact catalog of what exists (ids, kinds,
// names, how they relate, the code paths), and three tools — show a view, propose a relation, propose an
// entity — in the shape the Anthropic Messages API takes. A tool call comes back through
// `fromAgentToolCall`, which validates it like any untrusted input; what an agent chooses is drawn as its
// proposal until a person keeps it. The schemas describe; the parsers decide (as in shared/canvas/tools.ts).

export const CATALOG_SCHEMA = 'vowe.system-catalog/1';

export interface CatalogOptions {
  /** Levels to list (default: system, component, element). Code-level entities are many and rarely needed. */
  levels?: EntityLevel[];
  /** Cap on entities listed (default 600); the catalog says when it was cut. */
  maxEntities?: number;
  /** Only this subtree (an entity id and its descendants). */
  within?: string;
}

/** The registry as an agent reads it: compact JSON, ids first. */
export function catalog(reg: SystemRegistry, opts: CatalogOptions = {}) {
  const levels = new Set(opts.levels ?? ['system', 'component', 'element']);
  const max = opts.maxEntities ?? 600;
  const inTree = (e: Entity) => {
    if (!opts.within) return true;
    for (let cur: string | undefined = e.id; cur; cur = reg.entities[cur]?.parent) if (cur === opts.within) return true;
    return false;
  };
  const order: Record<EntityLevel, number> = { system: 0, component: 1, element: 2, code: 3 };
  const all = Object.values(reg.entities).filter((e) => levels.has(e.level) && inTree(e)).sort((a, b) => order[a.level] - order[b.level] || byString(a.id, b.id));
  const listed = all.slice(0, max);
  const ids = new Set(listed.map((e) => e.id));
  const relations = Object.values(reg.relations)
    .filter((r) => r.kind !== 'contains' && ids.has(r.from) && ids.has(r.to))
    .sort((a, b) => byString(a.id, b.id))
    .map((r) => [r.from, r.kind, r.to, ...(r.label ? [r.label] : [])] as [string, string, string, ...string[]]);
  return {
    schema: CATALOG_SCHEMA,
    repo: reg.revision.repo.name,
    revision: reg.revision.head ?? reg.revision.fingerprint,
    rules: reg.rules,
    ...(reg.fixture ? { fixture: reg.fixture } : {}),
    lenses: LENSES.map((l) => ({ lens: l, draws: LENS_RELATIONS[l] })),
    entities: listed.map((e) => ({
      id: e.id, kind: e.kind, name: e.name, level: e.level, ...(e.parent ? { parent: e.parent } : {}),
      ...(e.summary ? { summary: e.summary } : {}), provenance: e.provenance, ...(e.confidence !== undefined ? { confidence: e.confidence } : {}),
      ...(e.status !== 'current' ? { status: e.status } : {}),
    })),
    /** [from, kind, to, label?] */
    relations,
    sequences: Object.values(reg.sequences).sort((a, b) => byString(a.id, b.id)).map((s) => ({
      id: s.id, title: s.title, kind: s.kind, ...(s.subject ? { subject: s.subject } : {}), steps: s.steps.length,
      entities: [...new Set(s.steps.map((st) => st.entity))], ...(s.notes?.length ? { notes: s.notes } : {}),
    })),
    presets: presetViews(reg).map((v) => ({ id: v.id, lens: v.lens, title: v.title, focus: v.focus, ...(v.sequence ? { sequence: v.sequence } : {}) })),
    ...(all.length > listed.length ? { truncated: { listed: listed.length, of: all.length } } : {}),
  };
}

export type SystemCatalog = ReturnType<typeof catalog>;

type Schema = Record<string, unknown>;
export interface SystemToolDefinition { name: 'show_system_view' | 'propose_relation' | 'propose_entity'; description: string; input_schema: Schema }

const ID: Schema = { type: 'string', pattern: '^[a-z][a-z0-9-]*:[A-Za-z0-9_.:/#@-]{1,200}$', description: 'A registry id from the catalog, like "component:canvas-client".' };
const text = (max: number, description?: string): Schema => ({ type: 'string', minLength: 1, maxLength: max, ...(description ? { description } : {}) });
const object = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: 'object', properties, required, additionalProperties: false });
const KIND: Schema = { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,39}$' };

export const SYSTEM_VIEW_TOOLS: SystemToolDefinition[] = [
  {
    name: 'show_system_view',
    description: 'Shows a view of the system that answers a question: name the lens and the entities that matter (ids from the catalog); the canvas adds their parents and neighbours and lays them out. Never give coordinates. Lands as your proposal until a person keeps it.',
    input_schema: object({
      title: text(120), question: text(400, 'The question the view answers, in the person\'s words.'),
      lens: { enum: [...LENSES] },
      focus: { type: 'array', maxItems: 60, items: ID },
      include: { type: 'array', maxItems: 200, items: ID },
      exclude: { type: 'array', maxItems: 200, items: ID },
      relationKinds: { type: 'array', items: { enum: [...RELATION_KINDS] }, description: 'Default: what the lens draws.' },
      depth: { type: 'integer', minimum: 0, maximum: 3, description: 'Relation hops from the focus (default 1; 0 with a sequence).' },
      sequence: { ...ID, description: 'For path and failure: a sequence id from the catalog.' },
      failureAt: text(80, 'For failure: the step id where it goes wrong.'),
      enter: { ...ID, description: 'Open inside this component.' },
      changed: { type: 'array', maxItems: 500, items: text(400), description: 'For change-review: changed files or `file#Symbol`s.' },
      rationale: text(1000, 'Why these, said to the person.'),
    }, ['title', 'question', 'lens']),
  },
  {
    name: 'propose_relation',
    description: 'Proposes a relation the code does not show (or not yet). Drawn dashed as yours until a person accepts it.',
    input_schema: object({ from: ID, to: ID, relation: { enum: [...RELATION_KINDS] }, label: text(80), rationale: text(1000) }, ['from', 'to', 'relation']),
  },
  {
    name: 'propose_entity',
    description: 'Proposes a part that does not exist in the code yet (a new queue, a service to split out). Drawn as proposed.',
    input_schema: object({
      id: ID, kind: KIND, name: text(80), parent: ID, summary: text(400),
      relations: { type: 'array', maxItems: 12, items: object({ to: ID, relation: { enum: [...RELATION_KINDS] }, label: text(80), direction: { enum: ['out', 'in'] } }, ['to', 'relation']) },
      rationale: text(1000),
    }, ['id', 'kind', 'name']),
  },
];

export interface AgentIdentity { id: string; name: string }
const DEFAULT_AGENT: AgentIdentity = { id: 'agent', name: 'Agent' };

export type AgentToolResult =
  | { kind: 'view'; request: ViewRequest }
  | { kind: 'proposal'; request: ViewRequest; interpretation?: Interpretation };

/**
 * A tool call from an agent, validated. Views carry `source.kind = 'agent'`; proposals come back as a view
 * request carrying them (so they can be drawn in context) and, for relations, as a proposed Interpretation
 * the host can keep.
 */
export function fromAgentToolCall(name: string, input: unknown, opts: { agent?: AgentIdentity; now?: string; id?: string } = {}): AgentToolResult {
  const agent = opts.agent ?? DEFAULT_AGENT;
  const source = { kind: 'agent' as const, id: agent.id, name: agent.name };
  const at = opts.now ?? new Date().toISOString();
  const callId = opts.id ?? `${name}-${hashish(JSON.stringify(input ?? null))}`;
  switch (name) {
    case 'show_system_view': {
      const o = obj(input, 'input');
      if ('source' in o || 'proposals' in o || 'schema' in o || 'id' in o) throw new SystemInputError('is not an input of show_system_view', `input.${['source', 'proposals', 'schema', 'id'].find((k) => k in o)}`);
      return { kind: 'view', request: parseViewRequest({ ...o, schema: VIEW_SCHEMA, id: `agent:${callId}`, source }) };
    }
    case 'propose_relation': {
      const o = obj(input, 'input');
      only(o, ['from', 'to', 'relation', 'label', 'rationale'], 'input');
      const rel = proposedRelation({ from: o.from, to: o.to, kind: o.relation, ...(o.label !== undefined ? { label: o.label } : {}) }, 'input');
      if (!(RELATION_KINDS as readonly string[]).includes(rel.kind)) throw new SystemInputError(`must be one of ${RELATION_KINDS.join(', ')}`, 'input.relation');
      const rationale = o.rationale !== undefined ? str(o.rationale, 'input.rationale', 1000) : undefined;
      return {
        kind: 'proposal',
        request: parseViewRequest({
          schema: VIEW_SCHEMA, id: `agent:${callId}`, title: `Proposed: ${rel.from} ${rel.kind} ${rel.to}`, question: rationale ?? 'Should these be related?',
          lens: 'organization', focus: [rel.from, rel.to], depth: 0, source, proposals: { relations: [rel] }, ...(rationale ? { rationale } : {}),
        }),
        interpretation: {
          id: `int:${callId}`, op: { kind: 'relate', from: rel.from, to: rel.to, relation: rel.kind, ...(rel.label ? { label: rel.label } : {}) },
          by: { kind: 'agent', id: agent.id, name: agent.name }, at, status: 'proposed', ...(rationale ? { note: rationale } : {}),
        },
      };
    }
    case 'propose_entity': {
      const o = obj(input, 'input');
      only(o, ['id', 'kind', 'name', 'parent', 'summary', 'relations', 'rationale'], 'input');
      const entity = proposedEntity({ id: o.id, kind: o.kind, name: o.name, ...(o.parent !== undefined ? { parent: o.parent } : {}), ...(o.summary !== undefined ? { summary: o.summary } : {}) }, 'input');
      const rels: Relation[] = [];
      if (o.relations !== undefined) {
        if (!Array.isArray(o.relations) || o.relations.length > 12) throw new SystemInputError('must be an array of at most 12', 'input.relations');
        o.relations.forEach((raw, i) => {
          const r = obj(raw, `input.relations[${i}]`);
          only(r, ['to', 'relation', 'label', 'direction'], `input.relations[${i}]`);
          const other = entityId(r.to, `input.relations[${i}].to`);
          const out = r.direction !== 'in';
          if (r.direction !== undefined && r.direction !== 'in' && r.direction !== 'out') throw new SystemInputError('must be "in" or "out"', `input.relations[${i}].direction`);
          rels.push(proposedRelation({ from: out ? entity.id : other, to: out ? other : entity.id, kind: r.relation, ...(r.label !== undefined ? { label: r.label } : {}) }, `input.relations[${i}]`));
        });
      }
      const rationale = o.rationale !== undefined ? str(o.rationale, 'input.rationale', 1000) : undefined;
      return {
        kind: 'proposal',
        request: parseViewRequest({
          schema: VIEW_SCHEMA, id: `agent:${callId}`, title: `Proposed: ${entity.name}`, question: rationale ?? `What if there were ${entity.name}?`,
          lens: 'organization', focus: [entity.id, ...rels.map((r) => (r.from === entity.id ? r.to : r.from))], depth: 0, source,
          proposals: { entities: [entity], ...(rels.length ? { relations: rels } : {}) }, ...(rationale ? { rationale } : {}),
        }),
      };
    }
  }
  throw new SystemInputError(`unknown tool "${name}"; use one of ${SYSTEM_VIEW_TOOLS.map((t) => t.name).join(', ')}`, 'name');
}

const hashish = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h.toString(36); };
