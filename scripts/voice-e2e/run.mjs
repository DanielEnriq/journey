// pnpm test:voice: Vowe's voice end to end, on a real LiveKit server with real speech and the real
// runtime.
//
// Starts a throwaway LiveKit server in Docker (dev keys, localhost only). Two people, Daniel and John,
// join the room's call with the same grants as POST /livekit/token, each publishing a microphone. Each
// runs what their app runs, in process, with the IPC bridge replaced by direct calls:
//   - main: VoiceHost (their own Vowe, `vowe:<user id>`, seated with POST /vowe/token's grant; ElevenLabs
//     Scribe on their own microphone, ElevenLabs text-to-speech, LiveKit publishing) and the runtime's
//     Collaborator (src/assistant), with its tools over the eval's synthetic payments repository
//   - renderer: CallVoice, i.e. the runtime's VoiceAdapter + agentOverIpc, fed by the call's participants
//
// People's speech is real audio, made with ElevenLabs once at the start. It goes out to the call and into
// the speaker's own speech recognition, which is what the app's microphone tap does.
//
// The one thing not real is the model: there are no model credentials here, so Daniel's runtime uses the
// eval's mock (scripts/agent-eval/mock.mjs) for its tool and canvas calls, with scripted answers streamed
// word by word and honoring cancellation. John's runtime has no model sign-in at all.
//
// Needs Docker, `pnpm build && pnpm api:build`, and ELEVENLABS_API_KEY + ELEVENLABS_AGENT_ID in .env.
// LIVEKIT_E2E_URL=ws://… with LIVEKIT_API_KEY/LIVEKIT_API_SECRET runs against another server instead.

import { execFileSync } from 'node:child_process';
import { AudioFrame, AudioSource, AudioStream, LocalAudioTrack, Room, RoomEvent, TrackPublishOptions, TrackSource, dispose } from '@livekit/rtc-node';
import { RoomServiceClient } from 'livekit-server-sdk';
import { issueToken } from '../../server/dist/livekit.js';
import { voweToken } from '../../server/dist/vowe-voice.js';
import { Collaborator } from '../../dist/assistant/index.js';
import { ModelProviderError } from '../../dist/assistant/provider.js';
import { reasoningTools, roomTools } from '../../dist/assistant/room-tools.js';
import { workContextTools } from '../../dist/assistant/tools.js';
import { grepTracked, readTrackedFile } from '../../dist/git/index.js';
import { CallVoice } from '../../dist/renderer/voice/call-voice.js';
import { rms } from '../../dist/voice/hearing.js';
import { VoiceHost } from '../../dist/voice/host.js';
import { LiveKitTransport } from '../../dist/voice/livekit.js';
import { ElevenLabsRecognizer, ElevenLabsSynthesizer, agentVoice } from '../../dist/voice/providers/elevenlabs.js';
import { canvas, createFixtureRepo, room } from '../agent-eval/fixture.mjs';
import { mockProvider } from '../agent-eval/mock.mjs';

process.loadEnvFile(new URL('../../.env', import.meta.url));
const IMAGE = 'livekit/livekit-server:v1.9.1';
const NAME = 'vowe-voice-e2e';
const external = process.env.LIVEKIT_E2E_URL;

const ROOM = '0b7c6c4e-55d2-4d0f-9f53-0d0b8a3ef0a1';
const DANIEL = { userId: '11111111-1111-4111-8111-111111111111', name: 'Daniel' };
const JOHN = { userId: '22222222-2222-4222-8222-222222222222', name: 'John' };
/** A premade ElevenLabs voice for the people, so they don't sound like Vowe. */
const PERSON_VOICE = 'JBFqnCBsd6RMkjVDRZzb';

const ANSWERS = [
  [/crash/i, 'If the worker crashes after charging but before it acknowledges the job, the lease runs out after thirty seconds. The queue then hands the same job to another worker. That worker charges the card again, because nothing tells the processor it is the same payment. So the customer pays twice.'],
  [/retry|step/i, 'First the worker leases the job from the queue. Then it charges the card through the processor. Then it marks the order paid. Only after that does it acknowledge the job. If anything stops it before the acknowledgement, the lease expires, and the whole sequence runs again from the top, including the charge. '.repeat(2)],
  [/fix/i, 'The simplest fix is an idempotency key on the charge, derived from the order. The processor then treats a second charge for the same order as the first one. You could also record the charge before calling the processor, and check for it on a retry. Either way, the retry stops being a second payment. '.repeat(2)],
];

