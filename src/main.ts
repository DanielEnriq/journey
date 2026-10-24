import { app, ipcMain } from 'electron';
import { getCurrentUser, restoreSession, signIn, signOut } from './auth/google.js';
import { closeDb, getDb } from './db.js';

// Headless for now: no BrowserWindow. Keep the process alive without windows.
app.on('window-all-closed', () => {});
app.on('will-quit', closeDb);

// IPC surface for a future renderer.
ipcMain.handle('auth:getUser', () => getCurrentUser() ?? null);
ipcMain.handle('auth:signIn', () => signIn());
ipcMain.handle('auth:signOut', () => signOut());

async function main() {
  await app.whenReady();
  app.dock?.hide();
  getDb();

  let user = await restoreSession();
  if (process.argv.includes('--sign-out')) {
    await signOut();
    console.log('[auth] signed out');
    app.quit();
    return;
  }

  if (user) {
    console.log(`[auth] restored session for ${user.email}`);
  } else {
    console.log('[auth] no session; opening browser for Google sign-in…');
    user = await signIn();
    console.log(`[auth] signed in as ${user.email}`);
  }
}

main().catch((err) => {
  console.error(err);
  app.exit(1);
});
