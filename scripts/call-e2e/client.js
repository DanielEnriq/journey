// One side of the end-to-end call test, running the app's real CallService in a Chromium page with
// Chromium's fake microphone (a beeping tone). main.mjs drives it through window.harness.
import { CallService, domAudioSink } from '../../dist/renderer/calls/service.js';
import { Room, Track } from '../../dist/renderer/vendor/livekit-client.js';

const params = new URLSearchParams(location.search);
const access = { url: params.get('url'), token: params.get('token') };

// Count microphone opens, to prove joining doesn't open it and muting closes it.
const opened = [];
const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
navigator.mediaDevices.getUserMedia = async (constraints) => {
  const stream = await getUserMedia(constraints);
  opened.push(...stream.getAudioTracks());
  return stream;
};

let room;
const events = [];
const service = new CallService(
  { access: async () => access, requestMicrophone: async () => 'granted' },
  {
    createRoom: (options) => (room = new Room(options)),
    audio: domAudioSink(),
  },
);
service.onEvent((event) => events.push(event));

/** What this side hears from `identity`: totals from the WebRTC receiver, which only grow while audio arrives. */
async function hearing(identity) {
  const participant = room?.remoteParticipants.get(identity);
  const publication = participant?.getTrackPublication(Track.Source.Microphone);
  const track = publication?.track;
  if (!track) return { subscribed: false, muted: publication?.isMuted ?? true, packets: 0, energy: 0 };
  let packets = 0;
  let energy = 0;
  for (const stat of (await track.receiver.getStats()).values()) {
    if (stat.type !== 'inbound-rtp' || stat.kind !== 'audio') continue;
    packets += stat.packetsReceived ?? 0;
    energy += stat.totalAudioEnergy ?? 0;
  }
  return { subscribed: true, muted: publication.isMuted, packets, energy };
}

window.harness = {
  join: () => service.join(params.get('roomId')),
  leave: () => service.leave(),
  mic: (enabled) => service.setMicrophoneEnabled(enabled),
  snapshot: () => service.snapshot,
  events: () => events.map((e) => e.type),
  liveMicrophones: () => opened.filter((t) => t.readyState === 'live').length,
  microphonesOpened: () => opened.length,
  hearing,
  simulate: (scenario) => room.simulateScenario(scenario),
  playing: () => [...document.querySelectorAll('audio')].filter((a) => a.srcObject).length,
};
document.title = 'ready';
