import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  ParticipantKind,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type TrackPublication,
  type Participant,
} from '@livekit/rtc-node';
import type { CallTransport, TransportEvent } from './contract.js';

/**
 * Vowe's seat in a room's LiveKit call (`room:<room id>`), from a trusted Node process: the same
 * LiveKit room the people's CallService joins (renderer/calls), as one more participant.
 *
 * It joins with a Vowe token (kind agent, identity `vowe`; server/src/vowe-voice.ts), so people's
 * apps can tell it from a person and it can never take a person's place in the call. It hears each
 * person's microphone as its own 16 kHz stream and publishes one microphone track of its own speech.
 * It never publishes video or data, and never touches anyone else's tracks.
 */

/** Vowe's LiveKit identity; people's identities are their cloud user ids. */
export const VOWE_IDENTITY = 'vowe';
/** Frame size for outgoing speech: small, so an interruption clears quickly. */
const OUT_FRAME_MS = 10;

export interface LiveKitAccess {
  url: string;
  token: string;
}

interface Hearing {
  identity: string;
  trackSid: string;
  reader: ReadableStreamDefaultReader<AudioFrame>;
  muted: boolean;
}

export class LiveKitTransport implements CallTransport {
  readonly inputRate = 16000;
  readonly outputRate = 24000;
  private room: Room | null = null;
  private source: AudioSource | null = null;
  private track: LocalAudioTrack | null = null;
  private readonly hearing = new Map<string, Hearing>();
  private emit: (e: TransportEvent) => void = () => {};
  /** Bumped by clear(), so a play() in progress stops queueing what's left of it. */
  private generation = 0;
  private closed = false;

  constructor(private readonly access: () => Promise<LiveKitAccess>) {}

  async connect(onEvent: (e: TransportEvent) => void) {
    if (this.room) throw new Error('Already connected');
    this.emit = onEvent;
    const { url, token } = await this.access();
    const room = new Room();
    this.room = room;

    room
      .on(RoomEvent.TrackSubscribed, (track, publication, participant) => this.onSubscribed(track, publication, participant))
      .on(RoomEvent.TrackUnsubscribed, (_track, publication, participant) => this.stopHearing(participant.identity, publication.sid, 'muted'))
      .on(RoomEvent.TrackMuted, (publication, participant) => this.setMuted(publication, participant, true))
      .on(RoomEvent.TrackUnmuted, (publication, participant) => this.setMuted(publication, participant, false))
      .on(RoomEvent.ParticipantDisconnected, (participant) => {
        if (!isPerson(participant)) return;
        this.stopHearing(participant.identity, null, 'left');
        if (![...room.remoteParticipants.values()].some(isPerson)) this.emit({ type: 'alone' });
      })
      .on(RoomEvent.Reconnecting, () => this.emit({ type: 'reconnecting' }))
      .on(RoomEvent.Reconnected, () => this.emit({ type: 'reconnected' }))
      .on(RoomEvent.Disconnected, (reason) => {
        if (this.closed) return;
        this.release();
        this.emit({ type: 'disconnected', reason: `LiveKit disconnected (${reason})` });
      });

    try {
      await room.connect(url, token, { autoSubscribe: true, dynacast: false });
      this.source = new AudioSource(this.outputRate, 1);
      this.track = LocalAudioTrack.createAudioTrack('vowe', this.source);
      await room.localParticipant!.publishTrack(this.track, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }));
    } catch (err) {
      await this.disconnect();
      throw new Error(`Vowe could not join the call: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async play(pcm: Int16Array) {
    const source = this.source;
    if (!source) return;
    const generation = this.generation;
    const step = (this.outputRate * OUT_FRAME_MS) / 1000;
    for (let i = 0; i < pcm.length; i += step) {
      if (generation !== this.generation || this.closed) return;
      const data = pcm.slice(i, i + step);
      await source.captureFrame(new AudioFrame(data, this.outputRate, 1, data.length));
    }
  }

  async playedOut() {
    await this.source?.waitForPlayout();
  }

  clear() {
    this.generation++;
    this.source?.clearQueue();
  }

  async setAttributes(attributes: Record<string, string>) {
    await this.room?.localParticipant?.setAttributes(attributes);
  }

  async disconnect() {
    if (this.closed) return;
    this.closed = true;
    const room = this.room;
    this.release();
    await this.track?.close().catch(() => {});
    await this.source?.close().catch(() => {});
    this.track = null;
    this.source = null;
    await room?.disconnect().catch(() => {});
    this.room = null;
  }

  private onSubscribed(track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) {
    if (this.closed || track.kind !== TrackKind.KIND_AUDIO || publication.source !== TrackSource.SOURCE_MICROPHONE || !isPerson(participant)) return;
    this.stopHearing(participant.identity, null, null);
    const reader = new AudioStream(track, { sampleRate: this.inputRate, numChannels: 1, frameSizeMs: 20 }).getReader();
    const hearing: Hearing = { identity: participant.identity, trackSid: publication.sid ?? '', reader, muted: Boolean(publication.muted) };
    this.hearing.set(participant.identity, hearing);
    if (!hearing.muted) this.emit({ type: 'speaker-joined', speaker: speaker(participant) });
    void this.read(hearing);
  }

  private async read(hearing: Hearing) {
    try {
      for (;;) {
        const { done, value } = await hearing.reader.read();
        if (done || this.hearing.get(hearing.identity) !== hearing) return;
        if (!hearing.muted) this.emit({ type: 'audio', identity: hearing.identity, pcm: { samples: value.data, sampleRate: value.sampleRate } });
      }
    } catch {
      // the track went away; TrackUnsubscribed or ParticipantDisconnected reports it
    }
  }

  private setMuted(publication: TrackPublication, participant: Participant, muted: boolean) {
    const hearing = this.hearing.get(participant.identity);
    if (!hearing || hearing.trackSid !== publication.sid || hearing.muted === muted) return;
    hearing.muted = muted;
    this.emit(muted ? { type: 'speaker-left', identity: participant.identity, reason: 'muted' } : { type: 'speaker-joined', speaker: speaker(participant) });
  }

  /** Stops hearing someone (only that track, when `trackSid` is given); `reason` null reports nothing. */
  private stopHearing(identity: string, trackSid: string | null | undefined, reason: 'muted' | 'left' | null) {
    const hearing = this.hearing.get(identity);
    if (hearing && (!trackSid || hearing.trackSid === trackSid)) {
      this.hearing.delete(identity);
      void hearing.reader.cancel().catch(() => {});
      if (reason && !hearing.muted) this.emit({ type: 'speaker-left', identity, reason });
      return;
    }
    if (reason === 'left') this.emit({ type: 'speaker-left', identity, reason });
  }

  private release() {
    for (const hearing of this.hearing.values()) void hearing.reader.cancel().catch(() => {});
    this.hearing.clear();
  }
}

/** A person, not Vowe or another agent. */
function isPerson(p: Participant): boolean {
  return p.kind !== ParticipantKind.AGENT && p.identity !== VOWE_IDENTITY;
}

function speaker(p: Participant) {
  return { identity: p.identity, name: p.name || null };
}
