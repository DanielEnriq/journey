import { and, desc, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { getDb } from './index.js';
import { repositories, workspaceCache } from './schema.js';

export type Repository = typeof repositories.$inferSelect;

// Storage only: checking that a path exists or is a Git repo is the caller's job.

/** Most recently opened first, then most recently added. */
export function listRepositories(): Repository[] {
  return getDb()
    .select()
    .from(repositories)
    .orderBy(sql`${repositories.lastOpenedAt} IS NULL`, desc(repositories.lastOpenedAt), desc(repositories.addedAt))
    .all();
}

export function getRepository(id: string): Repository | undefined {
  return getDb().select().from(repositories).where(eq(repositories.id, id)).get();
}

/** Adds a repository by path, or returns the existing row if it's already known. */
export function addRepository(path: string, name?: string): Repository {
  const absolute = resolve(path);
  return getDb()
    .insert(repositories)
    .values({ id: randomUUID(), path: absolute, name: name ?? basename(absolute) })
    .onConflictDoUpdate({ target: repositories.path, set: { path: absolute } }) // no-op, so RETURNING yields the existing row
    .returning()
    .get();
}

export function removeRepository(id: string) {
  getDb().delete(repositories).where(eq(repositories.id, id)).run(); // cascades to workspace_cache
}

/** Returns the updated row, or undefined if there's no such repository. */
export function markRepositoryOpened(id: string): Repository | undefined {
  return getDb()
    .update(repositories)
    .set({ lastOpenedAt: sql`(datetime('now'))` })
    .where(eq(repositories.id, id))
    .returning()
    .get();
}

// ─── Workspace cache ─────────────────────────────────────────────────────────

export function getCached<T>(repositoryId: string, key: string): T | undefined {
  const row = getDb()
    .select({ value: workspaceCache.value })
    .from(workspaceCache)
    .where(and(eq(workspaceCache.repositoryId, repositoryId), eq(workspaceCache.key, key)))
    .get();
  return row?.value as T | undefined;
}

export function setCached(repositoryId: string, key: string, value: unknown) {
  getDb()
    .insert(workspaceCache)
    .values({ repositoryId, key, value })
    .onConflictDoUpdate({
      target: [workspaceCache.repositoryId, workspaceCache.key],
      set: { value, updatedAt: sql`(datetime('now'))` },
    })
    .run();
}

/** Clears one repository's cache, or all of it. */
export function clearCache(repositoryId?: string) {
  const db = getDb();
  if (repositoryId) db.delete(workspaceCache).where(eq(workspaceCache.repositoryId, repositoryId)).run();
  else db.delete(workspaceCache).run();
}
