import { Store } from './store.js';
import type { Anchor } from '../features/inbox/model.js';

// CONTRACT (lead-owned): landing somewhere exact in a room, from outside it. An Inbox item (or anything else
// that knows a room's record) sets `pendingAnchor`, then navigates to the room's route. The room applies it to
// its own UI state (tab, inspect, thread, lit parts, depth) once its record has loaded, then clears it. This
// works whether the room was already mounted (kept alive for a call) or mounts fresh, and doesn't depend on
// any component being on screen when the item was opened.

export interface PendingAnchor {
  anchor: Anchor | null;
  /** Changes on every request, so opening the same anchor twice applies twice. */
  nonce: number;
}

export const pendingAnchor = new Store<PendingAnchor>({ anchor: null, nonce: 0 });

export function requestAnchor(anchor: Anchor) {
  pendingAnchor.setState({ anchor, nonce: pendingAnchor.state.nonce + 1 });
}

/** The room calls this once it has applied the anchor meant for it. */
export function takeAnchor(roomId: string): Anchor | null {
  const a = pendingAnchor.state.anchor;
  if (!a || a.roomId !== roomId) return null;
  pendingAnchor.setState({ anchor: null });
  return a;
}
