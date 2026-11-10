import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { REGISTRY_SCHEMA, TRACE_SCHEMA, type Entity, type SystemRegistry } from '../../shared/system/model.js';
import { entityForSymbol, recordConflictTrace, recordDrawTrace } from './canvas-store.js';

// The harness really runs src/shared/canvas/store.ts's `execute`; these check what it saw.

const entity = (id: string, level: Entity['level'], anchors: Entity['anchors']): Entity =>
  ({ id, kind: 'function', name: id, level, anchors, attrs: {}, provenance: 'code', evidence: [], status: 'current' });

const registry: SystemRegistry = {
  schema: REGISTRY_SCHEMA,
  revision: { repo: { id: 'journey', name: 'journey', root: '/' }, head: null, branch: null, dirty: [], indexedAt: '', fingerprint: 'f' },
  rules: 'test', relations: {}, evidence: {}, sequences: {}, interpretations: {}, diagnostics: [],
  coverage: { byLang: {}, limits: [], diagnostics: {} }, incomplete: false,
  entities: Object.fromEntries([
    entity('component:canvas-store', 'component', [{ file: 'src/shared/canvas/store.ts' }]),
    entity('element:execute', 'element', [{ file: 'src/shared/canvas/store.ts', symbol: 'src/shared/canvas/store.ts#execute' }]),
    entity('code:execute', 'code', [{ file: 'src/shared/canvas/store.ts', symbol: 'src/shared/canvas/store.ts#execute' }]),
    entity('interface:canvas-store', 'element', [{ file: 'src/shared/canvas/store.ts', symbol: 'src/shared/canvas/store.ts#CanvasStore' }]),
    entity('store:memory', 'component', [{ file: 'src/shared/canvas/store.ts', symbol: 'src/shared/canvas/store.ts#memoryStore' }]),
    entity('method:memory-commit', 'element', [{ file: 'src/shared/canvas/store.ts', symbol: 'src/shared/canvas/store.ts#memoryStore.commit' }]),
    entity('engine:apply', 'element', [{ file: 'src/shared/canvas/engine.ts', symbol: 'src/shared/canvas/engine.ts#applyCommand' }]),
  ].map((e) => [e.id, e])),
};

describe('canvas store traces', () => {
  test('entities are found by the symbols they are anchored at, most specific first', () => {
    assert.equal(entityForSymbol(registry, 'src/shared/canvas/store.ts#execute'), 'code:execute');
    assert.equal(entityForSymbol(registry, 'src/shared/canvas/store.ts#CanvasStore.commit'), 'interface:canvas-store', 'falls back to the container');
    assert.equal(entityForSymbol(registry, 'src/shared/canvas/store.ts#memoryStore.load'), 'store:memory', 'falls back to the container');
    assert.equal(entityForSymbol(registry, 'src/shared/canvas/store.ts#MAX_ATTEMPTS'), 'component:canvas-store', 'falls back to the file');
    assert.equal(entityForSymbol(registry, 'src/nowhere.ts#x'), null);
    assert.equal(entityForSymbol(null, 'src/shared/canvas/store.ts#execute'), null);
  });

  test('a real revision conflict: the first commit gets null, the re-applied command saves', async () => {
    const trace = await recordConflictTrace(registry, 'rev');
    assert.equal(trace.schema, TRACE_SCHEMA);
    assert.match(trace.recorded.where, /in-memory store/);
    assert.match(trace.recorded.where, /not production or Supabase/);
    const ada = trace.events.filter((e) => e.data?.actor === 'Ada (harness)');
    const commits = ada.filter((e) => e.data?.via === 'src/shared/canvas/store.ts#CanvasStore.commit' && 'conflict' in (e.data ?? {}));
    assert.deepEqual(commits.map((e) => [e.data?.base, e.data?.conflict, e.data?.revision ?? null]), [[1, true, null], [2, false, 3]]);
    assert.deepEqual(ada.filter((e) => e.data?.symbol === 'src/shared/canvas/store.ts#memoryStore.load').map((e) => e.data?.revision), [1, 2], 'reloaded after the lost race');
    assert.deepEqual(ada.filter((e) => e.label.includes('applyCommand')).map((e) => e.data?.attempt), [1, 2]);
    const done = ada[ada.length - 1];
    assert.equal(done.data?.ok, true);
    assert.equal(done.data?.applied, 'applied');
    assert.equal(done.data?.revision, 3);
    // Ben's whole command ran between Ada's first commit call and its answer.
    const labels = trace.events.map((e) => e.label);
    const benSaved = labels.indexOf('Ben (harness): commit → revision 2');
    assert.ok(benSaved > labels.indexOf('Ada (harness): commit on base revision 1'));
    assert.ok(benSaved < labels.indexOf('Ada (harness): commit → null (someone saved first)'));
    // Times come from the clock and only go forward.
    for (let i = 1; i < trace.events.length; i++) assert.ok(trace.events[i].at >= trace.events[i - 1].at);
    // Events are mapped to registry entities where it has them, and say so where it doesn't.
    assert.equal(trace.events[0].entity, 'code:execute');
    assert.ok(trace.events.some((e) => e.entity === 'engine:apply'));
    assert.ok(trace.events.some((e) => e.entity === 'method:memory-commit'), 'commits are the in-memory store that ran');
    assert.ok(trace.events.some((e) => e.entity === 'store:memory'), 'loads fall back to the in-memory store');
    assert.ok(trace.events.filter((e) => e.data?.unmapped).every((e) => e.entity === e.data?.symbol));
  });

  test('a draw command saves through execute', async () => {
    const trace = await recordDrawTrace(null);
    const last = trace.events[trace.events.length - 1];
    assert.equal(last.data?.ok, true);
    assert.equal(last.data?.revision, 2);
    assert.ok(trace.events.every((e) => e.data?.unmapped === true), 'no registry, nothing mapped');
  });
});
