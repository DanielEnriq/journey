# Vowe's runtime: integration contracts

There is one brain: `Collaborator` (`src/assistant/index.ts`), running in each person's Electron main
process. Typed room questions, the developer screen and voice all use it. It explains and questions the
work. It never edits code and never steers coding agents. It produces three things: streamed words, a
checked account of what those words rest on, and validated canvas commands.

This document is the contract. The types below are copied from the source (`src/shared/api.ts`,
`src/assistant/canvas.ts`, `src/renderer/shared/vowe-voice.ts`). The JSON Schemas in
`src/assistant/contracts/` are generated from the zod schemas the runtime enforces. A test fails if
they drift from the source; `pnpm contracts:write` regenerates them.

| Contract | Source of truth | JSON Schema |
|---|---|---|
| Starting a turn: `RoomAgentTurn` | `roomTurnSchema` in `index.ts` | `contracts/room-agent-turn.schema.json` |
| The canvas the turn sees: `CanvasSnapshot` | `canvasSnapshotSchema` in `canvas.ts` | `contracts/canvas-snapshot.schema.json` |
| What Vowe asks the canvas to do: `CanvasCommand` | `canvasCommandSchema` in `canvas.ts` | `contracts/canvas-command.schema.json` |
| Events, replies, errors | `src/shared/api.ts` | TypeScript only (they originate in the runtime) |

```
asker's machine                                                     everyone in the room
───────────────────────────────────────────────────────────         ─────────────────────
renderer                         main (this runtime)
 room UI ── journey.agent.ask ──▶ Collaborator.ask
 VoiceAdapter ─ agentOverIpc ──▶   ├─ per-user check: asker == the person signed in here
                                   ├─ selectProvider: THIS person's ChatGPT plan, or this machine's key
                                   ├─ tools: WorkContextService (local), room record (Supabase, RLS)
          ◀── agent:event ───────  └─ AgentEvent stream: text, tools, approvals, canvas, end
 canvas engine ◀ canvas.command ─────────────────────────────── (relay to room: unresolved, §5)
 VoiceOutput (TTS) ─ audio as "vowe:<userId>" ─ LiveKit ─────────▶ hears "Vowe (for Daniel)"
```

## 1. Room turns: start, stream, cancel

### API (renderer, through the preload bridge)

```ts
window.journey.agent.ask(turn: RoomAgentTurn): Promise<{ turnId: string }>
window.journey.agent.onEvent(listener: (event: AgentEvent) => void): () => void   // returns unsubscribe
window.journey.agent.cancel(turnId: string): Promise<void>
window.journey.agent.approve(approvalId: string, approved: boolean): Promise<void>
window.journey.agent.status(): Promise<AgentStatus>   // provider, billing, configured, chatgpt status
```

The IPC channels are `agent:ask`, `agent:cancel`, `agent:approve` and `agent:status` (invoke), and
`agent:event` (broadcast to every window). In main, `Collaborator.ask(turn, onEvent)` returns a
`TurnHandle { turnId, conversationId, done: Promise<RoomAgentReply>, cancel(reason?) }`.

### Input

```ts
export interface RoomAgentTurn {
  roomId: string;
  /** The cloud user asking. Must be the person signed in on this machine. */
  participant: { userId: string; name: string | null };
  question: string;                                                  // 1–8000 chars, trimmed
  /** What was said before, oldest first, for context (a few turns). */
  recentTurns: { speaker: string; text: string; at?: string }[];     // ≤ 20, text ≤ 4000
  /** What the asker's canvas shows, including what they selected or circled. */
  canvas: CanvasSnapshot;                                            // §2
  /** Continues an earlier turn's conversation; null or absent starts one. */
  conversationId?: string | null;
  source: 'text' | 'voice';
}
```

Validation is strict: unknown fields are rejected. The question is resolved against
`canvas.selection`. Circled components come first, then selected ones. This is how "this worker"
becomes `payment-worker`.

### Authorization, checked in this order before any model call

| Check | On failure (`turn.failed` with `error.code`) |
|---|---|
| The turn matches `roomTurnSchema` | `invalid-turn`, naming the first 3 bad fields |
| `conversationId`, if given, is known here | `invalid-turn` ("That conversation has ended") |
| The conversation belongs to this room and this asker | `not-authorized` |
| No other turn is running in this conversation | `busy` |
| Someone is signed in to Vowe (cloud user) on this machine | `not-authorized` |
| `participant.userId` equals that signed-in user | `not-authorized`: **never answered on this machine's sign-in** |
| The room is readable through the person's Supabase session (RLS: members only) | `not-authorized` |

