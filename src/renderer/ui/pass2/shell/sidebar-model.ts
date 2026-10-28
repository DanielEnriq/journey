import type { RoomSummary, SpaceSummary } from '../../../features/room/types.js';

// What the sidebar shows, as pure rules (tested in sidebar-model.test.ts): rooms grouped under their Space
// (or, where Spaces aren't known, their repository), which groups start open, which rooms are quick or have
// gone quiet into Earlier, what the filters leave, and how long since a room moved. Journey's RoomSummary
// and SpaceSummary already carry everything; nothing new is loaded for it.

export interface SidebarRoom {
  id: string;
  name: string;
  repo: string | null;
  /** A call is on there (anyone's). */
  live: boolean;
  /** It's your call's room. */
  inCall: boolean;
  /** Items there that need you (from the Inbox; the room's own `needs` when the Inbox hasn't read yet). */
  needs: number;
  /** Nothing has moved there for a week: only decides whether its repository starts open. */
  quiet: boolean;
  /** When it last moved (ISO). */
  at: string;
  /** Its Space; null where that isn't known. */
  spaceId: string | null;
  /** Not kept yet: somewhere to look at something, kept once it holds work or someone keeps it. */
  quick: boolean;
  /** Quick, and nothing has moved there for a day: it waits under Earlier, never deleted. */
  earlier: boolean;
}

/** A Space as the sidebar draws it: its rooms, and the quick ones gone quiet, under Earlier. */
export interface SidebarSpace { id: string; name: string; repos: string[]; role: SpaceSummary['role']; rooms: SidebarRoom[]; earlier: SidebarRoom[] }

/** What the sidebar's filter menu chose. Kept on this machine (prefs). */
export interface SidebarFilter {
  /** Earlier rooms listed with the rest, not folded under Earlier. */
  earlier: boolean;
  /** Only rooms where something needs you. */
  needs: boolean;
  /** Only rooms with a call on. */
  live: boolean;
  /** Only Spaces that link this repository. */
  repo: string | null;
}
export const NO_FILTER: SidebarFilter = { earlier: false, needs: false, live: false, repo: null };
/** Whether the filter hides anything: the filter button says so. */
export const filtering = (f: SidebarFilter) => f.needs || f.live || f.repo !== null;

/** A quick room goes under Earlier once it has been quiet this long. */
export const EARLIER_MS = 86_400_000;

export interface SidebarGroup { key: string; repo: string | null; name: string; rooms: SidebarRoom[] }

/** "workflows" from "github.com/halyard/workflows"; rooms without one group under "No repository". */
export const repoName = (repo: string | null) => (repo ? repo.split('/').filter(Boolean).pop() ?? repo : 'No repository');

