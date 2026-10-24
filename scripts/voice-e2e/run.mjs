// pnpm test:voice — Vowe's voice end to end, on a real LiveKit server with real speech.
//
// Starts a throwaway LiveKit server in Docker (dev keys, localhost only). Two people, Daniel and John,
// join the room's call as LiveKit participants with the same grants as POST /livekit/token, each
// publishing a microphone. Vowe joins with the grant from POST /vowe/token and runs the real
// VoiceParticipant: LiveKit transport, ElevenLabs Scribe and text-to-speech. People's questions are
// spoken audio (made with ElevenLabs once at the start), so everything Vowe hears goes through the call.
//
// Reasoning is the fixture runtime (voice/reasoning/fixture.ts) until the reasoning runtime lands, and the
// canvas is a relay that records commands; both are the seams the other branches plug into.
//
// Needs Docker, `pnpm build && pnpm api:build`, and ELEVENLABS_API_KEY + ELEVENLABS_AGENT_ID in .env.
// LIVEKIT_E2E_URL=ws://… with LIVEKIT_API_KEY/LIVEKIT_API_SECRET runs against another server instead.

import { execFileSync } from 'node:child_process';
import { AudioSource, AudioStream, LocalAudioTrack, Room, RoomEvent, TrackPublishOptions, TrackSource, AudioFrame, dispose } from '@livekit/rtc-node';
import { RoomServiceClient } from 'livekit-server-sdk';
import { issueToken } from '../../server/dist/livekit.js';
import { voweToken } from '../../server/dist/vowe-voice.js';
import { LiveKitTransport } from '../../dist/voice/livekit.js';
import { VoiceParticipant, rms } from '../../dist/voice/participant.js';
import { ElevenLabsRecognizer, ElevenLabsSynthesizer, agentVoice } from '../../dist/voice/providers/elevenlabs.js';
import { FixtureReasoning } from '../../dist/voice/reasoning/fixture.js';

process.loadEnvFile(new URL('../../.env', import.meta.url));
const IMAGE = 'livekit/livekit-server:v1.9.1';
const NAME = 'vowe-voice-e2e';
const external = process.env.LIVEKIT_E2E_URL;

const ROOM = '0b7c6c4e-55d2-4d0f-9f53-0d0b8a3ef0a1';
const DANIEL = { id: '11111111-1111-4111-8111-111111111111', name: 'Daniel' };
const JOHN = { id: '22222222-2222-4222-8222-222222222222', name: 'John' };
const SELECTION = [{ id: 'payment-worker', label: 'Payment Worker' }];
const FAILURE_FLOW = { id: 'cmd-failure-flow', kind: 'show-view', view: 'failure-flow', focus: 'payment-worker' };
/** A premade ElevenLabs voice for the people's questions, so Daniel doesn't sound like Vowe. */
const PERSON_VOICE = 'JBFqnCBsd6RMkjVDRZzb';

