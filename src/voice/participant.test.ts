import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { CanvasCommand, CanvasRelay, SpokenTurn } from './contract.js';
import { VoiceParticipant, type VoiceEvent } from './participant.js';
import { FixtureReasoning, type FixtureScript } from './reasoning/fixture.js';
import { FakeSynthesizer, FakeTransport, ScriptedRecognizer, frame, tick, until } from './testing.js';

const ROOM = '0b7c6c4e-55d2-4d0f-9f53-0d0b8a3ef001';
const DANIEL = { identity: 'u-daniel', name: 'Daniel' };
const JOHN = { identity: 'u-john', name: 'John' };
const FAILURE_FLOW: CanvasCommand = { id: 'cmd-1', kind: 'show-view', view: 'failure-flow', focus: 'payment-worker' };

const ANSWER: FixtureScript = {
  steps: [
    { tool: 'read_component' },
    { say: 'If the Payment Worker crashes after charging, the charge stays but the order is never marked paid. ' },
    { canvas: FAILURE_FLOW },
    { say: 'Here is the failure flow: the retry charges the card a second time.' },
  ],
  deltaMs: 2,
};

let running: VoiceParticipant[] = [];
afterEach(async () => {
  await Promise.all(running.map((p) => p.stop()));
  running = [];
});

function setup(o: { script?: FixtureScript; canvas?: CanvasRelay; authorized?: string[]; synthChunks?: number; msPerChunk?: number } = {}) {
  const transport = new FakeTransport(o.msPerChunk ?? 5);
  const recognizer = new ScriptedRecognizer();
  const synthesizer = new FakeSynthesizer(o.synthChunks ?? 3, 2);
  const reasoning = new FixtureReasoning({ authorized: o.authorized ?? [DANIEL.identity], script: () => o.script ?? ANSWER });
  const applied: { command: CanvasCommand; turn: SpokenTurn; at: number }[] = [];
  const canvas: CanvasRelay = o.canvas ?? {
    apply: async (command, turn) => {
      applied.push({ command, turn, at: Date.now() });
      return 'applied';
    },
  };
  const events: (VoiceEvent & { at: number })[] = [];
  const participant = new VoiceParticipant({
    roomId: ROOM,
    summonedBy: DANIEL,
    transport,
    recognizer,
    synthesizer,
    reasoning,
    canvas,
    context: { forRequester: (id) => (id === DANIEL.identity ? { selection: [{ id: 'payment-worker', label: 'Payment Worker' }], view: 'architecture' } : { selection: [], view: null }) },
    timing: { settleMs: 20, floorMs: 30, bargeInMs: 60, wakeWindowMs: 500, canvasWaitMs: 200, recognitionRetryMs: [10, 10] },
    onEvent: (e) => events.push({ ...e, at: Date.now() }),
  });
  running.push(participant);
  const of = <T extends VoiceEvent['type']>(type: T) => events.filter((e): e is Extract<VoiceEvent, { type: T }> & { at: number } => e.type === type);
  return { transport, recognizer, synthesizer, reasoning, participant, events, of, applied };
}

async function joined(s: ReturnType<typeof setup>, ...speakers: (typeof DANIEL)[]) {
  await s.participant.start();
  s.recognizer.expect(...speakers.map((p) => p.identity));
  for (const speaker of speakers) s.transport.send({ type: 'speaker-joined', speaker });
  await until(() => speakers.every((p) => s.recognizer.streams.has(p.identity)), 500, 'recognition streams');
}

