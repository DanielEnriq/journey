# Calls: UI integration

`CallService` (`service.ts`) is a room's voice call between people, on LiveKit. It runs in the renderer, keeps the
microphone closed until someone turns it on, and plays everyone else's audio. It renders nothing, so connecting
it to the room screen is the UI's job.

Room data sources, `FreshCall`, the shell and `vowe.html` belong to the UI integration branch. This branch
(`feat/mvp-livekit-calls`) doesn't edit them. The four steps below are the changes to make there.

```
FreshCall ── mic button ──▶ CallService.setMicrophoneEnabled ──▶ OS prompt ──▶ LiveKit publish
    │                            │
    └─ onJoin ─▶ CallSession ─▶ realWorkspace.call.join ─▶ rooms.join (presence)
                                                         └▶ CallService.join ─▶ calls.access (IPC)
                                                                                  └▶ token service ─▶ { url, token }
```

## 1. Configure tokens

The app never holds the LiveKit secret. `window.journey.calls.access(roomId)` goes to main, which checks you're
a member of the room (`rooms.getRoom`). It then asks one of two token services, and both verify the caller's
Supabase session and their `room_members` row under RLS before issuing a token:

| Token service | When | Where its LiveKit credentials live |
|---|---|---|
| Vowe API `POST /livekit/token` (`server/src/livekit.ts`) | The app's `.env` sets `VOWE_API_URL` | The API's env: `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (`server/.env.example`) |
| `livekit-token` Edge Function (`supabase/functions/livekit-token`) | `VOWE_API_URL` unset | `pnpm exec supabase secrets set LIVEKIT_URL=… LIVEKIT_API_KEY=… LIVEKIT_API_SECRET=…`, then `pnpm cloud:functions` |

The app itself needs `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and optionally `VOWE_API_URL`. It never needs
`LIVEKIT_*`.

Locally: put `LIVEKIT_*` in the root `.env`, run `pnpm api:start`, and set `VOWE_API_URL=http://localhost:8080`.

Each token is issued as the caller's identity (their cloud user id), for `room:<roomId>` only, can publish the
microphone only (no camera, screen or data), and is valid for 10 minutes to join. LiveKit refreshes it for a
call in progress. A refusal comes back as a rejected `join()`: `Could not join the call: Join the room before its call`
(not a member) or `… Not signed in`.

## 2. Allow LiveKit in `vowe.html`'s CSP (required)

`vowe.html` has `connect-src 'self'`, which blocks LiveKit's websocket. Without this change, `join()` fails in the
real app with a CSP error:

```html
connect-src 'self' https://*.livekit.cloud wss://*.livekit.cloud
```

That's the same allowance `index.html` has. For self-hosted LiveKit, add its host instead. A local dev server
would need `ws://127.0.0.1:7880 http://127.0.0.1:7880`, which belongs in development builds only.

Microphone permission needs nothing more: `restrictPermissions` (`main/window.ts`) already lets `vowe.html`
capture audio and refuses camera and screen.

## 3. Wire the real workspace's `call` source

Create one service for the window, next to `realWorkspace`, only where the preload bridge exists (not in the
preview):

```ts
import { CallService } from '../../../calls/service.js';
export const calls = new CallService(window.journey.calls);
```

Then in `features/workspace/real/workspace.ts`, keep presence and record logging, and add audio:

```ts
const call: CallDataSource = {
  async join(roomId) {
    const session = await api().rooms.join(roomId);   // presence, as today
    selfId = session.selfId;
    presence.set(roomId, session.participants);
    try {
      await calls.join(roomId);                        // audio: resolves connected, mic off
    } catch (err) {
      await api().rooms.leave(roomId).catch(() => {}); // don't show presence for someone not in the call
      presence.delete(roomId);
      throw err;                                       // CallSession shows err.message as `failed`
    }
    await unwrap(api().record.call(roomId, 'call-started')).catch(() => {});
    await changed(roomId);
  },
  async leave(roomId) {
    await calls.leave();
    // …then record 'call-left', rooms.leave(roomId), presence.delete, changed, as today
  },
  setMuted: (muted) => void calls.setMuted(muted).catch(() => {}), // the reason lands in calls.snapshot.error
  setCaptions: () => {},                                           // no Vowe voice or captions yet
};
```

In `app.tsx`, have `CallSession` follow the connection, and leave on sign-out:

```ts
calls.onEvent((e) => {
  if (e.type === 'dropped') realSession.drop();                       // shows the Dropped banner; Rejoin → onJoin
  if (e.type === 'ended' && e.reason) void realSession.leave();       // removed, closed, or joined from elsewhere
});
// wherever auth changes are handled: if (!user) void calls.leave();
```

Rejoin through the existing `onJoin` → `session.join(id)` path works as it is: `calls.join` over a dropped call
starts fresh with a new token, muted. `calls.reconnect()` does the same thing for code that doesn't go through
`CallSession`.

## 4. Wire `FreshCall`

Read the service's state, rather than keeping a local `useState(true)` for `muted`:

