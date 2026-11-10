import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, relative, resolve, sep } from 'node:path';
import type { SystemService } from '../service.js';

// The system canvas's dev server: the built renderer pages as static files (system.html at `/`), and
// the system service as JSON routes, `POST /api/<method>` with the arguments as a JSON array. Plain
// node:http, bound to 127.0.0.1 only. It reads the repositories it was given and nothing else, but a
// page on another site could still try to reach it, so the API only answers same-origin JSON requests
// addressed to a loopback host name (no form posts, no DNS rebinding).

/** Everything SystemApi has, plus the host-only calls the page uses. `recordTraces` and `addRepo` stay off HTTP's page surface unless enabled. */
const METHODS = ['repos', 'open', 'freshness', 'refresh', 'source', 'fixtures', 'fixture', 'views', 'saveView', 'traces', 'addInterpretation'] as const;
const DEV_METHODS = ['addRepo', 'recordTraces'] as const;

const MAX_BODY = 1024 * 1024;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.png': 'image/png', '.map': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

export interface SystemServerOptions {
  service: SystemService;
  /** The built renderer: dist/renderer. */
  staticDir: string;
  /** Allow `addRepo` and `recordTraces` over HTTP (the serve script turns this on; it's a local dev tool). */
  devMethods?: boolean;
  log?: (line: string) => void;
}

const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

function send(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const statusFor = (code: unknown) => code === 'not-found' || code === 'missing' ? 404 : code === 'outside' ? 403 : code === 'invalid' || code === 'too-large' ? 400 : 500;

export function createSystemServer(opts: SystemServerOptions): Server {
  const allowed = new Set<string>([...METHODS, ...(opts.devMethods ? DEV_METHODS : [])]);
  const log = opts.log ?? (() => {});
  const root = resolve(opts.staticDir);

  async function api(req: IncomingMessage, res: ServerResponse, method: string) {
    if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
    if (!allowed.has(method)) return send(res, 404, { error: `No such method: ${method}` });
    if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) return send(res, 415, { error: 'Send JSON (content-type: application/json)' });
    const origin = req.headers.origin;
    if (origin && !LOOPBACK.test(origin.replace(/^https?:\/\//, ''))) return send(res, 403, { error: 'Cross-origin requests are refused' });
    let args: unknown;
    try { args = JSON.parse((await readBody(req)) || '[]'); }
    catch (err) { return send(res, (err as { status?: number }).status ?? 400, { error: (err as { status?: number }).status ? (err as Error).message : 'Body must be a JSON array of arguments' }); }
    if (!Array.isArray(args) || args.length > 6) return send(res, 400, { error: 'Body must be a JSON array of arguments' });
    const t0 = Date.now();
    try {
      const fn = (opts.service as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method];
      const result = await fn(...args);
      log(`${method} ${Date.now() - t0}ms`);
      send(res, 200, { result: result ?? null });
    } catch (err) {
      const status = statusFor((err as { code?: unknown }).code);
      if (status === 500) log(`${method} failed: ${(err as Error).stack ?? err}`);
      send(res, status, { error: (err as Error).message ?? String(err) });
    }
  }

  async function file(req: IncomingMessage, res: ServerResponse, pathname: string) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    const rel = pathname === '/' ? 'system.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    if (rel.split(/[\\/]/).includes('..') || rel.includes('\0')) { res.writeHead(403); return res.end(); }
    try {
      const real = await realpath(join(root, rel));
      const inside = relative(await realpath(root), real);
      if (inside.startsWith('..' + sep) || inside === '..') { res.writeHead(403); return res.end(); }
      const s = await stat(real);
      if (!s.isFile()) throw new Error('not a file');
      res.writeHead(200, { 'content-type': TYPES[extname(real)] ?? 'application/octet-stream', 'content-length': s.size, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
      if (req.method === 'HEAD') return res.end();
      createReadStream(real).pipe(res);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`Not found: ${pathname}`);
    }
  }

  return createServer((req, res) => {
    if (!LOOPBACK.test(req.headers.host ?? '')) { res.writeHead(421); return res.end('Use 127.0.0.1'); }
    const { pathname } = new URL(req.url ?? '/', 'http://127.0.0.1');
    const route = /^\/api\/([A-Za-z]+)$/.exec(pathname);
    const done = route ? api(req, res, route[1]) : file(req, res, pathname);
    done.catch((err) => { log(`request failed: ${err}`); if (!res.headersSent) send(res, 500, { error: 'Internal error' }); else res.end(); });
  });
}

/** Starts the server on 127.0.0.1; resolves with the port it listens on (0 picks a free one). */
export function listen(server: Server, port: number, host = '127.0.0.1'): Promise<number> {
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => {
      server.off('error', fail);
      const addr = server.address();
      ok(typeof addr === 'object' && addr ? addr.port : port);
    });
  });
}
