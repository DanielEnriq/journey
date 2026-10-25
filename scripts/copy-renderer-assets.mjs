// The renderer has no bundler: tsc emits its modules, and this copies everything else it loads into
// dist/renderer — pages, stylesheets, fonts, and the vendored ESM libraries.
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'src/renderer';
const OUT = 'dist/renderer';

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to);
}

// Pages, stylesheets and fonts keep their place under src/renderer.
for (const entry of fs.readdirSync(SRC, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !/\.(html|css|woff2)$/.test(entry.name)) continue;
  const rel = path.relative(SRC, path.join(entry.parentPath, entry.name));
  copy(path.join(SRC, rel), path.join(OUT, rel));
}

const fontsource = 'node_modules/@fontsource/jetbrains-mono/files';
for (const weight of [400, 500]) {
  copy(`${fontsource}/jetbrains-mono-latin-${weight}-normal.woff2`, `${OUT}/fonts/jetbrains-mono-${weight}.woff2`);
}

// Development builds against a local LiveKit server (livekit-server --dev) may also reach it; release builds
// never do: VOWE_LOCAL_LIVEKIT=1 pnpm build.
if (process.env.VOWE_LOCAL_LIVEKIT === '1') {
  const page = `${OUT}/vowe.html`;
  const html = fs.readFileSync(page, 'utf8');
  const local = html.replace("wss://*.livekit.cloud", "wss://*.livekit.cloud ws://127.0.0.1:7880 http://127.0.0.1:7880");
  if (local === html) throw new Error('vowe.html no longer allows LiveKit Cloud the expected way');
  fs.writeFileSync(page, local);
}

copy('node_modules/livekit-client/dist/livekit-client.esm.mjs', `${OUT}/vendor/livekit-client.js`);
copy('node_modules/preact/dist/preact.module.js', `${OUT}/vendor/preact.js`);

// preact/hooks imports "preact" by bare name, which a page can't resolve without an import map.
const hooks = fs.readFileSync('node_modules/preact/hooks/dist/hooks.module.js', 'utf8');
const relinked = hooks.replace(/from\s*"preact"/g, 'from"./preact.js"');
if (relinked === hooks || /from\s*"preact"/.test(relinked)) throw new Error('preact/hooks no longer imports "preact" the expected way');
fs.writeFileSync(`${OUT}/vendor/preact-hooks.js`, relinked);
