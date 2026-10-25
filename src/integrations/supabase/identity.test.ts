import { createClient, type Session } from '@supabase/supabase-js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { AuthErrorCode } from '../../shared/api.js';
import { browse, startMockGitHub, type GitHubAccount, type MockGitHub } from './github-mock.js';
import {
  AuthFlowError,
  codeFromRedirect,
  describeMethods,
  fetchAuthSettings,
  linkWithIdToken,
  linkWithOAuth,
  profileOf,
  resumeSession,
  signInWithOAuth,
  toAuthFailure,
  unlinkProvider,
  whyUnavailable,
  type BrowserFlow,
} from './identity.js';
import type { Cloud } from './index.js';
import { createInvitationService } from './invitations.js';
import { createRoomRecordService } from './record.js';
import { createRoomService } from './rooms.js';
import type { Database } from './types.js';

// Unit tests always run. The integration tests run Supabase's real GitHub sign-in and identity linking
// against a local stack whose GitHub provider points at a mock GitHub (github-mock.ts), as real users,
// and are skipped without one. On top of rooms.test.ts's variables they need the mock's port, which the
// stack's config must name, with "Confirm email" on:
//
//   [auth.external.github]  enabled = true, client_id/secret = anything, url = "http://host.docker.internal:57399"
//   [auth.email]            enable_confirmations = true
//
//   ROOMS_TEST_SUPABASE_URL=http://127.0.0.1:54321 ROOMS_TEST_SUPABASE_PUBLISHABLE_KEY=… \
//   ROOMS_TEST_SUPABASE_SECRET_KEY=… AUTH_TEST_GITHUB_MOCK_PORT=57399 pnpm test
//
// Google can't be driven here (Supabase checks Google ID tokens with Google), so "the Google user" is a
// user who signed up another way: linking acts on the user, whatever their first identity was.

const url = process.env.ROOMS_TEST_SUPABASE_URL;
const publishableKey = process.env.ROOMS_TEST_SUPABASE_PUBLISHABLE_KEY;
const secretKey = process.env.ROOMS_TEST_SUPABASE_SECRET_KEY;
const mockPort = Number(process.env.AUTH_TEST_GITHUB_MOCK_PORT);
const local = Boolean(url && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url));
if (url && !local) throw new Error('ROOMS_TEST_SUPABASE_URL must be a local stack (http://127.0.0.1:…), never a hosted project');
const integration =
  local && publishableKey && secretKey && mockPort ? {} : { skip: 'set ROOMS_TEST_SUPABASE_* and AUTH_TEST_GITHUB_MOCK_PORT to run against a local stack' };

async function failsWith(promise: Promise<unknown>, code: AuthErrorCode) {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof AuthFlowError, `expected an AuthFlowError, got ${String(err)}`);
    assert.equal(err.code, code, err.message);
    return true;
  });
}

const identity = (provider: string, data: Record<string, unknown> = {}) => ({ provider, identity_data: data, created_at: '2026-10-01T00:00:00Z' });

