import { useEffect, useReducer } from '../vendor/preact-hooks.js';

/** The smallest observable state holder: plain objects in, a change callback out. */
export class Store<S extends object> {
  private listeners = new Set<() => void>();

  constructor(public state: S) {}

  setState(patch: Partial<S>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** Re-renders the calling component whenever the store changes. */
export function useStore<S extends object>(store: Store<S>): S {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const off = store.subscribe(() => bump(0));
    return () => {
      off();
    };
  }, [store]);
  return store.state;
}
