# Journey

Electron desktop app (pnpm, TypeScript). Google or GitHub sign-in to one account (`docs/AUTH.md`), local SQLite storage, a Supabase cloud backend for shared data, LiveKit voice calls in rooms, and the groundwork for AI voice agents in those calls.

## Run

```sh
pnpm install
cp .env.example .env   # fill in GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
pnpm start
```

| Script | |
|---|---|
| `pnpm start` | Build and launch |
| `pnpm typecheck` | Type-check without emitting |
| `pnpm test` | Build and run `*.test.ts`; room integration tests need a local Supabase stack (`docs/rooms.md`) |
| `pnpm db:generate` | Write a migration after editing `src/database/schema.ts` |
| `pnpm cloud:push` | Apply `supabase/migrations/` to the linked Supabase project |
| `pnpm cloud:types` | Regenerate `src/integrations/supabase/types.ts` from the linked project |
| `pnpm cloud:functions` | Deploy the `livekit-token` Edge Function to the linked project |
| `pnpm sign-out` | End this device's stored session (Google or GitHub) and quit |
| `pnpm api:start` | Build and run the cloud API (`server/`) on `localhost:8080`, reading `.env` |

## Layout

```
src/
  main/          app lifecycle, window, IPC handlers (the only place the renderer can reach)
  preload/       exposes window.journey: named functions only, no raw ipcRenderer
  renderer/      the UI (sandboxed, no Node)
  database/      SQLite via Drizzle: schema, migrations runner, one module per area
  git/           read-only Git queries (status, branches, worktrees) via the git CLI
  agents/        the coding-agent adapter interface (Claude Code, Codex…); no adapters yet
  integrations/  external services (Google auth, Supabase, LiveKit, voice agents: ElevenLabs)
  shared/api.ts  the typed main ↔ renderer contract
server/          the Vowe cloud API (pnpm workspace package `vowe-api`), deployed to DigitalOcean
drizzle/         generated SQL migrations, applied on startup
supabase/        cloud Postgres schema (migrations/), Edge Functions (functions/), local-stack config
```

Data lives in `journey.db` under Electron's `userData` directory (`~/Library/Application Support/journey` on macOS).

## Cloud (Supabase)

Optional: leave `SUPABASE_*` unset and the app stays local-only. SQLite keeps what belongs to this machine (sessions, settings, repository paths, caches); Postgres holds what collaborators share:

| Table | Visible to | Writable by |
|---|---|---|
| `users` | yourself and anyone you share a workspace with | yourself (`name`, `avatar_url`); rows are created on sign-up |
| `workspaces` | members | anyone creates (and becomes owner); owners rename/delete |
| `workspace_members` | members | owners add/remove/change roles; anyone can leave |
| `rooms` | room members | workspace members create (and become owner); room owners rename/delete/set goal and repository |
| `room_members` | room members | room owners add workspace members, remove anyone, change roles; anyone can leave; a room always keeps an owner |

Every table has row-level security and nothing is granted to `anon`, so the publishable key on its own reads nothing. People sign in with Google or GitHub; both are identities on one Supabase user, so either reaches the same rooms (sign-in methods, linking and setup: `docs/AUTH.md`). After Google sign-in (or session restore) main exchanges the Google ID token for a Supabase session with `signInWithIdToken`, kept in memory only. Supabase links the account by its Google `sub`, so one Google account is always the same cloud user; if the exchange fails (say, offline at launch), the next cloud call retries it from the stored Google session, with no second sign-in. Cloud user ids are Supabase UUIDs, not the Google `sub` used locally. `public.users.email` follows the Google account; `name` and `avatar_url` are filled from it once and then left to the user.

### Live rooms (Supabase Realtime)

A connected room is a private Realtime channel, `room:<room id>`, run from main (`src/integrations/supabase/realtime.ts`) and reached by renderers through `window.journey.rooms`:

