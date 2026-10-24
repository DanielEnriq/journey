import type { User } from '../../shared/api.js';
import { mockLog } from './mock.js';
import { Store } from './store.js';

// Who is signed in. In the app, the main process's Google sign-in says (auth:getUser, auth:changed); the
// preview has no sign-in, so it is always the mock workspace's person.

const PREVIEW_USER: User = { id: 'preview', email: '', name: 'Daniel Enriquez', picture: null };

/** `undefined` until the main process answers; `null` when signed out. */
export const account = new Store<{ user: User | null | undefined }>({ user: window.journey ? undefined : PREVIEW_USER });

if (window.journey) {
  window.journey.auth.onChange((user) => account.setState({ user }));
  // A change that lands first is newer than this answer.
  window.journey.auth.getUser().then(
    (user) => { if (account.state.user === undefined) account.setState({ user }); },
    () => { if (account.state.user === undefined) account.setState({ user: null }); },
  );
}

export function signOut(): Promise<void> {
  if (window.journey) return window.journey.auth.signOut();
  mockLog('auth', 'Sign out: preview only, back to the sign-in screen');
  location.hash = '#/login';
  return Promise.resolve();
}

/** What to call someone: the first word of their name, or the front of their email. */
export function firstName(user: User | null | undefined): string {
  return user?.name?.trim().split(/\s+/)[0] || user?.email.split('@')[0] || '';
}

export function initials(name: string): string {
  return name.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}
