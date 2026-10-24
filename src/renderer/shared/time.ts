/** "just now", "4 min ago", "2 h ago", "3 days ago": how long ago an ISO time was. */
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return '';
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

/** An ISO time `minutes` before `from`. */
export const minutesBefore = (from: number, minutes: number) => new Date(from - minutes * 60_000).toISOString();

/** "now", "14m", "2h", "3d": the room panel's compact form of ago(). */
export function shortAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return '';
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
