// The system canvas's dev server: the built renderer (/ opens /renderer/system.html) and the system service as JSON
// routes (POST /api/<method>, JSON array of arguments). Runs the build in dist/ by default:
//
//   pnpm build && node scripts/system-canvas/serve.mjs            # http://127.0.0.1:4870
//   PORT=4999 node scripts/system-canvas/serve.mjs --dist <outDir> [--repo <path>]...
//
// --dist (or VOWE_SYSTEM_DIST) points at another tsc outDir with renderer assets copied in; the service's
// cache, saved views and traces live under VOWE_SYSTEM_HOME (default ~/.vowe/system).
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const all = (name) => args.flatMap((a, i) => a === name && args[i + 1] ? [args[i + 1]] : []);

const dist = path.resolve(flag('--dist') ?? process.env.VOWE_SYSTEM_DIST ?? 'dist');
const port = Number(process.env.PORT ?? 4870);
const repos = all('--repo').map((r) => path.resolve(r));

const { createSystemService, journeyRoot } = await import(pathToFileURL(path.join(dist, 'system', 'service.js')).href);
const { createSystemServer, listen } = await import(pathToFileURL(path.join(dist, 'system', 'server', 'index.js')).href);

const service = createSystemService({ repos: repos.length ? repos : [journeyRoot()] });
const server = createSystemServer({
  service,
  distDir: dist,
  devMethods: true,
  log: (line) => console.log(`[system] ${line}`),
});
const actual = await listen(server, port);
console.log(`[system] serving ${dist} (renderer/, shared/) and the system API at http://127.0.0.1:${actual}/ (→ /renderer/system.html)`);
for (const r of await service.repos()) console.log(`[system] repository ${r.id}: ${r.root}`);
