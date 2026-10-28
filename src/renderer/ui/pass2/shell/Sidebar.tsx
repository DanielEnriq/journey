import { Fragment, h, type ComponentChildren } from '../../../vendor/preact.js';
import { useEffect, useReducer, useRef, useState } from '../../../vendor/preact-hooks.js';
import { useStore } from '../../../shared/store.js';
import { useActiveInbox } from '../../../features/inbox/ui/hooks.js';
import { callPresence } from '../../../features/call/presence.js';
import type { PersonRef, RoomSummary, SpaceSummary } from '../../../features/room/types.js';
import { Icon, type IconName } from '../../icons.js';
import { setSidebarWidth, shellPrefs, SIDEBAR_MAX, SIDEBAR_MIN, SIDEBAR_W } from './prefs.js';
import {
  countByRoom, filtering, groupRooms, MAX_FACES, groupSpaces, openByDefault, repoName, since, sidebarRooms, spaceOpenByDefault,
  type SidebarRoom, type SidebarSpace,
} from './sidebar-model.js';
import { setSidebarFilter, sidebarFilter, useSpaces } from './spaces.js';
import { ContextMenu, FilterMenu, SpacePicker, type At, type MenuLine, type PickerMode } from './SpaceMenus.js';

// The one sidebar, the same on Home and in every room: Journey's places (the Inbox, which is Home, and New Space,
// which starts one from the repositories on this Mac: SpaceMenus.tsx), then your Spaces, each a folder of rooms. It is either shown or gone ("[" or the sidebar button hide it entirely;
// shell/prefs.ts keeps the choice).
//   Spaces heading   a filter: what the list shows; tinted while it hides anything.
//   Space row        a folder, open or closed. On hover or keyboard focus it becomes the chevron that says
//                    what a click does, and a + starts a room in it. Right-click: new room, rename, link a
//                    repository, and the repositories it links. Double-click the name to rename it.
//   room row         a dot (signal: something, or an agent, waits on you; grey otherwise; a ring while the room is
//                    quick, not kept yet) and the name. On the right, who's in its call as faces, or a spinner while
//                    its agents work; nothing when it's quiet. How long since it moved is in its tooltip. Right-click
//                    keeps it.
//   Earlier          quick rooms quiet for a day fold under it, at the foot of their Space; never deleted.
// Without Spaces (a workspace that doesn't have them), rooms group under their repository as before.
// Only the Inbox carries a number, and only for what needs you (a waiting invitation among it).

export type SidebarPlace = 'home';

export interface SidebarProps {
  /** The page on screen; null in a room. */
  place: SidebarPlace | null;
  rooms: SidebarRoom[];
  /** The room on screen. */
  current: string | null;
  /** The Inbox's number: what needs you. */
  needs: number;
  now: string;
  onPlace(p: SidebarPlace): void;
  onRoom(id: string): void;
  /** New room, in the Space whose + was pressed (where there are no Spaces, its repository; null: none chosen). */
  onNew(space: string | null): void;
  /** The foot: the account (Home) or AccountFoot (rooms). */
  foot?: ComponentChildren;
}

/** Spaces you opened or closed, kept while you move between Home and rooms. */
const opened = new Map<string, boolean>();
/** Spaces whose Earlier rooms you opened. */
const earlierOpen = new Set<string>();

const PLACES: { key: SidebarPlace; label: string; icon: IconName; tip?: string }[] = [
  { key: 'home', label: 'Inbox', icon: 'mail', tip: 'Inbox · ⌘1' },
];

const roomLabel = (r: SidebarRoom, now: string) =>
  `${r.name}${r.quick ? ', quick' : ''}${r.inCall ? ', your call is here' : r.live ? `, ${r.faces.map((f) => (f.tone === 'me' ? 'you' : f.name)).join(', ')} in the call` : ''}${r.work === 'running' ? ', agents working' : ''}${r.needs ? `, ${r.needs} need${r.needs > 1 ? '' : 's'} you` : ''}${since(r.at, now) === 'now' ? ', just now' : since(r.at, now) ? `, ${since(r.at, now)} ago` : ''}`;

