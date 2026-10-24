/**
 * Coding agents (Claude Code, Codex, …) behind one interface. An adapter wraps one agent's CLI
 * or SDK and runs it in main against a Git worktree, so the rest of the app never knows which
 * agent it's talking to.
 *
 * Nothing implements this yet, and nothing orchestrates agents: choosing a worktree, queueing
 * tasks, and showing runs in the UI come later. Keep this the smallest surface every agent can meet.
 */

export interface CodingAgentTask {
  /** Absolute path of the worktree to work in. The agent may read and change anything under it. */
  cwd: string;
  prompt: string;
}

export type CodingAgentEvent =
  /** Text the agent wrote for the user. */
  | { type: 'message'; text: string }
  /** The agent used a tool (edited a file, ran a command); `summary` is one human-readable line. */
  | { type: 'tool'; name: string; summary: string }
  /** The run ended, by finishing, failing, or cancel(). Nothing follows it. */
  | { type: 'exited'; ok: boolean; error: string | null };

export interface CodingAgentRun {
  /** Stops the agent; an `exited` event follows. */
  cancel(): void;
}

/** Whether an agent can run on this machine, e.g. its CLI is installed and signed in. */
export interface CodingAgentAvailability {
  available: boolean;
  version: string | null;
  /** Why it isn't available, for the UI. */
  reason: string | null;
}

export interface CodingAgentAdapter {
  /** Stable key, e.g. "claude-code" or "codex". */
  readonly id: string;
  /** For the UI and logs, e.g. "Claude Code". */
  readonly name: string;
  /** Checks the agent can run, without starting it. */
  detect(): Promise<CodingAgentAvailability>;
  /** Starts the agent on a task; resolves once it's running. */
  start(task: CodingAgentTask, onEvent: (event: CodingAgentEvent) => void): Promise<CodingAgentRun>;
}
