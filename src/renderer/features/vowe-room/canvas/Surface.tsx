import { h, useStore, type CanvasClient, type ComponentChildren } from '../journey.js';
import { CanvasSurface, type PartMarks } from '../../canvas/CanvasSurface.js';
import type { Scenario } from '../contracts/semantics.js';
import { useSemantics } from '../state/semantics.js';
import { useNames } from '../state/directory.js';
import type { Ui } from '../state/ui.js';

// The Pass 3 room's canvas: Journey's one canvas engine (features/canvas/CanvasSurface.tsx), given the
// room's own UI store (so the Desk sees the same selection and open part), the record's marks on each
// part, the room's semantics and the agent's name, and the call's lens. Nothing here draws or handles a
// gesture; the engine does, the same one Journey's other rooms and the harness use.

export type { PartMarks } from '../../canvas/CanvasSurface.js';
export { circled, refKey } from '../../canvas/geometry.js';

export interface SurfaceProps {
  client: CanvasClient;
  ui: Ui;
  marks: Record<string, PartMarks>;
  /** Components the Desk is pointing at (the option or PR you're looking at). */
  lit?: string[];
  onAsk?(about: { components: string[]; names: string[] }): void;
  onScenario?(component: string, s: Scenario): void;
  /** Told after the canvas's Concurrency instrument ran its commands (show_view / set_instances): n copies now run. */
  onCopies?(n: number): void;
  onComment?(x: number, y: number, on: { component: string; name: string } | null): void;
  onMarks?(component: string): void;
  anchored?(place: (x: number, y: number) => { x: number; y: number }, width: number, partRect: (component: string) => number[] | null): ComponentChildren;
  /** Room under the canvas kept clear for captions. */
  reserve?: number;
  /** A call is on: the view can follow the call or be just yours. */
  inCall?: boolean;
  children?: ComponentChildren;
}

export function Surface({ client, ui, marks, lit, onAsk, onScenario, onCopies, onComment, onMarks, anchored, reserve, inCall, children }: SurfaceProps) {
  const { agentName, person } = useNames();
  const semantics = useSemantics();
  const { since } = useStore(ui);
  return (
    <CanvasSurface client={client} ui={ui} marks={marks} lit={lit} semantics={semantics} agentName={agentName()} since={since}
      onAsk={onAsk ? ({ components, names }) => onAsk({ components, names }) : undefined}
      onScenario={onScenario} onCopies={onCopies} onComment={onComment} onMarks={onMarks} anchored={anchored} toneOf={(id) => { const t = person(id).tone; return t && t !== 'me' ? t : undefined; }} reserve={reserve} inCall={inCall}>
      {children}
    </CanvasSurface>
  );
}