During the turn, code and transcript excerpts reach the model only after the person approves. Code
is approved once per repository and conversation, transcripts once per session and conversation, via
`approval.requested`. If the person declines, the tool returns `{ declined: true }`, and the answer has
to say what couldn't be checked.

### Events, in order

```ts
export type AgentEvent =
  | { type: 'turn.started'; turnId: string; conversationId: string; roomId: string; provider: AgentProviderInfo }
  /** Partial answer text. `step` counts model calls; text before a tool call is Vowe thinking aloud. */
  | { type: 'text.delta'; turnId: string; step: number; delta: string }
  /** The answer's full text, once known. */
  | { type: 'text.final'; turnId: string; text: string }
  | { type: 'tool.started'; turnId: string; call: { id: string; name: string; input: unknown } }
  | { type: 'tool.finished'; turnId: string; call: AgentToolCall; evidence: string[] }
  | { type: 'approval.requested'; turnId: string; request: AgentApprovalRequest }
  | { type: 'canvas.command'; turnId: string; command: CanvasCommand }
  /** A canvas request the runtime refused to emit, and why (the model is told too). */
  | { type: 'canvas.rejected'; turnId: string; tool: string; errors: string[] }
  | { type: 'turn.completed'; turnId: string; reply: RoomAgentReply }
  | { type: 'turn.cancelled'; turnId: string; reason: 'interrupted' | 'cancelled'; reply: RoomAgentReply }
  | { type: 'turn.failed'; turnId: string; error: AgentError; reply: RoomAgentReply };

export interface AgentProviderInfo { id: string; name: string; billing: 'chatgpt-plan' | 'api-key'; model: string }
export interface AgentToolCall { id: string; name: string; input: unknown; error: string | null }
export interface AgentApprovalRequest { id: string; conversationId: string; title: string; detail: string }
```

These guarantees hold for every turn:

- **Exactly one ending event:** each turn ends with exactly one of `turn.completed`, `turn.cancelled`
  or `turn.failed`, and it is always the last event.
- **Failed authorization emits nothing else:** a turn that fails the checks above produces only
  `turn.failed`, with no `turn.started`.
- **Events can arrive before `ask()` resolves:** they are broadcast to every window. Buffer them and
  filter by `turnId`. `agentOverIpc()` in `vowe-voice.ts` does this and is the reference client.
- **Approvals:** `approval.requested` is also sent on the legacy `agent:approval` channel. Answer it
  with `approve(request.id, yes)`. If the turn is cancelled, the approval settles as `false`.

### Result

```ts
export interface RoomAgentReply {
  turnId: string;
  conversationId: string;
  roomId: string;
  text: string;
  stop: 'answered' | 'step-limit' | 'truncated' | 'refused' | 'cancelled' | 'failed';
  /** The claims behind the answer, checked against what the tools returned. */
  grounding: Grounding;
  /** The same, as it may be shown to the room: local excerpts and session ids removed (groundingForRoom). Post this one. */
  roomGrounding: Grounding;
  /** Validated canvas requests, in the order they were made. */
  commands: CanvasCommand[];
  toolCalls: AgentToolCall[];
  /** What the question was resolved against. */
  focus: { how: 'circled' | 'selected' | 'none'; componentIds: string[] };
  provider: AgentProviderInfo;
  model: string | null;
  error?: AgentError;
}

interface Grounding {
  status: 'grounded' | 'partial' | 'unreported';   // partial: some claims were downgraded
  claims: { text: string; basis: 'observed' | 'inferred' | 'hypothetical' | 'decided'; evidence: string[]; issues?: string[] }[];
  gaps: string[];                                  // what Vowe could not check
  sources: { id: string; kind: 'code' | 'git' | 'session' | 'activity' | 'decision' | 'thread' | 'goal' | 'canvas';
             ref: string; excerpt?: string; visibility: 'local' | 'room'; approved?: boolean; toolCallId: string }[];
}
```

`grounding` belongs on the asker's own screen. **Only `roomGrounding` may be shown to or stored for the
room.**

### Errors

```ts
export interface AgentError {
  code: 'not-signed-in' | 'not-eligible' | 'usage-limit' | 'unavailable' | 'unsupported' | 'auth' | 'rate-limit'
      | 'cancelled' | 'incomplete' | 'other' | 'not-authorized' | 'busy' | 'invalid-turn';
  message: string;          // written for a person
  retryable: boolean;
  manageUrl?: string;       // usage-limit: https://chatgpt.com/settings/usage
  providerCode?: string;    // OpenAI's or Anthropic's own code, e.g. subscription_sharing_usage_limit_exceeded
  requestId?: string;
}
```

