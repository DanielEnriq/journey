import { h } from '../../../vendor/preact.js';
import type { Person, Presence } from './types.js';

interface AvatarProps {
  person: Person | undefined;
  size?: 16 | 18 | 20;
  /** Ring in the person's tone: they are here right now. */
  ring?: boolean;
  /** Dashed outline: an empty slot waiting for this person. */
  pending?: boolean;
}

/** Initials in the person's tone, or the Vowe orb for the agent. */
export function Avatar({ person, size = 20, ring = false, pending = false }: AvatarProps) {
  if (person?.kind === 'agent') {
    return <span class={`rp-orb rp-av-${size}`} aria-hidden="true" />;
  }
  const tone = person?.tone ?? 'me';
  const cls = ['rp-av', `rp-av-${size}`, `rp-tone-${tone}`, ring ? 'rp-ring' : '', pending ? 'rp-pending' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <span class={cls} aria-hidden="true">
      {person?.initials ?? '?'}
    </span>
  );
}

export function TypingDots() {
  return (
    <span class="rp-dots" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

const VERB: Record<Presence['mode'], string> = {
  reading: 'is reading',
  typing: 'is typing',
  reviewing: 'is reviewing',
};

/** "John is reading" with a ringed avatar; animated dots while they act. */
export function PresenceTag({ presence, people }: { presence: Presence; people: Record<string, Person> }) {
  const person = people[presence.personId];
  const busy = presence.mode !== 'reading';
  return (
    <span class={`rp-pres${busy ? ' rp-busy' : ''}`} role="status">
      <Avatar person={person} size={16} ring />
      {person?.name ?? 'Someone'} {VERB[presence.mode]}
      {busy ? <TypingDots /> : null}
    </span>
  );
}

/** Tone class for an edge glow in the person's colour. */
export function liveTone(presence: Presence | undefined, people: Record<string, Person>): string {
  if (!presence) return '';
  return ` rp-live rp-tone-${people[presence.personId]?.tone ?? 'peer'}`;
}
