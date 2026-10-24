# Vowe's runtime: how to integrate it

There is one brain: `Collaborator` (`index.ts`). It runs a tool-calling loop over a model provider, a
typed tool registry, the local work context, and, in a room, the room's record and the asker's canvas.
Typed questions, the developer screen and (later) the call's voice participant all use it. It explains
and questions the work. It never edits code and never steers coding agents. It produces three things:
words, a checked account of what those words rest on, and validated canvas requests.

```
renderer (room UI, canvas, call)          main process (this runtime)                    providers
──────────────────────────────           ───────────────────────────                    ─────────
journey.agent.ask(turn) ───IPC───▶ Collaborator.ask ─┬─ selectProvider ──▶ ChatGPT plan (SIWC)  ← default
journey.agent.onEvent   ◀──IPC──── AgentEvent stream │                 └─▶ OpenAI API key / Anthropic (fallbacks)
journey.agent.cancel    ───IPC───▶ abort             ├─ tools: WorkContextService (sessions, Git, code)
journey.agent.approve   ───IPC───▶ approval prompts  │         room record (Supabase), canvas snapshot
                                                     └─ EvidenceLedger, validateCanvasCommand
```

## Files

| File | What it is |
|---|---|
| `index.ts` | `Collaborator`: `ask()` for room turns, `send()` for the developer screen, the loop, authorization, prompts |
| `provider.ts` | The neutral `ModelProvider` contract, `ModelItem`s, and `ModelProviderError` codes |
| `select.ts` | Which provider answers a turn: the ChatGPT plan first, then configured fallbacks |
| `tools.ts` | Work-context tools: `list_coding_sessions`, `read_coding_session`, `get_repository_status`, `get_worktree_changes`, `search_code`, `read_code` |
| `room-tools.ts` | `get_room_context`, `describe_canvas`, the five canvas tools, `report_reasoning` |
| `canvas.ts` | The canvas contract, version 1: the snapshot coming in, the commands going out, and validation |
| `evidence.ts` | Evidence ids, claim checking, and `groundingForRoom` |
| `voice.ts` | `VoiceAdapter`, the seam for the LiveKit voice participant, and `streamTurn` |
| `../integrations/openai/` | Sign in with ChatGPT (`chatgpt.ts`, `jwt.ts`) and the Responses provider (`responses.ts`) |
| `../integrations/anthropic/` | The Anthropic fallback |

## Providers and billing

`selectProvider(VOWE_AGENT_PROVIDER, chatgptPlan, [openaiApiKey, anthropic])` runs once per turn, before
any request is made.

- **auto** (the default) uses the person's ChatGPT plan when they have signed in with plan usage granted.
  Otherwise it uses the first fallback with a key in `.env`.
- **A pinned provider** is used even when it isn't configured. The person then sees why it can't answer,
  instead of being billed somewhere else.
- **A plan error stops the turn.** Nothing switches billing mid-turn. OpenAI's rule is "Don't silently
  switch to another billing path". For example, `usage-limit` comes back as a turn error with
  `manageUrl` pointing to ChatGPT settings → Usage.
- **The billing in use is always visible:** `AgentStatus.billing` and `AgentEvent turn.started.provider.billing`.
  The UI shows "Using ChatGPT plan" or "API key".

### Sign in with ChatGPT

This follows https://developers.openai.com/siwc/token-sharing-open-source:

- The first sign-in registers dynamically (`dynamic_agent_client` plus `agent_name_hint`). The issued
  `oaiapp_…` client id is saved and reused.
- One `ext_agent_host_id` (`urn:uuid:`) is kept per installation.
- The redirect goes to `http://127.0.0.1:<port>/auth/callback` and uses state, nonce and PKCE S256.
- The ID token is checked against OpenAI's JWKS (RS256, issuer, audience, expiry, nonce).
- Sign-in fails unless `chatgpt.tokens.use.direct` was granted.
- Refreshes are serialized because refresh tokens rotate. Terminal refresh errors clear the tokens.
- Sign-out revokes the refresh token.
- Inference is `POST https://api.openai.com/v1/responses` with `store:false`, `stream:true`, function
  tools only, and none of the omitted fields. Only `response.completed` counts as success.

Tokens live only in the main process, in `userData/chatgpt-accounts.json`. The file is written
atomically with mode 0600, and its token fields are sealed with the OS keychain (`safeStorage`). The
renderer only ever sees `ChatGptStatus`. Vowe never reads ChatGPT cookies or session tokens, and never
reads another app's credential store, such as Codex's `~/.codex`.

