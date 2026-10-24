# Persistent rooms

A room is Vowe's primary persistent object: a named, shared space in a workspace, with members, an
optional goal, and an optional repository. It exists on its own. Having a room never means a call is
running, and opening one never connects you to anything.

| Action | What it touches |
|---|---|
| Create, list, open (preview), rename, manage members | Cloud rows only: `rooms`, `room_members` (`window.journey.rooms.*` → `RoomService`) |
| Join the room live (presence, events) | Realtime channel `room:<id>`: `rooms.join` / `rooms.leave` |
| Join the call | LiveKit: `calls.access` + renderer `CallController`. The microphone is only requested by `calls.requestMicrophone` |

Leaving the call or the live channel keeps your membership. Leaving the *room* is `rooms.removeMember(roomId)`.

## Model

- `rooms`: `id` (UUID), `workspace_id`, `name`, `goal`, `repository`, `created_by`, `created_at`, `updated_at`.
- `room_members`: `(room_id, user_id)`, `role` (`owner` | `member`), `joined_at`.

`repository` is a **shared identity** such as `github.com/acme/payments`: the remote's host and path,
with no scheme, credentials, port or `.git`. A CHECK constraint refuses anything shaped like a local
path. Each member maps it to their own checkout on their own machine (`RoomCheckout`, not yet
implemented). Local paths, transcripts and worktrees never become room data automatically.
`rooms.attachRepository(roomId, localRepositoryId)` reads the local repository's `origin` in main and
stores only its identity.

## Permissions (RLS: `supabase/migrations/20261025000000_room_membership.sql`)

| | Owner | Member | Workspace member, not in the room | Outside the workspace |
|---|---|---|---|---|
| See the room and its roster | ✓ | ✓ | – (`not-found`) | – (`not-found`) |
| Rename, set goal/repository, delete | ✓ | – (`permission-denied`) | – | – |
| Add members (from the room's workspace) | ✓ | – | – | – |
| Change roles, remove others | ✓ | – | – | – |
| Leave | ✓ unless last owner | ✓ | – | – |
| Realtime channel, call token | ✓ | ✓ | – | – |

- Creating a room makes you its owner (a trigger, `private.add_room_owner`).
- A room always keeps an owner: removing or demoting the last one fails with `conflict`. Hand
  ownership on (`setMemberRole`/`addMember(…, 'owner')`) or delete the room. Account deletion still works.
- Membership also requires still being in the room's workspace: removing someone from the workspace
  cuts them off every room in it, though their `room_members` row stays.
- Only `name`, `goal`, `repository` (rooms) and `role` (room_members) are updatable; ids, owners and
  timestamps can't be rewritten.

**Behavior change from the previous schema.** Rooms used to be visible to the whole workspace, and
`rooms.join` / `calls.access` added you to a room automatically. Now a room is private to its members,
and joining live or the call requires membership. The migration makes each existing room's creator
its owner (or its earliest member, if the creator has left the workspace). Existing members keep
their access. Workspace members who were never in a room lose sight of it.

## Service (`src/integrations/supabase/rooms.ts`)

`createRoomService(client)` → `RoomService`; the app's instance is `rooms` in `workspaces.ts` (bound to
`getCloud`). Methods throw `RoomError { code, message }`. Over IPC each resolves with a
`RoomResult<T>` instead (`{ ok: true, value } | { ok: false, error: { code, message } }`), because
Electron drops custom error fields.

| Renderer (`window.journey.rooms`) | Service | Returns |
|---|---|---|
| `list(workspaceId?)` | `listRooms` | `RoomSummary[]`, most recently changed first |
| `get(roomId)` | `getRoom` | `RoomDetails` (summary + `memberCount`) |
| `create({ workspaceId, name, goal?, repository? })` | `createRoom` | `RoomDetails` |
| `update(roomId, { name?, goal?, repository? })` | `updateRoom` | `RoomDetails` |
| `delete(roomId)` | `deleteRoom` | – |
| `members(roomId)` | `listMembers` | `RoomMember[]`, owners first |
| `addMember(roomId, userId, role?)` | `addMember` | `RoomMember` (idempotent) |
| `setMemberRole(roomId, userId, role)` | `setMemberRole` | `RoomMember` |
| `removeMember(roomId, userId?)` | `removeMember` | – (no `userId`: leave) |
| `attachRepository(roomId, repositoryId)` | `updateRoom` + local `origin` | `RoomDetails` |

Error codes (`RoomErrorCode`):

- `not-found`: no such room, or you aren't a member. These are deliberately indistinguishable.
- `permission-denied`: you're a member, but your role can't do that.
- `invalid`: bad input, e.g. an empty name, a local path, or adding someone outside the workspace.
- `conflict`: the change would leave the room without an owner.
- `signed-out`: no cloud session.
- `not-configured`: no `SUPABASE_*` in `.env`.
- `network`: the cloud is unreachable. Retry. Note that supabase-js retries reads first, so this can take several seconds to arrive.
- `unknown`: anything else.

`RoomLoad<T>` (`loading` | `ready` | `error`) is a suggested shape for UI state around these calls.

## Integration boundaries (contracts only, in `src/shared/api.ts`)

`RoomCheckout` (room → local checkout), `RoomWorkstreamRef` (Claude Code work linked to a room, `local`
or `room` visibility), `RoomCallState`, `RoomViewRef`, `RoomDecisionRef`. Each future system keys its
data by room id. Nothing implements them yet.

## Not done yet

- **Invitations.** There's no way to bring a new person into a workspace except by cloud user id
  (`addWorkspaceMember`), and no email invitation. Room members can only be added from the room's
  workspace, so a person must be added to the workspace first. An invitation step (email → pending
  invite → accepted on sign-in) needs a table and probably an Edge Function, and is out of scope here.
- Rooms aren't pushed to the UI when another member changes them: re-fetch, or subscribe to Postgres
  changes later.
- A member removed from the workspace who was a room's only owner leaves the room ownerless (members keep
  access; nobody can rename it). Fix by re-adding them or by a future admin path.

## Testing

`pnpm test` runs the unit tests always and the integration tests when pointed at a **local** stack
(the tests refuse any non-localhost URL). They create throwaway users with the secret key, act as up to
four signed-in people (owner, member, workspace-only member, outsider), and delete the users afterwards.

```sh
pnpm exec supabase start          # applies supabase/migrations to a local stack
ROOMS_TEST_SUPABASE_URL=http://127.0.0.1:54321 \
ROOMS_TEST_SUPABASE_PUBLISHABLE_KEY=<Publishable key> \
ROOMS_TEST_SUPABASE_SECRET_KEY=<Secret key> \
pnpm test
```

Hosted rollout is `pnpm cloud:push`. It changes production access rules (see the behavior change above),
so run it deliberately.
