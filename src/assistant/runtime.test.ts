import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AgentEvent, ClaudeCodeSession, RoomAgentTurn, RoomDecision, RoomDetails, RoomMember, RoomRecord } from '../shared/api.js';
import type { CanvasSnapshot } from './canvas.js';
import { Collaborator, type CollaboratorOptions } from './index.js';
import { ModelProviderError, type ModelItem, type ModelProvider, type ModelRequest, type ModelResponse } from './provider.js';
import { reasoningTools, roomTools } from './room-tools.js';
import { workContextTools, type WorkContextReader } from './tools.js';

// The runtime against a scripted model: each step sees the request and answers with text and tool
// calls, as a provider would. The tools are the real ones, over fake work and room sources.

const DANIEL = { userId: 'u-daniel', name: 'Daniel' };
const PRIYA = { userId: 'u-priya', name: 'Priya' };

export const paymentCanvas: CanvasSnapshot = {
  version: 1,
  view: 'arch',
  views: [
    { id: 'arch', name: 'Architecture' },
    { id: 'failure', name: 'Failure', question: 'What breaks?' },
  ],
  components: [
    { id: 'api', name: 'Checkout API', kind: 'service' },
    { id: 'queue', name: 'Jobs queue', kind: 'queue', tech: 'jobs · 30s lease' },
    { id: 'worker', name: 'Payment Worker', kind: 'service', short: 'the worker', tech: 'payment-worker', paths: ['src/worker.ts'] },
    { id: 'psp', name: 'Card processor', kind: 'external' },
  ],
  relationships: [
    { from: 'api', to: 'queue', label: 'enqueue' },
    { from: 'queue', to: 'worker', label: 'lease' },
    { from: 'worker', to: 'psp', label: 'charge' },
  ],
  selection: { selected: ['worker'], circled: [] },
};

const WORKER_TS = [
  'export async function handle(job) {',
  '  const charge = await psp.charge(job.amount, job.card);',
  '  await db.saveCharge(job.id, charge.id);',
  '  await queue.ack(job.id);',
  '}',
];

const session: ClaudeCodeSession = {
  id: 'abcdef12-0000-4000-8000-000000000000',
  title: 'Retry worker',
  firstPrompt: 'make the worker retry',
  cwd: '/repo',
  gitBranch: 'main',
  createdAt: '2026-10-24T10:00:00Z',
  lastModifiedAt: '2026-10-24T11:00:00Z',
  fileSize: 1000,
  messageCount: 2,
  activity: null,
};
const SECRET = 'my staging card is 4242 and the admin password is hunter2-staging-only';

function fakeWork(): WorkContextReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getWorkContext() {
      throw new Error('not used');
    },
    async listWorkstreams() {
      return [];
    },
    async listSessions() {
      return [session];
    },
    async getSessionMessages() {
      calls.push('getSessionMessages');
      return {
        total: 1,
        workstreamId: null,
        link: null,
        activity: [],
        messages: [{ index: 0, message: { role: 'user', timestamp: '2026-10-24T10:00:00Z', parentToolUseId: null, blocks: [{ type: 'text', text: SECRET }] } }],
      } as never;
    },
    async getWorktreeChanges() {
      return null;
    },
    async searchCode(_repo, _ws, terms) {
      calls.push(`searchCode:${terms.join(',')}`);
      const matches = WORKER_TS.flatMap((text, i) => (terms.some((t) => text.toLowerCase().includes(t.toLowerCase())) ? [{ path: 'src/worker.ts', line: i + 1, text }] : []));
      return { root: '/repo', matches, omitted: 0 };
    },
    async readCode(_repo, _ws, path, from = 1, to = WORKER_TS.length) {
      calls.push(`readCode:${path}`);
      if (path !== 'src/worker.ts') throw new Error(`Not a tracked file in this worktree: ${path}`);
      const end = Math.min(to, WORKER_TS.length);
      return { path, from, to: end, totalLines: WORKER_TS.length, text: WORKER_TS.slice(from - 1, end).map((l, i) => `${from + i}: ${l}`).join('\n') };
    },
  };
}