describe('VoiceParticipant', () => {
  it('answers a question addressed to it, as the person who asked, with what they selected', async () => {
    const s = setup();
    await joined(s, DANIEL, JOHN);
    s.recognizer.event(DANIEL.identity, { type: 'partial', text: 'Vowe, what happens' });
    s.recognizer.event(DANIEL.identity, { type: 'final', text: 'Vowe, what happens if this crashes after charging?' });

    await until(() => s.of('turn-ended').length === 1, 3000, 'the turn to end');
    const [turn] = s.reasoning.turns;
    assert.equal(turn.roomId, ROOM);
    assert.deepEqual(turn.requester, DANIEL);
    assert.equal(turn.text, 'What happens if this crashes after charging?');
    assert.deepEqual(turn.context.selection, [{ id: 'payment-worker', label: 'Payment Worker' }]);
    assert.equal(turn.context.view, 'architecture');
    assert.equal(s.of('turn-ended')[0].outcome, 'answered');
    assert.deepEqual(
      s.of('state').map((e) => e.state),
      ['thinking', 'speaking', 'listening'],
    );
    assert.deepEqual(s.synthesizer.said, [
      'If the Payment Worker crashes after charging, the charge stays but the order is never marked paid.',
      'Here is the failure flow: the retry charges the card a second time.',
    ]);
    assert.ok(s.transport.played.length >= 6, 'both sentences reached the call');
    assert.ok(s.of('tool').length === 2);
  });

  it('relays canvas commands untouched, and says what follows only once the canvas shows it', async () => {
    let release!: (o: 'applied') => void;
    const s = setup({ canvas: { apply: () => new Promise((r) => (release = r)) } });
    await joined(s, DANIEL);
    s.recognizer.event(DANIEL.identity, { type: 'final', text: 'Vowe, show me what happens if this crashes.' });

    await until(() => s.of('say').length === 1, 2000, 'the first sentence');
    await tick(80);
    assert.equal(s.of('say').length, 1, 'the sentence after the command waits for the canvas');
    release('applied');
    await until(() => s.of('turn-ended').length === 1, 2000, 'the turn to end');
    assert.deepEqual(s.of('canvas').map((e) => [e.commandId, e.outcome]), [['cmd-1', 'applied']]);
  });

  it('goes on talking if the canvas never answers', async () => {
    const s = setup({ canvas: { apply: () => new Promise(() => {}) } });
    await joined(s, DANIEL);
    s.recognizer.event(DANIEL.identity, { type: 'final', text: 'Vowe, show me the failure flow.' });
    await until(() => s.of('turn-ended').length === 1, 2000, 'the turn to end');
    assert.equal(s.of('canvas')[0].outcome, 'timeout');
    assert.equal(s.of('say').length, 2);
  });

  it('ignores people talking to each other', async () => {
    const s = setup();
    await joined(s, DANIEL, JOHN);
    s.recognizer.event(JOHN.identity, { type: 'final', text: 'I think the worker retries after charging.' });
    s.recognizer.event(DANIEL.identity, { type: 'final', text: 'Should we ask Vowe about that?' });
    await tick(80);
    assert.equal(s.reasoning.turns.length, 0);
    assert.deepEqual(s.of('heard').map((e) => e.addressed), [false, false]);
    assert.equal(s.participant.state, 'listening');
  });

  it('takes "Vowe?" then the question as one request', async () => {
    const s = setup();
    await joined(s, DANIEL);
    s.recognizer.event(DANIEL.identity, { type: 'final', text: 'Vowe?' });
    await tick(30);
    assert.equal(s.reasoning.turns.length, 0);
    s.recognizer.event(DANIEL.identity, { type: 'final', text: 'What if the provider times out?' });
    await until(() => s.reasoning.turns.length === 1, 1000, 'the question');
    assert.equal(s.reasoning.turns[0].text, 'What if the provider times out?');
  });

  it('waits for the rest of a question said with a pause in it', async () => {
    const s = setup();
    await joined(s, DANIEL);
    s.recognizer.event(DANIEL.identity, { type: 'final', text: 'Vowe, what happens if this crashes' });
    await tick(5);
    s.recognizer.event(DANIEL.identity, { type: 'partial', text: 'after' });
    await tick(40);
    assert.equal(s.reasoning.turns.length, 0, 'still talking');
    s.recognizer.event(DANIEL.identity, { type: 'final', text: 'after charging?' });
    await until(() => s.reasoning.turns.length === 1, 1000, 'the question');
    assert.equal(s.reasoning.turns[0].text, 'What happens if this crashes after charging?');
  });

  it('stops speaking and cancels the request when someone talks over it', async () => {
    const long: FixtureScript = { steps: [{ say: 'The worker charges first. '.repeat(30) }], deltaMs: 1 };
    const s = setup({ script: long, synthChunks: 20, msPerChunk: 20 });
    await joined(s, DANIEL);
    s.recognizer.event(DANIEL.identity, { type: 'final', text: 'Vowe, walk me through the worker.' });
    await until(() => s.participant.state === 'speaking', 2000, 'Vowe to speak');
    const turnId = s.participant.activeTurn!.turnId;

    for (let i = 0; i < 5; i++) s.transport.send({ type: 'audio', identity: DANIEL.identity, pcm: { samples: frame(true), sampleRate: 16000 } });

    assert.equal(s.participant.state, 'listening');
    assert.deepEqual(s.of('interrupted').map((e) => [e.turnId, e.by]), [[turnId, DANIEL.identity]]);
    assert.equal(s.of('turn-ended')[0].outcome, 'interrupted');
    assert.ok(s.transport.cleared >= 1, 'queued speech was dropped');
    await until(() => s.reasoning.aborted.includes(turnId), 1000, 'the reasoning request to be cancelled');
    const playedAtInterrupt = s.transport.played.length;
    await tick(100);
    assert.equal(s.transport.played.length, playedAtInterrupt, 'nothing more was played');
  });

  it("doesn't count a short noise as an interruption", async () => {
    const s = setup({ script: { steps: [{ say: 'The worker charges first. '.repeat(10) }], deltaMs: 1 }, synthChunks: 10, msPerChunk: 20 });
    await joined(s, DANIEL, JOHN);
    s.recognizer.event(DANIEL.identity, { type: 'final', text: 'Vowe, walk me through the worker.' });
    await until(() => s.participant.state === 'speaking', 2000, 'Vowe to speak');
    s.transport.send({ type: 'audio', identity: JOHN.identity, pcm: { samples: frame(true), sampleRate: 16000 } });
    s.transport.send({ type: 'audio', identity: JOHN.identity, pcm: { samples: frame(false), sampleRate: 16000 } });
    assert.equal(s.participant.state, 'speaking');
    assert.equal(s.of('interrupted').length, 0);
  });

  it("doesn't take the question itself for an interruption", async () => {
    const s = setup({ script: { steps: [{ say: 'The worker charges first. '.repeat(10) }], deltaMs: 1 }, synthChunks: 10, msPerChunk: 20 });
    await joined(s, DANIEL);
    for (let i = 0; i < 100; i++) s.transport.send({ type: 'audio', identity: DANIEL.identity, pcm: { samples: frame(true), sampleRate: 16000 } });
    s.recognizer.event(DANIEL.identity, { type: 'final', text: 'Vowe, walk me through the worker.' });
    await until(() => s.participant.state === 'speaking', 2000, 'Vowe to speak');
    s.transport.send({ type: 'audio', identity: DANIEL.identity, pcm: { samples: frame(false), sampleRate: 16000 } });
    await tick(50);
    assert.equal(s.of('interrupted').length, 0);
    assert.equal(s.participant.state, 'speaking');
  });

  it('holds its answer while someone is still talking, then speaks in the pause', async () => {
    const s = setup();
    await joined(s, DANIEL, JOHN);
    s.recognizer.event(DANIEL.identity, { type: 'final', text: 'Vowe, what happens if this crashes?' });
    const talking = setInterval(() => s.transport.send({ type: 'audio', identity: JOHN.identity, pcm: { samples: frame(true), sampleRate: 16000 } }), 10);
    await until(() => s.participant.state === 'holding', 2000, 'Vowe to hold');
    await tick(60);
    assert.equal(s.participant.state, 'holding');
    clearInterval(talking);
    await until(() => s.of('turn-ended').length === 1, 2000, 'the answer');
    assert.equal(s.of('turn-ended')[0].outcome, 'answered');
  });

  it("refuses, aloud, to spend one person's model access on another's question", async () => {
    const s = setup({ authorized: [DANIEL.identity] });
    await joined(s, DANIEL, JOHN);
    s.recognizer.event(JOHN.identity, { type: 'final', text: 'Vowe, what does the ledger do?' });
    await until(() => s.of('turn-ended').length === 1, 2000, 'the turn to end');
    assert.equal(s.reasoning.turns.length, 0, 'the runtime never ran');
    assert.equal(s.of('turn-ended')[0].outcome, 'refused');
    assert.match(s.synthesizer.said[0], /John, I can only answer with your own model access/);
  });

  it('a new question replaces the one in progress', async () => {
    const s = setup({ script: { steps: [{ say: 'The worker charges first. '.repeat(30) }], deltaMs: 3 }, synthChunks: 20, msPerChunk: 20 });
    await joined(s, DANIEL);
    s.recognizer.event(DANIEL.identity, { type: 'final', text: 'Vowe, walk me through the worker.' });
    await until(() => s.reasoning.turns.length === 1, 1000, 'the first turn');
    s.recognizer.event(DANIEL.identity, { type: 'final', text: 'Vowe, actually, just the retry.' });
    await until(() => s.reasoning.turns.length === 2, 1000, 'the second turn');
    assert.equal(s.of('turn-ended')[0].outcome, 'superseded');
    assert.equal(s.reasoning.turns[1].text, 'Actually, just the retry.');
  });

  it('drops the turn when the person who asked leaves', async () => {
    const s = setup({ script: { steps: [{ say: 'The worker charges first. '.repeat(30) }], deltaMs: 3 } });
    await joined(s, DANIEL, JOHN);
    s.recognizer.event(DANIEL.identity, { type: 'final', text: 'Vowe, walk me through the worker.' });
    await until(() => s.reasoning.turns.length === 1, 1000, 'the turn');
    s.transport.send({ type: 'speaker-left', identity: DANIEL.identity, reason: 'left' });
    assert.equal(s.of('turn-ended')[0].outcome, 'requester-left');
    assert.ok(s.recognizer.streams.get(DANIEL.identity)!.closed);
    assert.ok(!s.recognizer.streams.get(JOHN.identity)!.closed);
  });

  it('reopens a recognition stream that failed, and gives up after the retries', async () => {
    const s = setup();
    await joined(s, DANIEL);
    s.recognizer.expect(DANIEL.identity);
    s.recognizer.event(DANIEL.identity, { type: 'error', message: 'socket reset', retryable: true });
    await until(() => s.recognizer.opened === 2, 500, 'a new stream');
    s.recognizer.event(DANIEL.identity, { type: 'final', text: 'Vowe, are you still there?' });
    await until(() => s.reasoning.turns.length === 1, 1000, 'the question over the new stream');

    s.recognizer.failNext = 5;
    s.recognizer.event(DANIEL.identity, { type: 'error', message: 'socket reset', retryable: true });
    await tick(100);
    assert.equal(s.recognizer.opened, 4, 'two retries, then it stops');
    assert.ok(s.of('error').filter((e) => e.scope === 'recognition').length >= 3);
  });

  it('shows its state to the call and releases everything when it leaves', async () => {
    const s = setup();
    await joined(s, DANIEL, JOHN);
    assert.deepEqual(s.transport.attributes[0], { 'vowe.state': 'listening', 'vowe.summonedBy': DANIEL.identity, 'vowe.hearing': 'addressed-only' });
    s.transport.send({ type: 'alone' });
    await until(() => s.of('stopped').length === 1, 1000, 'Vowe to leave');
    assert.equal(s.transport.connected, false);
    assert.ok([...s.recognizer.streams.values()].every((st) => st.closed), 'every recognition stream closed');
    assert.equal(s.of('stopped')[0].reason, 'Everyone left the call');
  });

  it('cancels a turn in progress when the call ends', async () => {
    const s = setup({ script: { steps: [{ say: 'The worker charges first. '.repeat(30) }], deltaMs: 3 } });
    await joined(s, DANIEL);
    s.recognizer.event(DANIEL.identity, { type: 'final', text: 'Vowe, walk me through the worker.' });
    await until(() => s.reasoning.turns.length === 1, 1000, 'the turn');
    s.transport.send({ type: 'disconnected', reason: 'Room closed' });
    await until(() => s.of('stopped').length === 1, 1000, 'Vowe to leave');
    assert.equal(s.of('turn-ended')[0].outcome, 'stopped');
    await until(() => s.reasoning.aborted.length === 1, 1000, 'the request to be cancelled');
  });
});
