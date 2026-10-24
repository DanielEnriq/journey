import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CanvasSnapshot } from '../../assistant/canvas.js';
import type { AgentEvent, RoomAgentReply, RoomAgentTurn } from '../../shared/api.js';
import { agentOverIpc, streamTurn, VoiceAdapter, VOWE_VOICE, type VoiceOutput, type VoiceTurnHandle } from './vowe-voice.js';

// The voice adapter against a fake runtime (no model involved), and agentOverIpc against a fake IPC.

const canvas: CanvasSnapshot = {
  version: 1,
  view: 'arch',
  views: [{ id: 'arch', name: 'Architecture' }],
  components: [{ id: 'worker', name: 'Payment Worker', kind: 'service' }],
  relationships: [],
  selection: { selected: ['worker'], circled: [] },
};
const me = { userId: 'u1', name: 'Daniel' };
const them = { userId: 'u2', name: 'Priya' };

function fakeAgent() {
  const asked: RoomAgentTurn[] = [];
  const handles: (VoiceTurnHandle & { cancelled: string | null; finish(reply?: Partial<RoomAgentReply>): void; emit(e: AgentEvent): void })[] = [];
  return {
    asked,
    handles,
    ask(turn: RoomAgentTurn, onEvent: (e: AgentEvent) => void): VoiceTurnHandle {
      asked.push(turn);
      let resolve!: (r: RoomAgentReply) => void;
      const done = new Promise<RoomAgentReply>((r) => (resolve = r));
      const turnId = `t${handles.length + 1}`;
      const h = {
        turnId,
        done,
        cancelled: null as string | null,
        cancel(reason: 'interrupted' | 'cancelled' = 'cancelled') {
          h.cancelled = reason;
          const reply = { stop: 'cancelled', text: '' } as RoomAgentReply;
          onEvent({ type: 'turn.cancelled', turnId, reason, reply });
          resolve(reply);
        },
        finish(over: Partial<RoomAgentReply> = {}) {
          const reply = { stop: 'answered', text: 'It charges twice.', ...over } as RoomAgentReply;
          onEvent({ type: 'turn.completed', turnId, reply });
          resolve(reply);
        },
        emit: onEvent,
      };
      onEvent({ type: 'turn.started', turnId, conversationId: 'conv1', roomId: turn.roomId, provider: { id: 'chatgpt', name: 'ChatGPT', billing: 'chatgpt-plan', model: 'm' } });
      handles.push(h);
      return h;
    },
  };
}

function recorder(): VoiceOutput & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    begin: ({ turnId, speaksFor }) => log.push(`begin ${turnId} for ${speaksFor.userId}`),
    say: (turnId, text) => log.push(`say ${turnId} ${text}`),
    end: (turnId) => log.push(`end ${turnId}`),
    stop: (turnId) => log.push(`stop ${turnId}`),
  };
}

