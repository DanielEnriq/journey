import Anthropic from '@anthropic-ai/sdk';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ModelProvider, ModelResponse } from '../../assistant/provider.js';
import { config } from '../../config.js';

const MAX_TOKENS = 16_000;
const STOP_REASONS = new Set<ModelResponse['stopReason']>(['end_turn', 'tool_use', 'pause_turn', 'max_tokens', 'refusal']);

let client: Anthropic | null = null;

/**
 * Claude through the Messages API. Credentials come from ANTHROPIC_API_KEY in .env, or from a
 * profile saved by `ant auth login`; the SDK resolves them on the first request.
 */
export const anthropic: ModelProvider = {
  name: 'Anthropic',
  get model() {
    return config.agent.model;
  },

  isConfigured() {
    return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || existsSync(join(homedir(), '.config', 'anthropic')));
  },

  async complete({ system, messages, tools, allowTools }) {
    client ??= new Anthropic();
    try {
      const response = await client.beta.messages.create({
        model: config.agent.model,
        max_tokens: MAX_TOKENS,
        system,
        messages,
        tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema })),
        tool_choice: { type: allowTools ? 'auto' : 'none' },
        output_config: { effort: config.agent.effort },
        // The system prompt and tools never change, and history only grows: cache the whole prefix.
        cache_control: { type: 'ephemeral' },
        // A request the model's safeguards decline is retried on Anthropic's recommended fallback model.
        ...(config.agent.fallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      });
      const stop = response.stop_reason as ModelResponse['stopReason'];
      return { content: response.content, stopReason: STOP_REASONS.has(stop) ? stop : 'other', model: response.model };
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) {
        throw new Error('Anthropic rejected the credentials. Set ANTHROPIC_API_KEY in .env (or run `ant auth login`) and restart.');
      }
      if (err instanceof Anthropic.RateLimitError) throw new Error('Anthropic rate limit reached; try again shortly.');
      if (err instanceof Anthropic.APIError) throw new Error(`Anthropic API error${err.status ? ` ${err.status}` : ''}: ${err.message}`);
      throw err;
    }
  },
};
