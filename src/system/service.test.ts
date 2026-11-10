import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { SavedView } from '../shared/system/api.js';
import {
  INDEX_SCHEMA, REGISTRY_SCHEMA, VIEW_SCHEMA,
  type Entity, type IndexDiff, type Interpretation, type RegistryDiff, type RepoIndex, type SystemRegistry,
} from '../shared/system/model.js';
import { createSystemService, type SystemEngine } from './service.js';
import { contentHash } from './store/source.js';

// The host against a real temporary git repository, with a small stand-in for the indexer and the
// registry (one entity per file) so these tests pin down what the host does: caching, freshness,
// refresh and its diffs, statuses, confinement, and what it saves. service.engine.test.ts runs the same
// host with the real indexer and registry.

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

function walk(root: string, dir = ''): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.name === '.git') return [];
    return e.isDirectory() ? walk(root, rel) : e.isFile() ? [rel] : [];
  }).sort();
}

/** One entity per file, anchored at it; enough to see the host route changes to entities. */
function fakeEngine(calls: string[]): SystemEngine {
  const head = (root: string) => { try { return git(root, 'rev-parse', 'HEAD'); } catch { return null; } };
  const index = (root: string): RepoIndex => {
    const files = walk(root).map((path) => {
      const text = readFileSync(join(root, path));
      return { path, lang: 'ts' as const, hash: contentHash(text), size: text.length, lines: text.toString().split('\n').length, status: 'indexed' as const };
    });
    const fingerprint = contentHash(files.map((f) => `${f.path}:${f.hash}`).join('\n'));
    return {
      schema: INDEX_SCHEMA,
      revision: { repo: { id: 'fixture', name: 'fixture', root }, head: head(root), branch: null, dirty: [], indexedAt: new Date().toISOString(), fingerprint },
      tools: { fake: '1' }, files, symbols: [], imports: [], references: [], literals: [], comparisons: [], flows: [],
      coverage: { byLang: {}, limits: ['stand-in engine for tests'], diagnostics: {} }, incomplete: false,
    };
  };
  const ids = (xs: string[]) => [...xs].sort();
  return {
    async index(root) { calls.push('index'); return index(root); },
    async scan(root, prev) {
      calls.push('scan');
      const now = index(root);
      const before = new Map(prev.files.map((f) => [f.path, f.hash]));
      const after = new Map(now.files.map((f) => [f.path, f.hash]));
      const changed = [...new Set([...before.keys(), ...after.keys()])].filter((p) => before.get(p) !== after.get(p));
      return { fingerprint: now.revision.fingerprint, changed, headMoved: now.revision.head !== prev.revision.head };
    },
    async refresh(root) { calls.push('refresh'); return index(root); },
    diffIndexes(a, b): IndexDiff {
      const am = new Map(a.files.map((f) => [f.path, f.hash])), bm = new Map(b.files.map((f) => [f.path, f.hash]));
      return {
        from: a.revision.fingerprint, to: b.revision.fingerprint,
        files: { added: ids([...bm.keys()].filter((p) => !am.has(p))), removed: ids([...am.keys()].filter((p) => !bm.has(p))), changed: ids([...bm.keys()].filter((p) => am.has(p) && am.get(p) !== bm.get(p))) },
        symbols: { added: [], removed: [], changed: [], moved: {} },
      };
    },
    build(idx, interpretations): SystemRegistry {
      calls.push('build');
      const entities: Record<string, Entity> = {};
      for (const f of idx.files) {
        const id = `file:${f.path}`;
        entities[id] = { id, kind: 'file', name: f.path, level: 'code', anchors: [{ file: f.path, hash: f.hash }], attrs: {}, provenance: 'code', evidence: [], status: 'current' };
      }
      for (const i of interpretations) if (i.op.kind === 'rename' && entities[i.op.entity] && i.status !== 'rejected') {
        entities[i.op.entity] = { ...entities[i.op.entity], name: i.op.name, interpretations: [i.id] };
      }
      return {
        schema: REGISTRY_SCHEMA, revision: idx.revision, rules: 'fake/1', entities, relations: {}, evidence: {}, sequences: {},
        interpretations: Object.fromEntries(interpretations.map((i) => [i.id, i])), diagnostics: [], coverage: idx.coverage, incomplete: false,
      };
    },
    diffRegistries(a, b): RegistryDiff {
      const changed = Object.keys(b.entities).filter((id) => a.entities[id] && a.entities[id].anchors[0].hash !== b.entities[id].anchors[0].hash);
      return {
        from: a.revision.fingerprint, to: b.revision.fingerprint,
        entities: { added: ids(Object.keys(b.entities).filter((id) => !a.entities[id])), removed: ids(Object.keys(a.entities).filter((id) => !b.entities[id])), changed: ids(changed) },
        relations: { added: [], removed: [], changed: [] },
      };
    },
    mark(next, diff, prev) {
      const entities = { ...next.entities };
      for (const id of diff.entities.added) entities[id] = { ...entities[id], status: 'new' };
      for (const id of diff.entities.changed) entities[id] = { ...entities[id], status: 'changed' };
      for (const id of diff.entities.removed) entities[id] = { ...prev.entities[id], status: 'missing' };
      return { ...next, entities };
    },
    fixtures: () => [{ id: 'fixture:shop', label: 'Fixture: a made-up shop' }],
    fixture: (id) => id === 'fixture:shop' ? { ...shopFixture() } : null,
  };
}
const shopFixture = (): SystemRegistry => ({
  schema: REGISTRY_SCHEMA, revision: { repo: { id: 'shop', name: 'shop', root: '' }, head: null, branch: null, dirty: [], indexedAt: '', fingerprint: 'f' },
  rules: 'fixture', entities: {}, relations: {}, evidence: {}, sequences: {}, interpretations: {}, diagnostics: [],
  coverage: { byLang: {}, limits: [], diagnostics: {} }, incomplete: false, fixture: { label: 'Fixture', note: 'hand-made' },
});