- `join(roomId)` connects to a room you're a member of and tracks your presence. `leave(roomId)` disconnects but keeps membership.
- `send(roomId, type, payload)` broadcasts a typed event to everyone else connected; `onEvent` receives them. Events aren't stored.
- `onPresence` reports who's connected (one entry per user, however many windows); `onStatus` reports `reconnecting` / `connected` / `left`.

Event types live in `RoomEvents` (`src/shared/api.ts`); each needs a validator in `realtime.ts`, which checks both outgoing and incoming events. RLS on `realtime.messages` only admits members of the room who are still in its workspace. `senderId` is reported by the sender, so it's trusted only as far as the room's members are.

Setup, once per project:

1. Create a Supabase project and put its URL and publishable key in `.env`.
2. Auth → Providers → Google: enable it and add `GOOGLE_CLIENT_ID` under **Client IDs**. For GitHub sign-in, follow `docs/AUTH.md` → Setup (a GitHub OAuth App, Confirm email on, manual linking on, and the loopback redirect URL).
3. Realtime → Settings: turn off **Allow public access**, so channels are private-only.
4. `pnpm exec supabase login && pnpm exec supabase link --project-ref <ref>`, then `pnpm cloud:push`.

Typed queries live in `src/integrations/supabase/workspaces.ts`; persistent rooms and their membership in `rooms.ts` (see `docs/rooms.md`). To change the schema, add a migration (`pnpm exec supabase migration new <name>`), `pnpm cloud:push`, then `pnpm cloud:types`.

### Voice calls (LiveKit)

Every room has an audio call between its members: one LiveKit room per Journey room, named `room:<room id>`. WebRTC needs a browser, so the call runs in the renderer (`CallService` in `src/renderer/calls/service.ts`; how the UI uses it is in `src/renderer/calls/INTEGRATION.md`). Main only lets you in:

1. `calls.access(roomId)` checks you're a member, then asks the token service: the Vowe API's `POST /livekit/token` with `VOWE_API_URL`, else the `livekit-token` Edge Function. Both verify your Supabase session, check the same rule as the Realtime channel (in the room *and* still in its workspace), and return a 10-minute token for that room only, microphone publishing only. The LiveKit API secret stays on the server side, never in the app.
2. `CallService.join` connects **with the microphone off**. You hear the others right away.
3. `setMicrophoneEnabled(true)` asks the OS for the microphone (`calls.requestMicrophone`; macOS prompts once, and a refusal must be undone in System Settings), then publishes it. Muting releases the device. Electron grants our pages audio capture and nothing else (`restrictPermissions` in `src/main/window.ts`).
4. Status is `connecting` / `connected` / `reconnecting` (LiveKit recovering on its own) / `dropped` (gave up; `reconnect()` rejoins muted), plus each participant's speaking, muted and connection quality.

LiveKit identities are cloud user ids, so joining from a second window or device replaces the first connection. A call is separate from the Realtime presence above: you can be in a room's channel without being in its call.

The renderer has no bundler, so `pnpm build` copies livekit-client's self-contained ESM bundle to `dist/renderer/vendor/livekit-client.js`; `src/renderer/vendor/livekit-client.d.ts` supplies its types. A page's CSP must admit the LiveKit host in `connect-src`: `index.html` allows `*.livekit.cloud`.

Tests: `pnpm test` covers the service's lifecycle against a fake room, and `pnpm --filter vowe-api test` covers token issuance (sessions, membership, grants). `pnpm test:calls` is end to end. It starts a throwaway LiveKit server in Docker, and two Electron clients join one call through `CallService` with Chromium's fake microphone. It checks that audio actually decodes on the other side, and that mute, unmute, reconnect and leave behave. It needs Docker running; `LIVEKIT_E2E_URL` with `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` points it at another server.

Setup, once per project (after the Supabase setup above):

1. Create a LiveKit Cloud project (cloud.livekit.io) and an API key under Settings → API Keys.
2. `pnpm exec supabase secrets set LIVEKIT_URL=wss://<project>.livekit.cloud LIVEKIT_API_KEY=<key> LIVEKIT_API_SECRET=<secret>`
3. `pnpm cloud:functions`

