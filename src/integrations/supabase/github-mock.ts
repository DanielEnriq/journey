import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';

// Test support for GitHub sign-in against a local Supabase stack: a stand-in for github.com that
// Supabase's GitHub provider talks to, and a "browser" that follows the redirects a person would.
// Supabase reaches it through `[auth.external.github] url`, the setting GitHub Enterprise uses: it
// sends people to <url>/login/oauth/authorize and calls <url>/api/v3/user and /user/emails.

export interface GitHubAccount {
  id: number;
  login: string;
  name?: string;
  emails: { email: string; verified: boolean; primary: boolean }[];
}

export interface MockGitHub {
  /** Who is signed in to GitHub in the browser, and whether they approve the next authorization. */
  as(account: GitHubAccount, options?: { deny?: boolean }): void;
  /** The scopes each authorization asked GitHub for, oldest first. */
  readonly authorizations: string[][];
  close(): Promise<void>;
}

export async function startMockGitHub(port: number, host = '127.0.0.1'): Promise<MockGitHub> {
  let current: { account: GitHubAccount; deny: boolean } | undefined;
  const codes = new Map<string, GitHubAccount>();
  const tokens = new Map<string, GitHubAccount>();
  const authorizations: string[][] = [];

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://github.mock');
    const json = (status: number, body: unknown) =>
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));

    if (req.method === 'GET' && url.pathname === '/login/oauth/authorize') {
      authorizations.push((url.searchParams.get('scope') ?? '').split(/[\s,]+/).filter(Boolean));
      const back = new URL(url.searchParams.get('redirect_uri') ?? '');
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      if (!current || current.deny) {
        back.searchParams.set('error', 'access_denied');
        back.searchParams.set('error_description', 'The user has denied your application access.');
      } else {
        const code = randomBytes(10).toString('hex');
        codes.set(code, current.account);
        back.searchParams.set('code', code);
      }
      res.writeHead(302, { Location: back.toString() }).end();
      return;
    }

    if (req.method === 'POST' && url.pathname === '/login/oauth/access_token') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const code = new URLSearchParams(body).get('code') ?? '';
        const account = codes.get(code);
        codes.delete(code); // single use, like GitHub's
        if (!account) return json(200, { error: 'bad_verification_code' });
        const token = `gho_${randomBytes(12).toString('hex')}`;
        tokens.set(token, account);
        json(200, { access_token: token, token_type: 'bearer', scope: 'user:email' });
      });
      return;
    }

    const account = tokens.get((req.headers.authorization ?? '').replace(/^(token|bearer)\s+/i, ''));
    const path = url.pathname.replace(/^\/api\/v3/, '');
    if (path === '/user' || path === '/user/emails') {
      if (!account) return json(401, { message: 'Bad credentials' });
      if (path === '/user/emails') return json(200, account.emails.map((e) => ({ ...e, visibility: null })));
      const primary = account.emails.find((e) => e.primary && e.verified);
      return json(200, {
        id: account.id,
        login: account.login,
        name: account.name ?? null,
        avatar_url: `https://avatars.example/${account.id}`,
        email: primary?.email ?? null,
      });
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  return {
    as: (account, { deny = false } = {}) => (current = { account, deny }),
    authorizations,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Opens `url` the way a browser would: follows redirects, keeping a fragment off the request, and runs
 * the loopback's fragment hand-off page. Supabase's container reaches the mock as host.docker.internal;
 * here that's this machine. Resolves once a request answers without redirecting.
 */
export async function browse(url: string): Promise<{ url: string; status: number }> {
  let next = new URL(url);
  for (let hops = 0; hops < 20; hops++) {
    if (next.hostname === 'host.docker.internal') next.hostname = '127.0.0.1';
    const fragment = next.hash.slice(1);
    next.hash = '';
    // Somewhere nothing answers (Supabase's fallback site URL, say): where the browser ended up.
    const res = await fetch(next, { redirect: 'manual' }).catch(() => undefined);
    if (!res) return { url: next.toString(), status: 0 };
    const html = res.status === 200 ? await res.text() : '';
    const location = res.headers.get('location');
    if (location) {
      next = new URL(location, next);
      continue;
    }
    // The loopback's hand-off page moves a fragment into the query, as its script does in a real browser.
    if (fragment && html.includes('data-vowe-handoff')) {
      next = new URL(next);
      next.search = fragment;
      continue;
    }
    return { url: next.toString(), status: res.status };
  }
  throw new Error('Too many redirects');
}
