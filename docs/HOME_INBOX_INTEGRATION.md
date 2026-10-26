# Home, Inbox, Focus and call controls: integration contract

Branch `feature/vowe-home-inbox-integration`, from `origin/main` 0f90be5 (includes the canvas polish, #16).
The design package is the `explore/home-inbox` branch (three commits on 9a2ebd2); read it with
`git show explore/home-inbox:src/renderer/explore/home-inbox/<path>`. It is reference only: nothing under
`src/renderer/explore/` lands here.

## Rule for overlapping code

- New in the design (Home/Inbox, sidebar, call cluster, Focus shell, motion, scrollbars): land it in full.
- Journey's newer content (canvas, pins, annotations, relationships, Concurrency view, `ThreadCard`,
  `DecisionDoc`, `PlanDoc`, `WorkView`, the Desk's compact and expanded states): keep Journey's. The design's
  copies of these were cut from 9a2ebd2 and are older than `origin/main`.
- Where both touched the same file, reconcile by hand; never copy a design file over a Journey file.

## Shared contracts (lead-owned; change only by asking the lead)

| Contract | File | Written by | Read by |
| --- | --- | --- | --- |
| Inbox model (`InboxItem`, `Tier`, `Anchor`, `InboxView`, `InboxMarks`) | `features/inbox/model.ts` | systems | UI |
| Inbox source (`InboxSource`, `InboxState`) | `features/inbox/source.ts` | systems implements | UI calls |
| Call presence (`callPresence` store) | `features/call/presence.ts` | systems publishes | UI's call cluster |
| Landing in a room (`requestAnchor`, `takeAnchor`) | `shared/nav.ts` | systems (apply in room) | UI (Open in room) |

Labels are the design's: tiers **Needs you**, **Following**, **Activity**; verbs from `OBLIGATION_VERB`.
Tiers come from the record's structure only (who asked whom, who signed, owns, took part), never from text or
a model's summary.

## Routes and history

- `#/home` Home (the Inbox). `#/home/i/<item id>` Home with that item selected, so back/forward restore it.
- `#/rooms`, `#/projects`, `#/invitations` as today. `#/room/<id>` and `#/room/<id>/call` as today.
- Every navigation is a hash change, so Electron's back/forward (⌘[ ⌘]) step through places.

## Call lifetime

Navigation never ends a call. Only the hang-up, Leave call in the popover, signing out, or crossing between
the demo and real rooms end it. The call's room stays mounted (hidden, `inert`) while you look elsewhere,
so its voice, canvas client and Desk state survive and coming back restores the same view. Joining another
room's call asks first.

## File ownership while the two workstreams run

| Area | Owner |
| --- | --- |
| `features/inbox/**` except `ui/`; derive, records loader, marks store, tests | systems |
| `features/call/**`, `app.tsx` (routes, history, call lifetime, keep-alive mount, Home wiring) | systems |
| `features/room/RoomScreen.tsx`, `features/vowe-room/host/**`, `room/navigation.ts` (anchors) | systems |
| `features/workspace/real/**`, `src/main/**`, `src/preload/**`, `src/integrations/**`, `supabase/**`, `shared/api.ts` | systems |
| `features/inbox/ui/**` (Home, rows, Preview, rooms), `features/home/Home.tsx` (page composition) | UI |
| `ui/pass2/shell/**` (AppShell, Sidebar, shell prefs), `ui/icons.tsx`, `ui/components.tsx`, `ui/pass2/rooms/CreateRoom.tsx` | UI |
| `features/room/call/CallControls.tsx` (+ css), `features/room/shell.tsx` (Chrome band) | UI |
| `features/vowe-room/desk/Focus.tsx`, `Desk.tsx` (FullScreen only), `room/VoweRoom.tsx`, `state/ui.ts` | UI |
| All stylesheets (motion, scrollbars, new component css), `vowe.html` | UI |
