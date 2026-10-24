import Database from 'better-sqlite3';
import { app } from 'electron';
import { join } from 'node:path';

const migrations: string[] = [
  `CREATE TABLE users (
     id           TEXT PRIMARY KEY,          -- Google "sub"
     email        TEXT NOT NULL,
     name         TEXT,
     picture      TEXT,
     created_at   TEXT NOT NULL DEFAULT (datetime('now')),
     last_login   TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE TABLE sessions (
     user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
     refresh_token BLOB NOT NULL,            -- encrypted with Electron safeStorage
     scope         TEXT,
     updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
   );`,
];

let db: Database.Database | undefined;

export function getDb(): Database.Database {
  if (db) return db;
  db = new Database(join(app.getPath('userData'), 'journey.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: Database.Database) {
  const version = db.pragma('user_version', { simple: true }) as number;
  for (let i = version; i < migrations.length; i++) {
    db.transaction(() => {
      db.exec(migrations[i]);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
}

export function closeDb() {
  db?.close();
  db = undefined;
}
