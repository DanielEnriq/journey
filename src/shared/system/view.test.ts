// Views (parsing untrusted requests, resolving them), presets, the agent surface and the bridge to a room's
// canvas — on the miniature app's registry and the hand-made payments fixture.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseArgs } from '../canvas/commands.js';
import { applyCommand } from '../canvas/engine.js';
import { command } from '../canvas/commands.js';
import { emptyDocument } from '../canvas/model.js';
import { buildRegistry } from '../../system/registry/index.js';
import { boardIndex } from '../../system/registry/testkit.js';
import { catalog, fromAgentToolCall, SYSTEM_VIEW_TOOLS } from './agent.js';
import { toRoomCanvasSystem } from './bridge.js';
import { PAYMENTS_FIXTURE } from './fixtures/index.js';
import { LENSES, VIEW_SCHEMA, type ViewRequest } from './model.js';
import { SystemInputError } from './registry-utils.js';
import { changeReviewView, parseViewRequest, presetViews, resolveView } from './view.js';

const reg = buildRegistry(boardIndex());
const src = { kind: 'manual', id: 'me', name: 'Me' } as const;
const req = (over: Partial<ViewRequest>): ViewRequest => parseViewRequest({ schema: VIEW_SCHEMA, title: 'T', question: 'Q?', lens: 'organization', focus: [], source: src, ...over });
const path = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as SystemInputError).path; } return 'ok'; };

describe('view requests are validated', () => {
  test('a good request parses; defaults are filled', () => {
    const v = req({ focus: ['component:board-client'] });
    assert.equal(v.schema, VIEW_SCHEMA);
    assert.match(v.id, /^view:organization:/);
  });
  test('a bad field is named', () => {
    assert.equal(path(() => parseViewRequest({ title: 'T', question: 'Q', lens: 'sideways', focus: ['component:a'] })), 'view.lens');
    assert.equal(path(() => parseViewRequest({ title: 'T', question: 'Q', lens: 'path', focus: ['nope'] })), 'view.focus[0]');
    assert.equal(path(() => parseViewRequest({ title: 'T', question: 'Q', lens: 'path', focus: ['component:a'], depth: 7 })), 'view.depth');
    assert.equal(path(() => parseViewRequest({ title: 'T', question: 'Q', lens: 'path', focus: ['component:a'], x: 1 })), 'view');
    assert.equal(path(() => parseViewRequest({ title: 'T', question: 'Q', lens: 'path', focus: [] })), 'view.focus');
    assert.equal(path(() => parseViewRequest({ title: 'T', question: 'Q', lens: 'path', focus: ['component:a'], proposals: { entities: [{ id: 'component:x', kind: 'Bad Kind', name: 'x' }] } })), 'view.proposals.entities[0].kind');
  });
});

describe('views resolve against the registry', () => {
  test('focus, parents and neighbours at depth, each with why; missing ids reported', () => {
    const v = resolveView(reg, req({ focus: ['component:board-client', 'component:nope'], depth: 1 }));
    assert.equal(v.why['component:board-client'], 'focus');
    assert.equal(v.why['subsystem:board'], 'parent');
    assert.equal(v.why['component:board-view'], 'neighbour');
    assert.deepEqual(v.missing, ['component:nope']);
    assert.ok(!v.entities.includes('component:database'), 'two hops away');
    const deeper = resolveView(reg, req({ focus: ['component:board-client'], depth: 3 }));
    assert.ok(deeper.entities.length > v.entities.length);
    const flat = resolveView(reg, req({ focus: ['component:board-client'], depth: 0 }));
    assert.ok(!flat.entities.includes('component:board-view'));
    for (const r of v.relations) assert.ok(v.entities.includes(reg.relations[r].from) && v.entities.includes(reg.relations[r].to));
  });
  test('a sequence brings its steps; a bad step for failureAt is missing', () => {
    const v = resolveView(reg, req({ lens: 'failure', focus: [], sequence: 'sequence:save-retry', failureAt: 'r99' }));
    assert.ok(v.entities.includes('table:boards'));
    assert.equal(v.why['function:board-engine/apply-op'], 'sequence');
    assert.deepEqual(v.missing, ['r99']);
  });
  test('changed files bring the entities anchored in them; entering shows a component\'s insides', () => {
    const v = resolveView(reg, changeReviewView(reg, ['src/shared/board/engine.ts']));
    assert.equal(v.why['command:board-engine/sketch-line'], 'changed');
    const inside = resolveView(reg, req({ lens: 'interface-change', focus: [], enter: 'component:board-view' }));
    assert.equal(inside.why['interaction:board-view/sketch'], 'enter');
  });
  test('proposals are drawn as proposals', () => {
    const v = resolveView(reg, req({ focus: ['component:x-cache'], proposals: { entities: [{ id: 'component:x-cache', kind: 'store', name: 'Cache', parent: 'subsystem:board' }] as never, relations: [{ from: 'component:board-client', to: 'component:x-cache', kind: 'reads' }] as never } }));
    assert.equal(v.why['component:x-cache'], 'proposal');
    assert.ok(v.relations.includes('component:board-client--reads--component:x-cache'));
  });
});

