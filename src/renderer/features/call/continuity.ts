import type { CallLink } from './presence.js';
import type { CallStatus } from './session.js';

// The call outlives the screen you're on. Going Home or to another room is navigation; only hanging up,
// leaving the room, signing out or crossing between the demo and your rooms ends a call. Pure, so the app
// and its tests agree on when the call's room stays mounted (hidden) and when joining asks first.

/** The voice connection's own state, where the call has one (LiveKit's CallService). */
export type VoiceLinkStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'dropped';

export interface CallNow { roomId: string | null; status: CallStatus }

/** You're in this call (or on your way out of it): its room stays mounted wherever you go. */
const HELD: CallStatus[] = ['connected', 'dropped', 'leaving'];

/**
 * Which room to keep mounted for the call, and whether it's the one on screen. `showing` is the room the
 * route shows (null on Home and other screens). A call that is still connecting is joined from the
 * room's own preview, which is on screen anyway.
 */
export function callLayout(call: CallNow, showing: string | null): { keep: string | null; visible: boolean } {
  const keep = call.roomId && HELD.includes(call.status) ? call.roomId : null;
  return { keep, visible: !!keep && showing === keep };
}

/** What joining `target`'s call means now: join it, ask before leaving the call you're in, or wait. */
export function joinPlan(call: CallNow, target: string): 'join' | 'switch' | 'busy' {
  if (call.status === 'connecting' || call.status === 'leaving') return 'busy';
  if (call.roomId && call.roomId !== target && (call.status === 'connected' || call.status === 'dropped')) return 'switch';
  return 'join';
}

/** How the call's connection reads to every screen: the session's state, refined by the voice link. */
export function callLink(session: CallStatus, voice: VoiceLinkStatus | null): CallLink | null {
  switch (session) {
    case 'idle': case 'failed': return null;
    case 'connecting': return 'connecting';
    case 'leaving': return 'leaving';
    case 'dropped': return 'dropped';
    case 'connected':
      return voice === 'reconnecting' ? 'reconnecting' : voice === 'dropped' ? 'dropped' : voice === 'connecting' ? 'connecting' : 'connected';
  }
}
