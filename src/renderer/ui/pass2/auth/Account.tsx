// Source: vowe-home-pass2.zip (approved Claude Design package, Pass 2), imports adapted to the vendored Preact.
/**
 * Account, from the sidebar foot. This mirrors Journey's `AccountFoot` panel:
 * who you are, Appearance, Sign-in methods, Vowe's model (ChatGPT), Sign out.
 *
 * Sign-in methods open as a sheet driven by `auth.methods()`. Every rule comes
 * from the `SignInMethod` data (`canUnlink`, `current`, `available`); the UI
 * only explains it. Sign-in methods are kept visibly apart from model access
 * and repository access.
 */
import { Fragment, h, type ComponentChildren } from '../../../vendor/preact.js';
import { useEffect, useRef } from '../../../vendor/preact-hooks.js';

import { Avatar, Badge, Button, FaultNotice, MenuItem, MenuSeparator, Segmented, Spinner } from '../../components.js';
import { Icon } from '../../icons.js';

import { Note, PROVIDER_LABEL, ProviderMark, Sheet } from '../common.js';
import type { AuthFailure, ChatGptStatus, SignInMethod, Theme } from '../../../../shared/api.js';
import type { AccountView, ProviderId } from '../types.js';

export function AccountMenu({ account, theme, chatgpt, onTheme, onManageSignIn, onChatGpt, onSignOut, onClose, signingOut, style }: {
  account: AccountView;
  theme: Theme;
  /** `chatgpt.status()`; null or `enabled: false` hides Vowe's model. */
  chatgpt: ChatGptStatus | null;
  onTheme: (t: Theme) => void;
  onManageSignIn: () => void;
  /** "Continue with ChatGPT", or open its section when already using it. */
  onChatGpt?: () => void;
  onSignOut: () => void;
  onClose: () => void;
  signingOut?: boolean;
  style?: Record<string, string>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('[data-account-anchor]')) onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    addEventListener('pointerdown', away);
    addEventListener('keydown', esc);
    return () => { removeEventListener('pointerdown', away); removeEventListener('keydown', esc); };
  }, [onClose]);
  const usingPlan = !!chatgpt?.signedIn && chatgpt.planUsage === 'granted';
  return (
    <div ref={ref} class="vh-pop" role="dialog" aria-label="Account" style={style ?? { left: '8px', bottom: '58px' }}>
      <div class="vh-pop-head">
        <Avatar initials={account.initials} tone={account.tone} size={36} />
        <div style={{ minWidth: 0 }}>
          <b>{account.name}</b>
          <span class="v-meta">{account.email}</span>
        </div>
      </div>
      <div class="vh-pop-sec">
        <span class="v-label" style={{ display: 'block', marginBottom: '8px' }}>Appearance</span>
        <Segmented label="Appearance" value={theme} onChange={onTheme}
          items={[{ key: 'system', label: 'System' }, { key: 'light', label: 'Light' }, { key: 'dark', label: 'Dark' }]} />
      </div>
      <MenuSeparator />
      <MenuItem icon="lock" label="Sign-in methods…" shortcut={PROVIDER_LABEL[account.provider]} onSelect={onManageSignIn} />
      {chatgpt?.enabled ? (
        <MenuItem icon="terminal" label={usingPlan ? 'Vowe’s model · ChatGPT plan' : 'Vowe’s model…'} onSelect={onChatGpt} />
      ) : null}
      <MenuSeparator />
      <MenuItem label={signingOut ? 'Signing out…' : 'Sign out'} onSelect={signingOut ? undefined : onSignOut} />
    </div>
  );
}

export interface SignInMethodsProps {
  /** `auth.methods()`; null while it loads. */
  methods: SignInMethod[] | null;
  /** The provider being linked or removed (`signInMethods.busy`). */
  busy: ProviderId | null;
  /** True while `busy` is a link waiting on the browser, so Cancel can show. */
  linking?: boolean;
  error: AuthFailure | null;
  marks?: Partial<Record<ProviderId, ComponentChildren>>;
  onLink: (p: ProviderId) => void;
  onUnlink: (p: ProviderId) => void;
  /** `auth.cancel()`: a link in flight fails as cancelled. */
  onCancel: () => void;
  /** Opens Vowe's model in the account panel. */
  onOpenModel?: () => void;
  onClose: () => void;
}