describe('presets come from registry facts', () => {
  test('on the miniature app: every lens, around the subsystem with the most command-producing interactions', () => {
    const ps = presetViews(reg, { changed: ['src/main/board.ts'] });
    assert.deepEqual(ps.map((p) => p.lens), [...LENSES]);
    const byLens = Object.fromEntries(ps.map((p) => [p.lens, p]));
    assert.ok(byLens.organization.focus.includes('component:board-client') && byLens.organization.focus.includes('component:database'));
    assert.equal(byLens.path.sequence, 'sequence:command-path:sketch-line');
    assert.equal(byLens.failure.sequence, 'sequence:save-retry');
    assert.ok(byLens.dataflow.focus.includes('table:boards'));
    assert.equal(byLens['interface-change'].enter, 'component:board-view');
    for (const p of ps) { assert.equal(p.source.kind, 'preset'); assert.deepEqual(resolveView(reg, parseViewRequest(p)).missing, [], p.id); }
  });
  test('on a different system (the fixture): falls back to what its facts support', () => {
    const ps = presetViews(PAYMENTS_FIXTURE);
    assert.ok(ps.find((p) => p.lens === 'failure')?.sequence === 'sequence:webhook-retry');
    assert.ok(ps.find((p) => p.lens === 'organization'));
  });
});

describe('the agent surface', () => {
  test('the catalog lists ids, relations, sequences and presets compactly', () => {
    const c = catalog(reg);
    assert.ok(c.entities.some((e) => e.id === 'component:board-client' && e.kind === 'client'));
    assert.ok(!c.entities.some((e) => e.level === 'code'));
    assert.ok(c.relations.some(([f, k, t]) => f === 'component:preload-bridge' && k === 'sends' && t === 'component:main-ipc'));
    assert.ok(c.sequences.some((s) => s.id === 'sequence:save-retry'));
    assert.equal(catalog(reg, { maxEntities: 3 }).truncated?.listed, 3);
  });
  test('tool calls come back validated, as the agent\'s', () => {
    assert.deepEqual(SYSTEM_VIEW_TOOLS.map((t) => t.name), ['show_system_view', 'propose_relation', 'propose_entity']);
    const v = fromAgentToolCall('show_system_view', { title: 'Save path', question: 'How is a stroke saved?', lens: 'path', focus: ['command:board-engine/sketch-line'], sequence: 'sequence:command-path:sketch-line' }, { agent: { id: 'vowe', name: 'Vowe' } });
    assert.equal(v.kind, 'view');
    assert.equal(v.request.source.kind, 'agent');
    assert.deepEqual(resolveView(reg, v.request).missing, []);
    const p = fromAgentToolCall('propose_relation', { from: 'component:board-view', to: 'component:database', relation: 'reads', rationale: 'Thumbnails' }, { now: '2026-11-10T00:00:00Z' });
    assert.equal(p.kind, 'proposal');
    assert.equal(p.kind === 'proposal' && p.interpretation?.status, 'proposed');
    const e = fromAgentToolCall('propose_entity', { id: 'component:board-cache', kind: 'store', name: 'Board cache', relations: [{ to: 'component:board-client', relation: 'reads', direction: 'in' }] });
    assert.equal(e.request.proposals?.entities?.[0].provenance, 'proposed');
    assert.equal(e.request.proposals?.relations?.[0].from, 'component:board-client');
    assert.equal(path(() => fromAgentToolCall('show_system_view', { title: 'x', question: 'y', lens: 'path', focus: ['component:a'], source: { kind: 'manual' } })), 'input.source');
    assert.equal(path(() => fromAgentToolCall('propose_relation', { from: 'component:a', to: 'component:b', relation: 'loves' })), 'input.relation');
    assert.equal(path(() => fromAgentToolCall('delete_everything', {})), 'name');
  });
});

describe('the bridge to a room canvas', () => {
  test('a resolved view becomes load_system arguments the room canvas accepts and applies', () => {
    for (const [name, r] of [['board', reg], ['fixture', PAYMENTS_FIXTURE]] as const) {
      for (const p of presetViews(r, { changed: ['src/main/board.ts'] })) {
        const args = toRoomCanvasSystem(r, resolveView(r, p), { replace: true });
        assert.doesNotThrow(() => parseArgs('load_system', args), `${name} ${p.id}`);
        const applied = applyCommand(emptyDocument(), command('load_system', parseArgs('load_system', args), 'cmd-test-1'), { kind: 'human', id: 'u', name: 'U' }, '2026-11-10T00:00:00.000Z');
        assert.ok(Object.keys(applied.doc.components).length >= 1, `${name} ${p.id}`);
      }
    }
    const org = toRoomCanvasSystem(reg, resolveView(reg, presetViews(reg)[0]));
    const db = org.components.find((c) => c.kind === 'database');
    assert.ok(db?.rows?.[1]?.[0] === 'boards' || db, 'the database comes across as a database');
    assert.ok(org.relationships.some((x) => x.kind === 'reads_writes' || x.kind === 'calls'));
  });
});
