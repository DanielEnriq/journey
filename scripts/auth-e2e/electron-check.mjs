// Continue with GitHub in the real app: boots dist/main/index.js against a local Supabase stack whose
// GitHub provider points at the mock GitHub (src/integrations/supabase/github-mock.ts), and clicks
// through the window as a person would. The system browser is the mock's browse(); the keychain is
// Chromium's mock keychain and userData a throwaway folder, so nothing of yours is touched.
//
//   AUTH_E2E_USER_DATA=<empty dir> AUTH_E2E_SHOTS=<dir> SUPABASE_URL=http://127.0.0.1:<port> \
//   SUPABASE_PUBLISHABLE_KEY=… ROOMS_TEST_SUPABASE_SECRET_KEY=… AUTH_TEST_GITHUB_MOCK_PORT=57399 \
//   node_modules/.bin/electron scripts/auth-e2e/electron-check.mjs first     # sign in through the window
//   … same env … electron scripts/auth-e2e/electron-check.mjs restart        # relaunch: restored; then revoke it
//   … same env … electron scripts/auth-e2e/electron-check.mjs expired        # relaunch: signed out, and says why
import { createClient } from '@supabase/supabase-js';
import { app, BrowserWindow, shell } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const phase = process.argv.at(-1);
const shots = process.env.AUTH_E2E_SHOTS;
app.commandLine.appendSwitch('use-mock-keychain');
app.setPath('userData', process.env.AUTH_E2E_USER_DATA);
mkdirSync(shots, { recursive: true });

const { browse, startMockGitHub } = await import('../../dist/integrations/supabase/github-mock.js');
const github = await startMockGitHub(Number(process.env.AUTH_TEST_GITHUB_MOCK_PORT));
github.as({ id: 424242, login: 'octo-e2e', name: 'Octo E2E', emails: [{ email: 'octo-e2e@gh.test', verified: true, primary: true }] });
const opened = [];
shell.openExternal = async (url) => void opened.push(browse(url));

await import('../../dist/main/index.js'); // the app itself
const account = await import('../../dist/integrations/account/index.js');
const { cloud } = await import('../../dist/integrations/supabase/index.js');
const { getLatestSession } = await import('../../dist/database/sessions.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const window = async () => {
  for (let i = 0; i < 100 && !BrowserWindow.getAllWindows()[0]; i++) await sleep(100);
  return BrowserWindow.getAllWindows()[0];
};
const run = async (win, js) => win.webContents.executeJavaScript(js);
async function waitFor(win, js, what) {
  for (let i = 0; i < 150; i++) {
    if (await run(win, js).catch(() => false)) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${what}`);
}
const textIs = (text) => `[...document.querySelectorAll('button')].some((b) => b.textContent.includes(${JSON.stringify(text)}))`;
const click = (text) => `[...document.querySelectorAll('button')].find((b) => b.textContent.includes(${JSON.stringify(text)})).click()`;
const shot = async (win, name) => writeFileSync(join(shots, `${name}.png`), (await win.webContents.capturePage()).toPNG());
const check = (ok, message) => {
  if (!ok) throw new Error(message);
  console.log(`  ✔ ${message}`);
};

// Electron emits `ready` only once this module has finished loading, so the check runs from there.
app.whenReady().then(async () => {
let ok = false;
try {
  const win = await window();
  await new Promise((r) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', r) : r()));

  if (phase === 'first') {
    await waitFor(win, textIs('Continue with GitHub'), 'the sign-in screen');
    await shot(win, '1-login');
    check(await run(win, textIs('Continue with Google')), 'the sign-in screen still offers Continue with Google');
    await run(win, click('Continue with GitHub'));
    // The buttons give way to "Waiting for GitHub…" at once; signed in is when the home screen shows.
    await waitFor(win, `!!document.querySelector('.account-me')`, 'the home screen');
    const user = account.getCurrentUser();
    check(user?.provider === 'github' && user.email === 'octo-e2e@gh.test', `signed in through the window as ${user?.email} (${user?.provider})`);
    check(github.authorizations.at(-1)?.join(' ') === 'user:email', 'GitHub was asked for user:email only');
    const stored = getLatestSession();
    check(stored?.user.provider === 'github' && stored.user.id === user.id, 'the session is stored, encrypted, as a GitHub session');
    await sleep(800);
    await shot(win, '2-home');
    check(await run(win, `document.querySelector('.account-me').textContent.includes('Signed in with GitHub')`), 'the account says “Signed in with GitHub”');
    await run(win, `document.querySelector('.account-me').click()`);
    await waitFor(win, `document.body.textContent.includes('Sign-in methods')`, 'the account panel');
    await sleep(500);
    await shot(win, '3-account-methods');
    const methods = await account.listSignInMethods();
    check(methods.ok && methods.value.find((m) => m.provider === 'github')?.current === true, 'Sign-in methods lists GitHub as this session’s');
    const unlink = await account.unlinkSignInMethod('github');
    check(!unlink.ok && unlink.error.code === 'current-method', `removing the only method is refused: “${unlink.ok ? '' : unlink.error.message}”`);
    writeFileSync(join(shots, 'user.json'), JSON.stringify(user));
  } else if (phase === 'restart') {
    const before = JSON.parse(readFileSync(join(shots, 'user.json'), 'utf8'));
    await waitFor(win, `!!document.querySelector('.account-me')`, 'the restored home screen');
    const user = account.getCurrentUser();
    check(user?.id === before.id && user.provider === 'github', `relaunched straight into the same account (${user?.email}), no browser`);
    check(opened.length === 0, 'no browser was opened on relaunch');
    // Revoke every session of this user on the server, as "sign out everywhere" or an admin would.
    // (A running app finds out when its access token next expires: supabase-js keeps a session whose
    // access token still works. The next launch finds out at once, which the `expired` phase checks.)
    const { data } = await cloud().auth.getSession();
    const admin = createClient(process.env.SUPABASE_URL, process.env.ROOMS_TEST_SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
    const { error } = await admin.auth.admin.signOut(data.session.access_token, 'global');
    check(!error, 'revoked every session of this account on the server');
  } else {
    await waitFor(win, textIs('Continue with GitHub'), 'the sign-in screen');
    await waitFor(win, `document.body.textContent.includes('GitHub sign-in ended')`, 'the reason');
    await sleep(800);
    await shot(win, '4-session-ended');
    check(!account.getCurrentUser(), 'a revoked session is not restored: back to sign-in, saying why');
    check(!getLatestSession(), 'the dead session is no longer stored');
    check(opened.length === 0, 'no browser was opened on its own');
  }
  ok = true;
} catch (err) {
  console.error('[auth-e2e] failed:', err);
  const win = BrowserWindow.getAllWindows()[0];
  if (win) await shot(win, `failure-${phase}`).catch(() => {});
} finally {
  await github.close();
}
app.exit(ok ? 0 : 1);
});
