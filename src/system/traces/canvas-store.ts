import { performance } from 'node:perf_hooks';
import { command, type CanvasCommand } from '../../shared/canvas/commands.js';
import { ARCHITECTURE_VIEW, type Actor, type CanvasDocument } from '../../shared/canvas/model.js';
import { PAYMENT_SYSTEM } from '../../shared/canvas/fixtures/payment.js';
import { execute, memoryStore, type CanvasStore } from '../../shared/canvas/store.js';
import { TRACE_SCHEMA, type SystemRegistry, type Trace } from '../../shared/system/model.js';

// Recorded runs of Journey's real canvas code, for the failure and path lenses. Nothing here is
// simulated: `execute` from src/shared/canvas/store.ts runs against `memoryStore()`, wrapped by a store
// that writes down each call it receives and what came back. The revision conflict is real too: when the
// first actor's save arrives, the wrapper first lets a second actor run a whole command of their own
// through the same `execute`, so the first save genuinely finds the revision moved and gets null back.
//
// The only thing observed without going through the store is the moment each `applyCommand` starts:
// `execute` asks its `now()` clock right as it applies, so the clock is where that event is written.
//
// What this is not: production. There is no Supabase, no network and no IPC here; the trace says so.

const WHERE = 'Dev harness (src/system/traces/canvas-store.ts): Journey\'s shared canvas code run in Node against an in-memory store (memoryStore), not production or Supabase.';

/** The code each event is about, by index symbol id; mapped to registry entities when there is a registry. */
const SYMBOLS = {
  execute: 'src/shared/canvas/store.ts#execute',
  load: 'src/shared/canvas/store.ts#CanvasStore.load',
  commit: 'src/shared/canvas/store.ts#CanvasStore.commit',
  apply: 'src/shared/canvas/engine.ts#applyCommand',
  memory: 'src/shared/canvas/store.ts#memoryStore',
} as const;

type Event = Trace['events'][number];

const LEVEL_RANK: Record<string, number> = { code: 0, element: 1, component: 2, system: 3 };

/**
 * The registry entity that stands for a symbol: one anchored at exactly that symbol, the most specific
 * first; else one anchored at its container (`CanvasStore` for `CanvasStore.load`); else at its file.
 * Null when the registry has nothing there, and the event keeps the symbol id so it can be mapped later.
 */
export function entityForSymbol(registry: SystemRegistry | null, symbol: string): string | null {
  if (!registry) return null;
  const file = symbol.slice(0, symbol.indexOf('#'));
  const name = symbol.slice(symbol.indexOf('#') + 1);
  const container = name.includes('.') ? `${file}#${name.slice(0, name.lastIndexOf('.'))}` : null;
  const pick = (match: (a: { file: string; symbol?: string }) => boolean) => {
    const hits = Object.values(registry.entities).filter((e) => e.anchors.some(match));
    hits.sort((a, b) => (LEVEL_RANK[a.level] ?? 9) - (LEVEL_RANK[b.level] ?? 9) || a.anchors.length - b.anchors.length || a.id.localeCompare(b.id));
    return hits[0]?.id ?? null;
  };
  return pick((a) => a.symbol === symbol)
    ?? (container ? pick((a) => a.symbol === container) : null)
    ?? pick((a) => a.file === file && !a.symbol);
}

interface Recorder {
  events: Event[];
  note(symbol: string, label: string, data?: Event['data']): void;
}

function recorder(registry: SystemRegistry | null): Recorder {
  const t0 = performance.now();
  const events: Event[] = [];
  return {
    events,
    note(symbol, label, data = {}) {
      const at = Math.round((performance.now() - t0) * 1000) / 1000;
      const entity = entityForSymbol(registry, symbol);
      events.push({ at, entity: entity ?? symbol, label, data: { symbol, ...(entity ? {} : { unmapped: true }), ...data } });
    },
  };
}

const counts = (doc: CanvasDocument) => ({
  components: Object.keys(doc.components).length,
  annotations: Object.keys(doc.annotations).length,
});

