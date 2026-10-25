/**
 * Source: vowe-foundations-pass1.zip (approved Claude Design package), imports adapted to the vendored Preact.
 * Vowe · Ink, Paper & Signal — core components (Pass 1), for Preact.
 *
 * Thin, typed wrappers over the v- classes in styles/components.css. They hold
 * no product state and make no network calls. Styling lives in CSS so the same
 * classes can be used in plain markup, prototypes and future design sessions.
 */
import { h, type ComponentChildren, type JSX } from '../vendor/preact.js';
import { useEffect, useRef } from '../vendor/preact-hooks.js';

import { Icon, type IconName } from './icons.js';

const cx = (...c: (string | false | null | undefined)[]): string => c.filter(Boolean).join(' ');

/* ------------------------------------------------------------------ mark */

/** The Vowe mark: a voice (ring + signal) drawn out into a structure (square). */
export function Mark({ size = 16, title }: { size?: number; title?: string }) {
  return (
    <svg class="v-mark" width={(size * 30) / 16} height={size} viewBox="0 0 30 16" role={title ? 'img' : undefined} aria-hidden={title ? undefined : true}>
      {title ? <title>{title}</title> : null}
      <circle cx="5.5" cy="8" r="4.25" fill="none" stroke="currentColor" stroke-width="1.6" />
      <circle class="v-mark-dot" cx="5.5" cy="8" r="1.7" />
      <path d="M9.75 8h7.25" stroke="currentColor" stroke-width="1.6" />
      <rect x="17" y="3" width="10" height="10" rx="1.6" fill="currentColor" />
    </svg>
  );
}

export function Wordmark({ size = 17 }: { size?: number }) {
  return (
    <span class="v-wordmark" style={{ fontSize: `${size}px` }} aria-label="Vowe">
      <Mark size={Math.round(size * 0.82)} />
      <span aria-hidden="true">vowe</span>
    </span>
  );
}

/* --------------------------------------------------------------- buttons */

export type ButtonVariant = 'default' | 'signal' | 'ink' | 'quiet' | 'danger';

type ButtonProps = Omit<JSX.HTMLAttributes<HTMLButtonElement>, 'icon' | 'size'> & {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  icon?: IconName;
  iconEnd?: IconName;
  shortcut?: string;
  loading?: boolean;
  block?: boolean;
  disabled?: boolean;
  type?: 'button' | 'submit';
  children?: ComponentChildren;
};

/**
 * `signal` is the one primary action a view exists for: never more than one
 * per view. `ink` is the strong secondary. `danger` lives in confirmations.
 */
export function Button({ variant = 'default', size = 'md', icon, iconEnd, shortcut, loading, block, disabled, type = 'button', children, class: klass, ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      class={cx('v-btn', variant !== 'default' && `v-btn-${variant}`, size !== 'md' && `v-btn-${size}`, block && 'v-btn-block', loading && 'is-loading', klass as string)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span class="v-spinner" aria-hidden="true" /> : icon ? <Icon name={icon} size={size === 'sm' ? 14 : 16} /> : null}
      {children}
      {shortcut ? <Kbd>{shortcut}</Kbd> : null}
      {iconEnd ? <Icon name={iconEnd} size={size === 'sm' ? 14 : 16} /> : null}
    </button>
  );
}

export function IconButton({ icon, label, active, ...rest }: { icon: IconName; label: string; active?: boolean } & JSX.HTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" class={cx('v-iconbtn', active && 'is-on')} aria-label={label} title={label} aria-pressed={active ?? undefined} {...rest}>
      <Icon name={icon} />
    </button>
  );
}

export function Kbd({ children }: { children: ComponentChildren }) {
  return <kbd class="v-kbd">{children}</kbd>;
}

/* ---------------------------------------------------------------- inputs */

type FieldProps = Omit<JSX.HTMLAttributes<HTMLInputElement>, 'icon'> & {
  icon?: IconName;
  label: string;
  hint?: string;
  error?: string;
  shortcut?: string;
  search?: boolean;
  value?: string;
  placeholder?: string;
  type?: string;
};

