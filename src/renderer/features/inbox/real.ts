import { inboxMarks, realWorkspace, roomScene, selfCloudId } from '../workspace/real/workspace.js';
import { createInboxSource, NOT_IN_JOURNEY, trackPresence, type InboxController } from './records.js';
import { activeInbox } from './source.js';
import type { StorageLike } from './marks.js';

// Binds the Inbox to your rooms while you're signed in. Signing out disposes it (writing any pending Done marks).

const storage = (): StorageLike | null => { try { return window.localStorage; } catch { return null; } };

function realInbox(): InboxController {
  return createInboxSource({
    services: realWorkspace.vowe,
    rooms: realWorkspace.room,
    invites: realWorkspace.invites,
    me: selfCloudId,
    storage: storage(),
    remoteMarks: inboxMarks,
    scene: async (roomId) => (await roomScene(roomId)).scene,
    onFocus: (fn) => { window.addEventListener('focus', fn); return () => window.removeEventListener('focus', fn); },
    unavailable: NOT_IN_JOURNEY,
  });
}

let current: { source: InboxController; off: () => void } | null = null;

/** Shows the Inbox, or none (false: signed out). Call from an effect; calling again while on keeps the source. */
export function bindInbox(on: boolean) {
  if (on && current) return current.source;
  current?.off();
  current?.source.dispose();
  current = null;
  if (!on) { activeInbox.setState({ source: null }); return null; }
  const source = realInbox();
  const off = trackPresence(source, window, document);
  current = { source, off };
  activeInbox.setState({ source });
  return source;
}
