import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;padding:3rem">${body}</body>`;
const SUCCESS_HTML = page('Signed in', "You're signed in. You can close this tab and return to Vowe.");
const FAILURE_HTML = page('Sign-in failed', 'Sign-in failed. You can close this tab and try again.');

export interface LoopbackListener {
  redirectUri: string;
  /** Resolves with the authorization code once Google redirects back. */
  code: Promise<string>;
  close(): void;
}

export interface CallbackListener {
  redirectUri: string;
  /**
   * Every query parameter of the redirect whose `state` matched; an OAuth `error` arrives here too,
   * for the caller to handle. Rejects on a state mismatch or timeout.
   */
  params: Promise<URLSearchParams>;
  close(): void;
}

/**
 * Starts a one-shot HTTP server on an ephemeral 127.0.0.1 port to receive an OAuth redirect
 * (RFC 8252 loopback flow) at `path`. Start it before opening the browser.
 */
export async function listenForCallback(
  expectedState: string,
  {
    path = '/callback',
    provider = 'the provider',
    timeoutMs = 5 * 60_000,
    signal,
  }: { path?: string; provider?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<CallbackListener> {
  let resolve!: (params: URLSearchParams) => void;
  let reject!: (err: Error) => void;
  const params = new Promise<URLSearchParams>((res, rej) => ((resolve = res), (reject = rej)));

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== path) {
      res.writeHead(404).end();
      return;
    }
    const matched = url.searchParams.get('state') === expectedState;
    const ok = matched && !url.searchParams.get('error') && Boolean(url.searchParams.get('code'));
    res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' }).end(ok ? SUCCESS_HTML : FAILURE_HTML);
    // A redirect with the wrong state isn't ours to act on, not even its error.
    if (!matched) reject(new Error('OAuth state mismatch'));
    else resolve(url.searchParams);
  });

  await new Promise<void>((res, rej) => {
    server.once('error', rej);
    server.listen(0, '127.0.0.1', res);
  });

  const timer = setTimeout(() => reject(new RedirectAbandoned('timed-out', provider)), timeoutMs);
  const abort = () => reject(new RedirectAbandoned('cancelled', provider));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const close = () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    server.close();
    server.closeAllConnections();
  };
  params.then(close, close);

  const { port } = server.address() as AddressInfo;
  return { redirectUri: `http://127.0.0.1:${port}${path}`, params, close };
}

/** Google's redirect: resolves with just the authorization code. */
export async function listenForRedirect(
  expectedState: string,
  { timeoutMs = 5 * 60_000, signal }: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<LoopbackListener> {
  const listener = await listenForCallback(expectedState, { provider: 'Google', timeoutMs, signal });
  const code = listener.params.then((params) => {
    const error = params.get('error');
    if (error === 'access_denied') throw new RedirectAbandoned('cancelled', 'Google');
    if (error) throw new Error(`Google returned error: ${error}`);
    const authCode = params.get('code');
    if (!authCode) throw new Error('No authorization code in redirect');
    return authCode;
  });
  return { redirectUri: listener.redirectUri, code, close: listener.close };
}

/** Why a wait for a redirect ended without one. */
export class RedirectAbandoned extends Error {
  constructor(readonly reason: 'cancelled' | 'timed-out', provider: string) {
    super(reason === 'cancelled' ? `${provider} sign-in was cancelled` : `Timed out waiting for ${provider} sign-in`);
  }
}

// Supabase reports results in the query, and some errors only in the fragment, which browsers don't send:
// this page moves a fragment into the query and comes back. It runs only when the query is empty.
const HANDOFF_HTML = page(
  'Signing in',
  `<p data-vowe-handoff>Finishing sign-in…</p><script>location.replace(location.pathname + '?' + (location.hash.slice(1) || 'error=no_result'))</script>`,
);

/**
 * Receives an OAuth redirect that Supabase brokers (GitHub sign-in, identity linking) on a one-shot
 * 127.0.0.1 listener (RFC 8252). Supabase keeps its own `state` with the provider, so ours is the last
 * path segment of the redirect URI: anything else on the port is a 404, not an answer. Resolves with the
 * redirect's parameters (a `code`, or an `error`/`error_code`/`error_description`) for the caller to judge.
 */
export async function listenForAuthRedirect(
  state: string,
  { provider, timeoutMs = 5 * 60_000, signal }: { provider: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<CallbackListener> {
  let resolve!: (params: URLSearchParams) => void;
  let reject!: (err: Error) => void;
  const params = new Promise<URLSearchParams>((res, rej) => ((resolve = res), (reject = rej)));
  const path = `/auth/callback/${state}`;

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method !== 'GET' || url.pathname !== path) {
      res.writeHead(404).end();
      return;
    }
    if (!url.search) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(HANDOFF_HTML);
      return;
    }
    const ok = Boolean(url.searchParams.get('code')) && !url.searchParams.get('error');
    res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(ok ? SUCCESS_HTML : FAILURE_HTML);
    resolve(url.searchParams);
  });

  await new Promise<void>((res, rej) => {
    server.once('error', rej);
    server.listen(0, '127.0.0.1', res);
  });

  const timer = setTimeout(() => reject(new RedirectAbandoned('timed-out', provider)), timeoutMs);
  const abort = () => reject(new RedirectAbandoned('cancelled', provider));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const close = () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    server.close();
    server.closeAllConnections();
  };
  params.then(close, close);

  const { port } = server.address() as AddressInfo;
  return { redirectUri: `http://127.0.0.1:${port}${path}`, params, close };
}