const t0 = Date.now();
const log = (...args) => console.log(`[${((Date.now() - t0) / 1000).toFixed(2).padStart(6)}s]`, ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
async function until(cond, ms) {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) return false;
    await sleep(20);
  }
  return true;
}
function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// ─── The model: the eval's mock for tools and canvas, with scripted spoken answers ────────────────

function scriptedModel() {
  const mock = mockProvider();
  const model = {
    requests: 0,
    aborted: 0,
    id: 'scripted',
    name: 'Scripted model (voice e2e)',
    billing: 'api-key',
    model: 'scripted',
    isConfigured: () => true,
    async complete(request) {
      model.requests++;
      const response = await mock.complete({ ...request, onTextDelta: undefined });
      if (!response.items.some((i) => i.type === 'assistant')) return response; // a tool step
      const asked = [...request.items].reverse().find((i) => i.type === 'user' && !i.text.startsWith('[Vowe runtime]'))?.text.split('\n').at(-1) ?? '';
      const text = ANSWERS.find(([pattern]) => pattern.test(asked))?.[1] ?? 'I am not sure.';
      for (const word of text.split(/(?<= )/)) {
        await sleep(45);
        if (request.signal?.aborted) {
          model.aborted++;
          throw new DOMException('The model request was aborted', 'AbortError');
        }
        request.onTextDelta?.(word);
      }
      return { ...response, items: [{ type: 'assistant', text }] };
    },
  };
  return model;
}

/** John has no model sign-in: what the ChatGPT plan provider does when nobody has signed in. */
const signedOut = {
  id: 'chatgpt',
  name: 'ChatGPT',
  billing: 'chatgpt-plan',
  model: '',
  isConfigured: () => false,
  async complete() {
    throw new ModelProviderError('not-signed-in', 'Sign in with ChatGPT to ask Vowe.');
  },
};

// ─── One person's app ─────────────────────────────────────────────────────────

const repo = createFixtureRepo();
const work = {
  getWorkContext: async () => ({}),
  listWorkstreams: async () => [],
  listSessions: async () => [],
  getSessionMessages: async () => null,
  getWorktreeChanges: async () => null,
  async searchCode(_repo, _ws, terms, pathspec) {
    const matches = await grepTracked(repo, terms, { pathspec });
    return { root: repo, matches: matches.slice(0, 60), omitted: Math.max(0, matches.length - 60) };
  },
  readCode: (_repo, _ws, path, from, to) => readTrackedFile(repo, path, from, to),
};

/** Delivers like IPC: later, and as a copy. */
const later = (listeners, value) => setImmediate(() => listeners.forEach((l) => l(structuredClone(value))));

