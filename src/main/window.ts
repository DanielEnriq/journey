import { BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const RENDERER_DIR = join(import.meta.dirname, '..', 'renderer');
const RENDERER_URL = pathToFileURL(join(RENDERER_DIR, 'index.html')).href;

/** True only for our own bundled page; IPC handlers use this to reject other senders. */
export function isAppPage(url: string): boolean {
  return url.split(/[?#]/)[0] === RENDERER_URL;
}

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Journey',
    webPreferences: {
      // CommonJS: sandboxed preloads can't be ES modules.
      preload: join(import.meta.dirname, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  // The window only ever shows our page; external links go to the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAppPage(url)) event.preventDefault();
  });

  win.loadFile(join(RENDERER_DIR, 'index.html'));
  return win;
}
