import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Collaborator } from '../assistant/index.js';
import type { AgentReply } from '../shared/api.js';
import type { ReasoningEvent, SpokenTurn } from './contract.js';
import { VoiceHost, type VoiceHostEvent } from './host.js';
import { CollaboratorReasoning } from './reasoning/collaborator.js';
import { FixtureReasoning } from './reasoning/fixture.js';
import { FakeSynthesizer, FakeTransport, ScriptedRecognizer, until } from './testing.js';

const ROOM = '0b7c6c4e-55d2-4d0f-9f53-0d0b8a3ef001';
const DANIEL = { identity: 'u-daniel', name: 'Daniel' };

function host(o: { seatFails?: boolean } = {}) {
  const transport = new FakeTransport(2);
  const recognizer = new ScriptedRecognizer();
  const reasoning = new FixtureReasoning({
    authorized: [DANIEL.identity],
    script: () => ({ steps: [{ say: 'Here is the failure flow for the worker you selected. ' }, { canvas: { id: 'cmd-1', view: 'failure-flow' } }, { say: 'The retry charges twice.' }], deltaMs: 1 }),
  });
  const h = new VoiceHost({
    self: async () => DANIEL,
    seat: async () => {
      if (o.seatFails) throw new Error('Could not bring Vowe into the call: Viewers can listen but not bring Vowe in');
      return { url: 'wss://lk.test', token: 't' };
    },
    speech: async () => ({ recognizer, synthesizer: new FakeSynthesizer(2, 1) }),
    reasoning: () => reasoning,
    transport: (seat) => {
      void seat();
      return transport;
    },
  });
  const events: VoiceHostEvent[] = [];
  h.onEvent((e) => events.push(e));
  return { h, transport, recognizer, reasoning, events };
}

describe('VoiceHost', () => {
  it('brings Vowe in, attaches your selection to your questions, and relays canvas commands to the renderer', async () => {
    const { h, transport, recognizer, reasoning, events } = host();
    assert.equal((await h.start(ROOM)).status, 'on');
    h.setContext(ROOM, { selection: [{ id: 'payment-worker', label: 'Payment Worker' }], view: 'architecture' });
    h.setContext('another-room', { selection: [{ id: 'nope' }], view: null });
    recognizer.expect(DANIEL.identity);
    transport.send({ type: 'speaker-joined', speaker: DANIEL });
    await until(() => recognizer.streams.has(DANIEL.identity));
    recognizer.event(DANIEL.identity, { type: 'final', text: 'Vowe, what if this crashes after charging?' });

    await until(() => events.some((e) => e.type === 'canvas-command'), 2000, 'the canvas command');
    const relayed = events.find((e) => e.type === 'canvas-command')!;
    assert.deepEqual(relayed.type === 'canvas-command' && [relayed.roomId, relayed.requester, relayed.command], [ROOM, DANIEL, { id: 'cmd-1', view: 'failure-flow' }]);
    h.canvasResult('cmd-1', 'applied');
    await until(() => events.some((e) => e.type === 'voice' && e.event.type === 'turn-ended'), 3000, 'the answer');
    assert.deepEqual(reasoning.turns[0].context.selection, [{ id: 'payment-worker', label: 'Payment Worker' }]);
    assert.ok(events.some((e) => e.type === 'voice' && e.event.type === 'canvas' && e.event.outcome === 'applied'));

    await h.stop();
    assert.equal(h.status.status, 'off');
    assert.equal(transport.connected, false);
  });

  it('reports why Vowe could not join', async () => {
    const { h } = host({ seatFails: true });
    const transport = new FakeTransport();
    transport.connect = async () => {
      throw new Error('Could not bring Vowe into the call: Viewers can listen but not bring Vowe in');
    };
    const failing = new VoiceHost({
      self: async () => DANIEL,
      seat: async () => ({ url: '', token: '' }),
      speech: async () => ({ recognizer: new ScriptedRecognizer(), synthesizer: new FakeSynthesizer() }),
      reasoning: () => new FixtureReasoning({ authorized: [], script: () => ({ steps: [] }) }),
      transport: () => transport,
    });
    await assert.rejects(failing.start(ROOM), /Viewers can listen/);
    assert.deepEqual([failing.status.status, failing.status.error], ['failed', 'Could not bring Vowe into the call: Viewers can listen but not bring Vowe in']);
    await h.stop();
  });

  it('goes off when the call ends from its side', async () => {
    const { h, transport, events } = host();
    await h.start(ROOM);
    transport.send({ type: 'alone' });
    await until(() => h.status.status === 'off', 1000, 'off');
    assert.equal(h.status.error, 'Everyone left the call');
    assert.ok(events.some((e) => e.type === 'voice' && e.event.type === 'stopped'));
  });
});

