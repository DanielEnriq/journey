// Electron main for the end-to-end call test (run.mjs starts it). Two windows, Ana and Ben, join one
// room's call through the app's CallService against a real LiveKit server, with tokens from the API's
// own issueToken. Chromium's fake microphone sends a beeping tone, so "Ben hears Ana" is measured from
// the audio Ben's WebRTC receiver actually decodes.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow } from 'electron';
import { issueToken } from '../../server/dist/livekit.js';

app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const ROOM = '0b7c6c4e-55d2-4d0f-9f53-0d0b8a3ef001';
const ANA = '11111111-1111-4111-8111-111111111111';
const BEN = '22222222-2222-4222-8222-222222222222';
const MEMBERS = new Set([ANA, BEN]);

/** The API's token route with a Supabase stand-in whose RLS admits exactly MEMBERS to ROOM. */
function tokenFor(userId, roomId = ROOM) {
  const supabase = {
    from(table) {
      const filters = {};
      const query = {
        select: () => query,
        eq: (column, value) => ((filters[column] = value), query),
        maybeSingle: async () =>
          table === 'room_members'
            ? { data: MEMBERS.has(filters.user_id) && filters.room_id === ROOM ? { room_id: ROOM } : null, error: null }
            : { data: { name: userId === ANA ? 'Ana' : 'Ben', avatar_url: null }, error: null },
      };
      return query;
    },
  };
  return issueToken({ userId, supabase }, { roomId });
}

async function client(userId) {
  const access = await tokenFor(userId);
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  const url = pathToFileURL(join(import.meta.dirname, 'client.html'));
  url.search = new URLSearchParams({ ...access, roomId: ROOM }).toString();
  await win.loadURL(url.href);
  await until(async () => win.webContents.getTitle() === 'ready', 'page ready');
  const run = (code) => win.webContents.executeJavaScript(code);
  return {
    join: () => run('harness.join()'),
    leave: () => run('harness.leave()'),
    mic: (on) => run(`harness.mic(${on})`),
    snapshot: () => run('harness.snapshot()'),
    events: () => run('harness.events()'),
    liveMicrophones: () => run('harness.liveMicrophones()'),
    microphonesOpened: () => run('harness.microphonesOpened()'),
    hearing: (identity) => run(`harness.hearing(${JSON.stringify(identity)})`),
    simulate: (scenario) => run(`harness.simulate(${JSON.stringify(scenario)})`),
    playing: () => run('harness.playing()'),
  };
}

async function until(check, what, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** Audio energy and packets Ben decodes from Ana over `ms`. */
async function heardOver(listener, identity, ms = 2000) {
  const before = await listener.hearing(identity);
  await new Promise((r) => setTimeout(r, ms));
  const after = await listener.hearing(identity);
  return { packets: after.packets - before.packets, energy: after.energy - before.energy, muted: after.muted };
}

const step = (name) => console.log(`  ✓ ${name}`);

async function main() {
  await app.whenReady();
  console.log('Call end-to-end:');

  await assert.rejects(tokenFor('33333333-3333-4333-8333-333333333333'), { message: 'Join the room before its call' });
  step('a non-member gets no token');

  const ana = await client(ANA);
  const ben = await client(BEN);

  await ana.join();
  await ben.join();
  await until(async () => (await ana.snapshot()).participants.length === 2, 'Ana to see Ben');
  const a = await ana.snapshot();
  assert.equal(a.status, 'connected');
  assert.deepEqual(a.participants.map((p) => p.name), ['Ana', 'Ben']);
  assert.ok((await ana.events()).includes('participant-joined'));
  step('two clients join the same call and see each other');

  assert.equal(a.micEnabled, false);
  assert.equal(await ana.microphonesOpened(), 0);
  assert.equal(await ben.microphonesOpened(), 0);
  assert.equal((await ben.hearing(ANA)).subscribed, false);
  step('joining leaves the microphone closed: nothing captured, nothing published');

  await ana.mic(true);
  assert.equal((await ana.snapshot()).micEnabled, true);
  await until(async () => (await ben.hearing(ANA)).subscribed, 'Ben to receive Ana’s track');
  await until(async () => (await heardOver(ben, ANA, 1000)).energy > 0, 'Ana’s audio to reach Ben', 10_000);
  const live = await heardOver(ben, ANA);
  assert.ok(live.packets > 50, `Ben received ${live.packets} packets in 2s`);
  assert.ok(live.energy > 0, 'Ben decoded non-silent audio');
  assert.equal(await ben.playing(), 1, 'Ben plays Ana through an <audio> element');
  step(`Ana's microphone reaches Ben: ${live.packets} packets, audio energy ${live.energy.toFixed(4)} in 2s`);

  await ana.mic(false);
  await until(async () => (await ben.snapshot()).participants.find((p) => p.name === 'Ana')?.isMuted, 'Ben to see Ana muted');
  const muted = await heardOver(ben, ANA);
  assert.ok(muted.energy < live.energy / 10, `muted energy ${muted.energy} should be near zero`);
  assert.equal(await ana.liveMicrophones(), 0, 'muting releases the device');
  step('mute: Ben sees Ana muted, hears nothing, and Ana’s device is released');

  await ana.mic(true);
  await until(async () => (await heardOver(ben, ANA, 1000)).energy > 0, 'Ana’s audio after unmute', 10_000);
  step('unmute: Ben hears Ana again');

  await ben.mic(true);
  await until(async () => (await heardOver(ana, BEN, 1000)).energy > 0, 'Ben’s audio to reach Ana', 10_000);
  step('both ways: Ana hears Ben');

  await ana.simulate('full-reconnect');
  await until(async () => (await ana.events()).includes('reconnected'), 'Ana to reconnect', 30_000);
  await until(async () => (await ana.snapshot()).status === 'connected', 'Ana connected after reconnect', 15_000);
  assert.ok((await ana.events()).includes('reconnecting'));
  await until(async () => (await heardOver(ben, ANA, 1000)).energy > 0, 'Ana’s audio after reconnect', 15_000);
  step('reconnect: Ana drops and comes back on her own, still heard');

  await ben.leave();
  await until(async () => (await ana.snapshot()).participants.length === 1, 'Ana to see Ben leave');
  assert.ok((await ana.events()).includes('participant-left'));
  assert.equal((await ben.snapshot()).status, 'idle');
  assert.equal(await ben.liveMicrophones(), 0, 'leaving stops the microphone');
  step('leave: Ana sees Ben go, and Ben’s microphone stops');

  await ana.leave();
  console.log('All call checks passed.');
}

main().then(
  () => app.exit(0),
  (err) => {
    console.error(`  ✗ ${err.stack ?? err}`);
    app.exit(1);
  },
);