/** "now", "28m", "5h", "3d", "1mo": how long since a room last moved, in the fewest characters. */
export function since(iso: string, now: string): string {
  const m = Math.max(0, Math.round((Date.parse(now) - Date.parse(iso)) / 60000));
  if (!Number.isFinite(m)) return '';
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr}h`;
  const d = Math.round(hr / 24);
  if (d < 30) return `${d}d`;
  return `${Math.max(1, Math.round(d / 30))}mo`;
}

/** Repositories, most recently active first; rooms in each, most recent first. "No repository" sorts like any other. */
export function groupRooms(rooms: SidebarRoom[]): SidebarGroup[] {
  const groups: SidebarGroup[] = [];
  for (const r of [...rooms].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.name.localeCompare(b.name)))) {
    const key = r.repo ?? '';
    const g = groups.find((x) => x.key === key);
    if (g) g.rooms.push(r); else groups.push({ key, repo: r.repo, name: repoName(r.repo), rooms: [r] });
  }
  return groups;
}

const recentFirst = (a: SidebarRoom, b: SidebarRoom) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.name.localeCompare(b.name));

/**
 * Spaces in their own order (they don't jump around as rooms move), rooms in each most recent first, the quiet quick
 * ones under Earlier. Rooms whose Space isn't listed (it hasn't loaded) go in a last group named "Rooms". With a filter,
 * Spaces with nothing left in them are left out; without one, every Space shows, empty ones too.
 */
export function groupSpaces(spaces: SpaceSummary[], rooms: SidebarRoom[], filter: SidebarFilter = NO_FILTER): SidebarSpace[] {
  const keep = (r: SidebarRoom) => (!filter.needs || r.needs > 0) && (!filter.live || r.live);
  const known = new Set(spaces.map((s) => s.id));
  const loose = rooms.filter((r) => !r.spaceId || !known.has(r.spaceId));
  const all: SpaceSummary[] = loose.length ? [...spaces, { id: '', name: 'Rooms', repos: [], role: 'member' }] : spaces;
  const out: SidebarSpace[] = [];
  for (const s of all) {
    if (filter.repo && !s.repos.some((r) => r.toLowerCase() === filter.repo!.toLowerCase())) continue;
    const mine = (s.id ? rooms.filter((r) => r.spaceId === s.id) : loose).filter(keep).sort(recentFirst);
    const fold = (r: SidebarRoom) => r.earlier && !filter.earlier;
    const g = { id: s.id, name: s.name, repos: s.repos, role: s.role, rooms: mine.filter((r) => !fold(r)), earlier: mine.filter(fold) };
    if (filtering(filter) && !g.rooms.length && !g.earlier.length) continue;
    out.push(g);
  }
  return out;
}

/** A Space starts open when one of its rooms is current, has a call on, needs you, or moved this week; an empty one too. */
export const spaceOpenByDefault = (g: SidebarSpace, current: string | null) =>
  !g.rooms.length && !g.earlier.length ? true : openByDefault({ key: g.id, repo: null, name: g.name, rooms: [...g.rooms, ...g.earlier] }, current);

/** Every repository the Spaces link, once each, for the filter menu. */
export const allRepos = (spaces: SpaceSummary[]) => [...new Map(spaces.flatMap((s) => s.repos).map((r) => [r.toLowerCase(), r])).values()];

/**
 * A name for a new Space from the repositories it starts with: the one repository's name; several under one owner,
 * the owner ("acme" for github.com/acme/web and github.com/acme/api); otherwise the first, and how many more.
 */
export function suggestSpaceName(repos: { label: string; identity: string | null }[]): string {
  if (!repos.length) return 'New Space';
  if (repos.length === 1) return repos[0]!.label;
  const owners = repos.map((r) => r.identity?.split('/').slice(-2, -1)[0]?.toLowerCase() ?? null);
  if (owners[0] && owners.every((o) => o === owners[0])) return repos[0]!.identity!.split('/').slice(-2, -1)[0]!;
  return `${repos[0]!.label} + ${repos.length - 1}`;
}

/** A repository starts open when one of its rooms is current, has a call on, needs you, or moved this week. */
export const openByDefault = (g: SidebarGroup, current: string | null) =>
  g.rooms.some((r) => r.id === current || r.live || r.inCall || r.needs > 0 || !r.quiet);

/**
 * RoomSummary → SidebarRoom. `needsByRoom` is the Inbox's Needs you, counted per room; where the Inbox has no
 * entry for a room (it hasn't read yet) the room's own `needs` line counts as one.
 */
export function sidebarRooms(rooms: RoomSummary[], o: { now: string; callRoomId: string | null; needsByRoom?: Record<string, number> | null; quietAfterDays?: number }): SidebarRoom[] {
  const quiet = (o.quietAfterDays ?? 7) * 86_400_000;
  return rooms.map((r) => {
    const at = r.activityAt ?? o.now;
    const quickRoom = r.keptAt === null;
    return {
      id: r.id,
      name: r.name,
      repo: r.repo,
      spaceId: r.spaceId ?? null,
      quick: quickRoom,
      earlier: quickRoom && Date.parse(o.now) - Date.parse(at) > EARLIER_MS && o.callRoomId !== r.id && r.inCall.length === 0,
      live: r.inCall.length > 0 || o.callRoomId === r.id,
      inCall: o.callRoomId === r.id,
      needs: o.needsByRoom ? o.needsByRoom[r.id] ?? 0 : r.needs ? 1 : 0,
      quiet: Date.parse(o.now) - Date.parse(at) > quiet,
      at,
    };
  });
}

/** Needs you, counted per room. */
export function countByRoom(items: { room: { id: string } }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) out[it.room.id] = (out[it.room.id] ?? 0) + 1;
  return out;
}
