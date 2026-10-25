import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import type { CallAccess, MicrophoneAccess } from '../../shared/api.js';
import { ConnectionState, DisconnectReason, type RemoteTrack, type Room, RoomEvent, Track } from '../vendor/livekit-client.js';
import { type AudioSink, type CallEvent, CallService, MICROPHONE_DENIED } from './service.js';

// LiveKit's Room, reduced to what CallService touches. The end-to-end test (scripts/call-e2e) runs the
// real one against a LiveKit server with two clients and real audio.

class FakeParticipant {
  isSpeaking = false;
  connectionQuality = 'excellent';
  metadata = JSON.stringify({ avatarUrl: 'https://example.com/a.png' });
  mic: { isMuted: boolean } | undefined;
  attributes: Record<string, string> = {};
  constructor(
    readonly identity: string,
    readonly name: string,
    readonly isLocal: boolean,
  ) {}
  getTrackPublication(source: Track.Source) {
    return source === Track.Source.Microphone ? this.mic : undefined;
  }
}

class FakeLocalParticipant extends FakeParticipant {
  micCalls: boolean[] = [];
  failMic: Error | undefined;
  constructor(private readonly room: FakeRoom) {
    super('me', 'Me', true);
  }
  async setMicrophoneEnabled(enabled: boolean) {
    this.micCalls.push(enabled);
    if (enabled && this.failMic) throw this.failMic;
    this.mic = enabled ? { isMuted: false } : this.mic && { isMuted: true };
    this.room.emit(enabled ? RoomEvent.LocalTrackPublished : RoomEvent.TrackMuted);
    return undefined;
  }
}

class FakeRoom extends EventEmitter {
  state: ConnectionState = ConnectionState.Disconnected;
  canPlaybackAudio = true;
  remoteParticipants = new Map<string, FakeParticipant>();
  localParticipant = new FakeLocalParticipant(this);
  connectedWith: CallAccess | undefined;
  disconnects = 0;
  async connect(url: string, token: string) {
    this.connectedWith = { url, token };
    this.state = ConnectionState.Connected;
    this.emit(RoomEvent.ConnectionStateChanged, this.state);
  }
  async disconnect() {
    this.disconnects++;
    this.state = ConnectionState.Disconnected;
  }
  async startAudio() {
    this.canPlaybackAudio = true;
  }
  addRemote(identity: string, name: string) {
    const p = new FakeParticipant(identity, name, false);
    this.remoteParticipants.set(identity, p);
    this.emit(RoomEvent.ParticipantConnected, p);
    return p;
  }
  removeRemote(identity: string) {
    const p = this.remoteParticipants.get(identity);
    this.remoteParticipants.delete(identity);
    this.emit(RoomEvent.ParticipantDisconnected, p);
  }
  setState(state: ConnectionState, event?: RoomEvent) {
    this.state = state;
    this.emit(RoomEvent.ConnectionStateChanged, state);
    if (event) this.emit(event);
  }
}

function setup({ microphone = 'granted' as MicrophoneAccess, access }: { microphone?: MicrophoneAccess; access?: (roomId: string) => Promise<CallAccess> } = {}) {
  const rooms: FakeRoom[] = [];
  const log: string[] = [];
  let tokens = 0;
  const backend = {
    access:
      access ??
      (async (roomId: string) => {
        log.push(`access ${roomId}`);
        return { url: 'wss://lk.test', token: `token-${++tokens}` };
      }),
    async requestMicrophone() {
      log.push('requestMicrophone');
      return microphone;
    },
    async openMicrophoneSettings() {},
  };
  const played = new Set<string>();
  const audio: AudioSink = {
    play: (t) => void played.add(t.sid!),
    stop: (t) => void played.delete(t.sid!),
    clear: () => played.clear(),
  };
  const service = new CallService(backend, {
    createRoom: () => {
      const room = new FakeRoom();
      rooms.push(room);
      return room as unknown as Room;
    },
    audio,
  });
  const events: CallEvent[] = [];
  service.onEvent((e) => events.push(e));
  return { service, rooms, log, events, played, room: () => rooms.at(-1)! };
}