describe('sign-in methods', () => {
  it('reads Supabase redirects as a code or a reason', () => {
    const q = (s: string) => new URLSearchParams(s);
    assert.equal(codeFromRedirect(q('code=abc'), 'github'), 'abc');
    const reason = (s: string) => {
      try {
        codeFromRedirect(q(s), 'github');
      } catch (err) {
        return (err as AuthFlowError).code;
      }
      return 'none';
    };
    assert.equal(reason('error=access_denied&error_description=The+user+has+denied'), 'cancelled');
    assert.equal(reason('error=server_error&error_code=identity_already_exists'), 'linked-elsewhere');
    assert.equal(reason('error=access_denied&error_code=provider_email_needs_verification'), 'email-unverified');
    assert.equal(reason('error=server_error&error_code=unexpected_failure&error_description=Database+error+saving+new+user'), 'email-unverified');
    assert.equal(reason('error=invalid_request&error_code=flow_state_expired'), 'timed-out');
    assert.equal(reason('error=no_result'), 'unknown');
    assert.equal(reason('code=abc&error=access_denied'), 'cancelled'); // an error wins over a code
  });

  it('refuses GitHub on a project that would take unconfirmed emails, or that has it off', () => {
    assert.equal(whyUnavailable({ external: { github: true, google: true }, mailer_autoconfirm: false }, 'github'), null);
    assert.equal(whyUnavailable({ external: { github: true }, mailer_autoconfirm: true }, 'github')?.code, 'not-configured');
    assert.equal(whyUnavailable({ external: { github: false }, mailer_autoconfirm: false }, 'github')?.code, 'not-configured');
    assert.equal(whyUnavailable({ external: { google: true }, mailer_autoconfirm: true }, 'google'), null);
  });

  it('lists one method per provider; only sign-in providers count toward removing one', () => {
    const available = { google: true, github: true };
    const both = describeMethods(
      [identity('google', { email: 'd@acme.test' }), identity('github', { email: 'd@gh.test', user_name: 'dan' }), identity('email')],
      'google',
      available,
    );
    assert.deepEqual(both.map((m) => [m.provider, m.linked, m.current, m.canUnlink]), [['google', true, true, false], ['github', true, false, true]]);
    assert.equal(both[1]!.username, 'dan');
    const alone = describeMethods([identity('github'), identity('email')], 'github', available);
    assert.deepEqual(alone.map((m) => [m.provider, m.linked, m.canUnlink]), [['google', false, false], ['github', true, false]]);
  });

  it('removes a method only when another remains and it is not this session’s', async () => {
    const unlinked: string[] = [];
    const fake = (providers: string[]) =>
      ({
        auth: {
          getUserIdentities: async () => ({ data: { identities: providers.map((p) => ({ ...identity(p), identity_id: `id-${p}` })) }, error: null }),
          unlinkIdentity: async (i: { identity_id: string }) => (unlinked.push(i.identity_id), { data: {}, error: null }),
        },
      }) as unknown as Cloud;
    await failsWith(unlinkProvider(fake(['google', 'github']), 'google', 'google'), 'current-method');
    await failsWith(unlinkProvider(fake(['github', 'email']), 'github', 'google'), 'last-method');
    await failsWith(unlinkProvider(fake(['google']), 'github', 'google'), 'not-linked');
    assert.deepEqual(unlinked, []);
    await unlinkProvider(fake(['google', 'github']), 'github', 'google');
    assert.deepEqual(unlinked, ['id-github']);
  });

  it('refuses a link that answers for someone else, and ends that session, not yours', async () => {
    const ended: string[] = [];
    const mine = { access_token: 'mine', refresh_token: 'r', expires_at: Date.now() / 1000 + 3600, user: { id: 'me' } } as Session;
    const fake = {
      auth: {
        setSession: async () => ({ data: {}, error: null }),
        linkIdentity: async () => ({ data: { session: { access_token: 'theirs', user: { id: 'someone-else' } }, user: { id: 'someone-else' } }, error: null }),
        admin: { signOut: async (jwt: string) => (ended.push(jwt), { data: null, error: null }) },
      },
    } as unknown as Cloud;
    await failsWith(linkWithIdToken(fake, mine, 'google', { idToken: 'x', accessToken: 'y' }), 'unknown');
    assert.deepEqual(ended, ['theirs']);
  });

  it('won’t act on a session about to expire (refreshing it would rotate the app’s token)', async () => {
    const expiring = { access_token: 'a', refresh_token: 'r', expires_at: Date.now() / 1000 + 30, user: { id: 'me' } } as Session;
    await failsWith(linkWithIdToken({ auth: {} } as unknown as Cloud, expiring, 'google', { idToken: 'x', accessToken: 'y' }), 'session-expired');
  });

  it('names who a GitHub session is', () => {
    const user = { id: 'u1', email: 'd@gh.test', user_metadata: { user_name: 'dan', avatar_url: 'https://a/1' } } as never;
    assert.deepEqual(profileOf(user, 'github'), { id: 'u1', email: 'd@gh.test', name: 'dan', picture: 'https://a/1', provider: 'github' });
  });

  it('turns stray errors into words', () => {
    assert.equal(toAuthFailure(new Error('Not signed in to the cloud')).code, 'signed-out');
    assert.equal(toAuthFailure(new Error('boom'), 'github').message, 'GitHub didn’t finish: boom');
  });
});

