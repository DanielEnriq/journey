import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AgentEvent, CanvasSnapshot, JourneyApi, RoomAgentReply, RoomAgentTurn, VoiceStatus } from '../../shared/api.js';
import type { CallParticipant, CallSnapshot } from '../calls/service.js';
import { CallVoice } from './call-voice.js';

const ROOM = '0b7c6c4e-55d2-4d0f-9f53-0d0b8a3ef001';
const DANIEL = { userId: 'u-daniel', name: 'Daniel' };
const canvas = { version: 1, view: 'arch', views: [], components: [], relationships: [], selection: { selected: ['payment-worker'], circled: [] } } as unknown as CanvasSnapshot;

const person = (identity: string, o: Partial<CallParticipant> = {}): CallParticipant => ({
  identity,
  name: identity,
  avatarUrl: null,
  isLocal: false,
  isSpeaking: false,
  isMuted: false,
  connection: 'good' as CallParticipant['connection'],
  ...o,
});

/** The preload bridge, with the runtime and main's voice faked: records what the renderer asks for. */
function bridge() {
  const calls: unknown[][] = [];
  const turns: RoomAgentTurn[] = [];
  const agentListeners = new Set<(e: AgentEvent) => void>();
  const speech = new Set<(u: { roomId: string; speech: never }) => void>();
  const status = new Set<(s: VoiceStatus) => void>();
  const on: VoiceStatus = { roomId: ROOM, status: 'on', state: 'listening', error: null };
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  const api = {
    agent: {
      ask: async (turn: RoomAgentTurn) => (turns.push(turn), { turnId: `t${turns.length}` }),
      cancel: record('agent.cancel'),
      onEvent: (l: (e: AgentEvent) => void) => (agentListeners.add(l), () => agentListeners.delete(l)),
    },
    voice: {
      start: async (roomId: string) => (calls.push(['start', roomId]), on),
      stop: record('stop'),
      status: async () => on,
      audio: record('audio'),
      begin: record('begin'),
      say: record('say'),
      end: record('end'),
      cancel: record('cancel'),
      onStatus: (l: (s: VoiceStatus) => void) => (status.add(l), () => status.delete(l)),
      onSpeech: (l: never) => (speech.add(l), () => speech.delete(l)),
      onSaid: () => () => {},
    },
  } as unknown as Pick<JourneyApi, 'agent' | 'voice'>;
  const reply = (turnId: string) => ({ turnId, text: 'It charges twice.', stop: 'answered' }) as RoomAgentReply;
  return {
    api,
    calls,
    turns,
    hear: (text: string, final = true) => speech.forEach((l) => l({ roomId: ROOM, speech: { participant: DANIEL, text, final } as never })),
    agentEvent: (e: AgentEvent) => agentListeners.forEach((l) => l(e)),
    reply,
    status: (s: Partial<VoiceStatus>) => status.forEach((l) => l({ ...on, ...s })),
    listening: () => speech.size + status.size + agentListeners.size,
  };
}

