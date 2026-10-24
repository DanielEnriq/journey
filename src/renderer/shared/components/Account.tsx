import { h } from '../../vendor/preact.js';
import { useEffect, useRef, useState } from '../../vendor/preact-hooks.js';
import { account, initials, signOut } from '../account.js';
import { useStore } from '../store.js';
import { useThemeSetting } from '../theme/theme.js';
import type { Theme } from '../../../shared/api.js';

// The sidebar's foot: who you are, and a small panel for appearance and signing out.

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
          <button class="account-out" type="button" disabled={leaving} onClick={out}>{leaving ? 'Signing out…' : 'Sign out'}</button>
        </div>
      )}
      <button class="account-me" type="button" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}>
        <span class="avatar">{initials(name)}</span>
        <span class="account-who"><span class="nm">{name}</span>{sub && <span class="em">{sub}</span>}</span>
      </button>
    </div>
  );
}
