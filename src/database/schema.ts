import { sql } from 'drizzle-orm';
import { blob, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// Source of truth for the local database. After changing it, run `pnpm db:generate`
// to write a migration into drizzle/; migrations apply automatically on startup.

const now = sql`(datetime('now'))`;

export const users = sqliteTable('users', {
  id: text('id').primaryKey(), // Google "sub" for Google sessions; the Supabase user id for GitHub sessions
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
  // 'google': a Google refresh token. 'github': a Supabase refresh token from Supabase's GitHub sign-in.
  provider: text('provider', { enum: ['google', 'github'] }).notNull().default('google'),
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

/** Claude Code hook events, as summarized by the hook (agents/claude-code-hook.cts). */
export const claudeCodeEvents = sqliteTable(
  'claude_code_events',
  {
    id: text('id').primaryKey(), // the hook's UUID, or derived from the transcript line, so re-reading can't duplicate it
    sessionId: text('session_id').notNull(),
    type: text('type').notNull(),
    occurredAt: text('occurred_at').notNull(), // ISO 8601, sortable as text
    cwd: text('cwd'),
    toolName: text('tool_name'),
    summary: text('summary'),
    subagent: integer('subagent', { mode: 'boolean' }).notNull().default(false),
    receivedAt: text('received_at').notNull().default(now),
    source: text('source').notNull().default('hook'), // 'hook' | 'transcript'
    filePath: text('file_path'),
  },
  (t) => [index('claude_code_events_session').on(t.sessionId, t.occurredAt), index('claude_code_events_time').on(t.occurredAt)],
);

// How far the transcript watcher has read each Claude Code transcript, so a restart resumes there.
export const claudeCodeTranscripts = sqliteTable('claude_code_transcripts', {
  path: text('path').primaryKey(),
  sessionId: text('session_id').notNull(),
  offset: integer('offset').notNull(), // bytes, always just after a newline
  inode: integer('inode'),
  updatedAt: text('updated_at').notNull().default(now),
});

/**
 * Claude Code sessions found for each repository: metadata and where to find the transcript (the
 * SDK locates it by session id and cwd). Transcripts themselves stay in Claude Code's own files.
 */
export const claudeCodeSessions = sqliteTable(
  'claude_code_sessions',
  {
    sessionId: text('session_id').primaryKey(),
    repositoryId: text('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    cwd: text('cwd'),
    gitBranch: text('git_branch'),
    title: text('title').notNull(),
    createdAt: text('created_at'),
    lastModifiedAt: text('last_modified_at').notNull(),
    indexedAt: text('indexed_at').notNull().default(now),
  },
  (t) => [index('claude_code_sessions_repository').on(t.repositoryId, t.lastModifiedAt)],
);

/** A branch checked out in a worktree, given a stable id the first time it's seen. */
export const workstreams = sqliteTable(
  'workstreams',
  {
    id: text('id').primaryKey(), // UUID
    repositoryId: text('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    worktreePath: text('worktree_path').notNull(),
    /** The branch, or "" for a detached HEAD. */
    branch: text('branch').notNull(),
    firstSeenAt: text('first_seen_at').notNull().default(now),
    lastSeenAt: text('last_seen_at').notNull().default(now),
  },
  (t) => [uniqueIndex('workstreams_worktree_branch').on(t.repositoryId, t.worktreePath, t.branch)],
);