```ts
function useCall(service: CallService) {
  const [snap, setSnap] = useState(service.snapshot);
  useEffect(() => service.onChange(setSnap), [service]);
  return snap;
}

const snap = useCall(calls);
const live = snap.status === 'connected';
const muted = !snap.micEnabled;
```

In the `CallControls` object:

```ts
micCls: 'cbtn' + (muted ? ' muted' : ''),
micLabel: snap.micPending ? 'Starting microphone…' : !live ? 'Reconnecting…' : muted ? 'Unmute' : 'Mute',
muted,
micDown: () => {},
micUp: () => { if (live && !snap.micPending) void calls.setMicrophoneEnabled(muted).catch(() => {}); },
```

- **`voiceOff` no longer disables the mic.** It stays true only for Vowe's voice and captions, which aren't in this
  branch. Today `CallControls.voiceOff` turns off Vowe, the mic and captions together, so the mic needs its own
  condition, or `voiceOff` needs to cover only the agent.
- **Show the mic error** (`snap.error`) near the bar, for example the OS refusal ("Vowe can’t use the microphone.
  Allow it in your system’s privacy settings…").
- **Overlay speaking and mute state on the people in the call.** Look up `snap.participants` by
  `identity === person.userId` (the cloud user id) to get `isSpeaking`, `isMuted`, and `connection: 'lost'`.
- **Show `reconnecting` in place.** Keep the canvas and dim the bar. LiveKit usually recovers within seconds, and
  `reconnected` follows.
- **`audioBlocked`**: if it's ever true, show a button that calls `calls.startAudio()` from the click.

Leave calls `calls.leave()` through `onLeave` → `CallSession.leave` → `call.leave`, which stops the microphone
and playback.

## API reference

| Member | Does |
|---|---|
| `new CallService(window.journey.calls, options?)` | `options.createRoom` and `options.audio` are for tests. |
| `snapshot: CallSnapshot` | Current state. |
| `onChange(fn) → unsubscribe` | Called with every snapshot, starting with the current one. |
| `onEvent(fn) → unsubscribe` | One-off moments, for toasts or activity. |
| `join(roomId)` | Token (members only), then connect. **Resolves connected with the mic off.** Rejects with a message you can show the person. Calling it again for the same call does nothing. Joining another room leaves this one. |
| `setMicrophoneEnabled(on)` | `true`: OS permission, then publish. `false`: mute and release the device, so the OS indicator turns off. Rejects with `MICROPHONE_DENIED` or `Microphone unavailable: …`, and the call carries on. Throws `Not in a call` unless `status === 'connected'`. |
| `setMuted(muted)` | `setMicrophoneEnabled(!muted)`. |
| `reconnect()` | After `dropped`: rejoins the same room, muted. |
| `leave()` | Disconnects, stops the mic and playback, and forgets a dropped call. |
| `startAudio()` | From a click, when `audioBlocked`. |

```ts
interface CallSnapshot {
  status: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'dropped';
  roomId: string | null;           // kept while dropped
  participants: CallParticipant[]; // you first; empty unless connected/reconnecting
  micEnabled: boolean;             // false after every join and rejoin
  micPending: boolean;             // OS prompt / device opening in flight
  audioBlocked: boolean;
  error: string | null;            // why it ended or dropped, or why the mic failed; cleared by the next join
}

interface CallParticipant {
  identity: string;                // cloud user id = Participant.userId from rooms.join
  name: string | null;
  avatarUrl: string | null;
  isLocal: boolean;
  isSpeaking: boolean;
  isMuted: boolean;                // muted, or never turned the mic on
  connection: 'excellent' | 'good' | 'poor' | 'lost' | 'unknown';
}

type CallEvent =
  | { type: 'participant-joined'; participant: CallParticipant } // people already there when you join aren't events
  | { type: 'participant-left'; identity: string; name: string | null }
  | { type: 'reconnecting' } | { type: 'reconnected' }            // LiveKit recovering on its own
  | { type: 'dropped'; roomId: string; reason: string }           // gave up: offer Rejoin
  | { type: 'ended'; roomId: string; reason: string | null };     // left (null), removed, room closed, joined elsewhere
```

Identities are user ids, so joining the same call from a second window or device ends the first with
`ended` / "You joined this call from another window or device."

## Verifying

- `pnpm test`: the service's lifecycle against a fake room.
- `pnpm --filter vowe-api test`: token issuance (no session, a bad room id, a non-member, the grants).
- `pnpm test:calls`: a local LiveKit server in Docker and two Electron clients with Chromium's fake microphone.
  It checks that audio decodes on the other side through mute, unmute, both directions, reconnect, and leave.
  Docker must be running.
- Manually, after steps 2–4: sign in as two different people on two machines, both members of one room, and
  join its call. Nobody is heard until they unmute, and then each hears the other.

## Not in this branch

- Vowe's AI voice agent in the call (ElevenLabs). `VoiceAgentProvider` stays separate, and captions remain a no-op.
- Input and output device pickers. LiveKit uses the system defaults.
- Automatic retry after a hard drop. LiveKit's own reconnect covers network blips (`reconnecting`), and a call
  that drops for good waits for Rejoin.
