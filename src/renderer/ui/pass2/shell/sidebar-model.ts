import type { RoomSummary } from '../../../features/room/types.js';

// What the sidebar shows, as pure rules (tested in sidebar-model.test.ts): rooms grouped under their
// repository, repositories ordered by their most recent room, which repositories start open, and how long
// since a room moved. Journey's RoomSummary already carries everything; nothing new is loaded for it.

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
}

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
    return {
      id: r.id,
      name: r.name,
      repo: r.repo,
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
