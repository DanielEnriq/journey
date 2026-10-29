import { Store } from '../../shared/store.js';

/** The room New Room just made, until its screen opens Share on it. */
export const freshRoom = new Store<{ id: string | null }>({ id: null });
