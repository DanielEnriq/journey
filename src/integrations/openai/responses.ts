/**
 * OpenAI's Responses API as a ModelProvider, for two billing paths that share one wire format:
 *   - the person's ChatGPT plan, with a Sign in with ChatGPT access token (chatgpt.ts): Vowe's default;
 *   - an OpenAI API key from .env: a fallback, used only when chosen or when no plan is signed in.
 *
 * Plan requests follow OpenAI's preview limits: the public POST /v1/responses endpoint (never ChatGPT's
 * backend-api), `store: false` and `stream: true` on every request, function tools only, the context
 * resent in `input` each step (no previous_response_id), and none of the omitted fields (temperature,
 * max_output_tokens, metadata, user, …). Encrypted reasoning comes back with each response and is
 * replayed in later input, which store: false requires for reasoning models to keep their thread.
 *
 * Errors keep their exact OpenAI code and request id. A plan error stops the turn: nothing here falls
 * back to another billing path.
 */

import { ModelProviderError, type ModelBilling, type ModelItem, type ModelProvider, type ModelRequest, type ModelResponse } from '../../assistant/provider.js';
import { RESOURCE, USAGE_URL } from './chatgpt.js';

const RESPONSES_URL = `${RESOURCE}/responses`;
const MODELS_URL = `${RESOURCE}/models`;
/** Bounded backoff for temporary (503) admission failures, before any output streamed. */
const RETRY_DELAYS_MS = [500, 2000];

export interface ResponsesProviderOptions {
  id: string;
  name: string;
  billing: ModelBilling;
  /** A fixed model, or '' to pick the first model the account lists (plan accounts differ). */
  model: string;
  isConfigured(): boolean;
  /** A bearer credential for one request: a plan access token or an API key. */
  bearer(): Promise<string>;
  fetch?: typeof fetch;
}

type ResponsesInput = Record<string, unknown>;

/** Neutral items as Responses input items. Opaque items from other providers are skipped. */
export function toInput(items: ModelItem[], providerId: string): ResponsesInput[] {
  return items.flatMap((item): ResponsesInput[] => {
    switch (item.type) {
      case 'user':
        return [{ role: 'user', content: item.text }];
      case 'assistant':
        return [{ role: 'assistant', content: item.text }];
      case 'tool_call':
        return [{ type: 'function_call', call_id: item.id, name: item.name, arguments: JSON.stringify(item.input ?? {}) }];
      case 'tool_result':
        return [{ type: 'function_call_output', call_id: item.callId, output: item.content }];
      case 'opaque':
        return item.provider === providerId ? [item.data as ResponsesInput] : [];
    }
  });
}

interface OutputItem {
  type: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: { type: string; text?: string; refusal?: string }[];
  [key: string]: unknown;
}

/** A completed response's output as neutral items, plus whether the model refused. */
export function fromOutput(output: OutputItem[], providerId: string): { items: ModelItem[]; refused: boolean } {
  const items: ModelItem[] = [];
  let refused = false;
  for (const out of output) {
    if (out.type === 'message') {
      const text = (out.content ?? []).flatMap((c) => (c.type === 'output_text' && c.text ? [c.text] : [])).join('');
      if ((out.content ?? []).some((c) => c.type === 'refusal')) refused = true;
      if (text) items.push({ type: 'assistant', text });
    } else if (out.type === 'function_call') {
      let input: unknown = {};
      try {
        input = JSON.parse(out.arguments || '{}');
      } catch {
        input = { __unparsed: out.arguments }; // the tool's own validation reports it to the model
      }
      items.push({ type: 'tool_call', id: String(out.call_id), name: String(out.name), input });
    } else if (out.type === 'reasoning') {
      items.push({ type: 'opaque', provider: providerId, data: out });
    }
  }
  return { items, refused };
}

/** Server-sent events from a fetch body, one parsed `data:` JSON object at a time. */
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, '');
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (data && data !== '[DONE]') yield JSON.parse(data);
    }
  }
}

