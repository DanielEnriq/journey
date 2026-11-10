// The registry rules, on a miniature app built by hand in the indexer's shapes (testkit.ts): each rule
// finds what it should, every derived thing carries evidence, and the same index always gives the same
// registry. `pnpm test` (or tsc to your own outDir, then node --test).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { relationKey, type SystemRegistry } from '../../shared/system/model.js';
import { validateRegistry } from '../../shared/system/registry-utils.js';
import { buildRegistry, RULES, RULES_VERSION } from './index.js';
import { boardIndex, IndexKit } from './testkit.js';

const reg = buildRegistry(boardIndex());
const E = reg.entities;
const rel = (from: string, kind: string, to: string) => reg.relations[relationKey(from, kind, to)];
const kids = (r: SystemRegistry, id: string) => Object.values(r.entities).filter((e) => e.parent === id).map((e) => e.id).sort();

describe('components are found by what code does', () => {
  test('a UI component with pointer handlers and SVG is an interface, named from its code', () => {
    const c = E['component:board-view'];
    assert.equal(c?.kind, 'interface');
    assert.equal(c.name, 'Board view');
    assert.equal(c.provenance, 'inferred');
    assert.ok(c.evidence.some((id) => reg.evidence[id].kind === 'rule' && reg.evidence[id].rule === 'role.interface'));
  });

  test('a class calling through an interface-typed field, with state, is a client; the interface is its transport', () => {
    const c = E['component:board-client'];
    assert.equal(c?.kind, 'client');
    assert.equal(E['transport:board-transport']?.parent, 'component:board-client');
    assert.deepEqual(E['transport:board-transport'].attrs.methods, ['load', 'onSaved', 'send']);
    assert.equal(E['state:board-client/pending']?.attrs.role, 'queue');
    assert.equal(E['state:board-client/store']?.attrs.role, 'store');
    assert.deepEqual(E['method:board-client/run'].attrs.roles, ['outgoing', 'pending']);
    assert.deepEqual(E['method:board-client/apply-saved'].attrs.roles, ['reconcile']);
    assert.deepEqual(E['method:board-client/constructor'].attrs.roles, ['subscribe']);
  });

  test('a function returning the transport is an adapter that implements it', () => {
    assert.equal(E['component:board-bridge-transport']?.kind, 'adapter');
    assert.equal(rel('component:board-bridge-transport', 'implements', 'transport:board-transport')?.provenance, 'code');
    assert.ok(rel('method:board-bridge-transport/send', 'implements', 'method:board-transport.send'));
  });

  test('a module invoking channels handled elsewhere is a bridge; one registering handlers is a service with endpoints', () => {
    assert.equal(E['component:preload-bridge']?.kind, 'adapter');
    assert.equal(E['component:main-ipc']?.kind, 'service');
    assert.equal(E['endpoint:board-send']?.parent, 'component:main-ipc');
    const sends = rel('component:preload-bridge', 'sends', 'endpoint:board-send');
    assert.equal(sends?.label, 'board:send');
    assert.equal(sends.provenance, 'code');
    assert.ok(rel('component:preload-bridge', 'sends', 'component:main-ipc')?.via?.includes(sends.id), 'the component relation rolls up the endpoint one');
  });

  test('endpoints are tied to the function that serves them, whose module is a service', () => {
    assert.equal(E['component:main-board']?.kind, 'service');
    assert.ok(rel('endpoint:board-send', 'handles', 'function:main-board/send-as-user'));
  });

  test('a call named like a channel goes through the bridge', () => {
    const r = rel('method:board-bridge-transport/send', 'calls', 'component:preload-bridge');
    assert.equal(r?.label, 'board:send');
    assert.equal(r.provenance, 'inferred');
    assert.ok(r.evidence.some((id) => reg.evidence[id].rule === 'relation.bridge-api'));
  });

  test('a dispatch table keyed by an interface\'s keys makes an engine with one command per key', () => {
    const eng = E['component:board-engine'];
    assert.equal(eng?.kind, 'engine');
    for (const k of ['sketch-line', 'erase-line', 'move']) assert.equal(E[`command:board-engine/${k}`]?.parent, eng.id);
    const draw = E['command:board-engine/sketch-line'];
    assert.equal(draw.summary, 'A stroke on the board.');
    assert.ok(draw.anchors.some((a) => a.symbol?.endsWith('#HANDLERS.sketch_line')), 'anchored at its handler');
    assert.equal(E['function:board-engine/apply-op']?.attrs.role, 'apply');
    assert.deepEqual(E['validator:board-engine/parse-op']?.attrs.raises, ['BoardError']);
    assert.equal(E['transport:board-store']?.parent, eng.id, 'the store interface the engine calls through is its boundary');
  });

  test('SQL tables and functions form the database; literal sites read and call them; SQL writes', () => {
    assert.equal(E['component:database']?.kind, 'store');
    assert.equal(E['table:boards']?.parent, 'component:database');
    assert.equal(E['column:boards.id']?.attrs.key, true);
    assert.equal(rel('store-function:save-board', 'writes', 'table:boards')?.provenance, 'code');
    assert.ok(rel('method:db-board-store/save', 'calls', 'store-function:save-board'));
    assert.equal(rel('method:db-board-store/load', 'reads', 'table:boards')?.label, 'boards');
    assert.ok(rel('component:db-board-store', 'calls', 'component:database'));
  });

  test('a hub that emits an event others subscribe to makes an event channel', () => {
    assert.equal(E['component:db-board-hub']?.kind, 'service');
    assert.ok(E['event-channel:saved']);
    assert.ok(rel('method:db-board-hub/send', 'publishes', 'event-channel:saved'));
    assert.ok(rel('component:main-ipc', 'consumes', 'event-channel:saved'));
  });

  test('interactions come from the mode union and its list, and produce the commands their branches run', () => {
    const sketch = E['interaction:board-view/sketch'];
    assert.equal(sketch?.parent, 'component:board-view');
    assert.equal(sketch.attrs.label, 'Sketch');
    assert.equal(sketch.attrs.key, 'p');
    assert.ok(rel('interaction:board-view/sketch', 'produces', 'command:board-engine/sketch-line'));
    assert.ok(rel('interaction:board-view/wipe', 'produces', 'command:board-engine/erase-line'));
    assert.ok(!kids(reg, 'component:board-view').includes('interaction:board-view/move'));
  });

  test('a file split between roles feeds several components; the feature word groups them across areas', () => {
    assert.ok(E['component:db-board-store'] && E['component:db-board-hub']);
    assert.equal(E['subsystem:board']?.kind, 'subsystem');
    for (const c of ['component:board-view', 'component:board-client', 'component:board-engine', 'component:main-board']) assert.equal(E[c].parent, 'subsystem:board', c);
    assert.equal(E['component:preload-bridge'].parent, 'area:preload');
    assert.ok(rel('subsystem:board', 'contains', 'component:board-client'));
  });

  test('tests verify the components they use and the commands they issue', () => {
    const t = Object.values(E).find((e) => e.kind === 'test')!;
    assert.equal(t.parent, 'component:board-engine');
    assert.ok(rel('component:board-engine', 'verified_by', t.id));
    assert.ok(rel('command:board-engine/sketch-line', 'verified_by', t.id));
  });
});

