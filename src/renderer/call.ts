import type { CallAccess, JourneyApi } from '../shared/api.js';
import {
  ConnectionQuality,
  ConnectionState,
  DisconnectReason,
  type Participant,
  type RemoteTrack,
  Room,
  RoomEvent,
  Track,
} from './vendor/livekit-client.js';

/**
 * A room's voice call, on LiveKit. WebRTC needs the renderer, so the call lives here; main only
 * checks room membership and hands out a short-lived token (calls.access). One call at a time:
 * joining another room's call leaves the current one.
 */

/** Someone in the call. `identity` is their cloud user id, the same as Participant.userId for the room. */
export interface CallParticipant {
  identity: string;
  name: string | null;
  avatarUrl: string | null;
  isLocal: boolean;
  isSpeaking: boolean;
  isMuted: boolean;
  /** `lost` while their connection is down; LiveKit drops them from the call if it doesn't come back. */
  connection: `${ConnectionQuality}`;
}

export type CallStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting';

export interface CallSnapshot {
  status: CallStatus;
  /** The Journey room whose call this is; null when idle. */
  roomId: string | null;
  /** Everyone in the call, you first. Empty until connected. */
  participants: CallParticipant[];
  /** Your microphone is sending. */
  micEnabled: boolean;
  /** The browser held back playback; call `startAudio()` from a click to hear the others. */
  audioBlocked: boolean;
  /** Why the last call ended, or why the microphone isn't sending. Cleared on the next join. */
  error: string | null;
}

const IDLE: CallSnapshot = { status: 'idle', roomId: null, participants: [], micEnabled: false, audioBlocked: false, error: null };

export class CallController {
  private room: Room | undefined;
  private state: CallSnapshot = IDLE;
  private readonly listeners = new Set<(snapshot: CallSnapshot) => void>();
  /** <audio> elements playing remote tracks, by track sid. */
  private readonly players = new Map<string, HTMLMediaElement>();

  constructor(private readonly calls: JourneyApi['calls']) {}

  get snapshot(): CallSnapshot {
    return this.state;
  }

