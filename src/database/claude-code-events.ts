import { and, desc, eq, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import type { ClaudeCodeEvent, ClaudeCodeEventType } from '../shared/api.js';
import { getDb } from './index.js';
import { claudeCodeEvents } from './schema.js';

type Row = typeof claudeCodeEvents.$inferSelect;

const toEvent = (row: Row): ClaudeCodeEvent => ({
  id: row.id,
  sessionId: row.sessionId,
  type: row.type as ClaudeCodeEventType,
  timestamp: row.occurredAt,
  cwd: row.cwd,
  toolName: row.toolName,
  summary: row.summary,
  subagent: row.subagent,
});

/** Stores an event once; returns false if one with its id is already stored. */
export function insertEvent(event: ClaudeCodeEvent): boolean {
  const { changes } = getDb()
    .insert(claudeCodeEvents)
    .values({
      id: event.id,
      sessionId: event.sessionId,
      type: event.type,
      occurredAt: event.timestamp,
      cwd: event.cwd,
      toolName: event.toolName,
      summary: event.summary,
      subagent: event.subagent,
    })
    .onConflictDoNothing()
    .run();
  return changes > 0;
}

/** Each session's most recent event, for the sessions that have one. */
export function latestEvents(sessionIds: string[]): Map<string, ClaudeCodeEvent> {
  const latest = new Map<string, ClaudeCodeEvent>();
  // SQLite caps bound parameters per statement, and a repository can have thousands of sessions.
  for (let i = 0; i < sessionIds.length; i += 500) {
    const chunk = sessionIds.slice(i, i + 500);
    const rows = getDb()
      .select()
      .from(claudeCodeEvents)
      .where(
        and(
          inArray(claudeCodeEvents.sessionId, chunk),
          eq(
            claudeCodeEvents.occurredAt,
            sql`(SELECT MAX(e.occurred_at) FROM claude_code_events e WHERE e.session_id = ${claudeCodeEvents.sessionId})`,
          ),
        ),
      )
      .all();
    for (const row of rows) latest.set(row.sessionId, toEvent(row));
  }
  return latest;
}

/**
 * Newest first: events from the given sessions, or run anywhere under the given directories (a
 * session that just started may not have a transcript to be listed by yet).
 */
export function recentEvents(sessionIds: string[], dirs: string[], limit = 100): ClaudeCodeEvent[] {
  const conditions: SQL[] = [];
  if (sessionIds.length) conditions.push(inArray(claudeCodeEvents.sessionId, sessionIds.slice(0, 900)));
  for (const dir of dirs) {
    const pattern = `${dir.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`;
    conditions.push(or(eq(claudeCodeEvents.cwd, dir), sql`${claudeCodeEvents.cwd} LIKE ${pattern} ESCAPE '\\'`)!);
  }
  if (!conditions.length) return [];
  return getDb()
    .select()
    .from(claudeCodeEvents)
    .where(or(...conditions))
    .orderBy(desc(claudeCodeEvents.occurredAt))
    .limit(limit)
    .all()
    .map(toEvent);
}

/** Deletes events older than `before` (ISO 8601). */
export function pruneEvents(before: string) {
  getDb().delete(claudeCodeEvents).where(lt(claudeCodeEvents.occurredAt, before)).run();
}