Google sign-in through Supabase stays separate and unchanged. It is who you are in rooms. ChatGPT is
only who pays for your own model requests. The account panel shows both sign-ins (`Account.tsx →
ChatGptSection`).

### Eligibility (read before turning it on)

OpenAI offers plan usage to **open-source and locally hosted apps**. A paid or remotely hosted app must
first complete OpenAI's interest form (https://openai.com/form/sign-in-with-chatgpt-interest/).

Vowe's runtime is locally hosted: it runs in each person's Electron main process. But the repository is
currently **private with no license**, so it is not an open-source app. For that reason the flow sits
behind `VOWE_CHATGPT_PLAN=on` and is **off by default**. Turn it on only after Vowe is published under
an open-source license, or after OpenAI approves it through the form.

## Per-user, local runtime (multiplayer rules)

A room has many members. Every member's Vowe runs on their own laptop.

- **A turn runs on the asker's machine.** `ask()` refuses any turn whose `participant.userId` is not the
  cloud user signed in there (`not-authorized`). One member's ChatGPT plan, transcripts and code therefore
  never answer another member's question. A conversation is also bound to its room and its asker.
- **Membership:** the room's record is read through the signed-in person's Supabase session, which row-level
  security limits to rooms they belong to. A room they can't read fails the turn before any model call.
- **Local context stays local.**
  - Code and transcript excerpts reach the model only after the person approves, once per repository
    for code and once per session for transcripts.
  - Nothing is ever shown to the room by default.
  - `reply.grounding` is for the asker's own screen. **Post `reply.roomGrounding` to the room**: it drops
    local excerpts and session ids.
  - The runtime refuses any canvas request that quotes a local transcript.
- **Recent activity is not a running process.** Session state is reported as what was last observed and
  when. The prompts forbid treating it as proof that Claude Code is running now.
- **A server-side LiveKit agent can't use plan tokens.** Plan tokens belong to one person, on their own
  machine. A shared cloud "Vowe" participant would be a remotely hosted app billing someone's plan for the
  whole room, which needs OpenAI's approval. It would also need everyone's local context, which it must
  not have. Voice therefore goes through each asker's local runtime (below). A cloud participant could
  only use an API key that Vowe pays for, and could only see room-visible data.

## Room UI: asking a question

```ts
const { turnId } = await window.journey.agent.ask({
  roomId, participant: { userId: me.id, name: me.name },
  question, recentTurns,            // the last few things said, for context
  canvas: snapshotOf(roomState),    // CanvasSnapshot v1: see below
  conversationId,                   // from the previous turn.started, to continue; null to start fresh
  source: 'text',
});
const off = window.journey.agent.onEvent((e) => { if (e.turnId === turnId) handle(e); });
```

The events arrive in order:

| Event | What to do with it |
|---|---|
| `turn.started` | Keep `conversationId` and show the provider and billing |
| `text.delta` | Stream the answer. Text before a tool call is Vowe thinking aloud, keyed by `step` |
| `tool.started` / `tool.finished` | Optionally show progress |
| `approval.requested` | Ask the person, then call `journey.agent.approve(request.id, yes)` |
| `canvas.command` | Hand it to the canvas engine |
| `canvas.rejected` | Development diagnostics only |
| `text.final` | The full answer text |
| `turn.completed` / `turn.cancelled` / `turn.failed` | Exactly one of these ends the turn |

Every ending event carries `reply`, a `RoomAgentReply` with `text`, `grounding`, `roomGrounding`,
`commands`, `focus` and `error`. `journey.agent.cancel(turnId)` stops a turn: its requests abort, pending
approvals settle as "no", and its history is rolled back.

On `turn.failed`, `error.code` tells the UI what to do:

| Code | Show |
|---|---|
| `usage-limit` | "Usage limit reached.", with a "Manage usage" link to `error.manageUrl` |
| `not-signed-in` | "Continue with ChatGPT" |
| `not-eligible` | The plan can't be used: suggest an API key |
| `unavailable` / `rate-limit` | Retryable: offer "Try again" |
| `not-authorized` | Not your question to answer here |
| `busy` | One turn per conversation at a time |

## Canvas engine: the contract (`canvas.ts`, version 1)

**In:** a `CanvasSnapshot`, built from the room's canvas state as the asker sees it. It contains:

