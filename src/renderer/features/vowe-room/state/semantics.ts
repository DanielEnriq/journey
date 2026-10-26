import { createContext } from '../../../vendor/preact.js';
import { useContext } from '../../../vendor/preact-hooks.js';
import { NO_SEMANTICS, type CanvasSemantics } from '../contracts/semantics.js';
import type { Evidence } from '../contracts/model.js';

/** Provided once by <VoweRoom> from its `semantics` prop. */
export const SemanticsContext = createContext<CanvasSemantics>(NO_SEMANTICS);
export const useSemantics = (): CanvasSemantics => useContext(SemanticsContext);
/** Resolve evidence ids (cited by threads, decision lines, plans) against the room's evidence. */
export function useEvidence(): (id: string) => Evidence | undefined {
  const { evidence } = useSemantics();
  return (id) => evidence.find((e) => e.id === id);
}
