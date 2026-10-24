import { h } from '../../vendor/preact.js';
import { useEffect, useRef, useState } from '../../vendor/preact-hooks.js';
import { account, initials, signOut } from '../account.js';
import { chatgpt, continueWithChatGpt, dismissChatGptWelcome, signOutOfChatGpt } from '../chatgpt.js';
import { useStore } from '../store.js';
import { useThemeSetting } from '../theme/theme.js';
import type { Theme } from '../../../shared/api.js';

// The sidebar's foot: who you are, and a small panel for appearance, Vowe's model, and signing out.

const THEMES: [Theme, string][] = [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']];

export function AccountFoot({ sub }: { sub?: string }) {
  const { user } = useStore(account);
  const [theme, pickTheme] = useThemeSetting();
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    addEventListener('pointerdown', away);
    addEventListener('keydown', esc);
    return () => { removeEventListener('pointerdown', away); removeEventListener('keydown', esc); };
  }, [open]);
  if (!user) return null;
  const name = user.name || user.email;
  const out = () => { setLeaving(true); signOut().finally(() => { setLeaving(false); setOpen(false); }); };
  return (
    <div class="side-foot account" ref={ref}>
      {open && (
        <div class="account-panel" role="dialog" aria-label="Account">
          {user.email && <div class="account-email" title={user.email}>{user.email}</div>}
          <div class="account-label">Appearance</div>
          <div class="account-seg" role="radiogroup" aria-label="Appearance">
            {THEMES.map(([t, label]) => (
              <button key={t} type="button" role="radio" aria-checked={theme === t} class={theme === t ? 'on' : ''} onClick={() => pickTheme(t)}>{label}</button>
            ))}
          </div>
          <ChatGptSection />
          <button class="account-out" type="button" disabled={leaving} onClick={out}>{leaving ? 'Signing out…' : 'Sign out'}</button>
        </div>
      )}
      <ChatGptWelcome />
      <button class="account-me" type="button" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}>
        <span class="avatar">{initials(name)}</span>
        <span class="account-who"><span class="nm">{name}</span>{sub && <span class="em">{sub}</span>}</span>
      </button>
    </div>
  );
}

/**
 * Sign in with ChatGPT, so Vowe's agent runs on your ChatGPT plan. Separate from Google, which is who
 * you are in rooms. Wording follows OpenAI's guidelines: "Continue with ChatGPT", "Using ChatGPT plan",
 * "Manage usage". Hidden when this build doesn't offer plan usage.
 */
function ChatGptSection() {
  const { status, busy, error } = useStore(chatgpt);
  if (!status?.enabled) return null;
  const using = status.signedIn && status.planUsage === 'granted';
  return (
    <div class="account-gpt">
      <div class="account-label">Vowe’s model</div>
      {using ? (
        <div class="account-gpt-row">
          <span class="account-gpt-on" title={status.account?.label}>Using ChatGPT plan</span>
          <a class="account-gpt-link" href={status.usageUrl} target="_blank" rel="noreferrer">Manage usage</a>
        </div>
      ) : (
        <div class="account-gpt-note">
          {status.signedIn && status.planUsage === 'not-granted'
            ? 'Plan usage wasn’t allowed. Allow it to use your ChatGPT plan, or Vowe uses an API key if one is set.'
            : status.problem ?? 'Use your ChatGPT plan for Vowe’s answers. Separate from any charges for Vowe itself.'}
        </div>
      )}
      {!using && (
        <button class="account-gpt-go" type="button" disabled={busy} onClick={() => continueWithChatGpt()}>
          {busy ? 'Waiting for ChatGPT…' : 'Continue with ChatGPT'}
        </button>
      )}
      {status.signedIn && (
        <button class="account-gpt-link button" type="button" disabled={busy} onClick={() => signOutOfChatGpt()}>
          Sign out of ChatGPT{status.account?.email ? ` (${status.account.email})` : ''}
        </button>
      )}
      {error && <div class="account-gpt-err" role="alert">{error}</div>}
    </div>
  );
}

/** Shown once, after the first sign-in with plan usage. */
function ChatGptWelcome() {
  const { status } = useStore(chatgpt);
  if (!status?.welcome) return null;
  return (
    <div class="gpt-welcome" role="dialog" aria-modal="true" aria-labelledby="gpt-welcome-title">
      <div class="gpt-welcome-card">
        <div id="gpt-welcome-title" class="gpt-welcome-title">You’re using your ChatGPT plan</div>
        <p>Vowe’s answers now use your ChatGPT plan. You can manage usage in <a href={status.usageUrl} target="_blank" rel="noreferrer">ChatGPT settings</a>.</p>
        <button type="button" class="account-gpt-go" onClick={() => dismissChatGptWelcome()}>Got it</button>
      </div>
    </div>
  );
}
