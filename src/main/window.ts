import { BrowserWindow, session, shell } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const RENDERER_DIR = join(import.meta.dirname, '..', 'renderer');
const RENDERER_URL = pathToFileURL(join(RENDERER_DIR, 'index.html')).href;

/** True only for our own bundled page; IPC handlers use this to reject other senders. */
export function isAppPage(url: string): boolean {
  return url.split(/[?#]/)[0] === RENDERER_URL;
}

/**
 * Electron grants every permission by default. Allow only what calls need, the microphone, and
 * only to our own page; camera, screen capture, notifications, etc. are refused. The OS has its
 * own microphone prompt on top of this (calls:requestMicrophone).
 */
export function restrictPermissions() {
  const { defaultSession } = session;
  defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const audioOnly =
      permission === 'media' &&
      'mediaTypes' in details &&
      details.mediaTypes?.length &&
      details.mediaTypes.every((type) => type === 'audio');
    callback(Boolean(audioOnly) && isAppPage(details.requestingUrl));
  });
  // Synchronous checks (e.g. enumerateDevices labels, permissions.query) follow the same rule.
  defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
    return permission === 'media' && details.mediaType !== 'video' && isAppPage(details.requestingUrl ?? requestingOrigin);
  });
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
