// Builds Journey into another directory than dist/ (tsc's output plus the renderer's pages, styles,
// fonts and vendored preact), so the system canvas can be served and tested while dist/ is someone
// else's. The renderer assets come from the repo's own scripts/copy-renderer-assets.mjs, run from a
// scratch directory whose src/ and node_modules/ link back to the repo, so nothing is copied twice by hand.
//
//   node scripts/system-canvas/build.mjs --out /tmp/vowe-dist      # then serve.mjs --dist /tmp/vowe-dist
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..', '..');
const i = process.argv.indexOf('--out');
const out = path.resolve(i >= 0 ? process.argv[i + 1] : path.join(repo, '.system-dist'));
if (out === path.join(repo, 'dist')) throw new Error('Use pnpm build for dist/');

// tsc reports type errors but still emits; a half-edited file elsewhere in the tree shouldn't stop a serve.
try { execFileSync(path.join(repo, 'node_modules', '.bin', 'tsc'), ['-p', repo, '--outDir', out], { stdio: 'inherit' }); }
catch { console.warn('[system] tsc reported errors (output was still emitted)'); }

const stage = fs.mkdtempSync(path.join(path.dirname(out), '.system-assets-'));
try {
  fs.symlinkSync(path.join(repo, 'src'), path.join(stage, 'src'));
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(stage, 'node_modules'));
  fs.symlinkSync(out, path.join(stage, 'dist'));
  execFileSync(process.execPath, [path.join(repo, 'scripts', 'copy-renderer-assets.mjs')], { cwd: stage, stdio: 'inherit' });
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
console.log(`[system] built into ${out}`);
