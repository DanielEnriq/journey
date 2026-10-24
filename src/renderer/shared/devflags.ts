import { Store } from './store.js';

// Switches the developer menu flips to show states the mocks would otherwise never reach: a slow or
// failing call connection, a work context that is slow or can't be read. Off by default, so the normal
// experience has no artificial delays. Kept per machine in localStorage.

export interface DevFlags {
  slowCall: boolean;
  failCall: boolean;
  slowWork: boolean;
  failWork: boolean;
}

const KEY = 'vowe.devflags';
const OFF: DevFlags = { slowCall: false, failCall: false, slowWork: false, failWork: false };

function load(): DevFlags {
  try { return { ...OFF, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return OFF; }
}

export const devFlags = new Store<DevFlags>(load());
devFlags.subscribe(() => { try { localStorage.setItem(KEY, JSON.stringify(devFlags.state)); } catch { /* storage may be unavailable */ } });

/** Resolves after `ms`, only when a dev flag asked for a delay. */
export const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