describe('voice adapter', () => {
  it("never starts a turn for someone else's speech: other members are context, answered on their own machines", () => {
    const agent = fakeAgent();
    const voice = new VoiceAdapter(agent, { roomId: 'r1', localUser: me, canvas: () => canvas });
    assert.equal(voice.hear({ participant: them, text: 'Vowe, what does the worker do?', final: true }), null);
    assert.equal(voice.hear({ participant: them, text: 'what does it do', final: true, addressed: true }), null);
    assert.equal(voice.hear({ participant: me, text: 'the worker looks risky', final: true }), null, 'not addressed');
    assert.equal(agent.asked.length, 0);
  });

  it("ignores Vowe's voice in the call, its own or another member's", () => {
    const agent = fakeAgent();
    const voice = new VoiceAdapter(agent, { roomId: 'r1', localUser: me, canvas: () => canvas });
    voice.hear({ participant: me, text: 'Vowe, explain the lease', final: true });
    voice.hear({ participant: { userId: VOWE_VOICE.identity('u2'), name: 'Vowe (for Priya)' }, text: 'The lease is thirty seconds.', final: false });
    assert.equal(agent.handles[0].cancelled, null, 'not a barge-in');
    voice.hear({ participant: { userId: VOWE_VOICE.identity('u1'), name: 'Vowe (for Daniel)' }, text: 'Vowe, say it again', final: true, addressed: true });
    assert.equal(agent.asked.length, 1);
  });

  it('starts a turn for the local person, speaks it as Vowe for them, and continues the conversation', async () => {
    const agent = fakeAgent();
    const output = recorder();
    const voice = new VoiceAdapter(agent, { roomId: 'r1', localUser: me, canvas: () => canvas, output });
    voice.hear({ participant: them, text: 'I think it double charges', final: true });
    const handle = voice.hear({ participant: me, text: 'Hey Vowe, what happens if this crashes after charging?', final: true })!;
    const [asked] = agent.asked;
    assert.equal(asked.question, 'what happens if this crashes after charging?');
    assert.deepEqual([asked.source, asked.participant], ['voice', me]);
    assert.deepEqual(asked.recentTurns.map((t) => t.speaker), ['Priya'], 'the question is not its own context');

    agent.handles[0].emit({ type: 'text.delta', turnId: 't1', step: 1, delta: 'It charges ' });
    agent.handles[0].emit({ type: 'text.delta', turnId: 't1', step: 1, delta: 'twice.' });
    agent.handles[0].finish();
    await handle.done;
    assert.deepEqual(output.log, ['begin t1 for u1', 'say t1 It charges ', 'say t1 twice.', 'end t1']);
    assert.equal(voice.busy, false);

    voice.hear({ participant: me, text: 'and with a retry?', final: true, addressed: true });
    assert.equal(agent.asked[1].conversationId, 'conv1');
    assert.equal(agent.asked[1].recentTurns.at(-1)?.speaker, 'Vowe');
  });

  it('stops speaking when anyone talks over it, and never speaks a failure into the call', async () => {
    const agent = fakeAgent();
    const output = recorder();
    const voice = new VoiceAdapter(agent, { roomId: 'r1', localUser: me, canvas: () => canvas, output });
    const first = voice.hear({ participant: me, text: 'Vowe, explain the lease', final: true })!;
    voice.hear({ participant: them, text: 'wait', final: false });
    assert.equal(agent.handles[0].cancelled, 'interrupted');
    await first.done;

    voice.hear({ participant: me, text: 'Vowe, again', final: true });
    const error = { code: 'usage-limit' as const, message: 'Usage limit reached.', retryable: false };
    agent.handles[1].emit({ type: 'turn.failed', turnId: 't2', error, reply: { stop: 'failed', error } as RoomAgentReply });
    assert.deepEqual(output.log, ['begin t1 for u1', 'stop t1', 'begin t2 for u1', 'stop t2']);
  });

  it('names the published voice after the person it speaks for', () => {
    assert.equal(VOWE_VOICE.identity('u1'), 'vowe:u1');
    assert.equal(VOWE_VOICE.name('Daniel'), 'Vowe (for Daniel)');
    assert.deepEqual(VOWE_VOICE.attributes('u1'), { kind: 'vowe', speaksFor: 'u1' });
  });

  it('streams a turn as an async iterator, and cancels when the consumer stops early', async () => {
    const agent = fakeAgent();
    const seen: string[] = [];
    for await (const event of streamTurn(agent, { question: 'q' } as RoomAgentTurn)) {
      seen.push(event.type);
      break;
    }
    assert.deepEqual(seen, ['turn.started']);
    assert.equal(agent.handles[0].cancelled, 'cancelled');
  });
});

describe('agentOverIpc', () => {
  function fakeIpc() {
    const listeners = new Set<(e: AgentEvent) => void>();
    const cancelled: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    return {
      cancelled,
      release,
      emit: (e: AgentEvent) => listeners.forEach((l) => l(e)),
      api: {
        ask: async () => (await gate, { turnId: 'T1' }),
        cancel: async (id: string) => void cancelled.push(id),
        onEvent: (l: (e: AgentEvent) => void) => (listeners.add(l), () => listeners.delete(l)),
      },
      listeners,
    };
  }

  it('holds events that arrive before the turn id, keeps only its own, and resolves on the ending event', async () => {
    const ipc = fakeIpc();
    const seen: string[] = [];
    const handle = agentOverIpc(ipc.api).ask({ roomId: 'r1' } as RoomAgentTurn, (e) => seen.push(`${e.type}:${e.turnId}`));
    ipc.emit({ type: 'text.delta', turnId: 'T1', step: 1, delta: 'a' });
    ipc.emit({ type: 'text.delta', turnId: 'OTHER', step: 1, delta: 'b' });
    ipc.release();
    await new Promise((r) => setTimeout(r));
    assert.equal(handle.turnId, 'T1');
    ipc.emit({ type: 'turn.completed', turnId: 'T1', reply: { stop: 'answered', text: 'a' } as RoomAgentReply });
    assert.equal((await handle.done).stop, 'answered');
    assert.deepEqual(seen, ['text.delta:T1', 'turn.completed:T1']);
    assert.equal(ipc.listeners.size, 0);
  });

  it('cancels a turn cancelled before its id was known', async () => {
    const ipc = fakeIpc();
    const handle = agentOverIpc(ipc.api).ask({ roomId: 'r1' } as RoomAgentTurn, () => {});
    handle.cancel('interrupted');
    ipc.release();
    await new Promise((r) => setTimeout(r));
    assert.deepEqual(ipc.cancelled, ['T1']);
  });
});
