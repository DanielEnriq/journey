import { useEffect, useRef, useState } from '../../vendor/preact-hooks.js';
import type { RoomDataSource } from '../room/data/sources.js';
import type { RoomSummary } from '../room/types.js';

/** The workspace's rooms, kept current. */
export function useRooms(room: RoomDataSource): RoomSummary[] {
  const [rooms, setRooms] = useState(() => room.list());
  useEffect(() => { setRooms(room.list()); return room.subscribe(() => setRooms(room.list())); }, [room]);
  return rooms;
}

export type Loaded<T> =
  | { state: 'loading'; value: null; error: null }
  | { state: 'ready'; value: T; error: null }
  | { state: 'failed'; value: T | null; error: string };

/**
 * Loads `fetch` now and again whenever `subscribe` fires, keeping what it had while it reloads, so a
 * refresh never flashes a loading state. `retry` starts over after a failure.
 */
export function useLoaded<T>(fetch: () => Promise<T>, subscribe: (fn: () => void) => () => void, key: unknown): Loaded<T> & { retry(): void } {
  const [st, setSt] = useState<Loaded<T>>({ state: 'loading', value: null, error: null });
  const gen = useRef(0);
  const run = (fresh: boolean) => {
    const id = ++gen.current;
    if (fresh) setSt({ state: 'loading', value: null, error: null });
    fetch().then(
      (value) => { if (gen.current === id) setSt({ state: 'ready', value, error: null }); },
      (err: Error) => { if (gen.current === id) setSt((prev) => ({ state: 'failed', value: prev.value, error: err.message })); },
    );
  };
  useEffect(() => {
    run(true);
    return subscribe(() => run(false));
  }, [key]);
  return { ...st, retry: () => run(true) };
}