class App {
  constructor(who, provider, speech, url) {
    this.who = who;
    this.provider = provider;
    this.asked = [];
    this.events = [];
    /** When each stage of the speech pipeline happened, for the latency breakdown. */
    this.stages = [];
    const mark = (stage) => this.stages.push({ stage, at: Date.now() });
    this.collaborator = new Collaborator({
      provider: () => provider,
      work,
      tools: workContextTools,
      roomTools,
      reasoningTools,
      describeRepository: () => `Repository: payments, checked out at ${repo} on branch main.`,
      approve: async () => true, // the synthetic repository: nothing private to approve
      rooms: {
        source: { room: async () => room.details, members: async () => room.members, record: async () => room.record },
        checkout: async () => ({ repositoryId: 'eval-payments' }),
        localUser: async () => who.userId,
      },
    });
    this.host = new VoiceHost({
      self: async () => who,
      seat: async () => ({ url, token: await voweToken(ROOM, who.userId, who.name).toJwt() }),
      speech: async () => ({ recognizer: timedRecognizer(new ElevenLabsRecognizer(speech), mark), synthesizer: timedSynthesizer(new ElevenLabsSynthesizer(speech), mark) }),
      transport: (seat, owner) => new TimedTransport(seat, owner, mark),
    });
    const agent = new Set();
    const voice = { status: new Set(), speech: new Set(), said: new Set() };
    this.host.onEvent((e) => {
      if (e.type === 'status') later(voice.status, e.status);
      else if (e.type === 'speech') later(voice.speech, { roomId: e.roomId, speech: e.speech });
      else later(voice.said, { roomId: e.roomId, turnId: e.turnId, text: e.text });
      this.events.push({ ...e, at: Date.now() });
      if (e.type === 'speech' && e.speech.final) log(`  ${who.name} heard: "${e.speech.text}"${e.speech.addressed ? ' (to Vowe)' : ''}`);
      if (e.type === 'said') log(`  ${who.name}'s Vowe says: "${e.text}"`);
    });
    const subscribe = (set) => (l) => (set.add(l), () => set.delete(l));
    this.api = {
      agent: {
        ask: async (turn) => {
          mark('runtime asked');
          this.asked.push(turn);
          return { turnId: this.collaborator.ask(turn, (event) => later(agent, event)).turnId };
        },
        cancel: async (turnId) => this.collaborator.cancel(turnId),
        onEvent: subscribe(agent),
      },
      voice: {
        start: (roomId) => this.host.start(roomId),
        stop: () => this.host.stop(),
        status: async () => this.host.status,
        audio: async (roomId, bytes) => this.host.audio(roomId, new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))),
        begin: async (turnId) => this.host.begin(turnId),
        say: async (turnId, text) => (mark('text to voice'), this.host.say(turnId, text)),
        end: async (turnId) => this.host.end(turnId),
        cancel: async (turnId) => this.host.cancel(turnId),
        onStatus: subscribe(voice.status),
        onSpeech: subscribe(voice.speech),
        onSaid: subscribe(voice.said),
      },
    };
  }

  /** The renderer's side: CallVoice over the call as this person's LiveKit room sees it. */
  async bringInVowe(person) {
    this.voice = new CallVoice({
      api: this.api,
      roomId: ROOM,
      localUser: this.who,
      canvas: () => canvas,
      call: person.callSnapshots(),
      microphone: () => null, // the e2e feeds the microphone into speech recognition itself (Person.say)
      onEvent: (e) => {
        this.events.push({ type: 'agent', event: e, at: Date.now() });
        if (e.type === 'turn.started') log(`  ${this.who.name}'s runtime: turn ${e.turnId.slice(0, 8)} started (${e.provider.name}, billed: ${e.provider.billing})`);
        if (e.type === 'canvas.command') log(`  ${this.who.name}'s runtime: canvas ${e.command.type} ${JSON.stringify(e.command.payload).slice(0, 80)}`);
        if (e.type === 'turn.completed' || e.type === 'turn.cancelled' || e.type === 'turn.failed')
          log(`  ${this.who.name}'s runtime: ${e.type}${e.reason ? ` (${e.reason})` : ''}${e.error ? ` ${e.error.code}: ${e.error.message}` : ''}`);
      },
    });
    return this.voice.start();
  }

  /** The first time each stage happened after `since`. */
  firstStage(stage, since) {
    return this.stages.find((s) => s.stage === stage && s.at >= since)?.at;
  }

  agentEvents(type) {
    return this.events.filter((e) => e.type === 'agent' && e.event.type === type).map((e) => ({ ...e.event, at: e.at }));
  }
}

// ─── Timing the pipeline ─────────────────────────────────────────────────────

function timedRecognizer(inner, mark) {
  return {
    name: inner.name,
    open: (rate, onEvent) => inner.open(rate, (e) => (e.type === 'final' && e.text.trim() && mark('recognizer final'), onEvent(e))),
  };
}

function timedSynthesizer(inner, mark) {
  return {
    name: inner.name,
    async *synthesize(text, rate, signal) {
      mark('synthesis requested');
      let first = true;
      for await (const chunk of inner.synthesize(text, rate, signal)) {
        if (first) mark('first synthesized audio');
        first = false;
        yield chunk;
      }
    },
  };
}

