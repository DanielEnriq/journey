import { safeStorage, shell } from 'electron';
import { CodeChallengeMethod, OAuth2Client, type Credentials } from 'google-auth-library';
import { randomBytes } from 'node:crypto';
import { config } from '../../config.js';
import { deleteSession, getLatestSession, saveSession, upsertUser } from '../../database/sessions.js';
import type { User } from '../../shared/api.js';
import { listenForRedirect } from './loopback.js';

let client: OAuth2Client | undefined;
let currentUser: User | undefined;
let signInInFlight: Promise<User> | undefined;
const listeners = new Set<(user: User | null) => void>();

function newClient(redirectUri?: string): OAuth2Client {
  return new OAuth2Client({
    clientId: config.google.clientId,
    clientSecret: config.google.clientSecret,
    redirectUri,
  });
}

export function getCurrentUser(): User | undefined {
  return currentUser;
}

/** Called after every sign-in, restore, and sign-out. */
export function onUserChange(listener: (user: User | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify() {
  for (const listener of listeners) listener(currentUser ?? null);
}

/** Authenticated client for calling Google APIs; refreshes access tokens automatically. */
export function getAuthClient(): OAuth2Client {
  if (!client || !currentUser) throw new Error('Not signed in');
  return client;
}

/**
 * A Google ID token valid for at least another minute, for backends that accept Google identity (Supabase),
 * plus the access token issued with it: the ID token's `at_hash` claim is checked against it.
 */
export async function getIdentityTokens(): Promise<{ idToken: string; accessToken: string }> {
  const oauth = getAuthClient();
  let { id_token, access_token, expiry_date } = oauth.credentials;
  if (!id_token || !access_token || !expiry_date || expiry_date - 60_000 < Date.now()) {
    // Google returns a fresh ID token alongside the access token for the openid scope.
    ({ id_token, access_token } = (await oauth.refreshAccessToken()).credentials);
  }
  if (!id_token || !access_token) throw new Error('Google did not return an ID token');
  return { idToken: id_token, accessToken: access_token };
}

/** Opens the system browser for Google sign-in and waits for the loopback redirect. */
export function signIn(): Promise<User> {
  signInInFlight ??= doSignIn().finally(() => (signInInFlight = undefined));
  return signInInFlight;
}

async function doSignIn(): Promise<User> {
  const state = randomBytes(16).toString('hex');
  const listener = await listenForRedirect(state);
  try {
    const oauth = newClient(listener.redirectUri);
    const { codeVerifier, codeChallenge } = await oauth.generateCodeVerifierAsync();
    const authUrl = oauth.generateAuthUrl({
      access_type: 'offline',
      prompt: 'select_account consent', // lets you pick (or switch) the account; consent ensures a refresh token
      scope: config.google.scopes,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
    });

    await shell.openExternal(authUrl);
    const code = await listener.code;

    const { tokens } = await oauth.getToken({ code, codeVerifier, redirect_uri: listener.redirectUri });
    oauth.setCredentials(tokens);
    const user = await verifyIdToken(oauth, tokens);
    attach(oauth, user);
    persist(user, tokens);
    return user;
  } finally {
    listener.close();
  }
}

/** Restores the most recent session from SQLite, if one exists and is still valid. */
export async function restoreSession(): Promise<User | undefined> {
  const session = getLatestSession();
  if (!session || !safeStorage.isEncryptionAvailable()) return undefined;

  const { user, refreshToken } = session;
  const oauth = newClient();
  oauth.setCredentials({ refresh_token: safeStorage.decryptString(refreshToken) });
  try {
    await oauth.getAccessToken(); // proves the refresh token still works
  } catch (err) {
    console.warn('[auth] stored session is no longer valid:', (err as Error).message);
    deleteSession(user.id);
    return undefined;
  }
  attach(oauth, user);
  return user;
}

export async function signOut(): Promise<void> {
  if (!currentUser) return;
  try {
    await client?.revokeCredentials();
  } catch (err) {
    console.warn('[auth] token revoke failed:', (err as Error).message);
  }
  deleteSession(currentUser.id);
  client = undefined;
  currentUser = undefined;
  notify();
}

async function verifyIdToken(oauth: OAuth2Client, tokens: Credentials): Promise<User> {
  if (!tokens.id_token) throw new Error('Google did not return an ID token');
  const ticket = await oauth.verifyIdToken({ idToken: tokens.id_token, audience: config.google.clientId });
  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email) throw new Error('ID token missing sub/email');
  return { id: payload.sub, email: payload.email, name: payload.name ?? null, picture: payload.picture ?? null };
}

function attach(oauth: OAuth2Client, user: User) {
  // Google occasionally rotates refresh tokens; keep the stored one current.
  oauth.on('tokens', (tokens) => {
    if (tokens.refresh_token) persist(user, tokens);
  });
  client = oauth;
  currentUser = user;
  notify();
}

function persist(user: User, tokens: Credentials) {
  upsertUser(user);

  if (!tokens.refresh_token) return;
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn('[auth] OS keychain unavailable; session will not be persisted');
    return;
  }
  saveSession(user.id, safeStorage.encryptString(tokens.refresh_token), tokens.scope ?? null);
}
