import type { CallLink, CallPresence } from '../../call/presence.js';
import type { PersonRef } from '../types.js';

// What the call cluster draws, derived from `callPresence` alone (tested in call-view.test.ts). Nothing here
// keeps state: mute, connection and who's in come from the last publish, so the cluster can never disagree
// with the call.

export interface CallPerson { key: string; name: string; initials: string; tone: PersonRef['tone'] }

export interface CallView {
  roomId: string;
  roomName: string;
  me: CallPerson;
  /** Everyone in the call but you. */
  others: CallPerson[];
  link: CallLink;
  muted: boolean;
  /** Why your mic can't be used (the mic is disabled and says so). */
  micOff?: string;
  /** Your Vowe is in the call. */
  vowe: boolean;
  /** Vowe hears you: it's in the call and your mic is on. */
  hearing: boolean;
  agentName: string;
  /** Key of whoever is talking ('me' for you), or null. */
  speaking: string | null;
  /** You're looking at the call's room. */
  here: boolean;
  /** The room's own CallBar is on screen (its canvas is showing): the cluster shows presence only. */
  barShown: boolean;
  /** Leaving: the hang-up can't be pressed twice. */
  leaving: boolean;
  /** The connection is not live: 'reconnecting' or 'dropped' (and 'connecting' before the first join). */
  trouble: 'connecting' | 'reconnecting' | 'dropped' | null;
  /** Rejoin is possible (after `dropped`, when the call offers it). */
  canRejoin: boolean;
  /** The accessible name of the presence pill. */
  label: string;
  /** What Vowe hears, in words: the tooltip and the popover say it so it never implies listening when it isn't. */
  voweLine: string;
}

export function callView(c: CallPresence, o: { looking: string | null; canvasShown: boolean }): CallView {
  const people = c.people.map((p, i): CallPerson => ({ key: p.tone === 'me' ? 'me' : `${p.initials}:${i}`, name: p.name, initials: p.initials, tone: p.tone }));
  const me = people.find((p) => p.key === 'me') ?? { key: 'me', name: 'You', initials: 'You', tone: 'me' as const };
  const others = people.filter((p) => p.key !== 'me');
  const here = o.looking === c.roomId;
  const muted = c.muted || !!c.micOff;
  const hearing = c.vowe && !muted && c.link === 'connected';
  // `speaking` comes as initials (or 'me'); map it to a person's key.
  const speaking = c.speaking === null ? null : c.speaking === 'me' ? 'me' : others.find((p) => p.initials === c.speaking)?.key ?? null;
  const trouble = c.link === 'connecting' || c.link === 'reconnecting' || c.link === 'dropped' ? c.link : null;
  const names = others.map((p) => p.name);
  const label = trouble === 'dropped'
    ? `The ${c.roomName} call dropped`
    : `In the ${c.roomName} call with ${names.length ? listNames(names) : 'nobody else'}${c.vowe ? ` and ${c.agentName}` : ''}${trouble === 'reconnecting' ? ', reconnecting' : trouble === 'connecting' ? ', connecting' : ''}`;
  const voweLine = !c.vowe ? `${c.agentName} isn’t in this call`
    : hearing ? `${c.agentName} is in the call and hears you`
    : `${c.agentName} is in the call; it hears you only while your mic is on`;
  return {
    roomId: c.roomId, roomName: c.roomName, me, others, link: c.link, muted, micOff: c.micOff, vowe: c.vowe, hearing, agentName: c.agentName,
    speaking, here, barShown: here && o.canvasShown, leaving: c.link === 'leaving', trouble, canRejoin: c.link === 'dropped' && !!c.act.rejoin, label, voweLine,
  };
}

export function listNames(xs: string[]): string {
  return xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

/** What you are in the call, for the popover's "You" line. */
export function yourState(v: CallView): string {
  if (v.trouble === 'dropped') return 'disconnected';
  if (v.micOff) return 'listening';
  return v.muted ? 'muted' : v.speaking === 'me' ? 'speaking' : 'heard when you talk';
}