class TimedTransport extends LiveKitTransport {
  constructor(seat, owner, mark) {
    super(seat, owner);
    this.mark = mark;
  }
  play(pcm) {
    this.mark('audio published');
    return super.play(pcm);
  }
}

// ─── One person in the call ───────────────────────────────────────────────────

/** A microphone fed from a queue of clips (silence in between) into the call and into their own speech recognition. */
class Person {
  constructor(who) {
    this.who = who;
    this.queue = [];
    this.heard = new Map(); // Vowe identity → [{ t, rms }] per 20 ms frame
    this.vowes = new Map(); // Vowe identity → participant as first seen
    this.states = new Map(); // Vowe identity → [{ state, at }] as shown in the call
  }
  async join(token, url, ownSpeech) {
    this.ownSpeech = ownSpeech;
    this.room = new Room();
    this.room.on(RoomEvent.ParticipantConnected, (p) => {
      if (p.identity.startsWith('vowe:')) this.vowes.set(p.identity, { kind: p.kind, name: p.name, attributes: { ...p.attributes } });
    });
    this.room.on(RoomEvent.TrackSubscribed, (track, _pub, p) => {
      if (!p.identity.startsWith('vowe:')) return;
      const frames = this.heard.get(p.identity) ?? [];
      this.heard.set(p.identity, frames);
      void (async () => {
        for await (const frame of new AudioStream(track, { sampleRate: 16000, numChannels: 1, frameSizeMs: 20 })) frames.push({ t: Date.now(), rms: rms(frame.data) });
      })().catch(() => {});
    });
    this.room.on(RoomEvent.ParticipantAttributesChanged, (changed, p) => {
      if (!p.identity.startsWith('vowe:') || !changed.state) return;
      this.states.set(p.identity, [...(this.states.get(p.identity) ?? []), { state: changed.state, at: Date.now() }]);
    });
    await this.room.connect(url, token, { autoSubscribe: true, dynacast: false });
    this.source = new AudioSource(16000, 1, 100);
    await this.room.localParticipant.publishTrack(LocalAudioTrack.createAudioTrack('mic', this.source), new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }));
    this.feeding = this.feed();
  }
  async feed() {
    const silence = new Int16Array(320);
    while (!this.left) {
      const next = this.queue.shift();
      next?.started?.();
      const data = next?.frame ?? silence;
      this.ownSpeech?.(data);
      await this.source.captureFrame(new AudioFrame(data, 16000, 1, data.length));
    }
  }
  /** Queues a clip; resolves when it starts going out. */
  say(clip) {
    return new Promise((resolve) => {
      for (let i = 0; i < clip.length; i += 320) this.queue.push(i === 0 ? { frame: clip.slice(i, i + 320), started: () => resolve(Date.now()) } : { frame: clip.slice(i, i + 320) });
    });
  }
  async saidAll() {
    while (this.queue.length) await sleep(20);
  }
  /** Seconds of clearly audible speech from a Vowe since `since`. */
  heardSeconds(identity, since = 0) {
    return (this.heard.get(identity) ?? []).filter((f) => f.t >= since && f.rms > 300).length * 0.02;
  }
  firstSoundAfter(identity, since) {
    return (this.heard.get(identity) ?? []).find((f) => f.t >= since && f.rms > 300)?.t;
  }
  /** When this person's call first showed a Vowe in `state` after `since`. */
  stateShown(identity, state, since) {
    return (this.states.get(identity) ?? []).find((s) => s.state === state && s.at >= since)?.at;
  }
  lastSound(identity) {
    return [...(this.heard.get(identity) ?? [])].reverse().find((f) => f.rms > 300)?.t ?? 0;
  }
  /** The call as CallService would report it: who's in it, and who LiveKit says is talking. */
  callSnapshots() {
    return {
      onChange: (listener) => {
        const emit = (speakers = []) => {
          const talking = new Set(speakers.map((p) => p.identity));
          const describe = (p, isLocal) => ({ identity: p.identity, name: p.name || null, avatarUrl: null, isLocal, isSpeaking: talking.has(p.identity), isMuted: false, connection: 'good' });
          listener({
            status: 'connected',
            roomId: ROOM,
            participants: [describe(this.room.localParticipant, true), ...[...this.room.remoteParticipants.values()].map((p) => describe(p, false))],
            micEnabled: false,
            micPending: false,
            audioBlocked: false,
            error: null,
          });
        };
        this.room.on(RoomEvent.ActiveSpeakersChanged, emit);
        emit();
        return () => this.room.off(RoomEvent.ActiveSpeakersChanged, emit);
      },
    };
  }
  async leave() {
    if (this.left) return;
    this.left = true;
    await this.feeding?.catch(() => {});
    await this.source?.close().catch(() => {});
    await this.room?.disconnect();
  }
}

