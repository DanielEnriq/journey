import { and, count, desc, eq, inArray, isNotNull, lt, or, sql, type SQL } from 'drizzle-orm';
import type { ClaudeCodeEvent, ClaudeCodeEventType } from '../shared/api.js';
import { getDb } from './index.js';
import { claudeCodeEvents, claudeCodeTranscripts } from './schema.js';

type Row = typeof claudeCodeEvents.$inferSelect;

const toEvent = (row: Row): ClaudeCodeEvent => ({
  id: row.id,
  sessionId: row.sessionId,
  type: row.type as ClaudeCodeEventType,
  source: row.source === 'transcript' ? 'transcript' : 'hook',
  timestamp: row.occurredAt,
  cwd: row.cwd,
  toolName: row.toolName,
  summary: row.summary,
  subagent: row.subagent,
  filePath: row.filePath,
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
      source: event.source,
      filePath: event.filePath,
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

/** Distinct files each of the sessions' observed file tools worked on. */
export function sessionFilePaths(sessionIds: string[]): Map<string, string[]> {
  const paths = new Map<string, string[]>();
  for (let i = 0; i < sessionIds.length; i += 500) {
    const rows = getDb()
      .selectDistinct({ sessionId: claudeCodeEvents.sessionId, filePath: claudeCodeEvents.filePath })
      .from(claudeCodeEvents)
      .where(and(inArray(claudeCodeEvents.sessionId, sessionIds.slice(i, i + 500)), isNotNull(claudeCodeEvents.filePath)))
      .all();
    for (const row of rows) paths.set(row.sessionId, [...(paths.get(row.sessionId) ?? []), row.filePath!]);
  }
  return paths;
}

// ─── Transcript read positions ───────────────────────────────────────────────

export type TranscriptPosition = typeof claudeCodeTranscripts.$inferSelect;

export function getTranscriptPosition(path: string): TranscriptPosition | undefined {
  return getDb().select().from(claudeCodeTranscripts).where(eq(claudeCodeTranscripts.path, path)).get();
}

export function setTranscriptPosition(path: string, sessionId: string, offset: number, inode: number | null) {
  const row = { sessionId, offset, inode, updatedAt: sql`(datetime('now'))` };
  getDb()
    .insert(claudeCodeTranscripts)
    .values({ path, ...row })
    .onConflictDoUpdate({ target: claudeCodeTranscripts.path, set: row })
    .run();
}

export function deleteTranscriptPosition(path: string) {
  getDb().delete(claudeCodeTranscripts).where(eq(claudeCodeTranscripts.path, path)).run();
}

/** Whether the watcher has ever recorded a position: false only on its very first run. */
export function hasTranscriptPositions(): boolean {
  return (getDb().select({ n: count() }).from(claudeCodeTranscripts).get()?.n ?? 0) > 0;
}
