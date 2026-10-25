# Engineer setup: run Vowe and join a room you were invited to

This is written so you can paste it to your coding agent (Claude Code or similar) as-is:

> Follow `docs/ENGINEER_SETUP.md` in the `DanielEnriq/journey` repo, branch `integration/vowe-complete-mvp`,
> to install and open the Vowe desktop app on this Mac. Stop and ask me when you need a value for `.env`,
> and when the app is open and waiting for me to sign in.

The end state: the Vowe Electron app is open on your machine, you're signed in with **your own** Google
account, and you've joined the room you were invited to, its call and its shared canvas.

---

## For the agent doing the setup

Ground rules:

- Run everything from the repo root. Don't change any source file to make setup work. If something fails,
  report the exact error to the person.
- **Never commit `.env`** (it's gitignored) and never print its values back in full.
- Never run `supabase db push`, `supabase migration …`, `supabase functions deploy` or `supabase secrets …`.
  The hosted project is shared, and this setup needs none of them.
- Don't paste the person's invitation link into logs, commits, issues or screenshots. It's a bearer token
  until it's used or expires.

### 1. Prerequisites (macOS, Apple silicon tested)

| Tool | Version | Check | Install |
|---|---|---|---|
| Git | any recent | `git --version` | `xcode-select --install` |
| Xcode Command Line Tools | — | `xcode-select -p` | `xcode-select --install` (native modules may need it) |
| Node.js | **24.x** (tested on 24.16) | `node -v` | `brew install node@24`, or nvm: `nvm install 24` |
| pnpm | **10.x** (tested on 10.34) | `pnpm -v` | `corepack enable && corepack prepare pnpm@10 --activate`, or `npm i -g pnpm@10` |

You also need **read access to the GitHub repo `DanielEnriq/journey`**. If `git clone` says "Repository not
found", ask Daniel to add your GitHub account as a collaborator.

### 2. Get the code

```sh
git clone git@github.com:DanielEnriq/journey.git vowe   # or https://github.com/DanielEnriq/journey.git
cd vowe
git checkout integration/vowe-complete-mvp
```

### 3. Install

```sh
pnpm install
```

This also rebuilds `better-sqlite3` for Electron (the `postinstall` step) and fetches the LiveKit native
module. It should end with `✔ Rebuild Complete`. If the rebuild fails with a compiler error, run
`xcode-select --install`, then run `pnpm install` again.

### 4. Configure `.env`

```sh
cp .env.example .env
```

Then **ask the person for these four values** (Daniel sends them privately, never in a public channel):

```
SUPABASE_URL=              # the hosted project, https://<ref>.supabase.co
SUPABASE_PUBLISHABLE_KEY=  # public client key (sb_publishable_…); RLS protects the data
GOOGLE_CLIENT_ID=          # Vowe's Google OAuth desktop client
GOOGLE_CLIENT_SECRET=      # Vowe's desktop client secret (desktop secrets aren't confidential, but keep it out of git)
```

Set exactly those four and leave every other line in `.env` empty or commented out. In particular:

- **Leave `VOWE_API_URL` unset.** The app then gets call tokens from the hosted `livekit-token` function. You
  need no LiveKit or ElevenLabs keys, and you must not be given them.
- You don't need any model keys to join, talk and see the canvas. Asking Vowe from your machine needs a model
  sign-in; see "What works on your machine" below.

Check it (prints names only):

```sh
grep -oE '^[A-Z_]+=.' .env
```

That should list the four names above, each followed by its first character.

### 5. Start the app

```sh
pnpm start
```

This builds TypeScript into `dist/`, then opens the Electron window. The first build takes about 20–40 s.

- `Supabase not configured — set SUPABASE_URL…`: `.env` is missing values, or isn't in the repo root.
- `Missing GOOGLE_CLIENT_ID — copy .env.example to .env and fill it in` (or `…SECRET`): one of the Google
  values is missing.

When the window shows **Continue with Google** and **Continue with GitHub**, stop and hand over to the person.

---

## For the person: sign in and join the room

1. **Continue with Google** (or **Continue with GitHub**, if the Vowe project has GitHub set up: `docs/AUTH.md`). Your browser opens the consent page. Pick **your own** account. The browser
   then says you can return to Vowe, and the app shows your Home.
   - If Google says **"Access blocked: … has not completed the Google verification process"** or that the app is
     in testing, Daniel has to add your Google email as a **test user** on the OAuth consent screen. Then sign
     in again.
2. **Paste the invite.** Daniel sends you a link that starts with `vowe://join/`.
   - Clicking it does nothing yet, because the desktop link handler isn't built.
   - Copy the whole link, then paste it into the **"Paste an invite link to join a room"** field on Home and
     press Enter.
3. **Check the invite.** It shows the room, who invited you, and your role.
   - If it says **"This link only works for …"**, or that you're signed in as the wrong account, use
     **Switch account**.
   - If it says the link expired or was turned off, ask Daniel for a new one.
4. Press **Join room**, then **Open room**. Joining the room doesn't join the call, and your mic stays off.
5. **Start or join the call** from the room page. Unmute when you want to talk. macOS asks once for microphone
   access, for "Electron" when run from source; allow it. If you said no earlier, use
   System Settings → Privacy & Security → Microphone.
6. You should now see:
   - Daniel in the call;
   - the room's shared canvas, with the same components Daniel sees and changes landing live;
   - the comment threads in the right-hand panel (press `]` if it's closed).

Membership is saved in the hosted database. Next time, `pnpm start` and the room is on your Home with no
new invite.

## What works on your machine

| | Works | Notes |
|---|---|---|
| Sign in with your own Google account | ✓ | Your Google account must be allowed on the OAuth consent screen while it's in testing |
| Accept the invite into Daniel's room | ✓ | Paste the link; clicking `vowe://` links isn't supported yet |
| Call (LiveKit), hear and talk to people | ✓ | Through the hosted `livekit-token` function; no keys on your side |
| See and change the shared canvas, comment, reply | ✓ | |
| Hear Daniel's Vowe answer aloud in the call | ✓ | His Vowe is a call participant |
| Bring **your own** Vowe into the call (orb) | ✗ | Needs the Vowe API (`VOWE_API_URL`), which only runs on Daniel's machine. The orb shows "needs the Vowe API". |
| Ask Vowe by text from your machine | needs setup | Needs your own model sign-in: ChatGPT plan (`VOWE_CHATGPT_PLAN=on`, then sign in when asked) or your own `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` in `.env` |

## Troubleshooting

- **The app opens, but Home shows no rooms after the invite.** Paste the link again. If it says you're
  already in the room, use **Open room**.
- **"Could not join the call: …"**: the reason after the colon comes from the token service. "Join the room
  before its call" means the invite wasn't accepted on this account.
- **No audio from others**: if the app says "Your system paused the call’s audio", click **Play audio**.
  Also check the macOS output device.
- **Rebuild after pulling changes**: `git pull && pnpm install && pnpm start`.
