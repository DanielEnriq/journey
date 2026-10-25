import type { Session } from '@supabase/supabase-js';
import { safeStorage, shell } from 'electron';
import { config } from '../../config.js';
import { deleteSession, getLatestSession, saveSession, upsertUser } from '../../database/sessions.js';
import type { AuthFailure, AuthResult, SignInMethod, SignInProvider, User } from '../../shared/api.js';
import * as google from '../google/auth.js';
import {
  AuthFlowError,
  describeMethods,
  fetchAuthSettings,
  linkWithIdToken,
  linkWithOAuth,
  profileOf,
  resumeSession,
  signInWithOAuth,
  toAuthFailure,
  unlinkProvider,
  whyUnavailable,
  type AuthSettings,
} from '../supabase/identity.js';
import { authClient, cloud, disconnectCloud, enqueue, getCloud, isCloudConfigured, setReconnect } from '../supabase/index.js';

/**
 * Who is signed in to Vowe, and with what: Continue with Google (native, src/integrations/google) or
 * Continue with GitHub (Supabase's GitHub provider). Both reach the same Supabase user once linked, and
 * so the same rooms (see supabase/identity.ts). Signing in grants Vowe nothing at the provider beyond
 * who you are: GitHub repository access and ChatGPT model access are separate grants.
 *
 * Stored sessions (SQLite, encrypted with safeStorage): a Google refresh token for Google, a Supabase
 * refresh token for GitHub, kept current as Supabase rotates it. If Supabase ends a GitHub session
 * (revoked, expired, signed out everywhere), the app signs out and says so (onSessionEnded).
 */

let currentUser: User | undefined;
const listeners = new Set<(user: User | null) => void>();
const endedListeners = new Set<(failure: AuthFailure) => void>();
/** Set while this app is ending its own session, so the cloud's SIGNED_OUT isn't taken for an expiry. */
let leaving = false;
/** Why the last session ended on its own, until the next sign-in. */
let ended: AuthFailure | null = null;

export function getCurrentUser(): User | undefined {
  return currentUser;
}

/** Why the last GitHub session ended without a sign-out here (expired, revoked), until the next sign-in. */
export function getSessionEnded(): AuthFailure | null {
  return ended;
}

