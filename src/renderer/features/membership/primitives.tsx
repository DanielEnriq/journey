import { h, type ComponentChildren } from '../../vendor/preact.js';
import { useEffect, useRef, useState } from '../../vendor/preact-hooks.js';
import type { User } from './model.js';

// The room-membership design's small parts: its icons, avatars, a menu, a confirmation sheet, quiet
// toasts. Ported from React to Preact as drawn; styles are membership.css's `vm-` classes.

const P = { fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } as const;

export const Icon = {
  mic: () => <svg viewBox="0 0 16 16" {...P} aria-hidden="true"><rect x="5.5" y="1.8" width="5" height="8" rx="2.5"></rect><path d="M3 7.6a5 5 0 0 0 10 0M8 12.6v1.8"></path></svg>,
  micOff: () => <svg viewBox="0 0 16 16" {...P} aria-hidden="true"><path d="M10.5 6.6V4.3a2.5 2.5 0 0 0-4.9-.7M5.5 6.9v.4A2.5 2.5 0 0 0 9.4 9.4M3 7.6a5 5 0 0 0 8.2 3.8M13 7.6c0 .5-.1 1-.2 1.4M8 12.6v1.8M2.5 2.5l11 11"></path></svg>,
  link: () => <svg viewBox="0 0 16 16" {...P} aria-hidden="true"><path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.2-2.2a2.6 2.6 0 0 0-3.7-3.7l-.8.8M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.3 9a2.6 2.6 0 0 0 3.7 3.7l.8-.8"></path></svg>,
  check: () => <svg viewBox="0 0 16 16" {...P} stroke-width={1.8} aria-hidden="true"><path d="M3.5 8.4l2.9 2.8 6.1-6.4"></path></svg>,
  close: () => <svg viewBox="0 0 16 16" {...P} aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"></path></svg>,
  lock: () => <svg viewBox="0 0 16 16" {...P} aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1.6"></rect><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7"></path></svg>,
  chevron: () => <svg viewBox="0 0 16 16" {...P} stroke-width={1.7} aria-hidden="true"><path d="M5 6.5l3 3 3-3"></path></svg>,
  back: () => <svg viewBox="0 0 16 16" {...P} stroke-width={1.7} aria-hidden="true"><path d="M9.5 4l-4 4 4 4"></path></svg>,
  people: () => <svg viewBox="0 0 16 16" {...P} aria-hidden="true"><circle cx="6" cy="5.5" r="2.3"></circle><path d="M1.8 13c.5-2.2 2.2-3.4 4.2-3.4s3.7 1.2 4.2 3.4"></path><path d="M10.6 3.4a2.2 2.2 0 0 1 0 4.2M12 9.9c1.1.5 1.9 1.6 2.2 3.1"></path></svg>,
  mail: () => <svg viewBox="0 0 16 16" {...P} aria-hidden="true"><rect x="2" y="3.5" width="12" height="9" rx="1.8"></rect><path d="M2.6 4.6L8 8.6l5.4-4"></path></svg>,
  leave: () => <svg viewBox="0 0 16 16" {...P} aria-hidden="true"><path d="M6.5 2.8H4a1.5 1.5 0 0 0-1.5 1.5v7.4A1.5 1.5 0 0 0 4 13.2h2.5M10 5l3 3-3 3M13 8H6"></path></svg>,
  phoneDown: () => <svg viewBox="0 0 16 16" {...P} aria-hidden="true"><path d="M2.2 9.4c3.4-3 8.2-3 11.6 0l-.9 1.7-2.4-.6-.3-1.6a6.6 6.6 0 0 0-4.4 0l-.3 1.6-2.4.6z"></path></svg>,
  speaker: () => <svg viewBox="0 0 16 16" {...P} aria-hidden="true"><path d="M2.5 6.2h2.2L8 3.5v9L4.7 9.8H2.5zM10.6 5.6a3.3 3.3 0 0 1 0 4.8M12.3 3.9a5.7 5.7 0 0 1 0 8.2"></path></svg>,
};

interface AvatarProps {
  user?: Pick<User, 'initials' | 'tone'> | null;
  /** An invitee who isn't a member yet: dashed, initials from their email. */
  pendingInitials?: string;
  size?: 16 | 20 | 24 | 28 | 40;
  ring?: boolean;
  speaking?: boolean;
  title?: string;
}

