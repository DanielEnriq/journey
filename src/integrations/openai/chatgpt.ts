/**
 * Sign in with ChatGPT, for ChatGPT plan usage: the person lets Vowe send eligible Responses API
 * requests on their own ChatGPT plan. Follows OpenAI's open-source app flow
 * (developers.openai.com/siwc/token-sharing-open-source): a per-host `ext_agent_host_id`, dynamic
 * registration on first sign-in, a 127.0.0.1 loopback redirect with state, nonce and PKCE, ID token
 * validation against OpenAI's JWKS, and a check that `chatgpt.tokens.use.direct` was granted.
 *
 * Separate from Google sign-in, which stays the identity for rooms (Supabase). Nothing here reads
 * ChatGPT cookies, session tokens, or another app's credential store: tokens come only from this OAuth flow.
 *
 * Credentials stay in main, on this machine. One file, written atomically with owner-only
 * permissions, holds a separate record per issued client id; token fields are additionally sealed with
 * the OS keychain (Electron safeStorage) when it's available. Tokens are never logged, and authorize
 * URLs (which can carry `id_token_hint`) are never logged either.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ModelProviderError } from '../../assistant/provider.js';
import type { ChatGptStatus } from '../../shared/api.js';
import { listenForCallback } from '../google/loopback.js';
import { validateIdToken, type Jwks } from './jwt.js';

export const ISSUER = 'https://auth.openai.com';
const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const OPENID_CONFIG_URL = `${ISSUER}/.well-known/openid-configuration`;
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
export const RESOURCE = 'https://api.openai.com/v1';
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const SCOPES = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', PLAN_SCOPE];
const REGISTER_CLIENT = 'dynamic_agent_client';
const CALLBACK_PATH = '/auth/callback';
export const USAGE_URL = 'https://chatgpt.com/settings/usage';
/** Refresh this long before the access token expires. */
const REFRESH_EARLY_MS = 5 * 60_000;
const JWKS_TTL_MS = 60 * 60_000;
const TERMINAL_REFRESH_ERRORS = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);

/** One registration: an issued client id, the account it's bound to, and its tokens (null once signed out). */
interface AccountRecord {
  email: string | null;
  issuer: string;
  subject: string;
  client_id: string;
  ext_agent_host_id: string;
  /** Kept after sign-in for `id_token_hint`; cleared on sign-out. */
  id_token: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_type: string;
  expires_in: number | null;
  /** Epoch ms. */
  expires_at: number | null;
  earliest_refresh_at: number | null;
  scopes: string[];
  saved_at: string;
  /** The welcome ("You're using your ChatGPT plan") is shown once, after the first plan-enabled sign-in. */
  welcomed: boolean;
  /** Why this account can't be used until it signs in again, in words. */
  problem: string | null;
}

interface StoreFile {
  version: 1;
  /** urn:uuid, generated once for this installation and kept across sign-outs. */
  hostId: string;
  active: string | null;
  accounts: Record<string, AccountRecord>;
}

/** Seals token fields at rest; identity when the OS keychain isn't available (the file stays 0600). */
export interface Sealer {
  seal(text: string): string;
  unseal(text: string): string;
}

export interface ChatGptAuthOptions {
  /** Where the credential file lives: the app's userData. */
  dir: string;
  openBrowser(url: string): Promise<void>;
  sealer?: Sealer;
  fetch?: typeof fetch;
  agentName: string;
  /** The eligibility gate (config.chatgpt.enabled). */
  enabled: boolean;
  now?: () => number;
  /** Lets tests drive the redirect without a browser. */
  listen?: typeof listenForCallback;
}

const SEALED = ['id_token', 'access_token', 'refresh_token'] as const;
const b64url = (bytes: Buffer) => bytes.toString('base64url');

