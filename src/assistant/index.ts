/**
 * Vowe's agent runtime: one tool-calling loop over a model provider, a tool registry, the work
 * context and, in a room, the room's record and the asker's canvas. It explains and questions the
 * work; it never changes code or steers coding agents. Its only outputs are words, a checked account
 * of what they rest on, and validated canvas requests.
 *
 * Transport-agnostic, and the only brain: the developer text screen calls send(); rooms call ask(),
 * typed (main/ipc.ts) or spoken (voice.ts adapts a call's speech to the same ask()). Approval prompts
 * go through `approve`, so each surface asks the person its own way.
 *
 * Per-user by construction: a room turn runs on the asking person's machine, for the person signed in
 * there, with their model sign-in and their local context. A turn for anyone else is refused, so one
 * member's ChatGPT plan, transcripts and code never answer another member's question.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  AgentApprovalRequest,
  AgentContext,
  AgentError,
  AgentEvent,
  AgentProviderInfo,
  AgentReply,
  AgentStatus,
  AgentToolCall,
  RoomAgentReply,
  RoomAgentTurn,
} from '../shared/api.js';
import { canvasSnapshotSchema, focusOf, validateCanvasCommand, type CanvasCommand, type CanvasSnapshot } from './canvas.js';
import { EvidenceLedger, groundingForRoom, type Claim, type Grounding } from './evidence.js';
import { ModelProviderError, isAbort, type ModelItem, type ModelProvider, type ModelResponse, type ModelToolDefinition } from './provider.js';
import type { AgentTool, RoomSource, ToolContext, WorkContextReader } from './tools.js';

/** Model calls per question: enough to look around, read code, and answer, without running away. */
const MAX_STEPS = 10;
/** A safety net on top of each tool's own limits. */
const MAX_TOOL_RESULT = 40_000;
const MAX_CONVERSATIONS = 20;

const EVIDENCE_RULES = `Reading the evidence:
- Activity is observed two ways, and each event names its source: "transcript" (Vowe reads what Claude Code appends to its transcript: prompts, tool results, completed turns) and "hook" (optional Claude Code hooks, which also report sessions starting and ending).
- Session state follows the latest event. "active" means activity was observed in the last few minutes; "turn-completed" means Claude Code finished responding and is waiting on its user; "ended" means a hook reported the session closed; "unknown" means nothing recent was observed. None of these proves a process is running now: say what was last observed and when. Only a hook can confirm a session ended; a transcript going quiet doesn't.
- Each link between a session and a workstream names its basis: "cwd" (Git places the session's directory in that worktree), "cwd-path" (the directory no longer exists, so only its path matched), or "edited-files" (its file tools touched files there). branchMatch compares the branch the session recorded with the worktree's: "detached" means the session recorded a detached HEAD, "different" or "unknown" mean the link is less certain. Say so rather than smoothing it over.
- A transcript records what Claude Code said and did, not what is true now. Check claims about changes against Git. Report tests as run or passing only when a transcript shows the command and its output.
- If the person declines to share a session or code, work from what you have and say what you couldn't check.`;

const SYSTEM_PROMPT = `You are Vowe, an engineering collaborator. People use you to understand and reason about software work that independent coding agents (currently Claude Code) are doing in their repositories. You help them see what is happening, think it through, and decide. You don't write or run code, and you can't start, steer, or stop coding agents.

Your tools are read-only views of this machine: Claude Code sessions (metadata, and messages from sessions the user lets you read), observed activity, real Git state, and tracked code the user lets you read. Check them before answering questions about the work, and check again when the state may have changed since an earlier turn.

${EVIDENCE_RULES}

Answering:
- Lead with the answer. Keep it short: a few sentences or a tight list. Don't narrate your process.
- Keep observations and interpretation apart. Mark inferences as inferred, and say what evidence would settle them.
- Cite the evidence behind important claims inline: sessions as \`session 1a2b3c4d #42\` (the message index), files as \`path/to/file.ts:12\`, Git facts by source (\`git status\`, \`git diff\`, a short commit hash).
- When the evidence is insufficient, say so plainly. When a question is ambiguous (which session, which branch) and the tools can't settle it, ask one specific question.
- Raise concerns and open questions when they matter: uncommitted or unpushed work, sessions that ended mid-task, overlapping changes across worktrees, questions in a transcript that were never answered.`;

