import type { InboxItem } from '../model.js';

// Which reading page an item gets, from what it is about and what you owe; never from the shape of its id
// (ids are the derivation's business). Tested in body.test.ts.

export type BodyKind = 'sign' | 'question' | 'thread' | 'invitation' | 'authorize' | 'allow' | 'generic';

export function bodyKind(it: Pick<InboxItem, 'subject' | 'obligation'>): BodyKind {
  const k = it.subject.kind;
  if (k === 'decision' && it.obligation === 'sign') return 'sign';
  if (k === 'question') return 'question';
  if (k === 'thread') return 'thread';
  if (k === 'invitation') return 'invitation';
  if (k === 'plan' && it.obligation === 'authorize') return 'authorize';
  if (k === 'plan' && it.obligation === 'allow') return 'allow';
  return 'generic';
}

/** Done is for what you follow or saw in your rooms; what needs you leaves when it's discharged. */
export const canMarkDone = (it: Pick<InboxItem, 'tier'>) => it.tier !== 'needs';

/** An invitation opens nothing until you join: Enter and "Open in room" don't apply to it. */
export const canOpen = (it: Pick<InboxItem, 'subject'>) => it.subject.kind !== 'invitation';