### Voice agents (ElevenLabs)

AI voice agents sit behind `VoiceAgentProvider` (`src/integrations/voice/provider.ts`): start a session, send it call audio and background context, get back transcripts, speech, and interruptions, all as plain PCM so a bridge can later carry them into a LiveKit call as one more participant. ElevenLabs is the only provider (`src/integrations/elevenlabs`), chosen by `getVoiceAgentProvider()` when `ELEVENLABS_*` is set. Nothing starts a conversation yet; startup only verifies the key and agent.

## Cloud API (DigitalOcean)

`server/` is a small Node HTTP service for integrations whose secrets must not ship with the app. It shares nothing with Electron or SQLite and deploys to DigitalOcean App Platform from `.do/app.yaml` (see `docs/DIGITALOCEAN_HANDOFF.md`). Supabase stays the auth, Postgres, and Realtime backend: the API checks the caller's Supabase session and asks Postgres questions as them, under RLS.

| Route | |
|---|---|
| `GET /health` | `{ status: 'ok', livekit, elevenlabs }`: which integrations have credentials |
| `POST /livekit/token` | `{ roomId }` → `{ url, token }`, the same rules as the `livekit-token` Edge Function |
| `POST /elevenlabs/signed-url` | `{ signedUrl }` for the private agent; any signed-in user |

Set `VOWE_API_URL` in `.env` and main uses it for call tokens and ElevenLabs signed URLs, so `ELEVENLABS_*` can stay off the machine. Unset, calls fall back to the Edge Function and ElevenLabs to the local key. Server env vars are listed in `server/.env.example`.

## Repositories and Git

`repos.add()` shows a folder picker in main and stores the top of the working tree the folder belongs to (`git rev-parse --show-toplevel`), so picking a subfolder adds the whole repository. `repos.detect()` ("Find repositories") lists repositories two levels deep in `~/projects`, `~/code`, `~/dev`, `~/Developer`, `~/src`, `~/repos`, `~/workspace`, and `~/GitHub`, skipping ones already added; `~/Documents` and `~/Desktop` are left alone because reading them makes macOS ask for access. `repos.addDetected(path)` only accepts a path from the last detection. The renderer names repositories by id from then on and never sends paths. `repos.open(id)` marks one as most recently opened.

`window.journey.git` reads a repository through `src/git`, which runs the user's `git` binary and parses its porcelain output:

- `status(id)`: current branch (null when detached), HEAD, upstream with ahead/behind, and each changed file, split into staged and unstaged changes, with renames and conflicts. Ignored files are left out.
- `branches(id)`: local branches, then remote-tracking ones, with upstream tracking and the worktree each is checked out in.
- `worktrees(id)`: every worktree, main first, flagged detached, locked, or prunable.

These calls are read-only. They take no locks (`GIT_OPTIONAL_LOCKS=0`), never prompt for credentials, and pass `core.fsmonitor=false`, because a repository's own config could otherwise make `git status` run a program.

### Coding agents

`CodingAgentAdapter` (`src/agents/adapter.ts`) is the interface future Claude Code and Codex adapters will implement: `detect()` whether the agent can run here, and `start({ cwd, prompt }, onEvent)` it in a worktree, streaming `message`, `tool`, and `exited` events, with `cancel()` to stop. `getCodingAgentAdapters()` returns none yet, and nothing orchestrates agents.

## Adding a renderer capability

1. Declare the channel in `src/shared/api.ts` (`Channels.invoke`) and the method on `JourneyApi`.
2. Handle it in `src/main/ipc.ts`, validating arguments: types aren't enforced at runtime.
3. Expose it in `src/preload/index.cts`.

The compiler flags any mismatch between the three. Main owns the filesystem, database, Git, and process execution, so expose intent-level operations ("add repository"), never raw paths or shell commands.
