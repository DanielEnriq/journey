import { AudioFrame, AudioSource, LocalAudioTrack, Room, RoomEvent, TrackPublishOptions, TrackSource } from '@livekit/rtc-node';
import type { CallTransport, TransportEvent } from './contract.js';

/**
 * One person's Vowe in a room's LiveKit call (`room:<room id>`), from their app's main process: the
 * same LiveKit room the people's CallService joins (renderer/calls), as a participant of its own.
 *
 * It joins with a Vowe token for the signed-in person (server/src/vowe-voice.ts): identity
 * `vowe:<their user id>`, named "Vowe (for <name>)", kind agent, attributes `kind: vowe` and
 * `speaksFor`. It publishes one microphone track of Vowe's speech, can't subscribe to anyone (it hears
 * through its person's own microphone, in their app), and never publishes video or data.
 */

/** Frame size for outgoing speech: small, so an interruption clears quickly. */
const OUT_FRAME_MS = 10;

export interface LiveKitAccess {
  url: string;
  token: string;
}

export class LiveKitTransport implements CallTransport {
  readonly outputRate = 24000;
  private room: Room | null = null;
  private source: AudioSource | null = null;
  private track: LocalAudioTrack | null = null;
  private emit: (e: TransportEvent) => void = () => {};
  /** Bumped by clear(), so a play() in progress stops queueing what's left of it. */
  private generation = 0;
  private closed = false;

  /** `owner`: the cloud user id of the person this Vowe speaks for. */
  constructor(
    private readonly access: () => Promise<LiveKitAccess>,
    private readonly owner: string,
  ) {}

  async connect(onEvent: (e: TransportEvent) => void) {
    if (this.room) throw new Error('Already connected');
    this.emit = onEvent;
    const { url, token } = await this.access();
    const room = new Room();
    this.room = room;

    room
      .on(RoomEvent.ParticipantDisconnected, (participant) => {
        if (participant.identity === this.owner) this.emit({ type: 'owner-left' });
      })
      .on(RoomEvent.Reconnecting, () => this.emit({ type: 'reconnecting' }))
      .on(RoomEvent.Reconnected, () => this.emit({ type: 'reconnected' }))
      .on(RoomEvent.Disconnected, (reason) => {
        if (this.closed) return;
        this.emit({ type: 'disconnected', reason: `LiveKit disconnected (${reason})` });
      });

    try {
      await room.connect(url, token, { autoSubscribe: false, dynacast: false });
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
    await this.track?.close().catch(() => {});
    await this.source?.close().catch(() => {});
    this.track = null;
    this.source = null;
    await room?.disconnect().catch(() => {});
    this.room = null;
  }
}
