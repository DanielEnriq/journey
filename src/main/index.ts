import { app, BrowserWindow } from 'electron';
import { closeDb, getDb } from '../database/index.js';
import { restoreSession, signIn, signOut } from '../integrations/google/auth.js';
import { startCloudSync } from '../integrations/supabase/index.js';
import { disconnectAllRooms } from '../integrations/supabase/realtime.js';
import { applySettings, registerIpc } from './ipc.js';
import { createMainWindow } from './window.js';

app.on('window-all-closed', () => {
  // Rooms are joined from the UI; with no window left (macOS keeps running), stop appearing present.
  void disconnectAllRooms();
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (app.isReady() && BrowserWindow.getAllWindows().length === 0) createMainWindow();
});
app.on('will-quit', closeDb);

registerIpc();
startCloudSync(); // before restoreSession, so a restored user connects too

async function main() {
  await app.whenReady();
  getDb();
  applySettings();

  const user = await restoreSession();
  if (process.argv.includes('--sign-out')) {
    await signOut();
    console.log('[auth] signed out');
    app.quit();
    return;
  }

  createMainWindow();

  if (user) {
    console.log(`[auth] restored session for ${user.email}`);
  } else {
    console.log('[auth] no session; opening browser for Google sign-in…');
    // A cancelled or timed-out sign-in leaves the app running; the window offers a retry.
    signIn().then(
      (u) => console.log(`[auth] signed in as ${u.email}`),
      (err: Error) => console.warn('[auth] sign-in did not complete:', err.message),
    );
  }
}

main().catch((err) => {
  console.error(err);
  app.exit(1);
});
