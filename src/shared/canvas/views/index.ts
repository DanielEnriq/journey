import { CanvasError } from '../errors.js';
import { ARCHITECTURE_VIEW, type Actor, type CanvasDocument, type ViewSpec } from '../model.js';
import { architecture } from './architecture.js';
import { concurrencyScene } from './concurrency.js';
import { failureScene } from './failure.js';
import { readSystem, type Scene } from './scene.js';

export * from './scene.js';
export { castOf, failSteps, happySteps } from './failure.js';

const SYSTEM: Actor = { kind: 'human', id: 'system', name: 'Vowe' };

/** Every document has an Architecture view, whether or not anyone saved one. */
export function implicitArchitecture(): ViewSpec {
  return {
    id: ARCHITECTURE_VIEW, type: 'architecture', name: 'Architecture', question: 'What is this system?',
    provenance: 'From the room’s system', status: 'agreed', by: SYSTEM, at: new Date(0).toISOString(),
  };
}

export function viewsOf(doc: CanvasDocument): ViewSpec[] {
  const views = Object.values(doc.views);
  return views.some((v) => v.id === ARCHITECTURE_VIEW) ? views : [implicitArchitecture(), ...views];
}

export function viewOf(doc: CanvasDocument, id: string): ViewSpec | undefined {
  return doc.views[id] ?? (id === ARCHITECTURE_VIEW ? implicitArchitecture() : undefined);
}

/** Lays out one view of the document. Throws if the view can't be drawn from what the document says. */
export function buildScene(doc: CanvasDocument, viewId: string): Scene {
  const spec = viewOf(doc, viewId);
  if (!spec) throw new CanvasError('not-found', `No view "${viewId}" on this canvas`);
  const sys = readSystem(doc);
  if (spec.type === 'architecture') return architecture(spec, sys);
  if (spec.type === 'failure-flow') return failureScene(spec, sys);
  return concurrencyScene(spec, sys);
}

/** Every view that can be drawn, by id; a view whose components were removed is left out, not thrown. */
export function buildScenes(doc: CanvasDocument): Record<string, Scene> {
  const out: Record<string, Scene> = {};
  for (const v of viewsOf(doc)) {
    try { out[v.id] = buildScene(doc, v.id); } catch { /* drawn again once its components are back */ }
  }
  return out;
}
