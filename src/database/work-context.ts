import { and, eq, notInArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { ClaudeCodeSession } from '../shared/api.js';
import { getDb } from './index.js';
import { claudeCodeSessions, workstreams } from './schema.js';

export type IndexedSession = typeof claudeCodeSessions.$inferSelect;
export type WorkstreamRow = typeof workstreams.$inferSelect;

/** Replaces the repository's session index with what was just listed. */
export function indexSessions(repositoryId: string, sessions: ClaudeCodeSession[]) {
  const db = getDb();
  db.transaction((tx) => {
    const ids = sessions.map((s) => s.id);
    tx.delete(claudeCodeSessions)
      .where(and(eq(claudeCodeSessions.repositoryId, repositoryId), ids.length ? notInArray(claudeCodeSessions.sessionId, ids) : undefined))
      .run();
    for (const s of sessions) {
      const row = {
        repositoryId,
        cwd: s.cwd,
        gitBranch: s.gitBranch,
        title: s.title,
        createdAt: s.createdAt,
        lastModifiedAt: s.lastModifiedAt,
        indexedAt: sql`(datetime('now'))`,
      };
      tx.insert(claudeCodeSessions)
        .values({ sessionId: s.id, ...row })
        .onConflictDoUpdate({ target: claudeCodeSessions.sessionId, set: row })
        .run();
    }
  });
}

export function getIndexedSession(sessionId: string): IndexedSession | undefined {
  return getDb().select().from(claudeCodeSessions).where(eq(claudeCodeSessions.sessionId, sessionId)).get();
}

export function indexedSessionIds(repositoryId: string): string[] {
  return getDb()
    .select({ id: claudeCodeSessions.sessionId })
    .from(claudeCodeSessions)
    .where(eq(claudeCodeSessions.repositoryId, repositoryId))
    .all()
    .map((r) => r.id);
}

/** The workstream for a branch checked out in a worktree, created the first time it's seen. */
export function touchWorkstream(repositoryId: string, worktreePath: string, branch: string): WorkstreamRow {
  return getDb()
    .insert(workstreams)
    .values({ id: randomUUID(), repositoryId, worktreePath, branch })
    .onConflictDoUpdate({
      target: [workstreams.repositoryId, workstreams.worktreePath, workstreams.branch],
      set: { lastSeenAt: sql`(datetime('now'))` },
    })
    .returning()
    .get();
}

export function getWorkstream(id: string): WorkstreamRow | undefined {
  return getDb().select().from(workstreams).where(eq(workstreams.id, id)).get();
}
