import type { Collaborator } from '../../assistant/index.js';
import type { RoomCheckout } from '../../shared/api.js';
import type { Authorization, ReasoningEvent, Speaker, SpokenTurn, VoiceReasoning } from '../contract.js';

/**
 * Interim: Vowe's voice on the reasoning that is on main today, the Collaborator (src/assistant), until
 * the reasoning runtime (feat/mvp-vowe-runtime) exposes VoiceReasoning itself. It adds no model, prompt,
 * or tools of its own: it frames the spoken turn as a Collaborator message and speaks the reply.
 *
 * What the Collaborator can't do yet, and the runtime must (INTEGRATION.md):
 *   - stream: the reply arrives whole, so Vowe starts speaking only once it's done
 *   - cancel: an interruption stops Vowe waiting and speaking, but the model request runs to completion
 *   - canvas: it has no canvas commands, so none are sent
 *   - per-person access: it runs on this machine's model credentials, so it answers only the person
 *     whose machine this is, and refuses everyone else aloud rather than spend this person's access
 */

export interface CollaboratorReasoningOptions {
  /** A Collaborator for voice turns. Its approvals must decline: nobody can answer a prompt mid-call. */
  collaborator: Collaborator;
  /** The signed-in person on this machine, whose model access the Collaborator uses. */
  owner: Speaker;
  /** Where the room's repository is checked out here (rooms:checkout). */
  checkout(roomId: string): Promise<RoomCheckout | null>;
}

export class CollaboratorReasoning implements VoiceReasoning {
  readonly name = 'collaborator (interim)';
  private readonly conversations = new Map<string, string>();
  private busy = false;

  constructor(private readonly o: CollaboratorReasoningOptions) {}

  async authorize(requester: Speaker): Promise<Authorization> {
    const { owner } = this.o;
    if (requester.identity !== owner.identity) {
      return {
        ok: false,
        code: 'unauthorized',
        message: `${requester.name ?? 'Sorry'}, I can only use ${owner.name ?? 'this person'}’s model access for ${owner.name ? 'their' : 'their own'} questions. Bring me in from your own app to ask me.`,
      };
    }
    if (!this.o.collaborator.status().configured) return { ok: false, code: 'unavailable', message: 'My model isn’t connected on this machine yet.' };
    return { ok: true };
  }

  async *respond(turn: SpokenTurn, signal: AbortSignal): AsyncIterable<ReasoningEvent> {
    const checkout = await this.o.checkout(turn.roomId).catch(() => null);
    if (signal.aborted) return;
    if (!checkout) {
      yield { type: 'error', code: 'unavailable', message: 'This room’s repository isn’t checked out on this machine, so I can’t look at the work.' };
      return;
    }
    // One conversation per room keeps follow-ups in context; a request still running after an
    // interruption gets a fresh one, since the Collaborator answers one message at a time.
    const conversationId = this.busy ? null : (this.conversations.get(turn.roomId) ?? null);
    this.busy = true;
    const reply = this.o.collaborator
      .send(conversationId, { repositoryId: checkout.repositoryId, workstreamId: null }, framed(turn))
      .finally(() => (this.busy = false));
    reply.catch(() => {}); // abandoned on interruption; its outcome no longer matters

    const aborted = new Promise<null>((resolve) => {
      if (signal.aborted) resolve(null);
      signal.addEventListener('abort', () => resolve(null), { once: true });
    });
    let answer;
    try {
      answer = await Promise.race([reply, aborted]);
    } catch (err) {
      yield { type: 'error', code: 'failed', message: err instanceof Error ? err.message : String(err) };
      return;
    }
    if (!answer) return;
    this.conversations.set(turn.roomId, answer.conversationId);
    for (const call of answer.toolCalls) {
      yield { type: 'tool', phase: 'started', id: call.id, name: call.name };
      yield { type: 'tool', phase: 'finished', id: call.id, name: call.name, error: call.error };
    }
    yield { type: 'text', delta: answer.text };
    yield { type: 'done', stop: answer.stop };
  }
}

/** The spoken question, with who asked and what they're looking at, and that the answer will be heard. */
function framed(turn: SpokenTurn): string {
  const { selection, view } = turn.context;
  const looking = [
    selection.length ? `Selected on the canvas: ${selection.map((s) => (s.label ? `${s.label} (${s.id})` : s.id)).join(', ')}.` : '',
    view ? `Canvas view: ${view}.` : '',
  ].filter(Boolean);
  return [
    `[Spoken aloud in the room's call by ${turn.requester.name ?? 'a participant'}. ${looking.join(' ')}`.trim(),
    'Your answer will be read aloud: two to four short spoken sentences, no lists, code, or citations.]',
    '',
    turn.text,
  ].join('\n');
}
