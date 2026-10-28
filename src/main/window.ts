import { BrowserWindow, session, shell } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const RENDERER_DIR = join(import.meta.dirname, '..', 'renderer');
/** vowe.html is the app; index.html is the earlier setup screen, reachable from its developer menu. */
const RENDERER_URLS = new Set(['vowe.html', 'index.html'].map((page) => pathToFileURL(join(RENDERER_DIR, page)).href));

/** True only for our own bundled pages; IPC handlers use this to reject other senders. */
export function isAppPage(url: string): boolean {
  return RENDERER_URLS.has(url.split(/[?#]/)[0]);
}

/**
 * Electron grants every permission by default. Allow only what the app needs, and only to our own
 * page: the microphone for calls, and writing to the clipboard for its Copy buttons. Camera, screen
 * capture, reading the clipboard, notifications, etc. are refused. The OS has its own microphone
 * prompt on top of this (calls:requestMicrophone).
 */
export function restrictPermissions() {
  const { defaultSession } = session;
  defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const audioOnly =
      permission === 'media' &&
      'mediaTypes' in details &&
      details.mediaTypes?.length &&
      details.mediaTypes.every((type) => type === 'audio');
    const copy = permission === 'clipboard-sanitized-write';
    callback((Boolean(audioOnly) || copy) && isAppPage(details.requestingUrl));
  });
  // Synchronous checks (e.g. enumerateDevices labels, permissions.query) follow the same rule.
  defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
    return permission === 'media' && details.mediaType !== 'video' && isAppPage(details.requestingUrl ?? requestingOrigin);
  });
}

export interface WindowOptions {
  /**
   * The development preview: no preload, so the page has no bridge to the main process, auth or any
   * service, and runs on its mock data alone.
   */
  preview?: boolean;
}

export function createMainWindow({ preview = false }: WindowOptions = {}): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 680,
    title: 'Vowe',
    // The room draws its own 40px band; on macOS the real traffic lights sit where the design puts them.
    // The sidebar is a little translucent: the window is clear behind it and macOS's sidebar material shows through.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 18, y: 14 }, vibrancy: 'sidebar' as const, backgroundColor: '#00000000' } : {}),
    webPreferences: {
      // CommonJS: sandboxed preloads can't be ES modules.
      ...(preview ? {} : { preload: join(import.meta.dirname, '..', 'preload', 'index.cjs') }),
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

  // The top bars leave room for the traffic lights, which macOS hides in full screen.
  const fullScreen = () => win.webContents.send('window:fullScreen', win.isFullScreen());
  win.on('enter-full-screen', fullScreen);
  win.on('leave-full-screen', fullScreen);
  win.webContents.on('did-finish-load', fullScreen);

  win.loadFile(join(RENDERER_DIR, 'vowe.html'));
  return win;
}
