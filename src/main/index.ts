import { app, BrowserWindow } from 'electron';
import { startClaudeCodeObserver, stopClaudeCodeObserver } from '../agents/claude-code-hooks.js';
import { startTranscriptWatcher, stopTranscriptWatcher } from '../agents/claude-code-watcher.js';
import { closeDb, getDb } from '../database/index.js';
import { isCloudConfigured } from '../integrations/supabase/index.js';
import { restoreSession, signIn, signOut, startAccount } from '../integrations/account/index.js';
import { disconnectAllRooms } from '../integrations/supabase/realtime.js';
import { getVoiceAgentProvider } from '../integrations/voice/index.js';
import { applySettings, registerIpc, voice } from './ipc.js';
import { createMainWindow, restrictPermissions } from './window.js';

app.on('window-all-closed', () => {
  // Rooms are joined from the UI; with no window left (macOS keeps running), stop appearing present.
  void disconnectAllRooms();
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (app.isReady() && BrowserWindow.getAllWindows().length === 0) createMainWindow();
});
app.on('will-quit', () => {
  void voice.stop(); // leaves any call Vowe is in; LiveKit drops it anyway when the process exits
  stopClaudeCodeObserver();
  stopTranscriptWatcher();
  closeDb();
});

registerIpc();
startAccount(); // before restoreSession, so a restored user connects too

async function main() {
  await app.whenReady();
  getDb();
  applySettings();
  startClaudeCodeObserver(); // reads hook events, including any that arrived while the app was closed
  startTranscriptWatcher(); // follows Claude Code transcripts, from where it left off
  restrictPermissions();

  const user = await restoreSession();
  if (process.argv.includes('--sign-out')) {
    await signOut();
    console.log('[auth] signed out');
    app.quit();
    return;
  }

  createMainWindow();
  checkVoiceAgent();

  if (user) {
    console.log(`[auth] restored session for ${user.email}`);
  } else {
    // The window offers Continue with Google or GitHub. Where Google is the only way in (no cloud), open
    // its sign-in right away, as before; a cancelled or timed-out one leaves the app running for a retry.
    if (isCloudConfigured()) {
      console.log('[auth] no session; waiting for sign-in in the window');
      return;
    }
    console.log('[auth] no session; opening browser for Google sign-in…');
    signIn('google').then(
      (u) => console.log(`[auth] signed in as ${u.email}`),
      (err: Error) => console.warn('[auth] sign-in did not complete:', err.message),
    );
  }
}

/** No conversation runs yet; this only surfaces bad credentials early instead of on the first call. */
function checkVoiceAgent() {
  const provider = getVoiceAgentProvider();
  if (!provider) return;
  provider.verify().then(
    () => console.log(`[voice] ${provider.name} agent ready`),
    (err: Error) => console.warn(`[voice] ${provider.name} check failed:`, err.message),
  );
}

main().catch((err) => {
  console.error(err);
  app.exit(1);
});
