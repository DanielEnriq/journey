import { isAuthError, isAuthRetryableFetchError, type Session, type User as CloudUser, type UserIdentity } from '@supabase/supabase-js';
import { randomBytes } from 'node:crypto';
import type { AuthErrorCode, AuthFailure, SignInMethod, SignInProvider, User } from '../../shared/api.js';
import { listenForAuthRedirect, RedirectAbandoned } from '../google/loopback.js';
import type { Cloud } from './index.js';

/**
 * Sign-in methods on one Vowe account, through Supabase Auth. No Electron here: main supplies the browser
 * (and src/integrations/account wires it up), so the integration tests run these flows for real.
 *
 * Every method is an identity on the person's single Supabase user, so whichever they sign in with,
 * auth.uid() and with it every room, membership, invitation and decision stays the same. Nothing is
 * ever moved between users. Linking is explicit, by the signed-in person (linkIdentity), and the
 * provider account must not already sign in to someone else. Supabase also joins a new identity to an
 * existing user on a matching email, but only on an email the provider verified, and only while the
 * project has "Confirm email" on: assertReady() refuses GitHub on a project that would accept
 * unverified emails.
 *
 * OAuth runs in a throwaway client (authClient()) and only plain tokens reach the app's client, so the
 * provider's own access token is never kept, and a link can't replace the session the app runs on.
 */

export const SIGN_IN_PROVIDERS: readonly SignInProvider[] = ['google', 'github'];
export const PROVIDER_NAMES: Record<SignInProvider, string> = { google: 'Google', github: 'GitHub' };

export class AuthFlowError extends Error {
  constructor(readonly code: AuthErrorCode, message: string, readonly provider?: SignInProvider) {
    super(message);
  }
}

/** Any error from a sign-in or link, in words to show. */
export function toAuthFailure(err: unknown, provider?: SignInProvider): AuthFailure {
  const e = asAuthFlowError(err, provider);
  return e.provider ? { code: e.code, message: e.message, provider: e.provider } : { code: e.code, message: e.message };
}

function asAuthFlowError(err: unknown, provider?: SignInProvider): AuthFlowError {
  if (err instanceof AuthFlowError) return err;
  const name = provider ? PROVIDER_NAMES[provider] : 'Sign-in';
  if (err instanceof RedirectAbandoned) return new AuthFlowError(err.reason, err.message, provider);
  if (isAuthRetryableFetchError(err)) return new AuthFlowError('unknown', `Couldn’t reach Vowe’s server. Check your connection and try again.`, provider);
  if (isAuthError(err)) return fromSupabase(err.code, err.message, provider);
  const message = err instanceof Error ? err.message : String(err);
  if (/not signed in/i.test(message)) return new AuthFlowError('signed-out', 'Sign in to Vowe first.', provider);
  return new AuthFlowError('unknown', `${name} didn’t finish: ${message}`, provider);
}

/** Supabase's error codes (from an API error or a redirect), as what happened and what to do. */
function fromSupabase(code: string | undefined, description: string, provider?: SignInProvider): AuthFlowError {
  const name = provider ? PROVIDER_NAMES[provider] : 'That provider';
  switch (code) {
    case 'identity_already_exists':
      return new AuthFlowError(
        'linked-elsewhere',
        `That ${name} account already signs in to a different Vowe account, so it wasn’t added here and nothing was merged. Sign in with it to use that account, or remove it there first.`,
        provider,
      );
    case 'provider_email_needs_verification':
    case 'email_not_confirmed':
      return new AuthFlowError('email-unverified', `${name} hasn’t verified this account’s email. Verify it with ${name}, then try again.`, provider);
    case 'manual_linking_disabled':
      return new AuthFlowError('not-configured', 'Linking sign-in methods isn’t turned on for this Vowe server (Supabase: Auth → allow manual linking).', provider);
    case 'provider_disabled':
      return new AuthFlowError('not-configured', `${name} sign-in isn’t turned on for this Vowe server.`, provider);
    case 'single_identity_not_deletable':
      return new AuthFlowError('last-method', 'That’s your only way to sign in, so it can’t be removed.', provider);
    case 'identity_not_found':
      return new AuthFlowError('not-linked', `${name} isn’t one of your sign-in methods.`, provider);
    case 'session_not_found':
    case 'refresh_token_not_found':
    case 'refresh_token_already_used':
    case 'session_expired':
      return new AuthFlowError('session-expired', 'Your session ended. Sign in again.', provider);
    case 'flow_state_expired':
    case 'flow_state_not_found':
    case 'bad_oauth_state':
    case 'bad_code_verifier':
      return new AuthFlowError('timed-out', `That ${name} sign-in expired. Try again.`, provider);
    case 'unexpected_failure':
      // With "Confirm email" on, Supabase refuses to join an unverified provider email to an existing user,
      // and reports it this way.
      if (/saving new user/i.test(description)) {
        return new AuthFlowError(
          'email-unverified',
          `${name}’s email matches an existing Vowe account but ${name} hasn’t verified it. Verify it with ${name}, or sign in your usual way and link ${name} from your account.`,
          provider,
        );
      }
  }
  return new AuthFlowError('unknown', `${name} didn’t finish: ${description || code || 'unknown error'}`, provider);
}

