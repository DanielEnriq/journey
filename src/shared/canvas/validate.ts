import { arr, obj, oneOf, str, type Obj } from './check.js';
import { invalid } from './errors.js';
import {
  ARCHITECTURE_VIEW, CANVAS_SCHEMA, COMPONENT_KINDS, ID_PATTERN, RELATIONSHIP_KINDS, VIEW_TYPES, emptyDocument,
  type CanvasDocument,
} from './model.js';

// Checks a stored document before anything builds on it: the shape, and that every reference points at
// something that exists. Commands are validated field by field (commands.ts) and only produce valid
// documents; this guards against a row someone edited by hand, or a client from a newer schema.

export function parseDocument(raw: unknown): CanvasDocument {
  if (raw === null || raw === undefined) return emptyDocument();
  const d = obj(raw, 'document');
  if (d.schema !== CANVAS_SCHEMA) throw invalid(`is "${String(d.schema)}"; this build reads "${CANVAS_SCHEMA}"`, 'document.schema');
  const map = (k: string) => {
    const m = obj(d[k] ?? {}, `document.${k}`);
    for (const [id, v] of Object.entries(m)) if ((obj(v, `document.${k}.${id}`) as Obj).id !== id) throw invalid('is filed under the wrong id', `document.${k}.${id}`);
    return m as Record<string, Obj>;
  };
  const components = map('components'), relationships = map('relationships'), views = map('views');
  const annotations = map('annotations'), proposals = map('proposals');

  for (const [id, c] of Object.entries(components)) {
    if (!ID_PATTERN.test(id)) throw invalid('is not a stable id', `document.components.${id}`);
    oneOf(c.kind, COMPONENT_KINDS, `document.components.${id}.kind`);
    str(c.name, `document.components.${id}.name`, 80);
    if (c.parent !== undefined && !components[c.parent as string]) throw invalid('points at a missing parent', `document.components.${id}.parent`);
  }
  for (const [id, r] of Object.entries(relationships)) {
    oneOf(r.kind, RELATIONSHIP_KINDS, `document.relationships.${id}.kind`);
    if (!components[r.from as string] || !components[r.to as string]) throw invalid('connects a missing component', `document.relationships.${id}`);
  }
  for (const [id, v] of Object.entries(views)) {
    oneOf(v.type, VIEW_TYPES, `document.views.${id}.type`);
    if (v.focus !== undefined && !components[v.focus as string]) throw invalid('is about a missing component', `document.views.${id}.focus`);
  }
  for (const [id, a] of Object.entries(annotations)) {
    oneOf(a.kind, ['note', 'ink', 'circle'] as const, `document.annotations.${id}.kind`);
    if (a.kind === 'note' && !components[a.on as string]) throw invalid('is on a missing component', `document.annotations.${id}.on`);
  }
  str(d.activeView, 'document.activeView', 64);
  arr(d.history ?? [], 'document.history', 1000);
  return {
    schema: CANVAS_SCHEMA, components, relationships, views, annotations, proposals,
    activeView: d.activeView as string, highlight: (d.highlight ?? null) as CanvasDocument['highlight'],
    history: (d.history ?? []) as CanvasDocument['history'],
  } as unknown as CanvasDocument;
}

/** The first reference that points at nothing, if any: what undoing a change mustn't leave behind. */
export function dangling(doc: CanvasDocument): string | null {
  const has = (id: string | undefined) => !id || !!doc.components[id];
  const view = (id: string) => id === ARCHITECTURE_VIEW || !!doc.views[id];
  for (const c of Object.values(doc.components)) if (!has(c.parent)) return `${c.name} sits in something that’s gone`;
  for (const r of Object.values(doc.relationships)) if (!has(r.from) || !has(r.to)) return `a connection to something that’s gone`;
  for (const v of Object.values(doc.views)) {
    if (!has(v.focus) || !has(v.subject)) return `${v.name} is about something that’s gone`;
    if (v.steps?.some((s) => !has(s.actor))) return `${v.name} has a step by something that’s gone`;
  }
  for (const a of Object.values(doc.annotations)) {
    if (a.kind === 'note' ? !has(a.on) : !view(a.view)) return a.kind === 'note' ? 'a note on something that’s gone' : 'a drawing on a view that’s gone';
    if (a.kind === 'circle' && a.refs.some((r) => !has(r.component))) return 'a circle around something that’s gone';
  }
  return null;
}