/** Why Remove isn't offered, from the method's own data. */
function whyKept(m: SignInMethod, methods: SignInMethod[]): string | null {
  if (!m.linked || m.canUnlink) return null;
  if (m.current) return 'You signed in with this. Sign in another way to remove it.';
  if (methods.filter((x) => x.linked).length <= 1) return 'Your only sign-in method. Link another first.';
  return null;
}

export function SignInMethodsSheet({ methods, busy, linking, error, marks = {}, onLink, onUnlink, onCancel, onOpenModel, onClose }: SignInMethodsProps) {
  const shown = methods?.filter((m) => m.linked || m.available) ?? [];
  const githubLinked = !!methods?.some((m) => m.provider === 'github' && m.linked);
  return (
    <Sheet title="Sign-in methods" subtitle="Ways to sign in to your one Vowe account. Either one opens the same rooms." onClose={onClose} width={500}
      footer={<Button variant="quiet" onClick={onClose}>Done</Button>}>
      {error && error.code !== 'cancelled' ? <FaultNotice title={error.code === 'linked-elsewhere' ? 'Already used by another Vowe account' : 'That didn’t work'}>{error.message}</FaultNotice> : null}
      {error?.code === 'cancelled' ? <div class="vh-auth-quiet" role="status"><Icon name="close" size={14} />Linking cancelled. Nothing changed.</div> : null}
      <div class="vh-choices" aria-busy={methods === null}>
        {methods === null ? (
          <div class="vh-choice" style={{ cursor: 'default' }}><Spinner /><span class="v-meta">Loading your sign-in methods…</span></div>
        ) : shown.map((m) => {
          const working = busy === m.provider;
          const kept = whyKept(m, methods);
          const detail = m.linked ? [m.username && `@${m.username}`, m.email].filter(Boolean).join(' · ') : 'Not linked';
          return (
            <div key={m.provider} class="vh-choice" style={{ cursor: 'default' }}>
              <ProviderMark provider={m.provider} mark={marks[m.provider]} />
              <span class="vh-choice-main">
                <b>{PROVIDER_LABEL[m.provider]}{m.current ? <span class="v-meta" style={{ display: 'inline' }}> · this session</span> : null}</b>
                <span class="v-meta">{working && linking ? 'Continue in your browser…' : kept ?? detail}</span>
              </span>
              {m.linked && !working ? <Badge tone="neutral" icon="check">Linked</Badge> : null}
              {working && linking ? (
                <><Spinner /><Button size="sm" variant="quiet" onClick={onCancel}>Cancel</Button></>
              ) : m.linked ? (
                m.canUnlink ? <Button size="sm" variant="quiet" loading={working} disabled={busy !== null && !working} onClick={() => onUnlink(m.provider)}>Remove</Button> : null
              ) : (
                <Button size="sm" variant="ink" disabled={busy !== null} onClick={() => onLink(m.provider)}>Link</Button>
              )}
            </div>
          );
        })}
      </div>
      {!githubLinked && shown.some((m) => m.provider === 'github') ? (
        <Note icon="branch"><b>GitHub here is only for signing in.</b> It asks for your email address, not your repositories.</Note>
      ) : null}
      <div>
        <span class="v-label" style={{ display: 'block', marginBottom: '8px' }}>Not sign-in methods</span>
        <div class="vh-note" style={{ flexDirection: 'column', gap: '6px' }}>
          <span><b>Vowe’s model.</b> Continue with ChatGPT lets Vowe’s answers use your ChatGPT plan. It’s separate, and it never signs you in to Vowe.</span>
          {onOpenModel ? <button type="button" class="v-link" style={{ alignSelf: 'flex-start' }} onClick={onOpenModel}>Open Vowe’s model</button> : null}
          <span><b>Repository access.</b> Rooms use repositories added on this machine. Connect GitHub isn’t in this build yet. When it comes, it will be its own permission.</span>
        </div>
      </div>
    </Sheet>
  );
}