type Menu = { kind: 'filter'; at: At } | { kind: 'picker'; at: At; mode: PickerMode } | { kind: 'lines'; at: At; label: string; lines: MenuLine[] };

const below = (e: Event): At => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); return { x: r.left, y: r.bottom + 4 }; };
/** Under a sidebar row, lined up with its left edge, the way a popover hangs from what opened it. */
const beside = (e: Event): At => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); return { x: r.left, y: r.bottom + 4 }; };
/** What the filter keeps, for the heading: "Needs You", "Calls On Now", a repository's name, or a few of them. */
const filterName = (f: { needs: boolean; live: boolean; repo: string | null }) =>
  [f.needs && 'Needs You', f.live && 'Calls On Now', f.repo && repoName(f.repo)].filter(Boolean).join(', ');
const point = (e: MouseEvent): At => ({ x: e.clientX, y: e.clientY });

export function Sidebar(p: SidebarProps) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const { source, spaces } = useSpaces();
  const filter = useStore(sidebarFilter);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const close = () => setMenu(null);
  const nav = useRef<HTMLElement>(null);
  const newSpace = (at: At) => (canSpaces ? setMenu(menu?.kind === 'picker' ? null : { kind: 'picker', at, mode: { kind: 'new' } }) : p.onNew(null));

  // Without Spaces, the repositories stand in for them, one each.
  const groups: SidebarSpace[] = spaces
    ? groupSpaces(spaces, p.rooms, filter)
    : groupRooms(p.rooms).map((g) => ({ id: g.key, name: g.name, repos: g.repo ? [g.repo] : [], role: 'member', rooms: g.rooms, earlier: [] }));
  const isOpen = (g: SidebarSpace) => opened.get(g.id) ?? (spaces ? spaceOpenByDefault(g, p.current) : openByDefault({ key: g.id, repo: null, name: g.name, rooms: g.rooms }, p.current));
  const toggle = (g: SidebarSpace) => { opened.set(g.id, !isOpen(g)); bump(0); };
  const canSpaces = !!(spaces && source?.createSpace);
  // ⇧⌘N: New Space, from the sidebar on screen (a room kept alive behind Home has one too, hidden).
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.key.toLowerCase() !== 'n' || !nav.current?.offsetParent) return;
      e.preventDefault();
      const row = nav.current.querySelector<HTMLElement>('.vh-sb-newspace')!.getBoundingClientRect();
      newSpace({ x: row.left, y: row.bottom + 4 });
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  });

  /** Open a Space and draw the eye to it: after making one, or going to the one that already links a repository. */
  const reveal = (id: string) => {
    opened.set(id, true); setFlash(id); bump(0);
    requestAnimationFrame(() => document.querySelector(`[data-space="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' }));
    setTimeout(() => setFlash((f) => (f === id ? null : f)), 1200);
  };
  const made = (s: SpaceSummary, fresh: boolean) => { reveal(s.id); if (fresh) setRenaming(s.id); };
  const rename = (g: SidebarSpace, name: string) => {
    setRenaming(null);
    const to = name.trim();
    if (to && to !== g.name) void source?.renameSpace?.(g.id, to).catch(() => { /* the name stays as it was */ });
  };

  const spaceMenu = (g: SidebarSpace, e: MouseEvent) => {
    if (!spaces || !g.id) return;
    e.preventDefault();
    const sp = spaces.find((s) => s.id === g.id)!;
    const lines: MenuLine[] = [
      { icon: 'plus', label: 'New Room', run: () => p.onNew(g.id) },
      ...(source?.renameSpace && g.role === 'owner' ? [{ icon: 'pen', label: 'Rename', run: () => setRenaming(g.id) } as MenuLine] : []),
      ...(source?.linkRepo ? [{ icon: 'link', label: 'Link Repository…', run: () => setMenu({ kind: 'picker', at: point(e), mode: { kind: 'link', space: sp } }) } as MenuLine] : []),
      ...(g.repos.length ? ['sep', { section: g.repos.length === 1 ? 'Repository' : 'Repositories' }, ...g.repos.map((r): MenuLine => ({ icon: 'branch', label: repoName(r), hint: r, mono: true }))] as MenuLine[] : []),
    ];
    setMenu({ kind: 'lines', at: point(e), label: g.name, lines });
  };
  const roomMenu = (r: SidebarRoom, e: MouseEvent) => {
    if (!source?.keep) return;
    e.preventDefault();
    setMenu({ kind: 'lines', at: point(e), label: r.name, lines: [
      { icon: 'join', label: 'Open Room', run: () => p.onRoom(r.id) },
      'sep',
      { icon: 'keep', label: r.quick ? 'Keep Room' : 'Kept', checked: !r.quick, run: () => void source.keep!(r.id, r.quick) },
    ] });
  };

  const roomRow = (r: SidebarRoom) => (
    <button key={r.id} type="button" class="vh-sb-row vh-sb-room" aria-current={p.current === r.id ? 'page' : undefined} onClick={() => p.onRoom(r.id)}
      onContextMenu={(e) => roomMenu(r, e)} aria-label={roomLabel(r, p.now)} title={since(r.at, p.now) === 'now' ? 'Just now' : since(r.at, p.now) ? `${since(r.at, p.now)} ago` : undefined}>
      <span class="vh-sb-glyph" aria-hidden="true"><i class={'vh-sb-dot' + (r.needs || r.work === 'waiting' ? ' is-needs' : r.quick ? ' is-quick' : '')} /></span>
      <span class="vh-sb-name">{r.name}</span>
      {r.faces.length ? <Faces people={r.faces} /> : r.work === 'running' ? <span class="vh-sb-running" aria-hidden="true" /> : null}
    </button>
  );

  return (
    <nav ref={nav} class="vh-sb" aria-label="Vowe">
      <div class="vh-sb-places">
        {PLACES.map((x) => (
          <button key={x.key} type="button" class="vh-sb-row" aria-current={p.place === x.key ? 'page' : undefined} onClick={() => p.onPlace(x.key)}>
            <span class="vh-sb-glyph"><Icon name={x.icon} size={16} /></span>
            <span class="vh-sb-name">{x.label}</span>
            {x.key === 'home' && p.needs ? <span class="vh-sb-count" aria-label={`${p.needs} need${p.needs > 1 ? '' : 's'} you`}>{p.needs}</span> : null}
          </button>
        ))}
        <button type="button" class="vh-sb-row vh-sb-newspace" aria-haspopup={canSpaces ? 'dialog' : undefined} aria-expanded={canSpaces ? menu?.kind === 'picker' && menu.mode.kind === 'new' : undefined}
          aria-keyshortcuts="Shift+Meta+N" onClick={(e) => newSpace(beside(e))}>
          <span class="vh-sb-glyph"><Icon name="folder-plus" size={16} /></span>
          <span class="vh-sb-name">New Space</span>
          <kbd class="vh-sb-kbd" aria-hidden="true">⇧⌘N</kbd>
        </button>
      </div>
      <div class="vh-sb-h">
        <span class="vh-sb-htitle">Spaces{filtering(filter) ? <span class="vh-sb-hfilter"> · {filterName(filter)}</span> : null}</span>
        {spaces ? (
          <button type="button" class={'v-iconbtn vh-sb-hbtn' + (filtering(filter) ? ' is-filtering' : '')} aria-label="Filter Spaces" aria-haspopup="menu"
            aria-expanded={menu?.kind === 'filter'} data-tip={filtering(filter) ? 'Filtered' : 'Filter'} data-tip-start=""
            onClick={(e) => setMenu(menu?.kind === 'filter' ? null : { kind: 'filter', at: below(e) })}><Icon name="filter" size={14} /></button>
        ) : null}
      </div>
      <div class="vh-sb-rooms">
        {groups.length === 0 ? (
          filtering(filter)
            ? <p class="vh-sb-none">Nothing matches the filter. <button type="button" class="linkish" onClick={() => setSidebarFilter({ needs: false, live: false, repo: null })}>Show everything</button></p>
            : <p class="vh-sb-none">No Spaces yet. A Space holds a project’s repositories; every room in it can use all of them.</p>
        ) : null}
        {groups.map((g) => {
          const o = isOpen(g), id = `vh-sb-space-${g.id.replace(/[^a-z0-9]+/gi, '-') || 'none'}`;
          const all = [...g.rooms, ...g.earlier];
          const earlier = earlierOpen.has(g.id);
          return (
            <div key={g.id} class={'vh-sb-repo' + (flash === g.id ? ' is-flash' : '')} data-space={g.id}>
              <div class="vh-sb-repoline" onContextMenu={(e) => spaceMenu(g, e)}>
                {renaming === g.id ? (
                  <div class="vh-sb-row vh-sb-reporow is-renaming">
                    <span class="vh-sb-glyph" aria-hidden="true"><Icon name="folder-open" size={16} /></span>
                    <RenameField value={g.name} onDone={(v) => rename(g, v ?? g.name)} />
                  </div>
                ) : (
                  <button type="button" class="vh-sb-row vh-sb-reporow" aria-expanded={o} aria-controls={id} onClick={() => toggle(g)}
                    onDblClick={(e) => { if (spaces && g.role === 'owner' && source?.renameSpace && (e.target as HTMLElement).closest('.vh-sb-name')) { e.preventDefault(); setRenaming(g.id); } }}
                    title={g.repos.length ? g.repos.join('\n') : undefined}>
                    <span class="vh-sb-glyph vh-sb-fold" aria-hidden="true">
                      <span class="vh-sb-fold-rest"><Icon name={o ? 'folder-open' : 'folder'} size={16} /></span>
                      <span class="vh-sb-fold-hover"><Icon name="chevron-r" size={16} /></span>
                    </span>
                    <span class="vh-sb-name">{g.name}</span>
                    {!o && all.some((r) => r.needs) ? <span class="vh-sb-state vh-sb-closedmark" aria-label="something here needs you"><i class="vh-sb-needsdot" /></span> : null}
                    {!o && !all.some((r) => r.needs) && all.some((r) => r.live) ? <span class="vh-sb-state vh-sb-closedmark" aria-label="a call is on here"><i class="vh-sb-livedot" /></span> : null}
                  </button>
                )}
                {renaming === g.id ? null : <button type="button" class="v-iconbtn vh-sb-repoadd" aria-label={`New room in ${g.name}`} data-tip={`New room in ${g.name}`} data-tip-end="" onClick={() => p.onNew(g.id || null)}><Icon name="plus" size={14} /></button>}
              </div>
              {/* Always drawn, so opening and closing can animate in step with the chevron; closed, it's out of reach. */}
              <div class={'vh-sb-repo-fold' + (o ? ' is-open' : '')} inert={!o} aria-hidden={!o}>
                <div id={id} role="group" aria-label={g.name} class="vh-sb-repo-rooms">
                  {g.rooms.map(roomRow)}
                  {!g.rooms.length && !g.earlier.length ? (
                    <button type="button" class="vh-sb-row vh-sb-room vh-sb-empty" onClick={() => p.onNew(g.id || null)}>
                      <span class="vh-sb-glyph" aria-hidden="true"><Icon name="plus" size={14} /></span><span class="vh-sb-name">New Room</span>
                    </button>
                  ) : null}
                  {g.earlier.length ? (
                    <>
                      <button type="button" class="vh-sb-row vh-sb-room vh-sb-earlier" aria-expanded={earlier} onClick={() => { if (earlier) earlierOpen.delete(g.id); else earlierOpen.add(g.id); bump(0); }}>
                        <span class="vh-sb-glyph" aria-hidden="true"><Icon name="chevron-r" size={14} /></span>
                        <span class="vh-sb-name">Earlier <span class="vh-sb-earliern">{g.earlier.length}</span></span>
                      </button>
                      {earlier ? g.earlier.map(roomRow) : null}
                    </>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {p.foot ? <div class="vh-sb-foot">{p.foot}</div> : null}
      <SidebarEdge />
      {menu?.kind === 'filter' && spaces ? (
        <FilterMenu at={menu.at} filter={filter} spaces={spaces} onClose={close} onFilter={setSidebarFilter}
          onCollapse={() => { for (const g of groups) opened.set(g.id, false); bump(0); }} />
      ) : null}
      {menu?.kind === 'picker' && source && spaces ? (
        <SpacePicker at={menu.at} mode={menu.mode} source={source} spaces={spaces} onClose={close} onMade={made} onJump={reveal} />
      ) : null}
      {menu?.kind === 'lines' ? <ContextMenu at={menu.at} label={menu.label} lines={menu.lines} onClose={close} /> : null}
    </nav>
  );
}

/** Who's in a room's call, as Slack shows a huddle on its channel: up to three faces, overlapping, then "+N". */
function Faces({ people }: { people: PersonRef[] }) {
  const shown = people.slice(0, MAX_FACES), more = people.length - shown.length;
  return (
    <span class="vh-sb-faces" aria-hidden="true">
      {shown.map((f) => <i key={f.initials + f.name} class={'vh-sb-face is-' + f.tone}>{f.initials.slice(0, 2)}</i>)}
      {more > 0 ? <i class="vh-sb-face is-more">+{more}</i> : null}
    </span>
  );
}

/** Finder's rename: the name selected in place; Return keeps it, Escape puts the old one back, clicking away keeps it. */
function RenameField({ value, onDone }: { value: string; onDone(v: string | null): void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const end = (v: string | null) => { if (done.current) return; done.current = true; onDone(v); };
  return (
    <input ref={ref} class="vh-sb-rename" type="text" defaultValue={value} aria-label="Space name" spellcheck={false}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); end(e.currentTarget.value); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end(null); } }}
      onBlur={(e) => end(e.currentTarget.value)} />
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
export function ShellSidebar(p: Omit<SidebarProps, 'rooms' | 'needs' | 'now' | 'onPlace'> & { rooms: RoomSummary[]; /** Invitations waiting, until the Inbox has read them. */ invitations?: number; onPlace?(place: SidebarPlace): void }) {
  const { state: inbox } = useActiveInbox();
  const { call } = useStore(callPresence);
  const now = new Date().toISOString();
  const needs = inbox && inbox.status !== 'loading' ? inbox.view.needs : null;
  const rooms = sidebarRooms(p.rooms, { now, callRoomId: call?.roomId ?? null, needsByRoom: needs ? countByRoom(needs) : null });
  return <Sidebar {...p} rooms={rooms} needs={inbox ? inbox.needsCount : p.invitations ?? 0} now={now} onPlace={p.onPlace ?? goPlace} />;
}

/** The sidebar's right edge: drag it to widen or narrow the sidebar (double-click for the usual width), or focus it
    and use the arrow keys. The width is the window's, so Home and every room follow. */
function SidebarEdge() {
  const { width } = useStore(shellPrefs);
  const drag = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX, w0 = shellPrefs.state.width;
    const move = (ev: PointerEvent) => setSidebarWidth(w0 + ev.clientX - x0, false);
    const up = () => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up);
      document.body.classList.remove('vh-sb-resizing');
      setSidebarWidth(shellPrefs.state.width);
    };
    document.body.classList.add('vh-sb-resizing');
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  };
  const key = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 40 : 10;
    const to = e.key === 'ArrowLeft' ? width - step : e.key === 'ArrowRight' ? width + step : e.key === 'Home' ? SIDEBAR_MIN : e.key === 'End' ? SIDEBAR_MAX : null;
    if (to === null) return;
    e.preventDefault();
    setSidebarWidth(to);
  };
  return (
    <div class="vh-sb-edge" role="separator" aria-orientation="vertical" aria-label="Sidebar width" tabIndex={0}
      aria-valuenow={width} aria-valuemin={SIDEBAR_MIN} aria-valuemax={SIDEBAR_MAX}
      onPointerDown={drag} onDblClick={() => setSidebarWidth(SIDEBAR_W)} onKeyDown={key} />
  );
}
