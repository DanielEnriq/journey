import type { CodingAgentAdapter } from './adapter.js';

export type * from './adapter.js';

/** Every coding agent the app knows about. Register adapters here; callers only see the interface. */
export function getCodingAgentAdapters(): CodingAgentAdapter[] {
  return [];
}

/** Read-only access to Claude Code's local session history. Not a CodingAgentAdapter: it never starts a run. */
export { ClaudeCodeAdapter } from './claude-code.js';
