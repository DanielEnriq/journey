// Development only: names Electron's own app bundle Vowe, so the menu bar's bold title says Vowe rather than
// Electron when running `pnpm start`. A packaged build gets its name from its own bundle instead. It changes
// CFBundleName and CFBundleDisplayName in node_modules' Electron.app and nothing else; run again after
// reinstalling Electron. Not macOS: nothing to do.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const NAME = 'Vowe';
if (process.platform === 'darwin') {
  const exe = createRequire(import.meta.url)('electron'); // …/Electron.app/Contents/MacOS/Electron
  const plist = join(dirname(dirname(exe)), 'Info.plist');
  if (!existsSync(plist)) {
    console.warn(`[name-dev-app] no Info.plist at ${plist}; left as it is`);
  } else {
    const read = (key) => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { encoding: 'utf8' }).trim();
    if (read('CFBundleName') !== NAME || read('CFBundleDisplayName') !== NAME) {
      for (const key of ['CFBundleName', 'CFBundleDisplayName']) execFileSync('/usr/bin/plutil', ['-replace', key, '-string', NAME, plist]);
      console.log(`[name-dev-app] Electron.app is named ${NAME} in the menu bar`);
    }
  }
}
