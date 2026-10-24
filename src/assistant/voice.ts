/**
 * The seam for a future LiveKit voice participant. It doesn't hear or speak itself: speech-to-text
 * hands it human speech, and it hands back what to say and what to draw. Its brain is the same runtime
 * as typed questions (Collaborator.ask); it only decides when a turn starts and when one is interrupted.
 *
 *   hear(partial)  someone is talking: if Vowe is answering, it stops (barge-in).
 *   hear(final)    a finished utterance: kept as conversation context, and if the local person
 *                  addressed Vowe, it becomes a turn.
 *   events         the turn's AgentEvents, in order: text.delta for speech as it streams, canvas.command
 *                  for the canvas engine, approval.requested for the person to answer on screen, and one
 *                  ending event.
 *
 * Per-user, like every turn: only the person signed in on this machine can start one here. Others in
 * the call are heard as context; their own machines answer their questions.
 */

import type { AgentEvent, RoomAgentReply, RoomAgentTurn } from '../shared/api.js';
import type { CanvasSnapshot } from './canvas.js';
import type { Collaborator, TurnHandle } from './index.js';

export interface HumanSpeech {
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
  /** The cloud user signed in on this machine. */
  localUserId: string;
  /** The local person's canvas right now, read when a turn starts. */
  canvas(): CanvasSnapshot;
  /** Every event of every turn, for speech, captions and the canvas. */
  onEvent(event: AgentEvent): void;
}

const RECENT_TURNS = 8;
const WAKE = /^\s*(hey\s+)?vowe\b[\s,.:!?-]*/i;

export class VoiceAdapter {
  private current: TurnHandle | null = null;
  private conversationId: string | null = null;
  private recent: RoomAgentTurn['recentTurns'] = [];

  constructor(
    private readonly agent: Pick<Collaborator, 'ask'>,
    private readonly options: VoiceAdapterOptions,
  ) {}

  /** Whether a turn is running (thinking or speaking). */
  get busy() {
    return this.current !== null;
  }

  hear(speech: HumanSpeech): TurnHandle | null {
    const text = speech.text.trim();
    if (!text) return null;
    // Anyone talking over Vowe stops it; their words are the next thing to listen to.
    if (this.current) this.current.cancel('interrupted');
    if (!speech.final) return null;

    const addressed = speech.addressed ?? WAKE.test(text);
    const question = text.replace(WAKE, '').trim();
    const local = speech.participant.userId === this.options.localUserId;
    if (!addressed || !local || !question) {
      this.remember(speech.participant.name ?? 'someone', text, speech.at);
      return null;
    }
    return this.start(speech, question);
  }

  /** Stops whatever Vowe is doing, e.g. when the person leaves the call. */
  stop() {
    this.current?.cancel('cancelled');
  }

  private start(speech: HumanSpeech, question: string): TurnHandle {
    const handle = this.agent.ask(
      {
        roomId: this.options.roomId,
        participant: speech.participant,
        question,
        recentTurns: this.recent.slice(-RECENT_TURNS),
        canvas: this.options.canvas(),
        conversationId: this.conversationId,
        source: 'voice',
      },
      (event) => {
        if (event.type === 'turn.started') this.conversationId = event.conversationId;
        this.options.onEvent(event);
      },
    );
    this.current = handle;
    this.remember(speech.participant.name ?? 'someone', question, speech.at);
    void handle.done.then((reply: RoomAgentReply) => {
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
 * One turn as an async iterator of its events, for consumers that prefer `for await`. Breaking out of
 * the loop cancels the turn.
 */
export function streamTurn(agent: Pick<Collaborator, 'ask'>, turn: RoomAgentTurn): AsyncIterable<AgentEvent> & { handle: TurnHandle } {
  const queue: AgentEvent[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  const handle = agent.ask(turn, (event) => {
    queue.push(event);
    if (event.type === 'turn.completed' || event.type === 'turn.cancelled' || event.type === 'turn.failed') ended = true;
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
