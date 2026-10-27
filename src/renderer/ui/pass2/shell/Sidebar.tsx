import { h, type ComponentChildren } from '../../../vendor/preact.js';
import { useReducer } from '../../../vendor/preact-hooks.js';
import { useStore } from '../../../shared/store.js';
import { useActiveInbox } from '../../../features/inbox/ui/hooks.js';
import { callPresence } from '../../../features/call/presence.js';
import type { RoomSummary } from '../../../features/room/types.js';
import { Icon, type IconName } from '../../icons.js';
import { countByRoom, groupRooms, openByDefault, since, sidebarRooms, type SidebarGroup, type SidebarRoom } from './sidebar-model.js';

// The one sidebar, the same on Home and in every room: Journey's four places (Home, Rooms, Projects,
// Invitations), then your repositories, each a folder you open to see its rooms. It is either shown or gone
// ("[" or the sidebar button hide it entirely; shell/prefs.ts keeps the choice).
//   repository row   a folder, open or closed. On hover or keyboard focus the folder becomes the chevron that
//                    says what a click does (right: open, down: close), and a + starts a room in it.
//   room row         a dot (sage: a call is on; signal: something needs you; quiet grey otherwise), the
//                    name, and how long since it moved. A click opens the room.
// Only Home carries a number, and only for what needs you; a waiting invitation is a dot (it's counted there).

export type SidebarPlace = 'home' | 'projects' | 'invitations';

export interface SidebarProps {
  /** The page on screen; null in a room. */
  place: SidebarPlace | null;
  rooms: SidebarRoom[];
  /** The room on screen. */
  current: string | null;
  /** Home's number: what needs you. */
  needs: number;
  /** Invitations waiting (shown as a dot). */
  invitations: number;
  now: string;
  onPlace(p: SidebarPlace): void;
  onRoom(id: string): void;
  /** New room, with the repository whose + was pressed (null: none chosen). */
  onNew(repo: string | null): void;
  /** The foot: the account (Home) or AccountFoot (rooms). */
  foot?: ComponentChildren;
}

/** Repositories you opened or closed, kept while you move between Home and rooms. */
const opened = new Map<string, boolean>();

const PLACES: { key: SidebarPlace; label: string; icon: IconName; tip?: string }[] = [
  { key: 'home', label: 'Home', icon: 'room', tip: 'Home · ⌘1' },
  { key: 'projects', label: 'Projects', icon: 'project' },
  { key: 'invitations', label: 'Invitations', icon: 'mail' },
];

const roomLabel = (r: SidebarRoom, now: string) =>
  `${r.name}${r.inCall ? ', your call is here' : r.live ? ', a call is on' : ''}${r.needs ? `, ${r.needs} need${r.needs > 1 ? '' : 's'} you` : ''}${since(r.at, now) ? `, ${since(r.at, now)} ago` : ''}`;

