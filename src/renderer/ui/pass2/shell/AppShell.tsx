// Source: vowe-home-pass2.zip (approved Claude Design package, Pass 2), imports adapted to the vendored Preact.
/**
 * The restrained shell around Home, Rooms, Projects and Invitations.
 *
 * - Full sidebar from 1100px, a 60px rail below that, hidden on request
 *   (Journey's sidebar toggle, "[").
 * - The window band leaves room for the macOS traffic lights; the app draws its
 *   own drag strip.
 * - Rooms stay one click away under the nav, as Journey's sidebar lists them
 *   today.
 * - Pure presentation: routes are the app's (hash routes in Journey).
 */
import { Fragment, h, type ComponentChildren } from '../../../vendor/preact.js';
import { useEffect, useState } from '../../../vendor/preact-hooks.js';

import { Avatar, Count, IconButton } from '../../components.js';
import { Icon, type IconName } from '../../icons.js';

import type { AccountView } from '../types.js';

export type ShellRoute = 'home' | 'rooms' | 'projects' | 'invitations';

export interface ShellRoomLink { id: string; name: string; needs: boolean; live: boolean }

export interface AppShellProps {
  route: ShellRoute | 'room';
  onNavigate: (r: ShellRoute) => void;
  account: AccountView;
  /** Invitations waiting for you (`invites.mine().length`). */
  invitationCount: number;
  /** Rooms for the sidebar, most recent first. */
  rooms: ShellRoomLink[];
  activeRoomId?: string;
  onOpenRoom: (id: string) => void;
  onNewRoom: () => void;
  onAccount: () => void;
  accountOpen?: boolean;
  /** The account popover and any sheet, rendered over the shell. */
  overlay?: ComponentChildren;
  /** Text for the window band (the current page). */
  title?: string;
  /** Forces a layout (boards and tests); otherwise it follows the window width. */
  layout?: 'full' | 'rail' | 'hidden';
  children: ComponentChildren;
}

const NAV: { key: ShellRoute; label: string; icon: IconName }[] = [
  { key: 'home', label: 'Home', icon: 'room' },
  { key: 'rooms', label: 'Rooms', icon: 'people' },
  { key: 'projects', label: 'Projects', icon: 'project' },
  { key: 'invitations', label: 'Invitations', icon: 'mail' },
];

function useAutoLayout(forced?: AppShellProps['layout']): ['full' | 'rail' | 'hidden', (v: boolean) => void] {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < 1100);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    if (forced) return;
    const on = () => setNarrow(window.innerWidth < 1100);
    addEventListener('resize', on);
    return () => removeEventListener('resize', on);
  }, [forced]);
  return [forced ?? (hidden ? 'hidden' : narrow ? 'rail' : 'full'), setHidden];
}

export function AppShell(p: AppShellProps) {
  const [layout, setHidden] = useAutoLayout(p.layout);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === '[' && !e.metaKey && !e.ctrlKey && !/INPUT|TEXTAREA/.test(t.tagName) && !t.isContentEditable) setHidden(layout !== 'hidden');
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [layout]);
  return (
    <div class={`vh-app v-root${layout === 'rail' ? ' is-rail' : layout === 'hidden' ? ' is-hidden' : ''}`}>
      <div class="vh-band">
        <IconButton icon="sidebar" label={layout === 'hidden' ? 'Show sidebar ( [ )' : 'Hide sidebar ( [ )'} onClick={() => setHidden(layout !== 'hidden')} />
        <IconButton icon="plus" label="New room" onClick={p.onNewRoom} />
        {p.title ? <span class="vh-band-title">{p.title}</span> : null}
      </div>

      <aside class="vh-side" aria-hidden={layout === 'hidden'} aria-label="Navigation">
        <nav class="vh-side-nav">
          {NAV.map((n) => (
            <button key={n.key} type="button" class={`vh-nav${p.route === n.key ? ' is-on' : ''}`} aria-current={p.route === n.key ? 'page' : undefined} title={layout === 'rail' ? n.label : undefined} onClick={() => p.onNavigate(n.key)}>
              <Icon name={n.icon} size={16} />
              <span>{n.label}</span>
              {n.key === 'invitations' && p.invitationCount > 0 ? (
                <><span class="vh-nav-end"><Count n={p.invitationCount} label={`${p.invitationCount} invitations`} /></span><i class="vh-nav-dot" aria-hidden="true" /></>
              ) : null}
            </button>
          ))}
        </nav>

        {p.rooms.length ? (
          <div class="vh-recent">
            <div class="vh-side-h v-label">Rooms</div>
            <div class="vh-side-nav">
              {p.rooms.slice(0, 8).map((r) => (
                <button key={r.id} type="button" class={`vh-nav vh-nav-room${p.activeRoomId === r.id ? ' is-on' : ''}`} onClick={() => p.onOpenRoom(r.id)}>
                  <i class={`vh-room-dot${r.needs ? ' is-needs' : r.live ? ' is-live' : ''}`} aria-hidden="true" />
                  <span>{r.name}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div class="vh-side-foot">
          <button type="button" class="vh-acct" data-account-anchor aria-haspopup="dialog" aria-expanded={!!p.accountOpen} onClick={p.onAccount} title={layout === 'rail' ? p.account.name : undefined}>
            <Avatar initials={p.account.initials} tone={p.account.tone} size={28} />
            <span class="vh-acct-main"><b>{p.account.name}</b><span class="v-meta">Signed in with {p.account.provider === 'github' ? 'GitHub' : 'Google'}</span></span>
            <Icon name="chevron" size={14} />
          </button>
        </div>
      </aside>

      <main class="vh-main" id="vh-main">{p.children}</main>
      {p.overlay}
    </div>
  );
}
