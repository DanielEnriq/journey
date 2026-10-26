import type { AgentEvent, CanvasSnapshot, HeardSpeech, JourneyApi, VoiceStatus } from '../../shared/api.js';
import type { CallSnapshot } from '../calls/service.js';
import { VoiceAdapter, agentOverIpc, isVoweVoice, type VoiceOutput } from '../shared/vowe-voice.js';
import { tapMicrophone, type MicrophoneTap, type TapMicrophone } from './microphone.js';

/**
 * Your Vowe in the call you're in: the runtime's VoiceAdapter (shared/vowe-voice.ts), connected to
 * speech in main and to the call.
 *
 *   your microphone track ─ tap ─▶ voice.audio ─▶ main: speech recognition ─▶ voice.onSpeech ─▶ adapter.hear
 *   adapter ─ VoiceOutput ─▶ voice.begin / say / end / cancel ─▶ main: speech ─▶ "Vowe (for you)" in the call
 *   someone else starts talking while your Vowe speaks ─▶ adapter.hear(interim) + voice.cancel: it stops
 *
 * Only you start turns here, on your own model sign-in (the runtime checks). Other people's speech is
 * never transcribed here: their own app hears them. Everyone's Vowe (`vowe:…`) is ignored entirely.
 */

export interface CallVoiceOptions {
  api: Pick<JourneyApi, 'agent' | 'voice'>;
  roomId: string;
  /** The cloud user signed in here. */
  localUser: { userId: string; name: string | null };
  /** Your canvas right now (CanvasSnapshot v1), read when a turn starts. */
  canvas(): CanvasSnapshot;
  /** The call: who's talking, and whether your microphone is on (CallService). */
  call: { onChange(listener: (snapshot: CallSnapshot) => void): () => void };
  /**
   * Your published microphone track, or null. CallService doesn't expose it: build it with `createRoom`
   * keeping the Room, then `room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack`.
   */
  microphone(): MediaStreamTrack | null | undefined;
  /**
   * When your Vowe answers: 'asked' only when you say "Vowe, …"; 'pauses' also whatever you say, once
   * you pause and nobody else is talking. Read as each thing you say ends. Defaults to 'asked'.
   */
  answers?(): 'pauses' | 'asked';
  /** You said something your Vowe is answering without being asked by name ('pauses'). */
  onOverheard?(question: string): void;
  /** Every event of every turn: captions, approvals, canvas commands, errors (show those to you only). */
  onEvent?(event: AgentEvent): void;
  /** For tests. */
  tap?: TapMicrophone;
  /** For tests: how long a pause is before Vowe chimes in. */
  pauseMs?: number;
}

/** After the recognizer ends a sentence (itself ~0.6 s of silence), how much longer before Vowe chimes in. */
export const CHIME_PAUSE_MS = 1000;

export class CallVoice {
  private adapter: VoiceAdapter | null = null;
  private readonly subscriptions: (() => void)[] = [];
  private turnId: string | null = null;
  private voweSpeaking = false;
  private talking = new Set<string>();
  private microphone: { track: MediaStreamTrack; tap: Promise<MicrophoneTap | null> } | null = null;
  /** What you've said since you last paused, while chiming in at pauses. */
  private said: { speech: HeardSpeech; text: string; timer: ReturnType<typeof setTimeout> | null } | null = null;

  constructor(private readonly o: CallVoiceOptions) {}

  /** Brings your Vowe into the call. Rejects with a reason to show (not a member, a viewer, no Vowe API…). */
  async start(): Promise<VoiceStatus> {
    if (this.adapter) return this.o.api.voice.status();
    const { api, roomId } = this.o;
    const status = await api.voice.start(roomId);
    const output: VoiceOutput = {
      begin: ({ turnId }) => void api.voice.begin(turnId),
      say: (turnId, text) => void api.voice.say(turnId, text),
      end: (turnId) => void api.voice.end(turnId),
      stop: (turnId) => void api.voice.cancel(turnId),
    };
    this.adapter = new VoiceAdapter(agentOverIpc(api.agent), {
      roomId,
      localUser: this.o.localUser,
      canvas: this.o.canvas,
      output,
      onEvent: (event) => {
        if (event.type === 'turn.started') this.turnId = event.turnId;
        else if ((event.type === 'turn.completed' || event.type === 'turn.cancelled' || event.type === 'turn.failed') && event.turnId === this.turnId) this.turnId = null;
        this.o.onEvent?.(event);
      },
    });
    this.subscriptions.push(
      api.voice.onSpeech((update) => update.roomId === roomId && this.heard(update.speech)),
      api.voice.onStatus((s) => {
        this.voweSpeaking = s.state === 'speaking';
        if (s.status === 'off' || s.status === 'failed') this.release(); // main took it out of the call
      }),
      this.o.call.onChange((snapshot) => this.follow(snapshot)),
    );
    return status;
  }

