// pnpm test:calls — the end-to-end call test. Starts a throwaway LiveKit server in Docker (dev keys,
// localhost only), runs main.mjs in Electron, and removes the server afterwards. Needs Docker running
// and `pnpm build && pnpm api:build` done (the package script does both).
//
// LIVEKIT_E2E_URL=ws://… with LIVEKIT_API_KEY/LIVEKIT_API_SECRET runs it against another server instead.
import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';

const IMAGE = 'livekit/livekit-server:v1.9.1';
const NAME = 'vowe-livekit-e2e';
const external = process.env.LIVEKIT_E2E_URL;

function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function waitForServer(url) {
  const http = url.replace(/^ws/, 'http');
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(http)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`LiveKit didn't come up at ${http}`);
}

const env = { ...process.env };
if (external) {
  env.LIVEKIT_URL = external;
} else {
  try {
    docker('rm', '-f', NAME);
  } catch {}
  // --dev: keys devkey/secret. Media on one UDP port plus TCP fallback, advertised as localhost.
  docker('run', '-d', '--rm', '--name', NAME, '-p', '127.0.0.1:7880:7880', '-p', '127.0.0.1:7881:7881', '-p', '127.0.0.1:7882:7882/udp',
    IMAGE, '--dev', '--bind', '0.0.0.0', '--node-ip', '127.0.0.1');
  Object.assign(env, { LIVEKIT_URL: 'ws://127.0.0.1:7880', LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'secret' });
}

let code = 1;
try {
  await waitForServer(env.LIVEKIT_URL);
  const electron = join('node_modules', '.bin', 'electron');
  code = await new Promise((resolve) => {
    spawn(electron, [join(import.meta.dirname, 'main.mjs')], { env, stdio: 'inherit' }).on('exit', (c) => resolve(c ?? 1));
  });
} finally {
  if (!external) {
    try {
      docker('rm', '-f', NAME);
    } catch {}
  }
}
process.exit(code);