const ROOM_PROMPT = `You are Vowe, an engineering collaborator in a shared room. The people in the room reason together about a system drawn on a shared canvas, and about the software work coding agents (currently Claude Code) do on it. You answer one person at a time: the asker named in the context, on their machine. You don't write or run code, and you can't start, steer, or stop coding agents.

What "this" means: when the asker selected or circled components, their question is about those components first. Resolve the question against them before anything else, and name them as the canvas does.

Where to look, in order of how much it proves:
1. Code and Git (search_code, read_code, get_repository_status, get_worktree_changes): what the system actually does. When a question is about a component's behaviour, look for its implementation, using its name, its "tech" label and any repository paths bound to it.
2. Claude Code sessions (list_coding_sessions, read_coding_session): what was done and tested, and what was said. Not proof of current state.
3. The room's record (get_room_context): the goal, decisions (only "agreed" ones are human-approved), concerns, constraints and notes.
4. The canvas (describe_canvas): what people drew. A drawing, not evidence of behaviour.
If the room's repository isn't checked out on this machine, or sharing is declined, or nothing matches, say so: never invent code, file names, line numbers, test runs or results.

${EVIDENCE_RULES}

Reasoning about failures: walk the sequence step by step, using the actual code paths when you found them. Separate what the code shows (observed), what follows from it (inferred), and the scenario you're asked to imagine (hypothetical). Say what would confirm or rule out each risky step.

Before you answer, call report_reasoning once with your claims, each with its basis (observed, inferred, hypothetical, decided) and the evidence ids your tools returned. Cite only ids you were given. Then write the answer.

The canvas: when a picture would help the room, request it with the canvas tools, naming components by their ids. For "what happens if…" questions about a failure, show the failure view with a sequence (actors in order; steps marking the crash and the bad outcome), and highlight the components at risk. Request only what supports your answer; one or two requests is typical. Canvas requests are seen by the whole room: their reasons, annotations and step text must not quote local code, transcripts or file contents. Describe behaviour in your own words.

Answering:
- Lead with the answer, in plain words people can say back. Keep it short: a few sentences or a tight list. Don't narrate your process.
- Cite important claims inline: files as \`path/to/file.ts:12\`, sessions as \`session 1a2b3c4d #42\`, decisions by title.
- When the evidence is insufficient, say so plainly, and say what would settle it.`;

const VOICE_NOTE = 'This turn is spoken: answer in two to four short sentences, without lists, code formatting or citations in the text (the evidence report carries them).';

interface Conversation {
  id: string;
  items: ModelItem[];
  /** Approved (true) or declined (false) sharing keys. Declines last only for the turn. */
  grants: Map<string, boolean>;
  busy: boolean;
  /** Set for room conversations: they stay in one room, with one asker. */
  roomId: string | null;
  askerId: string | null;
}

/** Where a room's repository is checked out on this machine, if it is. */
export interface RoomCheckoutResolver {
  (roomId: string): Promise<{ repositoryId: string } | null>;
}

export interface CollaboratorOptions {
  /** Picks the provider for each turn (select.ts); called once per turn. */
  provider(): ModelProvider;
  work: WorkContextReader;
  /** Tools for local work; room turns also get roomTools and reasoningTools. */
  tools: AgentTool[];
  roomTools?: AgentTool[];
  reasoningTools?: AgentTool[];
  /** Describes the repository (and workstream) for the model, throwing if it doesn't exist. */
  describeRepository(context: AgentContext): string;
  /** Asks the person; resolves with their answer. A cancelled turn aborts `signal`. */
  approve(request: AgentApprovalRequest, signal: AbortSignal): Promise<boolean>;
  /** Each tool call as it finishes (send() only; ask() reports through its events). */
  onToolCall?(conversationId: string, call: AgentToolCall): void;
  /** For room turns. */
  rooms?: {
    source: RoomSource;
    checkout: RoomCheckoutResolver;
    /** The cloud user signed in on this machine; null when signed out. */
    localUser(): Promise<string | null>;
  };
}