/** The code in a Supabase redirect, or why there isn't one. */
export function codeFromRedirect(params: URLSearchParams, provider: SignInProvider): string {
  const code = params.get('code');
  const error = params.get('error');
  if (code && !error) return code;
  const errorCode = params.get('error_code') ?? undefined;
  const description = params.get('error_description') ?? '';
  if (!errorCode && error === 'access_denied') {
    return failWith(new AuthFlowError('cancelled', `${PROVIDER_NAMES[provider]} sign-in was cancelled.`, provider));
  }
  if (error === 'no_result') return failWith(new AuthFlowError('unknown', `${PROVIDER_NAMES[provider]} sent no result back. Try again.`, provider));
  return failWith(fromSupabase(errorCode ?? error ?? undefined, description, provider));
}

function failWith(err: AuthFlowError): never {
  throw err;
}

// ─── Server settings ─────────────────────────────────────────────────────────

/** The public part of the project's Auth settings: which providers are on, and whether emails are trusted unconfirmed. */
export interface AuthSettings {
  external: Partial<Record<string, boolean>>;
  mailer_autoconfirm: boolean;
}

export async function fetchAuthSettings(url: string, publishableKey: string, fetchImpl: typeof fetch = fetch): Promise<AuthSettings> {
  const res = await fetchImpl(`${url}/auth/v1/settings`, { headers: { apikey: publishableKey } });
  if (!res.ok) throw new Error(`Supabase Auth settings: HTTP ${res.status}`);
  return (await res.json()) as AuthSettings;
}

/** Why `provider` can't be used against this project, or null if it can. */
export function whyUnavailable(settings: AuthSettings, provider: SignInProvider): AuthFlowError | null {
  const name = PROVIDER_NAMES[provider];
  if (!settings.external[provider]) {
    return new AuthFlowError('not-configured', `${name} sign-in isn’t turned on for this Vowe server (Supabase: Auth → Providers → ${name}).`, provider);
  }
  // With autoconfirm, Supabase treats every email a provider reports as verified, so a GitHub account
  // holding someone's address unverified would be joined to their Vowe account. Refuse rather than risk it.
  if (provider === 'github' && settings.mailer_autoconfirm) {
    return new AuthFlowError(
      'not-configured',
      'GitHub sign-in is off: this Vowe server accepts unconfirmed emails, which would let a GitHub account claim someone else’s address (Supabase: Auth → turn on Confirm email).',
      provider,
    );
  }
  return null;
}

// ─── Browser flows ───────────────────────────────────────────────────────────

