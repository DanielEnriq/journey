import { Store, useStore } from '../../../shared/store.js';
import { activeInbox, type InboxSource, type InboxState } from '../source.js';

// Reading the Inbox from a component. Hooks can't be called conditionally, so with no source a stand-in store
// is read and the result is null.

const NONE = new Store<InboxState | { none: true }>({ none: true });

export function useInboxState(source: InboxSource | null): InboxState | null {
  const s = useStore<InboxState | { none: true }>(source ? source.store : NONE);
  return 'none' in s ? null : s;
}

/** The Inbox of the workspace on screen, and its state. */
export function useActiveInbox(): { source: InboxSource | null; state: InboxState | null } {
  const { source } = useStore(activeInbox);
  return { source, state: useInboxState(source) };
}