const members: RoomMember[] = [DANIEL, PRIYA].map((p) => ({ roomId: 'r1', userId: p.userId, role: 'member', joinedAt: '', email: '', name: p.name, avatarUrl: null }) as RoomMember);
const decision = (signers: string[]): RoomDecision => ({
  id: 'd1000000',
  roomId: 'r1',
  title: 'Charges are idempotent by job id',
  verify: 'idempotency key sent; replay test',
  version: 2,
  proposedBy: { id: DANIEL.userId, name: 'Daniel' } as never,
  createdAt: '',
  updatedAt: '',
  signatures: signers.map((userId) => ({ userId, version: 2 }) as never),
  history: [],
});

function fakeRooms(opts: { signers?: string[]; memberOf?: boolean } = {}) {
  return {
    async room(roomId: string): Promise<RoomDetails> {
      if (opts.memberOf === false) throw new Error('not a member');
      return { id: roomId, name: 'Payment Reliability', goal: 'No duplicate charges', repository: 'github.com/acme/payments', memberCount: 2 } as RoomDetails;
    },
    async members() {
      return members;
    },
    async record(): Promise<RoomRecord> {
      return { roomId: 'r1', threads: [], decisions: [decision(opts.signers ?? [DANIEL.userId])], activity: [], lastSeenAt: null };
    },
  };
}

type Step = (request: ModelRequest, step: number) => ModelResponse | Promise<ModelResponse>;

function scripted(steps: Step[]): ModelProvider & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    id: 'fake',
    name: 'Fake',
    billing: 'chatgpt-plan',
    model: 'fake-1',
    requests,
    isConfigured: () => true,
    async complete(request) {
      requests.push({ ...request, items: [...request.items] });
      const step = steps[requests.length - 1];
      if (!step) throw new Error(`no scripted step ${requests.length}`);
      return step(request, requests.length);
    },
  };
}

let ids = 0;
const call = (name: string, input: unknown): ModelItem => ({ type: 'tool_call', id: `c${++ids}`, name, input });
const reply = (...items: ModelItem[]): ModelResponse => ({ items, stopReason: items.some((i) => i.type === 'tool_call') ? 'tool_use' : 'end_turn', model: 'fake-1' });
const say = (text: string) => reply({ type: 'assistant', text });
/** The tool results the model sees for its previous step's calls, by tool name. */
const results = (request: ModelRequest) => {
  const byId = new Map(request.items.flatMap((i) => (i.type === 'tool_call' ? [[i.id, i.name] as const] : [])));
  return request.items.flatMap((i) => (i.type === 'tool_result' ? [{ name: byId.get(i.callId), content: i.content, isError: i.isError }] : []));
};
const lastResult = (request: ModelRequest, name: string) => results(request).filter((r) => r.name === name).at(-1)!;
const evidenceIn = (content: string) => [...new Set(content.match(/E\d+/g) ?? [])];

function collaborator(provider: ModelProvider, over: Partial<CollaboratorOptions> & { approve?: CollaboratorOptions['approve']; local?: string | null; roomSource?: ReturnType<typeof fakeRooms>; checkout?: boolean } = {}) {
  const work = fakeWork();
  const agent = new Collaborator({
    provider: () => provider,
    work,
    tools: workContextTools,
    roomTools,
    reasoningTools,
    describeRepository: () => 'Repository: payments (main).',
    approve: over.approve ?? (async () => true),
    rooms: {
      source: over.roomSource ?? fakeRooms(),
      checkout: async () => (over.checkout === false ? null : { repositoryId: 'repo1' }),
      localUser: async () => (over.local === undefined ? DANIEL.userId : over.local),
    },
  });
  return { agent, work };
}

function turn(over: Partial<RoomAgentTurn> = {}): RoomAgentTurn {
  return {
    roomId: 'r1',
    participant: DANIEL,
    question: 'What happens if this worker crashes after charging but before acknowledging the job?',
    recentTurns: [],
    canvas: paymentCanvas,
    source: 'text',
    ...over,
  };
}

async function run(agent: Collaborator, t = turn()) {
  const events: AgentEvent[] = [];
  const handle = agent.ask(t, (e) => events.push(e));
  const result = await handle.done;
  return { reply: result, events, handle };
}

