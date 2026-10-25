/**
 * Source: vowe-foundations-pass1.zip (approved Claude Design package), imports adapted to the vendored Preact.
 * Sign-in (approved Pass 1 design, minimal). Presentational: the app's existing
 * auth flow owns state and passes it in. Nothing here starts OAuth itself.
 *
 * Capability rules (INTEGRATION.md §6):
 *  - Only providers with `available: true` get a button. A provider that isn't
 *    configured in the auth backend is simply absent, never a dead button.
 *  - `upcoming` providers (e.g. ChatGPT) render as one quiet, disabled line.
 *  - `waiting.userCode` is shown only when the auth backend actually issued a
 *    code to match in the browser. No code, no box.
 */
import { Fragment, h, type ComponentChildren } from '../vendor/preact.js';

import { Avatar, Button, FaultNotice, Mark, type PersonTone } from './components.js';
import { Icon } from './icons.js';

export interface AuthProviderOption {
  id: string;
  label: string;
  available: boolean;
  /** The official provider mark (an <img> or <svg> from the provider's brand kit). */
  mark?: ComponentChildren;
}

export type SignInState =
  | { kind: 'idle' }
  | { kind: 'waiting'; providerLabel: string; host: string; userCode?: string }
  | { kind: 'signed-in'; name: string; email: string; initials: string; tone?: PersonTone }
  | { kind: 'error'; title?: string; message: string };

export interface SignInProps {
  providers: AuthProviderOption[];
  upcoming?: { id: string; label: string }[];
  state: SignInState;
  onSignIn: (providerId: string) => void;
  onReopenBrowser?: () => void;
  onCancel: () => void;
  onOpenTerms?: () => void;
  onOpenPrivacy?: () => void;
}

export function SignIn({ providers, upcoming = [], state, onSignIn, onReopenBrowser, onCancel, onOpenTerms, onOpenPrivacy }: SignInProps) {
  const subtitle =
    state.kind === 'waiting' ? `Signing in with ${state.providerLabel}…` : state.kind === 'signed-in' ? 'Signed in. Opening Vowe…' : 'Sign in to continue.';
  const live = providers.filter((p) => p.available);
  return (
    <div class="vs-signin v-root v-grain">
      <div class="vs-signin-col">
        <div class="vs-signin-head">
          <span class="v-wordmark vs-signin-word"><Mark size={22} />vowe</span>
          <p aria-live="polite">{subtitle}</p>
        </div>

        {state.kind === 'idle' || state.kind === 'error' ? (
          <>
            {state.kind === 'error' ? <FaultNotice title={state.title ?? 'Sign-in didn’t finish'}>{state.message}</FaultNotice> : null}
            <div class="vs-signin-auth">
              {live.map((p) => (
                <Button key={p.id} onClick={() => onSignIn(p.id)}>
                  <span class="vs-provider-mark">{p.mark ?? null}</span>
                  <span class="vs-grow">Continue with {p.label}</span>
                </Button>
              ))}
              {live.length === 0 ? <p class="v-small">No sign-in method is configured. Check the auth settings for this build.</p> : null}
            </div>
            {upcoming.map((u) => (
              <div key={u.id} class="vs-signin-later" aria-disabled="true">
                <Icon name="lock" size={14} />
                <span>{u.label} sign-in</span>
                <span class="v-badge">Not available yet</span>
              </div>
            ))}
          </>
        ) : null}

        {state.kind === 'waiting' ? (
          <div class="vs-signin-panel">
            <div class="vs-signin-row">
              <span class="v-spinner" style={{ color: 'var(--v-info)' }} aria-hidden="true" />
              <span><b>Continue in your browser</b><span class="v-meta">{state.host}</span></span>
            </div>
            {state.userCode ? (
              <div class="vs-signin-code"><b>{state.userCode}</b><span>Check your browser shows the same code.</span></div>
            ) : null}
            <div class="vs-signin-acts">
              {onReopenBrowser ? <Button size="sm" icon="external" onClick={onReopenBrowser}>Open again</Button> : null}
              <Button size="sm" variant="quiet" onClick={onCancel}>Cancel</Button>
            </div>
          </div>
        ) : null}

        {state.kind === 'signed-in' ? (
          <div class="vs-signin-panel">
            <div class="vs-signin-row">
              <Avatar initials={state.initials} tone={state.tone ?? 1} size={28} />
              <span><b>{state.name}</b><span class="v-meta">{state.email}</span></span>
            </div>
          </div>
        ) : null}
      </div>
      {onOpenTerms || onOpenPrivacy ? (
        <div class="vs-signin-foot">
          {onOpenTerms ? <button type="button" class="v-link" onClick={onOpenTerms}>Terms</button> : null}
          {onOpenTerms && onOpenPrivacy ? <span>·</span> : null}
          {onOpenPrivacy ? <button type="button" class="v-link" onClick={onOpenPrivacy}>Privacy</button> : null}
        </div>
      ) : null}
    </div>
  );
}
