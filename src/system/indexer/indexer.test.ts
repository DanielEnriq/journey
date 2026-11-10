import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import type { RepoIndex } from '../../shared/system/model.js';
import { diffIndexes, indexRepository, indexRepositorySync, refreshIndex, scanFreshness, stableStringify } from './index.js';

// Small fixture repositories written to the temp dir: TypeScript, TSX, loose JS, SQL migrations, CSS.

const AT = '2026-01-01T00:00:00.000Z';
const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function fixture(files: Record<string, string>, git = false): string {
  const root = mkdtempSync(join(tmpdir(), 'vowe-indexer-'));
  dirs.push(root);
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  if (git) {
    sh(root, 'init', '-q', '-b', 'main');
    commitAll(root, 'first');
  }
  return root;
}
const sh = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString();
const commitAll = (root: string, msg: string) => { sh(root, 'add', '-A'); sh(root, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', msg); };

const FILES: Record<string, string> = {
  'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, jsx: 'react', jsxFactory: 'h', skipLibCheck: true, noEmit: true }, include: ['src'] }),
  '.gitignore': 'ignored/\n',
  'ignored/secret.ts': 'export const nope = 1;\n',
  'node_modules/pkg/index.js': 'module.exports = 1;\n',
  'src/client.ts': `/** Where commands go. */
export interface Transport {
  execute(name: string): Promise<string>;
  status: 'idle' | 'busy';
}

export type Tool = 'select' | 'draw';

export const TOOLS = [{ id: 'select', label: 'Select' }, { id: 'draw', label: 'Draw' }];

export const HANDLERS = {
  draw(n: number) { return n; },
  erase: (n: number) => n,
};

export const MAX = 5;

export class Client {
  private queue: string[] = [];
  constructor(readonly transport: Transport) {}

  /** Runs one command. */
  async run(name: string): Promise<string> {
    for (let i = 0; i < MAX; i++) {
      if (name === 'draw') {
        const out = await this.transport.execute(name);
        if (out) return out;
      }
    }
    try { helper('x'); } catch { this.queue.push('failed'); }
    return '';
  }
}

export function helper(s: string) { return s; }
`,
  'src/use.ts': `import { Client as C, helper, type Transport } from './client.js';

export function make(t: Transport) {
  const c = new C(t);
  helper('canvas:execute');
  return c.run('draw');
}

export function pick(tool: string) {
  switch (tool) {
    case 'draw': return 1;
    default: return 0;
  }
}
`,
  'src/ui.tsx': `declare function h(...a: unknown[]): unknown;
export function Button(p: { onClick(): void }) {
  return <button onClick={p.onClick}>x</button>;
}
`,
  'src/use.test.ts': `import { test } from 'node:test';
import { pick } from './use.js';
test('picks draw', () => { pick('draw'); });
`,
  'scripts/tool.mjs': 'export function cli() { return 1; }\n',
  'styles/app.css': '.a { color: red; }\n',
  'supabase/migrations/001_init.sql': `-- Items and notes.
create table public.items (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  old text,
  owner uuid references public.users (id)
);

create table notes (
  item_id uuid not null,
  body text,
  primary key (item_id, body)
);

create function public.save_item(item uuid, label text default 'x')
returns bigint language plpgsql security definer set search_path = '' as $$
begin
  -- the message mentions from public.notes but is a string: 'delete from public.notes'
  insert into public.items (id, name) values (item, label);
  update public.items set name = label where id = item;
  perform 1 from public.notes n join public.items i on i.id = n.item_id;
  return 1;
end;
$$;

create policy "items: read" on public.items for select to authenticated using (public.save_item(id, 'y') > 0);
create index items_name_idx on public.items (name);
`,
  'supabase/migrations/002_more.sql': `alter table public.items add column kind text not null default 'a';
alter table public.items drop column old;
alter table public.items enable row level security;
drop table public.notes;
create view public.v as select 1;
`,
};

describe('indexRepository on a fixture', async () => {
  const root = fixture(FILES, true);
  const ix = await indexRepository(root, { indexedAt: AT });
  const sym = (id: string) => ix.symbols.find((s) => s.id === id);
  const refs = (from: string, to: string) => ix.references.filter((r) => r.from === from && r.to === to).map((r) => r.kind);

  test('revision, files and statuses', () => {
    assert.equal(ix.schema, 'vowe.index/1');
    assert.match(ix.revision.head ?? '', /^[0-9a-f]{40}$/);
    assert.equal(ix.revision.branch, 'main');
    assert.deepEqual(ix.revision.dirty, []);
    assert.match(ix.revision.repo.id, /^vowe-indexer-[a-z0-9-]+-[0-9a-f]{8}$/);
    const paths = ix.files.map((f) => f.path);
    assert.ok(!paths.some((p) => p.startsWith('ignored/') || p.startsWith('node_modules/')), 'gitignored and node_modules are not listed');
    const f = (p: string) => ix.files.find((x) => x.path === p)!;
    assert.equal(f('src/client.ts').status, 'indexed');
    assert.equal(f('src/client.ts').hash.length, 16);
    assert.equal(f('scripts/tool.mjs').status, 'indexed');
    assert.equal(f('styles/app.css').status, 'unsupported');
    assert.match(f('styles/app.css').note!, /not parsed/);
    assert.equal(f('src/use.test.ts').test, true);
    assert.equal(f('supabase/migrations/002_more.sql').status, 'partial', 'create view is not understood');
    assert.equal(ix.coverage.byLang.css?.unsupported, 1);
    assert.ok(ix.coverage.limits.some((l) => /CSS and HTML are listed, not parsed/.test(l)));
    assert.equal(ix.incomplete, false);
  });

  test('symbols and ids', () => {
    assert.equal(sym('src/client.ts#Client')?.kind, 'class');
    const run = sym('src/client.ts#Client.run')!;
    assert.equal(run.kind, 'method');
    assert.equal(run.container, 'src/client.ts#Client');
    assert.equal(run.signature, 'run(name: string): Promise<string>');
    assert.equal(run.doc, 'Runs one command.');
    assert.equal(sym('src/client.ts#Client.transport')?.signature, 'readonly transport: Transport');
    assert.equal(sym('src/client.ts#Client.queue')?.signature, 'private queue: string[]');
    assert.equal(sym('src/client.ts#Transport')?.doc, 'Where commands go.');
    assert.deepEqual(sym('src/client.ts#Transport')?.attrs?.keys, ['execute', 'status']);
    assert.equal(sym('src/client.ts#Transport.execute')?.kind, 'method');
    assert.deepEqual(sym('src/client.ts#Transport.status')?.attrs?.members, ['idle', 'busy']);
    assert.deepEqual(sym('src/client.ts#Tool')?.attrs?.members, ['select', 'draw']);
    assert.deepEqual(sym('src/client.ts#TOOLS')?.attrs?.ids, ['select', 'draw']);
    assert.deepEqual(sym('src/client.ts#HANDLERS')?.attrs?.keys, ['draw', 'erase']);
    assert.equal(sym('src/client.ts#HANDLERS.draw')?.kind, 'method');
    assert.equal(sym('src/client.ts#HANDLERS.erase')?.kind, 'method');
    assert.equal(sym('src/client.ts#MAX')?.attrs?.value, 5);
    assert.equal(sym('src/client.ts#helper')?.exported, true);
    const button = sym('src/ui.tsx#Button')!;
    assert.equal(button.kind, 'ui-component');
    assert.deepEqual(button.attrs?.events, ['onClick']);
    assert.deepEqual(button.attrs?.elements, ['button']);
    assert.equal(sym('scripts/tool.mjs#cli')?.kind, 'function', 'loose JS outside tsconfig is indexed');
    assert.equal(sym('src/use.test.ts#test:picks draw')?.kind, 'test-case');
  });

  test('imports resolve to files', () => {
    const imp = ix.imports.find((i) => i.from === 'src/use.ts')!;
    assert.equal(imp.to, 'src/client.ts');
    assert.deepEqual(imp.names, ['Client', 'Transport', 'helper']);
    assert.equal(imp.typeOnly, false);
    assert.equal(ix.imports.find((i) => i.from === 'src/use.test.ts' && i.specifier === 'node:test')?.to, null);
  });

  test('references resolve through import aliases and interface members', () => {
    assert.ok(refs('src/use.ts#make', 'src/client.ts#Client').includes('new'), 'new C(t) → Client');
    assert.ok(refs('src/use.ts#make', 'src/client.ts#helper').includes('call'));
    assert.ok(refs('src/use.ts#make', 'src/client.ts#Client.run').includes('call'));
    assert.ok(refs('src/use.ts#make', 'src/client.ts#Transport').includes('type'));
    assert.ok(refs('src/client.ts#Client.run', 'src/client.ts#Transport.execute').includes('call'), 'this.transport.execute → the interface method');
    assert.ok(refs('src/client.ts#Client.run', 'src/client.ts#Client.transport').includes('read'));
    assert.ok(refs('src/client.ts#Client.run', 'src/client.ts#MAX').includes('read'));
    assert.ok(refs('src/use.test.ts#test:picks draw', 'src/use.ts#pick').includes('call'), 'tests refer from their test case');
  });

  test('literal and comparison sites', () => {
    const lit = ix.literals.find((l) => l.literal === 'canvas:execute')!;
    assert.equal(lit.in, 'src/use.ts#make');
    assert.equal(lit.callee, 'helper');
    assert.equal(lit.calleeSymbol, 'src/client.ts#helper');
    assert.equal(lit.argIndex, 0);
    assert.equal(lit.range.start.line, 5);
    const run = ix.literals.find((l) => l.in === 'src/use.ts#make' && l.literal === 'draw')!;
    assert.equal(run.callee, 'c.run');
    assert.equal(run.method, 'run');
    assert.equal(run.calleeSymbol, 'src/client.ts#Client.run');

    const cmp = ix.comparisons.find((c) => c.in === 'src/client.ts#Client.run' && c.literal === 'draw')!;
    assert.equal(cmp.subject, 'name');
    assert.equal(cmp.branch?.start.line, 25);
    assert.equal(cmp.branch?.end.line, 28);
    const sw = ix.comparisons.find((c) => c.in === 'src/use.ts#pick')!;
    assert.equal(sw.subject, 'tool');
    assert.equal(sw.literal, 'draw');
    assert.equal(sw.branch?.start.line, 11);
  });

  test('call flows carry loop, branch, await and try context', () => {
    const flow = ix.flows.find((f) => f.symbol === 'src/client.ts#Client.run')!;
    const exec = flow.steps.find((s) => s.callee === 'this.transport.execute')!;
    assert.deepEqual(exec.ctx, ['loop', 'branch', 'await']);
    assert.equal(exec.guard, "name === 'draw'");
    assert.equal(exec.calleeSymbol, 'src/client.ts#Transport.execute');
    const h = flow.steps.find((s) => s.callee === 'helper')!;
    assert.deepEqual(h.ctx, ['try']);
    assert.ok(!flow.steps.some((s) => s.callee === 'this.queue.push'), 'array helpers are left out');
    assert.ok(flow.steps.indexOf(exec) < flow.steps.indexOf(h), 'in source order');
  });

  test('SQL tables, columns, functions, policies and writes', () => {
    const t = sym('supabase/migrations/001_init.sql#public.items')!;
    assert.equal(t.kind, 'sql-table');
    assert.deepEqual(t.attrs?.columns, ['id', 'name', 'owner', 'kind']);
    assert.deepEqual(t.attrs?.primaryKey, ['id']);
    assert.equal(t.attrs?.rls, true);
    const id = sym('supabase/migrations/001_init.sql#public.items.id')!;
    assert.equal(id.kind, 'sql-column');
    assert.equal(id.container, t.id);
    assert.equal(id.attrs?.type, 'uuid');
    assert.equal(sym('supabase/migrations/001_init.sql#public.items.owner')?.attrs?.references, 'public.users(id)');
    assert.equal(sym('supabase/migrations/002_more.sql#public.items.kind')?.attrs?.default, "'a'", 'a column added later carries its migration');
    assert.equal(sym('supabase/migrations/001_init.sql#public.items.old'), undefined, 'dropped column is gone');
    assert.equal(sym('supabase/migrations/001_init.sql#public.notes'), undefined, 'dropped table is gone');

    const fn = sym('supabase/migrations/001_init.sql#public.save_item')!;
    assert.equal(fn.kind, 'sql-function');
    assert.deepEqual(fn.attrs?.params, ['item', 'label']);
    assert.equal(fn.attrs?.returns, 'bigint');
    assert.equal(fn.attrs?.language, 'plpgsql');
    assert.equal(fn.attrs?.securityDefiner, true);
    const writes = ix.references.filter((r) => r.from === fn.id && r.kind === 'sql-write');
    assert.equal(writes.length, 2, 'insert and update, not the words inside the string');
    assert.ok(writes.every((w) => w.to === t.id));
    assert.ok(ix.references.some((r) => r.from === fn.id && r.kind === 'sql-read' && r.to === t.id), 'join public.items');
    assert.ok(!ix.references.some((r) => r.to.endsWith('public.notes')), 'notes was dropped, so nothing resolves to it');

    const pol = sym('supabase/migrations/001_init.sql#public.items.policy:items: read')!;
    assert.equal(pol.kind, 'sql-policy');
    assert.equal(pol.attrs?.command, 'select');
    assert.ok(ix.references.some((r) => r.from === pol.id && r.kind === 'sql-call' && r.to === fn.id));
    assert.equal(sym('supabase/migrations/001_init.sql#public.items_name_idx')?.container, t.id);
  });

  test('two runs are byte-identical', async () => {
    const again = await indexRepository(root, { indexedAt: AT });
    assert.equal(stableStringify(again), stableStringify(ix));
    assert.equal(stableStringify(indexRepositorySync(root, { indexedAt: AT })), stableStringify(ix));
  });
});

describe('change detection', () => {
  test('freshness sees edits, additions, deletions and a moved head', () => {
    const root = fixture(FILES, true);
    const ix = indexRepositorySync(root, { indexedAt: AT, diagnostics: false });
    assert.equal(scanFreshness(root, ix).fresh, true);
    writeFileSync(join(root, 'src/client.ts'), FILES['src/client.ts'] + '\nexport const more = 1;\n');
    writeFileSync(join(root, 'src/new.ts'), 'export const x = 1;\n');
    rmSync(join(root, 'src/ui.tsx'));
    const f = scanFreshness(root, ix);
    assert.deepEqual(f.changed, ['src/client.ts']);
    assert.deepEqual(f.added, ['src/new.ts']);
    assert.deepEqual(f.removed, ['src/ui.tsx']);
    assert.equal(f.headMoved, false);
    assert.equal(f.fresh, false);
    assert.notEqual(f.current, f.indexed);
    commitAll(root, 'second');
    assert.equal(scanFreshness(root, ix).headMoved, true);
  });

  test('diff reports a renamed file as moved symbols, refresh re-indexes only on change', async () => {
    const root = fixture(FILES, true);
    const a = indexRepositorySync(root, { indexedAt: AT, diagnostics: false });
    const same = await refreshIndex(root, a, { indexedAt: AT, diagnostics: false });
    assert.equal(same.reindexed, false);
    assert.equal(same.index, a);

    renameSync(join(root, 'src/use.ts'), join(root, 'src/usage.ts'));
    writeFileSync(join(root, 'src/client.ts'), FILES['src/client.ts'].replace('return s;', 'return s + s;'));
    const { index: b, diff, reindexed } = await refreshIndex(root, a, { indexedAt: AT, diagnostics: false });
    assert.equal(reindexed, true);
    assert.deepEqual(diff.files.added, ['src/usage.ts']);
    assert.deepEqual(diff.files.removed, ['src/use.ts']);
    assert.deepEqual(diff.files.changed, ['src/client.ts']);
    assert.equal(diff.symbols.moved['src/use.ts#make'], 'src/usage.ts#make');
    assert.equal(diff.symbols.moved['src/use.ts#pick'], 'src/usage.ts#pick');
    assert.ok(!diff.symbols.removed.includes('src/use.ts#make'));
    assert.ok(!diff.symbols.added.includes('src/usage.ts#make'));
    assert.ok(diff.symbols.changed.includes('src/client.ts#helper'));
    assert.equal(diff.from, a.revision.fingerprint);
    assert.equal(diff.to, b.revision.fingerprint);
  });
});

describe('limits', () => {
  test('maxFiles cuts the index short and says so', () => {
    const root = fixture(FILES);
    const ix = indexRepositorySync(root, { indexedAt: AT, maxFiles: 3, diagnostics: false });
    assert.equal(ix.incomplete, true);
    assert.ok(ix.files.filter((f) => f.status === 'skipped' && f.note === 'over the maxFiles limit').length >= 5);
    assert.ok(ix.coverage.limits.some((l) => /file limit reached/.test(l)));
  });

  test('a time limit leaves files skipped and the index incomplete', () => {
    const root = fixture(FILES);
    const ix: RepoIndex = indexRepositorySync(root, { indexedAt: AT, timeoutMs: 0, diagnostics: false });
    assert.equal(ix.incomplete, true);
    assert.ok(ix.files.some((f) => f.status === 'skipped' && /time limit/.test(f.note ?? '')));
  });

  test('outside git: no head, a walk that skips node_modules', () => {
    const root = fixture(FILES);
    const ix = indexRepositorySync(root, { indexedAt: AT, diagnostics: false });
    assert.equal(ix.revision.head, null);
    assert.equal(ix.revision.branch, null);
    assert.ok(!ix.files.some((f) => f.path.startsWith('node_modules/')));
    assert.ok(ix.files.some((f) => f.path === 'ignored/secret.ts'), 'without git there is no .gitignore to honour');
    assert.ok(ix.symbols.some((s) => s.id === 'src/client.ts#Client.run'));
  });
});