/** The scenario's happy path, the way a capable model would walk it. */
function duplicateChargeScript(): Step[] {
  return [
    () => reply(call('search_code', { terms: ['charge', 'ack'] }), call('get_room_context', {})),
    (req) => {
      const code = evidenceIn(lastResult(req, 'search_code').content);
      return reply(
        call('show_view', {
          view: 'failure',
          focus: ['worker'],
          sequence: {
            actors: ['queue', 'worker', 'psp'],
            steps: [
              { actor: 'queue', title: 'Leases job' },
              { actor: 'worker', title: 'Charges card', tone: 'normal' },
              { actor: 'worker', title: 'Crashes before ack', tone: 'crash' },
              { actor: 'queue', title: 'Lease expires, job redelivered' },
              { actor: 'psp', title: 'Card charged twice', tone: 'bad' },
            ],
          },
          reason: 'The worker charges before it acknowledges, so a crash in between redelivers a paid job.',
          evidence: code,
        }),
        call('report_reasoning', {
          claims: [
            { text: 'The worker charges the card before it acks the job.', basis: 'observed', evidence: code },
            { text: 'A crash between them lets the lease expire and the job be charged again.', basis: 'inferred', evidence: code },
          ],
          gaps: ['No test for redelivery was seen.'],
        }),
      );
    },
    () => say('The card is charged twice: src/worker.ts:2 charges, and the ack at src/worker.ts:4 never happens, so the queue redelivers the job.'),
  ];
}

