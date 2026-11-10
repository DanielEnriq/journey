import type { Entity, Provenance, Relation, SourceRange, SystemRegistry, ViewRequest } from './model.js';
import { ancestors, componentOf } from './registry-utils.js';

// What a person means by "this". When someone points at the canvas and says "what writes to this?",
// the agent gets a PointingContext instead of a name read aloud: which entities, relations, steps or
// regions were indicated, how (hover, click, circle, keyboard), where each sits in the system, and the
// evidence behind it. Built from the registry and the canvas's own state, never from pixels, so the same
// reference means the same thing at every zoom level and inside or outside a component.
//
// It is a superset of the room canvas's existing selection (`{ selected, circled }`, the assistant's
// canvas-snapshot contract), and `toSnapshotSelection` maps it back for the current runtime.
//
// No agent or voice runs here yet: the canvas builds this on every pointing change and shows the person
// what Vowe would understand ("Supabase database · storage"), with the alternatives to correct it.

export const POINTING_SCHEMA = 'vowe.pointing/1';

/** How the person indicated something. Hover is weakest: it is a candidate until clicked, circled or spoken over. */
export type Gesture = 'hover' | 'click' | 'circle' | 'keyboard' | 'voice-hover';

export type ReferentTarget =
  | { kind: 'entity'; id: string }
  | { kind: 'relation'; id: string }
  | { kind: 'step'; sequence: string; step: string }
  /** An empty area of a component's interior or a process region: what it is inside. */
  | { kind: 'region'; within: string };

export interface Referent {
  target: ReferentTarget;
  /** Plain name for the reference chip: "Supabase database", "client → transport · execute". */
  name: string;
  /** Entity or relation kind; `step` or `region` otherwise. */
  kind: string;
  /** Outermost first: system → subsystem → component → element. Lets "this" keep its place across levels. */
  path: { id: string; name: string; kind: string }[];
  /** The component it belongs to, for entities below component level. */
  component?: string;
  provenance?: Provenance;
  confidence?: number;
  /** The first few evidence ranges, so an agent can open the code without another lookup. */
  evidence: { id: string; summary: string; range?: SourceRange }[];
  evidenceCount: number;
  /** For relations: its ends, by name. */
  ends?: { from: string; to: string };
}

export interface PointingContext {
  schema: typeof POINTING_SCHEMA;
  /** What the person means now, most specific first. */
  referents: Referent[];
  gesture: Gesture;
  /** Next-best readings for "no, the other one": nearby or overlapping targets, nearest first. */
  alternatives: Referent[];
  /** Where the person is standing: the entered path (component ids), outermost first. */
  entered: string[];
  view: { id: string; lens: ViewRequest['lens']; title: string; question: string };
  /** The registry revision the reference was made against. */
  revision: { repo: string; head: string | null; fingerprint: string };
  /** Whether the registry is a labelled fixture (no repository behind it). */
  fixture?: boolean;
}

export interface PointingInput {
  targets: ReferentTarget[];
  gesture: Gesture;
  /** Candidates under or near the pointer, nearest first (the canvas knows the geometry; this only names them). */
  nearby?: ReferentTarget[];
  entered: string[];
  view: ViewRequest;
}

const EVIDENCE_SHOWN = 3;

