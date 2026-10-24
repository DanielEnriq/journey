/**
 * The language model behind Vowe's collaborator, independent of who provides it. Like the voice
 * agent providers (integrations/voice), a provider runs in main and keeps its credentials there.
 *
 * Messages use the Anthropic Messages API shape because the first provider is Claude; another
 * provider translates to and from it inside complete(), and the runtime never notices.
 */

import type Anthropic from '@anthropic-ai/sdk';

export type ModelMessage = Anthropic.Beta.BetaMessageParam;
export type ModelContentBlock = Anthropic.Beta.BetaContentBlock;

export interface ModelToolDefinition {
  name: string;
  description: string;
  /** JSON Schema of the tool's input. */
  inputSchema: Record<string, unknown>;
}

export interface ModelRequest {
  system: string;
  messages: ModelMessage[];
  tools: ModelToolDefinition[];
  /** False on the last step of a turn, so the model has to answer with what it has. */
  allowTools: boolean;
}

export interface ModelResponse {
  /** Appended to the conversation as is, so nothing the provider needs back is lost. */
  content: ModelContentBlock[];
  stopReason: 'end_turn' | 'tool_use' | 'pause_turn' | 'max_tokens' | 'refusal' | 'other';
  /** The model that actually answered, which can differ from the configured one after a fallback. */
  model: string;
}

export interface ModelProvider {
  /** For logs and the UI, e.g. "Anthropic". */
  readonly name: string;
  readonly model: string;
  /** Whether credentials appear to be set; says nothing about whether they work. */
  isConfigured(): boolean;
  complete(request: ModelRequest): Promise<ModelResponse>;
}