/** Text field. `label` is always provided for screen readers, even when visually hidden. */
export function Field({ icon, label, hint, error, shortcut, search, class: klass, id, ...rest }: FieldProps) {
  const fid = (id as string) || `f-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <div class={klass as string}>
      <div class={cx('v-field', search && 'v-search', error && 'is-error')}>
        {icon ? <Icon name={icon} /> : null}
        <label class="v-sr" for={fid}>{label}</label>
        <input id={fid} aria-invalid={error ? true : undefined} aria-describedby={hint || error ? `${fid}-hint` : undefined} {...rest} />
        {shortcut ? <Kbd>{shortcut}</Kbd> : null}
      </div>
      {error || hint ? <div id={`${fid}-hint`} class={cx('v-field-hint', error && 'is-error')}>{error ?? hint}</div> : null}
    </div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return <input type="checkbox" role="switch" class="v-switch" aria-label={label} checked={checked} onChange={(e) => onChange((e.target as HTMLInputElement).checked)} />;
}

/* ------------------------------------------------------------ navigation */

export interface TabItem<K extends string> { key: K; label: string }

export function Tabs<K extends string>({ items, value, onChange, label }: { items: TabItem<K>[]; value: K; onChange: (k: K) => void; label: string }) {
  return (
    <div class="v-tabs" role="tablist" aria-label={label}>
      {items.map((t) => (
        <button key={t.key} type="button" role="tab" aria-selected={t.key === value} class={cx('v-tab', t.key === value && 'is-on')} onClick={() => onChange(t.key)}>{t.label}</button>
      ))}
    </div>
  );
}

export function Segmented<K extends string>({ items, value, onChange, label }: { items: TabItem<K>[]; value: K; onChange: (k: K) => void; label: string }) {
  return (
    <div class="v-seg" role="radiogroup" aria-label={label}>
      {items.map((t) => (
        <button key={t.key} type="button" role="radio" aria-checked={t.key === value} class={cx(t.key === value && 'is-on')} onClick={() => onChange(t.key)}>{t.label}</button>
      ))}
    </div>
  );
}

export function NavItem({ icon, label, active, end, onClick }: { icon: IconName; label: string; active?: boolean; end?: ComponentChildren; onClick?: () => void }) {
  return (
    <button type="button" class={cx('v-nav-item', active && 'is-on')} aria-current={active ? 'page' : undefined} onClick={onClick}>
      <Icon name={icon} />
      <span>{label}</span>
      {end ? <span class="v-nav-end">{end}</span> : null}
    </button>
  );
}

/* --------------------------------------------------------- cards & lists */

export function Card({ children, hover, selected, proposed, class: klass, ...rest }: { children: ComponentChildren; hover?: boolean; selected?: boolean; proposed?: boolean } & JSX.HTMLAttributes<HTMLDivElement>) {
  return <div class={cx('v-card', hover && 'v-card-hover', selected && 'is-selected', proposed && 'v-card-proposed', klass as string)} {...rest}>{children}</div>;
}

export function Row({ lead, title, sub, end, onClick }: { lead?: ComponentChildren; title: ComponentChildren; sub?: ComponentChildren; end?: ComponentChildren; onClick?: () => void }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag class="v-row" onClick={onClick} {...(onClick ? { type: 'button' } : {})}>
      {lead}
      <span class="v-row-main"><span class="v-row-title">{title}</span>{sub ? <span class="v-row-sub">{sub}</span> : null}</span>
      {end}
    </Tag>
  );
}

/* ------------------------------------------------------ badges & status */

/**
 * signal = needs a person · fault = something failed (oxide) · info = system/agent
 * proposed = not confirmed yet (dashed, any author) · success = passed.
 * `danger` is kept as an alias of `fault`.
 */
export type Tone = 'neutral' | 'signal' | 'info' | 'success' | 'fault' | 'danger' | 'proposed';

export function Badge({ tone = 'neutral', icon, children }: { tone?: Tone; icon?: IconName; children: ComponentChildren }) {
  return <span class={cx('v-badge', tone !== 'neutral' && `v-badge-${tone === 'danger' ? 'fault' : tone}`)}>{icon ? <Icon name={icon} size={14} /> : null}{children}</span>;
}

/** live = people present now · signal = needs you · fault = failed · info = system/agent · idle = quiet */
export function Dot({ tone = 'idle', label }: { tone?: 'live' | 'signal' | 'fault' | 'info' | 'idle'; label?: string }) {
  return <span class={cx('v-dot', tone !== 'idle' && `v-dot-${tone}`)} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}

export function Count({ n, label }: { n: number; label: string }) {
  return <span class="v-count" aria-label={`${n} ${label}`}>{n}</span>;
}

export function Spinner({ label }: { label?: string }) {
  return <span class="v-spinner" role={label ? 'status' : undefined} aria-label={label} />;
}

export function Skeleton({ width = '100%', height = 12 }: { width?: string | number; height?: number }) {
  return <span class="v-skeleton" style={{ display: 'block', width, height }} aria-hidden="true" />;
}

export function Progress({ value, label }: { value: number; label: string }) {
  return (
    <div class="v-progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
      <i style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  );
}

/* ------------------------------------------------------ people, presence */

export type PersonTone = 1 | 2 | 3 | 4 | 5;

export interface AvatarProps {
  initials: string;
  tone?: PersonTone;
  size?: 16 | 20 | 24 | 28 | 36 | 56;
  /** here = in the room with you; speaking animates the ring. */
  state?: 'idle' | 'here' | 'speaking' | 'away' | 'pending';
  name?: string;
}

export function Avatar({ initials, tone = 1, size = 24, state = 'idle', name }: AvatarProps) {
  return (
    <span
      class={cx('v-av', size !== 24 && `v-av-${size}`, state !== 'pending' && `v-p${tone}`, state === 'here' && 'is-here', state === 'speaking' && 'is-here is-speaking', state === 'away' && 'is-away', state === 'pending' && 'is-pending')}
      title={name}
      aria-label={name}
      role={name ? 'img' : undefined}
    >
      {initials}
    </span>
  );
}

export function AvatarStack({ people, size = 24, max = 4 }: { people: AvatarProps[]; size?: AvatarProps['size']; max?: number }) {
  return (
    <span class="v-avstack">
      {people.slice(0, max).map((p) => <Avatar key={p.initials} {...p} size={size} />)}
      {people.length > max ? <span class="v-av v-av-20" style={{ background: 'var(--v-surface-press)', color: 'var(--v-fg-2)' }}>+{people.length - max}</span> : null}
    </span>
  );
}

export function Typing() {
  return <span class="v-typing" aria-hidden="true"><i /><i /><i /></span>;
}

/** Vowe as a presence: a slate instrument. Never a glowing orb. */
export function AgentMark({ speaking, size = 22 }: { speaking?: boolean; size?: number }) {
  return <span class={cx('v-agent', speaking && 'is-speaking')} style={{ '--s': `${size}px` } as JSX.CSSProperties} aria-hidden="true" />;
}

export function Presence({ children }: { children: ComponentChildren }) {
  return <span class="v-presence">{children}</span>;
}

/**
 * Who made something. Independent of whether it's confirmed: a Vowe proposal is
 * dashed with this chip; once accepted it goes solid and keeps the chip.
 */
export function Provenance({ by, person, note }: { by: 'agent' | 'person'; person?: Pick<AvatarProps, 'initials' | 'tone'> & { name: string }; note?: string }) {
  if (by === 'agent') {
    return <span class="v-prov v-prov-agent"><span class="v-agent" aria-hidden="true" />Vowe{note ? ` · ${note}` : ''}</span>;
  }
  return (
    <span class="v-prov">
      <span class={cx('v-av', `v-p${person?.tone ?? 1}`)} aria-hidden="true">{person?.initials}</span>
      {person?.name ?? 'Someone'}{note ? ` · ${note}` : ''}
    </span>
  );
}

/** An error that already happened (oxide). Never used for "you should act". */
export function FaultNotice({ title, children }: { title: string; children?: ComponentChildren }) {
  return (
    <div class="v-fault" role="alert">
      <Icon name="warn" />
      <div><b>{title}</b>{children}</div>
    </div>
  );
}

/* ---------------------------------------------------------------- overlays */

export function Menu({ label, children }: { label: string; children: ComponentChildren }) {
  return <div class="v-menu" role="menu" aria-label={label}>{children}</div>;
}

export function MenuItem({ icon, label, shortcut, danger, onSelect }: { icon?: IconName; label: string; shortcut?: string; danger?: boolean; onSelect?: () => void }) {
  return (
    <button type="button" role="menuitem" class="v-menu-item" style={danger ? { color: 'var(--v-fault-fg)' } : undefined} onClick={onSelect}>
      {icon ? <Icon name={icon} /> : null}
      <span>{label}</span>
      {shortcut ? <Kbd>{shortcut}</Kbd> : null}
    </button>
  );
}

export function MenuSeparator() {
  return <div class="v-menu-sep" role="separator" />;
}

/**
 * A modal dialog: focuses its primary action, closes on Escape and on a click
 * on the scrim. Render it inside a positioned container (or portal it).
 */
export function Dialog({ title, children, actions, onClose }: { title: string; children: ComponentChildren; actions: ComponentChildren; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('[data-autofocus], .v-btn-signal, .v-btn-ink, .v-btn-danger')?.focus();
  }, []);
  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--v-scrim)' }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} class="v-dialog" role="dialog" aria-modal="true" aria-label={title} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <h2 class="v-dialog-title">{title}</h2>
        <div class="v-dialog-body">{children}</div>
        <div class="v-dialog-acts">{actions}</div>
      </div>
    </div>
  );
}

export function Toast({ children, lead }: { children: ComponentChildren; lead?: ComponentChildren }) {
  return <div class="v-toast" role="status" aria-live="polite">{lead}{children}</div>;
}

export function Tooltip({ children }: { children: ComponentChildren }) {
  return <span class="v-tooltip" role="tooltip">{children}</span>;
}
