import { Fragment, h, type ComponentChildren } from '../../../vendor/preact.js';
import { useEffect, useReducer, useRef, useState } from '../../../vendor/preact-hooks.js';
import { useStore } from '../../../shared/store.js';
import { useActiveInbox } from '../../../features/inbox/ui/hooks.js';
import { callPresence } from '../../../features/call/presence.js';
import type { PersonRef, RoomSummary, SpaceSummary } from '../../../features/room/types.js';
import { Icon, type IconName } from '../../icons.js';
import { setSidebarWidth, shellPrefs, SIDEBAR_MAX, SIDEBAR_MIN, SIDEBAR_W } from './prefs.js';
import {
  countByRoom, filtering, groupRooms, MAX_FACES, groupSpaces, openByDefault, pinnedRooms, pinPlace, repoName, since, sidebarRooms, spaceOpenByDefault,
  type SidebarRoom, type SidebarSpace,
} from './sidebar-model.js';
import { setSidebarFilter, sidebarFilter, useSpaces } from './spaces.js';
import { ContextMenu, FilterMenu, SpacePicker, type At, type MenuLine, type PickerMode } from './SpaceMenus.js';

// The one sidebar, the same on Home and in every room: Journey's places (the Inbox, which is Home, and New Space,
// which starts one from the repositories on this Mac: SpaceMenus.tsx), the rooms you pinned, then your Spaces, each a folder of
// rooms. It is either shown or gone ("[" or the sidebar button hide it entirely; shell/prefs.ts keeps the choice).
//   Pinned           your pinned rooms, whatever Space they're in, in the order you dragged them; only there while
//                    something is. Nothing on a row says it's pinned: being at the top does. They leave their Spaces.
//   Spaces heading   a filter: what the list shows; tinted while it hides anything.
//   Space row        a folder, open or closed. On hover or keyboard focus it becomes the chevron that says
//                    what a click does, and a + starts a room in it. Right-click: new room, rename, link a
//                    repository, and the repositories it links. Double-click the name to rename it.
//   room row         a dot (signal: something, or an agent, waits on you; grey otherwise; a ring while the room is
//                    quick, not kept yet) and the name. On the right, who's in its call as faces, or a spinner while
//                    its agents work; nothing when it's quiet. How long since it moved is in its tooltip (and, pinned,
//                    its Space). On hover those give way to ⋯, the same menu as a right-click: pin, keep, rename,
//                    archive. Drag a room into Pinned to pin it there, within it to reorder, out of it to unpin.
//   Archived         rooms you archived leave your sidebar (yours alone); the filter's Archived Rooms shows them again.
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
/** Whether Pinned is open; closed, its heading stays, with its rooms folded away. */
let pinsOpen = true;
/** Spaces whose Earlier rooms you opened. */
const earlierOpen = new Set<string>();

const PLACES: { key: SidebarPlace; label: string; icon: IconName; tip?: string }[] = [
  { key: 'home', label: 'Inbox', icon: 'mail', tip: 'Inbox · ⌘1' },
];

const roomLabel = (r: SidebarRoom, now: string) =>
  `${r.name}${r.quick ? ', quick' : ''}${r.inCall ? ', your call is here' : r.live ? `, ${r.faces.map((f) => (f.tone === 'me' ? 'you' : f.name)).join(', ')} in the call` : ''}${r.work === 'running' ? ', agents working' : ''}${r.needs ? `, ${r.needs} need${r.needs > 1 ? '' : 's'} you` : ''}${since(r.at, now) === 'now' ? ', just now' : since(r.at, now) ? `, ${since(r.at, now)} ago` : ''}`;

