// Interpretations, snapshot diffs and status marking, on the hand-made fixture and the registry built from
// the miniature app (src/system/registry/testkit.ts).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildRegistry } from '../../system/registry/index.js';
import { boardIndex } from '../../system/registry/testkit.js';
import { PAYMENTS_FIXTURE } from './fixtures/index.js';
import { relationKey, type Interpretation } from './model.js';
import {
  applyInterpretations, diffRegistries, interpretationsFile, markStatus, parseInterpretation, parseInterpretationsFile,
  SystemInputError, validateRegistry,
} from './registry-utils.js';

const by = { kind: 'human' as const, id: 'u-dan', name: 'Daniel' };
const at = '2026-11-10T12:00:00.000Z';
const interp = (id: string, op: Interpretation['op'], status: Interpretation['status'] = 'accepted'): Interpretation => ({ id, op, by, at, status });
const reg = buildRegistry(boardIndex());

describe('interpretations', () => {
  test('accepted ones rename, classify, summarise, relate and group; each records itself on its target', () => {
    const out = applyInterpretations(reg, [
      interp('i1', { kind: 'rename', entity: 'component:board-client', name: 'Board session' }),
      interp('i2', { kind: 'classify', entity: 'component:main-board', as: 'worker' }),
      interp('i3', { kind: 'summarise', entity: 'component:board-engine', summary: 'Where every op is applied.' }),
      interp('i4', { kind: 'relate', from: 'component:board-view', to: 'component:database', relation: 'depends_on', label: 'reads boards' }),
      interp('i5', { kind: 'group', id: 'component:board-backend', name: 'Board backend', as: 'service', members: ['component:main-board', 'src/integrations/db/board.ts'] }),
    ]);
    assert.equal(out.entities['component:board-client'].name, 'Board session');
    assert.deepEqual(out.entities['component:board-client'].interpretations, ['i1']);
    assert.equal(out.entities['component:main-board'].kind, 'worker');
    assert.equal(out.entities['component:board-engine'].summary, 'Where every op is applied.');
    const r = out.relations[relationKey('component:board-view', 'depends_on', 'component:database')];
    assert.equal(r.provenance, 'interpretation');
    assert.equal(out.evidence[r.evidence[0]].kind, 'interpretation');
    assert.equal(out.entities['component:board-backend'].provenance, 'interpretation');
    for (const m of ['component:main-board', 'component:db-board-store', 'component:db-board-hub']) assert.equal(out.entities[m].parent, 'component:board-backend', m);
    assert.equal(out.entities['component:board-backend'].level, 'system');
    assert.deepEqual(validateRegistry(out).filter((d) => d.severity === 'error'), []);
  });

  test('proposed ones are recorded but change nothing until accepted; rejected targets are removed', () => {
    const out = applyInterpretations(reg, [
      interp('p1', { kind: 'rename', entity: 'component:board-client', name: 'Nope' }, 'proposed'),
      interp('r1', { kind: 'reject', target: 'event-channel:saved' }),
    ]);
    assert.equal(out.entities['component:board-client'].name, 'Board client');
    assert.deepEqual(out.entities['component:board-client'].interpretations, ['p1']);
    assert.equal(out.interpretations.p1.status, 'proposed');
    assert.equal(out.entities['event-channel:saved'], undefined);
    assert.ok(!Object.values(out.relations).some((x) => x.from === 'event-channel:saved' || x.to === 'event-channel:saved'));
    assert.deepEqual(validateRegistry(out).filter((d) => d.severity === 'error'), []);
  });

  test('an interpretation whose target vanished is orphaned and changes nothing', () => {
    const out = applyInterpretations(reg, [interp('o1', { kind: 'rename', entity: 'component:gone', name: 'Gone' })]);
    assert.equal(out.interpretations.o1.orphaned, true);
    assert.ok(out.diagnostics.some((d) => /o1 no longer resolves/.test(d.message)));
  });

  test('files round-trip, and bad input names its field', () => {
    const file = interpretationsFile('board-app', [interp('i1', { kind: 'rename', entity: 'component:board-client', name: 'X' })]);
    assert.deepEqual(parseInterpretationsFile(JSON.parse(JSON.stringify(file))), file);
    assert.throws(() => parseInterpretation({ id: 'x', op: { kind: 'rename', entity: 'not an id', name: 'x' }, by, at }), (e: SystemInputError) => e.path === 'interpretation.op.entity');
    assert.throws(() => parseInterpretation({ id: 'x', op: { kind: 'explode' }, by, at }), (e: SystemInputError) => e.path === 'interpretation.op.kind');
    assert.throws(() => parseInterpretationsFile({ schema: 'vowe.interpretations/1', interpretations: [file.interpretations[0], file.interpretations[0]] }), /duplicate id/);
  });
});

describe('revisions', () => {
  test('a diff names added, removed and changed entities and relations', () => {
    const idx = boardIndex();
    const s = idx.symbols.find((x) => x.id.endsWith('#BoardClient.run'))!;
    s.hash = 'changed';
    idx.symbols = idx.symbols.filter((x) => !x.id.includes('#HANDLERS.move'));
    const after = buildRegistry(idx);
    const d = diffRegistries(reg, after);
    assert.ok(d.entities.changed.includes('method:board-client/run'));
    assert.ok(!d.entities.removed.includes('command:board-engine/move'), 'the key is still declared, so the command stays');
    assert.ok(d.entities.changed.includes('command:board-engine/move'), 'but its handler anchor is gone');
    assert.deepEqual(diffRegistries(reg, reg), { from: reg.revision.fingerprint, to: reg.revision.fingerprint, entities: { added: [], removed: [], changed: [] }, relations: { added: [], removed: [], changed: [] } });
  });

  test('markStatus: changed, new, missing (kept from the previous snapshot), stale and unknown', () => {
    const before = buildRegistry(boardIndex());
    const idx = boardIndex();
    idx.symbols.find((x) => x.id.endsWith('#BoardClient.run'))!.hash = 'changed';
    idx.literals = idx.literals.filter((l) => l.literal !== 'saved');
    const after = buildRegistry(idx);
    const marked = markStatus(after, { diff: diffRegistries(before, after), previous: before, freshness: { changed: ['src/main/board.ts'] }, unreadable: ['db/schema.sql'] });
    assert.equal(marked.entities['method:board-client/run'].status, 'changed');
    assert.equal(marked.entities['event-channel:saved'].status, 'missing');
    assert.equal(marked.entities['component:main-board'].status, 'stale');
    assert.equal(marked.entities['table:boards'].status, 'unknown');
    assert.equal(marked.entities['component:board-view'].status, 'current');
    const removedFile = markStatus(after, { freshness: { changed: [], removed: ['src/main/board.ts'] } });
    assert.equal(removedFile.entities['component:main-board'].status, 'missing');
  });

  test('the fixture is labelled and whole', () => {
    assert.ok(PAYMENTS_FIXTURE.fixture?.label);
    assert.deepEqual(validateRegistry(PAYMENTS_FIXTURE).filter((d) => d.severity !== 'info'), []);
    for (const ev of Object.values(PAYMENTS_FIXTURE.evidence)) assert.ok(ev.range!.file.startsWith('fixture://') && ev.summary.startsWith('Fixture:'), ev.id);
  });
});
