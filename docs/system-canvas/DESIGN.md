# System canvas — design

A drawing of a real system you can enter: each part has a form that says what it is, the space around it says
where it runs, lines say what kind of connection they are, and going closer (or in) reveals the parts inside,
in the places they had from outside. Everything drawn comes from the registry (`src/shared/system/model.ts`)
and is marked by how we know it.

SCRATCH below is the team scratchpad (`/tmp/claude-0/-home-user-journey/9eac8953-aefa-55cb-a316-f0397d43d10a/scratchpad`).

## 1. Directions explored

Three static prototypes, each drawing Journey's canvas subsystem (surface, client, bridge, IPC/hub, engine,
store) at overview, closer, one entered component, plus the command path and the save-retry loop.
Sources `SCRATCH/design/{a-plan,b-schematic,c-cutaway}.html`, screenshots `SCRATCH/design/shots/*.png`.

| | A · Plan (floor plan) | B · Schematic (circuit / subway) | C · Cutaway (technical illustration) |
|---|---|---|---|
| Idea | processes are buildings, components rooms, relations doors and corridors | each kind a compact symbol with pins; a wire grammar | each component a casing cut open to show its working parts |
| What it is at a glance | weak: every room is a rectangle; kind is told by furniture | good: silhouettes (drum, throat, bezel, dispatch table) | best: the silhouette *is* the thing |
| Relations mean something | weak: a call and a table write are both "a door" | strong: stroke, terminal, pin placement (writes land on the table) | medium |
| Boundaries / where it runs | strong: walls | medium: dash-dot process lines | strong: strata |
| Closer / entered continuity | entered = a grid of identical rooms | consistent language but entering feels like a new diagram | strong: entered = the same parts "pulled apart", in place |
| Paths and loops | a loop becomes a lap around a room | excellent: transit line with stations, loop drawn as a loop | fine, competes with the drawing |
| Risk | generic boxes | dense, technical, "diagram not place" | decorative; and the near view tempted me to draw invented queue items (`draw · c-17`) — exactly what must not happen |

**Chosen: a synthesis — "cutaway schematic".**
- From C: every kind has its own silhouette, and closer the casing shows its compartments; entering composes
  the same compartments as regions in the same columns, so the inside is visibly the outside opened up.
- From B: the relation grammar (weight, pattern, terminals, ports on the right part), and paths as a transit
  line with numbered stations and a drawn loop-back.
- From A/C: runtime boundaries as walls — rows of a section through the stack (renderer → preload → main →
  cloud), with code that is built into several processes standing beside the stack, not in it.
- Vowe's material language: graphite ink for what the code establishes, slate for what the system drew (paths,
  inferences), dashes only for what isn't confirmed, oxide only for where it breaks. Light and dark from tokens.

The prototype mistake in C (filled queue slots) became a rule: slots in queues, pending trays and workers are
*structure only* and stay empty unless a recorded trace fills them.

## 2. The visual language

### Forms (render/forms.ts `FORM_TABLE`, declarative: kind → form)
| kind | form | what the form shows |
|---|---|---|
| interface | window (rounded, title bar, three dots) | interaction regions; what it renders; tests |
| client | casing with a transport plug on its side | state · reconcile · pending tray (empty slots) · transport boundary · operations |
| engine | chamfered machine plate | the command set as notched tickets; the apply path; checks |
| store | drum | tables as drawers (with "written by …" notes), store functions |
| table | sheet with a header rule | columns |
| service | box with a thick wall on its inbound side | endpoints as sockets on the wall; what's inside |
| transport / adapter | narrow throat (hourglass) | channels/methods passing through |
| queue | open-ended tray | waiting slots (empty: structure only) |
| worker | box with a toothed top | lanes of work being processed (empty unless a trace) |
| event-channel | a bus line with taps | the event name |
| external | cut-corner box with an inner border (not ours) | operations it receives |
| module / subsystem | folder tab | its parts |
| function / method / store-function | hexagonal chip | signature |
| command | notched ticket | — |
| state, schema/type, validator, query, class, file, test | register, tabbed card, funnel, rounded-left, compartments, dog-ear page, plain + stamp | fields / checks / cases |
| anything else | plain box, kind written on it ("flux-capacitor (no form of its own)") | its parts |

