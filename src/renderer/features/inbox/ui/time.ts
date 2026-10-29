import type { InboxItem } from '../model.js';

// How the Inbox says time and moves through its list, as pure rules (tested in time.test.ts). Times are said
// against the view's own `now`, so a row never disagrees with the derivation it came from.

/** "now", "41m", "3h", "2d", "3w", "4mo", "1y": time since, the way Linear says it. */
export function ago(iso: string, now: string): string {
  const t = Date.parse(iso), n = Date.parse(now);
  if (!Number.isFinite(t) || !Number.isFinite(n)) return '';
  const m = Math.floor((n - t) / 60_000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  if (d < 30) return `${Math.floor(d / 7)}w`;
  if (d < 365) return `${Math.floor(d / 30)}mo`;
  return `${Math.floor(d / 365)}y`;
}

/** "Morning" / "Afternoon" / "Evening", for the greeting. */
export const partOfDay = (iso: string) => { const h = new Date(iso).getHours(); return h < 12 ? 'Morning' : h < 18 ? 'Afternoon' : 'Evening'; };

/** Tomorrow at 9:00 in local time, for "Until tomorrow, 9:00". */
export function tomorrowAt9(now: string): string {
  const d = new Date(Date.parse(now) + 86_400_000);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}

/** The snooze choices, in the order the menu offers them. "Until something new happens" never expires on time. */
export function snoozeChoices(now: string): { label: string; until: string }[] {
  return [
    { label: 'Until tomorrow, 9:00', until: tomorrowAt9(now) },
    { label: 'Until something new happens', until: '9999-12-31T00:00:00.000Z' },
    { label: 'Until after this call', until: new Date(Date.parse(now) + 3_600_000).toISOString() },
  ];
}

/** The list's order: Needs you, then Following, then In your rooms. */
export const inOrder = (v: { needs: InboxItem[]; following: InboxItem[]; activity: InboxItem[] }) => [...v.needs, ...v.following, ...v.activity];

/** j/k: the next or previous item from the selected one (from the top or bottom when nothing is selected). */
export function step(ids: string[], selected: string | null, d: 1 | -1): string | null {
  if (!ids.length) return null;
  const i = selected ? ids.indexOf(selected) : -1;
  if (i < 0) return d > 0 ? ids[0] : ids[ids.length - 1];
  return ids[Math.max(0, Math.min(ids.length - 1, i + d))];
}

/** After an item leaves the list (done, snoozed, answered), the one to select: the next, else the previous. */
export function nextAfter(ids: string[], gone: string): string | null {
  const i = ids.indexOf(gone);
  if (i < 0) return null;
  return ids[i + 1] ?? ids[i - 1] ?? null;
}