/** Wraps a store so every load and commit is written down with what it returned. */
function instrumented(inner: CanvasStore, rec: Recorder, who: string, beforeCommit?: () => Promise<void>): CanvasStore {
  return {
    async load(roomId) {
      const c = await inner.load(roomId);
      rec.note(SYMBOLS.load, `${who}: load → revision ${c.revision}`, { actor: who, revision: c.revision, ...counts(c.doc) });
      return c;
    },
    async commit(roomId, base, doc, cmd, actor) {
      rec.note(SYMBOLS.commit, `${who}: commit on base revision ${base}`, { actor: who, base, command: cmd.name, ...counts(doc) });
      if (beforeCommit) { const run = beforeCommit; beforeCommit = undefined; await run(); }
      const revision = await inner.commit(roomId, base, doc, cmd, actor);
      rec.note(SYMBOLS.commit, revision === null ? `${who}: commit → null (someone saved first)` : `${who}: commit → revision ${revision}`,
        { actor: who, base, conflict: revision === null, ...(revision === null ? {} : { revision }) });
      return revision;
    },
  };
}

/** A clock that marks each `applyCommand` call, since `execute` reads it exactly then. */
function applyClock(rec: Recorder, who: string) {
  let attempt = 0;
  return () => {
    attempt++;
    rec.note(SYMBOLS.apply, `${who}: applyCommand (attempt ${attempt})`, { actor: who, attempt });
    return new Date().toISOString();
  };
}

const ADA: Actor = { kind: 'human', id: 'harness-ada', name: 'Ada (harness)' };
const BEN: Actor = { kind: 'human', id: 'harness-ben', name: 'Ben (harness)' };
const ROOM = 'harness-room';

async function run(rec: Recorder, store: CanvasStore, cmd: CanvasCommand, actor: Actor) {
  rec.note(SYMBOLS.execute, `${actor.name}: execute ${cmd.name}`, { actor: actor.name, command: cmd.name });
  const { result, canvas } = await execute(store, ROOM, cmd, actor, applyClock(rec, actor.name));
  rec.note(SYMBOLS.execute, result.ok ? `${actor.name}: ${cmd.name} ${result.applied} at revision ${result.revision}` : `${actor.name}: ${cmd.name} failed (${result.error.code})`, {
    actor: actor.name, ok: result.ok, ...(result.ok ? { applied: result.applied, revision: result.revision } : { error: result.error.code }), savedRevision: canvas.revision,
  });
  return result;
}

/** Seeds a room with the payment fixture system, outside the trace: the trace is about what comes after. */
async function seeded() {
  const inner = memoryStore();
  const r = await execute(inner, ROOM, command('load_system', PAYMENT_SYSTEM, 'harness-seed'), ADA);
  if (!r.result.ok) throw new Error(`Seeding the harness room failed: ${r.result.error.message}`);
  return inner;
}

export async function recordConflictTrace(registry: SystemRegistry | null, revision?: string): Promise<Trace> {
  const inner = await seeded();
  const rec = recorder(registry);
  // Ben's note goes in through the real `execute`, start to finish, after Ada applied and before her save lands.
  const ben = instrumented(inner, rec, BEN.name);
  const ada = instrumented(inner, rec, ADA.name, async () => {
    await run(rec, ben, command('annotate_component', { component: 'retry-queue', text: 'Retries must stay idempotent.' }, 'harness-ben-note'), BEN);
  });
  await run(rec, ada, command('add_failure', { component: 'payment-worker', mode: 'crash' }, 'harness-ada-failure'), ADA);
  return {
    schema: TRACE_SCHEMA,
    id: 'trace:canvas-store-conflict',
    title: 'A canvas command loses a save race and is re-applied',
    recorded: { at: new Date().toISOString(), where: WHERE, by: 'src/system/traces/canvas-store.ts' },
    ...(revision ? { revision } : {}),
    events: rec.events,
  };
}

export async function recordDrawTrace(registry: SystemRegistry | null, revision?: string): Promise<Trace> {
  const inner = await seeded();
  const rec = recorder(registry);
  await run(rec, instrumented(inner, rec, ADA.name), command('draw', { view: ARCHITECTURE_VIEW, kind: 'ink', d: 'M10 10 L80 40 L140 30' }, 'harness-ada-draw'), ADA);
  return {
    schema: TRACE_SCHEMA,
    id: 'trace:canvas-store-draw',
    title: 'A draw command saved through execute',
    recorded: { at: new Date().toISOString(), where: WHERE, by: 'src/system/traces/canvas-store.ts' },
    ...(revision ? { revision } : {}),
    events: rec.events,
  };
}

export async function recordCanvasTraces(registry: SystemRegistry | null, revision?: string): Promise<Trace[]> {
  return [await recordConflictTrace(registry, revision), await recordDrawTrace(registry, revision)];
}