/** A room turn in flight. */
export interface TurnHandle {
  turnId: string;
  conversationId: string;
  /** Resolves when the turn ends, however it ends; never rejects. */
  done: Promise<RoomAgentReply>;
  /** Stops the turn: `interrupted` when someone spoke over Vowe, `cancelled` otherwise. */
  cancel(reason?: 'interrupted' | 'cancelled'): void;
}

const roomTurnSchema = z
  .object({
    roomId: z.string().trim().min(1).max(100),
    participant: z.object({ userId: z.string().trim().min(1).max(100), name: z.string().max(200).nullable() }).strict(),
    question: z.string().trim().min(1).max(8000),
    recentTurns: z.array(z.object({ speaker: z.string().max(200), text: z.string().max(4000), at: z.string().max(40).optional() }).strict()).max(20),
    canvas: canvasSnapshotSchema,
    conversationId: z.string().max(100).nullable().optional(),
    source: z.enum(['text', 'voice']),
  })
  .strict();

class TurnError extends Error {
  constructor(readonly code: AgentError['code'], message: string) {
    super(message);
  }
}

function toAgentError(err: unknown): AgentError {
  if (err instanceof TurnError) return { code: err.code, message: err.message, retryable: false };
  if (err instanceof ModelProviderError) {
    const { retryable = false, manageUrl, providerCode, requestId } = err.detail;
    return { code: err.code, message: err.message, retryable, manageUrl, providerCode, requestId };
  }
  return { code: 'other', message: err instanceof Error ? err.message : String(err), retryable: false };
}

const info = (p: ModelProvider): AgentProviderInfo => ({ id: p.id, name: p.name, billing: p.billing, model: p.model });

export class Collaborator {
  private conversations = new Map<string, Conversation>();
  private turns = new Map<string, TurnHandle>();
  private definitions = new Map<AgentTool[], ModelToolDefinition[]>();
  private readonly roomToolset: AgentTool[];

  constructor(private readonly options: CollaboratorOptions) {
    this.roomToolset = [...options.tools, ...(options.roomTools ?? []), ...(options.reasoningTools ?? [])];
  }

  status(): Omit<AgentStatus, 'chatgpt'> {
    const provider = this.options.provider();
    return { provider: provider.name, providerId: provider.id, billing: provider.billing, model: provider.model, configured: provider.isConfigured() };
  }

  /** The developer screen: one message about a repository in, one answer out. */
  async send(conversationId: string | null, context: AgentContext, text: string): Promise<AgentReply> {
    const conversation = this.conversation(conversationId, null, null);
    if (!conversation) throw new Error('That conversation has ended; start a new one.');
    if (conversation.busy) throw new Error('Still answering the previous message.');
    const provider = this.options.provider();
    const controller = new AbortController();
    const ledger = new EvidenceLedger();
    const toolCtx = this.toolContext(conversation, context, null, () => {}, controller.signal);
    const note = this.options.describeRepository(context);
    const result = await this.run(conversation, {
      provider,
      instructions: SYSTEM_PROMPT,
      text: `${note}\n\n${text}`,
      tools: this.options.tools,
      toolCtx,
      ledger,
      signal: controller.signal,
      onCall: (call) => this.options.onToolCall?.(conversation.id, call),
    });
    if (result.error) throw result.error instanceof Error ? result.error : new Error(String(result.error));
    return { conversationId: conversation.id, text: result.text, toolCalls: result.toolCalls, model: result.model, stop: result.stop as AgentReply['stop'] };
  }

