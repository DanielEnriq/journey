# Vowe's semantic canvas: integration

A room's canvas is a **semantic document**: components, relationships, the views drawn of them, notes and
marks, proposals and the active view. Positions are never stored. Every view is laid out from the
document, so `payment-worker` is the same component in Architecture, Failure flow and Concurrency, however
many copies of it a view draws. Every change, from a person's pen or from Vowe, is one **Canvas Command**.
The same engine runs it everywhere:

```
renderer pen ──IPC canvas:execute──▶ main hub ──┐
Vowe tool call ──hub.executeAsAgent (main)──────┤──▶ execute(): validate → apply → CAS save (commit_canvas)
dev harness ──memory store──────────────────────┘         │
                                                          ├─▶ this app's windows   (IPC canvas:changed)
                                                          └─▶ the rest of the call (realtime canvas:changed → re-read)
```

## Files

| Where | What |
|---|---|
| `src/shared/canvas/model.ts` | The document: `Component`, `Relationship`, `ViewSpec`, `Annotation`, `Proposal`, `CanvasRef`, `Actor`. Schema `vowe.canvas/1`. |
| `commands.ts` | The Command API: the 19 commands, their arguments, `parseCommand`, `fromToolCall`, `CommandResult`. |
| `engine.ts` | `applyCommand(doc, cmd, actor, now)`: pure. It handles agent rules, proposals, per-actor undo and cascades. |
| `views/` | `buildScene(doc, viewId)` / `buildScenes(doc)`: Architecture, Failure flow and Concurrency, laid out in the design's grammar. |
| `store.ts` | `CanvasStore`, `execute()` (CAS with up to 5 re-applies, then `busy`), `memoryStore`. |
| `presence.ts` | `CanvasPresence` (view, cursor in stage coordinates, semantic selection, tool), `CanvasChanged`. |
| `tools.ts` | `CANVAS_TOOLS`: JSON Schema tool definitions for the agent-allowed commands. |
| `src/integrations/supabase/canvas.ts` | `createCanvasStore`, `createCanvasHub`, `canvasContext`. Electron-free. |
| `src/main/canvas.ts` | The app's hub singleton (`canvas`), `loadRoomCanvas`, `executeAsPerson`, `sharePresence`. |
| `src/renderer/features/canvas/` | `client.ts` (`CanvasClient`, `ipcTransport`, `memoryTransport`), `LiveSurface.tsx`, `SceneGlimpse.tsx`, `Harness.tsx`. |
| `supabase/migrations/20261028000000_room_canvas.sql` | Tables and the only write path, `commit_canvas()`. |

## Command API

A command is `{ schema: 'vowe.canvas.command/1', id, name, args }`. `id` (6–64 of `[A-Za-z0-9_-]`) is chosen
by the issuer, and entities a command creates derive their ids from it. The result is always a value and
never thrown:

```ts
{ ok: true, command, name, revision, applied: 'applied' | 'proposed' | 'noop', changed: { components, relationships, views, annotations, proposals }, activeView, message }
{ ok: false, command, name, error: { code, message, path? } }
// code: invalid | not-found | conflict | forbidden | unsupported | permission-denied | busy | network | signed-out | unknown
```

| Command | Args (abridged) | Notes |
|---|---|---|
| `load_system` | `components[], relationships[], replace?` | Structured input; see `fixtures/payment.ts`. |
| `add_component` / `update_component` / `remove_component` | `component` / `{component, patch}` / `{component}` | Remove cascades to connections, views and notes. **Vowe: add/update become proposals; remove is forbidden.** |
| `connect_components` | `from, to, kind, label?, past?` | Kinds are checked against what they connect. **Vowe: becomes a proposal.** |
| `highlight_component` | `components[]` (empty clears) | Vowe's focus ring (`.part.agent`). |
| `annotate_component` | `component, text, kind?` | **Vowe: lands `suggested`, kind defaults to `question`.** |
| `show_view` | `view` (id or type), `focus?`, `instances?` | Makes it the active view for everyone. Draws it first if the room has none of that type. **Vowe: a new view lands `proposed`.** |
| `create_view` | `type, id?, name?, question?, focus?, subject?, instances?, steps?, parent?, show?` | |
| `add_failure` | `component, mode: crash\|timeout, after?, view?` | Failure flow: the focus fails after `after` (default: its irreversible call) and before its ack. |
| `propose_change` | `title, rationale?, changes[]` | Batches add/update/connect as one proposal. |
| `accept_proposal` / `reject_proposal` | `proposal` | **People only.** Reject restores what was changed. |
| `keep_view` / `remove_view` | `view` | Keep is **people only**. Vowe may only remove views it drew. Architecture can't be removed. |
| `draw` | `view, kind: ink\|circle, d, refs?` | `d` is straight segments only (`M x y L x y … Z`). A circle carries the semantic refs it encloses. |
| `remove_annotation` / `keep_note` | `annotation` | Keep is **people only**. Vowe may only remove its own notes. |
| `undo` | `command?` | Undoes the actor's own latest (or the named) command. Refuses with `conflict` if something changed since or the undo would leave dangling refs; refuses with `forbidden` for someone else's change. |

