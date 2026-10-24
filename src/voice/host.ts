import type { CallTransport, HeardSpeech, SpeechRecognizer, SpeechSynthesizer, TransportEvent, VoiceState } from './contract.js';
import { Hearing, type HearingTiming } from './hearing.js';
import type { LiveKitAccess } from './livekit.js';
import { VoweVoice } from './output.js';

/**
 * Your Vowe's voice in the call you're in, from this machine's main process. One call at a time. It's
 * the speech half of the runtime's VoiceAdapter (renderer/shared/vowe-voice.ts), which runs in the
 * room's renderer and decides turns:
 *
 *   renderer → main   your microphone's audio (audio), and VoiceOutput's begin / say / end / cancel
 *   main → renderer   your speech as HumanSpeech (`speech`), for VoiceAdapter.hear; captions (`said`)
 *
 * Vowe joins the call as its own participant, `vowe:<your user id>`, only once you bring it in, and
 * only with a seat the Vowe API gives you for a room you're a member of (POST /vowe/token).
 */

export interface VoiceStatus {
  roomId: string | null;
  status: 'off' | 'joining' | 'on' | 'failed';
  state: VoiceState;
  /** Why it failed or stopped, or the last speech problem while on. */
  error: string | null;
}

export type VoiceHostEvent =
  | { type: 'status'; status: VoiceStatus }
  | { type: 'speech'; roomId: string; speech: HeardSpeech }
  | { type: 'said'; roomId: string; turnId: string; text: string };

export interface VoiceHostDeps {
  /** The signed-in person, by cloud user id. */
  self(): Promise<{ userId: string; name: string | null }>;
  /** Your Vowe's seat in the room's call (POST /vowe/token). Rejects with a reason to show. */
  seat(roomId: string): Promise<LiveKitAccess>;
  speech(roomId: string): Promise<{ recognizer: SpeechRecognizer; synthesizer: SpeechSynthesizer }>;
  timing?: Partial<HearingTiming>;
  /** For tests: a transport other than LiveKit. */
  transport?(seat: () => Promise<LiveKitAccess>, owner: string): CallTransport;
}

const OFF: VoiceStatus = { roomId: null, status: 'off', state: 'listening', error: null };

interface Session {
  roomId: string;
  transport: CallTransport;
  hearing: Hearing;
  voice: VoweVoice;
}

export class VoiceHost {
  private session: Session | null = null;
  private _status: VoiceStatus = OFF;
  private readonly listeners = new Set<(e: VoiceHostEvent) => void>();

  constructor(private readonly deps: VoiceHostDeps) {}

  get status(): VoiceStatus {
    return this._status;
  }

  onEvent(listener: (e: VoiceHostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Brings your Vowe into the room's call. Resolves once it's in and hearing you; rejects with a reason to show. */
  async start(roomId: string): Promise<VoiceStatus> {
    if (this._status.roomId === roomId && (this._status.status === 'on' || this._status.status === 'joining')) return this._status;
    await this.stop();
    this.setStatus({ roomId, status: 'joining', state: 'listening', error: null });
    let session: Session | null = null;
    try {
      const self = await this.deps.self();
      const { recognizer, synthesizer } = await this.deps.speech(roomId);
      const seat = () => this.deps.seat(roomId);
      // Loaded on first use: the LiveKit native library stays out of the app until Vowe is brought in.
      const transport = this.deps.transport?.(seat, self.userId) ?? new (await import('./livekit.js')).LiveKitTransport(seat, self.userId);
      const live = () => this.session === session;
      const voice = new VoweVoice({
        transport,
        synthesizer,
        onState: (state) => {
          if (!live()) return;
          hearing.setVoweSpeaking(state === 'speaking');
          void transport.setAttributes({ state }).catch(() => {});
          this.setStatus({ state });
        },
        onSay: (turnId, text) => live() && this.emit({ type: 'said', roomId, turnId, text }),
        onError: (message) => live() && this.setStatus({ error: message }),
      });
      const hearing = new Hearing({
        self,
        recognizer,
        timing: this.deps.timing,
        onSpeech: (speech) => {
          if (!live()) return;
          // You talked over your own Vowe: silence it now, without waiting for the runtime to wind the turn down.
          if (!speech.final && voice.state === 'speaking') voice.stopCurrent();
          this.emit({ type: 'speech', roomId, speech });
        },
        onError: (message) => live() && this.setStatus({ error: message }),
      });
      session = { roomId, transport, hearing, voice };
      this.session = session;
      await transport.connect((e) => live() && this.onTransport(e));
      await hearing.start();
      if (!live()) return this._status; // stopped while joining
      this.setStatus({ status: 'on' });
    } catch (err) {
      if (session && this.session === session) await this.release(session);
      this.setStatus({ status: 'failed', state: 'listening', error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
    return this._status;
  }

  /** Takes Vowe out of the call (leaving, signing out, quitting). Safe to call when it isn't in one. */
  async stop(reason: string | null = null): Promise<void> {
    const session = this.session;
    if (session) await this.release(session);
    if (this._status.status !== 'off') this.setStatus({ ...OFF, error: reason });
  }

  /** Your microphone: 16 kHz mono PCM, while it's on. */
  audio(roomId: string, samples: Int16Array) {
    if (this.session?.roomId === roomId) this.session.hearing.audio(samples);
  }

  // The runtime's VoiceOutput, called by the renderer's VoiceAdapter.
  begin(turnId: string) {
    this.session?.voice.begin(turnId);
  }
  say(turnId: string, text: string) {
    this.session?.voice.say(turnId, text);
  }
  end(turnId: string) {
    this.session?.voice.end(turnId);
  }
  cancel(turnId: string) {
    this.session?.voice.stop(turnId);
  }

  private onTransport(e: TransportEvent) {
    if (e.type === 'owner-left') void this.stop('You left the call');
    else if (e.type === 'disconnected') void this.stop(e.reason ?? 'Vowe left the call');
  }

  private async release(session: Session) {
    this.session = null;
    session.hearing.stop();
    session.voice.stopCurrent();
    await session.transport.disconnect().catch(() => {});
  }

  private setStatus(patch: Partial<VoiceStatus>) {
    this._status = { ...this._status, ...patch };
    this.emit({ type: 'status', status: this._status });
  }

  private emit(event: VoiceHostEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('[voice] listener failed:', err);
      }
    }
  }
}