export function referent(reg: SystemRegistry, t: ReferentTarget): Referent | null {
  const named = (id: string) => ({ id, name: reg.entities[id]?.name ?? id, kind: String(reg.entities[id]?.kind ?? 'unknown') });
  const pathOf = (id: string) => [...ancestors(reg, id).reverse(), id].filter((x) => reg.entities[x]).map(named);
  const ev = (ids: string[]) => ({
    evidence: ids.slice(0, EVIDENCE_SHOWN).flatMap((id) => {
      const e = reg.evidence[id];
      return e ? [{ id, summary: e.summary, ...(e.range ? { range: e.range } : {}) }] : [];
    }),
    evidenceCount: ids.length,
  });
  switch (t.kind) {
    case 'entity': {
      const e: Entity | undefined = reg.entities[t.id];
      if (!e) return null;
      const comp = componentOf(reg, e.id);
      return {
        target: t, name: e.name, kind: String(e.kind), path: pathOf(e.id),
        ...(comp && comp !== e.id ? { component: comp } : {}),
        provenance: e.provenance, ...(e.confidence !== undefined ? { confidence: e.confidence } : {}),
        ...ev(e.evidence),
      };
    }
    case 'relation': {
      const r: Relation | undefined = reg.relations[t.id];
      if (!r) return null;
      const from = reg.entities[r.from]?.name ?? r.from, to = reg.entities[r.to]?.name ?? r.to;
      return {
        target: t, name: `${from} → ${to}${r.label ? ` · ${r.label}` : ''}`, kind: String(r.kind),
        path: pathOf(r.from), ends: { from, to },
        provenance: r.provenance, ...(r.confidence !== undefined ? { confidence: r.confidence } : {}),
        ...ev(r.evidence),
      };
    }
    case 'step': {
      const s = reg.sequences[t.sequence]?.steps.find((x) => x.id === t.step);
      if (!s) return null;
      const comp = componentOf(reg, s.entity);
      return {
        target: t, name: s.label, kind: 'step', path: pathOf(s.entity), ...(comp ? { component: comp } : {}),
        provenance: reg.sequences[t.sequence].provenance, ...ev(s.evidence),
      };
    }
    case 'region': {
      const w = reg.entities[t.within];
      if (!w) return null;
      return { target: t, name: `inside ${w.name}`, kind: 'region', path: pathOf(w.id), provenance: w.provenance, ...ev(w.evidence) };
    }
  }
}

const sameTarget = (a: ReferentTarget, b: ReferentTarget) => JSON.stringify(a) === JSON.stringify(b);

/** The context a future voice/pointer agent receives. Unknown ids are dropped, never guessed. */
export function pointingContext(reg: SystemRegistry, input: PointingInput): PointingContext {
  const referents = input.targets.map((t) => referent(reg, t)).filter((r): r is Referent => !!r);
  const alternatives = (input.nearby ?? [])
    .filter((t) => !input.targets.some((x) => sameTarget(x, t)))
    .map((t) => referent(reg, t)).filter((r): r is Referent => !!r);
  return {
    schema: POINTING_SCHEMA,
    referents, gesture: input.gesture, alternatives,
    entered: input.entered.filter((id) => reg.entities[id]),
    view: { id: input.view.id, lens: input.view.lens, title: input.view.title, question: input.view.question },
    revision: { repo: reg.revision.repo.name, head: reg.revision.head, fingerprint: reg.revision.fingerprint },
    ...(reg.fixture ? { fixture: true } : {}),
  };
}

/** "No, the other one": the next alternative becomes the referent; the old one becomes an alternative. */
export function correct(ctx: PointingContext, pick = 0): PointingContext {
  const next = ctx.alternatives[pick];
  if (!next) return ctx;
  const rest = ctx.alternatives.filter((_, i) => i !== pick);
  return { ...ctx, referents: [next], alternatives: [...ctx.referents, ...rest] };
}

/** The room runtime's current selection shape (assistant canvas-snapshot contract): component ids only. */
export function toSnapshotSelection(ctx: PointingContext, reg: SystemRegistry): { selected: string[]; circled: string[] } {
  const comps = [...new Set(ctx.referents.flatMap((r) => {
    if (r.target.kind === 'entity') return [componentOf(reg, r.target.id) ?? r.target.id];
    if (r.target.kind === 'relation') { const rel = reg.relations[r.target.id]; return rel ? [rel.from, rel.to].map((x) => componentOf(reg, x) ?? x) : []; }
    return r.component ? [r.component] : [];
  }))];
  return ctx.gesture === 'circle' ? { selected: [], circled: comps } : { selected: comps, circled: [] };
}
