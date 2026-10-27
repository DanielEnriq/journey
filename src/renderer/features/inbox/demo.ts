import { demoScene } from '../workspace/mock/canvas.js';
import { DEMO_ME, demoVowe } from '../workspace/mock/record.js';
import { workspace as demoWorkspace } from '../workspace/mock/workspace.js';
import { createInboxSource, type InboxController, type InboxDeps } from './records.js';

// The Inbox over the example workspace: the same source and derive as your rooms', reading the demo
// rooms' records (workspace/mock/record.ts), so signing, answering and replying here change the room you
// open next. The example workspace has no invitations, runs or PRs; your marks stay on this machine.

export function createDemoInbox(storage: InboxDeps['storage']): InboxController {
  return createInboxSource({
    services: demoVowe,
    rooms: demoWorkspace.room,
    invites: null,
    me: () => DEMO_ME,
    storage,
    scene: async (roomId) => (await demoScene(roomId))?.scene ?? null,
    unavailable: ['runner', 'github'],
  });
}
