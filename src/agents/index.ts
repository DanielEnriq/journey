import type { CodingAgentAdapter } from './adapter.js';

export type * from './adapter.js';

/** Every coding agent the app knows about. Register adapters here; callers only see the interface. */
export function getCodingAgentAdapters(): CodingAgentAdapter[] {
  return [];
}
