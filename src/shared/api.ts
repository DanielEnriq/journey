/**
 * The contract between main and renderer. Types only: the sandboxed preload can't
 * load local modules at runtime, so nothing here may emit JavaScript.
 *
 * Adding a capability: declare it in `Channels`, handle it in main/ipc.ts, and
 * expose it in preload/index.cts + `JourneyApi`. The compiler checks all three agree.
 */

export interface User {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
}

export type Theme = 'system' | 'light' | 'dark';

/** Every app preference. Add a key here and a default + validator in database/settings.ts. */
export interface Settings {
  theme: Theme;
}

export interface Repository {
  id: string;
  path: string;
  name: string;
  addedAt: string;
  lastOpenedAt: string | null;
}

/**
 * IPC channel names. `invoke` channels are request/response handled by main
 * (arguments are untrusted at runtime; handlers must validate them). `event`
 * channels are pushed from main to renderers.
 */
export interface Channels {
  invoke: {
    'auth:getUser': () => User | null;
    'auth:signIn': () => User;
    'auth:signOut': () => void;
    'settings:get': () => Settings;
    'settings:update': (patch: Partial<Settings>) => Settings;
    'repos:list': () => Repository[];
    /** Main shows a folder picker; resolves null if cancelled. The renderer never sends paths. */
    'repos:add': () => Repository | null;
    'repos:remove': (id: string) => void;
  };
  event: {
    'auth:changed': User | null;
  };
}

export type InvokeChannel = keyof Channels['invoke'];
export type InvokeArgs<K extends InvokeChannel> = Parameters<Channels['invoke'][K]>;
export type InvokeResult<K extends InvokeChannel> = ReturnType<Channels['invoke'][K]>;
export type EventChannel = keyof Channels['event'];

/** What the preload exposes on `window.journey`. */
export interface JourneyApi {
  auth: {
    getUser(): Promise<User | null>;
    signIn(): Promise<User>;
    signOut(): Promise<void>;
    /** Subscribes to sign-in/sign-out; returns an unsubscribe function. */
    onChange(listener: (user: User | null) => void): () => void;
  };
  settings: {
    get(): Promise<Settings>;
    update(patch: Partial<Settings>): Promise<Settings>;
  };
  repos: {
    list(): Promise<Repository[]>;
    add(): Promise<Repository | null>;
    remove(id: string): Promise<void>;
  };
}