describe('code-derived sequences', () => {
  test('the command path follows the gesture through the boundary, bridge, channel and engine to the SQL write', () => {
    const s = reg.sequences['sequence:command-path:sketch-line'];
    assert.ok(s, Object.keys(reg.sequences).join(', '));
    assert.equal(s.kind, 'code-path');
    assert.equal(s.subject, 'command:board-engine/sketch-line');
    assert.deepEqual(s.steps.map((x) => x.entity), [
      'interaction:board-view/sketch', 'component:board-view', 'method:board-client/run', 'method:board-transport.send',
      'method:board-bridge-transport/send', 'component:preload-bridge', 'endpoint:board-send', 'function:main-board/send-as-user',
      'method:db-board-hub/send', 'function:board-engine/run-op', 'validator:board-engine/parse-op', 'function:board-engine/apply-op',
      'command:board-engine/sketch-line', 'method:board-store.save', 'method:db-board-store/save', 'store-function:save-board', 'table:boards',
    ]);
    for (const st of s.steps) assert.ok(st.evidence.length && st.evidence.every((id) => reg.evidence[id]), st.id);
    assert.equal(s.steps.find((x) => x.entity === 'endpoint:board-send')?.relation, relationKey('component:preload-bridge', 'sends', 'endpoint:board-send'));
    assert.match(s.notes![0], /possible path, not a recorded run/);
  });

  test('a loop around a save that can return null is a retry sequence, with the loop and branch in `next`', () => {
    const s = reg.sequences['sequence:save-retry'];
    assert.ok(s);
    const by = (label: RegExp) => s.steps.find((x) => label.test(x.label))!;
    const apply = by(/^applyOp/), saved = by(/^saved/), reload = s.steps.filter((x) => /^store\.load/.test(x.label))[1], busy = s.steps[s.steps.length - 1];
    const write = s.steps.find((x) => x.entity === 'table:boards')!;
    assert.deepEqual(write.next, [saved.id, reload.id], 'after the write: saved, or lost the race');
    assert.deepEqual(saved.next, []);
    assert.deepEqual(reload.next, [apply.id, busy.id], 'reload goes round again, or gives up');
    assert.equal(reload.guard, 'for (let i = 0; i < MAX_TRIES; i++)');
    assert.ok(reload.ctx?.includes('loop'));
    assert.match(s.notes![1], /MAX_TRIES = 3/);
  });
});