`CanvasRef` is how "this" is said: `{ component, instance? }` (which copy, in a view that draws several) or
`{ step, view, component }`.

## For the reasoning runtime (no second runtime, no new provider)

The runtime offers `CANVAS_TOOLS` (load_system, add_component, update_component, connect_components,
highlight_component, annotate_component, show_view, create_view, add_failure, propose_change,
remove_view, draw, remove_annotation, undo) and runs each tool call in **main**:

```ts
import { canvas } from '../main/canvas.js';
import { fromToolCall, CANVAS_TOOLS } from '../shared/canvas/index.js';

const ctx = await canvas.context(roomId);          // compact JSON: ids, kinds, views, selection, open proposals, notes
const { result } = await canvas.executeAsAgent(roomId, fromToolCall(call.name, call.input, call.id));
return result;                                      // feed back as the tool result; failures are values
```

`fromToolCall` throws `CanvasError('invalid')` naming the bad field. Catch it and return it as the tool
error. The hub runs one command per room at a time, saves, and announces. Nothing here touches
`src/assistant`; wiring the tools into the Collaborator is the runtime owner's change.

**Who Vowe is in the database.** `room_canvas_ops.actor_kind = 'agent'` records that Vowe acted, but
the save is authenticated as the signed-in user whose app ran it (`created_by`). The engine's agent
rules (proposals, forbidden actions) are enforced in the app, not in Postgres. A server-side Vowe
identity would need its own role.

## Renderer

```ts
const client = new CanvasClient(roomId, ipcTransport(() => me));   // or memoryTransport(actor) in dev
await client.run('show_view', { view: 'concurrency', focus: 'payment-worker' });
client.share({ view, cursor: { x, y }, selection: [{ component: 'payment-worker', instance: 2 }], tool: 'select' });
<LiveSurface client={client} onComment={(x, y) => …}>{overlays}</LiveSurface>
```

`CanvasClient` shows your commands immediately by applying them to the last saved document, then
replaces that guess with the saved answer. `undo` is never guessed. Presence is throttled to every
60ms. A real room's call (`FreshCall` in `RoomScreen.tsx`) uses it when the room has a record. The
demo (`#/demo/...`) is untouched; its screenshots are byte-identical before and after. The room
preview shows the saved active view as a still (`SceneGlimpse`): nothing to press, no camera.

**Gestures resolve to meaning.** Click or marquee selects `CanvasRef`s. The circle tool runs `draw`
`circle` with the refs whose centres it encloses (`circled()`, shared with the harness). The pen runs
`draw` `ink`. ⌘Z runs `undo`. The view tabs run `show_view` for everyone. The camera, tool and
selection are per person. A proposed view shows the design's receipt (Undo → `remove_view`, Keep view →
`keep_view`). An open proposal shows Reject / Accept. Suggested notes show Keep / Dismiss.

## Persistence: `20261028000000_room_canvas.sql`

- `room_canvases(room_id pk, revision, document jsonb, updated_by, updated_at)`. The check requires an
  object with schema `vowe.canvas/1`, at most 1 MB.
- `room_canvas_ops(room_id, revision, command jsonb, actor_kind human|agent, created_by, created_at)`.
- `commit_canvas(room, base_revision, document, command, actor_kind)` is `security definer`. It raises
  42501 unless `private.can_edit_canvas` (an owner or member who is still in the workspace; the role is
  compared as text, so a future `viewer` role is refused without changes here). It does a CAS insert
  or update and returns the new revision, or `null` if someone saved first.
- RLS: members read both tables (`can_use_room`). Every privilege is revoked from `anon` and
  `authenticated`, and `authenticated` gets `select` back. This also removes the `truncate` that
  Supabase's default privileges grant and RLS doesn't cover, which matches the sibling migrations.
- **Deployed to the hosted project `journey` (`lpqzuilghsxbxsplamzr`) on 2026-10-24.**
  `supabase db push --linked` applied this migration and nothing else; a dry run listed only this one.
  Afterwards, on the hosted database:
  - the history row is present;
  - RLS is on for both tables;
  - `authenticated` has `select` only, and `anon` has nothing;
  - both read policies use `private.can_use_room`;
  - `commit_canvas` and `can_edit_canvas` are `security definer` with an empty `search_path`, and
    `anon` can't execute them;
  - the check constraints are present;
  - existing rooms, members, workspaces, users and invitations were unchanged;
  - the Realtime policies on `realtime.messages` were untouched.
  `pnpm cloud:types` regenerated `types.ts` from the hosted schema.

## Realtime

On the room's existing private channel (`src/integrations/supabase/realtime.ts`):

- `canvas:changed { revision, command, name }`: no content. Receivers' hubs re-read if behind.
- `canvas:presence { view, cursor, selection, tool }`: never saved. Cameras are never shared.

Both only reach people connected to the room's call. Anyone else reads the canvas when they next open it.

## Dev harness: `#/dev/canvas` (Developer menu → Canvas engine harness)

Eight steps, each one command or check, through `CanvasClient` + `LiveSurface` + `execute()`:

