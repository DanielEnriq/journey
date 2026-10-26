import { createContext } from '../../vendor/preact.js';
import { useContext, useEffect, useRef } from '../../vendor/preact-hooks.js';
import { callPresence, type CallPresence } from './presence.js';

// A room kept mounted for its call while you look elsewhere is hidden (and inert). Anything in it that
// listens on the window (keyboard shortcuts) asks this first, so only the room on screen answers keys.

export const RoomShown = createContext(true);

/** Whether this room is on screen, as a ref that window listeners can read when a key arrives. */
export function useShownRef(): { readonly current: boolean } {
  const shown = useContext(RoomShown);
  const ref = useRef(shown);
  ref.current = shown;
  return ref;
}

/** Publishes the call's presence while this component owns the call; clears it when it stops owning it. */
export function usePublishCall(call: CallPresence | null): void {
  useEffect(() => {
    callPresence.setState({ call });
  });
  const roomId = call?.roomId ?? null;
  useEffect(() => () => {
    if (roomId && callPresence.state.call?.roomId === roomId) callPresence.setState({ call: null });
  }, [roomId]);
}
