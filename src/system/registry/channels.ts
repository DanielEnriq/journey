import type { ComparisonSite, LiteralSite } from '../../shared/system/model.js';
import type { Facts } from './facts.js';

// String channels: the same literal registered as a handler in one place and invoked, emitted or
// compared in another. The index records every literal at a call site; this is where a literal becomes
// a channel, matched by its exact text.

/** `ipcMain.handle('x')`, `handle('x')`. */
const HANDLE = new Set(['handle', 'handleOnce']);
/** `app.get('/route')` and friends: routes only when the literal looks like a path. */
const HTTP = new Set(['get', 'post', 'put', 'patch', 'delete', 'all', 'route']);
/** Request/response: `ipcRenderer.invoke('x')`, `fetch('/route')`. */
const SEND = new Set(['invoke', 'sendSync', 'request', 'fetch', 'call']);
/** Subscriptions to a named event. */
const SUBSCRIBE = new Set(['on', 'once', 'subscribe', 'addListener', 'addEventListener', 'prependListener']);
/** Emitting a named event. */
const EMIT = /^(emit|broadcast|publish|announce|notify|dispatchEvent|trigger|send)$|^send\w*Event$|^emit\w+$/;

/** A literal that reads as a channel or route rather than prose: `canvas:execute`, `/api/rooms`, `changed`. */
export const channelish = (s: string) => /^[a-z][\w-]*(?:[:/.][\w-]+)+$/i.test(s) || /^\/[\w\-/:{}.]*$/.test(s);
const eventish = (s: string) => channelish(s) || /^[a-z][a-zA-Z0-9_-]{2,40}$/.test(s);

export interface Channels {
  /** Literal → the sites registering a handler for it. */
  handled: Map<string, LiteralSite[]>;
  /** Literal → request sites (invoke/fetch) for a handled channel. */
  invoked: Map<string, LiteralSite[]>;
  /** Literal → sites emitting it as an event, and subscribing/comparing it. Only literals with both. */
  events: Map<string, { publishers: LiteralSite[]; subscribers: LiteralSite[]; comparisons: ComparisonSite[] }>;
}

const push = <V>(m: Map<string, V[]>, k: string, v: V) => { const l = m.get(k); if (l) l.push(v); else m.set(k, [v]); };

export function analyseChannels(F: Facts): Channels {
  const handled = new Map<string, LiteralSite[]>(), invoked = new Map<string, LiteralSite[]>();
  const pubs = new Map<string, LiteralSite[]>(), subs = new Map<string, LiteralSite[]>();
  for (const l of F.index.literals) {
    if (F.isTest(l.file)) continue;
    if (HANDLE.has(l.method) && channelish(l.literal) && l.argIndex === 0) push(handled, l.literal, l);
    else if (HTTP.has(l.method) && l.literal.startsWith('/') && l.argIndex === 0 && !/^(map|set|params|query|headers|searchParams|cache|store)$/.test(l.callee.split('.').slice(-2)[0] ?? '')) push(handled, l.literal, l);
  }
  for (const l of F.index.literals) {
    if (F.isTest(l.file)) continue;
    if (handled.has(l.literal) && (SEND.has(l.method) || (l.method === 'send' && l.argIndex === 0))) push(invoked, l.literal, l);
    else if (SUBSCRIBE.has(l.method) && eventish(l.literal)) push(subs, l.literal, l);
    else if (EMIT.test(l.method) && eventish(l.literal) && !HANDLE.has(l.method)) push(pubs, l.literal, l);
  }
  const events = new Map<string, { publishers: LiteralSite[]; subscribers: LiteralSite[]; comparisons: ComparisonSite[] }>();
  for (const [lit, publishers] of [...pubs].sort(([a], [b]) => (a < b ? -1 : 1))) {
    let comparisons = (F.comparisonsByValue.get(lit) ?? []).filter((c) => !F.isTest(c.file) && /(^|\.)(type|event|kind|name|channel)$/.test(c.subject));
    let subscribers = subs.get(lit) ?? [];
    // A bare word ('changed') is only the same event where the subscriber can see the publisher: within two imports.
    if (!channelish(lit)) {
      const near = (file: string) => publishers.some((p) => p.file === file || hops(F, file, p.file) <= 2);
      subscribers = subscribers.filter((s) => near(s.file));
      comparisons = comparisons.filter((c) => near(c.file));
    }
    if (subscribers.length || comparisons.length) events.set(lit, { publishers, subscribers, comparisons });
  }
  return { handled, invoked, events };
}

function hops(F: Facts, from: string, to: string): number {
  const one = (f: string) => (F.importsFrom.get(f) ?? []).map((i) => i.to).filter((t): t is string => !!t);
  const a = one(from);
  if (a.includes(to)) return 1;
  return a.some((f) => one(f).includes(to)) ? 2 : 3;
}

/** `canvas:execute` → `canvas.execute`: how a bridge API names a channel's method, for matching `j.canvas.execute(…)`. */
export function channelKey(literal: string): string {
  const parts = literal.split(/[:/.]+/).filter(Boolean);
  return parts.slice(-2).join('.').toLowerCase();
}

/** `j.canvas.execute` → `canvas.execute`. */
export function calleeKey(callee: string): string {
  const parts = callee.replace(/\(.*?\)/g, '').split('.').filter(Boolean);
  return parts.length >= 3 ? parts.slice(-2).join('.').toLowerCase() : '';
}