function fakeCall() {
  let listener: ((s: CallSnapshot) => void) | null = null;
  return {
    call: { onChange: (l: (s: CallSnapshot) => void) => ((listener = l), () => (listener = null)) },
    set: (s: Partial<CallSnapshot>) =>
      listener?.({ status: 'connected', roomId: ROOM, participants: [], micEnabled: false, micPending: false, audioBlocked: false, error: null, ...s }),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('CallVoice', () => {
  it('asks the runtime for you when you address Vowe, and speaks its streamed answer as your Vowe', async () => {
    const b = bridge();
    const c = fakeCall();
    const v = new CallVoice({ api: b.api, roomId: ROOM, localUser: DANIEL, canvas: () => canvas, call: c.call, microphone: () => null });
    await v.start();
    b.hear('Vowe, what happens if this crashes after charging?');
    await tick();
    assert.equal(b.turns.length, 1);
    assert.deepEqual([b.turns[0].participant, b.turns[0].question, b.turns[0].source, b.turns[0].canvas], [DANIEL, 'what happens if this crashes after charging?', 'voice', canvas]);

    b.agentEvent({ type: 'turn.started', turnId: 't1', conversationId: 'c1', roomId: ROOM, provider: { id: 'mock', name: 'Mock', billing: 'api-key', model: 'm' } });
    b.agentEvent({ type: 'text.delta', turnId: 't1', step: 1, delta: 'It charges twice.' });
    b.agentEvent({ type: 'turn.completed', turnId: 't1', reply: b.reply('t1') });
    assert.deepEqual(
      b.calls.filter(([n]) => n !== 'start'),
      [
        ['begin', 't1'],
        ['say', 't1', 'It charges twice.'],
        ['end', 't1'],
      ],
    );
    await v.stop();
    assert.equal(b.listening(), 0);
  });

  it('taps your microphone only while it is on, and never turns it on', async () => {
    const b = bridge();
    const c = fakeCall();
    const taps: string[] = [];
    const stopped: string[] = [];
    let track: { id: string } | null = { id: 'mic-1' };
    const v = new CallVoice({
      api: b.api,
      roomId: ROOM,
      localUser: DANIEL,
      canvas: () => canvas,
      call: c.call,
      microphone: () => track as MediaStreamTrack | null,
      tap: async (t, onPcm) => {
        taps.push(t.id);
        onPcm(new Int16Array([1, 2, 3]));
        return { stop: () => stopped.push(t.id) };
      },
    });
    await v.start();
    c.set({ micEnabled: false });
    assert.deepEqual(taps, []);
    c.set({ micEnabled: true });
    await tick();
    assert.deepEqual(taps, ['mic-1']);
    const audio = b.calls.find(([n]) => n === 'audio')!;
    assert.deepEqual([audio[1], [...new Int16Array((audio[2] as Uint8Array).buffer)]], [ROOM, [1, 2, 3]]);
    track = { id: 'mic-2' }; // unmuted again: LiveKit opened a new track
    c.set({ micEnabled: true });
    c.set({ micEnabled: false });
    await tick();
    assert.deepEqual([taps, stopped], [['mic-1', 'mic-2'], ['mic-1', 'mic-2']]);
    await v.stop();
  });

  it('stops your Vowe when someone else talks over it, but ignores every Vowe and talk while it only thinks', async () => {
    const b = bridge();
    const c = fakeCall();
    const v = new CallVoice({ api: b.api, roomId: ROOM, localUser: DANIEL, canvas: () => canvas, call: c.call, microphone: () => null });
    await v.start();
    b.hear('Vowe, what does the ledger do?');
    await tick();
    b.agentEvent({ type: 'turn.started', turnId: 't1', conversationId: 'c1', roomId: ROOM, provider: { id: 'mock', name: 'Mock', billing: 'api-key', model: 'm' } });

    c.set({ participants: [person(DANIEL.userId, { isLocal: true }), person('u-john', { isSpeaking: true })] }); // thinking: John talks to Priya
    assert.equal(b.calls.filter(([n]) => n === 'agent.cancel' || n === 'cancel').length, 0);
    c.set({ participants: [person(DANIEL.userId, { isLocal: true }), person('u-john')] });

    b.status({ state: 'speaking' });
    c.set({ participants: [person(DANIEL.userId, { isLocal: true }), person('vowe:u-john', { isSpeaking: true })] }); // John's Vowe
    assert.equal(b.calls.filter(([n]) => n === 'cancel').length, 0);
    c.set({ participants: [person(DANIEL.userId, { isLocal: true }), person('u-john', { isSpeaking: true })] });
    await tick();
    assert.deepEqual(
      b.calls.filter(([n]) => n === 'cancel' || n === 'agent.cancel'),
      [
        ['cancel', 't1'],
        ['agent.cancel', 't1'],
      ],
    );
    await v.stop();
  });

  it('lets go when main takes Vowe out of the call', async () => {
    const b = bridge();
    const c = fakeCall();
    const v = new CallVoice({ api: b.api, roomId: ROOM, localUser: DANIEL, canvas: () => canvas, call: c.call, microphone: () => null });
    await v.start();
    b.status({ status: 'off', roomId: null, error: 'You left the call' });
    assert.equal(b.listening(), 0);
  });
});
