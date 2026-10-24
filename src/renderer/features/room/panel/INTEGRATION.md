# Room panel: integration notes

> **How it landed in Vowe (section 1 done).** The export assumed React 19 and
> `apps/desktop/...`; Vowe's renderer is Preact with no bundler, so the components
> here are a Preact port (`class`, `onInput`, hooks from `vendor/preact-hooks.js`),
> otherwise unchanged. Two small additions to `types.ts`: `proposedAgo` is
> optional, and `children` renders under Running (the room's overlap warning).
> Tokens: only `--peer3` was missing; it is in `.win` / `.win.light` in
> `shared/theme/shell.css`. The stylesheet is linked from `vowe.html`.
> The panel is mounted in the room's right column (`intent/Desk.tsx`), fed by
> `intent/toPanel.ts` from the demo controller rather than `fixtures.ts`, so the
> scripted room keeps working. `RoomPanelPreview` is at `#/dev/room-panel`
> (Developer menu → "Room panel, on fixtures"). Section 2 is not started.

The right-hand "Where we are" panel from the design canvas, exported as a
presentational React component. It draws the goal, the decision card, threads
and running streams. It has **no data layer**: it takes a view model as props
and calls back when someone acts. This file covers what is in the folder, how to
drop it in, and what still has to be built for it to work in the real app.

Design reference: the **Room — Payment Reliability** board on the design canvas
(`Main.dc.html`). Open product questions: the *Vowe Room — Open Product
Questions* doc.

---

## What's in the folder

| File | What it is |
|---|---|
| `RoomPanel.tsx` | The panel: header, "since you were last here" brief, goal, decision, threads, set-aside, running streams. |
| `DecisionCard.tsx` | The decision as a signed document: version, Verify line, signature slots (your empty slot is the Sign control), presence, version plates. |
| `ThreadStacks.tsx` | Threads as comments, stacked by the canvas part they are pinned to; fan out, replies, reply field, presence. |
| `Presence.tsx` | `Avatar` (initials in a person's tone, or the Vowe orb), `PresenceTag` ("John is typing" + dots), `TypingDots`. |
| `types.ts` | The view model: `Person`, `Presence`, `Decision`, `Approver`, `Thread`, `Comment`, `Stream`, `RoomPanelProps`. |
| `room-panel.css` | All styles, every class prefixed `rp-`. Includes reduced-motion handling. |
| `room-panel.tokens.css` | The CSS variables it reads, light and dark. Most already exist in Vowe's `styles.css`. |
| `fixtures.ts` | The Payment Reliability room as props. |
| `RoomPanelPreview.tsx` | Dev harness: fixtures + the canvas's scripted presence timeline + local handlers. Not for production. |
| `index.ts` | Barrel export. |

It is written to Vowe's renderer conventions: React 19, TS strict
(`noUncheckedIndexedAccess` clean), ESM with `.js` import suffixes,
`ReactElement` return types, plain global CSS, no runtime dependencies beyond
React. Typechecked and rendered headless (light and dark) before export.

---

## 1. Drop-in (a short PR)

1. Copy the folder to `apps/desktop/src/renderer/room/panel/` (or wherever room
   UI lives in the new app).
2. Import `room-panel.css` from the renderer's style entry, after the global
   tokens.
3. **Tokens.** Diff `room-panel.tokens.css` against the app's existing tokens and
   add only what's missing. Expect to add the person tones (`--me`, `--peer`,
   `--peer2`, `--peer3`) and Vowe's `--ask`. Point the `[data-theme='dark']`
   selector at whatever the app's theme switch sets. Don't duplicate tokens the
   app already defines.
4. Mount `<RoomPanel>` inside the shell's right column. The **shell keeps the
   column**: the 352px width, the collapse transition, and the 40px chrome band
   above the panel's content (`padding-top: 40px` on the column, as in Vowe's
   left sidebar). The panel just fills the column and scrolls.
5. Add a dev route rendering `<RoomPanelPreview />` so the panel can be checked
   in isolation against the canvas.

Constraints from the product brief still apply: renderer-only, no changes to
Google auth, the ElevenLabs integration, IPC or the main process.

---

## 2. What still has to be built for this to work for real

### 2a. A room store that produces the view model *(required)*

Something has to own room state and turn it into `RoomPanelProps`. Do it with
selectors, so the panel never sees raw rows.

- **people**: room members plus the agent (`kind: 'agent'`). Assign each person a
  tone once per room and keep it stable everywhere: canvas cursors, avatars,
  rings.
- **decision**: the *current* version only, with `earlierVersions` as a count.
  `approvers` lists who must sign (see the open questions below).
- **threads**: open threads pinned to a part (`anchor.id` = canvas part id),
  each with its replies. Format `ago` before handing it over, and re-tick it
  every 30–60s.
- **streams**: coding-agent work from the agent adapter (state, line, files
  changed).
- **brief**: what changed since the viewer last looked. This needs a
  per-user "last seen" marker.

### 2b. Persistence and sync *(required)*

A rough shape, to adapt to the actual backend:

```
decisions(id, room_id, current_version)
decision_versions(decision_id, version, title, verify, proposed_by, created_at)
signatures(decision_id, version, user_id, signed_at)       -- unique (decision_id, user_id, version)
threads(id, room_id, anchor_part_id, kind, created_by, created_at, resolved_at)
comments(id, thread_id, author_id, body, created_at)       -- root comment = first by created_at
```