| Code | Meaning | UI |
|---|---|---|
| `usage-limit` | The ChatGPT plan's limit was hit | "Usage limit reached." with a "Manage usage" link to `manageUrl`. Do not retry on a key. |
| `not-signed-in` | No ChatGPT sign-in, or it ended | "Continue with ChatGPT" (`journey.chatgpt.signIn()`) |
| `not-eligible` | Plan usage is off for this build, or this account isn't eligible | Offer an API key instead |
| `unavailable`, `rate-limit`, `incomplete` | Temporary | "Try again" when `retryable` |
| `auth`, `unsupported`, `other` | Provider refused | Show `message` |
| `not-authorized`, `busy`, `invalid-turn` | Runtime checks above | Show `message` |

A provider error ends the turn. **The runtime never switches provider or billing mid-turn.**

### Cancel

`journey.agent.cancel(turnId)`, or `handle.cancel('interrupted' | 'cancelled')` in main, aborts the
in-flight model request and settles pending approvals as `false`. A read-only tool that is already
running finishes, but no further tool or model call starts. It then emits
`turn.cancelled` with the reason and rolls the conversation back to before the question, so the next
question starts from a clean history. Cancelling an unknown or finished turn does nothing.

### Example

```ts
const { turnId } = await journey.agent.ask({ roomId, participant: { userId: me.id, name: me.name }, question,
  recentTurns: [], canvas: snapshot, conversationId, source: 'text' });
```

In practice, use `agentOverIpc(journey.agent).ask(turn, onEvent)`. It handles the buffering and
filtering and returns `{ turnId, done, cancel }`.

## 2. Canvas commands (contract version 1)

### In: `CanvasSnapshot`

The renderer builds this from what the asker sees. The full schema is in
`contracts/canvas-snapshot.schema.json`.

```ts
{
  version: 1,
  view: 'arch' | 'failure' | 'alternatives' | 'concurrency' | 'impl' | 'timeout' | 'ui',
  views: { id: ViewId, name: string /*≤60*/, question?: string /*≤200*/ }[],                 // ≤ 20
  components: { id: ComponentId, name: string /*≤80*/, kind: 'service' | 'queue' | 'external' | 'store' | 'client' | 'code',
                short?: string, tech?: string, proposed?: boolean, paths?: string[] /*repo paths, ≤20*/ }[],  // ≤ 200
  relationships: { from: ComponentId, to: ComponentId, label?: string /*≤60*/ }[],         // ≤ 400
  selection: { selected: ComponentId[], circled: ComponentId[] },                          // ≤ 50 each
}
// ComponentId: /^[A-Za-z][\w-]{0,63}$/
```

View ids and component kinds are checked at compile time against the renderer's `ViewId` and `PartKind`.

### Out: `CanvasCommand`

The envelope is the same on every command. The runtime fills it in; the model only supplies `reason`,
`evidence` and the payload.

```ts
{
  v: 1,
  id: string,            // UUID, unique per command
  roomId: string,        // the turn's room
  turnId: string,
  requestedBy: string,   // the asker's cloud user id: verified as the person signed in, never model-chosen
  reason: string,        // 1–240 chars, read by people on the canvas; must not quote local code or transcripts
  evidence: string[],    // ≤ 20 evidence ids ("E3"); ids no tool returned are dropped
  visibility: 'room',
  type, payload          // one of these:
}
```

| `type` | `payload` (strict: no other fields) | Extra rules |
|---|---|---|
| `highlight_component` | `{ componentIds: ComponentId[1..8], tone: 'focus' \| 'risk' \| 'verified' }` | Every id is on the canvas |
| `annotate_component` | `{ componentId, kind: 'note' \| 'concern' \| 'question' \| 'constraint', text: string(1..280) }` | The id is on the canvas. A suggestion until a person keeps it. |
| `show_view` | `{ view: ViewId, focus?: ComponentId[≤8], sequence?: { actors: ComponentId[1..6], steps: { actor, title: string(1..60), detail?: string(≤140), tone?: 'normal' \| 'crash' \| 'bad' \| 'good' /*default normal*/ }[1..12] } }` | `sequence` only on the `failure`, `timeout` and `concurrency` views. Each step's actor is one of `actors`, and every id is on the canvas. |
| `propose_component` | `{ component: { id, name: string(1..80), kind, tech?: string(≤120) }, near?: ComponentId }` | The id is new. `near` is on the canvas. Later commands in the same turn may use the new id. |
| `connect_components` | `{ from, to, label: string(1..40) }` | Both ends exist (or were proposed this turn), and `from ≠ to` |