describe('room turns', () => {
  it('grounds on the selection, calls tools, emits a validated failure view, and returns evidence', async () => {
    const provider = scripted(duplicateChargeScript());
    const { agent, work } = collaborator(provider);
    const { reply: r, events } = await run(agent);

    assert.equal(r.stop, 'answered');
    assert.match(r.text, /charged twice/);
    assert.deepEqual(r.focus, { how: 'selected', componentIds: ['worker'] });
    // The model was told what "this" is before it asked anything.
    const first = provider.requests[0].items[0];
    assert.ok(first.type === 'user' && /selected Payment Worker \(id worker, service, "payment-worker", paths src\/worker\.ts\)/.test(first.text));
    assert.deepEqual(work.calls, ['searchCode:charge,ack']);

    assert.equal(r.commands.length, 1);
    const [command] = r.commands;
    assert.equal(command.type, 'show_view');
    assert.equal(command.visibility, 'room');
    assert.equal(command.requestedBy, DANIEL.userId);
    assert.ok(command.type === 'show_view' && command.payload.sequence?.steps.some((s) => s.tone === 'crash'));
    assert.ok(command.evidence.length > 0);

    assert.equal(r.grounding.status, 'grounded');
    assert.deepEqual(r.grounding.claims.map((c) => c.basis), ['observed', 'inferred']);
    assert.ok(r.grounding.sources.every((s) => s.kind === 'code' && s.ref.startsWith('src/worker.ts:')));
    assert.deepEqual(r.grounding.gaps, ['No test for redelivery was seen.']);

    const types = events.map((e) => e.type);
    assert.equal(types[0], 'turn.started');
    assert.equal(types.at(-1), 'turn.completed');
    assert.equal(types.filter((t) => t === 'turn.completed' || t === 'turn.failed' || t === 'turn.cancelled').length, 1);
    assert.ok(types.includes('approval.requested'), 'code sharing is asked for');
    assert.ok(types.includes('canvas.command'));
    const finished = events.filter((e) => e.type === 'tool.finished');
    assert.deepEqual(finished.map((e) => e.call.name), ['search_code', 'get_room_context', 'show_view', 'report_reasoning']);
    assert.ok(finished[0].type === 'tool.finished' && finished[0].evidence.length === 3);
  });

  it('refuses canvas commands that name components the canvas does not have, and tells the model', async () => {
    const provider = scripted([
      () => reply(call('highlight_component', { componentIds: ['ledger'], tone: 'risk', reason: 'At risk.' })),
      (req) => {
        assert.match(lastResult(req, 'highlight_component').content, /no component "ledger" on this canvas/);
        assert.equal(lastResult(req, 'highlight_component').isError, true);
        return reply(call('report_reasoning', { claims: [{ text: 'Unclear.', basis: 'inferred' }] }));
      },
      () => say('I could not tell.'),
    ]);
    const { agent } = collaborator(provider);
    const { reply: r, events } = await run(agent);
    assert.equal(r.commands.length, 0);
    const rejected = events.find((e) => e.type === 'canvas.rejected');
    assert.ok(rejected && rejected.type === 'canvas.rejected' && rejected.tool === 'highlight_component');
  });

  it('lets a proposed component be connected in the same turn, and drops evidence ids no tool returned', async () => {
    const provider = scripted([
      () =>
        reply(
          call('propose_component', { component: { id: 'idem', name: 'Idempotency keys', kind: 'store' }, near: 'worker', reason: 'Remember charged jobs.', evidence: ['E99'] }),
          call('connect_components', { from: 'worker', to: 'idem', label: 'check key', reason: 'Check before charging.' }),
          call('report_reasoning', { claims: [{ text: 'A key store prevents a second charge.', basis: 'inferred' }] }),
        ),
      () => say('Add an idempotency store.'),
    ]);
    const { agent } = collaborator(provider);
    const { reply: r } = await run(agent);
    assert.deepEqual(r.commands.map((c) => c.type), ['propose_component', 'connect_components']);
    assert.deepEqual(r.commands[0].evidence, []);
  });

  it('reports tool failures to the model and keeps going', async () => {
    const provider = scripted([
      () => reply(call('read_code', { path: 'src/missing.ts' }), call('no_such_tool', {}), call('search_code', { terms: ['x'] })),
      (req) => {
        const [read, unknown, invalid] = results(req);
        assert.equal(read.isError, true);
        assert.match(read.content, /Not a tracked file/);
        assert.match(unknown.content, /Unknown tool: no_such_tool/);
        assert.match(invalid.content, /Invalid input: terms\.0/);
        return reply(call('report_reasoning', { claims: [{ text: 'The file is not in the repository.', basis: 'inferred' }], gaps: ['src/missing.ts'] }));
      },
      () => say('That file is not tracked here.'),
    ]);
    const { agent } = collaborator(provider);
    const { reply: r } = await run(agent);
    assert.equal(r.stop, 'answered');
    assert.deepEqual(r.toolCalls.map((c) => Boolean(c.error)), [true, true, true, false]);
  });

  it('downgrades claims the evidence does not support', async () => {
    const provider = scripted([
      () => reply(call('describe_canvas', {}), call('get_room_context', {})),
      (req) => {
        const canvas = evidenceIn(lastResult(req, 'describe_canvas').content);
        return reply(
          call('report_reasoning', {
            claims: [
              { text: 'The worker acks after charging.', basis: 'observed', evidence: canvas },
              { text: 'The worker retries forever.', basis: 'observed', evidence: ['E42'] },
              { text: 'We agreed on idempotency.', basis: 'decided', evidence: evidenceIn(lastResult(req, 'get_room_context').content).filter((id) => id !== canvas[0]) },
            ],
          }),
        );
      },
      () => say('Probably.'),
    ]);
    // Only Daniel signed: the decision isn't agreed, so it can't make a claim `decided`.
    const { agent } = collaborator(provider, { roomSource: fakeRooms({ signers: [DANIEL.userId] }) });
    const { reply: r } = await run(agent);
    assert.equal(r.grounding.status, 'partial');
    assert.deepEqual(r.grounding.claims.map((c) => c.basis), ['inferred', 'inferred', 'inferred']);
    assert.match(r.grounding.claims[0].issues!.join(), /no code, Git or transcript evidence/);
    assert.match(r.grounding.claims[1].issues!.join(), /E42, which no tool returned/);
    assert.match(r.grounding.claims[2].issues!.join(), /no decision signed/);
  });

  it('accepts a decided claim once every member signed the current version', async () => {
    const provider = scripted([
      () => reply(call('get_room_context', {})),
      (req) => reply(call('report_reasoning', { claims: [{ text: 'Charges are idempotent by job id.', basis: 'decided', evidence: evidenceIn(lastResult(req, 'get_room_context').content) }] })),
      () => say('Yes, the room agreed.'),
    ]);
    const { agent } = collaborator(provider, { roomSource: fakeRooms({ signers: [DANIEL.userId, PRIYA.userId] }) });
    const { reply: r } = await run(agent);
    assert.equal(r.grounding.status, 'grounded');
    assert.equal(r.grounding.claims[0].basis, 'decided');
  });

  it('asks once for a missing reasoning report and keeps the first answer', async () => {
    const provider = scripted([
      () => say('It double-charges.'),
      (req) => {
        const nudge = req.items.at(-1)!;
        assert.ok(nudge.type === 'user' && /Call report_reasoning/.test(nudge.text));
        return reply(call('report_reasoning', { claims: [{ text: 'Crash before ack redelivers.', basis: 'hypothetical' }] }));
      },
      () => say('(repeated answer that should not replace the first)'),
    ]);
    const { agent } = collaborator(provider);
    const { reply: r } = await run(agent);
    assert.equal(r.text, 'It double-charges.');
    assert.equal(r.grounding.claims[0].basis, 'hypothetical');
  });

  it('reports missing evidence as unreported when the model never explains itself', async () => {
    const provider = scripted([() => say('Trust me.'), () => say('Still trust me.')]);
    const { agent } = collaborator(provider);
    const { reply: r } = await run(agent);
    assert.equal(r.grounding.status, 'unreported');
    assert.deepEqual(r.grounding.sources, []);
  });

  it('says so when the repository is not checked out here, without reading code', async () => {
    const provider = scripted([
      (req) => {
        const first = req.items[0];
        assert.ok(first.type === 'user' && /isn't checked out on this machine/.test(first.text));
        return reply(call('search_code', { terms: ['charge'] }));
      },
      (req) => {
        assert.match(lastResult(req, 'search_code').content, /isn't checked out on this machine/);
        return reply(call('report_reasoning', { claims: [{ text: 'Unverified.', basis: 'hypothetical' }], gaps: ['No local code.'] }));
      },
      () => say('I cannot see the code here.'),
    ]);
    const { agent, work } = collaborator(provider, { checkout: false });
    const { reply: r } = await run(agent);
    assert.equal(r.stop, 'answered');
    assert.deepEqual(work.calls, []);
  });
});

describe('authorization', () => {
  it('refuses a turn for someone other than the person signed in here', async () => {
    const provider = scripted([]);
    const { agent } = collaborator(provider);
    const { reply: r, events } = await run(agent, turn({ participant: PRIYA }));
    assert.equal(r.error?.code, 'not-authorized');
    assert.equal(provider.requests.length, 0);
    assert.deepEqual(events.map((e) => e.type), ['turn.failed']);
  });

  it('refuses when signed out, and when the room is not readable (not a member)', async () => {
    for (const opts of [{ local: null }, { roomSource: fakeRooms({ memberOf: false }) }]) {
      const provider = scripted([]);
      const { agent } = collaborator(provider, opts);
      const { reply: r } = await run(agent);
      assert.equal(r.error?.code, 'not-authorized');
      assert.equal(provider.requests.length, 0);
    }
  });

  it('refuses a conversation started by another person or room', async () => {
    const provider = scripted(duplicateChargeScript());
    const { agent } = collaborator(provider);
    const first = await run(agent);
    const other = await run(agent, turn({ roomId: 'r2', conversationId: first.reply.conversationId }));
    assert.equal(other.reply.error?.code, 'not-authorized');
  });

  it('rejects malformed turns before anything runs', async () => {
    const provider = scripted([]);
    const { agent } = collaborator(provider);
    const bad = { ...turn(), canvas: { ...paymentCanvas, view: 'nope' } } as unknown as RoomAgentTurn;
    const { reply: r } = await run(agent, bad);
    assert.equal(r.error?.code, 'invalid-turn');
    assert.match(r.error!.message, /canvas\.view/);
  });

  it('does not read code when the person declines, and remembers the answer for the conversation', async () => {
    let asked = 0;
    const provider = scripted([
      () => reply(call('search_code', { terms: ['charge'] })),
      (req) => {
        assert.match(lastResult(req, 'search_code').content, /declined to share code/);
        return reply(call('read_code', { path: 'src/worker.ts' }));
      },
      (req) => {
        assert.match(lastResult(req, 'read_code').content, /declined/);
        return reply(call('report_reasoning', { claims: [{ text: 'Not checked.', basis: 'hypothetical' }], gaps: ['Code sharing declined.'] }));
      },
      () => say('I could not check the code.'),
    ]);
    const { agent, work } = collaborator(provider, { approve: async () => (asked++, false) });
    const { reply: r } = await run(agent);
    assert.equal(asked, 1);
    assert.deepEqual(work.calls, []);
    assert.equal(r.stop, 'answered');
  });
});

describe('cancellation', () => {
  it('cancels a turn mid-request, rolls back its items, and lets the next one start cleanly', async () => {
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => (started = resolve));
    const provider = scripted([
      (req) =>
        new Promise((_, reject) => {
          started();
          req.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
      ...duplicateChargeScript(),
    ]);
    const { agent } = collaborator(provider);
    const events: AgentEvent[] = [];
    const handle = agent.ask(turn(), (e) => events.push(e));
    await inFlight;
    handle.cancel('interrupted');
    const r = await handle.done;
    assert.equal(r.stop, 'cancelled');
    const ended = events.at(-1)!;
    assert.ok(ended.type === 'turn.cancelled' && ended.reason === 'interrupted');

    const next = await run(agent, turn({ conversationId: r.conversationId }));
    assert.equal(next.reply.stop, 'answered');
    // The cancelled question left nothing behind: the next request starts with the new question only.
    assert.equal(provider.requests[1].items.length, 1);
  });

  it('settles a pending approval when the turn is cancelled', async () => {
    let asked!: () => void;
    const askedP = new Promise<void>((resolve) => (asked = resolve));
    const provider = scripted([() => reply(call('search_code', { terms: ['charge'] }))]);
    const { agent, work } = collaborator(provider, {
      approve: (_req, signal) =>
        new Promise((resolve) => {
          asked();
          signal.addEventListener('abort', () => resolve(false));
        }),
    });
    const handle = agent.ask(turn(), () => {});
    await askedP;
    handle.cancel();
    assert.equal((await handle.done).stop, 'cancelled');
    assert.deepEqual(work.calls, []);
  });

  it('fails with the provider error and never switches provider', async () => {
    const provider = scripted([
      () => {
        throw new ModelProviderError('usage-limit', 'Usage limit reached.', { manageUrl: 'https://chatgpt.com/settings/usage', providerCode: 'subscription_sharing_usage_limit_exceeded' });
      },
    ]);
    const { agent } = collaborator(provider);
    const { reply: r, events } = await run(agent);
    assert.equal(r.stop, 'failed');
    assert.deepEqual({ code: r.error?.code, url: r.error?.manageUrl }, { code: 'usage-limit', url: 'https://chatgpt.com/settings/usage' });
    assert.equal(events.at(-1)!.type, 'turn.failed');
    assert.equal(provider.requests.length, 1);
  });
});

describe('transcript privacy', () => {
  function transcriptScript(canvasText: (secret: string) => string): Step[] {
    return [
      () => reply(call('read_coding_session', { sessionId: 'abcdef12' })),
      (req) => {
        const content = lastResult(req, 'read_coding_session').content;
        return reply(
          call('annotate_component', { componentId: 'worker', kind: 'note', text: canvasText(content), reason: 'From the session.' }),
          call('report_reasoning', { claims: [{ text: 'The session discussed staging.', basis: 'observed', evidence: evidenceIn(content) }] }),
        );
      },
      () => say('The session was about staging.'),
    ];
  }

  it('reads a session only with approval, and never sends it when declined', async () => {
    const provider = scripted([
      () => reply(call('read_coding_session', { sessionId: 'abcdef12' })),
      (req) => {
        assert.match(lastResult(req, 'read_coding_session').content, /declined to share this session/);
        return reply(call('report_reasoning', { claims: [{ text: 'Unknown.', basis: 'hypothetical' }] }));
      },
      () => say('I was not allowed to read it.'),
    ]);
    const { agent, work } = collaborator(provider, { approve: async () => false });
    await run(agent);
    assert.deepEqual(work.calls, []);
    assert.ok(!JSON.stringify(provider.requests).includes('hunter2'));
  });

  it('refuses canvas requests that quote a transcript, and strips transcript excerpts from the room grounding', async () => {
    const provider = scripted(transcriptScript(() => `Note: ${SECRET.toUpperCase()}`));
    const { agent } = collaborator(provider);
    const { reply: r, events } = await run(agent);
    assert.equal(r.commands.length, 0);
    const rejected = events.find((e) => e.type === 'canvas.rejected');
    assert.ok(rejected?.type === 'canvas.rejected' && /local Claude Code transcript/.test(rejected.errors[0]));

    // The asker's own reply keeps the excerpt; the room's copy doesn't.
    assert.ok(JSON.stringify(r.grounding).includes('hunter2'));
    assert.ok(!JSON.stringify(r.roomGrounding).includes('hunter2'));
    assert.ok(!JSON.stringify(r.roomGrounding).includes('abcdef12'));
    assert.equal(r.roomGrounding.claims[0].basis, 'observed');
  });

  it('lets a canvas request describe a session in its own words', async () => {
    const provider = scripted(transcriptScript(() => 'A local session worked on staging retries.'));
    const { agent } = collaborator(provider);
    const { reply: r } = await run(agent);
    assert.equal(r.commands.length, 1);
  });
});