A form with nothing inside that the registry knows of is drawn compact — never an empty box pretending to
hold something. Which children a compartment shows (6 per compartment, then "+N more") is decided by
relevance to the view: on the path first, then wired to something drawn, then wired at all — so the IPC
service shows `canvas:execute`, not the first 6 of its 134 endpoints alphabetically.

### Relations (render/grammar.ts `GRAMMAR`) — never colour alone
calls solid + filled arrow · sends double line + arrow, gate mark where it crosses a runtime wall · handles
solid into a socket · writes heavy + bracket ending on the table it writes · reads thin, arrow back to the
reader, tap on the source · publishes dotted (round dots) + ring · consumes dotted from a ring · depends_on
hairline + bar · implements hairline + hollow triangle · verified_by hairline + tick · produces solid +
diamond · renders thin + open arrow · precedes chevrons · unknown kinds: thin line with the kind written.
Rolled-up edges say "N relations"; entering shows the finer ones.

### How we know, and where it stands (not by colour alone)
- code: filled square mark; solid lines.
- inferred: half-filled circle + "inferred 75%"; on lines a "≈" seal; inspector names the rule.
- interpretation: hollow diamond; dash-dot outline.
- proposed (view proposals, interpretations awaiting review, agent-chosen views): dashed outline/line + word.
- observed: filled slate circle; solid path line (vs dashed "possible path").
- status: changed = "Δ changed" tag + halo; stale = hatched + tag; missing = dotted outline + struck name;
  new = "new" tag + halo; unknown = hatched + "? not fully indexed".

### Levels of detail
- far (zoom < 0.42): silhouettes with their compartments as shapes, names held at a readable size above.
- mid: names and kinds in the head, the words on relations, stubs ("3 outside the view", "not indexed").
- near (≥ 0.8): every part labelled. Nothing is only reachable by zoom: Enter / double-click / "enter · N"
  / the outline list all go inside.
- entered: the component's casing grows into the frame (continuity transition: fly in, then the entered level
  opens exactly where the component was; reduced motion: instant + 120 ms fade); its compartments are regions;
  neighbours outside are portals at the frame edge in the direction they really lie; following one goes there.

### Layout
Deterministic: rank by longest path over flow-carrying relations (cycles broken at the returning edge, drawn
as a return), rows per runtime zone with parts placed under the neighbours they connect to, a side column for
shared code. Then pins win, then remembered positions; anything new is fitted into free space near where it
belongs. Routes are orthogonal, staggered in shared gaps, and step around parts.

### Paths
Stations sit on the part each step belongs to (on the exact chip when the step is an element inside a
component). Code paths are dashed and labelled "Possible path · derived from code"; recordings are solid,
"Observed", with where/when/by. Loops are drawn out and back with the guard as written in code; the failure
step gets an oxide ×. Play advances at an even pace that implies no timing; recorded times are shown as numbers.

## 3. What's built
- `src/shared/system/render/` — `buildScene(registry, resolved, state, inputs)` (pure, deterministic), scene
  types, forms, grammar, layout. Tests: `render.test.ts`.
- `src/renderer/system.html`, `system.tsx`, `features/system-canvas/` — the page: chooser (repos + labelled
  fixtures), lens presets (registry's `presetViews`), View-request harness (validated by `parseViewRequest`),
  stage (pan/zoom/drag-to-pin, keyboard: Tab/arrows/Enter/Esc/+/−/0), inspector (evidence with source excerpts
  and "changed since indexed", relations to follow, propose rename/reclassify), player, legend, outline list,
  freshness + coverage bars, light/dark, motion toggle, narrow-window sheets. Camera math and keyboard order
  are pure and tested (`ui.test.ts`).

## 4. Known gaps
- Entered levels with many internal calls (the client) are still busy; edge bundling would help.
- The overview of the canvas subsystem opens at ~30–40 % on a 1440 window: legible as names and silhouettes,
  internals need a zoom or Enter.
- Layout memory is kept per view in localStorage (ViewState has no field for it; see contract request).
- Port assignment is by side and part; there is no crossing minimisation across rows beyond barycentres.
