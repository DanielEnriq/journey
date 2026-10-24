/**
 * Vowe's collaborator: one tool-calling loop over a model provider, a tool registry, and the work
 * context. It explains and questions the work; it never changes code or steers coding agents.
 *
 * Transport-agnostic: the text UI reaches it over IPC (main/ipc.ts), and a voice bridge or a shared
 * room can call send() the same way. Approval prompts go through `approve`, so each surface asks the
 * user its own way.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { WorkContextService } from '../context/index.js';
import { getRepository } from '../database/repositories.js';
import { getWorkstream } from '../database/work-context.js';
import type { AgentApprovalRequest, AgentContext, AgentReply, AgentStatus, AgentToolCall } from '../shared/api.js';
import type { ModelMessage, ModelProvider, ModelResponse, ModelToolDefinition } from './provider.js';
import type { AgentTool, ToolContext } from './tools.js';

/** Model calls per user message: enough to list, read, and check Git, without running away. */
const MAX_STEPS = 8;
/** A safety net on top of each tool's own limits. */
const MAX_TOOL_RESULT = 40_000;
const MAX_CONVERSATIONS = 20;

const SYSTEM_PROMPT = `You are Vowe, an engineering collaborator. People use you to understand and reason about software work that independent coding agents (currently Claude Code) are doing in their repositories. You help them see what is happening, think it through, and decide. You don't write or run code, and you can't start, steer, or stop coding agents.

Your tools are read-only views of this machine: Claude Code sessions (metadata, and messages from sessions the user lets you read), hook activity, and real Git state. Check them before answering questions about the work, and check again when the state may have changed since an earlier turn.

Reading the evidence:
- Session state comes from Claude Code hooks. "working" means a hook fired in the last few minutes; "turn-completed" means Claude Code finished responding and is waiting on its user; "ended" means the session closed; "unknown" means there is no recent hook evidence (hooks may not be installed). Only say a session is running when its state is "working", and say when it was last observed.
- A session is linked to a workstream only by the directory it ran in. A branchMatch of "unknown" or "different" means that link is uncertain; say so rather than smoothing it over.
- A transcript records what Claude Code said and did, not what is true now. Check claims about changes against Git. Report tests as run or passing only when a transcript shows the command and its output.
- If the user declines to share a session, work from its metadata and say what you couldn't check.

Answering:
- Lead with the answer. Keep it short: a few sentences or a tight list. Don't narrate your process.
- Keep observations and interpretation apart. Mark inferences as inferred, and say what evidence would settle them.
- Cite the evidence behind important claims inline: sessions as \`session 1a2b3c4d #42\` (the message index), files as \`path/to/file.ts\`, Git facts by source (\`git status\`, \`git diff\`, a short commit hash).
- When the evidence is insufficient, say so plainly. When a question is ambiguous (which session, which branch) and the tools can't settle it, ask one specific question.
- Raise concerns and open questions when they matter: uncommitted or unpushed work, sessions that ended mid-task, overlapping changes across worktrees, questions in a transcript that were never answered.`;

interface Conversation {
  id: string;
  messages: ModelMessage[];
  /** Approved (true) or declined (false) sharing keys. Declines last only for the turn. */
  grants: Map<string, boolean>;
  busy: boolean;
}

export interface CollaboratorOptions {
  provider: ModelProvider;
  work: WorkContextService;
  tools: AgentTool[];
  /** Asks the user; resolves with their answer. */
  approve(request: AgentApprovalRequest): Promise<boolean>;
  /** Each tool call as it finishes. */
  onToolCall?(conversationId: string, call: AgentToolCall): void;
}

export class Collaborator {
  private conversations = new Map<string, Conversation>();
  private readonly definitions: ModelToolDefinition[];

  constructor(private readonly options: CollaboratorOptions) {
    this.definitions = options.tools.map((t) => {
      const { $schema: _, ...inputSchema } = z.toJSONSchema(t.input, { io: 'input' });
      return { name: t.name, description: t.description, inputSchema };
    });
  }

  status(): AgentStatus {
    const { provider } = this.options;
    return { provider: provider.name, model: provider.model, configured: provider.isConfigured() };
  }

  /** One user message in, one answer out, with as many tool calls as it takes in between. */
  async send(conversationId: string | null, context: AgentContext, text: string): Promise<AgentReply> {
    const conversation = this.conversation(conversationId);
    if (conversation.busy) throw new Error('Still answering the previous message.');
    conversation.busy = true;
    const start = conversation.messages.length;
    try {
      return await this.turn(conversation, context, text);
    } catch (err) {
      // Drop the unanswered turn so the next message starts from a complete history.
      conversation.messages.length = start;
      throw err;
    } finally {
      conversation.busy = false;
    }
  }

  reset(conversationId: string) {
    this.conversations.delete(conversationId);
  }

