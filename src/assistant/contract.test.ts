import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readTrackedFile } from '../git/index.js';
import { z } from 'zod';
import { canvasCommandSchema, canvasSnapshotSchema, validateCanvasCommand, type CanvasSnapshot } from './canvas.js';
import { roomTurnSchema } from './index.js';
import { groundingForRoom } from './evidence.js';

const canvas: CanvasSnapshot = {
  version: 1,
  view: 'arch',
  views: [{ id: 'arch', name: 'Architecture' }],
  components: [
    { id: 'queue', name: 'Jobs queue', kind: 'queue' },
    { id: 'worker', name: 'Payment Worker', kind: 'service' },
  ],
  relationships: [{ from: 'queue', to: 'worker' }],
  selection: { selected: ['worker'], circled: [] },
};
const envelope = { v: 1, id: 'cmd1', roomId: 'r1', turnId: 't1', requestedBy: 'u1', reason: 'Because.', evidence: ['E1'], visibility: 'room' };

describe('canvas commands', () => {
  it('accepts each command type when it names real components', () => {
    const ok = [
      { type: 'highlight_component', payload: { componentIds: ['worker'], tone: 'risk' } },
      { type: 'annotate_component', payload: { componentId: 'worker', kind: 'concern', text: 'Not idempotent.' } },
      { type: 'show_view', payload: { view: 'failure', sequence: { actors: ['queue', 'worker'], steps: [{ actor: 'worker', title: 'Crash', tone: 'crash' }] } } },
      { type: 'propose_component', payload: { component: { id: 'keys', name: 'Idempotency keys', kind: 'store' }, near: 'worker' } },
      { type: 'connect_components', payload: { from: 'queue', to: 'worker', label: 'retry' } },
    ];
    for (const c of ok) assert.ok(validateCanvasCommand({ ...envelope, ...c }, canvas).ok, c.type);
  });

  it('rejects unknown types, extra fields, unknown components, bad views and taken ids', () => {
    const errors = (c: object) => {
      const r = validateCanvasCommand({ ...envelope, ...c }, canvas);
      assert.equal(r.ok, false);
      return r.ok ? '' : r.errors.join('\n');
    };
    assert.match(errors({ type: 'delete_component', payload: {} }), /type/);
    assert.match(errors({ type: 'highlight_component', payload: { componentIds: ['worker'], tone: 'risk', html: '<b>' } }), /html|Unrecognized/);
    assert.match(errors({ type: 'highlight_component', payload: { componentIds: ['ledger'], tone: 'risk' } }), /no component "ledger"/);
    assert.match(errors({ type: 'show_view', payload: { view: 'gantt' } }), /view/);
    assert.match(errors({ type: 'show_view', payload: { view: 'arch', sequence: { actors: ['worker'], steps: [{ actor: 'worker', title: 'x' }] } } }), /isn't a sequence/);
    assert.match(errors({ type: 'show_view', payload: { view: 'failure', sequence: { actors: ['worker'], steps: [{ actor: 'queue', title: 'x' }] } } }), /not one of the sequence's actors/);
    assert.match(errors({ type: 'propose_component', payload: { component: { id: 'worker', name: 'W', kind: 'service' } } }), /already on the canvas/);
    assert.match(errors({ type: 'connect_components', payload: { from: 'worker', to: 'worker', label: 'self' } }), /itself/);
    assert.match(errors({ type: 'annotate_component', payload: { componentId: 'worker', kind: 'decision', text: 'Agreed.' } }), /kind/);
    assert.match(errors({ ...envelope, visibility: 'private', type: 'highlight_component', payload: { componentIds: ['worker'], tone: 'focus' } }), /visibility/);
  });
});

describe('published JSON Schemas', () => {
  it('match the schemas the runtime enforces (pnpm contracts:write regenerates them)', () => {
    for (const [name, schema] of [['room-agent-turn', roomTurnSchema], ['canvas-snapshot', canvasSnapshotSchema], ['canvas-command', canvasCommandSchema]] as const) {
      const published = JSON.parse(readFileSync(`src/assistant/contracts/${name}.schema.json`, 'utf8'));
      assert.deepEqual(published, z.toJSONSchema(schema, { io: 'input' }), `${name}.schema.json is out of date`);
    }
  });
});

describe('room grounding', () => {
  it('keeps room sources, and strips excerpts and session ids from local ones', () => {
    const shared = groundingForRoom({
      status: 'grounded',
      claims: [],
      gaps: [],
      sources: [
        { id: 'E1', kind: 'session', ref: 'session abcdef12 #4', excerpt: 'secret prompt', visibility: 'local', toolCallId: 'c1' },
        { id: 'E2', kind: 'code', ref: 'src/worker.ts:2', excerpt: 'psp.charge()', visibility: 'local', toolCallId: 'c2' },
        { id: 'E3', kind: 'decision', ref: 'decision d1 v2', excerpt: 'Idempotent', visibility: 'room', toolCallId: 'c3', approved: true },
      ],
    });
    assert.deepEqual(shared.sources.map((s) => [s.ref, s.excerpt]), [
      ['a local Claude Code session (not shared)', undefined],
      ['src/worker.ts:2', undefined],
      ['decision d1 v2', 'Idempotent'],
    ]);
  });
});

// ─── Reading tracked files ───────────────────────────────────────────────────

describe('readTrackedFile', () => {
  const root = mkdtempSync(join(tmpdir(), 'vowe-read-'));
  const outside = mkdtempSync(join(tmpdir(), 'vowe-outside-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/worker.ts'), 'a\nb\nc\nd\n');
  writeFileSync(join(root, 'src/bin.dat'), Buffer.from([1, 0, 2]));
  writeFileSync(join(root, '.env'), 'SECRET=1\n');
  writeFileSync(join(root, '.gitignore'), '.env\n');
  writeFileSync(join(outside, 'secret.txt'), 'outside\n');
  symlinkSync(join(outside, 'secret.txt'), join(root, 'src/link.txt'));
  git('add', 'src/worker.ts', 'src/bin.dat', 'src/link.txt', '.gitignore');
  writeFileSync(join(root, 'src/untracked.ts'), 'new\n');

  it('reads a numbered range of a tracked file', async () => {
    const excerpt = await readTrackedFile(root, 'src/worker.ts', 2, 3);
    assert.deepEqual(excerpt, { path: 'src/worker.ts', from: 2, to: 3, totalLines: 5, text: '2: b\n3: c' });
  });

  it('refuses traversal, absolute paths, untracked and ignored files, symlinks out, and binaries', async () => {
    for (const [path, why] of [
      ['../vowe-outside/secret.txt', /inside the repository/],
      [join(outside, 'secret.txt'), /inside the repository/],
      ['src/../../x', /inside the repository/],
      ['src/untracked.ts', /Not a tracked file/],
      ['.env', /Not a tracked file/],
      ['src/link.txt', /links outside/],
      ['src/bin.dat', /binary/],
    ] as const) {
      await assert.rejects(readTrackedFile(root, path), why, path);
    }
  });
});
