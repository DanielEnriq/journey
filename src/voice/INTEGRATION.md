# Vowe in calls: voice integration

Each person in a call can bring in their own Vowe: a separate LiveKit participant, `vowe:<their user id>`,
shown as "Vowe (for Daniel)". It hears only that person, through the microphone they already have on in the
call. It answers with that person's own reasoning runtime and model sign-in, and speaks into the call in its
own voice. Everything in this guide is on `feat/mvp-ai-voice`. The UI wiring (sections 3–6) is for the UI
integration agent. This branch doesn't edit `FreshCall`, the call bar, `CallService` or the canvas.

## 0. Branch ancestry

`feat/mvp-ai-voice` already contains:

| Branch | Commit | What it brings |
|---|---|---|
| `main` | `4afd461` (merge of PR #9, `integration/vowe-ui-foundation`) | The real workspace, `FreshCall`, `CallService` (`src/renderer/calls`) |
| `feat/mvp-vowe-runtime` | `d837aa4` | The reasoning runtime (`src/assistant`), `window.journey.agent`, the voice adapter (`src/renderer/shared/vowe-voice.ts`) |

It is merged at `8f7bc69` ("Merge the reasoning runtime and give each person their own Vowe in calls"), so
don't merge `feat/mvp-vowe-runtime` again separately. It does **not** contain `integration/vowe-multiplayer`
(PR #10: membership, invitations, `RoomEvents`). Expect conflicts there in `src/main/ipc.ts`,
`src/shared/api.ts`, `src/preload/index.cts` and `package.json`. Resolve them by keeping both sides: the
`voice:*` channels below are additive.

## 1. How it fits together

```
renderer (the room window)                               main process                            LiveKit room:<roomId>
───────────────────────────                              ────────────                            ─────────────────────
CallService ── your mic track (already published) ──┐
                                                    ▼
CallVoice ── tapMicrophone (AudioWorklet, 16 kHz) ── voice:audio ──▶ VoiceHost ─ Hearing ─ Scribe (STT)
   │                                                                     │
   │  ◀────────────────────── voice:speech (HeardSpeech) ─────────────────┘
   ▼
VoiceAdapter.hear()  (runtime's, unchanged)
   │ agentOverIpc ── agent:ask / agent:cancel ──▶ Collaborator (runtime, unchanged; your model sign-in)
   │ ◀──────────────────────────── agent:event ──┘
   ▼ VoiceOutput.begin / say / end / stop
CallVoice ── voice:begin / say / end / cancel ─────▶ VoweVoice ─ TTS ─ LiveKitTransport ───────▶ vowe:<you> publishes its voice
                                                     state → participant attribute `state` ───▶ everyone sees listening / thinking / speaking
   ◀──────────────────────── voice:status / voice:said ─┘
```

- **Renderer:** `src/renderer/voice/call-voice.ts` (`CallVoice`), `microphone.ts` and `microphone-worklet.ts`.
- **Main:** `src/voice/` holds `host.ts` (`VoiceHost`), `hearing.ts`, `output.ts`, `player.ts`, `livekit.ts`,
  `providers/elevenlabs.ts`, and `index.ts` (`createVoiceHost`, credentials).
- **IPC:** `src/main/ipc.ts`, `src/shared/api.ts` and `src/preload/index.cts`.
- **API:** `server/src/vowe-voice.ts`, which serves `POST /vowe/token`, `/vowe/speech-token` and `/vowe/speech`.

## 2. Authorized `vowe:<userId>` identities and tokens

- The app never mints tokens. `createVoiceHost()` asks the Vowe API with `POST /vowe/token { roomId }`, using
  the signed-in person's Supabase session as a bearer token.
- The server checks the caller's `room_members` row under their own RLS. A non-member gets **403** "Join the
  room before bringing Vowe into its call". A viewer gets **403** "Viewers can listen but not bring Vowe in".
  Knowing the LiveKit room name is never enough.
- The identity comes from the verified session, never from the request: `vowe:<caller user id>`. The name is
  `Vowe (for <users.name>)`. People's identities are bare user ids, so a Vowe can't take a person's place.
- The grant has these properties:
  - **Room:** `room:<roomId>` only.
  - **Participant:** `kind: agent`.
  - **Publishing:** the microphone source only. `canPublishData: false`.
  - **Listening:** `canSubscribe: false`. Vowe can't hear the call; it hears only its owner's mic, inside the
    owner's app.
  - **Metadata:** `canUpdateOwnMetadata: true`, which is how it updates `state`.
  - **Expiry:** a 10-minute TTL.
- Attributes: `{ kind: 'vowe', speaksFor: <userId>, state: 'listening' | 'thinking' | 'speaking' }`.
- There is one seat per person. Bringing Vowe in from a second device replaces the first, because it has the
  same identity.
- Vowe leaves when its owner leaves the call (`owner-left`), when its owner signs out, or when the app quits.
- This uses the Vowe API. The hosted `livekit-token` Edge Function has no Vowe route. **`VOWE_API_URL` is
  required** for voice. Without it, `voice.start` rejects with "Vowe's voice needs the Vowe API: set
  VOWE_API_URL".
- It doesn't touch `POST /livekit/token` (the multiplayer token service) or the database schema.

## 3. `FreshCall` hands over the existing microphone track

Vowe never opens a microphone. It listens to the track `CallService` already publishes when the person
unmutes, and only while it's on. Muting stops Vowe hearing, and Vowe joining never unmutes anyone.

`CallService` keeps its `Room` private, so it needs **one small getter** (the UI agent owns
`src/renderer/calls/service.ts`):

```ts
// src/renderer/calls/service.ts, in CallService
import { Track } from 'livekit-client';

/** Your published microphone track while it's on, else null. Never opens one. */
microphoneTrack(): MediaStreamTrack | null {
  return this.room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack ?? null;
}
```

`CallVoice` asks for it whenever the call snapshot says `micEnabled`, and taps it with an `AudioWorklet`.
The tap is analysis only: it outputs nothing, so the person doesn't hear themselves. It re-taps when LiveKit
replaces the track, for example after a new device or unmuting again. It stops tapping on mute, leave or
disconnect. No `getUserMedia` call is made, and the OS prompt is still triggered only by
`CallService.setMicrophoneEnabled`.

The worklet is loaded with `audioWorklet.addModule(new URL('./microphone-worklet.js', import.meta.url))`, from
the same origin as the renderer. `script-src 'self'` therefore covers it. If the renderer is ever bundled,
`dist/renderer/voice/microphone-worklet.js` must ship next to `microphone.js`. Separately, the LiveKit
`connect-src` change from `src/renderer/calls/INTEGRATION.md` §2 is still required.

## 4. The orb starts and stops Vowe, and shows its state

Make one `CallVoice` per call in `FreshCall`, once the call is connected:

```ts
import { CallVoice } from '../../voice/call-voice.js';

const voice = new CallVoice({
  api: window.journey,                       // needs .agent and .voice
  roomId,
  localUser: { userId: me.id, name: me.name }, // the cloud user signed in here
  canvas: () => canvasSnapshot(),            // CanvasSnapshot v1 (src/assistant/canvas.ts), read at each question
  call: calls,                               // the CallService: onChange(snapshot) gives micEnabled and isSpeaking
  microphone: () => calls.microphoneTrack(), // §3
  onEvent: (event) => { /* §6 canvas, approvals, captions, errors */ },
});
```

- **Orb click while off:** `await voice.start()`.
  - It resolves with `VoiceStatus` once `vowe:<you>` is in the call and hearing you.
  - It rejects with a message to show the person: not a member, a viewer, no `VOWE_API_URL`, no speech
    credentials, or LiveKit unreachable.
  - `start()` must come from a click, because an `AudioContext` needs a user gesture to run.
- **Orb click while on:** `await voice.stop()`.
- **Leaving the call:** call `voice.stop()` before `calls.leave()`. Main also stops it by itself when you leave
  the LiveKit room, sign out or quit.
- **Your own Vowe's state**, for the orb and call bar: subscribe to
  `window.journey.voice.onStatus((s) => …)`.
  - `s.status`: `off | joining | on | failed`.
  - `s.state`: `listening | thinking | speaking`. It maps one-to-one onto `AgentState` in
    `features/room/types.ts`. `holding` is never used.
  - `s.error`: show this when the status is `failed`, or after a speech hiccup while on.
  - Example: `voweCls: 'vowe-btn ' + s.state`, `agentLabel: { listening: 'Listening', thinking: 'Thinking', speaking: 'Speaking' }[s.state]`.
  - `CallVoice` releases itself when main reports `off` or `failed`.
- **Other people's Vowes:** they are participants whose identity starts with `vowe:` (`isVoweVoice` in
  `shared/vowe-voice.ts`), with LiveKit `kind === AGENT`.
  - `CallService` lists them in `participants` today. The people list should filter them out and show them as
    "Vowe (for X)".
  - Their live state is the `state` attribute. `CallParticipant` doesn't carry attributes yet, so `CallService`
    should add `attributes` (or `voweState`). It updates on `RoomEvent.ParticipantAttributesChanged`.
  - `CallService` already plays every remote audio track, which includes every Vowe's voice. Nothing more is
    needed to hear them.
- **Captions:**
  - Your words come from `voice.onSpeech(({ speech }) => …)`, where `speech.final === false` while you're still
    talking.
  - Vowe's sentences come from `voice.onSaid(({ text }) => …)`, as each one starts playing.
  - The runtime's text stream comes through `onEvent` `text.delta`.

Interruption needs no UI:

- **You talk over your own Vowe:** main detects sustained voice on your mic, silences it in about 0.2–0.3 s,
  and the adapter cancels the turn and its model request.
- **Someone else talks over it:** `CallVoice` sees LiveKit's active speaker in the `CallService` snapshot and
  does the same, in about 0.6 s.
- **Another Vowe is speaking:** this never interrupts.

## 5. How the adapter calls the reasoning runtime

`CallVoice.start()` constructs the runtime's own `VoiceAdapter(agentOverIpc(window.journey.agent), { roomId,
localUser, canvas, output, onEvent })`. Neither the adapter nor the runtime is copied or changed.

- Main's `Hearing` turns your speech into the adapter's `HumanSpeech`.
  - An utterance addressed to Vowe is normalized to `"Vowe, <question>"` with `addressed: true`, so the adapter's
    wake pattern always matches, even though Scribe writes the name as "Voe", "Vow" or "Whoa".
  - Other finals carry `addressed: false`. They go into `recentTurns` as context and start no turn.
  - "Vowe?" followed by the question counts as one address, within 6 s.
- The adapter sends `agent.ask({ roomId, participant: you, question, recentTurns, canvas, source: 'voice' })`.
  The runtime authorizes only the person signed in on that machine, with their own model sign-in. Nobody's
  question ever reaches another person's model access.
- Errors such as `not-signed-in`, `usage-limit` and `not-allowed` come back as `turn.failed` through `onEvent`.
  Show them to that person only. Nothing is spoken.
- The adapter's `VoiceOutput` goes to main as `voice:begin/say/end/cancel`. Main splits the streamed text into
  sentences and starts speaking the first one while the rest is still streaming.

**Known mismatches with the runtime's interfaces:**

1. **The cancel reason is lost.** `agentOverIpc.cancel(reason)` drops `reason`, because `agent:cancel` takes only
   a turn id. A spoken interruption therefore arrives as `turn.cancelled` with `reason: 'cancelled'`, not
   `'interrupted'`. To fix it, add an optional reason to `agent:cancel` in the runtime.
2. **The adapter cancels on any `hear()` while busy.** `CallVoice` therefore feeds other people's speech only
   while your Vowe is **speaking**. While it is thinking, people talking among themselves would otherwise
   cancel your question.
3. **There is no voice floor yet.** Two people's Vowes can speak at once. The runtime's §6 #4 proposes a
   `vowe:speaking` room event, which needs multiplayer's `RoomEvents`.
4. **Approvals in voice turns.** A turn that needs `approval.requested` waits until
   `window.journey.agent.approve(id, ok)` is called. The call UI must show that prompt, or the voice turn stalls.

## 6. Canvas actions into the canvas engine

The runtime emits `{ type: 'canvas.command', turnId, command }`, already validated against the asker's
snapshot (`validateCanvasCommand` in `src/assistant/canvas.ts`, schema in `src/assistant/contracts/`). It reaches
the asker's renderer through `CallVoice`'s `onEvent`:

```ts
onEvent: (event) => {
  if (event.type === 'canvas.command') canvasEngine.propose(event.command); // a suggestion until a person keeps it
  if (event.type === 'approval.requested') showApproval(event);              // then window.journey.agent.approve(...)
  if (event.type === 'turn.failed') showToMeOnly(event.error.message);
}
```

**Missing pieces:**

- **Relaying to everyone else in the room (not built yet).** The intended path is multiplayer's `RoomEvents`
  with a `'vowe:canvas': { command }` event, validated in main with `canvasCommandSchema` both ways (runtime
  INTEGRATION.md §6 #4). Voice doesn't publish data over LiveKit (`canPublishData: false`) on purpose.
- **Applying commands.** No canvas engine applies `CanvasCommand` today. That is the canvas owner's job, and
  there's no apply/decline acknowledgement yet (§6 #5).

## 7. Local Vowe API: start and configure

The app's `.env`:

```
VOWE_API_URL=http://localhost:8080   # required for voice
SUPABASE_URL=…                       # as today
SUPABASE_PUBLISHABLE_KEY=…
# the asker's model: one of these (runtime INTEGRATION.md)
VOWE_AGENT_PROVIDER=openai           # with OPENAI_API_KEY, or anthropic with ANTHROPIC_API_KEY
# ChatGPT plan sign-in stays off (VOWE_CHATGPT_PLAN) until eligibility is settled
```

The API's env (`server/.env.example`, or the root `.env` when run with `pnpm api:start`):

```
SUPABASE_URL=…  SUPABASE_PUBLISHABLE_KEY=…          # verifies sessions, checks membership under RLS
LIVEKIT_URL=wss://<project>.livekit.cloud  LIVEKIT_API_KEY=…  LIVEKIT_API_SECRET=…
ELEVENLABS_API_KEY=…                                # STT (Scribe realtime) and TTS
ELEVENLABS_AGENT_ID=…                               # Vowe's voice is the one configured on this agent
VOWE_VOICE_ID=…  VOWE_TTS_MODEL=…                   # optional: override the agent's voice and model
```

Then run `pnpm api:start`, which builds `server/` and listens on `:8080`.

- **STT:** the app gets a single-use Scribe realtime token from `POST /vowe/speech-token` and streams 16 kHz PCM
  to ElevenLabs directly, with `enable_logging=false`.
- **TTS:** `POST /vowe/speech` streams PCM back. The ElevenLabs key never leaves the API. Interrupting closes
  the request, and the API aborts the upstream request.
- **Billing:** speech is billed to Vowe's ElevenLabs account, never to anyone's ChatGPT plan or model key.
  Model calls are billed to the person who asked.
- **Without `VOWE_API_URL`:** main can use `ELEVENLABS_API_KEY` from the app's `.env` for speech, for local
  development only. It still can't get a seat without the API.
- **Privacy:** no audio is recorded or stored. Each app transcribes only its own person's microphone.

## 8. Tests: scripted versus real

| Test | Run | Model | LiveKit | Speech |
|---|---|---|---|---|
| Unit tests: `src/voice/*.test.ts`, `src/renderer/voice/call-voice.test.ts` | `pnpm test` | none (fake IPC) | fake transport | scripted recognizer, fake synthesizer |
| `server/src/vowe-voice.test.ts` (grants, identity, member and viewer checks) | `pnpm --filter vowe-api test` | none | real token signing | none |
| `scripts/voice-e2e/run.mjs` | `pnpm test:voice` (Docker, ElevenLabs key) | **real runtime (`Collaborator`) with a scripted model**: the eval mock for tool and canvas calls, scripted answers streamed word by word. John has no sign-in, so he exercises `not-signed-in`. | **real** (local LiveKit server in Docker) | **real** ElevenLabs Scribe and TTS |
| `scripts/voice-e2e/speech-smoke.mjs` | `pnpm test:speech` | none | none | real ElevenLabs |
| `scripts/voice-e2e/api-speech-check.mjs` | `node …` after `pnpm api:build` | none | none | real ElevenLabs through the real `speak()` handler. Only the Supabase session is stubbed. |
| `scripts/voice-e2e/electron-check-run.mjs` | `node …` (Docker) | none | real, from Electron's main process | none |

Not covered by any test:

- a real model provider
- a real Supabase sign-in and RLS path end to end
- the production UI
- two separate machines
- a real microphone through WebRTC echo cancellation

**Status at `8f7bc69`:**

- Typecheck passes.
- Unit tests pass: 21 for voice and 8 for the server.
- The last full `pnpm test:voice` passed 13 of 15. The two failures, "answers aloud" and "everyone sees the
  state", were checking too early: 0.5 s after the text finished streaming, while about 15 s of the answer was
  still playing. Both checks have been rewritten to wait for playback to end, and now also verify that
  interruptions return the state to `listening` and that nothing of an interrupted answer is spoken. They
  haven't been rerun.
- First sound arrived 3.06 s after the person stopped talking. `test:voice` now prints a stage-by-stage
  breakdown. The expected contributors are:
  - Scribe's end-of-speech detection (0.6 s of silence)
  - the 350 ms settle
  - the scripted model at 45 ms per word to the end of the first sentence
  - time to the first TTS byte

## 9. Remaining dependencies and risks

**Dependencies:**

- **UI integration (top-left agent):**
  - §3: the `CallService.microphoneTrack()` getter.
  - §4: the orb's start, stop and state, filtering out and labelling `vowe:` participants, and exposing
    participant attributes.
  - Captions.
  - The approval prompt for voice turns.
- **Multiplayer:** the `vowe:canvas` relay and `vowe:speaking` floor over `RoomEvents`. Also merge conflicts with
  PR #10 in the shared IPC files.
- **Canvas:** apply `CanvasCommand` as suggestions, plus an acknowledgement.
- **Runtime:** a cancel reason over `agent:cancel` (§5, item 1).
- **Product:** ChatGPT plan eligibility (`VOWE_CHATGPT_PLAN` stays off).
- **Deployment:** the Vowe API, with `LIVEKIT_*` and `ELEVENLABS_*`, reachable at `VOWE_API_URL`. The Edge
  Function has no Vowe routes.

**Risks:**

- **ElevenLabs concurrency.** The account allows 5 concurrent requests. Each active Vowe holds one Scribe stream,
  plus up to 2 TTS requests while speaking, so the limit is shared by everyone's Vowe.
- **Echo.** Vowe's voice reaching a person's microphone is handled by WebRTC echo cancellation, and by ignoring
  short sounds while Vowe speaks. This hasn't been tested with real speakers.
- **False interruptions.** LiveKit's active speaker can fire on background noise, and when it does, it cuts
  Vowe off.
- **Electron.** The LiveKit native module (`@livekit/rtc-node`) loads in main. It is lazy-imported when Vowe is
  first brought in. `electron-check.mjs` confirms that it loads, but the script hasn't been rerun since this
  change.
