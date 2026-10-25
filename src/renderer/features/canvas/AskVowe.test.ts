import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AgentEvent, JourneyApi, RoomAgentReply, RoomAgentTurn } from '../../../shared/api.js';
import { AskVowe } from './AskVowe.js';
import { applyCommand, command, emptyDocument, PAYMENT_SYSTEM } from '../../../shared/canvas/index.js';
import { CanvasClient, type CanvasTransport } from './client.js';

// Asking Vowe by text against a fake agent IPC (no model involved): what the turn carries, and what
// the panel shows for answers, approvals, canvas outcomes, failures and Stop.

function fakeIpc() {
  const asked: RoomAgentTurn[] = [];
  const cancelled: string[] = [];
  const approvals: [string, boolean][] = [];
  let listener: (e: AgentEvent) => void = () => {};
  const api = {
    ask: async (turn: RoomAgentTurn) => { asked.push(turn); return { turnId: `t${asked.length}` }; },
    cancel: async (id: string) => { cancelled.push(id); },
    approve: async (id: string, ok: boolean) => { approvals.push([id, ok]); },
    onEvent: (fn: (e: AgentEvent) => void) => { listener = fn; return () => {}; },
  } as unknown as JourneyApi['agent'];
  return { api, asked, cancelled, approvals, emit: (e: AgentEvent) => listener(e) };
}

const reply = (text: string, stop = 'completed') => ({ turnId: 't1', conversationId: 'c1', roomId: 'r1', text, stop }) as RoomAgentReply;
const payment = () => applyCommand(emptyDocument(), command('load_system', PAYMENT_SYSTEM, 'load-0001'), { kind: 'human', id: 'u1', name: 'Daniel' }, '2026-10-24T12:00:00.000Z').doc;
const tick = () => new Promise((r) => setTimeout(r, 0));

function setup(userId: string | null = 'u1') {
  const ipc = fakeIpc();
  const transport = {
    me: () => ({ kind: 'human', id: 'u1', name: 'Daniel' }),
    load: async () => ({ revision: 1, doc: payment() }),
    execute: async () => { throw new Error('not used'); },
    onChanged: () => () => {},
    sendPresence: () => {},
    onPresence: () => () => {},
  } as unknown as CanvasTransport;
  const board = new CanvasClient('r1', transport);
  const ask = new AskVowe('r1', board, () => ({ userId, name: 'Daniel' }), ipc.api);
  return { ipc, board, ask };
}

describe('asking Vowe by text', () => {
  it('sends the question with what it is about, and streams the answer', async () => {
    const { ipc, ask } = setup();
    await tick();
    ask.open({ selected: ['payment-worker'], circled: [], names: ['Payment Worker'] });
    ask.ask('  What retries this?  ');
    await tick();
    const turn = ipc.asked[0];
    assert.equal(turn.question, 'What retries this?');
    assert.equal(turn.source, 'text');
    assert.deepEqual(turn.participant, { userId: 'u1', name: 'Daniel' });
    assert.deepEqual(turn.canvas.selection, { selected: ['payment-worker'], circled: [] });
    ipc.emit({ type: 'turn.started', turnId: 't1', conversationId: 'c1', provider: { name: 'OpenAI', billing: 'api-key' } } as AgentEvent);
    ipc.emit({ type: 'text.delta', turnId: 't1', delta: 'The ' } as AgentEvent);
    ipc.emit({ type: 'text.delta', turnId: 't1', delta: 'queue.' } as AgentEvent);
    assert.equal(ask.store.state.status, 'answering');
    assert.equal(ask.store.state.answer, 'The queue.');
    ipc.emit({ type: 'turn.completed', turnId: 't1', reply: reply('The queue.') } as AgentEvent);
    assert.equal(ask.store.state.status, 'done');

    ask.ask('And then?');
    await tick();
    assert.equal(ipc.asked[1].conversationId, 'c1');
    assert.deepEqual(ipc.asked[1].recentTurns.map((t) => t.speaker), ['Daniel', 'Vowe']);
  });

  it('shows a proposal waiting on people and a declined request, and relays approvals', async () => {
    const { ipc, ask } = setup();
    ask.open();
    ask.ask('Sketch it');
    await tick();
    ipc.emit({ type: 'approval.requested', turnId: 't1', request: { id: 'a1', title: 'Read the repo', detail: 'src/' } } as unknown as AgentEvent);
    assert.equal(ask.store.state.approval?.id, 'a1');
    ask.answer(false);
    assert.deepEqual(ipc.approvals, [['a1', false]]);
    assert.equal(ask.store.state.approval, null);
    ipc.emit({ type: 'canvas.applied', turnId: 't1', requests: ['r1'], result: { ok: true, applied: 'proposed', name: 'propose_change', message: 'Vowe proposed adding Queue.' } } as unknown as AgentEvent);
    ipc.emit({ type: 'canvas.applied', turnId: 't1', requests: ['r2'], result: { ok: false, error: { message: 'No component "x".' } } } as unknown as AgentEvent);
    assert.equal(ask.store.state.canvas.length, 2);
    assert.match(ask.store.state.canvas[0], /Accept or reject it on the canvas/);
    assert.match(ask.store.state.canvas[1], /No component "x"/);
  });

  it('stops a turn in flight and says why one failed', async () => {
    const { ipc, ask } = setup();
    ask.open();
    ask.ask('Long one');
    await tick();
    ask.stop();
    assert.deepEqual(ipc.cancelled, ['t1']);
    ipc.emit({ type: 'turn.cancelled', turnId: 't1', reason: 'cancelled', reply: reply('', 'cancelled') } as AgentEvent);
    assert.equal(ask.store.state.status, 'stopped');

    ask.ask('Again');
    await tick();
    const error = { code: 'usage-limit', message: 'You are out of usage.', retryable: false, manageUrl: 'https://example.com/usage' };
    ipc.emit({ type: 'turn.failed', turnId: 't2', error, reply: { ...reply('', 'failed'), turnId: 't2' } } as AgentEvent);
    assert.equal(ask.store.state.status, 'failed');
    assert.equal(ask.store.state.error?.manageUrl, 'https://example.com/usage');
  });

  it('asks nobody when signed out', () => {
    const { ipc, ask } = setup(null);
    ask.open();
    ask.ask('Hello?');
    assert.equal(ipc.asked.length, 0);
    assert.equal(ask.store.state.error?.code, 'not-authorized');
  });
});
