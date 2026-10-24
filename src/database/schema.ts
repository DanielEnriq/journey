import { sql } from 'drizzle-orm';
import { blob, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Source of truth for the local database. After changing it, run `pnpm db:generate`
// to write a migration into drizzle/; migrations apply automatically on startup.

const now = sql`(datetime('now'))`;

export const users = sqliteTable('users', {
  id: text('id').primaryKey(), // Google "sub"
  email: text('email').notNull(),
  name: text('name'),
  picture: text('picture'),
  createdAt: text('created_at').notNull().default(now),
  lastLogin: text('last_login').notNull().default(now),
});

export const sessions = sqliteTable('sessions', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  refreshToken: blob('refresh_token', { mode: 'buffer' }).notNull(), // encrypted with Electron safeStorage
  scope: text('scope'),
  updatedAt: text('updated_at').notNull().default(now),
});

/** App preferences as JSON values; keys and types are declared in settings.ts. */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: text('updated_at').notNull().default(now),
});

/** Local Git repositories the user has added. */
export const repositories = sqliteTable('repositories', {
  id: text('id').primaryKey(), // UUID, so rows can sync to a cloud service later without remapping
  path: text('path').notNull().unique(),
  name: text('name').notNull(),
  addedAt: text('added_at').notNull().default(now),
  lastOpenedAt: text('last_opened_at'),
});

/** Disposable per-repository data (file trees, git status, agent state…); safe to wipe at any time. */
export const workspaceCache = sqliteTable(
  'workspace_cache',
  {
    repositoryId: text('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: text('value', { mode: 'json' }).notNull(),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.repositoryId, t.key] })],
);
