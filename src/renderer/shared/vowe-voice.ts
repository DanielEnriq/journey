/**
 * Vowe in a voice call, on one person's machine. It doesn't hear or speak itself: speech-to-text hands
 * it the local person's speech, and it hands Vowe's answer to a VoiceOutput, which turns it into audio
 * in the call. Its brain is the same runtime as typed questions (Collaborator.ask in main, reached over
 * IPC with agentOverIpc); this only decides when a turn starts and when one is interrupted.
 *
 *   hear(partial)  someone is talking: if Vowe is answering, it stops (barge-in).
 *   hear(final)    a finished utterance: kept as conversation context, and if the local person
 *                  addressed Vowe, it becomes a turn.
 *   output         begin / say (streamed text) / end, or stop when interrupted or failed.
 *   onEvent        every AgentEvent, for captions, approvals and the canvas.
 *
 * Per-user: only the person signed in here starts turns here, and they run on this machine's model
 * sign-in. Vowe's voice is published to the call as speaking for that person (VOWE_VOICE). Nobody's
 * question is ever answered on someone else's ChatGPT plan: their own machine answers it, or nobody does.
 * See src/assistant/INTEGRATION.md → Voice.
 */

import type { AgentEvent, JourneyApi, RoomAgentReply, RoomAgentTurn } from '../../shared/api.js';
import type { CanvasSnapshot } from '../../assistant/canvas.js';

/** A turn in flight: what Collaborator.ask returns in main, and agentOverIpc in the renderer. */
export interface VoiceTurnHandle {
  turnId: string;
  /** Resolves when the turn ends, however it ends; never rejects. */
  done: Promise<RoomAgentReply>;
  cancel(reason?: 'interrupted' | 'cancelled'): void;
}

/** The runtime, as the adapter needs it. */
export interface VoiceAgent {
  ask(turn: RoomAgentTurn, onEvent: (event: AgentEvent) => void): VoiceTurnHandle;
}

/**
 * How Vowe's voice is published to the shared LiveKit call: a participant of its own per speaker, so
 * every client can show who it answers for and nobody's microphone carries it. Needs the token service to
 * mint this identity for the signed-in user only (INTEGRATION.md → Voice: unresolved).
 */
export const VOWE_VOICE = {
  identity: (userId: string) => `vowe:${userId}`,
  name: (personName: string | null) => `Vowe (for ${personName ?? 'a member'})`,
  /** Participant attributes, so clients can tell Vowe apart and who it speaks for. */
  attributes: (userId: string) => ({ kind: 'vowe', speaksFor: userId }),
} as const;

export const isVoweVoice = (identity: string) => identity.startsWith('vowe:');

/** Turns streamed text into audio in the call (TTS, then publishing as VOWE_VOICE). Implemented by the call layer. */
export interface VoiceOutput {
  /** A turn is about to speak, for the local person. */
  begin(turn: { turnId: string; speaksFor: { userId: string; name: string | null } }): void;
  /** More answer text, in order. */
  say(turnId: string, text: string): void;
  /** The answer is complete: finish speaking what was said. */
  end(turnId: string): void;
  /** Stop now and drop anything unspoken: interrupted, cancelled or failed. */
  stop(turnId: string): void;
}

export interface HumanSpeech {
  /** The LiveKit participant identity (the cloud user id) whose audio this is, never something a model said. */
  participant: { userId: string; name: string | null };
  text: string;
  /** False while the speaker is still talking (an interim transcript). */
  final: boolean;
  /** Set when the client knows the speech is for Vowe (push-to-ask); otherwise it must start with "Vowe". */
  addressed?: boolean;
  at?: string;
}

export interface VoiceAdapterOptions {
  roomId: string;
  /** The cloud user signed in on this machine; the runtime refuses turns for anyone else. */
  localUser: { userId: string; name: string | null };
  /** The local person's canvas right now, read when a turn starts. */
  canvas(): CanvasSnapshot;
  output?: VoiceOutput;
  /** Every event of every turn. */
  onEvent?(event: AgentEvent): void;
}

const RECENT_TURNS = 8;
const WAKE = /^\s*(hey\s+)?vowe\b[\s,.:!?-]*/i;
const ENDED = new Set<AgentEvent['type']>(['turn.completed', 'turn.cancelled', 'turn.failed']);

export class VoiceAdapter {
  private current: VoiceTurnHandle | null = null;
  private conversationId: string | null = null;
  private recent: RoomAgentTurn['recentTurns'] = [];

  constructor(
    private readonly agent: VoiceAgent,
    private readonly options: VoiceAdapterOptions,
  ) {}

  /** Whether a turn is running (thinking or speaking). */
  get busy() {
    return this.current !== null;
  }

