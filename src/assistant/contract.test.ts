import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readTrackedFile } from '../git/index.js';
import type { AgentEvent, RoomAgentReply, RoomAgentTurn } from '../shared/api.js';
import { validateCanvasCommand, type CanvasSnapshot } from './canvas.js';
import { groundingForRoom } from './evidence.js';
import type { TurnHandle } from './index.js';
import { streamTurn, VoiceAdapter } from './voice.js';

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

// ─── Voice adapter ───────────────────────────────────────────────────────────

function fakeAgent() {
  const asked: RoomAgentTurn[] = [];
  const handles: (TurnHandle & { cancelled: string | null; finish(reply?: Partial<RoomAgentReply>): void; emit(e: AgentEvent): void })[] = [];
  return {
    asked,
    handles,
    ask(turn: RoomAgentTurn, onEvent: (e: AgentEvent) => void): TurnHandle {
      asked.push(turn);
      let finish!: (r: RoomAgentReply) => void;
      const done = new Promise<RoomAgentReply>((r) => (finish = r));
      const h = {
        turnId: `t${handles.length + 1}`,
        conversationId: 'conv1',
        done,
        cancelled: null as string | null,
        cancel(reason = 'cancelled') {
          h.cancelled = reason;
          onEvent({ type: 'turn.cancelled', turnId: h.turnId, reason } as AgentEvent);
          finish({ stop: 'cancelled', text: '' } as RoomAgentReply);
        },
        finish(reply: Partial<RoomAgentReply> = {}) {
          finish({ stop: 'answered', text: 'It charges twice.', ...reply } as RoomAgentReply);
        },
        emit: onEvent,
      };
      onEvent({ type: 'turn.started', turnId: h.turnId, conversationId: 'conv1' } as AgentEvent);
      handles.push(h);
      return h;
    },
  };
}

const me = { userId: 'u1', name: 'Daniel' };
const them = { userId: 'u2', name: 'Priya' };

describe('voice adapter', () => {
  it('starts a turn only for the local person addressing Vowe, with what others said as context', async () => {
    const agent = fakeAgent();
    const events: AgentEvent[] = [];
    const voice = new VoiceAdapter(agent, { roomId: 'r1', localUserId: 'u1', canvas: () => canvas, onEvent: (e) => events.push(e) });

    assert.equal(voice.hear({ participant: them, text: 'Vowe, what does the worker do?', final: true }), null, "someone else's question is theirs to ask on their machine");
    assert.equal(voice.hear({ participant: me, text: 'the worker looks risky', final: true }), null, 'not addressed');
    const handle = voice.hear({ participant: me, text: 'Hey Vowe, what happens if this crashes after charging?', final: true });
    assert.ok(handle);
    const [asked] = agent.asked;
    assert.equal(asked.question, 'what happens if this crashes after charging?');
    assert.equal(asked.source, 'voice');
    assert.deepEqual(asked.participant, me);
    assert.deepEqual(asked.recentTurns.map((t) => t.speaker), ['Priya', 'Daniel']);
    assert.deepEqual(asked.canvas.selection.selected, ['worker']);

    agent.handles[0].finish();
    await handle.done;
    assert.equal(voice.busy, false);
    voice.hear({ participant: me, text: 'and with a retry?', final: true, addressed: true });
    assert.equal(agent.asked[1].conversationId, 'conv1', 'follow-ups continue the conversation');
    assert.equal(agent.asked[1].recentTurns.at(-1)?.speaker, 'Vowe');
  });

  it('stops answering when anyone talks over it', async () => {
    const agent = fakeAgent();
    const voice = new VoiceAdapter(agent, { roomId: 'r1', localUserId: 'u1', canvas: () => canvas, onEvent: () => {} });
    const handle = voice.hear({ participant: me, text: 'Vowe, explain the lease', final: true })!;
    voice.hear({ participant: them, text: 'wait', final: false });
    assert.equal(agent.handles[0].cancelled, 'interrupted');
    await handle.done;
    assert.equal(voice.busy, false);
  });

  it('streams a turn as an async iterator, and cancels when the consumer stops early', async () => {
    const agent = fakeAgent();
    const stream = streamTurn(agent, agent.asked[0] ?? ({ question: 'q' } as RoomAgentTurn));
    const seen: string[] = [];
    for await (const event of stream) {
      seen.push(event.type);
      break;
    }
    assert.deepEqual(seen, ['turn.started']);
    assert.equal(agent.handles[0].cancelled, 'cancelled');
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
