// pnpm eval:agent: Vowe's runtime, in text, against the payment-worker scenario. The real
// Collaborator, tools, canvas validation and evidence checks, over a synthetic payments repository
// and room (fixture.mjs). Needs `pnpm build` first.
//
//   --provider auto|chatgpt|openai|anthropic|mock    (default auto: the first one that's configured)
//   --question "…"                                   (default: the crash-after-charge question)
//   --voice                                          (as a spoken turn)
//   --require-real                                   (fail instead of falling back to the mock)
//   --json <file>                                    (also write the report as JSON)
//
// chatgpt signs in with Sign in with ChatGPT in your browser (VOWE_CHATGPT_PLAN=on), into this
// harness's own credential file under ~/.vowe-eval, never the app's or another tool's. openai and
// anthropic use OPENAI_API_KEY / ANTHROPIC_API_KEY from .env. mock is a scripted stand-in that only
// exercises the plumbing; its answer proves nothing about reasoning, and the report says so.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { exec } from 'node:child_process';
import { Collaborator } from '../../dist/assistant/index.js';
import { reasoningTools, roomTools } from '../../dist/assistant/room-tools.js';
import { workContextTools } from '../../dist/assistant/tools.js';
import { config } from '../../dist/config.js';
import { grepTracked, readTrackedFile } from '../../dist/git/index.js';
import { anthropic } from '../../dist/integrations/anthropic/index.js';
import { createChatGptAuth } from '../../dist/integrations/openai/chatgpt.js';
import { createResponsesProvider } from '../../dist/integrations/openai/responses.js';
import { canvas, createFixtureRepo, people, room } from './fixture.mjs';
import { mockProvider } from './mock.mjs';

const { values: args } = parseArgs({
  options: {
    provider: { type: 'string', default: 'auto' },
    question: { type: 'string', default: 'What happens if this worker crashes after charging but before acknowledging the job?' },
    voice: { type: 'boolean', default: false },
    'require-real': { type: 'boolean', default: false },
    json: { type: 'string' },
  },
});

// ─── Providers ───────────────────────────────────────────────────────────────

const chatgptAuth = createChatGptAuth({
  dir: join(homedir(), '.vowe-eval'),
  openBrowser: async (url) => {
    console.log('\nOpening your browser to sign in with ChatGPT…');
    exec(`${process.platform === 'darwin' ? 'open' : 'xdg-open'} '${url.replace(/'/g, "'\\''")}'`);
  },
  agentName: `${config.chatgpt.agentName} (eval)`,
  enabled: config.chatgpt.enabled,
});
const chatgpt = createResponsesProvider({
  id: 'chatgpt',
  name: 'ChatGPT',
  billing: 'chatgpt-plan',
  model: config.agent.chatgptModel,
  isConfigured: () => chatgptAuth.status().signedIn && chatgptAuth.status().planUsage === 'granted',
  bearer: async () => (await chatgptAuth.accessToken()).token,
});
const openai = createResponsesProvider({
  id: 'openai',
  name: 'OpenAI API',
  billing: 'api-key',
  model: config.agent.openaiModel,
  isConfigured: () => Boolean(process.env.OPENAI_API_KEY),
  bearer: async () => process.env.OPENAI_API_KEY ?? '',
});

async function pickProvider(choice) {
  if (choice === 'mock') return mockProvider();
  if (choice === 'chatgpt' || (choice === 'auto' && config.chatgpt.enabled)) {
    if (!config.chatgpt.enabled) throw new Error('ChatGPT plan usage is off: set VOWE_CHATGPT_PLAN=on (see INTEGRATION.md → Eligibility).');
    if (!chatgpt.isConfigured()) await chatgptAuth.signIn();
    if (chatgpt.isConfigured()) return chatgpt;
    if (choice === 'chatgpt') throw new Error('Signed in, but ChatGPT plan usage was not granted.');
  }
  if (choice === 'openai' && !openai.isConfigured()) throw new Error('--provider openai needs OPENAI_API_KEY (in .env or the environment).');
  if (choice === 'anthropic' && !anthropic.isConfigured()) throw new Error('--provider anthropic needs ANTHROPIC_API_KEY (in .env or the environment), or `ant auth login`.');
  if (choice === 'openai' || (choice === 'auto' && openai.isConfigured())) return openai;
  if (choice === 'anthropic' || (choice === 'auto' && anthropic.isConfigured())) return anthropic;
  if (choice !== 'auto') throw new Error(`Unknown provider ${choice}`);
  if (args['require-real']) throw new Error('--require-real: no real provider is configured (see INTEGRATION.md → Environment).');
  return mockProvider();
}

// ─── The world ───────────────────────────────────────────────────────────────

const repo = createFixtureRepo();
const work = {
  async getWorkContext() {
    throw new Error('This eval has no Claude Code sessions or worktrees; only code.');
  },
  async listWorkstreams() {
    return [];
  },
  async listSessions() {
    return [];
  },
  async getSessionMessages() {
    return null;
  },
  async getWorktreeChanges() {
    return null;
  },
  async searchCode(_repo, _ws, terms, pathspec) {
    const matches = await grepTracked(repo, terms, { pathspec });
    return { root: repo, matches: matches.slice(0, 60), omitted: Math.max(0, matches.length - 60) };
  },
  readCode: (_repo, _ws, path, from, to) => readTrackedFile(repo, path, from, to),
};