- **Signatures are bound to a version, and the server enforces it.** A new
  version must not carry old signatures; the UI only *displays* stale ones
  ("John · signed v2"). Don't trust the client for this.
- `onSign` should be optimistic: fill the slot right away and roll back on
  failure. It must be idempotent per (user, version).
- Comments and signatures come in over realtime; set `fresh: true` on items that
  just arrived so they animate in once.

### 2c. Presence *(required for the "live" feel)*

Presence is ephemeral. Keep it out of the database and use the realtime
channel's presence feature.

- Each client publishes `{ userId, target: { type: 'thread' | 'decision' | 'part', id }, mode }`.
- **reading**: the thread is expanded, or the decision card or drill-in is
  open and on screen.
- **typing**: the reply input is focused and keys were pressed in the last
  ~3s. Throttle publishes to about 1 per second.
- **reviewing**: the person has the decision open while their signature for the
  current version is missing.
- Expire an entry after ~10s without a heartbeat. Never show the viewer their own
  presence.
- Selectors map presence onto `thread.presence` and `decision.presence`, using the
  most recent entry if several people are present. Showing several people at
  once (an avatar stack) is a small follow-up.
- The same presence feed should drive canvas cursors and the edge chips, so the
  panel and the canvas never disagree.

### 2d. Callbacks to wire

| Prop | Wire to |
|---|---|
| `onSign(id, version)` | Signature mutation (above). |
| `onOpenDecision(id)` | The decision drill-in. **Not included** (see 2e). |
| `onProposeChange(id)` | Open the drill-in in amend mode, prefilled with `verify`. |
| `onHandOff(id)` | The handoff flow to the coding agent. **Not included.** |
| `onReply(threadId, body)` | Create a comment. Voice replies ("just say it on the call") go through the conversation pipeline and land as the same comment. |
| `onShowAnchor(partId)` | Canvas camera: pan and zoom to the part and select it. |
| `onShowStream(id)` | Switch the canvas to the implementation view for that stream. |
| `onDismissBrief` / `onShowBrief` | Move the viewer's "last seen" marker; jump to what changed. |

### 2e. Pieces the panel links to but doesn't contain *(follow-up PRs)*

- **Decision drill-in**: the full decision (goal, avoid, check, because), the
  amend editor that bumps the version and clears signatures, version history
  with diffs, and the handoff package (Claude Code or Codex) with its checks.
  All of it is designed on the canvas's Main board.
- **Canvas comments**: the comment bubbles pinned to parts, plus creating a
  thread from the canvas ("Keep what was just said…"). The panel only lists
  threads.
- **Agent questions**: a coding agent's blocking question, pinned to a part.
  It shows on a stream as `state: 'needs'`, the only other amber in the panel.
- **Resolving threads**: there's no resolve control yet. Decide whether a thread
  resolves when a decision answers it, or explicitly.

### 2f. States not yet designed

These need a design pass before they ship:

- Empty states: no decision yet, no threads, nothing running.
- Loading and error states, offline, and a sign that failed.
- Long content: many threads per part, very long Verify lines, ten or more
  streams.
- More than two approvers (the slot row wraps, but check it), and more than one
  person present on one thread.
- Notifications: what reaches someone who isn't in the room when their
  signature is needed.

### 2g. Tests to add

- Unit: the `decisionStatus` and signature-slot logic (needs you, stale,
  reviewing, agreed, handed), thread grouping and presence-first sorting.
- Component: signing calls `onSign` with the current version; a closed stack
  opens on click; Enter in the reply field calls `onReply` and clears it.
- Visual: screenshot the preview route in light and dark against the canvas.

---

## 3. Rules the integration must keep

- **Colour is identity.** A person's tone is theirs everywhere. Blue is Vowe and
  only Vowe. **Amber means "needs you"** and nothing else: here, only the viewer's
  Sign slot and a blocked stream. Green and red mean pass and fail. Dashed means
  proposed and not yet agreed.
- **One place per action.** Your empty signature slot is the Sign control; don't
  add a second Sign button or a "your signature next" label. The decision card's
  bottom-right corner holds the single next step.
- **Vowe's comments are ordinary comments.** There's no keep or dismiss; people
  can just leave them.
- **Activity is not attention.** Presence and typing are quiet (ink plus the
  person's tone). They never turn amber.

## 4. Open product questions that affect this panel

- Who counts as an approver: everyone in the room, the decision's author plus
  named people, or an owner per area?
- When a new version is proposed, do signatures always reset, or only when the
  Verify line changes?
- Do threads auto-resolve when a decision covers them?
- Should Vowe's comments fade after a while if nobody engages?

---

## Suggested first prompt for Claude Code

> Read `room/panel/INTEGRATION.md` and the components next to it. Do section 1
> (drop-in) only: copy the folder in, merge only the missing tokens, mount
> `<RoomPanel>` in the right column with `fixtures.ts` data, and add a dev
> route for `<RoomPanelPreview />`. Renderer only: don't touch auth,
> ElevenLabs, IPC or the main process. Typecheck, then screenshot the preview in
> light and dark. Stop and summarise before starting section 2.
