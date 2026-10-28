import { useEffect, useReducer } from '../../../vendor/preact-hooks.js';
import { Store, useStore } from '../../../shared/store.js';
import type { RoomDataSource } from '../../../features/room/data/sources.js';
import type { SpaceSummary } from '../../../features/room/types.js';
import { NO_FILTER, type SidebarFilter } from './sidebar-model.js';

// Where the sidebar reads Spaces from: the workspace on screen (your rooms or the demo's), set once by the app, so
// every screen's sidebar sees the same Spaces without each passing them down. And what its filter menu chose,
// kept on this machine like the sidebar's other choices (prefs.ts): every read and write tolerates no storage.

export const spaceSource = new Store<{ source: RoomDataSource | null }>({ source: null });

/** The workspace's Spaces, re-read as it changes; null where the workspace has none (the sidebar groups by repository). */
export function useSpaces(): { source: RoomDataSource | null; spaces: SpaceSummary[] | null } {
  const { source } = useStore(spaceSource);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => (source ? source.subscribe(() => bump(0)) : undefined), [source]);
  return { source, spaces: source?.spaces?.() ?? null };
}

const FILTER_KEY = 'vowe.shell.sidebarFilter';

function readFilter(): SidebarFilter {
  try {
    const f = JSON.parse(localStorage.getItem(FILTER_KEY) ?? 'null') as Partial<SidebarFilter> | null;
    return { ...NO_FILTER, ...(f && typeof f === 'object' ? f : {}) };
  } catch { return NO_FILTER; }
}

export const sidebarFilter = new Store<SidebarFilter>(typeof localStorage !== 'undefined' ? readFilter() : NO_FILTER);

export function setSidebarFilter(patch: Partial<SidebarFilter>) {
  sidebarFilter.setState(patch);
  try { localStorage.setItem(FILTER_KEY, JSON.stringify(sidebarFilter.state)); } catch { /* the filter lasts this session */ }
}
