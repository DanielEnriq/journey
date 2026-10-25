import type { CallAccess, JourneyApi } from '../../shared/api.js';
import {
  ConnectionQuality,
  ConnectionState,
  DisconnectReason,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
  Room,
  RoomEvent,
  type RoomOptions,
  Track,
} from '../vendor/livekit-client.js';

/**
 * A room's voice call between people, on LiveKit. WebRTC needs the renderer, so the call lives here;
 * main only checks that you are a member of the room and hands out a short-lived token (calls.access).
 * The LiveKit API secret stays with the token service (server/ or the livekit-token Edge Function).
 *
 * One call at a time: joining another room's call leaves the current one. Joining never opens the
 * microphone. You hear the others as soon as you are in, and they hear you only after
 * setMicrophoneEnabled(true), which is also when the OS asks for microphone permission.
 *
 * The UI reads `snapshot` (or onChange) for what to draw and onEvent for one-off moments ("Ana
 * joined"). See INTEGRATION.md next to this file.
 */

/** Someone in the call. `identity` is their cloud user id, the same as Participant.userId for the room. */
export interface CallParticipant {
  identity: string;
  name: string | null;
  avatarUrl: string | null;
  isLocal: boolean;
  isSpeaking: boolean;
  /** Not sending audio: muted, or never turned their microphone on. */
  isMuted: boolean;
  /** `lost` while their connection is down; LiveKit drops them from the call if it doesn't come back. */
  connection: `${ConnectionQuality}`;
  /** Someone's Vowe (`vowe:<their id>`): what it's doing, from its `state` attribute. Null for people. */
  voweState: 'listening' | 'thinking' | 'speaking' | null;
}

/**
 * - `connecting`: fetching a token and connecting.
 * - `connected`: in the call.
 * - `reconnecting`: the network blipped; LiveKit is getting you back in on its own. Audio pauses meanwhile.
 * - `dropped`: the connection was lost for good. `roomId` is kept so reconnect() can rejoin.
 */
export type CallStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'dropped';

export interface CallSnapshot {
  status: CallStatus;
  /** The Journey room whose call this is; null when idle. */
  roomId: string | null;
  /** Everyone in the call, you first. Empty unless connected or reconnecting. */
  participants: CallParticipant[];
  /** Your microphone is sending. False on every join and rejoin until you turn it on. */
  micEnabled: boolean;
  /** setMicrophoneEnabled is in flight (asking permission, opening the device). */
  micPending: boolean;
  /** The browser held back playback; call startAudio() from a click to hear the others. */
  audioBlocked: boolean;
  /** Why the call ended or dropped, or why the microphone couldn't start. Cleared on the next join. */
  error: string | null;
}

/** One-off moments, for toasts or the room's activity. State to draw is in the snapshot. */
export type CallEvent =
  | { type: 'participant-joined'; participant: CallParticipant }
  | { type: 'participant-left'; identity: string; name: string | null }
  | { type: 'reconnecting' }
  | { type: 'reconnected' }
  /** The connection is gone; reconnect() rejoins the same room. */
  | { type: 'dropped'; roomId: string; reason: string }
  /** The call is over without a way back in (left, removed, closed, joined elsewhere). */
  | { type: 'ended'; roomId: string; reason: string | null };

/** What main exposes for calls; window.journey.calls in the app. */
export type CallBackend = JourneyApi['calls'];

/** Plays remote audio. The default appends hidden <audio> elements to the page. */
export interface AudioSink {
  play(track: RemoteTrack): void;
  stop(track: RemoteTrack): void;
  clear(): void;
}

export interface CallServiceOptions {
  /** Builds the LiveKit room; tests pass a fake, and the end-to-end test keeps a handle on the real one. */
  createRoom?: (options: RoomOptions) => Room;
  audio?: AudioSink;
}

export const ROOM_OPTIONS: RoomOptions = {
  audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  // Release the device when muted, so the OS microphone indicator goes off with it.
  publishDefaults: { stopMicTrackOnMute: true, dtx: true, red: true },
  stopLocalTrackOnUnpublish: true,
  // Audio-only, so the video bandwidth features have nothing to do.
  adaptiveStream: false,
  dynacast: false,
};

const IDLE: CallSnapshot = {
  status: 'idle',
  roomId: null,
  participants: [],
  micEnabled: false,
  micPending: false,
  audioBlocked: false,
  error: null,
};

export const MICROPHONE_DENIED = 'Vowe can’t use the microphone. Allow it in your system’s privacy settings, then try again.';

export class CallService {
  private room: Room | undefined;
  private state: CallSnapshot = IDLE;
  private readonly listeners = new Set<(snapshot: CallSnapshot) => void>();
  private readonly eventListeners = new Set<(event: CallEvent) => void>();
  private readonly createRoom: (options: RoomOptions) => Room;
  private readonly audio: AudioSink;

