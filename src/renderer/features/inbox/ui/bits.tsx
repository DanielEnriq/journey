import { h, Fragment } from '../../../vendor/preact.js';
import { useEffect, useRef } from '../../../vendor/preact-hooks.js';
import { AgentMark, Avatar } from '../../../ui/components.js';
import { Icon, type IconName } from '../../../ui/icons.js';
import { AGENT } from '../../vowe-room/contracts/model.js';
import type { PersonId } from '../../vowe-room/journey.js';
import type { InboxItem } from '../model.js';
import type { InboxPerson } from '../source.js';
import { canMarkDone, canOpen } from './body.js';
import { snoozeChoices } from './time.js';

// Small pieces the Inbox's list and reading page share: a person's face from the view's own people, and the
// item menu (the page bar's Snooze, and a row's context menu).

const TONE = { me: 1, peer: 2, p2: 3, p3: 4 } as const;

export type People = Record<PersonId, InboxPerson>;

export const nameIn = (people: People, me: PersonId | null) => (id: PersonId | null | undefined): string =>
  !id ? 'Vowe' : id === me ? 'You' : people[id]?.name ?? (id === AGENT ? 'Vowe' : 'Someone');

/** A face: the agent's mark for the agent, a quiet glyph for the system, initials for people. */
export function Face({ id, people, size = 24 }: { id: PersonId | null; people: People; size?: 16 | 20 | 24 | 28 }) {
  if (id === AGENT) return <AgentMark size={size - 4} />;
  const p = id ? people[id] : undefined;
  if (!p) return <span class="vi-sysav" style={`width:${size}px;height:${size}px`} aria-hidden="true"><Icon name="canvas" size={14} /></span>;
  return <Avatar initials={p.initials} tone={TONE[p.tone]} size={size} name={p.name} />;
}

export interface ItemMenuActs {
  snooze(it: InboxItem, until: string, label: string): void;
  done(it: InboxItem): void;
  follow(it: InboxItem, on: boolean): void;
  open(it: InboxItem): void;
}

/**
 * The item's menu. `only: 'snooze'` is the page bar's Snooze; without it, a row's context menu (snooze, done,
 * follow, open). Focus moves in; Esc or a click outside closes it and focus goes back where it was.
 */
export function ItemMenu({ it, now, at, only, acts, onClose }: { it: InboxItem; now: string; at?: { x: number; y: number }; only?: 'snooze'; acts: ItemMenuActs; onClose(): void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); back?.focus(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation();
        const items = [...(box.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
        const i = items.indexOf(document.activeElement as HTMLElement);
        items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
      }
    };
    const down = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) onClose(); };
    addEventListener('keydown', key, true);
    addEventListener('pointerdown', down, true);
    return () => { removeEventListener('keydown', key, true); removeEventListener('pointerdown', down, true); };
  }, []);
  const pick = (f: () => void) => () => { onClose(); f(); };
  const following = it.tier === 'following';
  const item = (icon: IconName, label: string, f: () => void, hint?: string) => (
    <button type="button" role="menuitem" class="v-menu-item" onClick={pick(f)}>
      <Icon name={icon} /><span>{label}</span>{hint ? <kbd class="v-kbd">{hint}</kbd> : null}
    </button>
  );
  return (
    <div ref={box} class={'v-menu vi-menu' + (at ? ' is-at' : '')} role="menu" aria-label={only ? 'Snooze' : it.headline}
      style={at ? `left:${Math.min(at.x, innerWidth - 248)}px;top:${Math.min(at.y, innerHeight - 260)}px` : undefined}>
      {!only ? <div class="v-menu-label v-label">Snooze</div> : null}
      {snoozeChoices(now).map((c) => item('snooze', c.label, () => acts.snooze(it, c.until, c.label)))}
      {!only ? (
        <>
          <div class="v-menu-sep" role="separator" />
          {canMarkDone(it) ? item('check', 'Done', () => acts.done(it), 'E') : null}
          {item(following ? 'unfollow' : 'follow', following ? 'Unfollow' : 'Follow', () => acts.follow(it, !following))}
          {canOpen(it) ? item('external', 'Open in room', () => acts.open(it), '↵') : null}
        </>
      ) : null}
    </div>
  );
}