export function createChatGptAuth(options: ChatGptAuthOptions) {
  const http = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const listen = options.listen ?? listenForCallback;
  const file = join(options.dir, 'chatgpt-accounts.json');
  const listeners = new Set<(status: ChatGptStatus) => void>();
  let store = load();
  let jwks: { at: number; value: Jwks } | null = null;
  let revocationEndpoint: string | null = null;
  let signInInFlight: Promise<ChatGptStatus> | null = null;
  /** Refreshes for the same client run one at a time, since refresh tokens rotate. */
  const refreshing = new Map<string, Promise<AccountRecord>>();

  function load(): StoreFile {
    if (!existsSync(file)) return { version: 1, hostId: `urn:uuid:${randomUUID()}`, active: null, accounts: {} };
    const raw = JSON.parse(readFileSync(file, 'utf8')) as StoreFile & { sealed?: boolean };
    for (const account of Object.values(raw.accounts)) {
      for (const field of SEALED) if (account[field] && raw.sealed && options.sealer) account[field] = options.sealer.unseal(account[field]!);
    }
    return { version: 1, hostId: raw.hostId, active: raw.active, accounts: raw.accounts };
  }

  /** Atomic, owner-only: written to a sibling 0600 file, then renamed over the old one. */
  function save() {
    mkdirSync(options.dir, { recursive: true, mode: 0o700 });
    const sealer = options.sealer;
    const accounts = Object.fromEntries(
      Object.entries(store.accounts).map(([id, a]) => [id, { ...a, ...Object.fromEntries(SEALED.map((f) => [f, a[f] && sealer ? sealer.seal(a[f]!) : a[f]])) }]),
    );
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...store, accounts, sealed: Boolean(sealer) }, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
    const next = status();
    for (const listener of listeners) listener(next);
  }

  const active = () => (store.active ? (store.accounts[store.active] ?? null) : null);
  const hasPlan = (a: AccountRecord) => a.scopes.includes(PLAN_SCOPE);

  function status(): ChatGptStatus {
    const a = active();
    return {
      enabled: options.enabled,
      account: a && { clientId: a.client_id, email: a.email, label: a.email ?? `ChatGPT account ${a.subject.slice(0, 6)}` },
      signedIn: Boolean(a?.refresh_token || a?.access_token),
      planUsage: !a ? null : hasPlan(a) ? 'granted' : 'not-granted',
      welcome: Boolean(a && hasPlan(a) && a.access_token && !a.welcomed),
      problem: a?.problem ?? null,
      savedAccounts: Object.values(store.accounts).map((s) => ({ clientId: s.client_id, label: s.email ?? s.subject.slice(0, 6), signedIn: Boolean(s.refresh_token) })),
      usageUrl: USAGE_URL,
    };
  }

  async function keys(refresh: boolean): Promise<Jwks> {
    if (!refresh && jwks && now() - jwks.at < JWKS_TTL_MS) return jwks.value;
    const res = await http(JWKS_URL);
    if (!res.ok) throw new Error(`Couldn't fetch OpenAI's signing keys (HTTP ${res.status}).`);
    jwks = { at: now(), value: (await res.json()) as Jwks };
    return jwks.value;
  }

  async function tokenRequest(body: Record<string, string>) {
    const res = await http(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { res, json };
  }

  /**
   * Opens the browser for sign-in. `account`: a saved client id to reauthorize (the default: the active
   * account), or 'new' to register another account.
   */
  function signIn(account?: string | 'new'): Promise<ChatGptStatus> {
    if (!options.enabled) return Promise.reject(new ModelProviderError('not-eligible', 'ChatGPT plan usage is turned off for this build of Vowe.'));
    signInInFlight ??= doSignIn(account).finally(() => (signInInFlight = null));
    return signInInFlight;
  }

  async function doSignIn(which?: string | 'new'): Promise<ChatGptStatus> {
    const saved = which === 'new' ? null : (which ? store.accounts[which] : active()) ?? null;
    if (which && which !== 'new' && !saved) throw new Error('No such saved ChatGPT account.');
    if (!existsSync(file)) save(); // persist the host id before the first sign-in
    const state = b64url(randomBytes(24));
    const nonce = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(48));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const listener = await listen(state, { path: CALLBACK_PATH, provider: 'ChatGPT' });
    try {
      const params = new URLSearchParams({
        client_id: saved?.client_id ?? REGISTER_CLIENT,
        ext_agent_host_id: store.hostId,
        response_type: 'code',
        redirect_uri: listener.redirectUri,
        scope: SCOPES.join(' '),
        resource: RESOURCE,
        state,
        nonce,
        code_challenge_method: 'S256',
        code_challenge: challenge,
      });
      if (!saved) params.set('agent_name_hint', options.agentName);
      if (saved?.id_token) params.set('id_token_hint', saved.id_token);
      if (saved?.email) params.set('login_hint', saved.email);
      await options.openBrowser(`${AUTHORIZE_URL}?${params}`);

      const callback = await listener.params;
      const error = callback.get('error');
      if (error === 'access_denied') throw new ModelProviderError('not-signed-in', 'ChatGPT sign-in was cancelled. Nothing was changed.');
      if (error) throw new ModelProviderError(error === 'invalid_client' ? 'auth' : 'other', `ChatGPT sign-in failed: ${error}.`);
      const code = callback.get('code');
      if (!code) throw new Error('ChatGPT sign-in returned no authorization code.');
      const returned = callback.get('client_id');
      // A new registration names its issued client; a reauthorization keeps the one it asked with.
      if (!saved && !returned) throw new Error('ChatGPT registration did not complete (no client id came back). Try again.');
      if (saved && returned && returned !== saved.client_id) throw new Error('ChatGPT returned a different client than the one signing in. Nothing was changed.');
      const clientId = saved?.client_id ?? returned!;

      const { res, json } = await tokenRequest({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        code_verifier: verifier,
        redirect_uri: listener.redirectUri,
        resource: RESOURCE,
      });
      if (!res.ok) {
        const reason = String(json.error ?? res.status);
        // invalid_grant: the code is spent or stale; a fresh attempt with the same client id is the fix.
        throw new ModelProviderError(reason === 'invalid_client' ? 'auth' : 'other', `ChatGPT sign-in couldn't be completed (${reason}). Try again.`);
      }
      const idToken = String(json.id_token ?? '');
      const claims = await validateIdToken(idToken, { issuer: ISSUER, audience: clientId, nonce }, keys, now());
      if (saved && saved.subject !== claims.sub) throw new Error('You signed in to a different ChatGPT account than the one selected. Nothing was changed.');
      const scopes = String(json.scope ?? callback.get('scope') ?? '').split(/[\s+]+/).filter(Boolean);
      const expiresIn = Number(json.expires_in) || null;
      const previous = store.accounts[clientId];
      store.accounts[clientId] = {
        email: typeof claims.email === 'string' ? claims.email : (previous?.email ?? null),
        issuer: ISSUER,
        subject: claims.sub,
        client_id: clientId,
        ext_agent_host_id: store.hostId,
        id_token: idToken,
        access_token: String(json.access_token ?? '') || null,
        refresh_token: String(json.refresh_token ?? '') || null,
        token_type: String(json.token_type ?? 'Bearer'),
        expires_in: expiresIn,
        expires_at: expiresIn ? now() + expiresIn * 1000 : null,
        earliest_refresh_at: typeof json.earliest_refresh_at === 'number' ? json.earliest_refresh_at * 1000 : null,
        scopes,
        saved_at: new Date(now()).toISOString(),
        welcomed: previous?.welcomed ?? false,
        problem: null,
      };
      store.active = clientId;
      save();
      return status();
    } finally {
      listener.close();
    }
  }

  /** Replaces the access token, expiry, scopes and rotating refresh token together. */
  async function refresh(account: AccountRecord): Promise<AccountRecord> {
    const pending = refreshing.get(account.client_id);
    if (pending) return pending;
    const run = (async () => {
      if (!account.refresh_token) throw new ModelProviderError('not-signed-in', 'Sign in to ChatGPT again to use your plan.');
      let result;
      try {
        result = await tokenRequest({ grant_type: 'refresh_token', client_id: account.client_id, refresh_token: account.refresh_token, resource: RESOURCE });
      } catch {
        throw new ModelProviderError('unavailable', "Couldn't reach OpenAI to renew the ChatGPT sign-in. Try again shortly.", { retryable: true });
      }
      const { res, json } = result;
      if (!res.ok) {
        const reason = String(json.error ?? '');
        if (TERMINAL_REFRESH_ERRORS.has(reason)) {
          Object.assign(account, { access_token: null, refresh_token: null, expires_at: null, problem: 'Your ChatGPT sign-in ended. Continue with ChatGPT to sign in again.' });
          save();
          throw new ModelProviderError('not-signed-in', 'Your ChatGPT sign-in ended. Continue with ChatGPT to sign in again.', { providerCode: reason, status: res.status });
        }
        throw new ModelProviderError('unavailable', `OpenAI couldn't renew the ChatGPT sign-in right now (HTTP ${res.status}).`, { retryable: res.status >= 500, status: res.status, providerCode: reason || undefined });
      }
      const expiresIn = Number(json.expires_in) || null;
      Object.assign(account, {
        access_token: String(json.access_token),
        refresh_token: String(json.refresh_token ?? account.refresh_token),
        id_token: json.id_token ? String(json.id_token) : account.id_token,
        expires_in: expiresIn,
        expires_at: expiresIn ? now() + expiresIn * 1000 : null,
        earliest_refresh_at: typeof json.earliest_refresh_at === 'number' ? json.earliest_refresh_at * 1000 : null,
        scopes: json.scope ? String(json.scope).split(/\s+/).filter(Boolean) : account.scopes,
        saved_at: new Date(now()).toISOString(),
        problem: null,
      });
      save();
      return account;
    })().finally(() => refreshing.delete(account.client_id));
    refreshing.set(account.client_id, run);
    return run;
  }

  /**
   * A bearer token for plan-billed inference, renewed near expiry. Throws a ModelProviderError when
   * there's no usable plan sign-in; it never falls back to another billing path.
   */
  async function accessToken(): Promise<{ token: string; clientId: string }> {
    if (!options.enabled) throw new ModelProviderError('not-eligible', 'ChatGPT plan usage is turned off for this build of Vowe.');
    let a = active();
    if (!a || (!a.access_token && !a.refresh_token)) throw new ModelProviderError('not-signed-in', a?.problem ?? 'Continue with ChatGPT to use your ChatGPT plan.');
    // A valid ID token alone doesn't authorize plan usage: the grant must include the plan scope.
    if (!hasPlan(a)) throw new ModelProviderError('not-eligible', 'ChatGPT plan usage was not granted. Continue with ChatGPT and allow plan usage, or use an API key.');
    const expired = !a.access_token || !a.expires_at || a.expires_at - REFRESH_EARLY_MS < now();
    const tooSoon = a.earliest_refresh_at !== null && now() < a.earliest_refresh_at && a.access_token && a.expires_at && a.expires_at > now();
    if (expired && !tooSoon) a = await refresh(a);
    return { token: a.access_token!, clientId: a.client_id };
  }

  /**
   * Stops using the active account: attempts to revoke its renewable session, then clears its tokens.
   * Keeps the account's client id and this host's id for the next sign-in. Resolves with whether
   * OpenAI confirmed the revocation.
   */
  async function signOut(): Promise<{ revoked: boolean }> {
    const a = active();
    if (!a) return { revoked: true };
    let revoked = !a.refresh_token;
    if (a.refresh_token) {
      for (let attempt = 0; attempt < 3 && !revoked; attempt++) {
        try {
          revocationEndpoint ??= String(((await (await http(OPENID_CONFIG_URL)).json()) as { revocation_endpoint: string }).revocation_endpoint);
          const res = await http(revocationEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: a.refresh_token, token_type_hint: 'refresh_token', client_id: a.client_id }),
          });
          if (res.ok) revoked = true;
          else if (res.status < 500) break;
        } catch {
          // network failure: retry below
        }
        if (!revoked) await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
      }
    }
    Object.assign(a, { access_token: null, refresh_token: null, id_token: null, expires_at: null, problem: null });
    store.active = null;
    save();
    return { revoked };
  }

  return {
    status,
    signIn,
    signOut,
    accessToken,
    /** The welcome was seen ("Got it"). */
    dismissWelcome() {
      const a = active();
      if (a && !a.welcomed) {
        a.welcomed = true;
        save();
      }
    },
    /** Switches to a saved account without signing anyone out. */
    use(clientId: string) {
      if (!store.accounts[clientId]) throw new Error('No such saved ChatGPT account.');
      store.active = clientId;
      save();
    },
    onChange(listener: (status: ChatGptStatus) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type ChatGptAuth = ReturnType<typeof createChatGptAuth>;
