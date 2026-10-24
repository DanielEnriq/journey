/**
 * The language model behind Vowe, independent of who provides it. A provider runs in main and keeps
 * its credentials there; the renderer never sees a key or token.
 *
 * The transcript is provider-neutral: plain user and assistant text, tool calls and their results.
 * Whatever a provider needs replayed on the next request (Anthropic thinking blocks, OpenAI encrypted
 * reasoning) rides along as `opaque` items tagged with the provider's id; other providers skip them.
 */

export type ModelItem =
  | { type: 'user'; text: string }
  | { type: 'assistant'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; callId: string; content: string; isError?: boolean }
  /** Provider state to send back verbatim, e.g. a reasoning item. Only the provider with this id reads it. */
  | { type: 'opaque'; provider: string; data: unknown };

export interface ModelToolDefinition {
  name: string;
  /** What the model reads to decide when and how to use it. */
  description: string;
  /** JSON Schema of the tool's input. */
  inputSchema: Record<string, unknown>;
}

export interface ModelRequest {
  /** Developer instructions. */
  instructions: string;
  items: ModelItem[];
  tools: ModelToolDefinition[];
  /** False on the last step of a turn, so the model has to answer with what it has. */
  allowTools: boolean;
  /** Aborts the request: a person interrupted, or the turn was cancelled. */
  signal?: AbortSignal;
  /** Answer text as it streams, for captions and speech. */
  onTextDelta?(delta: string): void;
}

export interface ModelResponse {
  /** Appended to the transcript as is: text, tool calls, and any opaque state. */
  items: ModelItem[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';
  /** The model that actually answered, which can differ from the configured one after a fallback. */
  model: string;
}

/**
 * Who pays for a request. `chatgpt-plan`: the signed-in person's ChatGPT plan; `api-key`: a key in
 * this machine's .env. Shown to the person, so they always know which one is in use.
 */
export type ModelBilling = 'chatgpt-plan' | 'api-key';

export interface ModelProvider {
  /** Stable id, e.g. "chatgpt", "openai", "anthropic"; tags opaque items. */
  readonly id: string;
  /** For the UI and approval prompts, e.g. "ChatGPT". */
  readonly name: string;
  readonly billing: ModelBilling;
  /** The configured model, when known before a request. */
  readonly model: string;
  /** Whether it can be used now: credentials present (and, for a plan, the plan grant). Says nothing about whether they work. */
  isConfigured(): boolean;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export type ModelProviderErrorCode =
  | 'not-signed-in'
  | 'not-eligible'
  | 'usage-limit'
  | 'unavailable'
  | 'unsupported'
  | 'auth'
  | 'rate-limit'
  | 'cancelled'
  | 'incomplete'
  | 'other';

/**
 * A provider failure the runtime and UI can act on. `retryable` failures are worth trying again later
 * with the same provider. None of them switch billing: a plan error never quietly falls back to an API key.
 */
export class ModelProviderError extends Error {
  constructor(
    readonly code: ModelProviderErrorCode,
    message: string,
    readonly detail: { retryable?: boolean; providerCode?: string; requestId?: string; status?: number; manageUrl?: string } = {},
  ) {
    super(message);
    this.name = 'ModelProviderError';
  }
}

export const isAbort = (err: unknown) =>
  err instanceof Error && (err.name === 'AbortError' || (err instanceof ModelProviderError && err.code === 'cancelled'));