/** Called after every sign-in, restore, and sign-out. */
export function onUserChange(listener: (user: User | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Called when a session ends without anyone signing out here; onUserChange(null) follows. */
export function onSessionEnded(listener: (failure: AuthFailure) => void): () => void {
  endedListeners.add(listener);
  return () => endedListeners.delete(listener);
}

function setUser(user: User | undefined) {
  currentUser = user;
  if (user) ended = null;
  setReconnect(user && isCloudConfigured() ? () => (user.provider === 'google' ? connectGoogle() : resumeGitHub(user)) : undefined);
  for (const listener of listeners) listener(user ?? null);
}

/**
 * Keeps the cloud session in step with the account. Call once, before restoreSession(). Without
 * Supabase the app is local-only: Google sign-in still works, GitHub doesn't.
 */
export function startAccount() {
  if (!isCloudConfigured()) return;
  // A Google session's cloud session is exchanged from Google's ID token; a GitHub session already is one.
  onUserChange((user) => {
    if (user?.provider === 'github') return;
    enqueue(() => (user ? connectGoogle() : Promise.resolve())).then(
      () => user && console.log(`[cloud] connected as ${user.email}`),
      (err: Error) => console.warn('[cloud] session change failed:', err.message),
    );
  });
  cloud().auth.onAuthStateChange((event, session) => {
    const user = currentUser;
    if (user?.provider !== 'github') return;
    if (session && session.user.id === user.id && (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN')) {
      storeGitHubSession(user, session.refresh_token);
    }
    // Supabase dropped the session itself: its refresh token was refused. Not inside this callback,
    // which holds the client's lock.
    if (event === 'SIGNED_OUT' && !leaving) setTimeout(() => void endSession(user), 0);
  });
}

async function connectGoogle() {
  const { idToken, accessToken } = await google.getIdentityTokens();
  const { error } = await cloud().auth.signInWithIdToken({ provider: 'google', token: idToken, access_token: accessToken });
  if (error) throw error;
}

/** getCloud() found no session for a GitHub user: try the stored token once, else the session is over. */
async function resumeGitHub(user: User) {
  const stored = getLatestSession();
  try {
    if (stored?.user.id !== user.id || stored.user.provider !== 'github') throw new AuthFlowError('session-expired', 'Your session ended.');
    const session = await resumeSession(cloud(), safeStorage.decryptString(stored.refreshToken));
    storeGitHubSession(user, session.refresh_token);
  } catch (err) {
    if (toAuthFailure(err).code === 'session-expired') setTimeout(() => void endSession(user), 0);
    throw err;
  }
}

/** The GitHub session ended on Supabase's side: sign out here and say why. */
async function endSession(user: User) {
  if (currentUser?.id !== user.id || currentUser.provider !== 'github') return;
  deleteSession(user.id);
  setUser(undefined);
  await enqueue(disconnectCloud).catch(() => {});
  sessionEnded();
}

function sessionEnded() {
  ended = { code: 'session-expired', message: 'Your GitHub sign-in ended. Sign in again to get back to your rooms.', provider: 'github' };
  for (const listener of endedListeners) listener(ended);
}

function storeGitHubSession(user: User, refreshToken: string) {
  upsertUser(user);
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn('[auth] OS keychain unavailable; session will not be persisted');
    return;
  }
  saveSession(user.id, 'github', safeStorage.encryptString(refreshToken), null);
}

// ─── One browser flow at a time ──────────────────────────────────────────────

let flow: { key: string; controller: AbortController; promise: Promise<unknown> } | undefined;

/** Pressing the same button again reuses the flow in flight; a different one cancels it first. */
function runFlow<T>(key: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (flow?.key === key) return flow.promise as Promise<T>;
  flow?.controller.abort();
  const controller = new AbortController();
  const promise = run(controller.signal).finally(() => {
    if (flow?.controller === controller) flow = undefined;
  });
  flow = { key, controller, promise };
  return promise;
}

/** Stops waiting for the browser: the sign-in or link in flight fails as `cancelled`. */
export function cancelAuthFlow() {
  flow?.controller.abort();
}

const openBrowser = (url: string) => shell.openExternal(url);

// ─── Sign in, restore, sign out ──────────────────────────────────────────────

/** Opens the system browser to sign in with `provider`. Rejects with an AuthFlowError, in words to show. */
export function signIn(provider: SignInProvider = 'google'): Promise<User> {
  return runFlow(`sign-in:${provider}`, async (signal) => {
    try {
      if (currentUser) await signOut(); // switching accounts: sign-in only starts signed out
      const user = provider === 'google' ? await google.signIn(signal) : await signInWithGitHub(signal);
      setUser(user);
      return user;
    } catch (err) {
      const { code, message } = toAuthFailure(err, provider);
      throw new AuthFlowError(code, message, provider);
    }
  });
}

async function signInWithGitHub(signal: AbortSignal): Promise<User> {
  await requireReady('github');
  const session = await signInWithOAuth(authClient(), 'github', { open: openBrowser, signal });
  // Only the tokens move to the app's client: GitHub's own access token stays behind with the throwaway.
  await enqueue(async () => {
    const { error } = await cloud().auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
    if (error) throw error;
  });
  const user = profileOf(session.user, 'github');
  storeGitHubSession(user, session.refresh_token);
  return user;
}

/** Restores the most recent stored session, if there is one and it's still valid. */
export async function restoreSession(): Promise<User | undefined> {
  const stored = getLatestSession();
  if (!stored || !safeStorage.isEncryptionAvailable()) return undefined;

  if (stored.user.provider === 'google') {
    const user = await google.restoreSession(stored);
    if (user) setUser(user);
    return user;
  }

  if (!isCloudConfigured()) return undefined;
  try {
    const session = await enqueue(() => resumeSession(cloud(), safeStorage.decryptString(stored.refreshToken)));
    const user = profileOf(session.user, 'github');
    storeGitHubSession(user, session.refresh_token);
    setUser(user);
    return user;
  } catch (err) {
    const failure = toAuthFailure(err, 'github');
    // Offline at launch keeps the stored session for next time; one Supabase refused is gone for good.
    if (failure.code === 'session-expired') {
      deleteSession(stored.user.id);
      sessionEnded();
    }
    console.warn('[auth] stored GitHub session not restored:', failure.message);
    return undefined;
  }
}

/** Ends this device's session: leaves rooms, revokes it, and forgets it. Other devices stay signed in. */
export async function signOut(): Promise<void> {
  const user = currentUser;
  if (!user) return;
  leaving = true;
  try {
    setUser(undefined);
    if (isCloudConfigured()) await enqueue(disconnectCloud).catch((err: Error) => console.warn('[cloud] sign-out failed:', err.message));
    if (user.provider === 'google') await google.signOut(user);
    else deleteSession(user.id);
  } finally {
    leaving = false;
  }
}

// ─── Sign-in methods ─────────────────────────────────────────────────────────

let settingsCache: { at: number; settings: Promise<AuthSettings> } | undefined;

/** The project's public Auth settings, fetched at most once a minute. */
function authSettings(): Promise<AuthSettings> {
  if (!settingsCache || Date.now() - settingsCache.at > 60_000) {
    const { url, publishableKey } = config.supabase;
    const settings = fetchAuthSettings(url!, publishableKey!);
    settings.catch(() => (settingsCache = undefined));
    settingsCache = { at: Date.now(), settings };
  }
  return settingsCache.settings;
}

async function requireReady(provider: SignInProvider) {
  if (!isCloudConfigured()) {
    throw new AuthFlowError('not-configured', 'GitHub sign-in needs Vowe’s cloud: set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in .env.', provider);
  }
  const problem = whyUnavailable(await authSettings(), provider);
  if (problem) throw problem;
}

async function availability(): Promise<Record<SignInProvider, boolean>> {
  const hasGoogle = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  if (!isCloudConfigured()) return { google: hasGoogle, github: false };
  const settings = await authSettings().catch(() => undefined);
  return {
    google: hasGoogle && Boolean(settings && !whyUnavailable(settings, 'google')),
    github: Boolean(settings && !whyUnavailable(settings, 'github')),
  };
}

function requireUser(): User {
  if (!currentUser) throw new AuthFlowError('signed-out', 'Sign in to Vowe first.');
  return currentUser;
}

async function listMethods(): Promise<SignInMethod[]> {
  const user = requireUser();
  const available = await availability();
  if (!isCloudConfigured()) {
    // Local-only: the Google session is the whole account.
    return describeMethods([{ provider: 'google', identity_data: { email: user.email }, created_at: undefined }], user.provider, available);
  }
  const { data, error } = await (await getCloud()).auth.getUserIdentities();
  if (error) throw error;
  return describeMethods(data.identities, user.provider, available);
}

/** A session with time left on it, for a link to act as. */
async function freshSession(): Promise<Session> {
  const supabase = await getCloud();
  return enqueue(async () => {
    let { data: { session } } = await supabase.auth.getSession();
    if (session && (session.expires_at ?? 0) * 1000 - Date.now() < 5 * 60_000) {
      ({ data: { session } } = await supabase.auth.refreshSession());
    }
    if (!session) throw new AuthFlowError('session-expired', 'Your session ended. Sign in again.');
    return session;
  });
}

/** Re-reads the session so its token reflects the account's methods (app_metadata.providers). */
async function refreshAfterChange() {
  const supabase = await getCloud();
  await enqueue(async () => {
    const { error } = await supabase.auth.refreshSession();
    if (error) console.warn('[auth] session refresh after a method change failed:', error.message);
  });
}

async function authResult<T>(run: () => Promise<T>, provider?: SignInProvider): Promise<AuthResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (err) {
    const error = toAuthFailure(err, provider);
    if (error.code === 'unknown') console.warn('[auth]', err);
    return { ok: false, error };
  }
}

export function listSignInMethods(): Promise<AuthResult<SignInMethod[]>> {
  return authResult(listMethods);
}

/** Adds `provider` to the signed-in account, through the browser. Never merges two existing accounts. */
export function linkSignInMethod(provider: SignInProvider): Promise<AuthResult<SignInMethod[]>> {
  return authResult(
    () =>
      runFlow(`link:${provider}`, async (signal) => {
        requireUser();
        if (!isCloudConfigured()) throw new AuthFlowError('not-configured', 'Linking sign-in methods needs Vowe’s cloud.', provider);
        if ((await listMethods()).find((m) => m.provider === provider)?.linked) {
          throw new AuthFlowError('already-linked', `${provider === 'google' ? 'Google' : 'GitHub'} is already one of your sign-in methods.`, provider);
        }
        await requireReady(provider);
        const session = await freshSession();
        if (provider === 'github') {
          await linkWithOAuth(authClient(), session, 'github', { open: openBrowser, signal });
        } else {
          const proof = await google.verifyOnce(signal);
          try {
            await linkWithIdToken(authClient(), session, 'google', proof);
          } finally {
            await proof.revoke(); // only needed to prove who it is
          }
        }
        await refreshAfterChange();
        return listMethods();
      }),
    provider,
  );
}

/** Removes `provider` from the account: not the method this session used, and never the last one. */
export function unlinkSignInMethod(provider: SignInProvider): Promise<AuthResult<SignInMethod[]>> {
  return authResult(async () => {
    const user = requireUser();
    if (!isCloudConfigured()) throw new AuthFlowError('last-method', 'Google is your only way to sign in, so it can’t be removed.', provider);
    await unlinkProvider(await getCloud(), provider, user.provider);
    await refreshAfterChange();
    return listMethods();
  }, provider);
}
