# Vowe's system canvas

The system canvas draws a real software system as a place you can enter. It is built from what the code
establishes, never from a hand-drawn diagram. Journey is the first system it describes. The visual language is
explained in [DESIGN.md](DESIGN.md).

```
repository ──index──▶ RepoIndex ──rules──▶ SystemRegistry ──question──▶ ViewRequest ─resolve─▶ ResolvedView
 (files on disk)       facts           entities, relations,     (lens + focus ids;        │
                                       evidence, sequences,      agent / preset /          ▼
                                       interpretations           person / harness)   buildScene ──▶ SystemScene ──▶ canvas
                                                                                          ▲
                                                               recorded runs (Trace) ─────┘
```

Each layer has its own contract in `src/shared/system/model.ts` and is kept apart. That way the same system
can be drawn many ways without anyone claiming its structure changed.

| Layer | What it holds | Where |
|---|---|---|
| **Index** `vowe.index/1` | What the tooling established about one revision: files and hashes, symbols, imports, references resolved by the type checker, string-literal call sites (channels, tables, commands), string comparisons (`tool === 'draw'`), ordered call flows with loop/branch context, SQL tables, columns, functions and their reads/writes. Also coverage and limits, `incomplete`, and the revision (head, branch, dirty files, fingerprint). | `src/system/indexer/` (Node; TypeScript 5 compiler API as `typescript-api`, plus a small SQL reader) |
| **Registry** `vowe.registry/1` | Typed entities at four levels (system → component → element → code) linked by `parent`, typed relations, evidence records, code-derived sequences, reviewable interpretations, diagnostics, and a status per entity. | `src/system/registry/` (39 named rules); helpers in `src/shared/system/registry-utils.ts` |
| **View** `vowe.system-view/1` | A question, a lens and the ids that matter. It never carries coordinates. `resolveView` checks every id and records why each entity is on the canvas. | `src/shared/system/view.ts` |
| **Scene** `vowe.system-scene/1` | One level of a view, drawn deterministically: forms, compartments, ports, edges in the relation grammar, portals to neighbours, sequence stations, zones. | `src/shared/system/render/` (pure, no DOM) |
| **Trace** `vowe.trace/1` | Events recorded during a real run. Kept separate from code-derived sequences. | `src/system/traces/` |
| **Host** | `SystemApi`: repositories, open/index, freshness, refresh, source excerpts, fixtures, saved views, interpretations, traces. | `src/shared/system/api.ts`; `src/system/service.ts`; dev server `src/system/server/`; Electron `src/main/system-canvas.ts` |
| **Canvas** | The page: choosing a repository, lenses, the view-request harness, the stage, the inspector, the sequence player, freshness, coverage, legend and outline. | `src/renderer/system.html`, `src/renderer/features/system-canvas/` |

## Running it

```bash
pnpm system:serve
```

This builds into `dist/` and serves `http://127.0.0.1:4870/`. It binds to loopback only, and `PORT` changes the
port. To build somewhere else and leave `dist/` alone, run `node scripts/system-canvas/build.mjs --out <dir>` and then
`node scripts/system-canvas/serve.mjs --dist <dir>`. Add other repositories with `--repo <path>` (repeatable).
`VOWE_SYSTEM_HOME` decides where indexes, saved views, interpretations and traces are kept; the default is
`~/.vowe/system`. In the app, the canvas opens from **Developer ▸ System canvas** (macOS menu) through `system:*`
IPC.

Nothing needs a model provider or an API key.

## How we know: provenance and status

Every entity and relation names how it is known, and the canvas draws the difference. Colour is never the only
signal.

- **code**: an index fact establishes it directly, for example a resolved call, a SQL `insert into`, or a
  `handle('canvas:execute')` matched with `invoke('canvas:execute')`.
- **inferred**: a named rule decided it from code facts, for example "a class that holds a field typed by an
  interface whose methods it calls is a client of that boundary". The rule's id, its wording and a confidence
  value are part of the evidence.
- **interpretation**: a person or an agent asserted it (rename, classify, group, relate, reject). It is stored
  per repository (`vowe.interpretations/1`), re-applied on every rebuild, and marked `orphaned` if its target
  disappears.
- **proposed**: it is not in the code. It is part of a suggested change.
- **observed**: it was seen in a recorded trace.

Status is measured against the working tree. `stale` means files changed on disk and the index hasn't been
refreshed yet. `changed`, `new` and `missing` come from the diff after a refresh. `unknown` means the files
couldn't be fully indexed.

Every piece of evidence carries a source range and the hash of the file it was read from. The inspector shows the
current excerpt and warns when the file has changed since it was indexed.

## Identity across levels

Entity ids come from what an entity stands for, not where it is drawn. For example, `component:canvas-client`,
`interaction:canvas-surface/draw`, `command:canvas-engine/draw` and `table:room-canvases` stay the same while
their anchor symbols survive. A rename in place keeps the id, and a renamed file is tracked through `moved`
symbols.

- The scene uses the registry id as the node id at every level. The `draw` command inside the engine's
  near-view tickets is the same node you select after entering the engine, and it keeps its evidence and
  selection.
