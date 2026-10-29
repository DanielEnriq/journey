// Source: vowe-home-pass2.zip (approved Claude Design package, Pass 2), imports adapted to the vendored Preact.
// Home/Inbox integration (step 03): the aside is the one Sidebar, shared with rooms; it is shown or gone
// entirely (no icon rail), and the choice is the window's (shell/prefs.ts), not this page's.
/**
 * The restrained shell around Home, which is your Inbox.
 *
 * - The window band leaves room for the macOS traffic lights; the app draws its own drag strip. It carries the
 *   sidebar toggle, back and forward, the page's title, and the call cluster at its right end whenever you're
 *   in a call.
 * - Pure presentation: routes are the app's (hash routes in Journey).
 */
import { h, type ComponentChildren } from '../../../vendor/preact.js';

import { useStore } from '../../../shared/store.js';
import { CallCluster } from '../../../features/room/call/CallControls.js';
import type { RoomSummary } from '../../../features/room/types.js';
import { Avatar, IconButton } from '../../components.js';
import { Icon } from '../../icons.js';
import type { AccountView } from '../types.js';
import { shellPrefs, toggleSidebar, useSidebarKey } from './prefs.js';
import { ShellSidebar } from './Sidebar.js';

export type ShellRoute = 'home';

export interface AppShellProps {
  route: ShellRoute | 'room';
  onNavigate: (r: ShellRoute) => void;
  account: AccountView;
  /** Invitations waiting for you (`invites.mine().length`); the Inbox counts them once it has read them. */
  invitationCount: number;
  /** Your rooms; the sidebar groups them by repository. */
  rooms: RoomSummary[];
  activeRoomId?: string;
  onOpenRoom: (id: string) => void;
  /** New room, in the repository whose + was pressed (null: none chosen). */
  onNewRoom: (space: string | null) => void;
  onAccount: () => void;
  accountOpen?: boolean;
  /** The account popover and any sheet, rendered over the shell. */
  overlay?: ComponentChildren;
  /** Text for the window band (the current page). */
  title?: string;
  /** The page lays out its own scrolling panes (the Inbox's list and reading page): main doesn't scroll. */
  fixed?: boolean;
  /** Forces the sidebar (boards and tests); otherwise it follows the window's choice. */
  layout?: 'full' | 'hidden';
  children: ComponentChildren;
}

export function AppShell(p: AppShellProps) {
  const prefs = useStore(shellPrefs);
  useSidebarKey();
  const shown = p.layout ? p.layout === 'full' : prefs.sidebar;
  const route = p.route === 'room' ? null : p.route;
  return (
    <div class={`vh-app v-root${shown ? '' : ' is-hidden'}`}>
      <div class="vh-band">
        <IconButton icon="sidebar" label={shown ? 'Hide sidebar' : 'Show sidebar'} tip={`${shown ? 'Hide' : 'Show'} sidebar · [`} aria-pressed={shown} onClick={toggleSidebar} />
        <span class="vh-band-nav">
          <IconButton icon="chevron-l" label="Back" tip="Back · ⌘[" onClick={() => history.back()} />
          <IconButton icon="chevron-r" label="Forward" tip="Forward · ⌘]" onClick={() => history.forward()} />
        </span>
        {p.title ? <span class="vh-band-title">{p.title}</span> : null}
        <span class="vh-band-r"><CallCluster looking={null} /></span>
      </div>

      <aside class="vh-side" aria-hidden={!shown} inert={!shown} aria-label="Navigation">
        <ShellSidebar place={route} rooms={p.rooms} current={p.activeRoomId ?? null} invitations={p.invitationCount}
          onPlace={p.onNavigate} onRoom={p.onOpenRoom} onNew={p.onNewRoom}
          foot={
            <button type="button" class="vh-acct" data-account-anchor aria-haspopup="dialog" aria-expanded={!!p.accountOpen} onClick={p.onAccount}>
              <Avatar initials={p.account.initials} tone={p.account.tone} size={24} />
              <span class="vh-acct-main"><b>{p.account.name}</b></span>
              <Icon name="chevron" size={14} />
            </button>
          } />
      </aside>

      <main class={`vh-main${p.fixed ? ' is-fixed' : ''}`} id="vh-main">{p.children}</main>
      {p.overlay}
    </div>
  );
}