/** OpenAI's documented plan-usage error codes, mapped to what Vowe can do about each. */
export function planError(code: string | undefined, message: string, status: number, requestId?: string, param?: string): ModelProviderError {
  const d = { providerCode: code, status, requestId };
  switch (code) {
    case 'subscription_sharing_usage_limit_exceeded':
      return new ModelProviderError('usage-limit', 'Usage limit reached. Review your plan or this app’s limit in ChatGPT settings.', { ...d, manageUrl: USAGE_URL });
    case 'subscription_sharing_user_not_eligible':
      return new ModelProviderError('not-eligible', 'This ChatGPT account can’t use its plan in Vowe.', d);
    case 'subscription_sharing_unsupported_capability':
      return new ModelProviderError('unsupported', `ChatGPT plan usage doesn’t support part of this request${param ? ` (${param})` : ''}.`, d);
    case 'subscription_sharing_usage_unavailable':
    case 'subscription_sharing_user_unavailable':
      return new ModelProviderError('unavailable', 'ChatGPT plan usage is temporarily unavailable. Try again shortly.', { ...d, retryable: true });
    case 'subscription_sharing_invalid_user':
      return new ModelProviderError('auth', 'OpenAI didn’t accept this ChatGPT sign-in for plan usage.', d);
    case 'subscription_sharing_route_not_supported':
    case 'chatpass_v2_scope_not_authorized':
    case 'chatpass_v2_invalid_authorization_context':
      return new ModelProviderError('auth', `OpenAI refused the plan request (${code}).`, d);
  }
  if (status === 401) return new ModelProviderError('auth', `OpenAI didn’t accept the credentials: ${message}`, d);
  if (status === 403) return new ModelProviderError('not-eligible', `OpenAI refused the request: ${message}`, d);
  if (status === 429) return new ModelProviderError('rate-limit', 'OpenAI rate limit reached; try again shortly.', { ...d, retryable: true });
  if (status === 503 || status >= 500) return new ModelProviderError('unavailable', `OpenAI is unavailable (HTTP ${status}).`, { ...d, retryable: true });
  return new ModelProviderError('other', `OpenAI error${code ? ` ${code}` : ''}: ${message}`, d);
}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(timer), reject(new ModelProviderError('cancelled', 'Cancelled.'))), { once: true });
  });

