import { desc, eq, sql } from 'drizzle-orm';
import type { User } from '../shared/api.js';
import { getDb } from './index.js';
import { sessions, users } from './schema.js';

export interface StoredSession {
  user: User;
  /** Encrypted with Electron safeStorage; the database never sees plaintext tokens. */
  refreshToken: Buffer;
}

export function upsertUser(user: User) {
  getDb()
    .insert(users)
    .values(user)
    .onConflictDoUpdate({
      target: users.id,
      set: { email: user.email, name: user.name, picture: user.picture, lastLogin: sql`(datetime('now'))` },
    })
    .run();
}

/** The most recently updated session, if any. */
export function getLatestSession(): StoredSession | undefined {
  const row = getDb()
    .select({
      user: { id: users.id, email: users.email, name: users.name, picture: users.picture },
      refreshToken: sessions.refreshToken,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .orderBy(desc(sessions.updatedAt))
    .limit(1)
    .get();
  return row;
}

export function saveSession(userId: string, encryptedRefreshToken: Buffer, scope: string | null) {
  getDb()
    .insert(sessions)
    .values({ userId, refreshToken: encryptedRefreshToken, scope })
    .onConflictDoUpdate({
      target: sessions.userId,
      set: { refreshToken: encryptedRefreshToken, scope, updatedAt: sql`(datetime('now'))` },
    })
    .run();
}

export function deleteSession(userId: string) {
  getDb().delete(sessions).where(eq(sessions.userId, userId)).run();
}