type Menu = { kind: 'filter'; at: At } | { kind: 'picker'; at: At; mode: PickerMode } | { kind: 'lines'; at: At; label: string; lines: MenuLine[]; room?: string };

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
  const [renamingRoom, setRenamingRoom] = useState<string | null>(null);
  /** The room being dragged, and whether it came from Pinned. */
  const [drag, setDrag] = useState<{ id: string; pinned: boolean } | null>(null);
  /** Where it would land: an index among the pins (the insertion line), 'unpin' over the Spaces, or nowhere. */
  const [drop, setDrop] = useState<number | 'unpin' | null>(null);
  /** The room just archived, while its Undo is offered. */
  const [undo, setUndo] = useState<{ id: string; name: string } | null>(null);
  const pinList = useRef<HTMLDivElement>(null);
  const seenPins = useRef<Set<string> | null>(null);
  const close = () => setMenu(null);
  const nav = useRef<HTMLElement>(null);
  const newSpace = (at: At) => (canSpaces ? setMenu(menu?.kind === 'picker' ? null : { kind: 'picker', at, mode: { kind: 'new' } }) : p.onNew(null));

  // Without Spaces, the repositories stand in for them, one each.
  const groups: SidebarSpace[] = spaces
    ? groupSpaces(spaces, p.rooms, filter)
    : groupRooms(p.rooms).map((g) => ({ id: g.key, name: g.name, repos: g.repo ? [g.repo] : [], role: 'member', rooms: g.rooms, earlier: [] }));
  const pins = pinnedRooms(p.rooms, filter, spaces);
  const canPin = !!source?.pin;
  // A room that just arrived in Pinned slides up into place, as a note does when Notes pins it.
  const arriving = new Set(seenPins.current ? pins.filter((r) => !seenPins.current!.has(r.id)).map((r) => r.id) : []);
  useEffect(() => { seenPins.current = new Set(pins.map((r) => r.id)); });
  const spaceName = (r: SidebarRoom) => spaces?.find((s) => s.id === r.spaceId)?.name ?? null;
  const isOpen = (g: SidebarSpace) => opened.get(g.id) ?? (spaces ? spaceOpenByDefault(g, p.current) : openByDefault({ key: g.id, repo: null, name: g.name, rooms: g.rooms }, p.current));
  const toggle = (g: SidebarSpace) => { opened.set(g.id, !isOpen(g)); bump(0); };
  const canSpaces = !!(spaces && source?.createSpace);
  // Archive's Undo lasts a few seconds, and ⌘Z takes it while it's offered (not while typing).
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), 6000);
    const key = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.key.toLowerCase() !== 'z' || !nav.current?.offsetParent) return;
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return;
      e.preventDefault();
      unarchive();
    };
    addEventListener('keydown', key);
    return () => { clearTimeout(t); removeEventListener('keydown', key); };
  }, [undo]);
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
  // Pins and archive change the room source at once (it puts them back if the server refuses); nothing to say here.
  const pinTo = (r: SidebarRoom, order: number | null) => void source?.pin?.(r.id, order).catch(() => {});
  const archive = (r: SidebarRoom) => {
    void source?.archive?.(r.id, true).catch(() => setUndo(null));
    setUndo({ id: r.id, name: r.name });
  };
  const unarchive = () => {
    if (!undo) return;
    void source?.archive?.(undo.id, false).catch(() => {});
    setUndo(null);
  };
  const renameRoom = (r: SidebarRoom, name: string | null) => {
    setRenamingRoom(null);
    const to = name?.trim();
    if (to && to !== r.name) void source?.update?.(r.id, { name: to }).catch(() => { /* the name stays as it was */ });
  };
  /** The room's menu, the same from ⋯ and a right-click. */
  const roomMenu = (r: SidebarRoom, at: At) => {
    const lines: MenuLine[] = [
      ...(source?.pin && !r.archived ? [{ icon: 'pin', label: r.pin !== null ? 'Unpin Room' : 'Pin Room', run: () => pinTo(r, r.pin !== null ? null : pinPlace(pins, pins.length)) } as MenuLine] : []),
      ...(source?.keep && r.quick && !r.archived ? [{ icon: 'keep', label: 'Keep Room', run: () => void source.keep!(r.id, true).catch(() => {}) } as MenuLine] : []),
      ...(source?.update && r.role === 'owner' ? [{ icon: 'pen', label: 'Rename', run: () => setRenamingRoom(r.id) } as MenuLine] : []),
    ];
    if (source?.archive) {
      if (lines.length) lines.push('sep');
      lines.push(r.archived
        ? { icon: 'archive', label: 'Unarchive Room', run: () => void source.archive!(r.id, false).catch(() => {}) }
        : { icon: 'archive', label: 'Archive Room', run: () => archive(r) });
    }
    if (lines.length) setMenu({ kind: 'lines', at, label: r.name, lines, room: r.id });
  };

  // Dragging a room: into Pinned (anywhere along it) pins it there; out of Pinned onto the Spaces unpins it.
  const startDrag = (r: SidebarRoom, e: DragEvent) => {
    e.dataTransfer?.setData('text/plain', r.name);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    setDrag({ id: r.id, pinned: r.pin !== null });
  };
  const endDrag = () => { setDrag(null); setDrop(null); };
  const overPins = (e: DragEvent) => {
    if (!drag) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const rows = [...(pinList.current?.querySelectorAll<HTMLElement>('.vh-sb-roomline') ?? [])].filter((el) => el.dataset.room !== drag.id);
    const i = rows.findIndex((el) => { const b = el.getBoundingClientRect(); return e.clientY < b.top + b.height / 2; });
    const at = i < 0 ? rows.length : i;
    if (at !== drop) setDrop(at);
  };
  const dropPins = (e: DragEvent) => {
    if (!drag) return;
    e.preventDefault();
    const r = p.rooms.find((x) => x.id === drag.id);
    const rest = pins.filter((x) => x.id !== drag.id);
    if (r) pinTo(r, pinPlace(rest, typeof drop === 'number' ? drop : rest.length));
    endDrag();
  };
  const overSpaces = (e: DragEvent) => {
    if (!drag) return;
    if (!drag.pinned) { if (drop !== null) setDrop(null); return; }
    e.preventDefault();
    if (drop !== 'unpin') setDrop('unpin');
  };
  const dropSpaces = (e: DragEvent) => {
    if (!drag?.pinned) return;
    e.preventDefault();
    const r = p.rooms.find((x) => x.id === drag.id);
    if (r) pinTo(r, null);
    endDrag();
  };

  const roomRow = (r: SidebarRoom, pinned = false) => {
    const ago = since(r.at, p.now);
    const tip = [pinned ? spaceName(r) : null, ago === 'now' ? 'Just now' : ago ? `${ago} ago` : null].filter(Boolean).join(' · ') || undefined;
    const menuOpen = menu?.kind === 'lines' && menu.room === r.id;
    const dot = <span class="vh-sb-glyph" aria-hidden="true"><i class={'vh-sb-dot' + (r.needs || r.work === 'waiting' ? ' is-needs' : r.quick ? ' is-quick' : '')} /></span>;
    if (renamingRoom === r.id) {
      return (
        <div key={r.id} class="vh-sb-roomline" data-room={r.id}>
          <div class="vh-sb-row vh-sb-room is-renaming">{dot}<RenameField label="Room name" value={r.name} onDone={(v) => renameRoom(r, v)} /></div>
        </div>
      );
    }
    return (
      <div key={r.id} data-room={r.id} draggable={canPin && !r.archived} onDragStart={(e) => startDrag(r, e)} onDragEnd={endDrag}
        class={'vh-sb-roomline' + (menuOpen ? ' is-menu' : '') + (r.archived ? ' is-archived' : '') + (pinned && arriving.has(r.id) ? ' is-arriving' : '') + (drag?.id === r.id ? ' is-dragging' : '')}>
        <button type="button" class="vh-sb-row vh-sb-room" aria-current={p.current === r.id ? 'page' : undefined} onClick={() => p.onRoom(r.id)}
          onContextMenu={(e) => { e.preventDefault(); roomMenu(r, point(e)); }}
          onKeyDown={(e) => { if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); roomMenu(r, beside(e)); } }}
          aria-label={roomLabel(r, p.now)} title={tip}>
          {dot}
          <span class="vh-sb-name">{r.name}</span>
          <span class="vh-sb-trail">{r.faces.length ? <Faces people={r.faces} /> : r.work === 'running' ? <span class="vh-sb-running" aria-hidden="true" /> : null}</span>
        </button>
        <button type="button" class="v-iconbtn vh-sb-more" aria-label={`${r.name}: more`} aria-haspopup="menu" aria-expanded={menuOpen} tabIndex={-1}
          onClick={(e) => (menuOpen ? close() : roomMenu(r, beside(e)))}><Icon name="more" size={16} /></button>
      </div>
    );
  };
  const showPins = pins.length > 0 || (!!drag && canPin && !drag.pinned);
  const rest = drag ? pins.filter((x) => x.id !== drag.id) : pins;
  const line = (i: number) => (drop === i ? <i key="insert" class="vh-sb-insert" aria-hidden="true" /> : null);

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
      <div class="vh-sb-rooms" onDragOver={overSpaces} onDrop={dropSpaces}>
        {showPins ? (
          <div class={'vh-sb-pins' + (drop !== null && drop !== 'unpin' ? ' is-target' : '')} onDragOver={(e) => { e.stopPropagation(); overPins(e); }} onDrop={(e) => { e.stopPropagation(); dropPins(e); }}>
            <div class="vh-sb-h vh-sb-pinsh">
              <button type="button" class="vh-sb-hfold" aria-expanded={pinsOpen || !!drag} aria-controls="vh-sb-pinned" onClick={() => { pinsOpen = !pinsOpen; bump(0); }}>
                Pinned<Icon name={pinsOpen || drag ? 'chevron' : 'chevron-r'} size={14} />
              </button>
            </div>
            {pinsOpen || drag ? (
              <div ref={pinList} id="vh-sb-pinned" role="group" aria-label="Pinned" class="vh-sb-pinlist">
                {pins.map((r) => (
                  <Fragment key={r.id}>{line(rest.indexOf(r))}{roomRow(r, true)}</Fragment>
                ))}
                {line(rest.length)}
                {!pins.length ? <div class="vh-sb-pinslot" aria-hidden="true" /> : null}
              </div>
            ) : null}
          </div>
        ) : null}
      <div class="vh-sb-h">
        <span class="vh-sb-htitle">Spaces{filtering(filter) ? <span class="vh-sb-hfilter"> · {filterName(filter)}</span> : null}</span>
        {spaces ? (
          <button type="button" class={'v-iconbtn vh-sb-hbtn' + (filtering(filter) ? ' is-filtering' : '')} aria-label="Filter Spaces" aria-haspopup="menu"
            aria-expanded={menu?.kind === 'filter'} data-tip={filtering(filter) ? 'Filtered' : 'Filter'} data-tip-start=""
            onClick={(e) => setMenu(menu?.kind === 'filter' ? null : { kind: 'filter', at: below(e) })}><Icon name="filter" size={14} /></button>
        ) : null}
      </div>
        <div class={'vh-sb-spaces' + (drop === 'unpin' ? ' is-target' : '')}>
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
                    <RenameField label="Space name" value={g.name} onDone={(v) => rename(g, v ?? g.name)} />
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
                  {g.rooms.map((r) => roomRow(r))}
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
                      {earlier ? g.earlier.map((r) => roomRow(r)) : null}
                    </>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
        </div>
      </div>
      {undo ? (
        <div class="vh-sb-undo" role="status">
          <Icon name="archive" size={14} /><span class="vh-sb-name">{undo.name}</span>
          <button type="button" class="vh-sb-undobtn" aria-keyshortcuts="Meta+Z" onClick={unarchive}>Undo</button>
        </div>
      ) : null}
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
function RenameField({ label, value, onDone }: { label: string; value: string; onDone(v: string | null): void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const end = (v: string | null) => { if (done.current) return; done.current = true; onDone(v); };
  return (
    <input ref={ref} class="vh-sb-rename" type="text" defaultValue={value} aria-label={label} spellcheck={false}
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