  /** Takes your Vowe out of the call, cancelling anything it's doing. */
  async stop(): Promise<void> {
    this.release();
    await this.o.api.voice.stop();
  }

  private release() {
    this.unsay();
    this.adapter?.stop();
    this.adapter = null;
    this.turnId = null;
    for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe();
    this.untap();
  }

  /**
   * Your speech, to the adapter. Asked by name, it's a turn as it is. Chiming in at pauses, the rest is
   * held until you pause, then becomes one turn; partials still pass, so talking stops Vowe as before.
   */
  private heard(speech: HeardSpeech) {
    if (!this.adapter) return;
    if (speech.addressed || this.o.answers?.() !== 'pauses') {
      if (speech.final) this.unsay();
      this.adapter.hear(speech);
      return;
    }
    const text = speech.text.trim();
    if (!speech.final) {
      // Still talking: wait for the next pause.
      if (text && text !== '…' && this.said?.timer) {
        clearTimeout(this.said.timer);
        this.said.timer = null;
      }
      this.adapter.hear(speech);
      return;
    }
    if (!text) return;
    if (this.said?.timer) clearTimeout(this.said.timer);
    this.said = { speech, text: this.said ? `${this.said.text} ${text}` : text, timer: null };
    this.wait();
  }

  private wait() {
    const said = this.said;
    if (!said) return;
    said.timer = setTimeout(() => {
      if (this.said !== said || !this.adapter) return;
      // Someone else has the floor: chime in once they stop.
      if (this.talking.size) return this.wait();
      this.said = null;
      this.o.onOverheard?.(said.text);
      this.adapter.hear({ ...said.speech, text: said.text, final: true, addressed: true });
    }, this.o.pauseMs ?? CHIME_PAUSE_MS);
  }

  private unsay() {
    if (this.said?.timer) clearTimeout(this.said.timer);
    this.said = null;
  }

  private follow(snapshot: CallSnapshot) {
    if (!this.adapter) return;
    if (snapshot.status !== 'connected' && snapshot.status !== 'reconnecting') return void this.untap();
    const track = snapshot.micEnabled ? this.o.microphone() : null;
    if (track?.id !== this.microphone?.track.id) {
      this.untap();
      if (track) this.retap(track);
    }

    // Someone else talking over your Vowe stops it. Not while it's only thinking: people talking among
    // themselves then shouldn't cancel your question.
    const talking = new Set(snapshot.participants.filter((p) => !p.isLocal && p.isSpeaking && !isVoweVoice(p.identity)).map((p) => p.identity));
    for (const identity of talking) {
      if (this.talking.has(identity) || !this.voweSpeaking) continue;
      const person = snapshot.participants.find((p) => p.identity === identity)!;
      if (this.turnId) void this.o.api.voice.cancel(this.turnId); // silence now, while the runtime winds the turn down
      this.adapter.hear({ participant: { userId: identity, name: person.name }, text: '…', final: false });
    }
    this.talking = talking;
  }

  private retap(track: MediaStreamTrack) {
    const { api, roomId } = this.o;
    const microphone: { track: MediaStreamTrack; tap: Promise<MicrophoneTap | null> } = { track, tap: Promise.resolve(null) };
    this.microphone = microphone;
    microphone.tap = (this.o.tap ?? tapMicrophone)(track, (pcm) => {
      if (this.microphone === microphone) void api.voice.audio(roomId, new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
    }).catch((err: Error) => {
      console.warn('[voice] could not listen to the microphone:', err.message);
      return null;
    });
  }

  private untap() {
    const microphone = this.microphone;
    this.microphone = null;
    void microphone?.tap.then((tap) => tap?.stop());
  }
}
