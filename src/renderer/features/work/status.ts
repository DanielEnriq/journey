import type { WorkCheck, WorkStatus } from '../room/data/sources.js';

// One rule for how sure the app is about a workstream, so mock and real adapters say the same thing.
// Only evidence counts: a question raised, checks that ran, activity that was observed. A session that
// went quiet is "unknown", never "done" or "stuck".

/** Activity newer than this reads as work still going on. */
export const ACTIVE_WINDOW_MIN = 15;

export function classify(e: { question?: string; checks?: WorkCheck[]; lastActivityAt: string | null }, now = Date.now()): WorkStatus {
  if (e.question) return 'attention';
  if (e.checks?.length && e.checks.every((c) => c.result === 'pass')) return 'completed';
  if (e.lastActivityAt && now - Date.parse(e.lastActivityAt) < ACTIVE_WINDOW_MIN * 60_000) return 'active';
  return 'unknown';
}

export const STATUS_WORDS: Record<WorkStatus, string> = {
  active: 'Activity observed',
  completed: 'Checks passed',
  attention: 'Waiting on the room',
  unknown: 'Status unknown',
};