  /**
   * A question in a room. Starts the turn and returns at once; `onEvent` hears everything it does,
   * ending with exactly one turn.completed, turn.cancelled or turn.failed.
   */
  ask(input: RoomAgentTurn, onEvent: (event: AgentEvent) => void): TurnHandle {
    const turnId = randomUUID();
    const controller = new AbortController();
    let cancelReason: 'interrupted' | 'cancelled' = 'cancelled';
    const parsed = roomTurnSchema.safeParse(input);
    const conversation = parsed.success
      ? this.conversation(parsed.data.conversationId ?? null, parsed.data.roomId, parsed.data.participant.userId)
      : null;
    const handle: TurnHandle = {
      turnId,
      conversationId: conversation?.id ?? '',
      cancel: (reason = 'cancelled') => {
        cancelReason = reason;
        controller.abort();
      },
      done: null!,
    };
    handle.done = this.roomTurn(turnId, parsed, conversation, controller.signal, () => cancelReason, onEvent).finally(() => this.turns.delete(turnId));
    this.turns.set(turnId, handle);
    return handle;
  }

  /** Cancels a running room turn; false if it isn't running. */
  cancel(turnId: string, reason: 'interrupted' | 'cancelled' = 'cancelled'): boolean {
    const turn = this.turns.get(turnId);
    turn?.cancel(reason);
    return Boolean(turn);
  }

  reset(conversationId: string) {
    this.conversations.delete(conversationId);
  }

  private async roomTurn(
    turnId: string,
    parsed: ReturnType<typeof roomTurnSchema.safeParse>,
    conversation: Conversation | null,
    signal: AbortSignal,
    cancelReason: () => 'interrupted' | 'cancelled',
    onEvent: (event: AgentEvent) => void,
  ): Promise<RoomAgentReply> {
    const emit = (event: AgentEvent) => {
      try {
        onEvent(event);
      } catch (err) {
        console.warn('[agent] event listener failed:', err);
      }
    };
    const provider = this.options.provider();
    const ledger = new EvidenceLedger();
    const commands: CanvasCommand[] = [];
    let report: { claims: Claim[]; gaps: string[] } | null = null;
    const base = (turn?: z.infer<typeof roomTurnSchema>): RoomAgentReply => ({
      turnId,
      conversationId: conversation?.id ?? '',
      roomId: turn?.roomId ?? '',
      text: '',
      stop: 'failed',
      grounding: ledger.check(null),
      roomGrounding: ledger.check(null),
      commands,
      toolCalls: [],
      focus: turn ? { how: focusOf(turn.canvas).how, componentIds: focusOf(turn.canvas).components.map((c) => c.id) } : { how: 'none', componentIds: [] },
      provider: info(provider),
      model: null,
    });
    const fail = (err: unknown, turn?: z.infer<typeof roomTurnSchema>): RoomAgentReply => {
      const error = toAgentError(err);
      const reply = { ...base(turn), error };
      emit({ type: 'turn.failed', turnId, error, reply });
      return reply;
    };

    if (!parsed.success) {
      return fail(new TurnError('invalid-turn', `The question couldn't be read: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'turn'}: ${i.message}`).join('; ')}`));
    }
    const turn = parsed.data;
    const rooms = this.options.rooms;
    if (!rooms) return fail(new TurnError('invalid-turn', 'Rooms are not available in this build.'), turn);
    if (!conversation) return fail(new TurnError('invalid-turn', 'That conversation has ended; start a new one.'), turn);
    if (conversation.roomId !== turn.roomId || conversation.askerId !== turn.participant.userId) {
      return fail(new TurnError('not-authorized', 'That conversation belongs to another room or person.'), turn);
    }
    if (conversation.busy) return fail(new TurnError('busy', 'Vowe is still answering the previous question.'), turn);

    conversation.busy = true;
    try {
      // Per-user authorization: this machine's model sign-in and local context answer only its own person.
      const local = await rooms.localUser().catch(() => null);
      if (!local) throw new TurnError('not-authorized', 'Sign in to Vowe to ask in a room.');
      if (local !== turn.participant.userId) {
        throw new TurnError('not-authorized', "Vowe answers each person on their own machine, with their own sign-in and context. This question came from someone else, so it wasn't sent.");
      }
      // Membership: the room source reads only rooms the signed-in person belongs to.
      const room = await rooms.source.room(turn.roomId).catch((err) => {
        throw new TurnError('not-authorized', `This room isn't available to you: ${err instanceof Error ? err.message : String(err)}`);
      });
      const checkout = await rooms.checkout(turn.roomId).catch(() => null);
      emit({ type: 'turn.started', turnId, conversationId: conversation.id, roomId: turn.roomId, provider: info(provider) });

