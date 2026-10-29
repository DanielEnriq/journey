import { Fragment, h, type ComponentChildren } from '../../../vendor/preact.js';
import { useEffect, useRef, useState } from '../../../vendor/preact-hooks.js';
import type { LocalRepo, RoomDataSource } from '../../../features/room/data/sources.js';
import type { SpaceSummary } from '../../../features/room/types.js';
import { Switch } from '../../components.js';
import { Icon, type IconName } from '../../icons.js';
import { allRepos, filtering, NO_FILTER, repoName, suggestSpaceName, type SidebarFilter } from './sidebar-model.js';

// The sidebar's menus, drawn the way macOS draws them: one raised panel, check marks in a column on the left,
// small grey section names, keyboard first (arrows move, Return picks, Escape closes and gives focus back).
//   FilterMenu    what the Spaces list shows: Earlier rooms, archived ones, only what needs you or has a call on, one repository.
//   ContextMenu   a right-click on a Space or a room.
//   SpacePicker   a new Space starts from the repositories on this Mac: one click makes it, named after the
//                 repository; Select Multiple makes one from several. A repository another of your Spaces
//                 already links says so, and goes there, so the same code doesn't end up in two Spaces by accident.
//                 The same panel links a repository to an existing Space.

export interface At { x: number; y: number }

/** Where a panel of about this size fits on screen, from a point. */
const fit = (at: At, w: number, hgt: number) => `left:${Math.max(8, Math.min(at.x, innerWidth - w - 8))}px;top:${Math.max(8, Math.min(at.y, innerHeight - hgt - 8))}px`;

/** A menu's keyboard and closing: focus its first item, arrows between items, Escape or a click outside closes. */
function useMenu(onClose: () => void, first?: string) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    // A menu takes focus itself, as a Mac menu opens with nothing highlighted; the first arrow reaches its first item.
    (first ? box.current?.querySelector<HTMLElement>(first) : box.current)?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); back?.focus(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation();
        const items = [...(box.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled]), [role="option"]:not([aria-disabled="true"])') ?? [])];
        const i = items.indexOf(document.activeElement as HTMLElement);
        items[i < 0 ? (e.key === 'ArrowDown' ? 0 : items.length - 1) : (i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
      }
    };
    const down = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) onClose(); };
    addEventListener('keydown', key, true);
    addEventListener('pointerdown', down, true);
    return () => { removeEventListener('keydown', key, true); removeEventListener('pointerdown', down, true); };
  }, []);
  return box;
}

export interface MenuEntry {
  icon?: IconName; label: string; run?(): void; checked?: boolean; mono?: boolean; hint?: string; disabled?: boolean;
  /** A few grey words at the right edge, where a Mac menu puts its shortcuts. */
  detail?: string;
}
export type MenuLine = MenuEntry | 'sep' | { section: string };

function Lines({ lines, onClose, checks }: { lines: MenuLine[]; onClose(): void; checks?: boolean }) {
  return (
    <>
      {lines.map((l, i) => {
        if (l === 'sep') return <div key={i} class="v-menu-sep" role="separator" />;
        if ('section' in l) return <div key={i} class="vh-sbm-sec">{l.section}</div>;
        const role = l.checked !== undefined ? 'menuitemcheckbox' : 'menuitem';
        return (
          <button key={i} type="button" role={role} aria-checked={l.checked} disabled={l.disabled || !l.run} class={'v-menu-item vh-sbm-item' + (l.mono ? ' is-mono' : '')}
            title={l.hint} onClick={() => { onClose(); l.run?.(); }}>
            {checks ? <span class="vh-sbm-check">{l.checked ? <Icon name="check" size={14} /> : null}</span> : null}
            {l.icon ? <Icon name={l.icon} size={14} /> : null}
            <span class="vh-sbm-label">{l.label}</span>
            {l.detail ? <span class="vh-sbm-detail">{l.detail}</span> : null}
          </button>
        );
      })}
    </>
  );
}

export function ContextMenu({ at, label, lines, onClose, width = 240 }: { at: At; label: string; lines: MenuLine[]; onClose(): void; width?: number }) {
  const box = useMenu(onClose);
  const tall = lines.reduce((n, l) => n + (l === 'sep' ? 9 : 30), 10);
  return <div ref={box} tabIndex={-1} class="v-menu vh-sbm" role="menu" aria-label={label} style={`${fit(at, width, tall)};width:${width}px`}><Lines lines={lines} onClose={onClose} /></div>;
}