const ROOM = '0b7c6c4e-55d2-4d0f-9f53-0d0b8a3ef001';
const OTHER = '0b7c6c4e-55d2-4d0f-9f53-0d0b8a3ef002';

describe('CallService', () => {
  it('joins with the microphone off and never asks for it', async () => {
    const { service, log, room } = setup();
    await service.join(ROOM);
    assert.deepEqual(room().connectedWith, { url: 'wss://lk.test', token: 'token-1' });
    assert.equal(service.snapshot.status, 'connected');
    assert.equal(service.snapshot.roomId, ROOM);
    assert.equal(service.snapshot.micEnabled, false);
    assert.deepEqual(room().localParticipant.micCalls, []);
    assert.deepEqual(log, [`access ${ROOM}`]);
    assert.deepEqual(service.snapshot.participants, [
      { identity: 'me', name: 'Me', avatarUrl: 'https://example.com/a.png', isLocal: true, isSpeaking: false, isMuted: true, connection: 'excellent', voweState: null },
    ]);
  });

  it('refuses people the token service turns away, without connecting', async () => {
    const { service, rooms } = setup({ access: async () => Promise.reject(new Error('Could not join the call: Join the room before its call')) });
    await assert.rejects(service.join(ROOM), { message: 'Could not join the call: Join the room before its call' });
    assert.equal(rooms[0].connectedWith, undefined);
    assert.equal(service.snapshot.status, 'idle');
    assert.equal(service.snapshot.error, 'Could not join the call: Join the room before its call');
  });

  it('turns the microphone on only when asked, after the OS says yes, and mutes it again', async () => {
    const { service, log, room } = setup();
    await service.join(ROOM);
    await service.setMicrophoneEnabled(true);
    assert.deepEqual(log, [`access ${ROOM}`, 'requestMicrophone']);
    assert.equal(service.snapshot.micEnabled, true);
    assert.equal(service.snapshot.participants[0].isMuted, false);
    await service.setMuted(true);
    assert.equal(service.snapshot.micEnabled, false);
    assert.equal(service.snapshot.micPending, false);
    assert.deepEqual(room().localParticipant.micCalls, [true, false]);
  });

  it('keeps the microphone off when the OS refuses it, and stays in the call', async () => {
    const { service, room } = setup({ microphone: 'denied' });
    await service.join(ROOM);
    await assert.rejects(service.setMicrophoneEnabled(true), { message: MICROPHONE_DENIED });
    assert.deepEqual(room().localParticipant.micCalls, []);
    assert.equal(service.snapshot.status, 'connected');
    assert.equal(service.snapshot.micEnabled, false);
    assert.equal(service.snapshot.error, MICROPHONE_DENIED);
  });

  it('closes a microphone that failed to open', async () => {
    const { service, room } = setup();
    await service.join(ROOM);
    room().localParticipant.failMic = new Error('device busy');
    await assert.rejects(service.setMicrophoneEnabled(true), { message: 'Microphone unavailable: device busy' });
    assert.deepEqual(room().localParticipant.micCalls, [true, false]);
    assert.equal(service.snapshot.micEnabled, false);
  });

  it('refuses the microphone outside a call', async () => {
    const { service } = setup();
    await assert.rejects(service.setMicrophoneEnabled(true), { message: 'Not in a call' });
  });

  it('reports people joining and leaving', async () => {
    const { service, events, room } = setup();
    await service.join(ROOM);
    room().addRemote('ana', 'Ana');
    assert.deepEqual(
      service.snapshot.participants.map((p) => p.identity),
      ['me', 'ana'],
    );
    assert.equal(events[0].type, 'participant-joined');
    // Someone's Vowe is a participant too, with what it's doing in its `state` attribute.
    const vowe = room().addRemote('vowe:ana', 'Vowe (for Ana)');
    vowe.attributes = { kind: 'vowe', speaksFor: 'ana', state: 'speaking' };
    room().emit(RoomEvent.ParticipantAttributesChanged, {}, vowe);
    assert.deepEqual(service.snapshot.participants.map((p) => [p.identity, p.voweState]), [['me', null], ['ana', null], ['vowe:ana', 'speaking']]);
    room().removeRemote('vowe:ana');
    room().removeRemote('ana');
    assert.deepEqual(events.at(-1), { type: 'participant-left', identity: 'ana', name: 'Ana' });
    assert.deepEqual(
      service.snapshot.participants.map((p) => p.identity),
      ['me'],
    );
  });

  it('plays remote audio while subscribed and stops it on leave', async () => {
    const { service, played, room } = setup();
    await service.join(ROOM);
    const track = { kind: Track.Kind.Audio, sid: 'TR_a' } as RemoteTrack;
    room().emit(RoomEvent.TrackSubscribed, track);
    assert.deepEqual([...played], ['TR_a']);
    room().emit(RoomEvent.TrackUnsubscribed, track);
    assert.deepEqual([...played], []);
    room().emit(RoomEvent.TrackSubscribed, track);
    await service.leave();
    assert.deepEqual([...played], []);
  });

  it('shows a network blip as reconnecting, then connected', async () => {
    const { service, events, room } = setup();
    await service.join(ROOM);
    room().setState(ConnectionState.Reconnecting, RoomEvent.Reconnecting);
    assert.equal(service.snapshot.status, 'reconnecting');
    room().setState(ConnectionState.Connected, RoomEvent.Reconnected);
    assert.equal(service.snapshot.status, 'connected');
    assert.deepEqual(
      events.map((e) => e.type),
      ['reconnecting', 'reconnected'],
    );
  });

  it('keeps a dropped call so it can be rejoined, muted, with a new token', async () => {
    const { service, events, rooms } = setup();
    await service.join(ROOM);
    await service.setMicrophoneEnabled(true);
    rooms[0].emit(RoomEvent.Disconnected, DisconnectReason.JOIN_FAILURE);
    await Promise.resolve();
    assert.equal(service.snapshot.status, 'dropped');
    assert.equal(service.snapshot.roomId, ROOM);
    assert.equal(service.snapshot.error, 'Lost connection to the call.');
    assert.deepEqual(events.at(-1), { type: 'dropped', roomId: ROOM, reason: 'Lost connection to the call.' });

    await service.reconnect();
    assert.equal(rooms.length, 2);
    assert.equal(rooms[1].connectedWith?.token, 'token-2');
    assert.equal(service.snapshot.status, 'connected');
    assert.equal(service.snapshot.micEnabled, false);
    assert.equal(service.snapshot.error, null);
  });

  it('ends the call for good when you join from elsewhere', async () => {
    const { service, events, room } = setup();
    await service.join(ROOM);
    room().emit(RoomEvent.Disconnected, DisconnectReason.DUPLICATE_IDENTITY);
    await Promise.resolve();
    assert.equal(service.snapshot.status, 'idle');
    assert.equal(service.snapshot.error, 'You joined this call from another window or device.');
    assert.deepEqual(events.at(-1), { type: 'ended', roomId: ROOM, reason: 'You joined this call from another window or device.' });
    await assert.rejects(service.reconnect(), { message: 'No dropped call to reconnect' });
  });

  it('leaves the current call to join another, and ignores a repeat join', async () => {
    const { service, rooms } = setup();
    await service.join(ROOM);
    await service.join(ROOM);
    assert.equal(rooms.length, 1);
    await service.join(OTHER);
    assert.equal(rooms[0].disconnects, 1);
    assert.equal(service.snapshot.roomId, OTHER);
  });

  it('does not connect when you leave while the token is on its way', async () => {
    let release!: (access: CallAccess) => void;
    const { service, rooms } = setup({ access: () => new Promise((resolve) => (release = resolve)) });
    const joining = service.join(ROOM);
    assert.equal(service.snapshot.status, 'connecting');
    await service.leave();
    release({ url: 'wss://lk.test', token: 't' });
    await joining;
    assert.equal(rooms[0].connectedWith, undefined);
    assert.equal(service.snapshot.status, 'idle');
  });

  it('asks for a click when playback is blocked', async () => {
    const { service, room } = setup();
    await service.join(ROOM);
    room().canPlaybackAudio = false;
    room().emit(RoomEvent.AudioPlaybackStatusChanged);
    assert.equal(service.snapshot.audioBlocked, true);
    await service.startAudio();
    assert.equal(service.snapshot.audioBlocked, false);
  });
});