- the current `view` and the available `views`;
- `components`: id, name, kind, `short` (how it's named mid-sentence), `tech` label, `proposed`, and
  `paths`, the repository paths bound to it when known (these help Vowe find the code);
- `relationships`;
- `selection: { selected, circled }`. The question is about the circled components first, else the
  selected ones. This is how "this worker" is resolved.

View ids and component kinds are checked at compile time against the renderer's `ViewId` and `PartKind`.

**Out:** `CanvasCommand`s. Each has an envelope `{ v:1, id, roomId, turnId, requestedBy, reason, evidence[],
visibility:'room' }` plus one of these payloads:

| type | payload |
|---|---|
| `highlight_component` | `componentIds[]`, `tone`: focus, risk or verified |
| `annotate_component` | `componentId`, `kind`: note, concern, question or constraint, `text` |
| `show_view` | `view`, `focus[]?`, `sequence?`: `actors[]` and `steps[{actor, title, detail?, tone: normal\|crash\|bad\|good}]`, for failure, timeout and concurrency views |
| `propose_component` | `component {id, name, kind, tech?}`, `near?` |
| `connect_components` | `from`, `to`, `label` |

`validateCanvasCommand` checks the shape, that every referenced component exists (or was proposed
earlier in the same turn), and that the sequence and view rules hold. Only commands that pass are
emitted. The engine can still decline any command.

Suggested integration:
- Draw proposals and annotations as outlined suggestions until a person keeps them. Keeping one is an
  ordinary room-record action by that person.
- Broadcast commands to the room over the existing room channel, so everyone's canvas follows.
- The canvas renderer was not changed in this branch. Applying commands is the integration step.

To check a command by hand: `pnpm canvas:validate cmd.json [snapshot.json]`, or pipe it in with `-`.

## LiveKit voice participant (`voice.ts`)

Vowe has no separate voice brain. `VoiceAdapter` sits between the call's speech-to-text and the same
`ask()`:

```ts
const voice = new VoiceAdapter(collaborator /* or an IPC-backed { ask } */, {
  roomId, localUserId: me.id, canvas: () => snapshotOf(roomState), onEvent: speakAndDraw,
});
stt.on('transcript', (t) => voice.hear({ participant: t.speaker, text: t.text, final: t.isFinal }));
```

- Any interim speech while Vowe is answering cancels the turn with reason `interrupted`. This is barge-in.
- A final utterance from the local person that starts with "Vowe…", or that is marked `addressed`
  (push-to-ask), starts a voice turn. Voice turns get shorter, citation-free answers; the evidence report
  still carries the citations.
- Everyone else's speech is kept as `recentTurns` context. Their own machines answer their questions.
- Speak `text.delta` through TTS, and send `canvas.command` to the canvas.
- `streamTurn()` gives the same turn as an async iterator.

The LiveKit service itself is unchanged. Wiring STT and TTS to `hear()` is the remaining voice work.

## Evidence

Every tool registers the sources it returns: code ranges, Git facts, transcript messages, decisions,
threads and the canvas. The model receives ids such as `E3` to cite. Before it answers, it calls
`report_reasoning` with claims labelled `observed`, `inferred`, `hypothetical` or `decided`, plus `gaps`.
The runtime checks every claim against the ledger:

- An `observed` claim needs code, Git or transcript evidence. The canvas is a drawing, not evidence.
- A `decided` claim needs a decision that every member signed on its current version.
- Ids that no tool returned are flagged.

Claims that fail these checks are downgraded to `inferred`, with the reason attached. The result is in
`reply.grounding.status`: `grounded`, `partial` or `unreported`. A missing report is asked for once, and
the original answer is kept.

## Testing

- `pnpm test` runs these suites:
  - `assistant/runtime.test.ts`: a scripted model through the real loop and tools, covering the payment
    scenario, tool failures, authorization, cancellation, evidence downgrades and transcript privacy.
  - `assistant/contract.test.ts`: the canvas contract, the room grounding, the voice adapter and
    `readTrackedFile`.
  - `integrations/openai/openai.test.ts`: SIWC against a fake OpenAI, with a real loopback and a signed
    ID token, plus Responses streaming, errors and retries, and provider selection.
- `pnpm eval:agent [--provider auto|chatgpt|openai|anthropic|mock] [--question …] [--voice]` runs the
  real runtime, in text, against a synthetic payments repository and the Payment Reliability canvas. It
  prints the trace, the answer, the grounding and the commands, then checks behaviour: it grounded on the
  selection, read the worker code, cited it, explained the second charge, and emitted a failure view
  marking the crash and the bad outcome. With no provider configured, it runs the mock and says
  **MOCK ONLY**.
  - `--provider chatgpt` (with `VOWE_CHATGPT_PLAN=on`) signs in through your browser into the harness's
    own `~/.vowe-eval`.
- The payment scenario is an evaluation case. Nothing in the runtime or prompts mentions payments,
  charges or acknowledgements.