      const proposed = new Set<string>();
      const toolCtx = this.toolContext(
        conversation,
        { repositoryId: checkout?.repositoryId ?? '', workstreamId: null },
        {
          id: turn.roomId,
          source: rooms.source,
          canvas: turn.canvas,
          emit: (type, payload, reason, evidence) => {
            const result = validateCanvasCommand(
              { v: 1, id: randomUUID(), roomId: turn.roomId, turnId, requestedBy: turn.participant.userId, reason, evidence: ledger.known(evidence), visibility: 'room', type, payload },
              turn.canvas,
              proposed,
            );
            const quoted = result.ok && ledger.quotesTranscript(JSON.stringify([result.command.reason, result.command.payload]));
            if (quoted) {
              const errors = [`quotes ${quoted.id}, a local Claude Code transcript; canvas requests are seen by the whole room, so describe it instead of quoting it`];
              emit({ type: 'canvas.rejected', turnId, tool: type, errors });
              return { ok: false, errors };
            }
            if (result.ok) {
              if (result.command.type === 'propose_component') proposed.add(result.command.payload.component.id);
              commands.push(result.command);
              emit({ type: 'canvas.command', turnId, command: result.command });
            } else {
              emit({ type: 'canvas.rejected', turnId, tool: type, errors: result.errors });
            }
            return result;
          },
        },
        (r) => (report = r),
        signal,
        (request) => emit({ type: 'approval.requested', turnId, request }),
      );
      const result = await this.run(conversation, {
        provider,
        instructions: turn.source === 'voice' ? `${ROOM_PROMPT}\n\n${VOICE_NOTE}` : ROOM_PROMPT,
        text: `${roomNote(turn, room.name, room.goal, checkout ? this.options.describeRepository({ repositoryId: checkout.repositoryId, workstreamId: null }) : null)}\n\n${turn.question}`,
        tools: this.roomToolset,
        toolCtx,
        ledger,
        signal,
        needsReport: () => !report && Boolean(this.options.reasoningTools?.length),
        onDelta: (step, delta) => emit({ type: 'text.delta', turnId, step, delta }),
        onStart: (call) => emit({ type: 'tool.started', turnId, call }),
        onCall: (call) => emit({ type: 'tool.finished', turnId, call, evidence: ledger.all().filter((s) => s.toolCallId === call.id).map((s) => s.id) }),
      });