`validateCanvasCommand(value, snapshot, proposedEarlier?)` returns
`{ ok: true, command } | { ok: false, errors: string[] }`. Each error is `"<path>: <message>"`, for
example `payload.componentIds.0: no component "ledger" on this canvas`.

### Authorization

- Only the runtime creates commands, inside a turn that passed §1's checks. The model can't set `v`,
  `id`, `roomId`, `turnId`, `requestedBy` or `visibility`.
- Before a command is emitted, the runtime validates it against the asker's snapshot. It also refuses
  any command that quotes a local Claude Code transcript (32+ matching characters).
- Commands are room-visible, so they carry evidence ids, never excerpts.
- **Receiving clients must check** (relay unresolved, §5): the room channel's `senderId === command.requestedBy`,
  `command.roomId` is the current room, `v === 1`, and that the command validates against their own
  snapshot. A command that fails is dropped. These are suggestions, so an engine may also decline any command.

### Responses

| To whom | Success | Failure |
|---|---|---|
| The model (tool result) | `{"sent":true,"commandId":"<uuid>"}` | `isError` result `Not sent to the canvas: <errors joined by "; ">`, or `Invalid input: <path>: <message>` for a malformed payload |
| The UI (event) | `canvas.command { turnId, command }` | `canvas.rejected { turnId, tool, errors }` (diagnostics, not for the room) |
| The reply | `reply.commands[]`, in order | not included |
| A person, by hand | `pnpm canvas:validate cmd.json [snapshot.json]` prints `✔ 0: <type>`, exit 0 | prints `✖ 0: <type>` and the errors, exit 1. `-` reads stdin. Without a snapshot, the eval canvas is used. |

## 3. Voice (`src/renderer/shared/vowe-voice.ts`)

### The rule

**A spoken question is answered by the speaker's own runtime, on their own sign-in, or not at all.**
Nobody's question uses another person's ChatGPT allowance, and no shared cloud agent holds plan
tokens. A server-side LiveKit agent can't use plan tokens at all: plan usage is for locally hosted apps,
one person per sign-in. A cloud participant could only use a key Vowe pays for, and could only see
room-visible data.

### How a spoken turn flows

1. **Hearing.** Each client transcribes **only its own microphone**. The speaker's identity is therefore
   the local signed-in user, which matches their LiveKit identity (the cloud user id). It is never
   inferred by diarizing someone else's audio. The call layer turns other people's activity into
   `hear({ participant, text: '…', final: false })` from LiveKit's active-speaker changes. This is
   used for barge-in only.
