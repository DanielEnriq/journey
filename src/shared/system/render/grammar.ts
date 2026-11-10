import type { EntityStatus, Lens, Provenance, RelationKind } from '../model.js';

// Which kinds each lens draws by default is the view's business (view.ts LENS_RELATIONS); this file only
// says how each kind looks.
import type { RelationGrammar } from './scene.js';

// The relation grammar: what each kind of connection looks like, so a line says what it means by its
// weight, pattern and ends, not by colour. Dashes are kept for "not confirmed" (proposed, interpretation),
// as everywhere else in Vowe, so no relation kind is dashed by nature.

const G = (kind: RelationKind, says: string, line: RelationGrammar['line'], start: RelationGrammar['start'], end: RelationGrammar['end'], flow: RelationGrammar['flow'], marksBoundary = false): RelationGrammar =>
  ({ kind, says, line, start, end, flow, marksBoundary });

export const GRAMMAR: Record<string, RelationGrammar> = {
  calls: G('calls', 'calls — control passes over and comes back', 'solid', 'none', 'arrow', 'forward', true),
  sends: G('sends', 'sends — a message crosses a boundary on a named channel', 'double', 'none', 'arrow', 'forward', true),
  handles: G('handles', 'handles — receives on an endpoint it owns', 'solid', 'none', 'socket', 'forward', true),
  writes: G('writes', 'writes — deposits data into a table or state', 'heavy', 'none', 'bracket', 'forward'),
  reads: G('reads', 'reads — draws data out (arrow shows the data coming back)', 'thin', 'arrow', 'tap', 'forward'),
  publishes: G('publishes', 'publishes — announces an event, nobody waits', 'dotted', 'none', 'ring', 'forward', true),
  consumes: G('consumes', 'consumes — takes events or jobs from a channel or queue', 'dotted', 'ring', 'arrow', 'reverse', true),
  depends_on: G('depends_on', 'depends on — built with it (imports, types); no runtime traffic', 'hairline', 'none', 'bar', 'forward'),
  implements: G('implements', 'implements — fulfils an interface', 'hairline', 'none', 'triangle', 'none'),
  verified_by: G('verified_by', 'verified by — a test exercises it', 'hairline', 'none', 'tick', 'none'),
  produces: G('produces', 'produces — creates a value or document others use', 'solid', 'none', 'diamond', 'forward'),
  renders: G('renders', 'renders — draws it on screen', 'thin', 'none', 'open-arrow', 'forward'),
  precedes: G('precedes', 'precedes — happens before', 'thin', 'none', 'chevron', 'forward'),
  contains: G('contains', 'contains — drawn as nesting, not a line', 'hairline', 'none', 'none', 'none'),
};

/** A relation kind nobody has a grammar for is drawn plainly with its name written on it. */
export function grammarFor(kind: RelationKind): RelationGrammar {
  return GRAMMAR[kind] ?? G(kind, `${kind} — a relation kind without its own drawing; the name is written on the line`, 'thin', 'none', 'open-arrow', 'none');
}

/** Which way a lens reads. Failure reads top-down, like attempts stacked one under another. */
export const LENS_FLOW: Record<Lens, 'right' | 'down'> = {
  organization: 'right', path: 'right', failure: 'down', dataflow: 'right', 'interface-change': 'right', 'change-review': 'right',
};

/** Order of certainty: a rolled-up connection is as established as its best-evidenced member. */
export const PROVENANCE_ORDER: Provenance[] = ['code', 'observed', 'inferred', 'interpretation', 'proposed'];

/** Words drawn beside a provenance mark. The mark itself differs in shape, never colour alone. */
export const PROVENANCE_SAYS: Record<Provenance, string> = {
  code: 'established from code',
  observed: 'seen in a recorded trace',
  inferred: 'inferred by a named rule',
  interpretation: 'someone’s interpretation',
  proposed: 'proposed — not in the code',
};

export const STATUS_SAYS: Record<EntityStatus, string> = {
  current: 'matches the index',
  changed: 'its code changed since you last looked',
  stale: 'files changed on disk since indexing',
  missing: 'no longer found in the code',
  new: 'new since you last looked',
  unknown: 'indexing was incomplete here',
};