const t0 = Date.now();
const log = (...args) => console.log(`[${((Date.now() - t0) / 1000).toFixed(2).padStart(6)}s]`, ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
async function until(what, cond, ms) {
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

/** A person in the call: a microphone fed from a queue of clips (silence in between), and ears on Vowe. */
class Person {
  constructor(who) {
    this.who = who;
    this.queue = [];
    this.voweAudio = []; // { t, rms } per 20 ms frame of Vowe's track
    this.voweStates = [];
  }
  async join(token, url) {
    this.room = new Room();
    this.room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
      if (participant.identity !== 'vowe') return;
      this.voweKind = participant.kind;
      void (async () => {
        for await (const frame of new AudioStream(track, { sampleRate: 16000, numChannels: 1, frameSizeMs: 20 })) {
          this.voweAudio.push({ t: Date.now(), rms: rms(frame.data) });
        }
      })().catch(() => {});
    });
    this.room.on(RoomEvent.ParticipantAttributesChanged, (changed, participant) => {
      if (participant.identity === 'vowe' && changed['vowe.state']) this.voweStates.push(changed['vowe.state']);
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
      if (next?.started) next.started();
      const data = next?.frame ?? silence;
      await this.source.captureFrame(new AudioFrame(data, 16000, 1, data.length));
    }
  }
  /** Queues a clip; resolves when it starts going out. */
  say(clip) {
    return new Promise((resolve) => {
      for (let i = 0; i < clip.length; i += 320) {
        const frame = clip.slice(i, i + 320);
        this.queue.push(i === 0 ? { frame, started: () => resolve(Date.now()) } : { frame });
      }
    });
  }
  async saidAll() {
    while (this.queue.length) await sleep(20);
  }
  /** Seconds of clearly audible Vowe speech heard since `since`. */
  heardVoweSeconds(since = 0) {
    return this.voweAudio.filter((f) => f.t >= since && f.rms > 300).length * 0.02;
  }
  lastVoweSoundAt() {
    return [...this.voweAudio].reverse().find((f) => f.rms > 300)?.t ?? 0;
  }
  async leave() {
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

const env = {};
if (external) {
  Object.assign(env, { url: external });
} else {
  try {
    docker('rm', '-f', NAME);
  } catch {}
  // Its own ports (not 7880–7882), so it can run beside the calls e2e. Media ports must match inside and
  // out, since they're advertised to clients as is.
  const config = 'port: 7980\nrtc:\n  tcp_port: 7981\n  udp_port: 7982\n  use_external_ip: false\nkeys:\n  devkey: secret\n';
  docker('run', '-d', '--rm', '--name', NAME, '-p', '127.0.0.1:7980:7980', '-p', '127.0.0.1:7981:7981', '-p', '127.0.0.1:7982:7982/udp',
    IMAGE, '--dev', '--bind', '0.0.0.0', '--node-ip', '127.0.0.1', '--config-body', config);
  Object.assign(env, { url: 'ws://127.0.0.1:7980' });
  process.env.LIVEKIT_API_KEY = 'devkey';
  process.env.LIVEKIT_API_SECRET = 'secret';
}
process.env.LIVEKIT_URL = env.url;

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

let exit = 1;
const people = [];
let vowe;
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
  const voice = await agentVoice(apiKey, process.env.ELEVENLABS_AGENT_ID);
  const access = { kind: 'key', apiKey, ...voice };
  const personSynth = new ElevenLabsSynthesizer({ ...access, voiceId: PERSON_VOICE });
  const [q1, q2, stop, johnQ] = await Promise.all([
    clip(personSynth, 'Vowe, what happens if this crashes after charging?'),
    clip(personSynth, 'Vowe, walk me through the retry path, step by step.'),
    clip(personSynth, 'Wait, wait, hold on a second.'),
    clip(personSynth, 'Vowe, what does the ledger do?'),
  ]);
  log(`spoken questions ready (${(q1.length / 16000).toFixed(1)} s, ${(q2.length / 16000).toFixed(1)} s, ${(stop.length / 16000).toFixed(1)} s, ${(johnQ.length / 16000).toFixed(1)} s)`);

  // 1. Two people join the call.
  const daniel = new Person(DANIEL);
  const john = new Person(JOHN);
  people.push(daniel, john);
  for (const p of people) {
    const { token } = await issueToken(memberCaller(p.who.id, p.who.name), { roomId: ROOM });
    await p.join(token, env.url);
  }
  check('1. Two people join a real LiveKit call', await until('both see each other', () => daniel.room.remoteParticipants.has(JOHN.id) && john.room.remoteParticipants.has(DANIEL.id), 5000));

  // 2. Vowe joins as an AI participant.
  const canvasLog = [];
  const events = [];
  const reasoning = new FixtureReasoning({
    authorized: [DANIEL.id], // Daniel's model access only: John's questions must be refused, not charged to Daniel
    script: (turn) =>
      /walk me through/i.test(turn.text)
        ? { steps: [{ tool: 'read_component' }, { say: 'First the worker takes the job from the queue. Then it charges the card through the provider. Then it writes the result to the ledger. If it crashes between charging and writing, the lease expires. Another worker picks the job up again. That second worker charges the card a second time, because nothing remembers the first charge. '.repeat(2) }], deltaMs: 120 }
        : { steps: [{ tool: 'read_component' }, { say: 'If the Payment Worker crashes after charging, the customer is charged but the order never gets marked paid. ' }, { canvas: FAILURE_FLOW }, { say: 'On the failure flow you can see the retry charging them a second time.' }], deltaMs: 20 },
  });
  const transport = new LiveKitTransport(async () => ({ url: env.url, token: await voweToken(ROOM, DANIEL.id).toJwt() }));
  vowe = new VoiceParticipant({
    roomId: ROOM,
    summonedBy: { identity: DANIEL.id, name: DANIEL.name },
    transport,
    recognizer: new ElevenLabsRecognizer(access),
    synthesizer: new ElevenLabsSynthesizer(access),
    reasoning,
    canvas: {
      apply: async (command, turn) => {
        canvasLog.push({ command, requester: turn.requester.identity, at: Date.now() });
        await sleep(300); // the canvas engine validating, applying and broadcasting
        return 'applied';
      },
    },
    context: { forRequester: (identity) => (identity === DANIEL.id ? { selection: SELECTION, view: 'architecture' } : { selection: [], view: null }) },
    onEvent: (e) => {
      events.push({ ...e, at: Date.now() });
      if (e.type === 'heard' || e.type === 'say' || e.type === 'state' || e.type === 'interrupted' || e.type === 'turn-ended' || e.type === 'error' || e.type === 'canvas')
        log(`  vowe ${e.type}: ${JSON.stringify({ ...e, type: undefined, speaker: e.speaker?.name })}`);
    },
  });
  await vowe.start();
  const seen = await until('Vowe in the call', () => [...john.room.remoteParticipants.keys()].includes('vowe'), 5000);
  await until('Vowe hearing both', () => transport['hearing'].size === 2, 5000);
  check('2. Vowe joins as an AI participant', seen && john.voweKind === 4, `kind=${john.voweKind} (4 = agent), hearing ${transport['hearing'].size} microphones`);
  check('   Vowe never opens a person’s microphone: people published theirs, Vowe publishes only its own', daniel.room.remoteParticipants.get('vowe')?.trackPublications.size === 1);

  // 3–6. Daniel asks; Vowe hears, reasons, answers aloud, and asks for the failure flow.
  const asked = Date.now();
  await daniel.say(q1);
  await daniel.saidAll();
  const questionEnd = Date.now();
  const firstTurnDone = await until('first answer', () => events.some((e) => e.type === 'turn-ended'), 40000);
  const heard = events.filter((e) => e.type === 'heard' && e.speaker.identity === DANIEL.id).map((e) => e.text).join(' ');
  check('3. Daniel’s speech is transcribed', /crash/i.test(heard) && /charg/i.test(heard), `"${heard}"`);
  const turn = reasoning.turns[0];
  check('4. The question reaches the reasoning adapter, as Daniel, with his selection', turn?.requester.identity === DANIEL.id && /crash/i.test(turn?.text ?? '') && turn?.context.selection[0]?.id === 'payment-worker' && turn.roomId === ROOM,
    turn ? `requester=${turn.requester.name} text="${turn.text}" selection=${turn.context.selection.map((s) => s.id)}` : 'no turn');
  const firstAudio = john.voweAudio.find((f) => f.t > questionEnd && f.rms > 300)?.t;
  check('5. Vowe produces an audible answer (heard by John)', firstTurnDone && john.heardVoweSeconds(asked) > 2, `${john.heardVoweSeconds(asked).toFixed(1)} s audible; first sound ${firstAudio ? ((firstAudio - questionEnd) / 1000).toFixed(2) : '—'} s after Daniel stopped talking`);
  const canvas = events.find((e) => e.type === 'canvas');
  const says = events.filter((e) => e.type === 'say');
  check('8. Vowe relays a structured canvas action, and speaks about it after it is shown', canvasLog[0]?.command === FAILURE_FLOW && canvas?.outcome === 'applied' && says[1]?.at >= canvasLog[0].at + 300,
    canvasLog[0] ? `command ${canvasLog[0].command.id} passed through unchanged, applied; "${says[1]?.text}" started ${says[1] ? says[1].at - canvasLog[0].at : '—'} ms after the command` : 'no canvas command');
  const shown = await until('state attributes', () => john.voweStates.at(-1) === 'listening', 3000);
  check('   Everyone sees Vowe’s state through the call', shown && ['thinking', 'speaking'].every((s) => john.voweStates.includes(s)), john.voweStates.join(' → '));

  // 7. Daniel interrupts Vowe mid-answer.
  await sleep(1000);
  await daniel.say(q2);
  await daniel.saidAll();
  const speaking = await until('Vowe speaking the long answer', () => vowe.state === 'speaking', 30000);
  await sleep(2500);
  const turnId = vowe.activeTurn?.turnId;
  const interruptAt = await daniel.say(stop);
  const stopped = await until('the interruption', () => events.some((e) => e.type === 'interrupted'), 5000);
  const interrupted = events.find((e) => e.type === 'interrupted');
  await sleep(1500);
  const lastSound = john.lastVoweSoundAt();
  const silentAfter = john.heardVoweSeconds(interruptAt + 1000);
  check('7. Daniel interrupts Vowe and its speech stops', speaking && stopped && interrupted?.by === DANIEL.id && silentAfter < 0.2,
    `interrupted ${interrupted ? interrupted.at - interruptAt : '—'} ms after Daniel started talking; Vowe's last sound reached John ${lastSound - interruptAt} ms after; ${silentAfter.toFixed(2)} s of Vowe audio after that`);
  check('   …and its reasoning request is cancelled', await until('abort', () => reasoning.aborted.includes(turnId), 3000), turnId ? `turn ${turnId.slice(0, 8)} aborted` : 'no turn');
  await daniel.saidAll();

  // Per-person model access: John asks, but only Daniel's access is connected.
  await sleep(1500);
  const turnsBefore = reasoning.turns.length;
  const endedBefore = events.filter((e) => e.type === 'turn-ended').length;
  await john.say(johnQ);
  await john.saidAll();
  await until('refusal', () => events.filter((e) => e.type === 'turn-ended').length > endedBefore, 30000);
  const refusal = events.filter((e) => e.type === 'turn-ended').at(-1);
  check('   John’s question is refused aloud, never charged to Daniel’s model access', refusal?.outcome === 'refused' && reasoning.turns.length === turnsBefore,
    `outcome=${refusal?.outcome}; reasoning runs: ${reasoning.turns.length - turnsBefore}`);

  // 9. Leaving the call cleans up.
  await sleep(500);
  await daniel.leave();
  await john.leave();
  const left = await until('Vowe leaving', () => events.some((e) => e.type === 'stopped'), 10000);
  const roomService = new RoomServiceClient(env.url.replace(/^ws/, 'http'), process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
  await sleep(1000);
  const remaining = await roomService.listParticipants(`room:${ROOM}`).catch(() => []);
  check('9. Leaving the call cleans up all voice resources', left && remaining.length === 0 && transport['closed'] && transport['hearing'].size === 0,
    `Vowe stopped (${events.find((e) => e.type === 'stopped')?.reason}); ${remaining.length} participants left in the LiveKit room; recognition streams closed`);
  exit = results.every((r) => r.ok) ? 0 : 1;
} catch (err) {
  console.error(err);
} finally {
  await vowe?.stop().catch(() => {});
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
