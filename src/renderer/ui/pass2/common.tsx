// Source: vowe-home-pass2.zip (approved Claude Design package, Pass 2), imports adapted to the vendored Preact.
import { h, type ComponentChildren } from '../../vendor/preact.js';
import { useEffect, useRef } from '../../vendor/preact-hooks.js';

import { IconButton, Skeleton } from '../components.js';
import { Icon } from '../icons.js';

import type { CanvasPreview, ProviderId } from './types.js';

export const PROVIDER_LABEL: Record<ProviderId, string> = { google: 'Google', github: 'GitHub' };

/**
 * Slot for an official provider mark. Pass the brand asset as `mark`; without
 * one, a neutral placeholder holds the space (we never redraw provider logos).
 */
export function ProviderMark({ provider, mark }: { provider: ProviderId; mark?: ComponentChildren }) {
  return <span class={`vh-mark-slot${mark ? ' has-mark' : ''}`} aria-hidden="true">{mark ?? (provider === 'github' ? 'GH' : 'G')}</span>;
}

/** Local-time greeting. */
export function greeting(d = new Date()): string {
  const h = d.getHours();
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

/**
 * A small drawing of a room's current view, from its semantic canvas data.
 * Loading sweeps, empty says so, unavailable stays quiet. It never invents parts.
 */
export function CanvasThumb({ preview, large }: { preview: CanvasPreview; large?: boolean }) {
  if (preview.status === 'loading') {
    return (
      <div class={`vh-sketch${large ? ' is-large' : ''}`} aria-busy="true" aria-label="Loading canvas preview">
        <div class="vh-sketch-msg" style={{ flexDirection: 'column', alignItems: 'stretch', padding: large ? '60px' : '22px' }}>
          <Skeleton width="45%" height={large ? 18 : 10} /><Skeleton width="70%" height={large ? 18 : 10} /><Skeleton width="30%" height={large ? 18 : 10} />
        </div>
      </div>
    );
  }
  if (preview.status === 'unavailable') {
    return <div class={`vh-sketch${large ? ' is-large' : ''}`}><div class="vh-sketch-msg">Preview unavailable</div></div>;
  }
  if (preview.status === 'empty') {
    return <div class={`vh-sketch${large ? ' is-large' : ''}`}><div class="vh-sketch-msg"><em>The canvas fills in as the room talks.</em></div></div>;
  }
  if (preview.still) return <div class={`vh-sketch${large ? ' is-large' : ''}`}>{preview.still}</div>;
  if (!preview.sketch) return <div class={`vh-sketch${large ? ' is-large' : ''}`}><div class="vh-sketch-msg">Preview unavailable</div></div>;
  const { nodes, edges } = preview.sketch;
  const at = (id: string) => nodes.find((n) => n.id === id);
  return (
    <div class={`vh-sketch${large ? ' is-large' : ''}`} role="img" aria-label={`Canvas preview: ${nodes.map((n) => n.label).join(', ')}`}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {edges.map((e, i) => {
          const a = at(e.from), b = at(e.to);
          if (!a || !b) return null;
          const mx = (a.x + b.x) / 2;
          return <path key={i} class={`e${e.state === 'proposed' ? ' is-proposed' : e.state === 'fault' ? ' is-fault' : ''}`} vector-effect="non-scaling-stroke" d={`M${a.x} ${a.y} C ${mx} ${a.y} ${mx} ${b.y} ${b.x} ${b.y}`} style={{ animationDelay: `${120 + i * 80}ms` }} />;
        })}
      </svg>
      {nodes.map((n, i) => (
        <span key={n.id} class={`n${n.state === 'proposed' ? ' is-proposed' : n.state === 'fault' ? ' is-fault' : ''}`} style={{ left: `${n.x}%`, top: `${n.y}%`, animationDelay: `${i * 60}ms` }}>
          <small>{n.kind}</small>{n.label}
        </span>
      ))}
    </div>
  );
}

/**
 * A room's repository: its shared identity (never a path), and whether you
 * have a clone of it here (`rooms.checkout`).
 */
export function RepoChip({ repository, checkout }: { repository: string | null; checkout?: 'here' | 'missing' | null }) {
  if (!repository) return <span class="vh-projchip is-missing"><Icon name="branch" size={14} />No repository</span>;
  const missing = checkout === 'missing';
  const short = repository.replace(/^github\.com\//, '');
  return (
    <span class={`vh-projchip${missing ? ' is-missing' : ''}`} title={missing ? `${repository} isn’t added on this machine` : repository}>
      <Icon name="branch" size={14} />{short}{missing ? ' · not on this machine' : ''}
    </span>
  );
}

/** "3m ago", from an ISO time. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

export function initialsOf(name: string): string {
  return name.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
}

/** A modal sheet: serif title, body, footer. Focus moves in; Escape and the scrim close it. */
export function Sheet({ title, subtitle, children, footer, onClose, width }: { title: string; subtitle?: string; children: ComponentChildren; footer?: ComponentChildren; onClose: () => void; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>('[data-autofocus], input, button.v-btn-signal');
    first?.focus();
  }, []);
  return (
    <div class="vh-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} class="vh-sheet" role="dialog" aria-modal="true" aria-label={title} style={width ? { width: `${width}px` } : undefined} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div class="vh-sheet-head">
          <div><h2>{title}</h2>{subtitle ? <p>{subtitle}</p> : null}</div>
          <IconButton icon="close" label="Close" onClick={onClose} />
        </div>
        <div class="vh-sheet-body">{children}</div>
        {footer ? <div class="vh-sheet-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Note({ icon = 'lock', children }: { icon?: 'lock' | 'link' | 'branch' | 'mic-off' | 'project' | 'people'; children: ComponentChildren }) {
  return <div class="vh-note"><Icon name={icon} size={14} /><span>{children}</span></div>;
}
