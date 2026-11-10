import type { Lens, ResolvedView, SystemRegistry, ViewRequest } from '../../../shared/system/model.js';
import { parseViewRequest, presetViews, resolveView } from '../../../shared/system/view.js';

// The views the page offers before any agent is involved come from the registry's own presets (one per
// lens its facts support); each is a plain ViewRequest — exactly what an agent would send — so the
// harness panel can show and edit it. Validation and resolution are the registry's (view.ts), the same
// gate an agent's request goes through.

export const LENS_LABEL: Record<Lens, string> = {
  organization: 'Organization', path: 'Path', failure: 'Failure', dataflow: 'Dataflow', 'interface-change': 'Interface', 'change-review': 'Change review',
};

export function presets(reg: SystemRegistry, changedFiles: string[] = []): ViewRequest[] {
  return presetViews(reg, changedFiles.length ? { changed: changedFiles } : {});
}

/** Validates a request the way an agent's is checked; the error names the field that is wrong. */
export function validateRequest(raw: unknown, reg: SystemRegistry | null): { ok: true; request: ViewRequest } | { ok: false; errors: string[] } {
  try {
    const request = parseViewRequest(raw);
    const errors: string[] = [];
    if (reg && request.sequence && !reg.sequences[request.sequence]) errors.push(`view.sequence: "${request.sequence}" is not in this registry.`);
    return errors.length ? { ok: false, errors } : { ok: true, request };
  } catch (e) {
    return { ok: false, errors: [(e as Error).message] };
  }
}

export function resolve(reg: SystemRegistry, req: ViewRequest): ResolvedView {
  return resolveView(reg, req);
}
