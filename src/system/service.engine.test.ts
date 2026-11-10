import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createSystemService } from './service.js';

// The host with the real indexer and registry (src/system/store/engine.ts) on a small temporary git
// repository: what a person sees open, go stale, refresh, and lose a file.

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'pipe' });

let root: string;
let home: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'vowe-tiny-'));
  home = mkdtempSync(join(tmpdir(), 'vowe-home-'));
  mkdirSync(join(root, 'src', 'store'), { recursive: true });
  mkdirSync(join(root, 'src', 'ui'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"name":"tiny","type":"module"}\n');
  writeFileSync(join(root, 'tsconfig.json'), '{"compilerOptions":{"target":"ES2022","module":"NodeNext","strict":true},"include":["src"]}\n');
  writeFileSync(join(root, 'src', 'store', 'store.ts'), [
    'export interface Store { load(id: string): Promise<number>; save(id: string, v: number): Promise<boolean> }',
    'export function memoryStore(): Store {',
    '  const m = new Map<string, number>();',
    '  return { async load(id) { return m.get(id) ?? 0; }, async save(id, v) { m.set(id, v); return true; } };',
    '}',
  ].join('\n') + '\n');
  writeFileSync(join(root, 'src', 'ui', 'counter.ts'), [
    "import { memoryStore, type Store } from '../store/store.js';",
    'export class Counter {',
    '  constructor(readonly store: Store = memoryStore()) {}',
    '  async bump(id: string) { const v = await this.store.load(id); return this.store.save(id, v + 1); }',
    '}',
  ].join('\n') + '\n');
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'init');
});
after(() => { for (const d of [root, home]) rmSync(d, { recursive: true, force: true }); });

describe('system service with the real indexer and registry', () => {
  test('open, cached reopen, stale on edit, refresh, missing on delete', async () => {
    const service = createSystemService({ home, repos: [root], recordTraces: false });
    const [repo] = await service.repos();
    const opened = await service.open(repo.id);
    assert.equal(service.lastOpen(repo.id), 'indexed');
    assert.ok(opened.summary.symbols > 0);
    const inUi = Object.values(opened.registry.entities).filter((e) => e.anchors.some((a) => a.file === 'src/ui/counter.ts')).map((e) => e.id);
    assert.ok(inUi.length > 0, 'the registry has entities anchored in counter.ts');

    const again = createSystemService({ home, repos: [root], recordTraces: false });
    const cached = await again.open(repo.id);
    assert.equal(again.lastOpen(repo.id), 'cache');
    assert.equal(cached.summary.cached, true);
    assert.deepEqual(Object.keys(cached.registry.entities), Object.keys(opened.registry.entities));

    writeFileSync(join(root, 'src', 'ui', 'counter.ts'), [
      "import { memoryStore, type Store } from '../store/store.js';",
      'export class Counter {',
      '  constructor(readonly store: Store = memoryStore()) {}',
      '  async bump(id: string, by = 1) { const v = await this.store.load(id); return this.store.save(id, v + by); }',
      '}',
    ].join('\n') + '\n');
    const fresh = await again.freshness(repo.id);
    assert.deepEqual(fresh.changed, ['src/ui/counter.ts']);
    assert.deepEqual(fresh.staleEntities, [...inUi].sort());

    const refreshed = await again.refresh(repo.id);
    assert.deepEqual(refreshed.indexDiff.files.changed, ['src/ui/counter.ts']);
    assert.ok(refreshed.indexDiff.symbols.changed.some((s) => s.startsWith('src/ui/counter.ts#Counter')), 'the changed method is named');
    assert.ok(refreshed.registryDiff.entities.changed.length > 0);
    for (const id of refreshed.registryDiff.entities.changed) assert.equal(refreshed.registry.entities[id].status, 'changed', id);
    assert.deepEqual((await again.freshness(repo.id)).changed, []);

    rmSync(join(root, 'src', 'ui', 'counter.ts'));
    const deleted = await again.refresh(repo.id);
    assert.deepEqual(deleted.indexDiff.files.removed, ['src/ui/counter.ts']);
    assert.ok(deleted.registryDiff.entities.removed.length > 0);
    for (const id of deleted.registryDiff.entities.removed) assert.equal(deleted.registry.entities[id]?.status, 'missing', id);
  });
});