async function clip(synth, text) {
  const parts = [];
  for await (const c of synth.synthesize(text, 16000, new AbortController().signal)) parts.push(c);
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
}

/** POST /livekit/token's real grant, for a caller RLS shows as a member of the room. */
function memberCaller(userId, name) {
  const supabase = {
    from(table) {
      const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: table === 'room_members' ? { room_id: ROOM, role: 'member' } : { name, avatar_url: null }, error: null }) };
      return q;
    },
  };
  return { userId, supabase };
}

// ─── The run ──────────────────────────────────────────────────────────────────

const env = {};
if (external) {
  env.url = external;
} else {
  try {
    docker('rm', '-f', NAME);
  } catch {}
  // Its own ports (not 7880–7882), so it can run beside the calls e2e. Media ports must match inside and
  // out, since they're advertised to clients as is.
  const config = 'port: 7980\nrtc:\n  tcp_port: 7981\n  udp_port: 7982\n  use_external_ip: false\nkeys:\n  devkey: secret\n';
  docker('run', '-d', '--rm', '--name', NAME, '-p', '127.0.0.1:7980:7980', '-p', '127.0.0.1:7981:7981', '-p', '127.0.0.1:7982:7982/udp',
    IMAGE, '--dev', '--bind', '0.0.0.0', '--node-ip', '127.0.0.1', '--config-body', config);
  env.url = 'ws://127.0.0.1:7980';
  process.env.LIVEKIT_API_KEY = 'devkey';
  process.env.LIVEKIT_API_SECRET = 'secret';
}
process.env.LIVEKIT_URL = env.url;