export interface BrowserFlow {
  /** Opens the system browser at `url`. */
  open(url: string): Promise<void>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Signs in with an OAuth provider through Supabase (PKCE) and resolves with the new session. `client` is
 * a throwaway authClient(); hand the session's tokens to the app's client. Supabase asks GitHub only for
 * `user:email`: signing in grants no repository access.
 */
export async function signInWithOAuth(client: Cloud, provider: 'github', flow: BrowserFlow): Promise<Session> {
  const listener = await listenForAuthRedirect(randomBytes(16).toString('hex'), { provider: PROVIDER_NAMES[provider], signal: flow.signal, timeoutMs: flow.timeoutMs });
  try {
    const { data, error } = await client.auth.signInWithOAuth({ provider, options: { redirectTo: listener.redirectUri, skipBrowserRedirect: true } });
    if (error) throw error;
    await flow.open(data.url);
    const code = codeFromRedirect(await listener.params, provider);
    const exchanged = await client.auth.exchangeCodeForSession(code, data.flowId ? { flowId: data.flowId } : undefined);
    if (exchanged.error) throw exchanged.error;
    return exchanged.data.session;
  } catch (err) {
    throw asAuthFlowError(err, provider);
  } finally {
    listener.close();
  }
}

/** Links an OAuth provider to the account signed in as `session`, through the browser. */
export async function linkWithOAuth(client: Cloud, session: Session, provider: 'github', flow: BrowserFlow): Promise<void> {
  const listener = await listenForAuthRedirect(randomBytes(16).toString('hex'), { provider: PROVIDER_NAMES[provider], signal: flow.signal, timeoutMs: flow.timeoutMs });
  try {
    await actAs(client, session);
    const { data, error } = await client.auth.linkIdentity({ provider, options: { redirectTo: listener.redirectUri } });
    if (error) throw error;
    await flow.open(data.url);
    const code = codeFromRedirect(await listener.params, provider);
    const exchanged = await client.auth.exchangeCodeForSession(code, data.flowId ? { flowId: data.flowId } : undefined);
    if (exchanged.error) throw exchanged.error;
    await settleLink(client, session.user.id, exchanged.data.session, provider);
  } catch (err) {
    throw asAuthFlowError(err, provider);
  } finally {
    listener.close();
  }
}

/** Links a provider whose ID token the app got itself (Google, signed in natively) to the account signed in as `session`. */
export async function linkWithIdToken(client: Cloud, session: Session, provider: 'google', proof: { idToken: string; accessToken: string }): Promise<void> {
  try {
    await actAs(client, session);
    const { data, error } = await client.auth.linkIdentity({ provider, token: proof.idToken, access_token: proof.accessToken });
    if (error) throw error;
    await settleLink(client, session.user.id, data.session, provider);
  } catch (err) {
    throw asAuthFlowError(err, provider);
  }
}

/**
 * The throwaway client acts as the signed-in person for one link. It never refreshes (that would rotate
 * the app's refresh token out from under it), so the access token must have time left.
 */
async function actAs(client: Cloud, session: Session) {
  if ((session.expires_at ?? 0) * 1000 - Date.now() < 2 * 60_000) throw new AuthFlowError('session-expired', 'Your session is about to expire. Try again.');
  const { error } = await client.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
  if (error) throw error;
}

/**
 * A link issues a second session for the same person. End that one by its own token, never the app's, and
 * refuse if it somehow belongs to someone else.
 */
async function settleLink(client: Cloud, me: string, linked: Session | null, provider: SignInProvider) {
  if (!linked) throw new AuthFlowError('unknown', `${PROVIDER_NAMES[provider]} wasn’t linked: no session came back.`, provider);
  const { error } = await client.auth.admin.signOut(linked.access_token, 'local');
  if (error) console.warn('[auth] could not end the linking session:', error.message);
  if (linked.user.id !== me) throw new AuthFlowError('unknown', `${PROVIDER_NAMES[provider]} answered for a different account, so nothing changed on yours.`, provider);
}

// ─── Methods on the account ──────────────────────────────────────────────────

/** Removes `provider` from the signed-in account. Not the method this session used, and never the last one. */
export async function unlinkProvider(client: Cloud, provider: SignInProvider, current: SignInProvider): Promise<void> {
  try {
    const { data, error } = await client.auth.getUserIdentities();
    if (error) throw error;
    const identity = data.identities.find((i) => i.provider === provider);
    if (!identity) throw new AuthFlowError('not-linked', `${PROVIDER_NAMES[provider]} isn’t one of your sign-in methods.`, provider);
    if (provider === current) {
      throw new AuthFlowError('current-method', `You’re signed in with ${PROVIDER_NAMES[provider]}. Sign in another way to remove it.`, provider);
    }
    if (!data.identities.some((i) => i !== identity && isSignInProvider(i.provider))) {
      throw new AuthFlowError('last-method', `${PROVIDER_NAMES[provider]} is your only way to sign in, so it can’t be removed.`, provider);
    }
    const { error: unlinkError } = await client.auth.unlinkIdentity(identity);
    if (unlinkError) throw unlinkError;
  } catch (err) {
    throw asAuthFlowError(err, provider);
  }
}

export function isSignInProvider(value: unknown): value is SignInProvider {
  return SIGN_IN_PROVIDERS.includes(value as SignInProvider);
}

/** The account's identities as sign-in methods, one per provider Vowe offers. */
export function describeMethods(
  identities: Pick<UserIdentity, 'provider' | 'identity_data' | 'created_at'>[],
  current: SignInProvider,
  available: Record<SignInProvider, boolean>,
): SignInMethod[] {
  const linked = identities.filter((i) => isSignInProvider(i.provider));
  return SIGN_IN_PROVIDERS.map((provider) => {
    const identity = linked.find((i) => i.provider === provider);
    const data = identity?.identity_data ?? {};
    const text = (key: string) => (typeof data[key] === 'string' && data[key] ? (data[key] as string) : null);
    return {
      provider,
      linked: Boolean(identity),
      email: text('email'),
      username: provider === 'github' ? text('user_name') ?? text('preferred_username') : null,
      linkedAt: identity?.created_at ?? null,
      current: provider === current,
      available: available[provider],
      canUnlink: Boolean(identity) && provider !== current && linked.some((i) => i.provider !== provider),
    };
  });
}

/** A stored session's refresh token as a live session on `client`, or `session-expired` if Supabase ended it. */
export async function resumeSession(client: Cloud, refreshToken: string): Promise<Session> {
  const { data, error } = await client.auth.refreshSession({ refresh_token: refreshToken });
  if (error && !isAuthRetryableFetchError(error)) throw new AuthFlowError('session-expired', 'Your session ended. Sign in again.');
  if (error) throw asAuthFlowError(error);
  if (!data.session) throw new AuthFlowError('session-expired', 'Your session ended. Sign in again.');
  return data.session;
}

/** Who a cloud session is, as this app's signed-in user. */
export function profileOf(user: CloudUser, provider: SignInProvider): User {
  const meta = user.user_metadata ?? {};
  const text = (...keys: string[]) => keys.map((k) => meta[k]).find((v): v is string => typeof v === 'string' && v.length > 0) ?? null;
  return { id: user.id, email: user.email ?? '', name: text('full_name', 'name', 'user_name'), picture: text('avatar_url', 'picture'), provider };
}