  /** Called with every change, starting with the current state. Returns an unsubscribe function. */
  onChange(listener: (snapshot: CallSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  /**
   * Connects to a room's call with the microphone on; rejects if it can't connect. Joining the
   * current call again is a no-op.
   */
  async join(roomId: string): Promise<void> {
    if (this.state.roomId === roomId && this.state.status !== 'idle') return;
    await this.leave();

    const room = new Room({
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      // Audio-only, so the video bandwidth features have nothing to do.
      adaptiveStream: false,
      dynacast: false,
    });
    this.room = room;
    this.set({ ...IDLE, status: 'connecting', roomId });

    try {
      const microphone = await this.calls.requestMicrophone();
      if (microphone !== 'granted') {
        throw new Error('Journey can’t use the microphone. Allow it in your system’s privacy settings, then try again.');
      }
      const access: CallAccess = await this.calls.access(roomId);
      if (this.room !== room) return; // left or switched rooms while waiting

      this.listen(room);
      await room.connect(access.url, access.token);
    } catch (err) {
      await this.end(room, null);
      throw err;
    }
    if (this.room !== room) return;
    // No usable microphone (unplugged, held by another app) still lets you listen.
    await room.localParticipant.setMicrophoneEnabled(true).catch((err: Error) => {
      if (this.room === room) this.set({ ...this.state, error: `Microphone unavailable: ${err.message}` });
    });
    this.update();
  }

  /** Disconnects from the call, if any. */
  async leave(): Promise<void> {
    if (this.room) await this.end(this.room, null);
  }

  async setMuted(muted: boolean): Promise<void> {
    if (this.state.status !== 'connected' || !this.room) throw new Error('Not in a call');
    await this.room.localParticipant.setMicrophoneEnabled(!muted);
    this.update();
  }

  /** Resumes playback the browser blocked. Must run from a user gesture. */
  async startAudio(): Promise<void> {
    await this.room?.startAudio();
    this.update();
  }

  private listen(room: Room) {
    const refresh = () => this.room === room && this.update();
    room
      .on(RoomEvent.ConnectionStateChanged, refresh)
      .on(RoomEvent.ParticipantConnected, refresh)
      .on(RoomEvent.ParticipantDisconnected, refresh)
      .on(RoomEvent.ActiveSpeakersChanged, refresh)
      .on(RoomEvent.ConnectionQualityChanged, refresh)
      .on(RoomEvent.TrackMuted, refresh)
      .on(RoomEvent.TrackUnmuted, refresh)
      .on(RoomEvent.LocalTrackPublished, refresh)
      .on(RoomEvent.LocalTrackUnpublished, refresh)
      .on(RoomEvent.AudioPlaybackStatusChanged, refresh)
      .on(RoomEvent.TrackSubscribed, (track) => {
        this.play(track);
        refresh();
      })
      .on(RoomEvent.TrackUnsubscribed, (track) => {
        this.stop(track);
        refresh();
      })
      .on(RoomEvent.MediaDevicesError, (err) => {
        if (this.room === room) this.set({ ...this.state, error: `Microphone unavailable: ${err.message}` });
      })
      .on(RoomEvent.Disconnected, (reason) => {
        // Also fires after leave(); end() ignores a room it has already ended.
        if (this.room === room) void this.end(room, disconnectMessage(reason));
      });
  }

  private play(track: RemoteTrack) {
    if (track.kind !== Track.Kind.Audio || !track.sid) return;
    const element = track.attach();
    element.hidden = true;
    document.body.append(element);
    this.players.set(track.sid, element);
  }

  private stop(track: RemoteTrack) {
    if (!track.sid) return;
    const element = this.players.get(track.sid);
    if (!element) return;
    track.detach(element);
    element.remove();
    this.players.delete(track.sid);
  }

  private async end(room: Room, error: string | null) {
    if (this.room !== room) return;
    this.room = undefined;
    for (const element of this.players.values()) element.remove();
    this.players.clear();
    this.set({ ...IDLE, error });
    room.removeAllListeners();
    await room.disconnect(); // also stops the microphone
  }

  private update() {
    const room = this.room;
    if (!room) return;
    const status: CallStatus =
      room.state === ConnectionState.Connected
        ? 'connected'
        : room.state === ConnectionState.Reconnecting || room.state === ConnectionState.SignalReconnecting
          ? 'reconnecting'
          : 'connecting';
    const connected = status !== 'connecting';
    this.set({
      ...this.state,
      status,
      participants: connected ? [room.localParticipant, ...room.remoteParticipants.values()].map(describe) : [],
      micEnabled: connected && room.localParticipant.isMicrophoneEnabled,
      audioBlocked: connected && !room.canPlaybackAudio,
    });
  }

  private set(next: CallSnapshot) {
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }
}

function describe(p: Participant): CallParticipant {
  const microphone = p.getTrackPublication(Track.Source.Microphone);
  return {
    identity: p.identity,
    name: p.name || null,
    avatarUrl: avatarUrl(p.metadata),
    isLocal: p.isLocal,
    isSpeaking: p.isSpeaking,
    isMuted: !microphone || microphone.isMuted,
    connection: p.connectionQuality,
  };
}

/** The token function puts `{ avatarUrl }` in metadata; anything else counts as no avatar. */
function avatarUrl(metadata: string | undefined): string | null {
  try {
    const value = (JSON.parse(metadata ?? '{}') as { avatarUrl?: unknown }).avatarUrl;
    return typeof value === 'string' && value.startsWith('https:') ? value : null;
  } catch {
    return null;
  }
}

function disconnectMessage(reason: DisconnectReason | undefined): string | null {
  switch (reason) {
    case DisconnectReason.CLIENT_INITIATED:
      return null;
    case DisconnectReason.DUPLICATE_IDENTITY:
      return 'You joined this call from another window or device.';
    case DisconnectReason.PARTICIPANT_REMOVED:
      return 'You were removed from the call.';
    case DisconnectReason.ROOM_DELETED:
    case DisconnectReason.ROOM_CLOSED:
      return 'The call was closed.';
    default:
      return 'Lost connection to the call.';
  }
}
