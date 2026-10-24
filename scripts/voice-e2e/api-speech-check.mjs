// The Vowe API's speech proxy (server/src/vowe-voice.ts), the path the app uses when VOWE_API_URL is set:
// serves the real speak() handler on a local port, with a caller RLS would show as a member of the room
// (the Supabase session check is the only thing stubbed), and speaks through it with the app's
// 'api' access. Needs ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID in .env.
import { createServer } from 'node:http';
import { speak } from '../../server/dist/vowe-voice.js';
import { ElevenLabsSynthesizer } from '../../dist/voice/providers/elevenlabs.js';

process.loadEnvFile(new URL('../../.env', import.meta.url));
const ROOM = '0b7c6c4e-55d2-4d0f-9f53-0d0b8a3ef0a1';
const member = { userId: 'u-1', supabase: { from: () => { const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { role: 'member' }, error: null }) }; return q; } } };

const server = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  try {
    await speak(member, JSON.parse(body), res);
  } catch (err) {
    if (!res.headersSent) res.writeHead(err.status ?? 500).end(err.message);
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const synth = new ElevenLabsSynthesizer({
  kind: 'api',
  recognitionToken: async () => '',
  speak: (text, sampleRate, signal) => fetch(`${base}/vowe/speech`, { method: 'POST', body: JSON.stringify({ roomId: ROOM, text, sampleRate }), signal }),
});

let samples = 0;
const t = Date.now();
let first = null;
for await (const c of synth.synthesize('If the worker crashes after charging, the retry charges twice.', 24000, new AbortController().signal)) {
  first ??= Date.now() - t;
  samples += c.length;
}
console.log(`[api speech] ${(samples / 24000).toFixed(2)} s of 24 kHz speech through the proxy; first audio after ${first} ms`);

// Interrupting mid-sentence closes the proxy's upstream request too.
const abort = new AbortController();
let got = 0;
for await (const c of synth.synthesize('This is a much longer sentence that Vowe will not get to finish, because someone is about to talk over it.', 24000, abort.signal)) {
  got += c.length;
  if (got > 2400) abort.abort();
}
console.log(`[api speech] aborted after ${(got / 24000).toFixed(2)} s, as asked`);
const tooLong = await fetch(`${base}/vowe/speech`, { method: 'POST', body: JSON.stringify({ roomId: ROOM, text: 'x'.repeat(1001), sampleRate: 24000 }) });
console.log(`[api speech] over-long text → ${tooLong.status}`);
server.close();
process.exit(samples > 24000 && got < 24000 * 3 && tooLong.status === 400 ? 0 : 1);