export function Sidebar(p: SidebarProps) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const groups = groupRooms(p.rooms);
  const isOpen = (g: SidebarGroup) => opened.get(g.key) ?? openByDefault(g, p.current);
  const toggle = (g: SidebarGroup) => { opened.set(g.key, !isOpen(g)); bump(0); };

  return (
    <nav class="vh-sb" aria-label="Vowe">
      <div class="vh-sb-places">
        {PLACES.map((x) => (
          <button key={x.key} type="button" class="vh-sb-row" aria-current={p.place === x.key ? 'page' : undefined} onClick={() => p.onPlace(x.key)}>
            <span class="vh-sb-glyph"><Icon name={x.icon} size={16} /></span>
            <span class="vh-sb-name">{x.label}</span>
            {x.key === 'home' && p.needs ? <span class="vh-sb-count" aria-label={`${p.needs} need${p.needs > 1 ? '' : 's'} you`}>{p.needs}</span> : null}
            {x.key === 'invitations' && p.invitations ? <span class="vh-sb-state" aria-label={`${p.invitations} waiting`}><i class="vh-sb-needsdot" /></span> : null}
          </button>
        ))}
      </div>
      <div class="vh-sb-h">
        <span>Repositories</span>
        <button type="button" class="v-iconbtn vh-sb-add" aria-label="New room" data-tip="New room" onClick={() => p.onNew(null)}><Icon name="plus" size={14} /></button>
      </div>
      <div class="vh-sb-rooms">
        {groups.length === 0 ? <p class="vh-sb-none">No rooms yet. Start one with +.</p> : null}
        {groups.map((g) => {
          const o = isOpen(g), id = `vh-sb-repo-${g.key.replace(/[^a-z0-9]+/gi, '-') || 'none'}`;
          return (
            <div key={g.key} class="vh-sb-repo">
              <div class="vh-sb-repoline">
                <button type="button" class="vh-sb-row vh-sb-reporow" aria-expanded={o} aria-controls={id} onClick={() => toggle(g)} title={g.repo ?? undefined}>
                  <span class="vh-sb-glyph vh-sb-fold" aria-hidden="true">
                    <span class="vh-sb-fold-rest"><Icon name={o ? 'folder-open' : 'folder'} size={16} /></span>
                    <span class="vh-sb-fold-hover"><Icon name={o ? 'chevron' : 'chevron-r'} size={16} /></span>
                  </span>
                  <span class="vh-sb-name">{g.name}</span>
                  {!o && g.rooms.some((r) => r.needs) ? <span class="vh-sb-state vh-sb-closedmark" aria-label="something here needs you"><i class="vh-sb-needsdot" /></span> : null}
                  {!o && !g.rooms.some((r) => r.needs) && g.rooms.some((r) => r.live) ? <span class="vh-sb-state vh-sb-closedmark" aria-label="a call is on here"><i class="vh-sb-livedot" /></span> : null}
                </button>
                <button type="button" class="v-iconbtn vh-sb-repoadd" aria-label={`New room in ${g.name}`} data-tip={`New room in ${g.name}`} data-tip-end="" onClick={() => p.onNew(g.repo)}><Icon name="plus" size={14} /></button>
              </div>
              {o ? (
                <div id={id} role="group" aria-label={g.name} class="vh-sb-repo-rooms">
                  {g.rooms.map((r) => (
                    <button key={r.id} type="button" class="vh-sb-row vh-sb-room" aria-current={p.current === r.id ? 'page' : undefined} onClick={() => p.onRoom(r.id)} aria-label={roomLabel(r, p.now)}>
                      <span class="vh-sb-glyph" aria-hidden="true"><i class={'vh-sb-dot' + (r.live ? ' is-live' : r.needs ? ' is-needs' : '')} /></span>
                      <span class="vh-sb-name">{r.name}</span>
                      <span class="vh-sb-ago" aria-hidden="true">{since(r.at, p.now)}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {p.foot ? <div class="vh-sb-foot">{p.foot}</div> : null}
    </nav>
  );
}

/** Goes to one of the four places from anywhere: the app's router follows the hash. */
export function goPlace(place: SidebarPlace) {
  location.hash = `#/${place}`;
}

/**
 * The sidebar as every screen draws it: Home's count and the per-room marks come from the workspace's Inbox
 * (`activeInbox`), the live dot of your call's room from `callPresence`. Screens pass only their rooms and
 * where you are.
 */
export function ShellSidebar(p: Omit<SidebarProps, 'rooms' | 'needs' | 'invitations' | 'now' | 'onPlace'> & { rooms: RoomSummary[]; invitations?: number; onPlace?(place: SidebarPlace): void }) {
  const { state: inbox } = useActiveInbox();
  const { call } = useStore(callPresence);
  const now = new Date().toISOString();
  const needs = inbox && inbox.status !== 'loading' ? inbox.view.needs : null;
  const rooms = sidebarRooms(p.rooms, { now, callRoomId: call?.roomId ?? null, needsByRoom: needs ? countByRoom(needs) : null });
  const invitations = Math.max(p.invitations ?? 0, needs ? needs.filter((i) => i.obligation === 'accept').length : 0);
  return <Sidebar {...p} rooms={rooms} needs={inbox ? inbox.needsCount : 0} invitations={invitations} now={now} onPlace={p.onPlace ?? goPlace} />;
}

