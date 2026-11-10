import { REGISTRY_SCHEMA, VIEW_SCHEMA, relationKey, type Entity, type Lens, type Relation, type ResolvedView, type SystemRegistry, type ViewRequest, type ViewState } from '../model.js';

// A small hand-made registry shaped like Journey's canvas subsystem, for render tests only. It is a
// fixture: it says nothing about any repository and is labelled so.

type E = Partial<Entity> & Pick<Entity, 'id' | 'kind' | 'name'>;

const ent = (e: E): Entity => ({
  level: e.parent ? 'element' : 'component', anchors: [], attrs: {}, provenance: 'code', evidence: [], status: 'current', ...e,
});

export function testRegistry(): SystemRegistry {
  const es: Entity[] = [
    ent({ id: 'subsystem:canvas', kind: 'subsystem', name: 'Canvas', level: 'system' }),
    ent({ id: 'component:surface', kind: 'interface', name: 'Canvas surface', parent: 'subsystem:canvas', anchors: [{ file: 'src/renderer/features/canvas/CanvasSurface.tsx' }] }),
    ...['select', 'pan', 'circle', 'draw', 'erase', 'comment'].map((t) => ent({ id: `interaction:tool-${t}`, kind: 'interaction', name: t, parent: 'component:surface', anchors: [{ file: 'src/renderer/features/canvas/CanvasSurface.tsx' }] })),
    ent({ id: 'component:client', kind: 'client', name: 'Canvas client', parent: 'subsystem:canvas', anchors: [{ file: 'src/renderer/features/canvas/client.ts' }], provenance: 'inferred', confidence: 0.8 }),
    ent({ id: 'state:client-state', kind: 'state', name: 'CanvasState', parent: 'component:client', anchors: [{ file: 'src/renderer/features/canvas/client.ts' }] }),
    ent({ id: 'state:client-queue', kind: 'state', name: 'queue', parent: 'component:client', anchors: [{ file: 'src/renderer/features/canvas/client.ts' }] }),
    ent({ id: 'method:client-run', kind: 'method', name: 'run', parent: 'component:client', anchors: [{ file: 'src/renderer/features/canvas/client.ts' }] }),
    ent({ id: 'method:client-redraw', kind: 'method', name: 'redraw', parent: 'component:client', anchors: [{ file: 'src/renderer/features/canvas/client.ts' }] }),
    ent({ id: 'method:client-saved', kind: 'method', name: 'saved', parent: 'component:client', anchors: [{ file: 'src/renderer/features/canvas/client.ts' }] }),
    ent({ id: 'transport:ipc', kind: 'transport', name: 'ipcTransport', parent: 'component:client', anchors: [{ file: 'src/renderer/features/canvas/client.ts' }] }),
    ent({ id: 'component:bridge', kind: 'adapter', name: 'Preload bridge', parent: 'subsystem:canvas', anchors: [{ file: 'src/preload/index.cts' }], attrs: { channels: ['canvas:execute', 'canvas:load'] } }),
    ent({ id: 'component:ipc', kind: 'service', name: 'IPC handlers', parent: 'subsystem:canvas', anchors: [{ file: 'src/main/ipc.ts' }] }),
    ent({ id: 'endpoint:canvas-execute', kind: 'endpoint', name: 'canvas:execute', parent: 'component:ipc', anchors: [{ file: 'src/main/ipc.ts' }] }),
    ent({ id: 'component:hub', kind: 'service', name: 'Canvas hub', parent: 'subsystem:canvas', anchors: [{ file: 'src/integrations/supabase/canvas.ts' }] }),
    ent({ id: 'component:engine', kind: 'engine', name: 'Canvas engine', parent: 'subsystem:canvas', anchors: [{ file: 'src/shared/canvas/engine.ts' }] }),
    ...['draw', 'add_component', 'connect_components'].map((c) => ent({ id: `command:${c}`, kind: 'command', name: c, parent: 'component:engine', anchors: [{ file: 'src/shared/canvas/engine.ts' }] })),
    ent({ id: 'function:apply', kind: 'function', name: 'applyCommand', parent: 'component:engine', anchors: [{ file: 'src/shared/canvas/engine.ts' }] }),
    ent({ id: 'component:execute', kind: 'module', name: 'Store.execute', parent: 'subsystem:canvas', anchors: [{ file: 'src/shared/canvas/store.ts' }] }),
    ent({ id: 'function:execute', kind: 'function', name: 'execute', parent: 'component:execute', anchors: [{ file: 'src/shared/canvas/store.ts' }] }),
    ent({ id: 'store:db', kind: 'store', name: 'Canvas store', anchors: [{ file: 'supabase/migrations/20261028000000_room_canvas.sql' }] }),
    ent({ id: 'table:room-canvases', kind: 'table', name: 'room_canvases', parent: 'store:db', anchors: [{ file: 'supabase/migrations/20261028000000_room_canvas.sql' }], attrs: { columns: ['room_id', 'revision', 'document'] } }),
    ent({ id: 'table:room-canvas-ops', kind: 'table', name: 'room_canvas_ops', parent: 'store:db', anchors: [{ file: 'supabase/migrations/20261028000000_room_canvas.sql' }] }),
    ent({ id: 'fn:commit-canvas', kind: 'store-function', name: 'commit_canvas', parent: 'store:db', anchors: [{ file: 'supabase/migrations/20261028000000_room_canvas.sql' }] }),
  ];
  const rel = (from: string, kind: string, to: string, extra: Partial<Relation> = {}): Relation =>
    ({ id: relationKey(from, kind, to), kind, from, to, provenance: 'code', evidence: [], status: 'current', ...extra });
  const rs: Relation[] = [
    rel('component:surface', 'calls', 'method:client-run', { label: 'run' }),
    rel('method:client-run', 'writes', 'state:client-queue'),
    rel('method:client-run', 'calls', 'method:client-redraw'),
    rel('method:client-run', 'calls', 'transport:ipc', { label: 'execute' }),
    rel('method:client-saved', 'writes', 'state:client-state'),
    rel('method:client-redraw', 'calls', 'function:apply', { label: 'applyCommand' }),
    rel('transport:ipc', 'sends', 'component:bridge', { label: 'canvas.execute' }),
    rel('component:bridge', 'sends', 'endpoint:canvas-execute', { label: 'canvas:execute' }),
    rel('endpoint:canvas-execute', 'calls', 'component:hub', { label: 'executeAsPerson' }),
    rel('component:hub', 'calls', 'function:execute'),
    rel('function:execute', 'calls', 'function:apply'),
    rel('function:execute', 'writes', 'table:room-canvases', { label: 'commit_canvas' }),
    rel('function:execute', 'reads', 'table:room-canvases'),
    rel('fn:commit-canvas', 'writes', 'table:room-canvas-ops'),
    rel('component:hub', 'publishes', 'method:client-saved', { label: 'canvas:changed', provenance: 'inferred', confidence: 0.7 }),
  ];
  const r: SystemRegistry = {
    schema: REGISTRY_SCHEMA,
    revision: { repo: { id: 'test', name: 'test', root: '/test' }, head: null, branch: null, dirty: [], indexedAt: '2026-01-01T00:00:00Z', fingerprint: 'fp-test' },
    rules: 'test', entities: {}, relations: {}, evidence: {}, interpretations: {}, diagnostics: [],
    coverage: { byLang: {}, limits: [], diagnostics: {} }, incomplete: false,
    fixture: { label: 'Render test fixture', note: 'Hand-made; not an index of any repository.' },
    sequences: {
      'seq:draw': {
        id: 'seq:draw', title: 'A draw command', kind: 'code-path', provenance: 'code', evidence: [],
        steps: [
          { id: 's1', entity: 'component:surface', label: 'pointer up with the draw tool', evidence: [] },
          { id: 's2', entity: 'method:client-run', label: 'run("draw")', evidence: [] },
          { id: 's3', entity: 'transport:ipc', label: 'transport.execute', evidence: [] },
          { id: 's4', entity: 'endpoint:canvas-execute', label: 'canvas:execute', evidence: [] },
          { id: 's5', entity: 'function:execute', label: 'load → apply → commit', evidence: [] },
          { id: 's6', entity: 'table:room-canvases', label: 'commit', evidence: [], next: ['s5', 's7'], guard: 'revision === null', ctx: ['loop'] },
          { id: 's7', entity: 'method:client-saved', label: 'saved()', evidence: [] },
        ],
      },
    },
  };
  for (const e of es) r.entities[e.id] = e;
  for (const x of rs) r.relations[x.id] = x;
  return r;
}

export function request(lens: Lens, over: Partial<ViewRequest> = {}): ViewRequest {
  return { schema: VIEW_SCHEMA, id: `test-${lens}`, title: 'Test', question: 'How is it organised?', lens, focus: [], source: { kind: 'harness', id: 't', name: 'test' }, ...over };
}

/** A resolved view that includes every entity and relation (tests don't depend on view.ts). */
export function resolveAll(reg: SystemRegistry, req: ViewRequest): ResolvedView {
  const entities = Object.keys(reg.entities).sort();
  return { request: req, entities, relations: Object.keys(reg.relations).sort(), why: Object.fromEntries(entities.map((id) => [id, 'focus'])), missing: [], warnings: [] };
}

export function emptyState(view = 'v'): ViewState {
  return { view, seenFingerprint: '', entered: [], selection: null, cameras: {}, pinned: {}, expanded: [] };
}
