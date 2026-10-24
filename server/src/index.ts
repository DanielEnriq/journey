// Vowe cloud API: the server-side half of integrations whose secrets must not ship with the desktop app.
// Electron, SQLite, Git and coding agents stay local; Supabase stays the auth, Postgres and Realtime backend.
//
//   GET  /health                → 200 { status: 'ok', livekit, elevenlabs }   which integrations are configured
//   POST /livekit/token         { roomId } → 200 { url, token }               see livekit.ts
//   POST /elevenlabs/signed-url            → 200 { signedUrl }                see elevenlabs.ts
//   POST /vowe/token, /vowe/speech-token, /vowe/speech                         see vowe-voice.ts
//
// Authenticated routes take the caller's Supabase session as `Authorization: Bearer <jwt>`.
// Binds 0.0.0.0:$PORT (App Platform sets PORT; 8080 locally).

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isElevenLabsConfigured, signedUrl } from './elevenlabs.js';
import { HttpError, authenticate } from './http.js';
import { isLiveKitConfigured, issueToken } from './livekit.js';
import { issueSpeechToken, issueVoweToken, speak } from './vowe-voice.js';

type Handler = (req: IncomingMessage) => Promise<object>;

const routes: Record<string, Handler> = {
  'GET /health': async () => ({ status: 'ok', livekit: isLiveKitConfigured(), elevenlabs: isElevenLabsConfigured() }),
  'POST /livekit/token': async (req) => issueToken(await authenticate(req), await readJson(req)),
  'POST /elevenlabs/signed-url': async (req) => {
    await authenticate(req);
    return { signedUrl: await signedUrl() };
  },
  'POST /vowe/token': async (req) => issueVoweToken(await authenticate(req), await readJson(req)),
  'POST /vowe/speech-token': async (req) => issueSpeechToken(await authenticate(req), await readJson(req)),
};

/** Routes that answer with a stream rather than JSON. */
const streams: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> = {
  'POST /vowe/speech': async (req, res) => speak(await authenticate(req), await readJson(req), res),
};

const MAX_BODY = 16 * 1024;

async function readJson(req: IncomingMessage): Promise<unknown> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) throw new HttpError(413, 'Body too large');
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new HttpError(400, 'Body must be JSON');
  }
}

function reply(res: ServerResponse, status: number, body: object) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  const handler = routes[`${req.method} ${path}`];
  const stream = streams[`${req.method} ${path}`];
  if (!handler && !stream) return reply(res, 404, { error: 'Not found' });
  try {
    if (stream) return await stream(req, res);
    reply(res, 200, await handler(req));
  } catch (err) {
    if (res.headersSent) return void res.destroy();
    if (err instanceof HttpError) return reply(res, err.status, { error: err.message });
    console.error(`[api] ${req.method} ${path} failed:`, err);
    reply(res, 500, { error: 'Internal error' });
  }
});

const port = Number(process.env.PORT ?? 8080);
server.listen(port, '0.0.0.0', () => console.log(`[api] listening on 0.0.0.0:${port}`));

// App Platform sends SIGTERM on redeploy; finish in-flight requests, then exit.
process.on('SIGTERM', () => server.close(() => process.exit(0)));
