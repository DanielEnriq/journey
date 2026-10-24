import { createClient, type RealtimeChannel } from '@supabase/supabase-js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  buildScenes, command, parseCanvasChanged, parsePresence, PAYMENT_SYSTEM,
  type CanvasStore, type CommandResult, type StoredCanvas,
} from '../../shared/canvas/index.js';
import { canvasContext, createCanvasHub, createCanvasStore, toCanvasError, type CanvasChange, type CanvasHubOptions } from './canvas.js';
import type { Cloud } from './index.js';
import type { Database } from './types.js';

// A room's canvas against a local Supabase stack with the migrations applied, as several real
// signed-in users over real Realtime channels. Skipped without one; refuses anything but localhost:
//
//   ROOMS_TEST_SUPABASE_URL=http://127.0.0.1:54321 ROOMS_TEST_SUPABASE_PUBLISHABLE_KEY=… \
//   ROOMS_TEST_SUPABASE_SECRET_KEY=… pnpm test

const url = process.env.ROOMS_TEST_SUPABASE_URL;
const publishableKey = process.env.ROOMS_TEST_SUPABASE_PUBLISHABLE_KEY;
const secretKey = process.env.ROOMS_TEST_SUPABASE_SECRET_KEY;
const local = Boolean(url && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url));
if (url && !local) throw new Error('ROOMS_TEST_SUPABASE_URL must be a local stack (http://127.0.0.1:…), never a hosted project');
const integration = local && publishableKey && secretKey ? {} : { skip: 'set ROOMS_TEST_SUPABASE_* to run against a local stack' };

const ok = (r: CommandResult) => { assert.ok(r.ok, r.ok ? '' : `${r.error.code}: ${r.error.message}`); return r as Extract<CommandResult, { ok: true }>; };
const errorCode = (r: CommandResult) => r.ok ? 'ok' : r.error.code;

describe('canvas errors', () => {
  it('maps cloud failures to canvas codes', () => {
    assert.equal(toCanvasError({ code: '42501', message: 'not allowed' }).code, 'permission-denied');
    assert.equal(toCanvasError({ code: '23514', message: 'check' }).code, 'invalid');
    assert.equal(toCanvasError({ code: '', message: 'TypeError: fetch failed' }).code, 'network');
    assert.equal(toCanvasError({ code: 'PGRST301', message: 'JWT expired' }).code, 'signed-out');
  });
});