  constructor(
    private readonly backend: CallBackend,
    options: CallServiceOptions = {},
  ) {
    this.createRoom = options.createRoom ?? ((o) => new Room(o));
    this.audio = options.audio ?? domAudioSink();
  }

  get snapshot(): CallSnapshot {
    return this.state;
  }

  /** Called with every change, starting with the current state. Returns an unsubscribe function. */
  onChange(listener: (snapshot: CallSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  /** Called for each CallEvent from now on. Returns an unsubscribe function. */
  onEvent(listener: (event: CallEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /**
   * Connects to a room's call with the microphone off; resolves once connected, rejects if it can't
   * connect (not a member, not signed in, LiveKit unreachable). Joining the current call again is a no-op.
   */
  async join(roomId: string): Promise<void> {
    if (this.state.roomId === roomId && (this.state.status === 'connecting' || this.state.status === 'connected' || this.state.status === 'reconnecting')) {
      return;
    }
    if (this.room || this.state.status === 'dropped') await this.leave();

    const room = this.createRoom(ROOM_OPTIONS);
    this.room = room;
    this.set({ ...IDLE, status: 'connecting', roomId });

    try {
      const access: CallAccess = await this.backend.access(roomId);
      if (this.room !== room) return; // left or switched rooms while waiting
      this.listen(room, roomId);
      await room.connect(access.url, access.token);
    } catch (err) {
      await this.end(room, null, { silent: true });
      const message = `Could not join the call: ${(err as Error).message.replace(/^Could not join the call: /, '')}`;
      this.set({ ...IDLE, error: message });
      throw new Error(message);
    }
    if (this.room === room) this.update();
  }

  /** Rejoins the call that dropped. A rejoin starts muted, like any join. */
  async reconnect(): Promise<void> {
    const { status, roomId } = this.state;
    if (status !== 'dropped' || !roomId) throw new Error('No dropped call to reconnect');
    await this.join(roomId);
  }

  /** Disconnects from the call, if any; also forgets a dropped one. Stops the microphone. */
  async leave(): Promise<void> {
    if (this.room) await this.end(this.room, null);
    else if (this.state.status === 'dropped') this.set(IDLE);
  }

  /**
   * Turns your microphone on or off. Turning it on asks the OS for permission the first time and rejects
   * with a message for a person if it is refused or no device works; the call carries on either way.
   */
  async setMicrophoneEnabled(enabled: boolean): Promise<void> {
    const room = this.room;
    if (!room || this.state.status !== 'connected') throw new Error('Not in a call');
    if (enabled === this.state.micEnabled && !this.state.micPending) return;
    this.set({ ...this.state, micPending: true, error: null });
    let opening = false;
    try {
      if (enabled) {
        const access = await this.backend.requestMicrophone();
        if (access !== 'granted') throw new Error(MICROPHONE_DENIED);
        if (this.room !== room) return;
      }
      opening = enabled;
      await room.localParticipant.setMicrophoneEnabled(enabled);
    } catch (err) {
      const message = (err as Error).message === MICROPHONE_DENIED ? MICROPHONE_DENIED : `Microphone unavailable: ${(err as Error).message}`;
      if (this.room === room) this.set({ ...this.state, micPending: false, error: message });
      // Don't leave a half-opened device sending if it failed after publishing.
      if (opening) await room.localParticipant.setMicrophoneEnabled(false).catch(() => {});
      if (this.room === room) this.update();
      throw new Error(message);
    }
    if (this.room === room) {
      this.set({ ...this.state, micPending: false });
      this.update();
    }
  }

  setMuted(muted: boolean): Promise<void> {
    return this.setMicrophoneEnabled(!muted);
  }

  /** Resumes playback the browser blocked. Must run from a user gesture. */
  /** Your published microphone track while it's on, else null. Never opens one. */
  microphoneTrack(): MediaStreamTrack | null {
    return this.room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack ?? null;
  }

  async startAudio(): Promise<void> {
    await this.room?.startAudio();
    this.update();
  }

  private listen(room: Room, roomId: string) {
    const live = () => this.room === room;
    const refresh = () => live() && this.update();
    room
      .on(RoomEvent.ConnectionStateChanged, refresh)
      .on(RoomEvent.ActiveSpeakersChanged, refresh)
      .on(RoomEvent.ConnectionQualityChanged, refresh)
      .on(RoomEvent.TrackMuted, refresh)
      .on(RoomEvent.TrackUnmuted, refresh)
      .on(RoomEvent.TrackPublished, refresh)
      .on(RoomEvent.TrackUnpublished, refresh)
      .on(RoomEvent.LocalTrackPublished, refresh)
      .on(RoomEvent.LocalTrackUnpublished, refresh)
      .on(RoomEvent.ParticipantNameChanged, refresh)
      .on(RoomEvent.ParticipantAttributesChanged, refresh)
      .on(RoomEvent.AudioPlaybackStatusChanged, refresh)
      .on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => {
        if (!live()) return;
        this.update();
        this.emit({ type: 'participant-joined', participant: describe(p) });
      })
      .on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => {
        if (!live()) return;
        this.update();
        this.emit({ type: 'participant-left', identity: p.identity, name: p.name || null });
      })
      .on(RoomEvent.Reconnecting, () => {
        if (!live()) return;
        this.update();
        this.emit({ type: 'reconnecting' });
      })
      .on(RoomEvent.Reconnected, () => {
        if (!live()) return;
        this.update();
        this.emit({ type: 'reconnected' });
      })
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
        if (!live()) return;
        if (track.kind === Track.Kind.Audio) this.audio.play(track);
        this.update();
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        if (!live()) return;
        this.audio.stop(track);
        this.update();
      })
      .on(RoomEvent.MediaDevicesError, (err: Error) => {
        if (live()) this.set({ ...this.state, error: `Microphone unavailable: ${err.message}` });
      })
      .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
        // Also fires after leave(); end() ignores a room it has already ended.
        if (!live()) return;
        const message = disconnectMessage(reason);
        if (canRejoin(reason)) void this.end(room, message ?? 'Lost connection to the call.', { dropped: roomId });
        else void this.end(room, message);
      });
  }

  /**
   * Tears the room down. `dropped` keeps its id so reconnect() can rejoin; `silent` skips the ended
   * event (a join that never got in).
   */
  private async end(room: Room, error: string | null, { silent = false, dropped }: { silent?: boolean; dropped?: string } = {}) {
    if (this.room !== room) return;
    const roomId = this.state.roomId;
    this.room = undefined;
    room.removeAllListeners();
    this.audio.clear();
    if (dropped) {
      this.set({ ...IDLE, status: 'dropped', roomId: dropped, error });
      this.emit({ type: 'dropped', roomId: dropped, reason: error ?? 'Lost connection to the call.' });
    } else {
      this.set({ ...IDLE, error });
      if (!silent && roomId) this.emit({ type: 'ended', roomId, reason: error });
    }
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
    const inCall = status !== 'connecting';
    this.set({
      ...this.state,
      status,
      participants: inCall ? [room.localParticipant, ...room.remoteParticipants.values()].map(describe) : [],
      micEnabled: inCall && isSending(room.localParticipant),
      audioBlocked: inCall && !room.canPlaybackAudio,
    });
  }

  private set(next: CallSnapshot) {
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }

  private emit(event: CallEvent) {
    for (const listener of this.eventListeners) listener(event);
  }
}

