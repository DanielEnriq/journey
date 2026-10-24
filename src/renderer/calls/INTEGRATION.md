# Calls: UI integration

`CallService` (`service.ts`) is a room's voice call between people, on LiveKit. It runs in the renderer, keeps the
microphone closed until someone turns it on, and plays everyone else's audio. It renders nothing, so connecting
it to the room screen is the UI's job.

Room data sources, `FreshCall`, the shell and `vowe.html` belong to the UI integration branch. This branch
doesn't edit them. The snippets below are what to add there.

## Create one per window

```ts
import { CallService } from '../calls/service.js'; // adjust the relative path

const calls = new CallService(window.journey.calls); // only where the preload bridge exists (not the preview)
```

One call at a time: `join(other)` leaves the current call first. Leave on sign-out, because the token outlives it:
`auth.onChange((user) => { if (!user) void calls.leave(); })`.

## API

| Member | Does |
|---|---|
| `snapshot: CallSnapshot` | Current state (below). |
| `onChange(fn) → unsubscribe` | Called with every snapshot, starting with the current one. |
| `onEvent(fn) → unsubscribe` | One-off moments for toasts or activity (below). |
| `join(roomId)` | Fetches a token (members only), connects, and **resolves muted**. Rejects with a message you can show the person (`Could not join the call: Join the room before its call`). Calling it again for the same call does nothing. |
| `setMicrophoneEnabled(on)` | `true` asks the OS for permission (macOS prompts the first time), then publishes the microphone. `false` mutes it and releases the device, so the OS indicator turns off. Rejects with a message you can show the person (`MICROPHONE_DENIED`, `Microphone unavailable: …`), and the call carries on either way. Throws `Not in a call` unless `status === 'connected'`. |
| `setMuted(muted)` | `setMicrophoneEnabled(!muted)`. |
| `reconnect()` | After `status === 'dropped'`: rejoins the same room with a new token, **muted**. |
| `leave()` | Disconnects, stops the microphone and playback, and forgets a dropped call. |
| `startAudio()` | Call it from a click when `audioBlocked` is true. |

### `CallSnapshot`

```ts
status: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'dropped';
roomId: string | null;          // kept while dropped, for reconnect()
participants: CallParticipant[]; // you first; empty unless connected/reconnecting
micEnabled: boolean;             // false after every join and rejoin
micPending: boolean;             // permission prompt / device opening in flight: disable the button
audioBlocked: boolean;
error: string | null;            // why it ended, dropped, or the mic failed. Cleared by the next join
```

`CallParticipant`: `{ identity, name, avatarUrl, isLocal, isSpeaking, isMuted, connection }`. `identity` is the
cloud user id, the same as `Participant.userId` from `rooms.join`, so it maps directly onto room members. `connection` is `'excellent' | 'good' | 'poor' | 'lost' | 'unknown'`.

### `CallEvent`

```ts
| { type: 'participant-joined'; participant: CallParticipant }
| { type: 'participant-left'; identity: string; name: string | null }
| { type: 'reconnecting' } | { type: 'reconnected' }   // LiveKit recovering on its own; audio pauses meanwhile
| { type: 'dropped'; roomId; reason }                  // gave up; offer "Rejoin" → reconnect()
| { type: 'ended'; roomId; reason: string | null }      // left (reason null), removed, room closed, or joined elsewhere
```

People already in the call when you join show up in `snapshot.participants`, not as `participant-joined` events.

## Connecting the real workspace's `CallDataSource`

`CallDataSource` (`features/room/data/sources.ts`) already fits. In `features/workspace/real/workspace.ts`,
keep the Realtime presence and record logging, and add audio:

```ts
const call: CallDataSource = {
  async join(roomId) {
    const session = await api().rooms.join(roomId);    // presence, as today
    selfId = session.selfId;
    presence.set(roomId, session.participants);
    await calls.join(roomId);                           // audio: resolves connected and muted
    await unwrap(api().record.call(roomId, 'call-started')).catch(() => {});
    await changed(roomId);
  },
  async leave(roomId) {
    await calls.leave();
    // …record 'call-left', rooms.leave(roomId), presence.delete, changed, as today
  },
  setMuted: (muted) => void calls.setMuted(muted).catch(() => {}), // the failure is in calls.snapshot.error
  setCaptions: () => {},                                           // Vowe's voice isn't part of this branch
};
```

If `calls.join` rejects after `rooms.join` succeeded, call `rooms.leave(roomId)` so presence doesn't show
someone who isn't in the call. `CallSession` in `features/call/session.ts` already turns a rejection into
`status: 'failed'`.

To draw the call bar, subscribe with `calls.onChange` and map:

| Snapshot | UI |
|---|---|
| `status === 'reconnecting'` | "Reconnecting…", keep the canvas |
| `status === 'dropped'` | `CallSession.drop()`'s "dropped" state, with Rejoin → `calls.reconnect()` |
| `micEnabled` / `micPending` | Mic button on/off/busy. It starts off; the person turns it on |
| `participants[i].isSpeaking` / `isMuted` | Speaking ring and muted badge |
| `error` | Inline under the bar |

## Required: let the page reach LiveKit

`vowe.html`'s CSP is `connect-src 'self'`, which blocks LiveKit's websocket, so `join` fails with a CSP error
in the real app. Change it to the same allowance `index.html` has:

```
connect-src 'self' https://*.livekit.cloud wss://*.livekit.cloud
```

Self-hosted LiveKit or the local dev server would also need `ws://127.0.0.1:7880 http://127.0.0.1:7880`
(dev only).

Nothing else is needed: microphone permission (`restrictPermissions` in `main/window.ts`) already allows
`vowe.html` to capture audio and nothing else.

## Not here

- Vowe's AI voice agent in the call (ElevenLabs). `VoiceAgentProvider` stays separate, and captions remain a no-op.
- Device pickers (input/output selection). LiveKit uses the system defaults.
- Automatic retry after a hard drop. LiveKit's own reconnect covers network blips (`reconnecting`), and a call
  that drops for good waits for `reconnect()`.
