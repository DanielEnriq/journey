// The real app, for checking Home, the Inbox and calls by hand against a local Supabase stack: boots
// dist/main/index.js exactly as `pnpm start` does, with a throwaway userData folder, Chromium's mock keychain
// and the mock GitHub (src/integrations/supabase/github-mock.ts) standing in for github.com, so you sign in
// by clicking Continue with GitHub as a test account. Nothing of yours is touched. Drive it by hand, or over
// the DevTools port.
//
//   pnpm build
//   HOME_E2E_USER_DATA=<empty dir> HOME_E2E_AS=<login> HOME_E2E_DEBUG_PORT=9334 \
//   SUPABASE_URL=http://127.0.0.1:<port> SUPABASE_PUBLISHABLE_KEY=… VOWE_API_URL=http://localhost:<api port> \
//   AUTH_TEST_GITHUB_MOCK_PORT=<the port the stack's [auth.external.github] url names> \
//   node_modules/.bin/electron scripts/home-e2e/launch.mjs
//
// HOME_E2E_AS picks the GitHub account (login, numeric id and `<login>@gh.test`, all derived from it), so
// relaunching with the same value signs back in to the same test account. See scripts/home-e2e/seed.mjs.
import { app, shell } from 'electron';
import { mkdirSync } from 'node:fs';

const as = process.env.HOME_E2E_AS ?? 'tester';
const userData = process.env.HOME_E2E_USER_DATA;
if (!userData) throw new Error('Set HOME_E2E_USER_DATA to an empty folder (it becomes the app’s userData)');
mkdirSync(userData, { recursive: true });
app.commandLine.appendSwitch('use-mock-keychain');
if (process.env.HOME_E2E_DEBUG_PORT) app.commandLine.appendSwitch('remote-debugging-port', process.env.HOME_E2E_DEBUG_PORT);
app.setPath('userData', userData);

const { browse, startMockGitHub } = await import('../../dist/integrations/supabase/github-mock.js');
const github = await startMockGitHub(Number(process.env.AUTH_TEST_GITHUB_MOCK_PORT));
const id = 100000 + [...as].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 900000, 7);
const name = as.split(/[-_.]/).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
github.as({ id, login: as, name, emails: [{ email: `${as}@gh.test`, verified: true, primary: true }] });
shell.openExternal = async (url) => { void browse(url); };

await import('../../dist/main/index.js'); // the app itself