  hear(speech: HumanSpeech): VoiceTurnHandle | null {
    const text = speech.text.trim();
    // Vowe's own voice (anyone's) is not a person: it neither interrupts nor counts as what was said.
    if (!text || isVoweVoice(speech.participant.userId)) return null;
    // Anyone talking over Vowe stops it; their words are the next thing to listen to.
    if (this.current) this.current.cancel('interrupted');
    if (!speech.final) return null;

    const addressed = speech.addressed ?? WAKE.test(text);
    const question = text.replace(WAKE, '').trim();
    const local = speech.participant.userId === this.options.localUser.userId;
    if (!addressed || !local || !question) {
      this.remember(speech.participant.name ?? 'someone', text, speech.at);
      return null;
    }
    return this.start(question, speech.at);
  }

  /** Stops whatever Vowe is doing, e.g. when the person leaves the call. */
  stop() {
    this.current?.cancel('cancelled');
  }

  private start(question: string, at?: string): VoiceTurnHandle {
    const { output, localUser } = this.options;
    const handle = this.agent.ask(
      {
        roomId: this.options.roomId,
        participant: localUser,
        question,
        recentTurns: this.recent.slice(-RECENT_TURNS),
        canvas: this.options.canvas(),
        conversationId: this.conversationId,
        source: 'voice',
      },
      (event) => {
        if (event.type === 'turn.started') {
          this.conversationId = event.conversationId;
          output?.begin({ turnId: event.turnId, speaksFor: localUser });
        } else if (event.type === 'text.delta') output?.say(event.turnId, event.delta);
        else if (event.type === 'turn.completed') output?.end(event.turnId);
        // Errors and cancellations are shown to the local person, never spoken into the room.
        else if (event.type === 'turn.cancelled' || event.type === 'turn.failed') output?.stop(event.turnId);
        this.options.onEvent?.(event);
      },
    );
    this.current = handle;
    this.remember(localUser.name ?? 'someone', question, at);
    void handle.done.then((reply) => {
      if (this.current === handle) this.current = null;
      if (reply.stop !== 'cancelled' && reply.stop !== 'failed' && reply.text) this.remember('Vowe', reply.text);
      // A conversation the runtime no longer knows starts over on the next question.
      if (reply.error?.code === 'invalid-turn') this.conversationId = null;
    });
    return handle;
  }

  private remember(speaker: string, text: string, at?: string) {
    this.recent.push({ speaker, text: text.slice(0, 4000), ...(at ? { at } : {}) });
    if (this.recent.length > RECENT_TURNS * 2) this.recent.splice(0, this.recent.length - RECENT_TURNS);
  }
}

/**
 * The runtime in main, as a VoiceAgent: journey.agent.ask, its events filtered to the turn, and
 * journey.agent.cancel. Events can arrive before ask() resolves with the turn id, so they're held until then.
 */
export function agentOverIpc(api: Pick<JourneyApi['agent'], 'ask' | 'cancel' | 'onEvent'>): VoiceAgent {
  return {
    ask(turn, onEvent) {
      let turnId: string | null = null;
      let early: AgentEvent[] = [];
      let cancelled = false;
      let finish!: (reply: RoomAgentReply) => void;
      const done = new Promise<RoomAgentReply>((resolve) => (finish = resolve));
      const deliver = (event: AgentEvent) => {
        onEvent(event);
        if (event.type === 'turn.completed' || event.type === 'turn.cancelled' || event.type === 'turn.failed') {
          off();
          finish(event.reply);
        }
      };
      const off = api.onEvent((event) => {
        if (turnId === null) early.push(event);
        else if (event.turnId === turnId) deliver(event);
      });
      const handle: VoiceTurnHandle = {
        turnId: '',
        done,
        cancel() {
          cancelled = true;
          if (turnId) void api.cancel(turnId);
        },
      };
      api.ask(turn).then(
        (started) => {
          turnId = handle.turnId = started.turnId;
          const held = early.filter((e) => e.turnId === started.turnId);
          early = [];
          held.forEach(deliver);
          if (cancelled) void api.cancel(started.turnId);
        },
        (err) => {
          off();
          const error = { code: 'other' as const, message: err instanceof Error ? err.message : String(err), retryable: false };
          const reply = { turnId: '', conversationId: '', roomId: turn.roomId, text: '', stop: 'failed', error } as RoomAgentReply;
          onEvent({ type: 'turn.failed', turnId: '', error, reply });
          finish(reply);
        },
      );
      return handle;
    },
  };
}

/**
 * One turn as an async iterator of its events, for consumers that prefer `for await`. Breaking out of
 * the loop cancels the turn.
 */
export function streamTurn(agent: VoiceAgent, turn: RoomAgentTurn): AsyncIterable<AgentEvent> & { handle: VoiceTurnHandle } {
  const queue: AgentEvent[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  const handle = agent.ask(turn, (event) => {
    queue.push(event);
    if (ENDED.has(event.type)) ended = true;
    wake?.();
  });
  return {
    handle,
    async *[Symbol.asyncIterator]() {
      try {
        while (true) {
          while (queue.length) yield queue.shift()!;
          if (ended) return;
          await new Promise<void>((resolve) => (wake = resolve));
          wake = null;
        }
      } finally {
        if (!ended) handle.cancel('cancelled');
      }
    },
  };
}
