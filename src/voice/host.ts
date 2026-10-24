import type { CanvasCommand, CanvasRelay, ContextSource, SpeechRecognizer, SpeechSynthesizer, Speaker, SpokenTurn, TurnContext, VoiceReasoning, VoiceState } from './contract.js';
import type { LiveKitAccess } from './livekit.js';
import { VoiceParticipant, type VoiceEvent } from './participant.js';

/**
 * Brings Vowe into the call of the room you're in, from this machine's main process, and takes it out
 * again. One Vowe at a time. It's the only way in: the renderer asks for it by room id, and the Vowe
 * API decides whether you may (POST /vowe/token: members, not viewers).
 *
 * What it relays between the call and the room's renderer, since both of those live in the renderer:
 *   - context: what you have selected and which view is open (setContext), for the questions you ask
 *   - canvas:  the reasoning runtime's commands go to the renderer (`canvas-command`), whose canvas
 *              engine applies them and answers with canvasResult(); Vowe never draws
 */

export interface VoiceStatus {
  roomId: string | null;
  status: 'off' | 'joining' | 'on' | 'failed';
  state: VoiceState;
  /** Why it failed or stopped, if it did. */
  error: string | null;
}

export type VoiceHostEvent =
  | { type: 'status'; status: VoiceStatus }
  | { type: 'voice'; roomId: string; event: VoiceEvent }
  | { type: 'canvas-command'; roomId: string; turnId: string; requester: Speaker; command: CanvasCommand };

export interface VoiceHostDeps {
  /** The signed-in person, by cloud user id. */
  self(): Promise<Speaker>;
  /** Vowe's seat in the room's call (POST /vowe/token). Rejects with a reason to show. */
  seat(roomId: string): Promise<LiveKitAccess>;
  speech(roomId: string): Promise<{ recognizer: SpeechRecognizer; synthesizer: SpeechSynthesizer }>;
  reasoning(roomId: string, self: Speaker): VoiceReasoning;
  /** For tests: a transport other than LiveKit. */
  transport?(seat: () => Promise<LiveKitAccess>): ConstructorParameters<typeof VoiceParticipant>[0]['transport'];
}

const CANVAS_TIMEOUT_MS = 10_000;

export class VoiceHost {
  private participant: VoiceParticipant | null = null;
  private _status: VoiceStatus = { roomId: null, status: 'off', state: 'listening', error: null };
  private readonly listeners = new Set<(e: VoiceHostEvent) => void>();
  private readonly contexts = new Map<string, TurnContext>();
  private readonly pendingCanvas = new Map<string, { resolve: (o: 'applied' | 'rejected') => void; timer: ReturnType<typeof setTimeout> }>();
  private selfId: string | null = null;

  constructor(private readonly deps: VoiceHostDeps) {}

  get status(): VoiceStatus {
    return this._status;
  }

  onEvent(listener: (e: VoiceHostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Brings Vowe into the room's call. Resolves once it's in and listening; rejects with a reason to show. */
  async start(roomId: string): Promise<VoiceStatus> {
    if (this._status.roomId === roomId && (this._status.status === 'on' || this._status.status === 'joining')) return this._status;
    await this.stop();
    this.setStatus({ roomId, status: 'joining', state: 'listening', error: null });
    try {
      const self = await this.deps.self();
      this.selfId = self.identity;
      const { recognizer, synthesizer } = await this.deps.speech(roomId);
      const seat = () => this.deps.seat(roomId);
      const participant = new VoiceParticipant({
        roomId,
        summonedBy: self,
        // Loaded on first use: the LiveKit native library stays out of the app until Vowe is brought in.
        transport: this.deps.transport?.(seat) ?? new (await import('./livekit.js')).LiveKitTransport(seat),
        recognizer,
        synthesizer,
        reasoning: this.deps.reasoning(roomId, self),
        canvas: this.canvasRelay(roomId),
        context: this.contextSource(),
        onEvent: (event) => this.onVoice(participant, roomId, event),
      });
      this.participant = participant;
      await participant.start();
      if (this.participant !== participant) return this._status; // stopped while joining
      this.setStatus({ status: 'on' });
    } catch (err) {
      const participant = this.participant;
      this.participant = null;
      await participant?.stop().catch(() => {});
      this.setStatus({ status: 'failed', error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
    return this._status;
  }

  /** Takes Vowe out of the call (leaving, signing out, quitting). Safe to call when it isn't in one. */
  async stop(): Promise<void> {
    const participant = this.participant;
    this.participant = null;
    for (const [id, pending] of this.pendingCanvas) {
      clearTimeout(pending.timer);
      pending.resolve('rejected');
      this.pendingCanvas.delete(id);
    }
    this.contexts.clear();
    if (participant) await participant.stop('Stopped');
    if (this._status.status !== 'off') this.setStatus({ roomId: null, status: 'off', state: 'listening', error: null });
  }

  /** You held the mic button to talk over Vowe. */
  interrupt() {
    if (this.selfId) this.participant?.interrupt(this.selfId);
  }

  /** What you're looking at in the room; attached to the questions you ask. */
  setContext(roomId: string, context: TurnContext) {
    if (roomId !== this._status.roomId || !this.selfId) return;
    this.contexts.set(this.selfId, context);
  }

  /** The canvas engine's answer to a `canvas-command`. */
  canvasResult(commandId: string, outcome: 'applied' | 'rejected') {
    const pending = this.pendingCanvas.get(commandId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingCanvas.delete(commandId);
    pending.resolve(outcome);
  }

  private canvasRelay(roomId: string): CanvasRelay {
    return {
      apply: (command: CanvasCommand, turn: SpokenTurn) =>
        new Promise((resolve) => {
          // Settles on its own eventually, so a renderer that never answers can't leak these.
          const timer = setTimeout(() => (this.pendingCanvas.delete(command.id), resolve('rejected')), CANVAS_TIMEOUT_MS);
          this.pendingCanvas.set(command.id, { resolve, timer });
          this.emit({ type: 'canvas-command', roomId, turnId: turn.turnId, requester: turn.requester, command });
        }),
    };
  }

  private contextSource(): ContextSource {
    // Only your own selection is known here, until the canvas engine shares everyone's (INTEGRATION.md).
    return { forRequester: (identity) => this.contexts.get(identity) ?? { selection: [], view: null } };
  }

  private onVoice(participant: VoiceParticipant, roomId: string, event: VoiceEvent) {
    if (this.participant !== participant && event.type !== 'stopped') return;
    if (event.type === 'state') this.setStatus({ state: event.state });
    if (event.type === 'stopped' && this.participant === participant) {
      // Ended from the call's side: everyone left, or the room closed.
      this.participant = null;
      this.setStatus({ roomId: null, status: 'off', state: 'listening', error: event.reason });
    }
    this.emit({ type: 'voice', roomId, event });
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
