import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { VoiceHost, type VoiceHostEvent } from './host.js';
import { FakeSynthesizer, FakeTransport, ScriptedRecognizer, frame, until } from './testing.js';

const ROOM = '0b7c6c4e-55d2-4d0f-9f53-0d0b8a3ef001';
const DANIEL = { userId: 'u-daniel', name: 'Daniel' };

function host(o: { connect?: () => Promise<void> } = {}) {
  const transport = new FakeTransport(2);
  if (o.connect) transport.connect = o.connect;
  const recognizer = new ScriptedRecognizer();
  const synthesizer = new FakeSynthesizer(3, 1);
  const owners: string[] = [];
  const h = new VoiceHost({
    self: async () => DANIEL,
    seat: async () => ({ url: 'wss://lk.test', token: 't' }),
    speech: async () => ({ recognizer, synthesizer }),
    timing: { settleMs: 10 },
    transport: (_seat, owner) => (owners.push(owner), transport),
  });
  const events: VoiceHostEvent[] = [];
  h.onEvent((e) => events.push(e));
  return { h, transport, recognizer, synthesizer, events, owners };
}

const states = (events: VoiceHostEvent[]) => events.flatMap((e) => (e.type === 'status' ? [e.status.state] : [])).filter((s, i, all) => s !== all[i - 1]);

describe('VoiceHost', () => {
  it('joins as your Vowe and passes on your speech', async () => {
    const { h, recognizer, events, owners } = await host();
    assert.equal((await h.start(ROOM)).status, 'on');
    assert.deepEqual(owners, [DANIEL.userId]);
    recognizer.event({ type: 'final', text: 'Vowe, what if this crashes after charging?' });
    await until(() => events.some((e) => e.type === 'speech'));
    const heard = events.find((e) => e.type === 'speech');
    assert.deepEqual(heard?.type === 'speech' && [heard.roomId, heard.speech.participant, heard.speech.addressed], [ROOM, DANIEL, true]);
    await h.stop();
  });

  it('speaks a streamed answer sentence by sentence, showing thinking then speaking', async () => {
    const { h, transport, synthesizer, events } = await host();
    await h.start(ROOM);
    h.begin('t1');
    h.say('t1', 'If it crashes after charging, the lease ');
    h.say('t1', 'runs out and the job comes back. The retry charges ');
    h.say('other-turn', 'Not this turn.');
    h.say('t1', 'the card again.');
    h.end('t1');
    await until(() => states(events).at(-1) === 'listening' && synthesizer.said.length === 2, 3000, 'the answer');
    assert.deepEqual(synthesizer.said, ['If it crashes after charging, the lease runs out and the job comes back.', 'The retry charges the card again.']);
    assert.deepEqual(states(events), ['listening', 'thinking', 'speaking', 'listening']);
    assert.deepEqual(events.flatMap((e) => (e.type === 'said' ? [e.text] : [])), synthesizer.said);
    assert.ok(transport.attributes.some((a) => a.state === 'speaking'));
    await h.stop();
  });

  it('goes silent at once when you talk over it, before the runtime has ended the turn', async () => {
    const { h, transport, events } = await host();
    await h.start(ROOM);
    h.begin('t1');
    h.say('t1', 'This is a long answer that keeps going for a while. It has several sentences in it. ');
    await until(() => states(events).at(-1) === 'speaking');
    const cleared = transport.cleared;
    for (let i = 0; i < 12; i++) h.audio(ROOM, frame(true));
    assert.equal(transport.cleared, cleared + 1);
    assert.equal(states(events).at(-1), 'listening');
    const interruption = events.findLast((e) => e.type === 'speech');
    assert.deepEqual(interruption?.type === 'speech' && [interruption.speech.text, interruption.speech.final], ['…', false]);
    h.say('t1', 'More words that arrive late. '); // the runtime hasn't cancelled yet: ignored
    await h.stop();
  });

  it('stops when the runtime cancels the turn, and leaves when you do', async () => {
    const { h, transport, events } = await host();
    await h.start(ROOM);
    h.begin('t1');
    h.say('t1', 'An answer that will be cut short by the person. Then more. ');
    await until(() => states(events).at(-1) === 'speaking');
    h.cancel('t1');
    assert.equal(states(events).at(-1), 'listening');
    transport.send({ type: 'owner-left' });
    await until(() => h.status.status === 'off');
    assert.equal(h.status.error, 'You left the call');
    assert.equal(transport.connected, false);
  });

  it('reports why your Vowe could not join', async () => {
    const { h } = await host({
      connect: async () => {
        throw new Error('Could not bring Vowe into the call: Viewers can listen but not bring Vowe in');
      },
    });
    await assert.rejects(h.start(ROOM), /Viewers can listen/);
    assert.deepEqual([h.status.status, h.status.error], ['failed', 'Could not bring Vowe into the call: Viewers can listen but not bring Vowe in']);
  });
});