export function createResponsesProvider(options: ResponsesProviderOptions): ModelProvider & { listModels(): Promise<{ slug: string; name: string }[]> } {
  const http = options.fetch ?? fetch;
  let listed: string | null = null;

  async function listModels() {
    const res = await http(MODELS_URL, { headers: { Authorization: `Bearer ${await options.bearer()}` } });
    if (!res.ok) throw planError(undefined, `listing models failed`, res.status, res.headers.get('x-request-id') ?? undefined);
    const json = (await res.json()) as { models?: { slug: string; display_name?: string; visibility?: string }[]; data?: { id: string }[] };
    // Plan accounts answer with `models` (keep visibility "list"); API keys with the standard `data`.
    if (json.models) return json.models.filter((m) => m.visibility === 'list').map((m) => ({ slug: m.slug, name: m.display_name ?? m.slug }));
    return (json.data ?? []).map((m) => ({ slug: m.id, name: m.id }));
  }

  async function model(): Promise<string> {
    if (options.model) return options.model;
    listed ??= (await listModels())[0]?.slug ?? null;
    if (!listed) throw new ModelProviderError('unsupported', 'This ChatGPT account lists no models Vowe can use.');
    return listed;
  }

  async function open(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw new ModelProviderError('cancelled', 'Cancelled.');
      let res: Response;
      try {
        res = await http(RESPONSES_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${await options.bearer()}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify(body),
          signal,
        });
      } catch (err) {
        if (signal?.aborted) throw new ModelProviderError('cancelled', 'Cancelled.');
        if (err instanceof ModelProviderError) throw err;
        throw new ModelProviderError('unavailable', `Couldn’t reach OpenAI: ${err instanceof Error ? err.message : String(err)}`, { retryable: true });
      }
      if (res.ok && res.body) return res;
      const requestId = res.headers.get('x-request-id') ?? undefined;
      const json = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string; param?: string }; detail?: string };
      const error = planError(json.error?.code, json.error?.message ?? json.detail ?? res.statusText, res.status, requestId, json.error?.param);
      console.warn(`[${options.id}] HTTP ${res.status} ${json.error?.code ?? (json.detail ? 'detail' : 'no-code')} request ${requestId ?? '?'}`);
      if (!error.detail.retryable || res.status !== 503 || attempt >= RETRY_DELAYS_MS.length) throw error;
      await wait(RETRY_DELAYS_MS[attempt], signal);
    }
  }

  return {
    id: options.id,
    name: options.name,
    billing: options.billing,
    get model() {
      return options.model || listed || 'account default';
    },
    isConfigured: options.isConfigured,
    listModels,

    async complete({ instructions, items, tools, allowTools, signal, onTextDelta }: ModelRequest): Promise<ModelResponse> {
      const res = await open(
        {
          model: await model(),
          instructions,
          input: toInput(items, options.id),
          tools: tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.inputSchema, strict: false })),
          tool_choice: allowTools ? 'auto' : 'none',
          parallel_tool_calls: true,
          include: ['reasoning.encrypted_content'],
          store: false,
          stream: true,
        },
        signal,
      );
      const requestId = res.headers.get('x-request-id') ?? undefined;
      let completed = null as { model?: string; output?: OutputItem[] } | null;
      // Plan accounts stream each item as output_item.done and may complete with an empty `output`.
      const done: OutputItem[] = [];
      const seen = new Map<string, number>();
      try {
        for await (const event of sseEvents(res.body!)) {
          const type = event.type as string;
          seen.set(type, (seen.get(type) ?? 0) + 1);
          if (type === 'response.output_text.delta') onTextDelta?.(String(event.delta ?? ''));
          else if (type === 'response.output_item.done' && event.item) done.push(event.item as OutputItem);
          else if (type === 'response.completed') completed = event.response as { model?: string; output?: OutputItem[] };
          else if (type === 'response.failed') {
            const error = (event.response as { error?: { code?: string; message?: string; param?: string } }).error;
            throw planError(error?.code, error?.message ?? 'the response failed', 200, requestId, error?.param);
          } else if (type === 'response.incomplete') {
            const reason = (event.response as { incomplete_details?: { reason?: string } }).incomplete_details?.reason ?? 'unknown';
            if (reason === 'max_output_tokens') return { items: fromOutput(((event.response as { output?: OutputItem[] }).output) ?? [], options.id).items, stopReason: 'max_tokens', model: await model() };
            throw new ModelProviderError('incomplete', `The response stopped early (${reason}).`, { requestId });
          } else if (type === 'error') {
            throw planError(event.code as string | undefined, String(event.message ?? 'stream error'), 200, requestId, event.param as string | undefined);
          }
        }
      } catch (err) {
        if (signal?.aborted) throw new ModelProviderError('cancelled', 'Cancelled.');
        throw err;
      }
      // Only response.completed marks success; a stream that just ends is an interrupted one.
      if (!completed) throw new ModelProviderError('incomplete', 'The response stream ended before it completed.', { requestId, retryable: true });
      const { items: out, refused } = fromOutput(completed.output?.length ? completed.output : done, options.id);
      const calls = out.some((i) => i.type === 'tool_call');
      if (!out.length) console.warn(`[responses] ${options.id} returned no output items; stream events: ${[...seen].map(([t, n]) => `${t}×${n}`).join(', ')}`);
      return { items: out, stopReason: refused && !calls ? 'refusal' : calls ? 'tool_use' : 'end_turn', model: completed.model ?? (await model()) };
    },
  };
}
