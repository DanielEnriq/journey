import { safeStorage, shell } from 'electron';
import { CodeChallengeMethod, OAuth2Client, type Credentials } from 'google-auth-library';
import { randomBytes } from 'node:crypto';
import { config } from '../../config.js';
import { deleteSession, saveSession, upsertUser, type StoredSession } from '../../database/sessions.js';
import type { User } from '../../shared/api.js';
import { listenForRedirect } from './loopback.js';

// Continue with Google: the system browser, a loopback redirect and PKCE, natively (not through
// Supabase), so the Google refresh token stays on this machine. Who is signed in, and with what, is
// src/integrations/account's to say; this module holds only the Google session while there is one.

let client: OAuth2Client | undefined;

function newClient(redirectUri?: string): OAuth2Client {
  return new OAuth2Client({
    clientId: config.google.clientId,
    clientSecret: config.google.clientSecret,
    redirectUri,
  });
}

/** Authenticated client for calling Google APIs; refreshes access tokens automatically. */
export function getAuthClient(): OAuth2Client {
  if (!client) throw new Error('Not signed in');
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

/** Opens the system browser for Google sign-in and makes it this app's Google session. */
export async function signIn(signal?: AbortSignal): Promise<User> {
  const { oauth, tokens, user } = await authorize({ offline: true, signal });
  attach(oauth, user);
  persist(user, tokens);
  return user;
}

/**
 * Google's consent once, to prove who someone is (linking Google to the account signed in another way).
 * Nothing is stored; revoke() once the tokens have been used.
 */
export async function verifyOnce(signal?: AbortSignal): Promise<{ idToken: string; accessToken: string; revoke(): Promise<void> }> {
  const { oauth, tokens } = await authorize({ offline: false, signal });
  if (!tokens.access_token || !tokens.id_token) throw new Error('Google did not return an ID token');
  return {
    idToken: tokens.id_token,
    accessToken: tokens.access_token,
    revoke: () => oauth.revokeCredentials().then(() => undefined, (err: Error) => console.warn('[auth] token revoke failed:', err.message)),
  };
}

async function authorize({ offline, signal }: { offline: boolean; signal?: AbortSignal }) {
  const state = randomBytes(16).toString('hex');
  const listener = await listenForRedirect(state, { signal });
  try {
    const oauth = newClient(listener.redirectUri);
    const { codeVerifier, codeChallenge } = await oauth.generateCodeVerifierAsync();
    const authUrl = oauth.generateAuthUrl({
      access_type: offline ? 'offline' : 'online',
      // Lets you pick (or switch) the account; consent ensures a refresh token when one is kept.
      prompt: offline ? 'select_account consent' : 'select_account',
      scope: config.google.scopes,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
    });

    await shell.openExternal(authUrl);
    const code = await listener.code;

    const { tokens } = await oauth.getToken({ code, codeVerifier, redirect_uri: listener.redirectUri });
    oauth.setCredentials(tokens);
    return { oauth, tokens, user: await verifyIdToken(oauth, tokens) };
  } finally {
    listener.close();
  }
}

/** Restores a stored Google session, if its refresh token still works. */
export async function restoreSession({ user, refreshToken }: StoredSession): Promise<User | undefined> {
  if (!safeStorage.isEncryptionAvailable()) return undefined;
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

/** Revokes the Google session's tokens and forgets it. */
export async function signOut(user: User): Promise<void> {
  try {
    await client?.revokeCredentials();
  } catch (err) {
    console.warn('[auth] token revoke failed:', (err as Error).message);
  }
  deleteSession(user.id);
  client = undefined;
}

async function verifyIdToken(oauth: OAuth2Client, tokens: Credentials): Promise<User> {
  if (!tokens.id_token) throw new Error('Google did not return an ID token');
  const ticket = await oauth.verifyIdToken({ idToken: tokens.id_token, audience: config.google.clientId });
  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email) throw new Error('ID token missing sub/email');
  return { id: payload.sub, email: payload.email, name: payload.name ?? null, picture: payload.picture ?? null, provider: 'google' };
}

function attach(oauth: OAuth2Client, user: User) {
  // Google occasionally rotates refresh tokens; keep the stored one current.
  oauth.on('tokens', (tokens) => {
    if (tokens.refresh_token) persist(user, tokens);
  });
  client = oauth;
}

function persist(user: User, tokens: Credentials) {
  upsertUser(user);

  if (!tokens.refresh_token) return;
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn('[auth] OS keychain unavailable; session will not be persisted');
    return;
  }
  saveSession(user.id, 'google', safeStorage.encryptString(tokens.refresh_token), tokens.scope ?? null);
}
