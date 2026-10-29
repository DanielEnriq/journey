import type { AuthFailure, AuthResult, SignInMethod, SignInProvider, User } from '../../shared/api.js';
import { Store } from './store.js';

// Who is signed in: the main process's sign-in says (auth:getUser, auth:changed).

/**
 * `undefined` until the main process answers; `null` when signed out. `ended`: why the last session ended
 * on its own (expired or revoked), for the sign-in screen; cleared by the next sign-in.
 */
export const account = new Store<{ user: User | null | undefined; ended: AuthFailure | null }>({
  user: undefined,
  ended: null,
});

window.journey.auth.onChange((user) => account.setState(user ? { user, ended: null } : { user }));
window.journey.auth.onEnded((ended) => account.setState({ ended }));
// A session that ended before this window opened (at launch) is told here.
window.journey.auth.getEnded().then((ended) => { if (ended && !account.state.user) account.setState({ ended }); }, () => {});
// A change that lands first is newer than this answer.
window.journey.auth.getUser().then(
  (user) => { if (account.state.user === undefined) account.setState({ user }); },
  () => { if (account.state.user === undefined) account.setState({ user: null }); },
);

/** Rejects with a message to show as is. */
export async function signIn(provider: SignInProvider): Promise<User> {
  try {
    return await window.journey.auth.signIn(provider);
  } catch (err) {
    throw new Error(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '') : String(err));
  }
}

/** Stops waiting for the browser; the sign-in or link in flight fails as cancelled. */
export function cancelSignIn(): Promise<void> {
  return window.journey.auth.cancel();
}

export function signOut(): Promise<void> {
  return window.journey.auth.signOut();
}

// ─── Sign-in methods ─────────────────────────────────────────────────────────
// The account's ways to sign in (Google, GitHub), for settings. Interfaces only; the visual treatment
// comes separately. `busy`: the provider being linked or removed.

export const signInMethods = new Store<{ methods: SignInMethod[] | null; busy: SignInProvider | null; error: AuthFailure | null }>({
  methods: null,
  busy: null,
  error: null,
});

async function apply(provider: SignInProvider | null, run: () => Promise<AuthResult<SignInMethod[]>>) {
  signInMethods.setState({ busy: provider, error: null });
  try {
    const result = await run();
    signInMethods.setState(result.ok ? { methods: result.value } : { error: result.error });
  } catch (err) {
    signInMethods.setState({ error: { code: 'unknown', message: err instanceof Error ? err.message : String(err) } });
  } finally {
    signInMethods.setState({ busy: null });
  }
}

export function loadSignInMethods(): Promise<void> {
  return apply(null, () => window.journey.auth.methods());
}

/** Opens the provider in the browser to add it to this account. */
export function linkSignInMethod(provider: SignInProvider): Promise<void> {
  return apply(provider, () => window.journey.auth.link(provider));
}

export function unlinkSignInMethod(provider: SignInProvider): Promise<void> {
  return apply(provider, () => window.journey.auth.unlink(provider));
}

/** What to call someone: the first word of their name, or the front of their email. */
export function firstName(user: User | null | undefined): string {
  return user?.name?.trim().split(/\s+/)[0] || user?.email.split('@')[0] || '';
}

export function initials(name: string): string {
  return name.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}
