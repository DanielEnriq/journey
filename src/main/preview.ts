import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { createMainWindow } from './window.js';

// A development-only way to look at the UI without credentials: `pnpm preview:ui`. It opens the same
// window and pages as the app, but registers no IPC, restores no session, opens no database and
// reaches no service; the page has no preload, so it runs on its mock data alone. It keeps its own
// profile, apart from the app's. It refuses to run from a packaged build.

if (app.isPackaged) {
  console.error('[preview] the UI preview is for development only');
  app.exit(1);
}

app.setName('Vowe UI Preview');
app.setPath('userData', join(app.getPath('appData'), 'Vowe UI Preview'));

app.on('window-all-closed', () => app.quit());

app.whenReady().then(() => {
  console.log('[preview] UI preview: mock data only, no sign-in, no services');
  createMainWindow({ preview: true });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow({ preview: true }); });
});