let root: string;
let home: string;
let outside: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'vowe-repo-'));
  home = mkdtempSync(join(tmpdir(), 'vowe-home-'));
  outside = mkdtempSync(join(tmpdir(), 'vowe-outside-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\nexport function f() {\n  return a;\n}\n');
  writeFileSync(join(root, 'src', 'b.ts'), 'export const b = 2;\n');
  writeFileSync(join(outside, 'secret.txt'), 'not yours\n');
  git(root, 'init', '-q');
  git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
  git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
});
after(() => { for (const d of [root, home, outside]) rmSync(d, { recursive: true, force: true }); });

describe('system service', () => {
  test('open indexes, a reopen with an unchanged tree hits the cache, edits show as stale then changed', async () => {
    const calls: string[] = [];
    const service = createSystemService({ home, repos: [root], engine: fakeEngine(calls), recordTraces: false });
    const [repo] = await service.repos();
    assert.equal(repo.root, root);
    assert.equal(repo.indexed, undefined);

    const first = await service.open(repo.id);
    assert.equal(service.lastOpen(repo.id), 'indexed');
    assert.equal(first.summary.files, 2);
    assert.ok(existsSync(join(home, 'repos', repo.id, 'index.json')));

    // A new host (as after a restart) finds the cache, checks the tree, and doesn't re-index.
    const calls2: string[] = [];
    const again = createSystemService({ home, repos: [root], engine: fakeEngine(calls2), recordTraces: false });
    assert.equal((await again.repos())[0].indexed?.fingerprint, first.summary.revision.fingerprint, 'repos() reports the cached revision');
    const reopened = await again.open(repo.id);
    assert.equal(again.lastOpen(repo.id), 'cache');
    assert.deepEqual(calls2, ['scan'], 'no index, no rebuild');
    assert.equal(reopened.registry.revision.fingerprint, first.registry.revision.fingerprint);
    assert.equal((reopened.summary as { cached?: boolean }).cached, true);

    // Edit a file: freshness reports it and the entities anchored there, without re-indexing.
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 3;\n');
    const fresh = await again.freshness(repo.id);
    assert.deepEqual(fresh.changed, ['src/a.ts']);
    assert.deepEqual(fresh.staleEntities, ['file:src/a.ts']);
    assert.equal(fresh.headMoved, false);
    assert.notEqual(fresh.fingerprint, first.summary.revision.fingerprint);

    // Refresh: the index and registry diffs name the change, and the entity is marked changed.
    const refreshed = await again.refresh(repo.id);
    assert.deepEqual(refreshed.indexDiff.files.changed, ['src/a.ts']);
    assert.deepEqual(refreshed.registryDiff.entities.changed, ['file:src/a.ts']);
    assert.equal(refreshed.registry.entities['file:src/a.ts'].status, 'changed');
    assert.equal(refreshed.registry.entities['file:src/b.ts'].status, 'current');
    assert.deepEqual((await again.freshness(repo.id)).changed, [], 'fresh after refresh');

    // Delete a file and add one: missing and new.
    rmSync(join(root, 'src', 'b.ts'));
    writeFileSync(join(root, 'src', 'c.ts'), 'export const c = 4;\n');
    const second = await again.refresh(repo.id);
    assert.deepEqual(second.indexDiff.files.removed, ['src/b.ts']);
    assert.deepEqual(second.indexDiff.files.added, ['src/c.ts']);
    assert.equal(second.registry.entities['file:src/b.ts'].status, 'missing');
    assert.equal(second.registry.entities['file:src/c.ts'].status, 'new');

    // Reopening after the refresh uses the refreshed cache.
    const third = createSystemService({ home, repos: [root], engine: fakeEngine([]), recordTraces: false });
    await third.open(repo.id);
    assert.equal(third.lastOpen(repo.id), 'cache');
  });

  test('concurrent opens of one repository index once', async () => {
    const calls: string[] = [];
    const h = mkdtempSync(join(tmpdir(), 'vowe-home-'));
    const service = createSystemService({ home: h, repos: [root], engine: fakeEngine(calls), recordTraces: false });
    const [repo] = await service.repos();
    await Promise.all([service.open(repo.id), service.open(repo.id), service.refresh(repo.id)]);
    assert.equal(calls.filter((c) => c === 'index').length, 1);
    rmSync(h, { recursive: true, force: true });
  });

  test('source excerpts stay inside the repository', async () => {
    const service = createSystemService({ home, repos: [root], engine: fakeEngine([]), recordTraces: false });
    const [repo] = await service.repos();
    writeFileSync(join(root, 'src', 'lines.ts'), Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n'));
    const ex = await service.source(repo.id, 'src/lines.ts', 10, 11, 2);
    assert.equal(ex.start, 8);
    assert.deepEqual(ex.lines, ['line 8', 'line 9', 'line 10', 'line 11', 'line 12', 'line 13']);
    assert.deepEqual(ex.focus, { start: 10, end: 11 });
    assert.equal(ex.hash, contentHash(readFileSync(join(root, 'src', 'lines.ts'))));
    assert.equal(ex.language, 'ts');

    symlinkSync(join(outside, 'secret.txt'), join(root, 'src', 'escape.txt'));
    symlinkSync(outside, join(root, 'src', 'escape-dir'));
    for (const bad of ['../' + outside.split('/').pop() + '/secret.txt', 'src/../../etc/passwd', '/etc/passwd', join(outside, 'secret.txt'), 'src/escape.txt', 'src/escape-dir/secret.txt', '.git/config', 'src\\..\\..\\x']) {
      await assert.rejects(service.source(repo.id, bad, 1, 1), (err: Error & { code?: string }) => {
        assert.ok(['outside', 'missing'].includes(err.code ?? ''), `${bad}: ${err.code} ${err.message}`);
        assert.ok(!err.message.includes('not yours'));
        return true;
      }, bad);
    }
    await assert.rejects(service.source(repo.id, 'src/nope.ts', 1, 1), /No such file/);
    await assert.rejects(service.source('nope', 'src/a.ts', 1, 1), /No such repository/);
  });

  test('saved views round-trip per repository and replace by id', async () => {
    const service = createSystemService({ home, repos: [root], engine: fakeEngine([]), recordTraces: false });
    const [repo] = await service.repos();
    const view = (title: string): SavedView => ({
      request: { schema: VIEW_SCHEMA, id: 'view:path-draw', title, question: 'How does draw travel?', lens: 'path', focus: ['command:draw'], source: { kind: 'manual', id: 'me', name: 'Me' } },
      state: { view: 'view:path-draw', seenFingerprint: 'abc', entered: [], selection: null, cameras: { '': { x: 1, y: 2, z: 1 } }, pinned: {}, expanded: [] },
      savedAt: '2026-11-10T00:00:00.000Z',
    });
    await service.saveView(repo.id, view('First'));
    await service.saveView(repo.id, view('Second'));
    const reopened = createSystemService({ home, repos: [root], engine: fakeEngine([]), recordTraces: false });
    const views = await reopened.views(repo.id);
    assert.equal(views.length, 1);
    assert.equal(views[0].request.title, 'Second');
    assert.deepEqual(views[0].state?.cameras, { '': { x: 1, y: 2, z: 1 } });
    await assert.rejects(service.saveView(repo.id, { request: { id: 'x' } } as unknown as SavedView), /schema/);
    assert.deepEqual(readdirSync(join(home, 'repos', repo.id)).filter((n) => n.endsWith('.tmp')), [], 'no temp files left behind');
  });

  test('interpretations persist and are applied on every rebuild', async () => {
    const h = mkdtempSync(join(tmpdir(), 'vowe-home-'));
    const calls: string[] = [];
    const service = createSystemService({ home: h, repos: [root], engine: fakeEngine(calls), recordTraces: false });
    const [repo] = await service.repos();
    await service.open(repo.id);
    const interp: Interpretation = {
      id: 'interp:name-a', op: { kind: 'rename', entity: 'file:src/a.ts', name: 'The a module' },
      by: { kind: 'human', id: 'u1', name: 'Test' }, at: '2026-11-10T00:00:00.000Z', status: 'accepted',
    };
    const reg = await service.addInterpretation(repo.id, interp);
    assert.equal(reg.entities['file:src/a.ts'].name, 'The a module');
    await assert.rejects(service.addInterpretation(repo.id, { id: 'bad', op: { kind: 'nope' } } as unknown as Interpretation), /op\.kind/);

    // A fresh host rebuilds from the cached index with the saved interpretation; so does a refresh.
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 5;\n');
    const other = createSystemService({ home: h, repos: [root], engine: fakeEngine([]), recordTraces: false });
    const opened = await other.open(repo.id);
    assert.equal(opened.registry.entities['file:src/a.ts'].name, 'The a module');
    const refreshed = await other.refresh(repo.id);
    assert.equal(refreshed.registry.entities['file:src/a.ts'].name, 'The a module');
    assert.deepEqual(refreshed.registry.interpretations['interp:name-a']?.op, interp.op);
    rmSync(h, { recursive: true, force: true });
  });

  test('fixtures are listed and labelled', async () => {
    const service = createSystemService({ home, repos: [root], engine: fakeEngine([]), recordTraces: false });
    assert.deepEqual(await service.fixtures(), [{ id: 'fixture:shop', label: 'Fixture: a made-up shop' }]);
    assert.ok((await service.fixture('fixture:shop')).fixture);
    await assert.rejects(service.fixture('nope'), /No such fixture/);
  });

  test('added repositories are remembered', async () => {
    const h = mkdtempSync(join(tmpdir(), 'vowe-home-'));
    const service = createSystemService({ home: h, repos: [], engine: fakeEngine([]), recordTraces: false });
    const added = await service.addRepo(root);
    await assert.rejects(service.addRepo(join(root, 'nope')), /No such directory/);
    const later = createSystemService({ home: h, repos: [], engine: fakeEngine([]), recordTraces: false });
    assert.deepEqual((await later.repos()).map((r) => r.id), [added.id]);
    rmSync(h, { recursive: true, force: true });
  });
});