describe('GitHub sign-in and linking (local Supabase, mock GitHub)', integration, () => {
  const run = randomUUID().slice(0, 8);
  const password = `pw-${randomUUID()}`;
  const base = Math.floor(Math.random() * 1e8) + 1e8;
  const created = new Set<string>();
  let github: MockGitHub;

  const admin = () => createClient<Database>(url!, secretKey!, { auth: { persistSession: false, autoRefreshToken: false } });
  const throwaway = () =>
    createClient<Database>(url!, publishableKey!, { auth: { flowType: 'pkce', persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const account = (n: number, email: string, verified = true): GitHubAccount => ({ id: base + n, login: `gh${base + n}`, name: `GitHub ${n}`, emails: [{ email, verified, primary: true }] });

  /** A browser that does what the person would; `opened` settles once it has finished. */
  function browser(): BrowserFlow & { opened: Promise<unknown>[] } {
    const opened: Promise<unknown>[] = [];
    return { opened, open: async (target) => void opened.push(browse(target).catch(() => undefined)), timeoutMs: 20_000 };
  }

  async function signInAs(who: GitHubAccount): Promise<{ client: Cloud; session: Session }> {
    github.as(who);
    const client = throwaway();
    const session = await signInWithOAuth(client, 'github', browser());
    created.add(session.user.id);
    // The app moves only the tokens to its own client; do the same.
    const app = throwaway();
    await app.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
    return { client: app, session };
  }

  async function passwordUser(name: string) {
    const email = `${name}-${run}@identity.test`;
    const { data, error } = await admin().auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: name } });
    if (error) throw error;
    created.add(data.user.id);
    const client = throwaway();
    const { data: signedIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
    if (signInError) throw signInError;
    return { id: data.user.id, email, client, session: signedIn.session };
  }

  const providersOf = async (id: string) => ((await admin().auth.admin.getUserById(id)).data.user?.identities ?? []).map((i) => i.provider).sort();

  before(async () => {
    github = await startMockGitHub(mockPort);
  });

  after(async () => {
    await github?.close();
    for (const id of created) await admin().auth.admin.deleteUser(id);
  });

  it('is on, and safe, for this project', async () => {
    assert.equal(whyUnavailable(await fetchAuthSettings(url!, publishableKey!), 'github'), null);
  });

  it('creates a Vowe account for a new GitHub user, asking GitHub only who they are', async () => {
    const { session } = await signInAs(account(1, `new-${run}@gh.test`));
    assert.deepEqual(session.user.identities?.map((i) => i.provider), ['github']);
    assert.deepEqual(github.authorizations.at(-1), ['user:email']); // no repo scope: sign-in isn't repository access
    assert.equal(profileOf(session.user, 'github').email, `new-${run}@gh.test`);
  });

  it('brings a returning GitHub user back to the same account', async () => {
    const first = await signInAs(account(2, `back-${run}@gh.test`));
    const again = await signInAs(account(2, `back-${run}@gh.test`));
    assert.equal(again.session.user.id, first.session.user.id);
  });

  it('links GitHub to an existing account, which then signs in with GitHub to the same rooms, ownership, decisions and invitations', async () => {
    const dana = await passwordUser('dana');
    const peer = await passwordUser('peer');
    const rooms = createRoomService(async () => dana.client);
    const { data: ws, error } = await dana.client.from('workspaces').insert({ name: `Identity ${run}` }).select().single();
    if (error) throw error;
    const room = await rooms.createRoom({ workspaceId: ws.id, name: 'Payment Reliability', goal: 'Stop double charges' });
    const decision = await createRoomRecordService(async () => dana.client).propose(room.id, { title: 'Idempotency keys', verify: 'Replay test' });
    // Someone else's room invites Dana by her account's email, before she links anything.
    const { data: peerWs } = await peer.client.from('workspaces').insert({ name: `Peer ${run}` }).select().single();
    const peerRoom = await createRoomService(async () => peer.client).createRoom({ workspaceId: peerWs!.id, name: 'Peer room', goal: '' });
    await createInvitationService(async () => peer.client).send(peerRoom.id, [dana.email], 'member');

    // Her GitHub account uses a different email.
    const hers = account(3, `dana-${run}@gh.test`);
    github.as(hers);
    await linkWithOAuth(throwaway(), dana.session!, 'github', browser());
    assert.deepEqual(await providersOf(dana.id), ['email', 'github']);
    assert.ok((await dana.client.auth.getUser()).data.user, 'the session the app runs on survives the link');

    // Later, on another machine: Continue with GitHub.
    const { client, session } = await signInAs(hers);
    assert.equal(session.user.id, dana.id);
    assert.equal(session.user.email, dana.email, 'her account email stays the one invitations go to');
    const mine = await createRoomService(async () => client).listRooms();
    assert.deepEqual(mine.map((r) => [r.id, r.role]), [[room.id, 'owner']]);
    const record = await createRoomRecordService(async () => client).getRecord(room.id);
    assert.equal(record.decisions[0]?.id, decision.id);
    const invites = createInvitationService(async () => client);
    const [waiting] = await invites.mine();
    assert.equal(waiting?.roomName, 'Peer room');
    assert.equal(await invites.accept({ invitationId: waiting!.id }), peerRoom.id);
  });

  it('won’t link a GitHub account that already signs in to someone else, and changes neither account', async () => {
    const owner = await signInAs(account(4, `taken-${run}@gh.test`));
    const other = await passwordUser('other');
    github.as(account(4, `taken-${run}@gh.test`));
    await failsWith(linkWithOAuth(throwaway(), other.session!, 'github', browser()), 'linked-elsewhere');
    assert.deepEqual(await providersOf(other.id), ['email']);
    assert.deepEqual(await providersOf(owner.session.user.id), ['github']);
  });

  it('never lets a GitHub account claim an account through an email GitHub hasn’t verified', async () => {
    const victim = await passwordUser('victim');
    const victimRooms = createRoomService(async () => victim.client);
    const { data: ws } = await victim.client.from('workspaces').insert({ name: `Victim ${run}` }).select().single();
    await victimRooms.createRoom({ workspaceId: ws!.id, name: 'Private', goal: '' });

    // Unverified as the primary email: no session at all.
    github.as({ id: base + 5, login: 'attacker5', emails: [{ email: victim.email, verified: false, primary: true }] });
    await failsWith(signInWithOAuth(throwaway(), 'github', browser()), 'email-unverified');
    // Unverified as a secondary email: an account of its own, not the victim's.
    const attacker = await signInAs({
      id: base + 6,
      login: 'attacker6',
      emails: [{ email: `attacker-${run}@gh.test`, verified: true, primary: true }, { email: victim.email, verified: false, primary: false }],
    });
    assert.notEqual(attacker.session.user.id, victim.id);
    assert.deepEqual(await createRoomService(async () => attacker.client).listRooms(), []);
    assert.deepEqual(await providersOf(victim.id), ['email']);
  });

  it('joins a GitHub account whose verified email is the account’s (Supabase’s automatic linking)', async () => {
    const vera = await passwordUser('vera');
    const { session } = await signInAs(account(7, vera.email));
    assert.equal(session.user.id, vera.id);
  });

  it('won’t remove someone else’s identity, or the last way to sign in', async () => {
    const owner = await signInAs(account(8, `own-${run}@gh.test`));
    const intruder = await passwordUser('intruder');
    const [theirs] = owner.session.user.identities!;
    const { error } = await intruder.client.auth.unlinkIdentity(theirs!);
    assert.ok(error, 'Supabase refuses to unlink an identity of another user');
    assert.deepEqual(await providersOf(owner.session.user.id), ['github']);
    await failsWith(unlinkProvider(owner.client, 'github', 'google'), 'last-method');
  });

  it('won’t link Google from a forged ID token, and the account is untouched', async () => {
    const gus = await passwordUser('gus');
    await assert.rejects(linkWithIdToken(throwaway(), gus.session!, 'google', { idToken: 'eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.', accessToken: 'x' }));
    assert.deepEqual(await providersOf(gus.id), ['email']);
    assert.ok((await gus.client.auth.getUser()).data.user);
  });

  it('can’t use an intercepted code without the app’s PKCE verifier', async () => {
    github.as(account(9, `pkce-${run}@gh.test`));
    const listener = throwaway();
    const { data } = await listener.auth.signInWithOAuth({ provider: 'github', options: { redirectTo: 'http://127.0.0.1:9/auth/callback/x', skipBrowserRedirect: true } });
    const landed = new URL((await browse(data.url!)).url);
    const code = landed.searchParams.get('code');
    assert.ok(code);
    const { error } = await throwaway().auth.exchangeCodeForSession(code);
    assert.ok(error, 'another client has no verifier for it');
  });

  it('handles cancelling at GitHub, in the app, and waiting too long', async () => {
    github.as(account(10, `cancel-${run}@gh.test`), { deny: true });
    await failsWith(signInWithOAuth(throwaway(), 'github', browser()), 'cancelled');

    github.as(account(10, `cancel-${run}@gh.test`));
    const controller = new AbortController();
    const waiting = signInWithOAuth(throwaway(), 'github', { open: async () => controller.abort(), signal: controller.signal });
    await failsWith(waiting, 'cancelled');
    await failsWith(signInWithOAuth(throwaway(), 'github', { open: async () => {}, timeoutMs: 50 }), 'timed-out');
  });

  it('restores a stored session while it lasts, and says so once Supabase has ended it', async () => {
    const { session } = await signInAs(account(11, `restore-${run}@gh.test`));
    const restored = await resumeSession(throwaway(), session.refresh_token);
    assert.equal(restored.user.id, session.user.id);
    // Signed out (or revoked) elsewhere: the newest token stops working too.
    await throwaway().auth.admin.signOut(restored.access_token, 'global');
    await failsWith(resumeSession(throwaway(), restored.refresh_token), 'session-expired');
  });
});