- Entering a component lays its internals out in its own frame. Its neighbours stay at the edges, in the
  direction they really lie, as portals you can follow.
- Leaving restores the outer level's camera and keeps the selection.
- Layout memory and pins are saved with the view (`ViewState.layout`, `ViewState.pinned`). Positions that
  are already placed are kept, and new entities go into free space.

## Lenses: composing a view around a question

| Lens | Question | What leads |
|---|---|---|
| `organization` | How is it organised? | Components in runtime zones, composition, and relations rolled up with `via` |
| `path` | How does something travel? | A sequence, drawn as stations on the exact parts (elements inside components included) |
| `failure` | What happens when it goes wrong? | The sequence's loop and branch, with guards copied from code, plus recorded traces when they exist |
| `dataflow` | Where does information move? | Stores, tables, and the reads and writes that reach them |
| `interface-change` | What supports this interface? | The interface entered, its interactions, and the commands and callees they produce |
| `change-review` | What does this change touch? | Entities anchored in the changed files, marked with their evidence |

`presetViews(registry)` finds the presets with generic queries, never by name. For example, it picks the
subsystem with the most command-producing interactions, or a sequence whose `next` loops back. On a repository
where no query matches, it falls back to the largest subsystem.

**Motion is tied to evidence.** A `code-path` sequence is labelled *possible path, derived from code*. A
`trace` is labelled *observed*, with where, when and by whom it was recorded. Journey's recorded traces come from
actually running `execute()` from `src/shared/canvas/store.ts` against an in-memory store, with a second
actor saving first. They are a real revision conflict in the dev harness, not production. Playback can be
paused, stepped, replayed and scrubbed, and it respects reduced motion.

## For a coding agent (future)

The agent never draws. It chooses what to render.

1. Read `catalog(registry)` (`src/shared/system/agent.ts`). This is compact JSON listing entity ids, kinds,
   names, parents and provenance, the relations as `[from, kind, to, label?]`, the sequences, the lenses and the
   presets.
2. Call one of `SYSTEM_VIEW_TOOLS`:
   - `show_system_view`: a ViewRequest-shaped input with title, question, lens, focus ids, and optionally
     sequence, enter and changed.
   - `propose_relation`
   - `propose_entity`
3. Pass the tool call through `fromAgentToolCall(name, input)`. It validates the call like untrusted input and
   names the field that is wrong. The resulting request has `source.kind = 'agent'` and is drawn as the agent's
   proposal. Proposed entities and relations are dashed until a person keeps them.
4. Resolve and render it: `resolveView(registry, request)`, then `buildScene(registry, resolved, state)`.
   Requested ids the registry doesn't have come back in `missing` and are drawn as ghosts. They are never
   invented.

The canvas's **View request** panel is this contract by hand. Paste or edit the JSON an agent would send, see
validation errors, and apply it.

**Placing a selection on a room's existing canvas.** `toRoomCanvasSystem(registry, resolved)`
(`src/shared/system/bridge.ts`) turns a resolved view into arguments for the room canvas's existing
`load_system` command. A registry selection can therefore go onto a room through the current Canvas Command API,
CAS save and permissions, with no change to the `vowe.canvas/1` schema or the database.

## The existing room canvas

The room canvas is unchanged: `vowe.canvas/1`, its 20 commands, `commit_canvas`, realtime and presence. The
system canvas reads Journey's canvas code as its first subject and keeps its own state outside the room
document. Saved views and interpretations are files under `VOWE_SYSTEM_HOME`. No database migration was
needed.

## Limits

- **Index:**
  - CSS, HTML, JSON and Markdown are listed but not parsed.
  - Dynamic dispatch (`HANDLERS[cmd.name]`), calls through `any` and dynamic SQL are not resolved. The registry
    links commands to handlers with the `engine.commands` rule, which is inferred and says so.
  - Refresh re-indexes the whole repository (about 15 s for Journey). Reopening an unchanged tree loads from
    the cache in about 60 ms.
  - The full index covers TypeScript/JavaScript and Supabase migrations; other languages get file-level
    coverage only.
- **Registry:**
  - Breadth outside the canvas subsystem is shallow. There are many small adapters and services, and engines
    are detected only as tables of handler functions.
  - Feature subsystems are grouped by a shared word (`canvas`), so a few neighbours join them.
  - In Journey, only `draw` gets a full command path. Circle's `run('draw')` sits under a `d.mode !== 'marquee'`
    branch, and erase issues its command through a local helper. Both are still linked to commands by the
    weaker `relation.issues` rule.
- **Runtime zones** (renderer, preload, main, cloud, shared) are inferred from file paths and labelled that way.
- **Traces:** only Journey's canvas store can record traces, in the dev harness.
- **Live counts:** queues and pending trays are drawn empty unless a trace fills them; there are no live counts
  or timings.
- **Electron:** the window, IPC and preload wiring are typechecked but were not run here. `better-sqlite3`
  couldn't be rebuilt for Electron in this environment. Everything else was exercised in Chromium through the
  dev server.
