// Starts a throwaway LiveKit server and runs electron-check.mjs in Electron's main process.
import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';

const NAME = 'vowe-voice-electron-check';
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
try {
  docker('rm', '-f', NAME);
} catch {}
const config = 'port: 7990\nrtc:\n  tcp_port: 7991\n  udp_port: 7992\n  use_external_ip: false\nkeys:\n  devkey: secret\n';
docker('run', '-d', '--rm', '--name', NAME, '-p', '127.0.0.1:7990:7990', '-p', '127.0.0.1:7991:7991', '-p', '127.0.0.1:7992:7992/udp',
  'livekit/livekit-server:v1.9.1', '--dev', '--bind', '0.0.0.0', '--node-ip', '127.0.0.1', '--config-body', config);
let code = 1;
try {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch('http://127.0.0.1:7990')).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  const env = { ...process.env, LIVEKIT_URL: 'ws://127.0.0.1:7990', LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'secret' };
  code = await new Promise((resolve) =>
    spawn(join('node_modules', '.bin', 'electron'), [join(import.meta.dirname, 'electron-check.mjs')], { env, stdio: 'inherit' }).on('exit', (c) => resolve(c ?? 1)),
  );
} finally {
  try {
    docker('rm', '-f', NAME);
  } catch {}
}
process.exit(code);
