import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ModelProviderError, type ModelProvider } from '../../assistant/provider.js';
import { selectProvider } from '../../assistant/select.js';
import { createChatGptAuth, PLAN_SCOPE } from './chatgpt.js';
import { createResponsesProvider, toInput } from './responses.js';

// Sign in with ChatGPT and the Responses provider against a fake OpenAI: the real loopback listener
// receives the redirect, ID tokens are signed with a generated RSA key published as the JWKS.

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-key';
const jwks = { keys: [{ ...(publicKey.export({ format: 'jwk' }) as object), kid: KID, alg: 'RS256', use: 'sig' }] };

function idToken(claims: Record<string, unknown>, key: KeyObject = privateKey, kid = KID) {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const body = `${enc({ alg: 'RS256', kid, typ: 'JWT' })}.${enc(claims)}`;
  return `${body}.${sign('sha256', Buffer.from(body), key).toString('base64url')}`;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

interface FakeOpenAI {
  fetch: typeof fetch;
  token: URLSearchParams[];
  revoked: URLSearchParams[];
  authorize: URL[];
  /** What the next token responses say (shift per call), else the default. */
  tokenReplies: ((body: URLSearchParams) => Response)[];
  /** Claims overrides for the next ID token. */
  claims: Record<string, unknown>;
  scope: string;
  issuedClient: string;
}

function fakeOpenAI(): FakeOpenAI {
  const fake: FakeOpenAI = {
    token: [],
    revoked: [],
    authorize: [],
    tokenReplies: [],
    claims: {},
    scope: `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`,
    issuedClient: 'oaiapp_test123',
    fetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith('/.well-known/jwks.json')) return json(jwks);
      if (url.endsWith('/.well-known/openid-configuration')) return json({ revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke' });
      if (url.endsWith('/oauth/revoke')) {
        fake.revoked.push(new URLSearchParams(String(init?.body)));
        return new Response(null, { status: 200 });
      }
      if (url.endsWith('/oauth/token')) {
        const body = new URLSearchParams(String(init?.body));
        fake.token.push(body);
        const custom = fake.tokenReplies.shift();
        if (custom) return custom(body);
        const n = fake.token.length;
        const nonce = fake.authorize.at(-1)?.searchParams.get('nonce');
        return json({
          access_token: `at-${n}`,
          refresh_token: `rt-${n}`,
          id_token: idToken({ iss: 'https://auth.openai.com', aud: body.get('client_id'), sub: 'user-1', email: 'daniel@example.com', exp: Math.floor(Date.now() / 1000) + 3600, nonce, ...fake.claims }),
          token_type: 'Bearer',
          expires_in: 3600,
          scope: fake.scope,
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  };
  return fake;
}

/** A "browser" that approves at once: the authorization server redirects back to the loopback. */
function browser(fake: FakeOpenAI, extra: (url: URL) => Record<string, string> = () => ({})) {
  return async (raw: string) => {
    const url = new URL(raw);
    fake.authorize.push(url);
    const back = new URL(url.searchParams.get('redirect_uri')!);
    back.searchParams.set('state', url.searchParams.get('state')!);
    back.searchParams.set('code', `code-${fake.authorize.length}`);
    if (url.searchParams.get('client_id') === 'dynamic_agent_client') back.searchParams.set('client_id', fake.issuedClient);
    for (const [k, v] of Object.entries(extra(url))) v === '' ? back.searchParams.delete(k) : back.searchParams.set(k, v);
    void fetch(back).catch(() => {});
  };
}

const sealer = { seal: (t: string) => `sealed:${Buffer.from(t).toString('base64')}`, unseal: (t: string) => Buffer.from(t.slice(7), 'base64').toString() };

function auth(fake: FakeOpenAI, over: { enabled?: boolean; dir?: string; now?: () => number; open?: (url: string) => Promise<void> } = {}) {
  const dir = over.dir ?? mkdtempSync(join(tmpdir(), 'vowe-chatgpt-'));
  return { dir, auth: createChatGptAuth({ dir, fetch: fake.fetch, openBrowser: over.open ?? browser(fake), sealer, agentName: 'Vowe', enabled: over.enabled ?? true, now: over.now }) };
}

describe('Sign in with ChatGPT', () => {
  it('registers on first sign-in with the documented authorize request, and stores tokens privately', async () => {
    const fake = fakeOpenAI();
    const { auth: a, dir } = auth(fake);
    const status = await a.signIn();

    const url = fake.authorize[0];
    assert.equal(url.origin + url.pathname, 'https://auth.openai.com/api/accounts/authorize');
    const q = url.searchParams;
    assert.equal(q.get('client_id'), 'dynamic_agent_client');
    assert.equal(q.get('agent_name_hint'), 'Vowe');
    assert.match(q.get('ext_agent_host_id')!, /^urn:uuid:[0-9a-f-]{36}$/);
    assert.match(q.get('redirect_uri')!, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    assert.deepEqual(q.get('scope')!.split(' ').sort(), ['email', 'offline_access', 'openid', 'profile', 'resource.invoke', PLAN_SCOPE].sort());
    assert.equal(q.get('resource'), 'https://api.openai.com/v1');
    assert.equal(q.get('response_type'), 'code');
    assert.equal(q.get('code_challenge_method'), 'S256');
    assert.ok(q.get('state') && q.get('nonce'));

    const exchange = fake.token[0];
    assert.equal(exchange.get('grant_type'), 'authorization_code');
    assert.equal(exchange.get('client_id'), 'oaiapp_test123');
    assert.equal(createHash('sha256').update(exchange.get('code_verifier')!).digest('base64url'), q.get('code_challenge'));
    assert.equal(exchange.get('redirect_uri'), q.get('redirect_uri'));
    assert.equal(exchange.get('resource'), 'https://api.openai.com/v1');

    assert.deepEqual(
      { signedIn: status.signedIn, planUsage: status.planUsage, welcome: status.welcome, email: status.account?.email },
      { signedIn: true, planUsage: 'granted', welcome: true, email: 'daniel@example.com' },
    );
    const file = join(dir, 'chatgpt-accounts.json');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const raw = readFileSync(file, 'utf8');
    assert.ok(!raw.includes('rt-1') && !raw.includes('at-1'), 'tokens are sealed at rest');
    assert.deepEqual(await a.accessToken(), { token: 'at-1', clientId: 'oaiapp_test123' });
    a.dismissWelcome();
    assert.equal(a.status().welcome, false);
  });

  it('reauthorizes the saved client with hints, and keeps the host id', async () => {
    const fake = fakeOpenAI();
    const { auth: a, dir } = auth(fake);
    await a.signIn();
    await a.signIn();
    const [first, second] = fake.authorize.map((u) => u.searchParams);
    assert.equal(second.get('client_id'), 'oaiapp_test123');
    assert.equal(second.get('agent_name_hint'), null);
    assert.equal(second.get('login_hint'), 'daniel@example.com');
    assert.ok(second.get('id_token_hint'));
    assert.equal(second.get('ext_agent_host_id'), first.get('ext_agent_host_id'));
    // A fresh process reads the same file.
    const again = createChatGptAuth({ dir, fetch: fake.fetch, openBrowser: async () => {}, sealer, agentName: 'Vowe', enabled: true });
    assert.equal((await again.accessToken()).token, 'at-2');
  });

  it('refuses plan usage when the plan scope was not granted', async () => {
    const fake = fakeOpenAI();
    fake.scope = 'openid profile email offline_access';
    const { auth: a } = auth(fake);
    const status = await a.signIn();
    assert.equal(status.planUsage, 'not-granted');
    await assert.rejects(a.accessToken(), (e: unknown) => e instanceof ModelProviderError && e.code === 'not-eligible');
  });

  it('rejects an ID token with the wrong nonce, audience or signature', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    for (const tamper of [{ claims: { nonce: 'other' } }, { claims: { aud: 'oaiapp_someone_else' } }, { key: other }]) {
      const fake = fakeOpenAI();
      if (tamper.claims) fake.claims = tamper.claims;
      if (tamper.key) {
        fake.tokenReplies.push((body) =>
          json({
            access_token: 'at',
            refresh_token: 'rt',
            id_token: idToken({ iss: 'https://auth.openai.com', aud: body.get('client_id'), sub: 'u', exp: Date.now() / 1000 + 60, nonce: fake.authorize[0].searchParams.get('nonce') }, tamper.key),
            expires_in: 3600,
            scope: fake.scope,
          }),
        );
      }
      const { auth: a } = auth(fake);
      await assert.rejects(a.signIn());
      assert.equal(a.status().signedIn, false);
    }
  });

  it('treats a cancelled consent as nothing changed', async () => {
    const fake = fakeOpenAI();
    const { auth: a } = auth(fake, { open: browser(fake, () => ({ error: 'access_denied', code: '' })) });
    await assert.rejects(a.signIn(), (e: unknown) => e instanceof ModelProviderError && e.code === 'not-signed-in');
    assert.equal(fake.token.length, 0);
  });

  it('refreshes near expiry once for concurrent requests, rotating the refresh token', async () => {
    const fake = fakeOpenAI();
    let clock = Date.now();
    const { auth: a } = auth(fake, { now: () => clock });
    await a.signIn();
    clock += 56 * 60_000; // inside the 5-minute early-refresh window
    const [x, y] = await Promise.all([a.accessToken(), a.accessToken()]);
    assert.equal(fake.token.length, 2);
    const refresh = fake.token[1];
    assert.deepEqual([refresh.get('grant_type'), refresh.get('refresh_token'), refresh.get('resource')], ['refresh_token', 'rt-1', 'https://api.openai.com/v1']);
    assert.equal(x.token, 'at-2');
    assert.equal(y.token, 'at-2');
    clock += 56 * 60_000;
    await a.accessToken();
    assert.equal(fake.token[2].get('refresh_token'), 'rt-2');
  });

  it('clears tokens on a terminal refresh error and asks to sign in again', async () => {
    const fake = fakeOpenAI();
    let clock = Date.now();
    const { auth: a } = auth(fake, { now: () => clock });
    await a.signIn();
    clock += 2 * 3600_000;
    fake.tokenReplies.push(() => json({ error: 'refresh_token_reused' }, 400));
    await assert.rejects(a.accessToken(), (e: unknown) => e instanceof ModelProviderError && e.code === 'not-signed-in');
    assert.equal(a.status().signedIn, false);
    assert.match(a.status().problem!, /sign in again/);
  });

  it('signs out by revoking the refresh token, keeping the client for next time', async () => {
    const fake = fakeOpenAI();
    const { auth: a } = auth(fake);
    await a.signIn();
    assert.deepEqual(await a.signOut(), { revoked: true });
    assert.equal(fake.revoked[0].get('token'), 'rt-1');
    assert.equal(fake.revoked[0].get('token_type_hint'), 'refresh_token');
    assert.equal(a.status().signedIn, false);
    await assert.rejects(a.accessToken(), (e: unknown) => e instanceof ModelProviderError && e.code === 'not-signed-in');
    assert.equal(a.status().savedAccounts[0].clientId, 'oaiapp_test123');
  });

  it('stays off behind the eligibility gate', async () => {
    const fake = fakeOpenAI();
    const { auth: a } = auth(fake, { enabled: false });
    await assert.rejects(a.signIn(), (e: unknown) => e instanceof ModelProviderError && e.code === 'not-eligible');
    assert.equal(fake.authorize.length, 0);
  });
});

// ─── Responses ───────────────────────────────────────────────────────────────

function sse(events: object[], { chunk = 7 } = {}) {
  const text = events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(c) {
        for (let i = 0; i < bytes.length; i += chunk) c.enqueue(bytes.slice(i, i + chunk)); // split mid-event on purpose
        c.close();
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream', 'x-request-id': 'req_1' } },
  );
}

function responses(replies: (() => Response)[]) {
  const sent: { url: string; body: Record<string, unknown>; auth: string }[] = [];
  const provider = createResponsesProvider({
    id: 'chatgpt',
    name: 'ChatGPT',
    billing: 'chatgpt-plan',
    model: 'gpt-test',
    isConfigured: () => true,
    bearer: async () => 'at-1',
    fetch: async (url, init) => {
      sent.push({ url: String(url), body: JSON.parse(String(init?.body)), auth: new Headers(init?.headers).get('Authorization')! });
      return replies.shift()!();
    },
  });
  return { provider, sent };
}

const request = { instructions: 'Be brief.', items: [{ type: 'user' as const, text: 'Hi' }], tools: [{ name: 'search_code', description: 'Search.', inputSchema: { type: 'object' } }], allowTools: true };

describe('Responses provider', () => {
  it('sends a plan-eligible streaming request and reads text, tool calls and reasoning', async () => {
    const reasoning = { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque' };
    const { provider, sent } = responses([
      () =>
        sse([
          { type: 'response.created' },
          { type: 'response.output_text.delta', delta: 'Look' },
          { type: 'response.output_text.delta', delta: 'ing.' },
          {
            type: 'response.completed',
            response: {
              model: 'gpt-test-2026',
              output: [
                reasoning,
                { type: 'message', content: [{ type: 'output_text', text: 'Looking.' }] },
                { type: 'function_call', call_id: 'call_1', name: 'search_code', arguments: '{"terms":["charge"]}' },
              ],
            },
          },
        ]),
    ]);
    const deltas: string[] = [];
    const res = await provider.complete({ ...request, onTextDelta: (d) => deltas.push(d) });

    const [{ url, body, auth }] = sent;
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(auth, 'Bearer at-1');
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    assert.equal(body.tool_choice, 'auto');
    for (const omitted of ['previous_response_id', 'temperature', 'top_p', 'max_output_tokens', 'metadata', 'user', 'background', 'truncation', 'safety_identifier', 'prompt_cache_retention'])
      assert.ok(!(omitted in body), `${omitted} is omitted`);

    assert.deepEqual(deltas, ['Look', 'ing.']);
    assert.equal(res.stopReason, 'tool_use');
    assert.equal(res.model, 'gpt-test-2026');
    assert.deepEqual(res.items, [
      { type: 'opaque', provider: 'chatgpt', data: reasoning },
      { type: 'assistant', text: 'Looking.' },
      { type: 'tool_call', id: 'call_1', name: 'search_code', input: { terms: ['charge'] } },
    ]);
    // Reasoning goes back verbatim next time, but only to the provider that produced it.
    assert.deepEqual(toInput(res.items, 'chatgpt')[0], reasoning);
    assert.equal(toInput(res.items, 'openai').length, 2);
  });

  it('asks for no tools on the last step', async () => {
    const { provider, sent } = responses([() => sse([{ type: 'response.completed', response: { output: [] } }])]);
    await provider.complete({ ...request, allowTools: false });
    assert.equal(sent[0].body.tool_choice, 'none');
  });

  it('maps a plan usage limit to its manage link, without retrying', async () => {
    const { provider, sent } = responses([() => json({ error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } }, 429, { 'x-request-id': 'req_9' })]);
    await assert.rejects(provider.complete(request), (e: unknown) => {
      assert.ok(e instanceof ModelProviderError);
      assert.deepEqual([e.code, e.detail.manageUrl, e.detail.requestId, e.detail.providerCode], ['usage-limit', 'https://chatgpt.com/settings/usage', 'req_9', 'subscription_sharing_usage_limit_exceeded']);
      return true;
    });
    assert.equal(sent.length, 1);
  });

  it('does not retry an ineligible user', async () => {
    const { provider, sent } = responses([() => json({ error: { code: 'subscription_sharing_user_not_eligible', message: 'no' } }, 403)]);
    await assert.rejects(provider.complete(request), (e: unknown) => e instanceof ModelProviderError && e.code === 'not-eligible' && !e.detail.retryable);
    assert.equal(sent.length, 1);
  });

  it('retries temporary unavailability with backoff, then succeeds', async () => {
    const { provider, sent } = responses([
      () => json({ error: { code: 'subscription_sharing_usage_unavailable', message: 'busy' } }, 503),
      () => sse([{ type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] } }]),
    ]);
    const res = await provider.complete(request);
    assert.equal(sent.length, 2);
    assert.deepEqual(res.items, [{ type: 'assistant', text: 'ok' }]);
  });

  it('treats a stream that ends without response.completed as incomplete', async () => {
    const { provider } = responses([() => sse([{ type: 'response.output_text.delta', delta: 'half' }])]);
    await assert.rejects(provider.complete(request), (e: unknown) => e instanceof ModelProviderError && e.code === 'incomplete');
  });

  it('reports a failed response with its code', async () => {
    const { provider } = responses([() => sse([{ type: 'response.failed', response: { error: { code: 'subscription_sharing_unsupported_capability', message: 'x', param: 'tools' } } }])]);
    await assert.rejects(provider.complete(request), (e: unknown) => e instanceof ModelProviderError && e.code === 'unsupported' && /tools/.test(e.message));
  });

  it('cancels when aborted', async () => {
    const controller = new AbortController();
    const provider = createResponsesProvider({
      id: 'chatgpt', name: 'ChatGPT', billing: 'chatgpt-plan', model: 'm', isConfigured: () => true, bearer: async () => 't',
      fetch: (_u, init) => new Promise((_, reject) => init!.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
    });
    const pending = provider.complete({ ...request, signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, (e: unknown) => e instanceof ModelProviderError && e.code === 'cancelled');
  });

  it('lists the plan account models that are visible', async () => {
    const provider = createResponsesProvider({
      id: 'chatgpt', name: 'ChatGPT', billing: 'chatgpt-plan', model: '', isConfigured: () => true, bearer: async () => 't',
      fetch: async () => json({ models: [{ slug: 'hidden', visibility: 'hide' }, { slug: 'gpt-a', display_name: 'GPT A', visibility: 'list' }] }),
    });
    assert.deepEqual(await provider.listModels(), [{ slug: 'gpt-a', name: 'GPT A' }]);
  });
});

describe('provider selection', () => {
  const p = (id: string, configured: boolean) => ({ id, isConfigured: () => configured }) as ModelProvider;
  it('prefers the ChatGPT plan, falls back to the first configured key, and honours a pinned choice', () => {
    assert.equal(selectProvider('auto', p('chatgpt', true), [p('openai', true)]).id, 'chatgpt');
    assert.equal(selectProvider('auto', p('chatgpt', false), [p('openai', false), p('anthropic', true)]).id, 'anthropic');
    assert.equal(selectProvider('auto', p('chatgpt', false), [p('openai', false)]).id, 'chatgpt', 'nothing configured: the plan, so the person is asked to sign in');
    assert.equal(selectProvider('openai', p('chatgpt', true), [p('openai', false)]).id, 'openai', 'pinned, even unconfigured');
  });
});
