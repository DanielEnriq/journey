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

Navigation never ends a call. Only the hang-up, Leave call in the popover, or signing out
end it. The call's room stays mounted (hidden, `inert`) while you look elsewhere,
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

## Where the Inbox's state lives

- Seen, snoozed, followed and muted marks: `inbox_state` (one row per person, RLS: only you), with a local copy in
  `localStorage` (`vowe.inbox.v1:<userId>`) for speed. The newest `updatedAt` wins; saves are debounced and flushed
  on sign-out. A database without migration `20261031000000_inbox_state` keeps them on the machine only, and Home's
  footer says so.
- Done: `attention_done`, per room. Declining an invitation: `room_invitations.declined_at` via
  `decline_room_invitation`; sending it again brings it back.
- The rooms list is re-read when the window regains focus and every minute while visible, so a room someone adds
  you to shows up without relaunching.

## Checking it by hand against a local stack

`scripts/home-e2e/launch.mjs` boots the real app (`dist/main/index.js`, as `pnpm start` does) with a throwaway
userData folder and the mock GitHub, so you sign in with Continue with GitHub as a test account. After that account
has signed in once, `scripts/home-e2e/seed.mjs <login>` has two other people do ordinary things through the app's own
services (a decision to sign, a thread waiting on you, a plan's question, an invitation). It refuses anything but a
local Supabase URL. The header of each script has the exact environment.
