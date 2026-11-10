import type { SystemApi } from '../../../shared/system/api.js';

// How the system canvas page reaches whoever hosts the index. Inside Electron the preload exposes
// `window.journey.system` (IPC to main/system-canvas.ts); served by the dev server
// (scripts/system-canvas/serve.mjs) it's plain JSON over HTTP. Both are the same Node service behind
// one interface, so the page never knows which it got.

/** What the page gets: SystemApi, whichever host is behind it. */
export type SystemClient = SystemApi;

/** The method names both hosts accept, in one place so the server and the clients can't drift apart. */
export const SYSTEM_METHODS = [
  'repos', 'open', 'freshness', 'refresh', 'source', 'fixtures', 'fixture', 'views', 'saveView', 'traces', 'addInterpretation',
] as const satisfies readonly (keyof SystemApi)[];

export class SystemApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** The dev server's routes: `POST <base>/api/<method>` with the arguments as a JSON array. */
export function httpSystemApi(base = ''): SystemClient {
  const call = async (method: string, args: unknown[]) => {
    const res = await fetch(`${base}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    const body = await res.json().catch(() => null) as { result?: unknown; error?: string } | null;
    if (!res.ok || !body || 'error' in body) throw new SystemApiError(body?.error ?? `${method} failed (${res.status})`, res.status);
    return body.result;
  };
  return clientFrom(call);
}

/** Electron: the preload's named functions (window.journey.system). */
export function ipcSystemApi(): SystemClient {
  const bridge = window.journey?.system;
  if (!bridge) throw new Error('This window has no system bridge');
  return bridge;
}

/** IPC when the page runs inside Electron, else the dev server it was served from. */
export function pickSystemApi(): SystemClient {
  return typeof window !== 'undefined' && window.journey?.system ? ipcSystemApi() : httpSystemApi();
}

function clientFrom(call: (method: string, args: unknown[]) => Promise<unknown>): SystemClient {
  // Trailing undefined arguments are dropped so optional parameters arrive as absent, not null.
  const fn = (method: string) => (...args: unknown[]) => {
    while (args.length && args[args.length - 1] === undefined) args.pop();
    return call(method, args);
  };
  return Object.fromEntries(SYSTEM_METHODS.map((m) => [m, fn(m)])) as unknown as SystemClient;
}
