import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from '../../config.js';
import { getIdentityTokens, onUserChange } from '../google/auth.js';
import type { Database } from './types.js';

/**
 * Supabase cloud backend: shared data (workspaces, rooms) lives in Postgres behind
 * row-level security; local-only data stays in SQLite (src/database/).
 *
 * Google sign-in stays the source of identity. Each time the user signs in or a
 * session is restored, the Google ID token is exchanged for a Supabase session
 * (signInWithIdToken), so RLS sees them as auth.uid(). The Supabase session lives
 * in memory only: nothing new is persisted, and the next launch exchanges again.
 *
 * Schema: supabase/migrations/. Types: ./types.ts (`pnpm cloud:types`).
 */

export type Cloud = SupabaseClient<Database>;

let client: Cloud | undefined;
let connecting: Promise<void> | undefined;

export function isCloudConfigured(): boolean {
  return Boolean(config.supabase.url && config.supabase.publishableKey);
}

function cloud(): Cloud {
  const { url, publishableKey } = config.supabase;
  if (!url || !publishableKey) {
    throw new Error('Supabase not configured — set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in .env');
  }
  client ??= createClient<Database>(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false },
  });
  return client;
}

/** The signed-in Supabase client. Waits for an in-flight sign-in; throws if signed out. */
export async function getCloud(): Promise<Cloud> {
  await connecting;
  const supabase = cloud();
  const { data } = await supabase.auth.getSession();
  if (!data.session) throw new Error('Not signed in to the cloud');
  return supabase;
}

/** Cloud user id (auth.uid()), distinct from the Google `sub` used as the local user id. */
export async function getCloudUserId(): Promise<string> {
  const { data } = await (await getCloud()).auth.getSession();
  return data.session!.user.id;
}

async function connect() {
  const { idToken, accessToken } = await getIdentityTokens();
  const { error } = await cloud().auth.signInWithIdToken({ provider: 'google', token: idToken, access_token: accessToken });
  if (error) throw error;
}

async function disconnect() {
  // scope 'local': drop this client's session without signing the user out elsewhere.
  const { error } = await cloud().auth.signOut({ scope: 'local' });
  if (error) console.warn('[cloud] sign-out failed:', error.message);
}

/** Keeps the Supabase session in step with Google sign-in. No-op when Supabase isn't configured. */
export function startCloudSync() {
  if (!isCloudConfigured()) return;
  onUserChange((user) => {
    // Chained so a quick sign-in → sign-out applies in order.
    connecting = Promise.resolve(connecting)
      .then(() => (user ? connect() : disconnect()))
      .then(
      () => console.log(user ? `[cloud] connected as ${user.email}` : '[cloud] disconnected'),
      (err: Error) => console.warn('[cloud] session change failed:', err.message),
    );
  });
}