let exit = 1;
let firstSoundLatency = null;
const people = [];
const apps = [];
try {
  const http = env.url.replace(/^ws/, 'http');
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(http)).ok) break;
    } catch {}
    await sleep(500);
  }
  log(`LiveKit up at ${env.url}`);

  const apiKey = process.env.ELEVENLABS_API_KEY;
  const speech = { kind: 'key', apiKey, ...(await agentVoice(apiKey, process.env.ELEVENLABS_AGENT_ID)) };
  const personSynth = new ElevenLabsSynthesizer({ ...speech, voiceId: PERSON_VOICE });
  // One at a time: the ElevenLabs plan caps concurrent requests (5 here), and the call needs some of them.
  const lines = [];
  for (const text of [
    'Vowe, what happens if this crashes after charging?',
    'Vowe, walk me through the retry path, step by step.',
    'Vowe, so what would fix it?',
    'Wait, wait, hold on a second.',
    'Hang on, hang on, let me look at that.',
    'Vowe, what does the ledger do?',
  ])
    lines.push(await clip(personSynth, text));
  const [q1, q2, q3, wait, hangOn, johnQ] = lines;
  log('spoken lines ready');

  // 1. Two people join the call, each with their own app.
  const daniel = new Person(DANIEL);
  const john = new Person(JOHN);
  const danielApp = new App(DANIEL, scriptedModel(), speech, env.url);
  const johnApp = new App(JOHN, signedOut, speech, env.url);
  people.push(daniel, john);
  apps.push(danielApp, johnApp);
  await daniel.join((await issueToken(memberCaller(DANIEL.userId, DANIEL.name), { roomId: ROOM })).token, env.url, (frame) => danielApp.host.audio(ROOM, frame));
  await john.join((await issueToken(memberCaller(JOHN.userId, JOHN.name), { roomId: ROOM })).token, env.url, (frame) => johnApp.host.audio(ROOM, frame));
  check('1. Two people join a real LiveKit call', await until(() => daniel.room.remoteParticipants.has(JOHN.userId) && john.room.remoteParticipants.has(DANIEL.userId), 5000));

  // 2. Each brings in their own Vowe.
  await danielApp.bringInVowe(daniel);
  await johnApp.bringInVowe(john);
  const danielsVowe = `vowe:${DANIEL.userId}`;
  const johnsVowe = `vowe:${JOHN.userId}`;
  await until(() => john.vowes.has(danielsVowe) && daniel.vowes.has(johnsVowe), 5000);
  const seen = john.vowes.get(danielsVowe);
  check('2. Daniel’s Vowe joins as its own AI participant, speaking for him', seen?.kind === 4 && seen.name === 'Vowe (for Daniel)' && seen.attributes.kind === 'vowe' && seen.attributes.speaksFor === DANIEL.userId,
    seen ? `identity ${danielsVowe}, name "${seen.name}", kind ${seen.kind} (4 = agent), attributes ${JSON.stringify(seen.attributes)}` : 'not seen');
  const voweRoom = danielApp.host['session'].transport.room;
  const vowePublications = john.room.remoteParticipants.get(danielsVowe)?.trackPublications.size;
  const danielPublications = john.room.remoteParticipants.get(DANIEL.userId)?.trackPublications.size;
  const subscribed = [...voweRoom.remoteParticipants.values()].flatMap((p) => [...p.trackPublications.values()]).filter((t) => t.subscribed).length;
  check('   Vowe never touches a person’s microphone, and can’t listen to the call', vowePublications === 1 && danielPublications === 1 && voweRoom.remoteParticipants.size >= 2 && subscribed === 0,
    `Daniel publishes ${danielPublications} track (his microphone), his Vowe ${vowePublications} (its voice); Vowe sees ${voweRoom.remoteParticipants.size} participants and is subscribed to ${subscribed} tracks`);

  // 3–6, 8. Daniel asks; his runtime answers aloud, streaming, and asks the canvas for the failure flow.
  const asked = await daniel.say(q1);
  await daniel.saidAll();
  const questionEnd = Date.now();
  const done1 = await until(() => danielApp.agentEvents('turn.completed').length === 1, 40000);
  const heard = danielApp.events.filter((e) => e.type === 'speech' && e.speech.final && e.speech.addressed).map((e) => e.speech.text);
  check('3. Daniel’s speech is transcribed from his own microphone', heard.length === 1 && /crash/i.test(heard[0]) && /charg/i.test(heard[0]), `"${heard[0]}"`);
  const turn = danielApp.asked[0];
  check('4. The spoken question reaches the runtime as Daniel’s turn, with his canvas', turn?.participant.userId === DANIEL.userId && turn.source === 'voice' && /crash/i.test(turn.question) && turn.canvas.selection.selected[0] === 'payment-worker',
    turn ? `participant=${turn.participant.name} source=${turn.source} question="${turn.question}" selected=${turn.canvas.selection.selected}` : 'no turn');
  const completed1 = danielApp.agentEvents('turn.completed')[0];
  // The text finishes streaming long before it's all been said: wait for Vowe to finish speaking.
  const spoken1 = await until(() => john.stateShown(danielsVowe, 'listening', completed1?.at ?? questionEnd), 60000);
  await sleep(300);
  const firstSound = john.firstSoundAfter(danielsVowe, questionEnd);
  const audible1 = john.heardSeconds(danielsVowe, asked);
  check('5. Vowe answers aloud, heard by John', done1 && completed1.reply.stop === 'answered' && spoken1 && audible1 > 10,
    `${audible1.toFixed(1)} s of the answer audible to John; first sound ${firstSound ? ((firstSound - questionEnd) / 1000).toFixed(2) : '—'} s after Daniel stopped talking`);
  check('6. It speaks while the answer is still streaming', firstSound && firstSound < completed1.at, firstSound ? `first sound ${((completed1.at - firstSound) / 1000).toFixed(2)} s before the runtime finished the answer` : '');

  // Where the time to first sound goes, stage by stage.
  const at = {
    'recognizer final': danielApp.firstStage('recognizer final', questionEnd),
    'addressed speech passed on': danielApp.events.find((e) => e.type === 'speech' && e.speech.final && e.speech.addressed && e.at >= questionEnd)?.at,
    'runtime asked': danielApp.firstStage('runtime asked', questionEnd),
    'turn started': danielApp.agentEvents('turn.started')[0]?.at,
    'first text delta': danielApp.agentEvents('text.delta').find((e) => e.at >= questionEnd)?.at,
    'synthesis requested': danielApp.firstStage('synthesis requested', questionEnd),
    'first synthesized audio': danielApp.firstStage('first synthesized audio', questionEnd),
    'audio published': danielApp.firstStage('audio published', questionEnd),
    'heard by John': firstSound,
  };
  let previous = questionEnd;
  log('  time to first sound, from the end of Daniel\'s question:');
  for (const [stage, t] of Object.entries(at)) {
    log(`    ${stage.padEnd(28)} ${t ? `+${((t - questionEnd) / 1000).toFixed(2)} s  (${t - previous >= 0 ? '+' : ''}${t - previous} ms)` : '—'}`);
    if (t) previous = t;
  }
  firstSoundLatency = firstSound ? firstSound - questionEnd : null;

  const command = danielApp.agentEvents('canvas.command')[0]?.command;
  check('8. The runtime’s canvas command reaches Daniel’s room, validated, for the canvas engine', command?.v === 1 && command.type === 'show_view' && command.payload.view === 'failure' && command.requestedBy === DANIEL.userId && command.roomId === ROOM,
    command ? `${command.type} ${command.payload.view}, requestedBy ${command.requestedBy === DANIEL.userId ? 'Daniel' : command.requestedBy}` : 'none');
  const shown = (john.states.get(danielsVowe) ?? []).map((s) => s.state);
  check('   Everyone sees what Daniel’s Vowe is doing, through the call', shown.join(' → ') === 'thinking → speaking → listening' && danielApp.host.status.state === 'listening', shown.join(' → '));

  // 7. Daniel talks over his Vowe.
  await sleep(1000);
  await daniel.say(q2);
  await daniel.saidAll();
  const speaking2 = await until(() => danielApp.host.status.state === 'speaking', 30000);
  await sleep(2500);
  const abortsBefore = danielApp.provider.aborted;
  const interruptAt = await daniel.say(wait);
  const cancelled = await until(() => danielApp.agentEvents('turn.cancelled').length === 1, 10000);
  const silencedAt = danielApp.events.find((e) => e.type === 'status' && e.at > interruptAt && e.status.state === 'listening')?.at;
  await sleep(1500);
  const lastSound = john.lastSound(danielsVowe);
  const shownListening2 = john.stateShown(danielsVowe, 'listening', interruptAt);
  check('7. Daniel interrupts his Vowe: its speech stops', speaking2 && silencedAt && john.heardSeconds(danielsVowe, interruptAt + 1000) < 0.2 && shownListening2 && danielApp.host.status.state === 'listening',
    `silenced ${silencedAt ? silencedAt - interruptAt : '—'} ms after Daniel started talking; its last sound reached John ${lastSound - interruptAt} ms after; ${john.heardSeconds(danielsVowe, interruptAt + 1000).toFixed(2)} s of it after that; John's call shows it listening ${shownListening2 ? shownListening2 - interruptAt : '—'} ms after`);
  const cancel = danielApp.agentEvents('turn.cancelled')[0];
  // The reason arrives as 'cancelled': agentOverIpc's cancel() drops 'interrupted' (agent:cancel takes only the turn id).
  check('   …and the runtime cancels the turn and its model request', cancelled && danielApp.provider.aborted > abortsBefore, `turn.cancelled (${cancel?.reason}); model request aborted: ${danielApp.provider.aborted > abortsBefore}`);
  await daniel.saidAll();

  // 7b. John talks over Daniel's Vowe.
  await sleep(1500);
  await daniel.say(q3);
  await daniel.saidAll();
  const speaking3 = await until(() => danielApp.host.status.state === 'speaking', 30000);
  await sleep(2500);
  const cancelsBefore = danielApp.agentEvents('turn.cancelled').length;
  const johnTalks = await john.say(hangOn);
  const cancelled3 = await until(() => danielApp.agentEvents('turn.cancelled').length > cancelsBefore, 10000);
  const silenced3 = danielApp.events.find((e) => e.type === 'status' && e.at > johnTalks && e.status.state === 'listening')?.at;
  await sleep(1500);
  const shownListening3 = john.stateShown(danielsVowe, 'listening', johnTalks);
  check('   John talking over Daniel’s Vowe stops it too', speaking3 && cancelled3 && john.heardSeconds(danielsVowe, johnTalks + 1500) < 0.2 && shownListening3 && danielApp.host.status.state === 'listening',
    `silenced ${silenced3 ? silenced3 - johnTalks : '—'} ms after John started talking (LiveKit's active speaker); ${john.heardSeconds(danielsVowe, johnTalks + 1500).toFixed(2)} s of it after that; John's call shows it listening ${shownListening3 ? shownListening3 - johnTalks : '—'} ms after`);
  // A cancelled turn leaves nothing behind: the next question gets a fresh answer, not the rest of this one.
  const lateSay = danielApp.events.some((e) => e.type === 'said' && e.at > (silenced3 ?? johnTalks) && e.turnId === danielApp.agentEvents('turn.cancelled').at(-1)?.turnId);
  check('   Nothing of an interrupted answer is said after it stops', !lateSay && !danielApp.events.some((e) => e.type === 'said' && e.at > (silencedAt ?? interruptAt) && e.turnId === cancel?.turnId), lateSay ? 'late sentence spoken' : 'no sentence of either interrupted turn was spoken after it stopped');
  await john.saidAll();

  // Per-person model access: John asks, but has no model sign-in of his own.
  await sleep(1500);
  const danielTurns = danielApp.asked.length;
  const danielRequests = danielApp.provider.requests;
  const johnAsked = await john.say(johnQ);
  await john.saidAll();
  const failed = await until(() => johnApp.agentEvents('turn.failed').length === 1, 20000);
  await sleep(1500);
  const failure = johnApp.agentEvents('turn.failed')[0];
  check('9. John’s question goes to his own runtime only, never Daniel’s model access', failed && failure.error.code === 'not-signed-in' && danielApp.asked.length === danielTurns && danielApp.provider.requests === danielRequests && daniel.heardSeconds(johnsVowe, johnAsked) === 0,
    `John's runtime: ${failure?.error.code} (shown to John only, nothing spoken); turns on Daniel's machine: ${danielApp.asked.length - danielTurns}; Daniel's model requests: ${danielApp.provider.requests - danielRequests}`);

  // Feedback loops: nobody's Vowe is ever transcribed.
  const transcripts = apps.flatMap((a) => a.events.filter((e) => e.type === 'speech' && e.speech.final).map((e) => e.speech.text));
  check('10. No Vowe audio is transcribed as a person (each app hears only its own microphone)', !transcripts.some((t) => /lease|idempotency|processor|acknowledge/i.test(t)) && apps.every((a) => a.events.filter((e) => e.type === 'speech').every((e) => e.speech.participant.userId === a.who.userId)),
    `${transcripts.length} finished utterances, all the speaker’s own`);

  // 11. Leaving the call cleans up.
  await daniel.leave();
  await john.leave();
  const left = await until(() => apps.every((a) => a.host.status.status === 'off'), 10000);
  const roomService = new RoomServiceClient(http, process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
  await sleep(1000);
  const remaining = await roomService.listParticipants(`room:${ROOM}`).catch(() => []);
  check('11. Leaving the call cleans up all voice resources', left && remaining.length === 0 && apps.every((a) => a.host['session'] === null),
    `both Vowes left (${apps.map((a) => a.host.status.error).join('; ')}); ${remaining.length} participants left in the LiveKit room; recognition closed`);
  exit = results.every((r) => r.ok) ? 0 : 1;
} catch (err) {
  console.error(err);
} finally {
  for (const a of apps) await a.voice?.stop().catch(() => {});
  for (const p of people) await p.leave().catch(() => {});
  if (!external) {
    try {
      docker('rm', '-f', NAME);
    } catch {}
  }
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
  await dispose().catch(() => {});
  process.exit(exit);
}
