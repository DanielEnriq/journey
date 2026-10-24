import Anthropic from '@anthropic-ai/sdk';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ModelProviderError, type ModelItem, type ModelProvider, type ModelResponse } from '../../assistant/provider.js';
import { config } from '../../config.js';

const MAX_TOKENS = 16_000;
const STOP_REASONS = new Set<ModelResponse['stopReason']>(['end_turn', 'tool_use', 'max_tokens', 'refusal']);

let client: Anthropic | null = null;

/** A profile saved by `ant auth login`. An empty profile directory doesn't count. */
function hasProfile(): boolean {
  try {
    return readdirSync(join(homedir(), '.config', 'anthropic')).length > 0;
  } catch {
    return false;
  }
}

/** Neutral items as Messages API turns: consecutive assistant items share one message, tool results ride in a user message. */
function toMessages(items: ModelItem[]): Anthropic.Beta.BetaMessageParam[] {
  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  const push = (role: 'user' | 'assistant', block: Anthropic.Beta.BetaContentBlockParam) => {
    const last = messages.at(-1);
    if (last?.role === role && Array.isArray(last.content)) last.content.push(block);
    else messages.push({ role, content: [block] });
  };
  for (const item of items) {
    if (item.type === 'user') push('user', { type: 'text', text: item.text });
    else if (item.type === 'assistant') push('assistant', { type: 'text', text: item.text });
    else if (item.type === 'tool_call') push('assistant', { type: 'tool_use', id: item.id, name: item.name, input: item.input });
    else if (item.type === 'tool_result') push('user', { type: 'tool_result', tool_use_id: item.callId, content: item.content, is_error: item.isError });
    else if (item.provider === 'anthropic') push('assistant', item.data as Anthropic.Beta.BetaContentBlockParam);
  }
  return messages;
}

function toItems(content: Anthropic.Beta.BetaContentBlock[]): ModelItem[] {
  return content.map((block): ModelItem => {
    if (block.type === 'text') return { type: 'assistant', text: block.text };
    if (block.type === 'tool_use') return { type: 'tool_call', id: block.id, name: block.name, input: block.input };
    return { type: 'opaque', provider: 'anthropic', data: block }; // thinking blocks, replayed as is
  });
}

/**
 * Claude through the Messages API, billed to ANTHROPIC_API_KEY (or an `ant auth login` profile).
 * An API-key fallback: Vowe prefers the person's ChatGPT plan (integrations/openai/chatgpt.ts).
 */
export const anthropic: ModelProvider = {
  id: 'anthropic',
  name: 'Anthropic',
  billing: 'api-key',
  get model() {
    return config.agent.anthropicModel;
  },

  isConfigured() {
    return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || hasProfile());
  },

  async complete({ instructions, items, tools, allowTools, signal, onTextDelta }) {
    client ??= new Anthropic();
    try {
      const stream = client.beta.messages.stream(
        {
          model: config.agent.anthropicModel,
          max_tokens: MAX_TOKENS,
          system: instructions,
          messages: toMessages(items),
          tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema })),
          tool_choice: { type: allowTools ? 'auto' : 'none' },
          output_config: { effort: config.agent.effort },
          // The instructions and tools never change, and history only grows: cache the whole prefix.
          cache_control: { type: 'ephemeral' },
          // A request the model's safeguards decline is retried on Anthropic's recommended fallback model.
          ...(config.agent.fallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
        },
        { signal },
      );
      if (onTextDelta) stream.on('text', (delta) => onTextDelta(delta));
      const response = await stream.finalMessage();
      const stop = response.stop_reason as ModelResponse['stopReason'];
      return { items: toItems(response.content), stopReason: STOP_REASONS.has(stop) ? stop : 'other', model: response.model };
    } catch (err) {
      if (err instanceof Anthropic.APIUserAbortError || signal?.aborted) throw new ModelProviderError('cancelled', 'Cancelled.');
      if (err instanceof Anthropic.AuthenticationError) {
        throw new ModelProviderError('auth', 'Anthropic rejected the credentials. Set ANTHROPIC_API_KEY in .env (or run `ant auth login`) and restart.');
      }
      if (err instanceof Anthropic.RateLimitError) throw new ModelProviderError('rate-limit', 'Anthropic rate limit reached; try again shortly.', { retryable: true });
      if (err instanceof Anthropic.APIError) throw new ModelProviderError('other', `Anthropic API error${err.status ? ` ${err.status}` : ''}: ${err.message}`, { status: err.status });
      throw err;
    }
  },
};