2. **Deciding.** `VoiceAdapter.hear()` starts a turn only for a final utterance from `localUser` that
   starts with "Vowe…" or is marked `addressed` (push-to-ask). Anything else is context. Identities
   starting with `vowe:` (any member's Vowe voice) are ignored entirely.
3. **Reasoning.** `agentOverIpc(journey.agent).ask()` sends the turn to `Collaborator.ask` in main. Main
   re-checks that `participant.userId` is the signed-in user (§1) and answers on that person's provider:
   their ChatGPT plan, or this machine's API key. The billing is in `turn.started.provider.billing`.
4. **Speaking.** The adapter calls `VoiceOutput`:
   - `begin` on `turn.started`;
   - `say` for each `text.delta`;
   - `end` on `turn.completed`;
   - `stop` on `turn.cancelled` or `turn.failed`.

   Errors are shown to the asker only and never spoken into the call.
5. **Publishing.** The asker's client publishes the TTS audio to the room's LiveKit call as its own
   participant, `VOWE_VOICE.identity(userId)` = `vowe:<userId>`, named `Vowe (for <name>)` with
   attributes `{ kind: 'vowe', speaksFor: userId }`. Everyone hears it and can see whose Vowe is
   speaking. The person's own microphone track never carries Vowe's audio.
6. **Interruptions.** Any human speech while Vowe is answering cancels the turn
   (`cancel('interrupted')`). The runtime aborts the model request, `VoiceOutput.stop()` drops the
   unspoken audio, and the conversation rolls back.

### API

```ts
export interface HumanSpeech {
  /** The LiveKit participant identity (the cloud user id) whose audio this is, never something a model said. */
  participant: { userId: string; name: string | null };
  text: string;
  final: boolean;           // false: interim (still talking)
  addressed?: boolean;      // push-to-ask; otherwise the text must start with "Vowe" / "Hey Vowe"
  at?: string;
}

export interface VoiceOutput {   // implemented by the call layer: TTS → LiveKit as VOWE_VOICE
  begin(turn: { turnId: string; speaksFor: { userId: string; name: string | null } }): void;
  say(turnId: string, text: string): void;
  end(turnId: string): void;
  stop(turnId: string): void;
}

new VoiceAdapter(agentOverIpc(window.journey.agent), {
  roomId,
  localUser: { userId: me.id, name: me.name },   // the cloud user signed in here
  canvas: () => snapshotOf(roomState),           // CanvasSnapshot v1
  output,                                        // VoiceOutput
  onEvent,                                       // optional: captions, approvals, canvas.command
}): { hear(speech: HumanSpeech): VoiceTurnHandle | null; stop(): void; readonly busy: boolean }

export const VOWE_VOICE = {
  identity: (userId) => `vowe:${userId}`,
  name: (personName) => `Vowe (for ${personName ?? 'a member'})`,
  attributes: (userId) => ({ kind: 'vowe', speaksFor: userId }),
};
export function streamTurn(agent: VoiceAgent, turn: RoomAgentTurn): AsyncIterable<AgentEvent> & { handle: VoiceTurnHandle };
```

### Model authorization for voice

This is the same as §1. A voice turn whose asker isn't signed in to ChatGPT, with no fallback key,
fails with `not-signed-in`. One whose plan is exhausted fails with `usage-limit`. Show either privately
to the asker. Nothing falls back to another member's runtime.

## 4. Environment

Main reads these from the process environment or from `<checkout>/.env`. Values already set in the
environment take precedence.

| Variable | Default | What it does |
|---|---|---|
| `VOWE_AGENT_PROVIDER` | `auto` | `auto`: the ChatGPT plan if signed in with plan usage granted, else the first configured of OpenAI key, then Anthropic key. `chatgpt`, `openai` or `anthropic` pins one. |
| `VOWE_CHATGPT_PLAN` | off | `on` enables Sign in with ChatGPT plan usage. **Leave it off until Vowe is eligible** (see Eligibility below). |
| `VOWE_CHATGPT_MODEL` | first model the account lists | Plan model slug |
| `OPENAI_API_KEY` | none | Fallback provider, billed to that key |
| `VOWE_OPENAI_MODEL` | `gpt-6.1-sol` | Model for the OpenAI key (taken from OpenAI's SIWC examples). Set it to one your key can use. |
| `ANTHROPIC_API_KEY` | none | Fallback provider. Instead of a key: `ant auth login`. |
| `VOWE_AGENT_MODEL` / `VOWE_AGENT_EFFORT` / `VOWE_AGENT_FALLBACKS` | `claude-opus-5-5` / `medium` / on | The Anthropic fallback's model, effort, and fallback model |

Google and Supabase sign-in (`GOOGLE_*`, `SUPABASE_*`) are unchanged and still required for rooms.
ChatGPT tokens are never configured through the environment. They come only from the in-app OAuth
flow, are stored in `userData/chatgpt-accounts.json` (mode 0600, token fields sealed by the OS keychain),
and never reach the renderer.

**Eligibility.** OpenAI offers plan usage to open-source, locally hosted apps. A paid or remotely
hosted app must first complete https://openai.com/form/sign-in-with-chatgpt-interest/. Vowe runs
locally, but its repository is private with no license, so it doesn't qualify yet. That is why
`VOWE_CHATGPT_PLAN` is off by default.

### Reproducible real-model evaluation

Run these from the checkout. `--require-real` refuses to fall back to the mock.

```sh
pnpm build
OPENAI_API_KEY=… node scripts/agent-eval/run.mjs --provider openai --require-real --json eval-openai.json
ANTHROPIC_API_KEY=… node scripts/agent-eval/run.mjs --provider anthropic --require-real --json eval-anthropic.json
# Only once eligible. Opens your browser to sign in, into the harness's own ~/.vowe-eval:
VOWE_CHATGPT_PLAN=on node scripts/agent-eval/run.mjs --provider chatgpt --require-real --json eval-chatgpt.json
# Variants: --voice (a spoken turn), --question "…"
```

The eval runs the real `Collaborator`, tools, canvas validation and evidence checks. It works against
a synthetic payments repository, created fresh in a temp directory and committed, and the Payment
Reliability canvas with the Payment Worker selected (`scripts/agent-eval/fixture.mjs`).

It checks behaviour, not wording:
- it answered;
- it grounded on the selection;
- it read the worker code;
- its observed claims cite `src/payments/worker.ts`;
- it explains a second charge;
- it emitted a validated `failure` view marking a crash and a bad outcome;
- no claim was downgraded.

| Exit code | Meaning |
|---|---|
| 0 | All checks passed |
| 1 | A check failed |
| 2 | The requested provider isn't available |

The `--json` report records `kind: "real-model"` or `"mock"`, the provider, the model that answered,
each check's result, and the reply with the room's grounding.

## 5. Test kinds: mocked models vs real providers

| What | Model | Network | Command |
|---|---|---|---|
| `assistant/runtime.test.ts`: the loop, tools, authorization, cancellation, evidence, privacy | **Mocked**: a scripted provider | none | `pnpm test` |
| `assistant/contract.test.ts`: canvas validation, schema drift, room grounding, `readTrackedFile` | no model | none | `pnpm test` |
| `renderer/shared/vowe-voice.test.ts`: the voice adapter and `agentOverIpc` | **Mocked**: a fake runtime | none | `pnpm test` |
| `integrations/openai/openai.test.ts`: SIWC and the Responses wire format | **Mocked**: a fake OpenAI over HTTP, with a real loopback and a signed ID token | localhost only | `pnpm test` |
| `pnpm eval:agent` with no credentials | **Mocked**: `scripts/agent-eval/mock.mjs`, printed as **MOCK ONLY**, `kind: "mock"` | none | `node scripts/agent-eval/run.mjs` |
| `pnpm eval:agent --require-real` | **Real provider** | the provider's API | §4 |

`pnpm test` never calls a real provider. As of this branch, **no real-provider run has been
recorded**: the development machine had no API key, and plan usage is gated off.

## 6. Unresolved integration contracts

| # | Contract | Owner | What's needed |
|---|---|---|---|
| 1 | **Vowe's voice identity in LiveKit** | LiveKit / token service | Tokens currently allow one identity per user, microphone only (`server/src/livekit.ts`, `supabase/functions/livekit-token`). Mint a second token for `vowe:<userId>` only to the authenticated `userId`, with `canPublishSources: [MICROPHONE]`, `canSubscribe: false`, and attributes `{kind:'vowe', speaksFor}`. Clients render it as "Vowe (for …)". |
| 2 | **`VoiceOutput` implementation** | Call layer | TTS (for example ElevenLabs, with its key kept in main or on the Vowe API, billed to Vowe, never to a ChatGPT plan) streaming into a second LiveKit connection as #1. Stop must cut audio immediately. |
| 3 | **Local speech-to-text** | Call layer | Transcribe the local microphone into `hear()`, and feed active-speaker changes as interim speech for barge-in. Decide whether others' speech is shared as captions (their privacy) or omitted from `recentTurns`. |
| 4 | **Room relay for canvas commands and the voice floor** | Multiplayer (`RoomEvents`) | Add `'vowe:canvas': { command: CanvasCommand }`, validated in main with `canvasCommandSchema` both ways and checked per §2. Optionally add `'vowe:speaking': { turnId, speaksFor, state: 'start' \| 'end' }` so only one Vowe speaks at a time. |
| 5 | ~~Canvas engine applying commands~~ **Done** | Canvas | `src/shared/canvas/runtime.ts` + `main/vowe-canvas.ts`: requests run on the room's canvas as Vowe, and each outcome reaches the asker as `canvas.applied`. See src/shared/canvas/INTEGRATION.md → "Vowe's turns on the room canvas". The model still gets `{"sent":true}`, not the outcome. |
| 6 | **Room UI**: partly done | Room UI | Done in `features/canvas/AskVowe.tsx`: the ask box, the streamed answer, the approval prompt, errors (including `manageUrl`), Stop, and canvas outcomes. **Remaining:** posting `roomGrounding` (never `grounding`) to the room's record. |
| 7 | **Sign in with ChatGPT eligibility** | Product | Open-source Vowe, or get OpenAI's approval. Until then, `VOWE_CHATGPT_PLAN` stays off. |
| 8 | **Keychain API** | Main | Electron 45 deprecates the synchronous `safeStorage` calls used by both Google and ChatGPT sign-in. Migrate both to the async variants together. |