  private conversation(id: string | null): Conversation {
    const existing = id && this.conversations.get(id);
    if (existing) {
      this.conversations.delete(existing.id); // re-insert: Map order doubles as least-recently-used
      this.conversations.set(existing.id, existing);
      return existing;
    }
    if (id) throw new Error('That conversation has ended; start a new one.');
    const conversation: Conversation = { id: randomUUID(), messages: [], grants: new Map(), busy: false };
    this.conversations.set(conversation.id, conversation);
    while (this.conversations.size > MAX_CONVERSATIONS) this.conversations.delete(this.conversations.keys().next().value!);
    return conversation;
  }

  private async turn(conversation: Conversation, context: AgentContext, text: string): Promise<AgentReply> {
    const { provider } = this.options;
    for (const [key, approved] of conversation.grants) if (!approved) conversation.grants.delete(key);
    const tools = this.toolContext(conversation, context);
    conversation.messages.push({ role: 'user', content: `${contextNote(context)}\n\n${text}` });

    const toolCalls: AgentToolCall[] = [];
    for (let step = 1; ; step++) {
      const last = step === MAX_STEPS;
      const response = await provider.complete({ system: SYSTEM_PROMPT, messages: conversation.messages, tools: this.definitions, allowTools: !last });
      conversation.messages.push({ role: 'assistant', content: response.content });
      const reply = (stop: AgentReply['stop']): AgentReply => ({ conversationId: conversation.id, text: answerText(response), toolCalls, model: response.model, stop });

      if (response.stopReason === 'pause_turn') continue;
      if (response.stopReason === 'refusal') return { ...reply('refused'), text: reply('refused').text || 'The model declined to answer this.' };
      if (response.stopReason === 'max_tokens') return reply('truncated');
      const uses = response.content.filter((b) => b.type === 'tool_use');
      if (response.stopReason !== 'tool_use' || !uses.length) return reply(last ? 'step-limit' : 'answered');
      if (last) {
        // Every tool_use needs a result before the next user message, even ones that won't run.
        conversation.messages.push({
          role: 'user',
          content: uses.map((u) => ({ type: 'tool_result' as const, tool_use_id: u.id, content: 'Not run: step limit reached.', is_error: true })),
        });
        return reply('step-limit');
      }

      // One user message with every result, in order (parallel calls stay paired with their results).
      const results = [];
      for (const use of uses) {
        const { call, content } = await this.runTool(use.id, use.name, use.input, tools);
        toolCalls.push(call);
        this.options.onToolCall?.(conversation.id, call);
        results.push({ type: 'tool_result' as const, tool_use_id: use.id, content, is_error: call.error ? true : undefined });
      }
      const content: Extract<ModelMessage['content'], unknown[]> = results;
      if (step + 1 === MAX_STEPS) content.push({ type: 'text', text: 'Step limit reached: answer now with what you have, and say what you could not check.' });
      conversation.messages.push({ role: 'user', content });
    }
  }

  private async runTool(id: string, name: string, input: unknown, ctx: ToolContext): Promise<{ call: AgentToolCall; content: string }> {
    const tool = this.options.tools.find((t) => t.name === name);
    const fail = (error: string) => ({ call: { id, name, input, error }, content: error });
    if (!tool) return fail(`Unknown tool: ${name}`);
    const parsed = tool.input.safeParse(input);
    if (!parsed.success) return fail(`Invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`);
    try {
      const json = JSON.stringify(await tool.run(parsed.data, ctx));
      const content = json.length > MAX_TOOL_RESULT ? `${json.slice(0, MAX_TOOL_RESULT)}… [result clipped; ask for less]` : json;
      return { call: { id, name, input, error: null }, content };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  private toolContext(conversation: Conversation, context: AgentContext): ToolContext {
    return {
      work: this.options.work,
      repositoryId: context.repositoryId,
      workstreamId: context.workstreamId,
      providerName: this.options.provider.name,
      authorize: async (key, request) => {
        const known = conversation.grants.get(key);
        if (known !== undefined) return known;
        const approved = await this.options.approve({ id: randomUUID(), conversationId: conversation.id, ...request });
        conversation.grants.set(key, approved);
        return approved;
      },
    };
  }
}

/** Checks the context names a real repository (and one of its workstreams), and describes it for the model. */
function contextNote({ repositoryId, workstreamId }: AgentContext): string {
  const repo = getRepository(repositoryId);
  if (!repo) throw new Error('No such repository');
  const workstream = workstreamId ? getWorkstream(workstreamId) : null;
  if (workstreamId && workstream?.repositoryId !== repositoryId) throw new Error('No such workstream in this repository');
  const focus = workstream
    ? `Selected workstream: ${workstream.branch || '(detached HEAD)'} in ${workstream.worktreePath} (id ${workstream.id}).`
    : 'No workstream selected: the whole repository.';
  return `[Vowe context] Repository: ${repo.name} at ${repo.path}. ${focus} Time: ${new Date().toISOString()}.`;
}

function answerText(response: ModelResponse): string {
  return response.content
    .flatMap((b) => (b.type === 'text' ? [b.text] : []))
    .join('\n\n')
    .trim();
}