export function FilterMenu({ at, filter, spaces, onFilter, onCollapse, onClose }: {
  at: At; filter: SidebarFilter; spaces: SpaceSummary[]; onFilter(f: Partial<SidebarFilter>): void; onCollapse(): void; onClose(): void;
}) {
  const box = useMenu(onClose);
  const repos = allRepos(spaces);
  const lines: MenuLine[] = [
    { section: 'Show' },
    { label: 'Earlier Rooms', checked: filter.earlier, run: () => onFilter({ earlier: !filter.earlier }) },
    { label: 'Archived Rooms', checked: filter.archived, run: () => onFilter({ archived: !filter.archived }) },
    { section: 'Only' },
    { label: 'Needs You', checked: filter.needs, run: () => onFilter({ needs: !filter.needs }) },
    { label: 'Calls On Now', checked: filter.live, run: () => onFilter({ live: !filter.live }) },
    ...(repos.length > 1 ? [
      { section: 'Repository' } as MenuLine,
      { label: 'All Repositories', checked: filter.repo === null, run: () => onFilter({ repo: null }) },
      ...repos.map((r): MenuLine => ({ label: repoName(r), hint: r, mono: true, checked: filter.repo?.toLowerCase() === r.toLowerCase(), run: () => onFilter({ repo: r }) })),
    ] : []),
    'sep',
    { label: 'Collapse All Spaces', run: onCollapse },
    ...(filtering(filter) || filter.earlier || filter.archived ? [{ label: 'Reset Filters', run: () => onFilter(NO_FILTER) } as MenuLine] : []),
  ];
  return <div ref={box} tabIndex={-1} class="v-menu vh-sbm" role="menu" aria-label="Filter Spaces" style={fit(at, 240, 360)}><Lines lines={lines} onClose={onClose} checks /></div>;
}

export type PickerMode = { kind: 'new' } | { kind: 'link'; space: SpaceSummary };

/**
 * The New Space panel (and, for a Space, Link Repository). Repositories come from this Mac; only their remote is
 * shared. Picking one makes the Space at once; with Select Multiple, check several and make it from all of them.
 */