export function Avatar({ user, pendingInitials, size = 24, ring, speaking, title }: AvatarProps) {
  if (!user) {
    return <span class={`vm-av vm-av-${size} vm-av-pending`} title={title} aria-hidden={title ? undefined : true}>{pendingInitials ?? '?'}</span>;
  }
  const cls = `vm-av vm-av-${size} vm-tone-${user.tone}${ring ? ' vm-ring' : ''}${speaking ? ' vm-speaking' : ''}`;
  return <span class={cls} title={title} aria-hidden={title ? undefined : true}>{user.initials}</span>;
}

export interface MenuItem {
  key: string;
  label: string;
  hint?: string;
  checked?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
  onSelect(): void;
}

/** A button and a list that closes on select, Escape or a click outside. Arrow keys move; Enter selects. */
export function Menu({ label, items, align = 'end', buttonClass = 'vm-menu-btn', ariaLabel, disabled }: {
  label: ComponentChildren;
  items: MenuItem[];
  align?: 'start' | 'end';
  buttonClass?: string;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', off);
    return () => document.removeEventListener('mousedown', off);
  }, [open]);
  useEffect(() => { if (open) ref.current?.querySelector<HTMLButtonElement>('.vm-menu-item:not(:disabled)')?.focus(); }, [open]);
  const move = (dir: 1 | -1) => {
    const list = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('.vm-menu-item:not(:disabled)') ?? []);
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    list[(i + dir + list.length) % list.length]?.focus();
  };
  return (
    <div class="vm-menu" ref={ref} onKeyDown={(e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); }
      if (open && e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      if (open && e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    }}>
      <button type="button" class={buttonClass} aria-haspopup="menu" aria-expanded={open} aria-label={ariaLabel} disabled={disabled} onClick={() => setOpen(!open)}>
        {label}
        <Icon.chevron />
      </button>
      {open && (
        <div class={`vm-menu-list vm-menu-${align}`} role="menu">
          {items.map((it) => (
            <div key={it.key} role="none">
              {it.separatorBefore && <div class="vm-menu-sep" role="separator"></div>}
              <button type="button" role="menuitemradio" aria-checked={it.checked ?? false} class={`vm-menu-item${it.destructive ? ' vm-destructive' : ''}`}
                disabled={it.disabled} onClick={() => { setOpen(false); it.onSelect(); }}>
                <span class="vm-menu-check">{it.checked ? <Icon.check /> : null}</span>
                <span class="vm-menu-text">
                  <span>{it.label}</span>
                  {it.hint && <span class="vm-menu-hint">{it.hint}</span>}
                </span>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ConfirmDialog({ title, body, confirmLabel, destructive = true, busy, onConfirm, onCancel, children }: {
  title: string;
  body: ComponentChildren;
  confirmLabel: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm(): void;
  onCancel(): void;
  children?: ComponentChildren;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { confirmRef.current?.focus(); }, []);
  return (
    <div class="vm-scrim" role="presentation" onMouseDown={(e: MouseEvent) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div class="vm-sheet" role="alertdialog" aria-modal="true" aria-labelledby="vm-confirm-title" onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); }}>
        <h2 id="vm-confirm-title" class="vm-sheet-title">{title}</h2>
        <div class="vm-sheet-body">{body}</div>
        {children}
        <div class="vm-sheet-acts">
          <button type="button" class="vm-btn vm-btn-ghost" onClick={onCancel}>Cancel</button>
          <button ref={confirmRef} type="button" class={`vm-btn ${destructive ? 'vm-btn-danger' : 'vm-btn-primary'}`} disabled={busy} onClick={onConfirm}>
            {busy && <Spinner />}{confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export interface Toast {
  id: string;
  text: string;
  user?: Pick<User, 'initials' | 'tone'>;
}

/** Quiet confirmations under the chrome band. Never amber: these are activity, not attention. */
export function Toasts({ toasts }: { toasts: Toast[] }) {
  return (
    <div class="vm-toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} class="vm-toast">
          {t.user ? <Avatar user={t.user} size={20} /> : <span class="vm-toast-check"><Icon.check /></span>}
          {t.text}
        </div>
      ))}
    </div>
  );
}

/** Toasts that leave on their own after a few seconds. */
export function useToasts(): [Toast[], (text: string, user?: Toast['user']) => void] {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const add = (text: string, user?: Toast['user']) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((all) => [...all.slice(-2), { id, text, user }]);
    setTimeout(() => setToasts((all) => all.filter((t) => t.id !== id)), 3200);
  };
  return [toasts, add];
}

export function Spinner() {
  return <span class="vm-spin" aria-hidden="true"></span>;
}
