import { realWorkspace, roomScene, selfCloudId } from '../workspace/real/workspace.js';
import { createDemoInbox } from './demo.js';
import { createInboxSource, NOT_IN_JOURNEY, trackPresence, type InboxController } from './records.js';
import { activeInbox } from './source.js';
import type { StorageLike } from './marks.js';

// Binds the Inbox to the workspace the app is showing: Journey's rooms (real) or the example rooms (demo).
// One source at a time; switching workspaces disposes the old one (writing any pending Done marks).

const storage = (): StorageLike | null => { try { return window.localStorage; } catch { return null; } };

function realInbox(): InboxController {
  return createInboxSource({
    services: realWorkspace.vowe,
    rooms: realWorkspace.room,
    invites: realWorkspace.invites,
    me: selfCloudId,
    storage: storage(),
    scene: async (roomId) => (await roomScene(roomId)).scene,
    onFocus: (fn) => { window.addEventListener('focus', fn); return () => window.removeEventListener('focus', fn); },
    unavailable: NOT_IN_JOURNEY,
  });
}

let current: { demo: boolean; source: InboxController; off: () => void } | null = null;

/** Shows the Inbox for this workspace (null: none, e.g. signed out). Call from an effect; calling again for the same workspace keeps the source. */
export function bindInbox(which: 'demo' | 'real' | null) {
  const demo = which === 'demo';
  if (which && current && current.demo === demo) return current.source;
  current?.off();
  current?.source.dispose();
  current = null;
  if (!which) { activeInbox.setState({ source: null }); return null; }
  const source = demo ? createDemoInbox(storage()) : realInbox();
  const off = trackPresence(source, window, document);
  current = { demo, source, off };
  activeInbox.setState({ source });
  return source;
}