describe('room canvases (local Supabase)', integration, () => {
  const run = randomUUID().slice(0, 8);
  const password = `pw-${randomUUID()}`;
  const admin = () => createClient<Database>(url!, secretKey!, { auth: { persistSession: false, autoRefreshToken: false } });

  async function signIn(email: string): Promise<Cloud> {
    const client = createClient<Database>(url!, publishableKey!, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return client;
  }

  interface Person { id: string; email: string; name: string; cloud: Cloud; store: CanvasStore }
  const people: Record<'alice' | 'bob' | 'carol' | 'dave' | 'erin', Person> = {} as never;
  let roomId: string;

  /** Joins the room's private channel as Realtime and RLS see it, like realtime.ts does. */
  async function channel(p: Person, received: unknown[] = []): Promise<RealtimeChannel> {
    await p.cloud.realtime.setAuth();
    const ch = p.cloud.channel(`room:${roomId}`, { config: { private: true, broadcast: { self: false, ack: true } } });
    ch.on('broadcast', { event: 'room-event' }, ({ payload }) => received.push(payload));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('channel join timed out')), 10_000);
      ch.subscribe((status, err) => {
        if (status === 'SUBSCRIBED') { clearTimeout(timer); resolve(); }
        else if (status !== 'CLOSED') { clearTimeout(timer); reject(err ?? new Error(status)); }
      });
    });
    return ch;
  }

  const until = async (check: () => boolean, what: string, ms = 8000) => {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  before(async () => {
    for (const name of ['alice', 'bob', 'carol', 'dave', 'erin'] as const) {
      const email = `${name}-${run}@canvas.test`;
      const full = name[0]!.toUpperCase() + name.slice(1);
      const { data, error } = await admin().auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: full } });
      if (error) throw error;
      const cloud = await signIn(email);
      people[name] = { id: data.user.id, email, name: full, cloud, store: createCanvasStore(async () => cloud) };
    }
    // Alice owns the room; Bob is a member; Erin is a viewer; Carol is in the workspace but not the room;
    // Dave is in neither.
    const { alice, bob, carol, erin } = people;
    const { data: ws, error } = await alice.cloud.from('workspaces').insert({ name: `Canvas ${run}` }).select().single();
    if (error) throw error;
    const added = await alice.cloud.from('workspace_members').insert([{ workspace_id: ws.id, user_id: bob.id }, { workspace_id: ws.id, user_id: carol.id }, { workspace_id: ws.id, user_id: erin.id }]);
    if (added.error) throw added.error;
    const room = await alice.cloud.from('rooms').insert({ workspace_id: ws.id, name: 'Payment Reliability' }).select().single();
    if (room.error) throw room.error;
    roomId = room.data.id;
    const member = await alice.cloud.from('room_members').insert([{ room_id: roomId, user_id: bob.id, role: 'member' }, { room_id: roomId, user_id: erin.id, role: 'viewer' }]);
    if (member.error) throw member.error;
  });

  after(async () => {
    for (const p of Object.values(people)) {
      await p.cloud.removeAllChannels();
      await admin().auth.admin.deleteUser(p.id);
    }
  });

  const hubFor = (p: Person, announce: CanvasHubOptions['announce'] = async () => {}) =>
    createCanvasHub({ store: p.store, person: async () => ({ kind: 'human', id: p.id, name: p.name }), announce });

  it('starts empty, saves a system, and reads back the same document as another member', async () => {
    const { alice, bob } = people;
    assert.equal((await alice.store.load(roomId)).revision, 0);
    const hub = hubFor(alice);
    const { result } = await hub.execute(roomId, command('load_system', PAYMENT_SYSTEM));
    assert.equal(ok(result).revision, 1);
    const seen = await bob.store.load(roomId);
    assert.equal(seen.revision, 1);
    assert.deepEqual(Object.keys(seen.doc.components).sort(), PAYMENT_SYSTEM.components.map((c) => c.id).sort());
    assert.deepEqual(seen.doc.history[0]!.by, { kind: 'human', id: alice.id, name: 'Alice' });
  });

  it('logs every saved command with who ran it, a person or Vowe', async () => {
    const { alice } = people;
    const hub = hubFor(alice);
    ok((await hub.executeAsAgent(roomId, command('highlight_component', { components: ['payment-worker'] }))).result);
    const { data, error } = await alice.cloud.from('room_canvas_ops').select('revision, actor_kind, created_by, command').eq('room_id', roomId).order('revision');
    assert.ifError(error);
    assert.deepEqual(data!.map((o) => [o.revision, o.actor_kind, o.created_by]), [[1, 'human', alice.id], [2, 'agent', alice.id]]);
    assert.equal((data![1]!.command as { name: string }).name, 'highlight_component');
  });

  it('refuses a save built on a stale revision, and the losing command is re-applied, not lost', async () => {
    const { alice, bob } = people;
    const stale = await bob.store.load(roomId);
    // Alice saves first.
    ok((await hubFor(alice).execute(roomId, command('annotate_component', { component: 'retry-queue', text: 'Retries stay reliable.' }))).result);
    // Bob's raw save on the old revision is refused by the database…
    const cmd = command('add_failure', { component: 'payment-worker', mode: 'crash' });
    assert.equal(await bob.store.commit(roomId, stale.revision, stale.doc, cmd, { kind: 'human', id: bob.id, name: 'Bob' }), null);
    // …and through the hub his command lands on top of Alice's.
    const { result, canvas } = await hubFor(bob).execute(roomId, cmd);
    assert.equal(ok(result).revision, stale.revision + 2);
    assert.equal(Object.values(canvas.doc.annotations).length, 1, 'Alice’s note survived');
    assert.equal(canvas.doc.views['failure-flow']!.steps!.length, 5);
  });

  it('two people saving at once both land, in some order', async () => {
    const { alice, bob } = people;
    const before = (await alice.store.load(roomId)).revision;
    const [a, b] = await Promise.all([
      hubFor(alice).execute(roomId, command('annotate_component', { component: 'payment-worker', text: 'Crash after charge?' })),
      hubFor(bob).execute(roomId, command('annotate_component', { component: 'payment-provider', text: 'Does it take a key?' })),
    ]);
    assert.deepEqual([ok(a.result).revision, ok(b.result).revision].sort(), [before + 1, before + 2]);
    const after = await alice.store.load(roomId);
    const texts = Object.values(after.doc.annotations).map((x) => x.kind === 'note' ? x.text : '');
    assert.ok(texts.includes('Crash after charge?') && texts.includes('Does it take a key?'));
  });

  it('keeps the canvas from anyone who isn’t an owner or member of the room', async () => {
    const { alice, carol, dave } = people;
    for (const outsider of [carol, dave]) {
      assert.equal((await outsider.store.load(roomId)).revision, 0, 'RLS shows them no canvas at all');
      // To them the canvas is empty, so they try what's valid on an empty canvas; the database refuses it.
      const { result } = await hubFor(outsider).execute(roomId, command('load_system', PAYMENT_SYSTEM));
      assert.equal(errorCode(result), 'permission-denied');
    }
    // Nobody writes the table directly, members included.
    const live = await alice.store.load(roomId);
    const direct = await alice.cloud.from('room_canvases').update({ revision: live.revision + 1 }).eq('room_id', roomId).select();
    assert.ok(direct.error || direct.data?.length === 0, 'a direct update changed nothing');
    assert.equal((await alice.store.load(roomId)).revision, live.revision);
  });

  it('lets a viewer read the canvas but not change it, and shows anyone signed out nothing', async () => {
    const { alice, erin } = people;
    const live = await alice.store.load(roomId);
    const seen = await erin.store.load(roomId);
    assert.equal(seen.revision, live.revision, 'a viewer reads the same canvas');
    const { result } = await hubFor(erin).execute(roomId, command('annotate_component', { component: 'payment-worker', text: 'Viewer note' }));
    assert.equal(errorCode(result), 'permission-denied');
    assert.equal((await alice.store.load(roomId)).revision, live.revision);
    const anon = createClient<Database>(url!, publishableKey!, { auth: { persistSession: false, autoRefreshToken: false } });
    const read = await anon.from('room_canvases').select('room_id').eq('room_id', roomId);
    assert.ok(read.error || read.data?.length === 0, 'signed out reads nothing');
    const ops = await anon.from('room_canvas_ops').select('revision').eq('room_id', roomId);
    assert.ok(ops.error || ops.data?.length === 0, 'signed out reads no commands');
    const rpc = await anon.rpc('commit_canvas', { room: roomId, base_revision: live.revision, document: live.doc as never, command: {} as never });
    assert.ok(rpc.error, 'signed out cannot save');
  });

  it('refuses a document the app didn’t make', async () => {
    const { alice } = people;
    const { revision } = await alice.store.load(roomId);
    const { error } = await alice.cloud.rpc('commit_canvas', {
      room: roomId, base_revision: revision, document: { schema: 'not-a-canvas' }, command: { schema: 'vowe.canvas.command/1', id: 'cmd-x', name: 'undo', args: {} },
    });
    assert.equal(toCanvasError(error).code, 'invalid');
  });

  it('tells the other member over Realtime, who re-reads the same canvas', async () => {
    const { alice, bob } = people;
    const heard: unknown[] = [];
    const aliceChannel = await channel(alice);
    await channel(bob, heard);
    const announce = async (_room: string, change: { revision: number; command: string; name: string }) => {
      const r = await aliceChannel.send({ type: 'broadcast', event: 'room-event', payload: { id: randomUUID(), type: 'canvas:changed', payload: change, senderId: alice.id, sentAt: new Date().toISOString() } });
      if (r !== 'ok') throw new Error(`not delivered: ${r}`);
    };
    const aliceHub = hubFor(alice, announce);
    const bobHub = hubFor(bob);
    await bobHub.load(roomId);
    const bobSaw: CanvasChange[] = [];
    bobHub.events.on('changed', (c) => bobSaw.push(c));

    const { result } = await aliceHub.execute(roomId, command('show_view', { view: 'concurrency', focus: 'payment-worker' }));
    const revision = ok(result).revision;
    await until(() => heard.length > 0, 'Bob to hear the change');
    const event = heard[0] as { type: string; payload: unknown };
    assert.equal(event.type, 'canvas:changed');
    const change = parseCanvasChanged(event.payload);
    assert.equal(change.revision, revision);

    await bobHub.remoteChanged(roomId, change.revision);
    assert.equal(bobSaw.length, 1);
    assert.equal(bobSaw[0]!.canvas.revision, revision);
    assert.equal(bobSaw[0]!.canvas.doc.activeView, 'concurrency');
    assert.deepEqual(buildScenes(bobSaw[0]!.canvas.doc).concurrency!.nodes.map((n) => n.key), ['retry-queue', 'payment-worker', 'payment-worker#2', 'payment-provider']);
  });

  it('carries presence between members, and keeps outsiders off the channel', async () => {
    const { alice, bob, dave } = people;
    await alice.cloud.removeAllChannels();
    await bob.cloud.removeAllChannels();
    const heard: unknown[] = [];
    await channel(bob, heard);
    const aliceChannel = await channel(alice);
    const presence = parsePresence({ view: 'concurrency', cursor: { x: 700, y: 300 }, selection: [{ component: 'payment-worker', instance: 2 }], tool: 'circle' });
    await aliceChannel.send({ type: 'broadcast', event: 'room-event', payload: { id: randomUUID(), type: 'canvas:presence', payload: presence, senderId: alice.id, sentAt: new Date().toISOString() } });
    await until(() => heard.some((e) => (e as { type: string }).type === 'canvas:presence'), 'Bob to see Alice’s pen');
    const got = heard.find((e) => (e as { type: string }).type === 'canvas:presence') as { payload: unknown };
    assert.deepEqual(parsePresence(got.payload), presence);
    await assert.rejects(channel(dave), 'Dave isn’t admitted to the room’s channel');
  });

  it('survives a restart: a fresh session reads the same canvas and draws the same views', async () => {
    const { alice } = people;
    const before: StoredCanvas = await alice.store.load(roomId);
    const restarted = await signIn(alice.email);
    const after = await createCanvasStore(async () => restarted).load(roomId);
    assert.equal(after.revision, before.revision);
    assert.deepEqual(after.doc, before.doc);
    assert.deepEqual(JSON.stringify(buildScenes(after.doc)), JSON.stringify(buildScenes(before.doc)));
    const ctx = canvasContext(after, null);
    assert.equal(ctx.activeView, 'concurrency');
    assert.ok(ctx.components.some((c) => c.id === 'payment-worker'));
    await restarted.auth.signOut({ scope: 'local' });
  });
});
