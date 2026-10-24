import { eq, sql } from 'drizzle-orm';
import type { Settings } from '../shared/api.js';
import { getDb } from './index.js';
import { settings } from './schema.js';

// Keys and types live in shared/api.ts. Adding a setting needs a default and a validator here; no migration.

const defaults: Settings = {
  theme: 'system',
};

const validators: { [K in keyof Settings]: (value: unknown) => value is Settings[K] } = {
  theme: (v): v is Settings['theme'] => v === 'system' || v === 'light' || v === 'dark',
};

export function getSetting<K extends keyof Settings>(key: K): Settings[K] {
  const row = getDb().select({ value: settings.value }).from(settings).where(eq(settings.key, key)).get();
  return row ? (row.value as Settings[K]) : defaults[key];
}

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  getDb()
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: sql`(datetime('now'))` } })
    .run();
}

/** Stored values merged over defaults; unknown or stale keys are ignored. */
export function getAllSettings(): Settings {
  const all = { ...defaults };
  for (const { key, value } of getDb().select().from(settings).all()) {
    if (key in validators && validators[key as keyof Settings](value)) Object.assign(all, { [key]: value });
  }
  return all;
}

/** Validates an untrusted patch (e.g. from the renderer) and saves it atomically. */
export function updateSettings(patch: unknown): Settings {
  if (typeof patch !== 'object' || patch === null) throw new Error('Settings patch must be an object');
  const entries = Object.entries(patch);
  for (const [key, value] of entries) {
    if (!(key in validators)) throw new Error(`Unknown setting: ${key}`);
    if (!validators[key as keyof Settings](value)) throw new Error(`Invalid value for ${key}`);
  }
  getDb().transaction(() => {
    for (const [key, value] of entries) setSetting(key as keyof Settings, value as never);
  });
  return getAllSettings();
}
