import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const SUCCESS_HTML = `<!doctype html><meta charset="utf-8"><title>Signed in</title>
<body style="font-family:system-ui;padding:3rem">You're signed in. You can close this tab and return to Journey.</body>`;
const FAILURE_HTML = `<!doctype html><meta charset="utf-8"><title>Sign-in failed</title>
<body style="font-family:system-ui;padding:3rem">Sign-in failed. You can close this tab and try again.</body>`;

export interface LoopbackListener {
  redirectUri: string;
  /** Resolves with the authorization code once Google redirects back. */
  code: Promise<string>;
  close(): void;
}

/**
 * Starts a one-shot HTTP server on an ephemeral 127.0.0.1 port to receive the
 * OAuth redirect (RFC 8252 loopback flow).
 */
export async function listenForRedirect(expectedState: string, timeoutMs = 5 * 60_000): Promise<LoopbackListener> {
  let resolve!: (code: string) => void;
  let reject!: (err: Error) => void;
  const code = new Promise<string>((res, rej) => ((resolve = res), (reject = rej)));

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get('error');
    const authCode = url.searchParams.get('code');
    const state = url.searchParams.get('state');

    const ok = !error && authCode && state === expectedState;
    res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' }).end(ok ? SUCCESS_HTML : FAILURE_HTML);

    if (error) reject(new Error(`Google returned error: ${error}`));
    else if (state !== expectedState) reject(new Error('OAuth state mismatch'));
    else if (!authCode) reject(new Error('No authorization code in redirect'));
    else resolve(authCode);
  });

  await new Promise<void>((res, rej) => {
    server.once('error', rej);
    server.listen(0, '127.0.0.1', res);
  });

  const timer = setTimeout(() => reject(new Error('Timed out waiting for Google sign-in')), timeoutMs);
  const close = () => {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  };
  code.then(close, close);

  const { port } = server.address() as AddressInfo;
  return { redirectUri: `http://127.0.0.1:${port}/callback`, code, close };
}
