import { createClient } from '@supabase/supabase-js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { RoomErrorCode } from '../../shared/api.js';
import type { Cloud } from './index.js';
import { createRoomService, repositoryIdentity, RoomError, toRoomError, type RoomService } from './rooms.js';
import type { Database } from './types.js';

// Unit tests always run. The integration tests run against a local Supabase stack with the migrations
// applied (docs/rooms.md), as several real signed-in users, and are skipped without one:
//
//   ROOMS_TEST_SUPABASE_URL=http://127.0.0.1:54321 ROOMS_TEST_SUPABASE_PUBLISHABLE_KEY=… \
//   ROOMS_TEST_SUPABASE_SECRET_KEY=… pnpm test
//
// They create throwaway users and delete them afterwards, so they refuse any URL but localhost.

const url = process.env.ROOMS_TEST_SUPABASE_URL;
const publishableKey = process.env.ROOMS_TEST_SUPABASE_PUBLISHABLE_KEY;
const secretKey = process.env.ROOMS_TEST_SUPABASE_SECRET_KEY;
const local = Boolean(url && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url));
if (url && !local) throw new Error('ROOMS_TEST_SUPABASE_URL must be a local stack (http://127.0.0.1:…), never a hosted project');
const integration = local && publishableKey && secretKey ? {} : { skip: 'set ROOMS_TEST_SUPABASE_* to run against a local stack' };

async function rejectsWith(promise: Promise<unknown>, code: RoomErrorCode) {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof RoomError, `expected a RoomError, got ${String(err)}`);
    assert.equal(err.code, code, err.message);
    return true;
  });
}

describe('repositoryIdentity', () => {
  it('reduces remotes to host and path', () => {
    for (const remote of [
      'git@github.com:Acme/Payments.git',
      'https://github.com/Acme/Payments',
      'https://github.com/Acme/Payments.git/',
      'https://user:token@GitHub.com/Acme/Payments.git',
      'ssh://git@github.com:22/Acme/Payments.git',
      'github.com/Acme/Payments',
    ]) {
      assert.equal(repositoryIdentity(remote), 'github.com/Acme/Payments', remote);
    }
    assert.equal(repositoryIdentity('acme/payments'), 'acme/payments');
    assert.equal(repositoryIdentity('git@gitlab.example.com:group/sub/project.git'), 'gitlab.example.com/group/sub/project');
  });

  it('refuses local paths and file URLs', () => {
    for (const path of [
      '/Users/dee/projects/journey',
      '~/projects/journey',
      './journey',
      '../journey',
      'C:\\code\\journey',
      'C:/code/journey',
      'file:///Users/dee/projects/journey',
      'journey',
      '',
      'github.com/acme/../secrets',
      'has space/repo',
    ]) {
      assert.equal(repositoryIdentity(path), null, path);
    }
  });
});

describe('toRoomError', () => {
  it('maps Postgres and network failures to codes', () => {
    assert.equal(toRoomError({ code: '42501', message: 'new row violates row-level security policy' }).code, 'permission-denied');
    assert.equal(toRoomError({ code: 'VR001', message: 'A room needs an owner' }).code, 'conflict');
    assert.equal(toRoomError({ code: '23514', message: 'check' }).code, 'invalid');
    assert.equal(toRoomError({ code: 'PGRST301', message: 'JWT expired' }).code, 'signed-out');
    assert.equal(toRoomError({ code: '', message: 'TypeError: fetch failed' }).code, 'network');
    assert.equal(toRoomError(new TypeError('fetch failed')).code, 'network');
    assert.equal(toRoomError({ name: 'AuthRetryableFetchError', message: 'Failed to fetch', status: 0 }).code, 'network');
    assert.equal(toRoomError(new Error('boom')).code, 'unknown');
    const mapped = new RoomError('not-found', 'gone');
    assert.equal(toRoomError(mapped), mapped);
  });
});

describe('room service without a usable session', () => {
  it('reports invalid ids before any request', async () => {
    const service = createRoomService(() => Promise.reject(new Error('should not be called')));
    await rejectsWith(service.getRoom('not-a-uuid'), 'invalid');
    await rejectsWith(service.createRoom({ workspaceId: randomUUID(), name: '   ' }), 'invalid');
    await rejectsWith(service.createRoom(null as never), 'invalid');
    await rejectsWith(service.updateRoom(randomUUID(), { repository: '/Users/dee/journey' }), 'invalid');
  });

  it('passes on the client source’s RoomError', async () => {
    const service = createRoomService(() => Promise.reject(new RoomError('not-configured', 'no Supabase')));
    await rejectsWith(service.listRooms(), 'not-configured');
  });
});