function voweState(p: Participant): CallParticipant['voweState'] {
  if (!p.identity.startsWith('vowe:')) return null;
  const s = p.attributes?.state;
  return s === 'thinking' || s === 'speaking' ? s : 'listening';
}

function isSending(p: Participant): boolean {
  const microphone = p.getTrackPublication(Track.Source.Microphone);
  return Boolean(microphone && !microphone.isMuted);
}

function describe(p: Participant): CallParticipant {
  return {
    identity: p.identity,
    name: p.name || null,
    avatarUrl: avatarUrl(p.metadata),
    isLocal: p.isLocal,
    isSpeaking: p.isSpeaking,
    isMuted: !isSending(p),
    connection: p.connectionQuality,
    voweState: voweState(p),
  };
}

/** The token service puts `{ avatarUrl }` in metadata; anything else counts as no avatar. */
function avatarUrl(metadata: string | undefined): string | null {
  try {
    const value = (JSON.parse(metadata ?? '{}') as { avatarUrl?: unknown }).avatarUrl;
    return typeof value === 'string' && value.startsWith('https:') ? value : null;
  } catch {
    return null;
  }
}

/** Disconnects that a rejoin can fix. Being replaced, removed, or the room closing can't be. */
function canRejoin(reason: DisconnectReason | undefined): boolean {
  switch (reason) {
    case DisconnectReason.CLIENT_INITIATED:
    case DisconnectReason.DUPLICATE_IDENTITY:
    case DisconnectReason.PARTICIPANT_REMOVED:
    case DisconnectReason.ROOM_DELETED:
    case DisconnectReason.ROOM_CLOSED:
      return false;
    default:
      return true;
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

/** Remote audio through hidden <audio> elements, one per track. */
export function domAudioSink(): AudioSink {
  const players = new Map<string, HTMLMediaElement>();
  return {
    play(track) {
      if (!track.sid || players.has(track.sid)) return;
      const element = track.attach();
      element.hidden = true;
      document.body.append(element);
      players.set(track.sid, element);
    },
    stop(track) {
      const element = track.sid ? players.get(track.sid) : undefined;
      if (!element || !track.sid) return;
      track.detach(element);
      element.remove();
      players.delete(track.sid);
    },
    clear() {
      for (const element of players.values()) element.remove();
      players.clear();
    },
  };
}
