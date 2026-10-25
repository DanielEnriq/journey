# Signing in: Google and GitHub

Vowe has one account per person. You can sign in to it with **Google**, with **GitHub**, or with both once
they're linked. Either way you get the same Supabase user (`auth.uid()`), so you see the same rooms,
memberships, ownership, invitations and decisions. Nothing is copied or moved between users. Each sign-in
method is an *identity* on the one `auth.users` row.

| | Google | GitHub |
|---|---|---|
| How | Native: Google OAuth in your browser, loopback redirect plus PKCE (`src/integrations/google`), then `signInWithIdToken` | Supabase's GitHub provider: browser, loopback redirect plus PKCE (`signInWithOAuth`) |
| Stored on this machine | Google refresh token, encrypted with `safeStorage` | Supabase refresh token, encrypted with `safeStorage`, kept current as Supabase rotates it |
| What the provider grants Vowe | `openid email profile` | `user:email` only. **No repository access.** |

Repository access is a separate grant. Rooms use repositories added on this machine today, and Connect
GitHub isn't in this build yet. When it comes, it will be its own authorization (a GitHub App install with
its own scopes), never the sign-in. ChatGPT model access ("Continue with ChatGPT") is
separate again. Signing in with GitHub doesn't change or imply either of them.

The code lives in `src/integrations/account` (the app's sign-in, sessions and sign-in methods: Electron)
and `src/integrations/supabase/identity.ts` (the flows and rules, Electron-free, so they're tested for
real).

## Setup

Do this once for each Supabase project: hosted, and local if you want GitHub sign-in on your machine.
Google setup is unchanged (README → Cloud).

### 1. Create a GitHub OAuth App

github.com → Settings → Developer settings → **OAuth Apps** → **New OAuth App**. For a team, use the
organization's settings so the app isn't tied to one person.

| Field | Value |
|---|---|
| Application name | `Vowe` (people see this on GitHub's consent page) |
| Homepage URL | your site, or `https://github.com/DanielEnriq/journey` |
| Authorization callback URL | hosted: `https://<project-ref>.supabase.co/auth/v1/callback`<br>local: `http://127.0.0.1:54321/auth/v1/callback` |
| Enable Device Flow | off |

Then **Generate a new client secret**. You need the **Client ID** and the **client secret**, nothing
else. Use an *OAuth App*, not a GitHub App: sign-in only needs to know who you are. The callback goes to
Supabase, never to Vowe. Supabase then sends the browser back to the app's loopback port. GitHub
OAuth Apps allow one callback URL each, so make one app for hosted and another for local.

### 2. Hosted Supabase project (dashboard)

1. **Authentication → Sign In / Providers → GitHub:** enable it, and paste the Client ID and client secret.
2. **Authentication → Sign In / Providers → Email → Confirm email: keep it ON.** This is required (see
   Security). With it off, the app refuses GitHub sign-in and says why.
3. **Authentication → Sign In / Providers → Allow manual linking: ON.** This lets someone link GitHub to
   the account they're signed in to. Without it, linking reports that it's turned off.
4. **Authentication → URL Configuration → Redirect URLs:** add `http://127.0.0.1:*/auth/callback/*`.
   Supabase sends the browser back only to an allowed URL. For anything else it silently falls back to
   the Site URL, and sign-in never finishes.
5. Google stays as it was: Providers → Google enabled, with `GOOGLE_CLIENT_ID` under Client IDs.

No migration and no app `.env` change is needed. The app asks the project which providers are on
(`/auth/v1/settings`), so the GitHub button works once step 1 is done.

### 3. Local stack (`supabase start`)

`supabase/config.toml` already has all of the above: GitHub enabled, manual linking, confirmations on,
and the loopback redirect URL. It reads the credentials from `supabase/.env`, which git ignores:

```sh
# supabase/.env: never commit it
SUPABASE_AUTH_EXTERNAL_GITHUB_CLIENT_ID=<Client ID of the local OAuth App>
SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET=<its client secret>
```

Then `pnpm exec supabase stop && pnpm exec supabase start`. Without the file the stack still starts, and
Google works. Only Continue with GitHub fails, at GitHub's own page, because the client id is missing.

## How it behaves

- **New GitHub user:** Continue with GitHub creates a Vowe account from the GitHub profile and its
  primary verified email.
- **Link GitHub to a Google account:** Account → Sign-in methods → GitHub → **Link**. You do it while
  signed in. It adds the GitHub identity to *this* user. Afterwards, Continue with GitHub signs you in to
  the same account. Linking Google to a GitHub account works the same way, through Google's native
  sign-in.
- **Already used elsewhere:** if that GitHub account already signs in to a different Vowe account, the
  link is refused ("already signs in to another Vowe account"). Neither account changes. To move it,
  remove it from the other account first.
- **Remove:** a method can be removed if it isn't the one this session signed in with, and it isn't your
  last one. Both rules are enforced in the app, and Supabase refuses removing the last identity anyway.
- **Same email, no link:** if your Google and GitHub accounts share a *verified* email, Supabase joins
  them on the first GitHub sign-in. That's the same person, proven by both providers. An *unverified*
  email is never used to join accounts (see Security).
- **Cancel / timeout:** Cancel on the sign-in screen, or closing the browser tab and waiting five
  minutes, stops the flow and frees the loopback port. "Cancel" or "Deny" on GitHub's page is reported
  as cancelled. Nothing is stored.
- **Session ended elsewhere** (revoked, signed out everywhere, refresh token expired): at the next launch
  the app returns to sign-in and says "Your GitHub sign-in ended. Sign in again to get back to your
  rooms." While the app is running, supabase-js keeps a session until its access token expires (up to
  an hour), then the app signs out with the same message. Offline at launch keeps the stored session for
  next time.
- `pnpm sign-out` ends this device's session, whichever provider it was, and forgets it.

The app's surface for this is `window.journey.auth`: `signIn(provider)`, `cancel()`, `getEnded()` /
`onEnded()`, `methods()`, `link(provider)` and `unlink(provider)`. Results are `AuthResult` with an
`AuthErrorCode` and a message to show as is (`src/shared/api.ts`). The account panel has a minimal
Sign-in methods list on top of it; the visual design comes separately.

## Security

**Unverified emails.** GoTrue (Supabase Auth) joins a new OAuth identity to an existing user with the same
email. We tested this against GoTrue v2.197 with a mock GitHub. With **Confirm email off**
(`mailer_autoconfirm`), it also does this for an email GitHub marks *unverified*, even one that's only a
secondary address. Anyone could add a victim's address to their GitHub account and sign in as the victim.
With **Confirm email on**, the same attempts fail closed: an unverified primary email is refused, an
unverified secondary gets its own separate account, and a GitHub account that "claims" an address before
its owner signs up loses that identity when the real owner confirms. So:

- the committed `config.toml` sets `[auth.email] enable_confirmations = true`;
- the app reads the project's settings and **refuses GitHub** when `mailer_autoconfirm` is on;
- the integration tests run each takeover attempt and check that it's refused.

**Other rules the code keeps:**

- Linking only ever adds an identity to the *signed-in* user, through `linkIdentity` on that user's own
  session. It never merges two existing users, and never rewrites `room_members`, `workspace_members` or
  invitations.
- Each OAuth flow runs in a throwaway Supabase client. Only the session's Supabase tokens reach the app.
  GitHub's own access token (`provider_token`) is dropped with that client and never stored. A link can't
  replace the session the app runs on. The extra session a link creates is ended by its own token. If it
  somehow belongs to a different user, the link is refused.
- The loopback server answers only `/auth/callback/<state>` for the flow in progress (anything else is a
  404). It listens on 127.0.0.1 only and closes on success, cancel or timeout. PKCE means an intercepted
  code can't be exchanged.
- Refresh tokens are stored only encrypted (`safeStorage`, the OS keychain), and never when encryption
  isn't available.

## Known limitations

- **Invitations by email** match the account's *primary* verified email (`private.verified_email()`).
  Linking GitHub doesn't change it, but an invitation sent to your GitHub-only address won't match a
  Google-primary account.
- **Removing a method** may change the account's primary email, if that's where it came from.
  `public.users.email` follows it (`handle_user_updated`).
- A GitHub user's local id (SQLite `users.id`) is the Supabase user id, and a Google user's is the Google
  `sub`. Everything shared is keyed by the Supabase id, so this matters only to the local sessions table.
- One Supabase project per GitHub OAuth App callback.

## Testing

`pnpm test` runs the unit tests (`identity.test.ts`, `loopback.test.ts`) every time. The integration
tests run when given a **local** stack whose GitHub provider points at the mock GitHub
(`src/integrations/supabase/github-mock.ts`). Real GitHub can't be automated, and Google tokens are
checked with Google, so a Google-signed-in person is played by an email-and-password user of the same
Supabase project. The identity-linking path is the same.

In the stack's `config.toml`, keep confirmations on and point GitHub at the mock:

```toml
[auth.external.github]
enabled = true
client_id = "mock"
secret = "mock"
url = "http://host.docker.internal:57399"   # the mock, as reached from GoTrue's container
```

```sh
ROOMS_TEST_SUPABASE_URL=http://127.0.0.1:54321 \
ROOMS_TEST_SUPABASE_PUBLISHABLE_KEY=<Publishable key> \
ROOMS_TEST_SUPABASE_SECRET_KEY=<Secret key> \
AUTH_TEST_GITHUB_MOCK_PORT=57399 \
pnpm test
```

The same stack drives the real app end to end, in three launches (`scripts/auth-e2e/electron-check.mjs`):
sign in by clicking Continue with GitHub; relaunch straight into the same account, then revoke it on the
server; relaunch and land on sign-in with the reason. Screenshots go to `AUTH_E2E_SHOTS`.

```sh
pnpm build
export AUTH_E2E_USER_DATA=$(mktemp -d) AUTH_E2E_SHOTS=/tmp/vowe-auth-shots \
  SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_PUBLISHABLE_KEY=<…> ROOMS_TEST_SUPABASE_SECRET_KEY=<…> \
  AUTH_TEST_GITHUB_MOCK_PORT=57399
for phase in first restart expired; do node_modules/.bin/electron scripts/auth-e2e/electron-check.mjs $phase; done
```

### By hand, with real Google and GitHub

Automation can't cover real Google, so check these once against the hosted project after setup:

1. Signed out: **Continue with Google** works, and you see your rooms.
2. Account → Sign-in methods → GitHub → **Link**. Approve on GitHub. GitHub now shows as linked, and the
   page asked only for your email address (no repositories).
3. Sign out. **Continue with GitHub**: the same rooms, the same owner role, and pending invitations still
   there.
4. Sign out. **Continue with Google**: the same account again.
5. Try to remove the method you're signed in with: refused, with the reason.
6. Start Continue with GitHub and press **Cancel** in the app, or **Cancel** on GitHub's page: back to the
   sign-in screen, with "cancelled" shown.
