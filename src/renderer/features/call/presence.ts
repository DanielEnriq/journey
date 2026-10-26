import { Store } from '../../shared/store.js';
import type { PersonRef } from '../room/types.js';

// CONTRACT (lead-owned): your call, as every screen draws it. The call outlives the screen you're on: going
// Home or to another room is navigation, not leaving. The room that owns the call (kept mounted while you look
// elsewhere) publishes this; the band's call cluster on Home, on other rooms and in Full screen reads it.
// Nothing keeps its own copy of mute or connection state: every control acts through `act`, and the next
// publish is the only source of truth for what the UI shows.

export type CallLink = 'connecting' | 'connected' | 'reconnecting' | 'dropped' | 'leaving';

export interface CallPresence {
  roomId: string;
  roomName: string;
  link: CallLink;
  /** Your mic is off. True while `micOff` is set. */
  muted: boolean;
  /** Why your mic can't be used here (a viewer listens; no voice in this call). */
  micOff?: string;
  /** Your Vowe is in the call (it hears you only while your mic is on). */
  vowe: boolean;
  /** What the agent is called in this room. */
  agentName: string;
  /** Everyone in the call, you included (tone 'me'). */
  people: PersonRef[];
  /** Initials of whoever is talking now ('me' for you), or null. */
  speaking: string | null;
  act: {
    /** Toggles your mic (asks the OS the first time). */
    mic(): void;
    /** Ends your participation; you stay on the screen you're on. */
    leave(): Promise<void>;
    /** Rejoins after `dropped`. */
    rejoin?(): void;
  };
}

/** Null when you're in no call. */
export const callPresence = new Store<{ call: CallPresence | null }>({ call: null });