describe('the registry as a whole', () => {
  test('is whole: no dangling ids, every relation has evidence, rules named', () => {
    assert.deepEqual(validateRegistry(reg).filter((d) => d.severity === 'error'), []);
    assert.equal(reg.rules, RULES_VERSION);
    for (const e of Object.values(E)) if (e.provenance === 'inferred') assert.ok(e.evidence.some((id) => reg.evidence[id].kind === 'rule' && RULES[reg.evidence[id].rule!]), e.id);
    for (const ev of Object.values(reg.evidence)) if (ev.range && !ev.range.file.startsWith('db/')) assert.ok(ev.fileHash, ev.id);
  });

  test('is deterministic', () => {
    assert.equal(JSON.stringify(buildRegistry(boardIndex())), JSON.stringify(reg));
    const shuffled = boardIndex();
    shuffled.symbols.reverse(); shuffled.references.reverse(); shuffled.literals.reverse(); shuffled.flows.reverse();
    const again = buildRegistry(shuffled);
    assert.deepEqual(Object.keys(again.entities), Object.keys(reg.entities));
    assert.deepEqual(Object.keys(again.relations), Object.keys(reg.relations));
  });

  test('keeps ids when a file is renamed in place (the anchors survive)', () => {
    const moved = buildRegistry(boardIndex({ rename: { 'src/renderer/features/board/client.ts': 'src/renderer/features/board/board-client.ts' } }));
    const ids = (r: SystemRegistry) => Object.keys(r.entities).filter((id) => !id.startsWith('test:')).sort();
    assert.deepEqual(ids(moved), ids(reg));
    assert.equal(moved.entities['component:board-client'].anchors[0].file, 'src/renderer/features/board/board-client.ts');
  });

  test('says unknown for what rests only on files the index could not read', () => {
    const r = buildRegistry(boardIndex({ status: { 'db/schema.sql': 'error' } }));
    assert.equal(r.entities['table:boards'].status, 'unknown');
    assert.equal(r.entities['component:board-client'].status, 'current');
  });

  test('an index with nothing recognisable still gives a valid registry', () => {
    const k = new IndexKit().file('src/a.ts').sym('src/a.ts#f', 'function', 1, 3);
    const r = buildRegistry(k.build('tiny'));
    assert.equal(r.entities['system:tiny']?.kind, 'system');
    assert.deepEqual(validateRegistry(r).filter((d) => d.severity === 'error'), []);
  });
});
