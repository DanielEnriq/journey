import { h } from '../../vendor/preact.js';
import { useState } from '../../vendor/preact-hooks.js';
import { account, cancelSignIn } from '../../shared/account.js';
import { useStore } from '../../shared/store.js';
import { SignIn, type SignInState } from '../../ui/SignIn.js';
import { SessionSplash } from '../../ui/pass2/auth/SessionSplash.js';
import type { SignInProvider } from '../../../shared/api.js';

// Sign-in: the approved Pass 1 minimal, centered screen, kept as is in Pass 2. Sign-in is the main process's
// Google or GitHub sign-in. While the app is still finding out whether you're signed in, Pass 2's session
// splash shows instead of a blank window.

export interface LoginProps {
  /** The app's sign-in. The app leaves this screen once a user is signed in. */
  signIn: (provider: SignInProvider) => Promise<unknown>;
}

const PROVIDER_NAMES: Record<SignInProvider, string> = { google: 'Google', github: 'GitHub' };
/** Where each provider's sign-in happens in the browser: Google's own page, or GitHub's by way of Supabase. */
const PROVIDER_HOSTS: Record<SignInProvider, string> = { google: 'accounts.google.com', github: 'github.com' };

/**
 * The approved Pass 1 sign-in (ui/SignIn.tsx), driven by the main process's real Google and GitHub sign-in.
 * Only the state mapping lives here. Both providers stay listed, as before: the renderer can't ask main
 * which are configured until someone is signed in, and an unconfigured one fails with its real reason.
 * No matching code (main issues none) and no "open again" (main can't reopen the URL).
 */
export function LoginScreen({ signIn: realSignIn }: LoginProps) {
  const { ended } = useStore(account);
  const [login, setLogin] = useState<SignInProvider | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const signIn = (id: string) => {
    const provider = id as SignInProvider;
    setFailed(null);
    setLogin(provider);
    realSignIn(provider).catch((err: Error) => {
      setLogin((now) => (now === provider ? null : now)); // a newer sign-in replaced this one: leave it be
      if (!/was cancelled/.test(err.message)) setFailed(err.message || 'Sign-in did not complete.');
    });
  };
  // Stops the sign-in in main too, so the browser tab's answer no longer counts.
  const cancel = () => { setLogin(null); void cancelSignIn(); };
  const state: SignInState = login
      ? { kind: 'waiting', providerLabel: PROVIDER_NAMES[login], host: PROVIDER_HOSTS[login] }
      : failed
        ? { kind: 'error', message: failed }
        : ended
          ? { kind: 'error', title: 'You were signed out', message: ended.message }
          : { kind: 'idle' };
  return (
    <div class="welcome-screen">
      <SignIn
        providers={[
          { id: 'google', label: 'Google', available: true },
          { id: 'github', label: 'GitHub', available: true },
        ]}
        upcoming={[{ id: 'chatgpt', label: 'ChatGPT' }]}
        state={state}
        onSignIn={signIn}
        onCancel={cancel}
      />
    </div>
  );
}

/** Before the main process has said whether you're signed in: the session splash, not a blank window. */
export function OpeningVowe() {
  return <div class="welcome-screen"><SessionSplash label="Opening Vowe…" /></div>;
}