export function SpacePicker({ at, mode, source, spaces, onMade, onJump, onClose }: {
  at: At; mode: PickerMode; source: RoomDataSource; spaces: SpaceSummary[];
  /** A Space was made (new) or linked to (link). */
  onMade(space: SpaceSummary, fresh: boolean): void;
  /** Go to the Space that already links a repository. */
  onJump(spaceId: string): void;
  onClose(): void;
}) {
  const box = useMenu(onClose, 'input');
  const [repos, setRepos] = useState<LocalRepo[] | null>(null);
  const [q, setQ] = useState('');
  const [multi, setMulti] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = () => source.localRepos?.().then(setRepos, (e: Error) => { setRepos([]); setError(e.message); });
  useEffect(() => { void load(); }, [source]);

  const linking = mode.kind === 'link' ? mode.space : null;
  const home = (r: LocalRepo) => r.identity ? spaces.find((s) => s.id !== linking?.id && s.repos.some((x) => x.toLowerCase() === r.identity!.toLowerCase())) ?? null : null;
  const linked = (r: LocalRepo) => !!linking && !!r.identity && linking.repos.some((x) => x.toLowerCase() === r.identity!.toLowerCase());
  const needle = q.trim().toLowerCase();
  const shown = (repos ?? []).filter((r) => !needle || r.label.toLowerCase().includes(needle) || (r.identity ?? '').toLowerCase().includes(needle));

  const run = (f: () => Promise<void>) => { setBusy(true); setError(null); f().then(() => setBusy(false), (e: Error) => { setBusy(false); setError(e.message); }); };
  const make = (picked: LocalRepo[]) => run(async () => {
    const made = await source.createSpace!({ name: suggestSpaceName(picked), repos: picked.map((r) => r.id) });
    onClose(); onMade(made, true);
  });
  const link = (r: LocalRepo) => run(async () => { await source.linkRepo!(linking!.id, r.id); onClose(); onMade(linking!, false); });
  const pick = (r: LocalRepo) => {
    if (!r.identity || busy || linked(r)) return;
    if (linking) link(r);
    else if (multi) setChosen((c) => (c.includes(r.id) ? c.filter((x) => x !== r.id) : c.concat([r.id])));
    else make([r]);
  };
  // A folder chosen in Finder joins the list, and is picked as if clicked.
  const choose = () => run(async () => {
    const added = await source.addRepo!();
    if (!added) return;
    const fresh = await source.localRepos!();
    setRepos(fresh);
    const r = fresh.find((x) => x.id === added.id);
    if (r) setTimeout(() => pick(r), 0);
  });
  const onSearchKey = (e: KeyboardEvent) => { if (e.key === 'Enter' && shown.length && !multi) { e.preventDefault(); pick(shown[0]!); } };

  const footer: ComponentChildren = multi && !linking ? (
    <div class="vh-sbp-make">
      <span>{chosen.length ? `${chosen.length} selected` : 'Select repositories'}</span>
      <button type="button" class="vh-sbp-go" disabled={!chosen.length || busy} onClick={() => make((repos ?? []).filter((r) => chosen.includes(r.id)))}>Create Space</button>
    </div>
  ) : null;

  return (
    <div ref={box} class="v-menu vh-sbm vh-sbp" role="dialog" aria-label={linking ? `Link a repository to ${linking.name}` : 'New Space'} style={fit(at, 320, 420)} aria-busy={busy}>
      <div class="vh-sbp-search">
        <Icon name="search" size={14} />
        <input type="text" placeholder={linking ? `Link to ${linking.name}…` : 'Find a repository…'} value={q} aria-label="Find a repository"
          onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)} onKeyDown={onSearchKey} />
      </div>
      <div class="vh-sbp-head">
        <span class="vh-sbm-sec">On This Mac</span>
        {!linking ? <label class="vh-sbp-multi">Select Multiple<Switch checked={multi} label="Select Multiple" onChange={(v) => { setMulti(v); setChosen([]); }} /></label> : null}
      </div>
      <div class="vh-sbp-list" role="listbox" aria-multiselectable={multi || undefined} aria-label="Repositories on this Mac">
        {repos === null ? <div class="vh-sbp-empty"><span class="spinlet" /></div> : null}
        {repos && !shown.length ? <div class="vh-sbp-empty">{repos.length ? 'No repository matches.' : 'No repositories added on this Mac yet.'}</div> : null}
        {shown.map((r) => {
          const elsewhere = linking ? null : home(r), on = chosen.includes(r.id), done = linked(r);
          const off = !r.identity || done;
          return (
            <div key={r.id} role="option" tabIndex={off ? -1 : 0} aria-selected={multi ? on : undefined} aria-disabled={off || undefined}
              class={'vh-sbp-row' + (off ? ' is-off' : '') + (on ? ' is-on' : '')} title={r.identity ?? 'No remote: only a repository with a remote can be shared'}
              onClick={() => pick(r)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(r); } }}>
              {multi ? <span class={'vh-sbp-box' + (on ? ' is-on' : '')}>{on ? <Icon name="check" size={14} /> : null}</span> : <Icon name={done ? 'check' : 'folder'} size={14} />}
              <span class="vh-sbp-name">{r.label}</span>
              {elsewhere ? (
                <button type="button" class="vh-sbp-in" tabIndex={-1} title={`Already in ${elsewhere.name}. Go there`} onClick={(e) => { e.stopPropagation(); onClose(); onJump(elsewhere.id); }}>
                  {elsewhere.name}<Icon name="arrow-ur" size={14} />
                </button>
              ) : done || !r.identity ? <span class="vh-sbp-id">{done ? 'Linked' : 'No remote'}</span> : null}
            </div>
          );
        })}
      </div>
      {error ? <div class="vh-sbp-err" role="alert">{error}</div> : null}
      {footer}
      <div class="v-menu-sep" role="separator" />
      {source.addRepo ? <button type="button" role="menuitem" class="v-menu-item vh-sbm-item" onClick={choose}><Icon name="folder-plus" size={14} /><span class="vh-sbm-label">Choose Folder…</span></button> : null}
      {!linking ? (
        <button type="button" role="menuitem" class="v-menu-item vh-sbm-item" disabled={busy} onClick={() => run(async () => { const made = await source.createSpace!({ name: 'New Space', repos: [] }); onClose(); onMade(made, true); })}>
          <Icon name="folder" size={14} /><span class="vh-sbm-label">Empty Space</span>
        </button>
      ) : null}
    </div>
  );
}