let provider;
try {
  provider = await pickProvider(args.provider);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(2);
}
const agent = new Collaborator({
  provider: () => provider,
  work,
  tools: workContextTools,
  roomTools,
  reasoningTools,
  describeRepository: () => `Repository: payments, checked out at ${repo} on branch main (a clean worktree).`,
  approve: async (request) => {
    console.log(`  ? ${request.title} → yes (synthetic repository)`);
    return true;
  },
  rooms: {
    source: { room: async () => room.details, members: async () => room.members, record: async () => room.record },
    checkout: async () => ({ repositoryId: 'eval-payments' }),
    localUser: async () => people.daniel.userId,
  },
});

// ─── The turn ────────────────────────────────────────────────────────────────

const mock = provider.id === 'mock';
console.log(`Vowe text eval: ${provider.name} (${provider.billing}${provider.model ? `, ${provider.model}` : ''})${mock ? ' MOCK ONLY: no real model is configured' : ''}`);
console.log(`Daniel selected Payment Worker and asks: "${args.question}"\n`);

let streaming = false;
const handle = agent.ask(
  { roomId: 'eval-room', participant: people.daniel, question: args.question, recentTurns: [], canvas, source: args.voice ? 'voice' : 'text' },
  (event) => {
    if (event.type !== 'text.delta' && streaming) (process.stdout.write('\n'), (streaming = false));
    switch (event.type) {
      case 'tool.started':
        console.log(`  → ${event.call.name} ${JSON.stringify(event.call.input).slice(0, 140)}`);
        break;
      case 'tool.finished':
        if (event.call.error) console.log(`    ✗ ${event.call.error.slice(0, 200)}`);
        else if (event.evidence.length) console.log(`    cites ${event.evidence.join(' ')}`);
        break;
      case 'canvas.command':
        console.log(`  ◆ canvas ${event.command.type}: ${event.command.reason}`);
        break;
      case 'canvas.rejected':
        console.log(`  ◇ canvas ${event.tool} refused: ${event.errors.join('; ')}`);
        break;
      case 'text.delta':
        if (!streaming) process.stdout.write('  … ');
        streaming = true;
        process.stdout.write(event.delta.replace(/\n/g, ' '));
        break;
    }
  },
);
process.once('SIGINT', () => handle.cancel());
const reply = await handle.done;

console.log(`\n── Answer (${reply.stop}${reply.model ? `, ${reply.model}` : ''}) ──\n${reply.text || '(none)'}`);
if (reply.error) console.log(`\nError: ${reply.error.code}: ${reply.error.message}${reply.error.manageUrl ? ` (${reply.error.manageUrl})` : ''}`);
console.log(`\n── Grounding: ${reply.grounding.status} ──`);
for (const c of reply.grounding.claims) console.log(`  [${c.basis}] ${c.text} ${c.evidence.join(' ')}${c.issues ? `  ⚠ ${c.issues.join('; ')}` : ''}`);
for (const g of reply.grounding.gaps) console.log(`  gap: ${g}`);
for (const s of reply.grounding.sources) console.log(`  ${s.id} ${s.kind} ${s.ref}`);
console.log(`\n── Canvas commands (${reply.commands.length}) ──`);
for (const c of reply.commands) console.log(JSON.stringify(c, null, 2));

// ─── Checks: the behaviour the scenario asks for, not the wording ────────────

const failureView = reply.commands.find((c) => c.type === 'show_view' && c.payload.view === 'failure');
const steps = failureView?.payload.sequence?.steps ?? [];
const codeSources = reply.grounding.sources.filter((s) => s.kind === 'code');
const checks = [
  ['answered', reply.stop === 'answered'],
  ['grounded on the selection', reply.focus.how === 'selected' && reply.focus.componentIds.includes('payment-worker')],
  ['read the worker code', reply.toolCalls.some((c) => !c.error && /search_code|read_code/.test(c.name))],
  ['observed claims cite code', reply.grounding.claims.some((c) => c.basis === 'observed') && codeSources.some((s) => s.ref.startsWith('src/payments/worker.ts'))],
  ['explains a second charge', mock ? null : /twice|double|duplicate|second charge|charged again/i.test(reply.text)],
  ['emitted a validated failure view', Boolean(failureView)],
  ['the view marks the crash and the bad outcome', steps.some((s) => s.tone === 'crash') && steps.some((s) => s.tone === 'bad')],
  ['no unsupported claims', reply.grounding.status === 'grounded'],
];
console.log('\n── Checks ──');
for (const [name, ok] of checks) console.log(`  ${ok === null ? '–' : ok ? '✔' : '✖'} ${name}${ok === null ? ' (skipped: needs a real model)' : ''}`);
const failed = checks.filter(([, ok]) => ok === false).length;
console.log(mock ? '\nMOCK ONLY: these checks exercised the runtime with a scripted model, not a real one.' : `\n${failed ? `${failed} check(s) failed` : 'All checks passed'} with ${provider.name}.`);
if (args.json) {
  const { writeFileSync } = await import('node:fs');
  const report = {
    kind: mock ? 'mock' : 'real-model',
    provider: { id: provider.id, name: provider.name, billing: provider.billing, model: reply.model },
    question: args.question,
    source: args.voice ? 'voice' : 'text',
    checks: Object.fromEntries(checks.map(([name, ok]) => [name, ok === null ? 'skipped' : ok ? 'pass' : 'fail'])),
    reply: { ...reply, grounding: reply.roomGrounding }, // the room's copy: no local excerpts in a file that may be shared
  };
  writeFileSync(args.json, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Report written to ${args.json}`);
}
process.exitCode = failed ? 1 : 0;