1. Load the payment architecture.
2. Vowe highlights the worker.
3. Vowe shows Failure flow (proposed).
4. Vowe adds the crash after the charge, before the ack.
5. Vowe shows Concurrency (proposed).
6. Check: two copies of one component.
7. You circle the provider; it resolves to `{component:'payment-provider'}`.
8. Reload from storage and compare the document, scenes and revision.

`#/dev/canvas` keeps the room in local storage. Two windows are two people (BroadcastChannel). `#/dev/canvas/<roomId>`
runs against a real room via IPC. Vowe's steps run as you there, because a renderer can't act as the agent.

## Vowe's turns on the room canvas (`runtime.ts`, `main/vowe-canvas.ts`)

The runtime (`src/assistant`) speaks contract version 1: a `CanvasSnapshot` in and `CanvasCommand`
requests out. The engine speaks the semantic document. `runtime.ts` adapts between the two, so neither
side changes:

- **In.** `withRoomCanvas(turn)` in main replaces the renderer's snapshot with
  `snapshotOf(await canvas.load(roomId), selection)`. Vowe then sees the document the hub will apply its
  requests to, and the asker's selection and circle are kept. Views map `architecture→arch`,
  `failure-flow→failure` and `concurrency→concurrency`. Kinds map `worker`/`boundary→service`,
  `database→store` and `event→queue`. When a mapping loses detail, the engine kind is kept in `tech`.
- **Out.** `canvasEvents(hub, roomId, forward)` wraps the turn's event stream. `TurnCanvas` maps each
  validated request to engine commands, run through `hub.executeAsAgent`, so the engine's agent rules
  apply:
  - `highlight` → `highlight_component`;
  - `annotate` → `annotate_component`, a suggested note;
  - `show_view` → `show_view` (proposed). `failure`/`timeout` with a crash step becomes `add_failure`;
  - every `propose_component` / `connect_components` in a turn becomes **one** `propose_change` when the
    turn ends, which a person accepts or rejects. Requests that point at a proposed id wait until after
    the proposal.
  Each outcome reaches the asker as `{ type: 'canvas.applied', turnId, requests, result }`. The turn's
  last event waits until its canvas requests have run. A cancelled or failed turn drops its unsent
  proposal.
- **Declined.** The `alternatives`, `impl` and `ui` views (demo-only here) come back as `canvas.applied`
  with `ok: false`, and the ask panel says so.
- **Lost in translation.** Highlight `tone` and annotation `near` have no engine equivalent and are
  dropped. The model's tool result is the runtime's `{"sent":true}`, not the engine's outcome, so in the
  same turn Vowe doesn't know whether a request was declined.

## What was tested where

| Against the real local Supabase stack (`canvas.test.ts`, real users, RLS on) | Unit / in-memory only |
|---|---|
| Save, then read back as another member | Engine: all commands, agent rules, proposals, undo, cascades |
| Ops log with `actor_kind` | Views: the design's rects, steps, captions and recipes; a second system |
| A stale revision refused by the DB; the losing command re-applied | Command and presence validation, `busy`, noop not saved |
| Concurrent saves from two users | Renderer client, LiveSurface, gestures, harness (browser and Electron, memory store) |
| Outsiders refused; direct table writes refused; document check constraint | Two-window presence and selection (BroadcastChannel, not Supabase) |
| Realtime `canvas:changed` from Alice reaching Bob, whose hub re-reads | |
| Presence carried between members; a non-member refused from the private channel | |
| A fresh session reads an identical document and scenes | |

**Not tested:** the renderer's `ipcTransport` end to end in a signed-in app (it needs Google sign-in),
and more than two simultaneous users. This is not a claim of production multiplayer support.

## Design gaps (reported rather than invented)

- **No styles for:** a proposed *wire* (a dashed part exists; a dashed connection doesn't); a third or
  later peer (cursor, tab, edge: only `peer` and `p2` exist); a `p2` selection tab (`.tab.peer` is used for both);
  other people's ink (drawn in your `--me` colour); a standalone event or job block (events draw inside
  their queue); timing lanes for races.
- Architecture doesn't draw `retries` relationships.
- Alternatives, Implementation, Provider timeout and Checkout UI remain demo-only views.
- Asking Vowe (`features/canvas/AskVowe.tsx`) has three ways in: the selection bar's "Ask about
  this/these", the circle popover's "Ask Vowe about this", and the empty canvas's "Ask Vowe". All three
  use the existing `.ctx`, `.lasso-ask` and `.mini.ask` styles. The question and the streamed answer
  appear in the existing captions panel (`.captions`, `.prevline`, `.curline`, `.spk`), which the ask
  takes over while it's open. The only new rules are the `.ask-vowe` / `.ask-field` layout in `room.css`;
  no design exists for a typed question.
- The selection bar's "Point everyone here" (`highlight_component`) uses the existing `.ctx` bar.
- One added CSS rule: `.cursor.live{transition:transform 120ms linear}`. Live cursors follow the pointer
  instead of the demo's 900ms scripted glide.
- The harness's step list is plain `.wnote` rows in the existing desk column, as dev tooling.
