// Checks the speech providers on their own, against the real ElevenLabs API: speaks a question with
// text-to-speech, streams it into Scribe realtime at real-time pace, and prints what was recognized.
// Needs ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID in .env. Run: pnpm build && node scripts/voice-e2e/speech-smoke.mjs
import { ElevenLabsRecognizer, ElevenLabsSynthesizer, agentVoice } from '../../dist/voice/providers/elevenlabs.js';


process.loadEnvFile(new URL('../../.env', import.meta.url));
const apiKey = process.env.ELEVENLABS_API_KEY;
const voice = await agentVoice(apiKey, process.env.ELEVENLABS_AGENT_ID);
const access = { kind: 'key', apiKey, ...voice };
const question = process.argv[2] ?? 'Vowe, what happens if this crashes after charging?';

let t = Date.now();
const chunks = [];
let firstChunkMs = null;
for await (const c of new ElevenLabsSynthesizer(access).synthesize(question, 16000, new AbortController().signal)) {
  firstChunkMs ??= Date.now() - t;
  chunks.push(c);
}
const samples = chunks.reduce((n, c) => n + c.length, 0);
console.log(`[tts] ${voice.voiceId} ${voice.model}: first audio after ${firstChunkMs} ms, ${(samples / 16000).toFixed(2)} s of speech`);

const events = [];
t = Date.now();
const stream = await new ElevenLabsRecognizer(access).open(16000, (e) => {
  events.push(e);
  console.log(`[stt +${Date.now() - t}ms] ${e.type}${'text' in e ? `: ${e.text}` : 'message' in e ? `: ${e.message}` : ''}`);
});
const all = new Int16Array(samples);
let o = 0;
for (const c of chunks) (all.set(c, o), (o += c.length));
const silence = new Int16Array(16000 * 1.5);
for (const buf of [all, silence]) {
  for (let i = 0; i < buf.length; i += 320) {
    stream.send(buf.subarray(i, i + 320));
    await new Promise((r) => setTimeout(r, 20));
  }
}
await new Promise((r) => setTimeout(r, 1500));
stream.close();
const final = events.filter((e) => e.type === 'final' && e.text).map((e) => e.text).join(' ');
console.log(`[result] ${final ? `recognized: "${final}"` : 'NOTHING RECOGNIZED'}`);
process.exit(final ? 0 : 1);