describe('persistent rooms (local Supabase)', integration, () => {
  const run = randomUUID().slice(0, 8);
  const password = `pw-${randomUUID()}`;
  const admin = () =>
    createClient<Database>(url!, secretKey!, { auth: { persistSession: false, autoRefreshToken: false } });

  /** A fresh client and session, as a restarted app would have. */
  async function signIn(email: string, fetchImpl?: typeof fetch): Promise<Cloud> {
    const client = createClient<Database>(url!, publishableKey!, {
      auth: { persistSession: false, autoRefreshToken: false },
      ...(fetchImpl ? { global: { fetch: fetchImpl } } : {}),
    });
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return client;
  }

  interface Person {
    id: string;
    email: string;
    cloud: Cloud;
    rooms: RoomService;
  }
  const people: Record<'alice' | 'bob' | 'carol' | 'dave', Person> = {} as never;
  let workspaceId: string;

  before(async () => {
    for (const name of ['alice', 'bob', 'carol', 'dave'] as const) {
      const email = `${name}-${run}@rooms.test`;
      const { data, error } = await admin().auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: name[0]!.toUpperCase() + name.slice(1) },
      });
      if (error) throw error;
      const cloud = await signIn(email);
      people[name] = { id: data.user.id, email, cloud, rooms: createRoomService(async () => cloud) };
    }
    // Alice's workspace has Bob and Carol; Dave is in none of hers.
    const { alice, bob, carol } = people;
    const { data: ws, error } = await alice.cloud.from('workspaces').insert({ name: `Rooms ${run}` }).select().single();
    if (error) throw error;
    workspaceId = ws.id;
    const { error: addError } = await alice.cloud.from('workspace_members').insert([
      { workspace_id: workspaceId, user_id: bob.id },
      { workspace_id: workspaceId, user_id: carol.id },
    ]);
    if (addError) throw addError;
  });

  after(async () => {
    for (const person of Object.values(people)) {
      await person.cloud.removeAllChannels();
      await admin().auth.admin.deleteUser(person.id); // cascades to their workspaces, rooms, memberships
    }
  });

  it('creates a room owned by its creator and reads it back', async () => {
    const { alice } = people;
    const room = await alice.rooms.createRoom({
      workspaceId,
      name: '  Payment Reliability  ',
      goal: 'Stop double charges',
      repository: 'git@github.com:Acme/Payments.git',
    });
    assert.match(room.id, /^[0-9a-f-]{36}$/);
    assert.equal(room.name, 'Payment Reliability');
    assert.equal(room.goal, 'Stop double charges');
    assert.equal(room.repository, 'github.com/Acme/Payments');
    assert.equal(room.workspaceId, workspaceId);
    assert.equal(room.createdBy, alice.id);
    assert.equal(room.role, 'owner');
    assert.equal(room.memberCount, 1);
    assert.ok(Date.parse(room.createdAt) && Date.parse(room.updatedAt));

    assert.deepEqual(await alice.rooms.getRoom(room.id), room);
    const listed = await alice.rooms.listRooms(workspaceId);
    assert.ok(listed.some((r) => r.id === room.id && r.role === 'owner'));
    const members = await alice.rooms.listMembers(room.id);
    assert.deepEqual(
      members.map((m) => [m.userId, m.role, m.name]),
      [[alice.id, 'owner', 'Alice']],
    );
  });

  it('survives signing out and back in, as after restarting the app', async () => {
    const { alice } = people;
    const created = await alice.rooms.createRoom({ workspaceId, name: 'Survives restarts' });
    await alice.cloud.auth.signOut({ scope: 'local' });
    const restarted = await signIn(alice.email);
    alice.cloud = restarted;
    alice.rooms = createRoomService(async () => restarted);

    const reopened = await alice.rooms.getRoom(created.id);
    assert.equal(reopened.id, created.id);
    assert.equal(reopened.name, 'Survives restarts');
    assert.equal(reopened.createdAt, created.createdAt);
    assert.ok((await alice.rooms.listRooms()).some((r) => r.id === created.id));
  });

  it('lets an owner add a workspace member, who then shares the room', async () => {
    const { alice, bob } = people;
    const room = await alice.rooms.createRoom({ workspaceId, name: 'Shared' });
    const added = await alice.rooms.addMember(room.id, bob.id);
    assert.equal(added.role, 'member');
    assert.equal(added.email, bob.email);
    // Adding again is a no-op that returns the same member.
    assert.deepEqual(await alice.rooms.addMember(room.id, bob.id), added);

    const seen = await bob.rooms.getRoom(room.id);
    assert.equal(seen.role, 'member');
    assert.equal(seen.memberCount, 2);
    assert.ok((await bob.rooms.listRooms()).some((r) => r.id === room.id));
    assert.deepEqual(
      (await bob.rooms.listMembers(room.id)).map((m) => [m.userId, m.role]),
      [
        [alice.id, 'owner'],
        [bob.id, 'member'],
      ],
    );
  });

  it('keeps room changes and membership to owners', async () => {
    const { alice, bob, carol } = people;
    const room = await alice.rooms.createRoom({ workspaceId, name: 'Owner rules' });
    await alice.rooms.addMember(room.id, bob.id);

    await rejectsWith(bob.rooms.updateRoom(room.id, { name: 'Bob’s now' }), 'permission-denied');
    await rejectsWith(bob.rooms.addMember(room.id, carol.id), 'permission-denied');
    await rejectsWith(bob.rooms.removeMember(room.id, alice.id), 'permission-denied');
    await rejectsWith(bob.rooms.setMemberRole(room.id, bob.id, 'owner'), 'permission-denied');
    await rejectsWith(bob.rooms.deleteRoom(room.id), 'permission-denied');

    // The same writes made directly, bypassing the service, are refused by the database.
    const direct = await bob.cloud.from('rooms').update({ name: 'Direct' }).eq('id', room.id).select();
    assert.deepEqual(direct.data, []);
    const promote = await bob.cloud.from('room_members').update({ role: 'owner' }).eq('room_id', room.id).select();
    assert.deepEqual(promote.data, []);
    const invite = await bob.cloud.from('room_members').insert({ room_id: room.id, user_id: carol.id });
    assert.equal(invite.error?.code, '42501');
    const reassign = await alice.cloud.from('rooms').update({ created_by: bob.id } as never).eq('id', room.id);
    assert.equal(reassign.error?.code, '42501'); // only name, goal and repository are writable

    await new Promise((r) => setTimeout(r, 5)); // so updated_at visibly moves
    const renamed = await alice.rooms.updateRoom(room.id, { name: 'Renamed', goal: 'A goal', repository: null });
    assert.equal(renamed.name, 'Renamed');
    assert.equal(renamed.goal, 'A goal');
    assert.ok(renamed.updatedAt > room.updatedAt);
    assert.equal((await bob.rooms.getRoom(room.id)).name, 'Renamed');
  });

  it('hides rooms from people who are not members', async () => {
    const { alice, bob, carol, dave } = people;
    const room = await alice.rooms.createRoom({ workspaceId, name: 'Private' });
    await alice.rooms.addMember(room.id, bob.id);

    // Carol is in the workspace, Dave isn't; neither is in the room.
    for (const outsider of [carol, dave]) {
      await rejectsWith(outsider.rooms.getRoom(room.id), 'not-found');
      await rejectsWith(outsider.rooms.listMembers(room.id), 'not-found');
      await rejectsWith(outsider.rooms.updateRoom(room.id, { name: 'Mine' }), 'not-found');
      await rejectsWith(outsider.rooms.deleteRoom(room.id), 'not-found');
      await rejectsWith(outsider.rooms.addMember(room.id, outsider.id), 'not-found');
      await rejectsWith(outsider.rooms.removeMember(room.id, bob.id), 'not-found');
      assert.ok(!(await outsider.rooms.listRooms()).some((r) => r.id === room.id));

      // Straight at the tables: nothing to read, nothing to change.
      assert.deepEqual((await outsider.cloud.from('rooms').select().eq('id', room.id)).data, []);
      assert.deepEqual((await outsider.cloud.from('room_members').select().eq('room_id', room.id)).data, []);
      const selfAdd = await outsider.cloud.from('room_members').insert({ room_id: room.id, user_id: outsider.id });
      assert.equal(selfAdd.error?.code, '42501');
      const kick = await outsider.cloud.from('room_members').delete().eq('room_id', room.id).select();
      assert.deepEqual(kick.data, []);
    }
    assert.equal((await alice.rooms.listMembers(room.id)).length, 2);
    assert.equal((await alice.rooms.getRoom(room.id)).name, 'Private');

    // Only workspace members can be added, even by an owner.
    await rejectsWith(alice.rooms.addMember(room.id, dave.id), 'invalid');
    // A workspace Dave isn't in is as good as missing to him.
    await rejectsWith(dave.rooms.createRoom({ workspaceId, name: 'Sneaky' }), 'not-found');
  });

  it('admits members, and only members, to the room’s live channel', async () => {
    const { alice, bob, carol } = people;
    const room = await alice.rooms.createRoom({ workspaceId, name: 'Live' });
    await alice.rooms.addMember(room.id, bob.id);

    const subscribe = (cloud: Cloud) =>
      new Promise<string>((resolve) => {
        const channel = cloud.channel(`room:${room.id}`, { config: { private: true } });
        const timer = setTimeout(() => resolve('TIMED_OUT'), 8000);
        channel.subscribe((status) => {
          if (status === 'SUBSCRIBED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            clearTimeout(timer);
            void cloud.removeChannel(channel);
            resolve(status);
          }
        });
      });
    assert.equal(await subscribe(bob.cloud), 'SUBSCRIBED');
    assert.notEqual(await subscribe(carol.cloud), 'SUBSCRIBED');
  });

  it('lets members leave and owners remove them, but never the last owner', async () => {
    const { alice, bob, carol } = people;
    const room = await alice.rooms.createRoom({ workspaceId, name: 'Comings and goings' });
    await alice.rooms.addMember(room.id, bob.id);
    await alice.rooms.addMember(room.id, carol.id);

    await bob.rooms.removeMember(room.id); // leaves
    await rejectsWith(bob.rooms.getRoom(room.id), 'not-found');
    await alice.rooms.removeMember(room.id, carol.id); // removed
    await rejectsWith(carol.rooms.getRoom(room.id), 'not-found');
    await rejectsWith(alice.rooms.removeMember(room.id, carol.id), 'not-found');

    await rejectsWith(alice.rooms.removeMember(room.id), 'conflict');
    await rejectsWith(alice.rooms.setMemberRole(room.id, alice.id, 'member'), 'conflict');

    // Hand ownership on, then the old owner can step down and leave.
    await alice.rooms.addMember(room.id, bob.id, 'owner');
    await alice.rooms.setMemberRole(room.id, alice.id, 'member');
    await rejectsWith(alice.rooms.updateRoom(room.id, { name: 'Not mine now' }), 'permission-denied');
    await alice.rooms.removeMember(room.id);
    assert.equal((await bob.rooms.getRoom(room.id)).role, 'owner');
    await rejectsWith(alice.rooms.getRoom(room.id), 'not-found');

    // Deleting the room takes its last owner's membership with it.
    await bob.rooms.deleteRoom(room.id);
    await rejectsWith(bob.rooms.getRoom(room.id), 'not-found');
  });

  it('cuts off a member removed from the workspace', async () => {
    const { alice, carol } = people;
    const room = await alice.rooms.createRoom({ workspaceId, name: 'Workspace bound' });
    await alice.rooms.addMember(room.id, carol.id);
    assert.equal((await carol.rooms.getRoom(room.id)).role, 'member');

    const { error } = await alice.cloud.from('workspace_members').delete().eq('workspace_id', workspaceId).eq('user_id', carol.id);
    assert.equal(error, null);
    await rejectsWith(carol.rooms.getRoom(room.id), 'not-found');
    assert.ok(!(await carol.rooms.listRooms()).some((r) => r.id === room.id));
  });

  it('never stores a local path as the repository', async () => {
    const { alice } = people;
    await rejectsWith(alice.rooms.createRoom({ workspaceId, name: 'Local', repository: '/Users/alice/payments' }), 'invalid');
    // Even straight at the table, the database refuses paths.
    for (const repository of ['/Users/alice/payments', 'C:\\code\\payments', 'file:///Users/alice/payments']) {
      const { error } = await alice.cloud.from('rooms').insert({ workspace_id: workspaceId, name: 'Local', repository });
      assert.equal(error?.code, '23514', repository);
    }
  });

  it('opens a room without connecting to anything', async () => {
    const { alice } = people;
    const room = await alice.rooms.createRoom({ workspaceId, name: 'Quiet' });
    await alice.rooms.getRoom(room.id);
    await alice.rooms.listMembers(room.id);
    assert.equal(alice.cloud.getChannels().length, 0);
  });

  it('reports network failures and lost sessions', async () => {
    const { bob } = people;
    let offline = false;
    const flaky: typeof fetch = (input, init) =>
      offline ? Promise.reject(new TypeError('fetch failed')) : fetch(input, init);
    const cloud = await signIn(bob.email, flaky);
    const rooms = createRoomService(async () => cloud);
    await rooms.listRooms();
    offline = true;
    await rejectsWith(rooms.listRooms(), 'network');
    await rejectsWith(rooms.getRoom(randomUUID()), 'network');

    const signedOut = createClient<Database>(url!, publishableKey!, { auth: { persistSession: false } });
    await rejectsWith(createRoomService(async () => signedOut).listRooms(), 'signed-out');
  });

  it('links repositories to the Space, for its members only', async () => {
    const { alice, bob, carol, dave } = people;
    // An earlier test removed Carol from the workspace; she's a plain member again from here.
    const { error: back } = await alice.cloud.from('workspace_members').insert({ workspace_id: workspaceId, user_id: carol.id });
    assert.equal(back, null);
    const linked = await alice.rooms.linkRepository(workspaceId, 'git@github.com:Acme/Payments.git');
    assert.equal(linked.repository, 'github.com/Acme/Payments');
    assert.equal(linked.addedBy, alice.id);
    // The same repository again, spelled differently, is still one row.
    const again = await bob.rooms.linkRepository(workspaceId, 'https://GitHub.com/Acme/Payments');
    assert.equal(again.addedBy, alice.id);
    await bob.rooms.linkRepository(workspaceId, 'github.com/Acme/Ledger');
    assert.deepEqual((await carol.rooms.listSpaceRepositories(workspaceId)).map((r) => r.repository), ['github.com/Acme/Payments', 'github.com/Acme/Ledger']);

    // Outside the Space there's nothing to read or link; local paths never become Space data.
    assert.deepEqual(await dave.rooms.listSpaceRepositories(workspaceId), []);
    await rejectsWith(dave.rooms.linkRepository(workspaceId, 'github.com/Acme/Sneaky'), 'not-found');
    await rejectsWith(alice.rooms.linkRepository(workspaceId, '/Users/alice/payments'), 'invalid');

    // Whoever linked one, or a Space owner, unlinks it.
    await rejectsWith(carol.rooms.unlinkRepository(workspaceId, 'github.com/Acme/Payments'), 'permission-denied');
    await rejectsWith(bob.rooms.unlinkRepository(workspaceId, 'github.com/Acme/Payments'), 'permission-denied');
    await bob.rooms.unlinkRepository(workspaceId, 'github.com/Acme/Ledger');
    await rejectsWith(bob.rooms.unlinkRepository(workspaceId, 'github.com/Acme/Ledger'), 'not-found');
    await alice.rooms.unlinkRepository(workspaceId, 'github.com/Acme/Payments');
    assert.deepEqual(await alice.rooms.listSpaceRepositories(workspaceId), []);
  });

  it('starts rooms quick, and keeps them when asked or once they hold a decision', async () => {
    const { alice, bob, carol, dave } = people;
    const room = await alice.rooms.createRoom({ workspaceId, name: 'Quick look' });
    assert.equal(room.keptAt, null);
    await alice.rooms.addMember(room.id, bob.id);
    await alice.rooms.addMember(room.id, carol.id, 'viewer');

    const kept = await bob.rooms.keepRoom(room.id, true);
    assert.ok(kept.keptAt);
    assert.equal((await bob.rooms.keepRoom(room.id, true)).keptAt, kept.keptAt, 'keeping twice keeps the first time');
    await rejectsWith(carol.rooms.keepRoom(room.id, false), 'permission-denied');
    await rejectsWith(dave.rooms.keepRoom(room.id, false), 'not-found');
    // Not by writing the column directly either: only owners update rooms, and only through keep_room for members.
    const direct = await bob.cloud.from('rooms').update({ kept_at: null }).eq('id', room.id).select();
    assert.ok(direct.error || !direct.data?.length, 'a member can’t write kept_at directly');
    assert.equal((await bob.rooms.getRoom(room.id)).keptAt, kept.keptAt);
    assert.equal((await alice.rooms.keepRoom(room.id, false)).keptAt, null);

    const { error } = await bob.cloud.from('room_decisions').insert({ room_id: room.id, title: 'Retry with backoff', verify: 'No duplicate charges' });
    assert.equal(error, null);
    assert.ok((await alice.rooms.getRoom(room.id)).keptAt, 'a decision keeps the room');
  });

  it('pins and archives rooms for one person only, and pinning keeps a quick room', async () => {
    const { alice, bob, carol, dave } = people;
    const room = await alice.rooms.createRoom({ workspaceId, name: 'Pin me' });
    await alice.rooms.addMember(room.id, bob.id);
    await alice.rooms.addMember(room.id, carol.id, 'viewer');

    const pinned = await bob.rooms.pinRoom(room.id, 2.5);
    assert.equal(pinned.pinOrder, 2.5);
    assert.ok(pinned.keptAt, 'pinning keeps a quick room');
    assert.equal((await alice.rooms.getRoom(room.id)).pinOrder, null, 'nobody else’s sidebar changes');
    assert.equal((await bob.rooms.listRooms()).find((r) => r.id === room.id)?.pinOrder, 2.5);

    // A viewer pins too, but can't keep the room by it.
    await alice.rooms.keepRoom(room.id, false);
    assert.equal((await carol.rooms.pinRoom(room.id, 1)).keptAt, null);
    await rejectsWith(dave.rooms.pinRoom(room.id, 1), 'not-found');
    await rejectsWith(bob.rooms.pinRoom(room.id, Number.NaN), 'invalid');

    // Archiving unpins; unarchiving brings it back unpinned. Pinning an archived room brings it back.
    const archived = await bob.rooms.archiveRoom(room.id, true);
    assert.ok(archived.archivedAt);
    assert.equal(archived.pinOrder, null);
    assert.equal((await alice.rooms.getRoom(room.id)).archivedAt, null);
    assert.equal((await bob.rooms.archiveRoom(room.id, false)).archivedAt, null);
    await bob.rooms.archiveRoom(room.id, true);
    const back = await bob.rooms.pinRoom(room.id, 1);
    assert.equal(back.archivedAt, null);
    assert.equal((await bob.rooms.pinRoom(room.id, null)).pinOrder, null);
    await rejectsWith(dave.rooms.archiveRoom(room.id, true), 'not-found');

    // Not by writing your membership directly: members change it only through these.
    const direct = await bob.cloud.from('room_members').update({ pin_order: 9 }).eq('room_id', room.id).eq('user_id', bob.id).select();
    assert.ok(direct.error || !direct.data?.length, 'a member can’t write their membership directly');
  });

  it('attaches coding sessions to a room: members see them, only their machine publishes what they do', async () => {
    const { alice, bob, carol, dave } = people;
    await alice.rooms.linkRepository(workspaceId, 'github.com/Acme/Web');
    const room = await alice.rooms.createRoom({ workspaceId, name: 'Sessions' });
    await alice.rooms.addMember(room.id, bob.id);
    await alice.rooms.addMember(room.id, carol.id, 'viewer');
    const one = '0a1b2c3d-0000-4000-8000-000000000001', two = '0a1b2c3d-0000-4000-8000-000000000002';

    const attached = await bob.rooms.attachSession(room.id, {
      sessionId: one, repository: 'git@github.com:Acme/Web.git', title: 'Fix the join sheet', branch: 'fix/join', status: 'active', activity: 'Edited sheet.tsx', changedFiles: 3,
    });
    assert.equal(attached.repository, 'github.com/Acme/Web');
    assert.equal(attached.attachedBy, bob.id);
    assert.equal(attached.status, 'active');
    // Attaching it again leaves it as it was.
    assert.equal((await bob.rooms.attachSession(room.id, { sessionId: one, repository: 'github.com/Acme/Web', title: 'Renamed', branch: null })).title, 'Fix the join sheet');
    const seen = await carol.rooms.listSessions(room.id);
    assert.deepEqual(seen.map((s) => [s.sessionId, s.title, s.changedFiles]), [[one, 'Fix the join sheet', 3]], 'viewers see the room’s sessions');

    // Viewers don't attach; nor does anyone outside the room, or from outside the Space's repositories.
    await rejectsWith(carol.rooms.attachSession(room.id, { sessionId: two, repository: 'github.com/Acme/Web', title: 'Mine', branch: null }), 'permission-denied');
    await rejectsWith(bob.rooms.attachSession(room.id, { sessionId: two, repository: 'github.com/Acme/Elsewhere', title: 'Mine', branch: null }), 'invalid');
    await rejectsWith(dave.rooms.attachSession(room.id, { sessionId: two, repository: 'github.com/Acme/Web', title: 'Mine', branch: null }), 'not-found');
    await rejectsWith(dave.rooms.listSessions(room.id), 'not-found');
    await rejectsWith(bob.rooms.attachSession(room.id, { sessionId: 'not-a-session', repository: 'github.com/Acme/Web', title: 'x', branch: null }), 'invalid');

    // Only whoever attached it publishes what it's doing, and nothing else about it changes.
    await rejectsWith(alice.rooms.reportSession(room.id, one, { status: 'attention', activity: null, changedFiles: null }), 'permission-denied');
    await bob.rooms.reportSession(room.id, one, { status: 'attention', activity: 'Allow pnpm test?', changedFiles: 4 });
    const [now] = await alice.rooms.listSessions(room.id);
    assert.deepEqual([now!.status, now!.activity, now!.changedFiles], ['attention', 'Allow pnpm test?', 4]);
    assert.ok(now!.statusAt);
    const moved = await bob.cloud.from('room_sessions').update({ repository: 'github.com/Acme/Other' }).eq('session_id', one).select();
    assert.ok(moved.error || !moved.data?.length, 'a session’s repository is fixed once attached');
    assert.equal(now!.agent, 'claude-code', 'sessions are Claude Code’s unless attached as another agent');
    const recast = await bob.cloud.from('room_sessions').update({ agent: 'codex' }).eq('session_id', one).select();
    assert.ok(recast.error || !recast.data?.length, 'a session’s agent is fixed once attached');

    // A waiting session says what it waits for, and only a waiting one does; its machine says when it last saw it.
    const seenAt = '2026-10-28T12:00:00.000Z';
    await bob.rooms.reportSession(room.id, one, { status: 'waiting', waitingOn: 'permission', lastSeenAt: seenAt, activity: 'Asked: Claude needs your permission to use Bash', changedFiles: 4 });
    const [waiting] = await carol.rooms.listSessions(room.id);
    assert.deepEqual([waiting!.status, waiting!.waitingOn, Date.parse(waiting!.lastSeenAt!)], ['waiting', 'permission', Date.parse(seenAt)]);
    await rejectsWith(bob.rooms.reportSession(room.id, one, { status: 'waiting', activity: null, changedFiles: null }), 'invalid');
    await rejectsWith(bob.rooms.reportSession(room.id, one, { status: 'active', waitingOn: 'input', activity: null, changedFiles: null }), 'invalid');
    const unpaired = await bob.cloud.from('room_sessions').update({ status: 'waiting', waiting_on: null }).eq('session_id', one).select();
    assert.ok(unpaired.error, 'the database refuses a waiting session that doesn’t say what for');
    await bob.rooms.reportSession(room.id, one, { status: 'active', activity: 'Used Bash: pnpm test', changedFiles: 4 });
    const [moving] = await alice.rooms.listSessions(room.id);
    assert.deepEqual([moving!.status, moving!.waitingOn], ['active', null], 'it waits on nothing once it moves on');

    // Whoever attached it, or an owner, detaches it.
    const second = await bob.rooms.attachSession(room.id, { sessionId: two, agent: 'codex', repository: 'github.com/Acme/Web', title: 'Second', branch: 'b' });
    assert.equal(second.agent, 'codex');
    await rejectsWith(carol.rooms.detachSession(room.id, one), 'permission-denied');
    await alice.rooms.detachSession(room.id, one);
    await bob.rooms.detachSession(room.id, two);
    assert.deepEqual(await bob.rooms.listSessions(room.id), []);
    await alice.rooms.unlinkRepository(workspaceId, 'github.com/Acme/Web');
  });
});
