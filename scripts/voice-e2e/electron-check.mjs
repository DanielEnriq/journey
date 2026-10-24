// Vowe's voice runs in Electron's main process, so its LiveKit native module must load there, not only
// in Node. Joins a throwaway LiveKit server (started by the caller) as Vowe through the real transport,
// publishes its microphone track, and leaves. Run via: node scripts/voice-e2e/electron-check-run.mjs
import { app } from 'electron';
import { voweToken } from '../../server/dist/vowe-voice.js';
import { LiveKitTransport } from '../../dist/voice/livekit.js';

app.whenReady().then(async () => {
  let ok = false;
  try {
    const url = process.env.LIVEKIT_URL;
    const transport = new LiveKitTransport(async () => ({ url, token: await voweToken('0b7c6c4e-55d2-4d0f-9f53-0d0b8a3ef0a1', 'u-check').toJwt() }));
    await transport.connect(() => {});
    await transport.play(new Int16Array(2400));
    await transport.setAttributes({ 'vowe.state': 'listening' });
    await transport.disconnect();
    ok = true;
    console.log(`[electron ${process.versions.electron}] Vowe joined, published its microphone, and left`);
  } catch (err) {
    console.error('[electron] failed:', err);
  }
  app.exit(ok ? 0 : 1);
});
