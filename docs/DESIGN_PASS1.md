# Design Pass 1 · Ink, Paper & Signal

The approved Pass 1 visual system from `vowe-foundations-pass1.zip`, applied to Journey. Journey's `main`
stays the authority on behaviour; the package was used only for how things look. The package's
`INTEGRATION.md` was written against an older Vowe repo, so each mapping below was checked against
Journey and adapted where they disagree.

## What changed

- **Tokens and fonts.** `src/renderer/ui/styles/{tokens,components,fonts}.css` come from the package
  unchanged, apart from one deviation: the paper-grain tiles are files (`grain-*.svg`) because Journey's CSP
  blocks `data:` images. The fonts are Instrument Serif, Instrument Sans and IBM Plex Mono, all under OFL 1.1
  with no Reserved Font Name. They ship unmodified, and their licenses go into `dist` (`ui/fonts/licenses`).
- **Theme.** `<html data-theme>` follows `useAppearance()`, so the existing Theme setting (System, Light
  or Dark, applied through `nativeTheme`) drives the new tokens. The package's own localStorage theme
  preference was not used.
- **Bridge.** `shared/theme/bridge.css` maps every window token the feature stylesheets read (`--pane`,
  `--ink-*`, `--attention`, `--bad`, `--ask`, …) onto `--v-*`. The old hex palettes in `shell.css` are gone.
- **Meaning.**
  - Vermilion (`--attention`, "Start room") marks human action and attention.
  - Oxide (`--bad`, destructive buttons) marks faults.
  - Slate (`--ask`, the Vowe orb) marks the agent and its provenance.
  - An ink-dashed outline marks every proposed or unconfirmed item, whoever authored it.
- **Type.** Serif is used for room titles, goals, decisions and the Home greeting. Sans is used for the
  interface, and mono for code and labels.
- **SignIn.** The package's minimal `SignIn` is wired to the real flow (`account.signIn` /
  `cancelSignIn`) through `LoginScreen`, with Google and GitHub as providers. ChatGPT appears only as
  "Not available yet".
- **Small fixes.**
  - Text on a person-tone avatar now uses `--v-bg`; previously white text was unreadable on light tones
    in dark mode.
  - Signing out is no longer coloured as a fault.
  - The dev menu uses the new tokens.

## Deliberately not done (Pass 2 / 3)

- **Home, Login and Onboarding layouts.** The package's `Home.tsx` was not integrated, so Home keeps its
  structure and data; only its styling changed. Pass 2 owns these layouts.
- **Room and canvas layout and interaction.** Unchanged. Canvas parts carry only `proposed`, with no
  author, so the provenance chips need data first (Pass 3).
- **Provider availability before sign-in.** Main computes it but exposes it only after sign-in, so both
  providers always show. Proposal: a read-only `auth:providers` IPC.
- **"Reopen browser" and the device matching code.** Journey's auth supports neither, so both are
  omitted.
- **Provider logos.** The design leaves an empty slot, and the logos are not redrawn. Terms/Privacy links
  are omitted because there are no pages for them.
- **Primary buttons stay ink.** Vermilion is reserved for "Start room" and the "needs you" markers.
- **Reference sheets** (`src/renderer/reference`) keep their old Satoshi and JetBrains fonts.

## Package version

There were two copies of `vowe-foundations-pass1.zip`. This uses the newer one in `~/Downloads` (23:27),
whose SignIn is the minimal one. The `Claude outputs` copy (23:26) still has the older split layout with
artwork.