describe('CollaboratorReasoning (interim)', () => {
  const turn = (requester = DANIEL): SpokenTurn => ({
    turnId: 't1',
    roomId: ROOM,
    requester,
    text: 'What happens if this crashes after charging?',
    heard: 'Vowe, what happens if this crashes after charging?',
    context: { selection: [{ id: 'payment-worker', label: 'Payment Worker' }], view: 'architecture' },
    source: 'voice',
    at: new Date().toISOString(),
  });
  const reply: AgentReply = { conversationId: 'c1', text: 'It charges twice.', toolCalls: [{ id: 'x', name: 'git_status', input: {}, error: null }], model: 'm', stop: 'answered' };

  function adapter(send: Collaborator['send'], configured = true) {
    const sent: { conversationId: string | null; text: string }[] = [];
    const collaborator = {
      status: () => ({ provider: 'Anthropic', model: 'm', configured }),
      send: (conversationId: string | null, context: never, text: string) => (sent.push({ conversationId, text }), send(conversationId, context, text)),
    } as unknown as Collaborator;
    const reasoning = new CollaboratorReasoning({
      collaborator,
      owner: DANIEL,
      checkout: async (roomId) => (roomId === ROOM ? { roomId, repository: 'github.com/acme/pay', repositoryId: 'repo-1', path: '/x' } : null),
    });
    return { reasoning, sent };
  }

  async function collect(it: AsyncIterable<ReasoningEvent>) {
    const out: ReasoningEvent[] = [];
    for await (const e of it) out.push(e);
    return out;
  }

  it('answers only the person whose model access it runs on', async () => {
    const { reasoning } = adapter(async () => reply);
    assert.deepEqual(await reasoning.authorize(DANIEL), { ok: true });
    const john = await reasoning.authorize({ identity: 'u-john', name: 'John' });
    assert.equal(john.ok, false);
    assert.match(!john.ok ? john.message : '', /John, I can only use Daniel’s model access/);
    assert.equal((await adapter(async () => reply, false).reasoning.authorize(DANIEL)).ok, false);
  });

  it('frames the spoken question with who asked and what they selected, and keeps follow-ups in one conversation', async () => {
    const { reasoning, sent } = adapter(async () => reply);
    const events = await collect(reasoning.respond(turn(), new AbortController().signal));
    assert.match(sent[0].text, /Spoken aloud in the room's call by Daniel\. Selected on the canvas: Payment Worker \(payment-worker\)\. Canvas view: architecture\./);
    assert.match(sent[0].text, /What happens if this crashes after charging\?$/);
    assert.deepEqual(events.map((e) => e.type), ['tool', 'tool', 'text', 'done']);
    await collect(reasoning.respond(turn(), new AbortController().signal));
    assert.deepEqual(sent.map((s) => s.conversationId), [null, 'c1']);
  });

  it('says why when the room’s repository is not on this machine', async () => {
    const { reasoning } = adapter(async () => reply);
    const events = await collect(reasoning.respond({ ...turn(), roomId: 'elsewhere' }, new AbortController().signal));
    assert.equal(events[0].type === 'error' && events[0].code, 'unavailable');
  });

  it('stops waiting when interrupted', async () => {
    const { reasoning } = adapter(() => new Promise(() => {}));
    const abort = new AbortController();
    const done = collect(reasoning.respond(turn(), abort.signal));
    abort.abort();
    assert.deepEqual(await done, []);
  });
});
