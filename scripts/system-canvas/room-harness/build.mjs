// Puts the room harness into a built renderer: the stub beside the pages, and room-harness.html, which is
// vowe.html with the stub loaded first. Run after scripts/system-canvas/build.mjs --out <dir>.
//
//   node scripts/system-canvas/room-harness/build.mjs --out <dir>
import fs from 'node:fs';
import path from 'node:path';

const i = process.argv.indexOf('--out');
if (i < 0) throw new Error('Usage: build.mjs --out <dir that build.mjs built>');
const renderer = path.join(path.resolve(process.argv[i + 1]), 'renderer');
const here = import.meta.dirname;
fs.mkdirSync(path.join(renderer, 'room-harness'), { recursive: true });
fs.copyFileSync(path.join(here, 'stub.js'), path.join(renderer, 'room-harness', 'stub.js'));
const page = fs.readFileSync(path.join(renderer, 'vowe.html'), 'utf8')
  .replace('<script type="module" src="app.js"></script>', '<script type="module" src="room-harness/stub.js"></script>\n    <script type="module" src="app.js"></script>');
if (!page.includes('room-harness/stub.js')) throw new Error('vowe.html no longer loads app.js the way this expects');
fs.writeFileSync(path.join(renderer, 'room-harness.html'), page);
console.log(`[room-harness] ${path.join(renderer, 'room-harness.html')}`);
