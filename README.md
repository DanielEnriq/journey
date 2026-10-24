# Journey

Electron desktop app (pnpm, TypeScript). Google sign-in, local SQLite storage, a Supabase cloud backend for shared data, and the groundwork for collaborative agent calls.

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
| `pnpm db:generate` | Write a migration after editing `src/database/schema.ts` |
| `pnpm cloud:push` | Apply `supabase/migrations/` to the linked Supabase project |
| `pnpm cloud:types` | Regenerate `src/integrations/supabase/types.ts` from the linked project |
| `pnpm sign-out` | Revoke the stored Google session and quit |

## Layout

```
src/
  main/          app lifecycle, window, IPC handlers (the only place the renderer can reach)
  preload/       exposes window.journey: named functions only, no raw ipcRenderer
  renderer/      the UI (sandboxed, no Node)
  database/      SQLite via Drizzle: schema, migrations runner, one module per area
  integrations/  external services (Google auth, Supabase, ElevenLabs)
  shared/api.ts  the typed main ↔ renderer contract
drizzle/         generated SQL migrations, applied on startup
supabase/        cloud Postgres schema (migrations/) and local-stack config
```

Data lives in `journey.db` under Electron's `userData` directory (`~/Library/Application Support/journey` on macOS).

## Cloud (Supabase)

Optional: leave `SUPABASE_*` unset and the app stays local-only. SQLite keeps what belongs to this machine (sessions, settings, repository paths, caches); Postgres holds what collaborators share:

| Table | Visible to | Writable by |
|---|---|---|
| `users` | yourself and anyone you share a workspace with | yourself (`name`, `avatar_url`); rows are created on sign-up |
| `workspaces` | members | anyone creates (and becomes owner); owners rename/delete |
| `workspace_members` | members | owners add/remove/change roles; anyone can leave |
| `rooms` | workspace members | members create; creator or owner renames/deletes |
| `room_members` | workspace members | members add workspace members; leave yourself; creator or owner removes |

Every table has row-level security and nothing is granted to `anon`, so the publishable key on its own reads nothing. Google stays the identity provider: after Google sign-in (or session restore) main exchanges the Google ID token for a Supabase session with `signInWithIdToken`, kept in memory only. Supabase links the account by its Google `sub`, so one Google account is always the same cloud user; if the exchange fails (say, offline at launch), the next cloud call retries it from the stored Google session, with no second sign-in. Cloud user ids are Supabase UUIDs, not the Google `sub` used locally. `public.users.email` follows the Google account; `name` and `avatar_url` are filled from it once and then left to the user.

### Live rooms (Supabase Realtime)

A connected room is a private Realtime channel, `room:<room id>`, run from main (`src/integrations/supabase/realtime.ts`) and reached by renderers through `window.journey.rooms`:

- `join(roomId)` makes you a room member if needed (you must be in its workspace), connects, and tracks your presence. `leave(roomId)` disconnects but keeps membership.
- `send(roomId, type, payload)` broadcasts a typed event to everyone else connected; `onEvent` receives them. Events aren't stored.
- `onPresence` reports who's connected (one entry per user, however many windows); `onStatus` reports `reconnecting` / `connected` / `left`.

Event types live in `RoomEvents` (`src/shared/api.ts`); each needs a validator in `realtime.ts`, which checks both outgoing and incoming events. RLS on `realtime.messages` only admits members of the room who are still in its workspace. `senderId` is reported by the sender, so it's trusted only as far as the room's members are.

Setup, once per project:

1. Create a Supabase project and put its URL and publishable key in `.env`.
2. Auth → Providers → Google: enable it and add `GOOGLE_CLIENT_ID` under **Client IDs**.
3. Realtime → Settings: turn off **Allow public access**, so channels are private-only.
4. `pnpm exec supabase login && pnpm exec supabase link --project-ref <ref>`, then `pnpm cloud:push`.

Typed queries live in `src/integrations/supabase/workspaces.ts`. To change the schema, add a migration (`pnpm exec supabase migration new <name>`), `pnpm cloud:push`, then `pnpm cloud:types`.

## Adding a renderer capability

1. Declare the channel in `src/shared/api.ts` (`Channels.invoke`) and the method on `JourneyApi`.
2. Handle it in `src/main/ipc.ts`, validating arguments: types aren't enforced at runtime.
3. Expose it in `src/preload/index.cts`.

The compiler flags any mismatch between the three. Main owns the filesystem, database, Git, and process execution, so expose intent-level operations ("add repository"), never raw paths or shell commands.