      const grounding: Grounding = ledger.check(report);
      const reply: RoomAgentReply = { ...base(turn), text: result.text, stop: result.stop, grounding, roomGrounding: groundingForRoom(grounding), toolCalls: result.toolCalls, model: result.model };
      if (result.stop === 'cancelled') {
        emit({ type: 'turn.cancelled', turnId, reason: cancelReason(), reply });
        return reply;
      }
      if (result.error) {
        const error = toAgentError(result.error);
        const failed = { ...reply, stop: 'failed' as const, error };
        emit({ type: 'turn.failed', turnId, error, reply: failed });
        return failed;
      }
      emit({ type: 'text.final', turnId, text: result.text });
      emit({ type: 'turn.completed', turnId, reply });
      return reply;
    } catch (err) {
      return fail(err, turn);
    } finally {
      conversation.busy = false;
    }
  }

  /** The conversation with `id`, or a new one when `id` is null; null when `id` names one that has ended. */
  private conversation(id: string | null, roomId: string | null, askerId: string | null): Conversation | null {
    const existing = id && this.conversations.get(id);
    if (existing) {
      this.conversations.delete(existing.id); // re-insert: Map order doubles as least-recently-used
      this.conversations.set(existing.id, existing);
      return existing;
    }
    if (id) return null;
    const conversation: Conversation = { id: randomUUID(), items: [], grants: new Map(), busy: false, roomId, askerId };
    this.conversations.set(conversation.id, conversation);
    while (this.conversations.size > MAX_CONVERSATIONS) this.conversations.delete(this.conversations.keys().next().value!);
    return conversation;
  }

  private defs(tools: AgentTool[]): ModelToolDefinition[] {
    let known = this.definitions.get(tools);
    if (!known) {
      known = tools.map((t) => {
        const { $schema: _, ...inputSchema } = z.toJSONSchema(t.input, { io: 'input' });
        return { name: t.name, description: t.description, inputSchema };
      });
      this.definitions.set(tools, known);
    }
    return known;
  }

  /**
   * The loop: model, tools, model, … until it answers. On failure or cancellation the turn's items are
   * dropped, so the next question starts from a complete history.
   */
  private async run(
    conversation: Conversation,
    turn: {
      provider: ModelProvider;
      instructions: string;
      text: string;
      tools: AgentTool[];
      toolCtx: ToolContext;
      ledger: EvidenceLedger;
      signal: AbortSignal;
      needsReport?(): boolean;
      onDelta?(step: number, delta: string): void;
      onStart?(call: { id: string; name: string; input: unknown }): void;
      onCall?(call: AgentToolCall): void;
    },
  ): Promise<{ text: string; toolCalls: AgentToolCall[]; model: string | null; stop: RoomAgentReply['stop']; error?: unknown }> {
    const { provider, signal } = turn;
    const start = conversation.items.length;
    for (const [key, approved] of conversation.grants) if (!approved) conversation.grants.delete(key);
    conversation.items.push({ type: 'user', text: turn.text });
    const definitions = this.defs(turn.tools);
    const toolCalls: AgentToolCall[] = [];
    let answer: string | null = null; // set once the model answered, when it's only asked for its report
    let nudged = false;
    let model: string | null = null;
    const finish = (text: string, stop: RoomAgentReply['stop']) => ({ text: answer ?? text, toolCalls, model, stop });

    try {
      for (let step = 1; ; step++) {
        if (signal.aborted) throw new ModelProviderError('cancelled', 'Cancelled.');
        const last = step === MAX_STEPS;
        const response: ModelResponse = await provider.complete({
          instructions: turn.instructions,
          items: conversation.items,
          tools: definitions,
          allowTools: !last,
          signal,
          onTextDelta: answer === null && turn.onDelta ? (delta) => turn.onDelta!(step, delta) : undefined,
        });
        model = response.model;
        conversation.items.push(...response.items);
        const text = answerText(response.items);

        if (response.stopReason === 'refusal') return finish(text || 'The model declined to answer this.', 'refused');
        if (response.stopReason === 'max_tokens') return finish(text, 'truncated');
        const calls = response.items.filter((i): i is Extract<ModelItem, { type: 'tool_call' }> => i.type === 'tool_call');
        if (!calls.length) {
          // Answered without its reasoning report: ask for it once, keeping this answer as the answer.
          if (!last && !nudged && turn.needsReport?.()) {
            nudged = true;
            answer = text;
            conversation.items.push({ type: 'user', text: '[Vowe runtime] Call report_reasoning for the answer you just gave. Do not repeat or change the answer.' });
            continue;
          }
          return finish(text, last ? 'step-limit' : 'answered');
        }
        if (last) {
          // Every tool call needs a result before the next question, even ones that won't run.
          conversation.items.push(...calls.map((c) => ({ type: 'tool_result' as const, callId: c.id, content: 'Not run: step limit reached.', isError: true })));
          return finish(text, 'step-limit');
        }

        // Every result, in order (parallel calls stay paired with their results).
        for (const call of calls) {
          if (signal.aborted) throw new ModelProviderError('cancelled', 'Cancelled.');
          turn.onStart?.({ id: call.id, name: call.name, input: call.input });
          const { record, content } = await this.runTool(call, turn.tools, turn.toolCtx, turn.ledger);
          toolCalls.push(record);
          turn.onCall?.(record);
          conversation.items.push({ type: 'tool_result', callId: call.id, content, isError: record.error ? true : undefined });
        }
        if (step + 1 === MAX_STEPS) conversation.items.push({ type: 'user', text: 'Step limit reached: answer now with what you have, and say what you could not check.' });
      }
    } catch (err) {
      conversation.items.length = start;
      if (isAbort(err) || signal.aborted) return { text: '', toolCalls, model, stop: 'cancelled' };
      return { text: '', toolCalls, model, stop: 'failed', error: err };
    }
  }

  private async runTool(
    use: { id: string; name: string; input: unknown },
    tools: AgentTool[],
    ctx: ToolContext,
    ledger: EvidenceLedger,
  ): Promise<{ record: AgentToolCall; content: string }> {
    const { id, name, input } = use;
    const tool = tools.find((t) => t.name === name);
    const fail = (error: string) => ({ record: { id, name, input, error }, content: error });
    if (!tool) return fail(`Unknown tool: ${name}`);
    const parsed = tool.input.safeParse(input);
    if (!parsed.success) return fail(`Invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`);
    try {
      // Sources a tool cites are bound to its call, so each tool.finished event lists its own evidence.
      const json = JSON.stringify(await tool.run(parsed.data, { ...ctx, cite: (source) => ledger.add({ ...source, toolCallId: id }) }));
      const content = json.length > MAX_TOOL_RESULT ? `${json.slice(0, MAX_TOOL_RESULT)}… [result clipped; ask for less]` : json;
      return { record: { id, name, input, error: null }, content };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  private toolContext(
    conversation: Conversation,
    context: AgentContext,
    room: ToolContext['room'],
    report: ToolContext['report'],
    signal: AbortSignal,
    onApproval?: (request: AgentApprovalRequest) => void,
  ): ToolContext {
    return {
      work: this.options.work,
      repositoryId: context.repositoryId || null,
      workstreamId: context.workstreamId,
      providerName: this.options.provider().name,
      room,
      report,
      cite: () => {
        throw new Error('Sources are cited from inside a tool call.'); // runTool binds cite per call
      },
      authorize: async (key, request) => {
        const known = conversation.grants.get(key);
        if (known !== undefined) return known;
        if (signal.aborted) return false;
        const approval = { id: randomUUID(), conversationId: conversation.id, ...request };
        onApproval?.(approval);
        const approved = await this.options.approve(approval, signal);
        conversation.grants.set(key, approved);
        return approved;
      },
    };
  }
}

/** What the model is told about the room turn, before the question. */
function roomNote(turn: z.infer<typeof roomTurnSchema>, roomName: string, goal: string | null, repository: string | null): string {
  const focus = focusOf(turn.canvas);
  const describe = (c: CanvasSnapshot['components'][number]) => `${c.name} (id ${c.id}, ${c.kind}${c.tech ? `, "${c.tech}"` : ''}${c.paths?.length ? `, paths ${c.paths.join(', ')}` : ''})`;
  const lines = [
    `[Vowe context] Room: ${roomName}.${goal ? ` Goal: ${goal}.` : ''} Asked by ${turn.participant.name ?? 'a member'}, ${turn.source === 'voice' ? 'by voice' : 'in text'}. Time: ${new Date().toISOString()}.`,
    focus.components.length
      ? `They ${focus.how} ${focus.components.map(describe).join('; ')} on the ${turn.canvas.view} view.`
      : `Nothing is selected; the canvas shows the ${turn.canvas.view} view.`,
    ...(focus.missing.length ? [`Their selection also named ${focus.missing.join(', ')}, which the canvas no longer shows.`] : []),
    repository ? repository : "The room's repository isn't checked out on this machine: there is no local code, Git or Claude Code context for this turn.",
  ];
  if (turn.recentTurns.length) lines.push(`Said just before:\n${turn.recentTurns.map((t) => `- ${t.speaker}: ${t.text}`).join('\n')}`);
  return lines.join('\n');
}

function answerText(items: ModelItem[]): string {
  return items
    .flatMap((i) => (i.type === 'assistant' ? [i.text] : []))
    .join('\n\n')
    .trim();
}
