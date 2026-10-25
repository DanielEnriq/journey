# Design Pass 2 · Home, Login & Onboarding

The approved Pass 2 package (`vowe-home-pass2.zip`) applied to Journey, on top of Pass 1's tokens. Journey stays the
authority on behaviour, and the package was used only for appearance. The package components live in
`src/renderer/ui/pass2/`. Each file's first line names its source. They never fetch data: the container
`features/home/Home.tsx` reads the real workspace and maps it into their view models. Anything Journey can't
supply is passed as `null`, and the section is left out instead of being faked.

## What changed

- **Shell and pages.** Home, Rooms, Projects and Invitations sit inside the Pass 2 `AppShell`. Each page has
  a route: `#/home`, `#/rooms`, `#/projects` and `#/invitations`, with the same pages under `#/demo/…`. Below
  1100px the sidebar collapses to a rail, and the shell's top band drags the window.
- **First-time Home** appears when you have no rooms. It shows the composer, your email invitations, the
  link field and your repositories.
- **Returning Home** has these sections, all built from real data:
  - **Needs you:** decisions waiting for your signature, plus email invitations.
  - **Your rooms:** each room's last shared view drawn small, from its canvas.
  - **Ongoing work:** Claude Code sessions in repositories on this machine.
  - **Decisions:** the decision each room is working on.
  - **Projects:** your local repositories, plus rooms whose repository isn't on this machine.
- **Rooms** lists every room with its role, repository, checkout state and last activity. It has error and
  retry states.
- **Projects** lists the repositories added on this machine, which rooms use each one, and the rooms whose
  repository has no clone here. It has "Add a repository…" and "Find repositories".
- **Invitations** shows the email invitations waiting for you, plus the link field.
- **Room creation** uses the Pass 2 New room sheet everywhere, Home and room sidebar alike. Creating a room
  opens its preview. It never starts a call.
- **Invites** open through `InviteGate` inside the shell, with the same resolve and accept flow as before.
  The key stays in memory only.
- **Account panel.** The sidebar's account button opens a menu with:
  - Appearance: the existing Theme setting.
  - Sign-in methods: link and unlink Google and GitHub, with the same rules as before.
  - Vowe's model: the ChatGPT section, shown only when enabled.
  - Sign out, which shows the session splash.
- **Sign-in.** Pass 1's minimal centered sign-in is kept as it was (`features/welcome/LoginScreen.tsx`).
  The only addition is the "Opening Vowe…" splash, which replaces the blank window shown while main
  reports the session.

## Adapted from the package

- **The split-layout sign-in is not used.** Its `AuthScreen`, its artwork and the loopback pages were not
  ported. Browser auth pages are unchanged.
- **Room previews use `CanvasSketch`, not `SceneGlimpse`.**
  - Each card reads its room's canvas once (`roomScene`) and draws at most five parts where the scene
    places them.
  - Long spoken part names are shortened to a tile label.
  - Empty canvases and unreadable ones get their own states. The room screen's glimpse CSS is scoped to
    `.room-screen`, so it can't be reused here.
- **The demo gets a `room` need kind.** The demo's needs are free text, such as "Claude Code has a schema
  question". The package's need kinds don't cover free text, so a `room` kind with an "Open room" button
  was added.
- **The demo has no link field.** Invite links only exist for real rooms, so the demo says so instead of
  showing a field that does nothing. The demo never reads repositories, invitations, work or canvases. Home
  is keyed by workspace, so nothing read for your real rooms carries into the demo.
- **CSS fixes in `app.css`.** `pass2.css` ships exactly as packaged. A few package parts use `width:100%`
  plus padding without `box-sizing`, and overflowed their container on the boards too. Those parts, and the
  empty-canvas sentence in the Rooms list's small thumbnails, are fixed in `app.css`.

## Removed

- `features/welcome/WelcomeScreen.tsx`'s Home, and `welcome.css`.
- `features/workspace/NewRoom.tsx`.
- `features/membership/HomeInvites.tsx` and `InviteLanding.tsx`.
- Their CSS: the `.nr-*` rules, the `@scope (.welcome-screen)` Home block, and the `vm-invites-home` and
  `vm-redeem` rules.

`AccountFoot` stays because the room sidebar still uses it until Pass 3.

## Not done (future)

- **Room preview and pre-join restyle.** This was optional in Pass 2. The room screen, its preview and the
  call lifecycle are unchanged.
- **Before sign-in:**
  - Hiding providers that aren't configured. This needs a pre-sign-in `auth:providers` IPC.
  - Per-error sign-in copy.
- **Room data:**
  - Presence for every room. Today, rooms report only what they already list.
  - Agent questions as needs.
  - A repository's remote before it's attached to a room.
- **Invites:**
  - A `vowe://` handler and a pending invite across sign-in. Not implemented, and nothing pretends it works.
  - A hosted `/j/` landing page.
  - Request access.
- **Other:**
  - An example room.
  - Terms and Privacy links.
  - Restyling main's loopback pages.
