import { createClient } from '@supabase/supabase-js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { MembershipErrorCode } from '../../shared/api.js';
import type { Cloud } from './index.js';
import { createInvitationService, inviteUrl, parseInviteToken, type InvitationService } from './invitations.js';
import { createRoomRecordService } from './record.js';
import { createRoomService, RoomError, type RoomService } from './rooms.js';
import type { Database } from './types.js';

// Unit tests always run. The integration tests run against a local Supabase stack with the migrations
// applied, as real signed-in users, and are skipped without one (same variables as rooms.test.ts):
//
//   ROOMS_TEST_SUPABASE_URL=http://127.0.0.1:54321 ROOMS_TEST_SUPABASE_PUBLISHABLE_KEY=… \
//   ROOMS_TEST_SUPABASE_SECRET_KEY=… pnpm test

const url = process.env.ROOMS_TEST_SUPABASE_URL;
const publishableKey = process.env.ROOMS_TEST_SUPABASE_PUBLISHABLE_KEY;
const secretKey = process.env.ROOMS_TEST_SUPABASE_SECRET_KEY;
const local = Boolean(url && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url));
if (url && !local) throw new Error('ROOMS_TEST_SUPABASE_URL must be a local stack (http://127.0.0.1:…), never a hosted project');
const integration = local && publishableKey && secretKey ? {} : { skip: 'set ROOMS_TEST_SUPABASE_* to run against a local stack' };

async function refusedWith(promise: Promise<unknown>, reason: MembershipErrorCode) {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof RoomError, `expected a RoomError, got ${String(err)}`);
    assert.equal(err.reason, reason, err.message);
    return true;
  });
}

describe('invite links', () => {
  const token = 'AbCdEfGhIjKlMnOpQrSt_-';

  it('finds the token in whatever was pasted', () => {
    assert.equal(inviteUrl(token), `vowe://join/${token}`);
    assert.equal(parseInviteToken(`vowe://join/${token}`), token);
    assert.equal(parseInviteToken(`  Join me: vowe://join/${token} thanks`), token);
    assert.equal(parseInviteToken(`https://vowe.app/j/${token}`), token);
    assert.equal(parseInviteToken(token), token);
  });

  it('finds nothing in anything else', () => {
    for (const text of ['', 'hello', `vowe://join/${token}x`, token.slice(1), 'vowe://join/short', `${token} ${token}`]) {
      assert.equal(parseInviteToken(text), null, text);
    }
  });

  it('refuses malformed ids and keys before any request', async () => {
    const service = createInvitationService(() => Promise.reject(new Error('should not be called')));
    await assert.rejects(service.list('room-1'), (err: RoomError) => err.code === 'invalid');
    await assert.rejects(service.send(randomUUID(), [], 'member'), (err: RoomError) => err.reason === 'invalid_email');
    await assert.rejects(service.createLink(randomUUID(), { role: 'owner', expiry: '7d', domain: null }), (err: RoomError) => err.reason === 'not_permitted');
    await assert.rejects(service.revoke('nope'), (err: RoomError) => err.code === 'invalid');
  });
});

describe('room invitations (local Supabase)', integration, () => {
  const run = randomUUID().slice(0, 8);
  const password = `pw-${randomUUID()}`;
  const admin = () => createClient<Database>(url!, secretKey!, { auth: { persistSession: false, autoRefreshToken: false } });

  interface Person {
    id: string;
    email: string;
    cloud: Cloud;
    rooms: RoomService;
    invites: InvitationService;
  }
  const people: Record<'owner' | 'john' | 'srikar' | 'maya' | 'stranger', Person> = {} as never;
  let roomId: string;

  async function person(name: string, domain: string): Promise<Person> {
    const email = `${name}-${run}@${domain}`;
    const { data, error } = await admin().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: name[0]!.toUpperCase() + name.slice(1) },
    });
    if (error) throw error;
    const cloud = createClient<Database>(url!, publishableKey!, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error: signInError } = await cloud.auth.signInWithPassword({ email, password });
    if (signInError) throw signInError;
    const source = async () => cloud;
    return { id: data.user.id, email, cloud, rooms: createRoomService(source), invites: createInvitationService(source) };
  }

  before(async () => {
    people.owner = await person('daniel', 'acme.test');
    people.john = await person('john', 'acme.test');
    people.srikar = await person('srikar', 'acme.test');
    people.maya = await person('maya', 'elsewhere.test');
    people.stranger = await person('stranger', 'acme.test');
    const { data: ws, error } = await people.owner.cloud.from('workspaces').insert({ name: `Invites ${run}` }).select().single();
    if (error) throw error;
    roomId = (await people.owner.rooms.createRoom({ workspaceId: ws.id, name: 'Payment Reliability', goal: 'Stop double charges' })).id;
  });

  after(async () => {
    for (const p of Object.values(people)) await admin().auth.admin.deleteUser(p.id);
  });

  it('lets only owners invite', async () => {
    await refusedWith(people.john.invites.send(roomId, [people.john.email], 'member'), 'not_permitted');
    await refusedWith(people.john.invites.createLink(roomId, { role: 'member', expiry: '7d', domain: null }), 'not_permitted');
    await refusedWith(people.owner.invites.send(roomId, ['not an email'], 'member'), 'invalid_email');
  });

  it('invites by email; only that signed-in address can see and accept it, and accepting never joins the call', async () => {
    const { owner, john, stranger } = people;
    const [sent] = await owner.invites.send(roomId, [john.email.toUpperCase()], 'member');
    assert.equal(sent?.email, john.email);
    assert.equal(sent?.status, 'pending');
    assert.ok(!('token_hash' in (sent as object)));

    // Nobody else can find it by id; John finds it waiting for him.
    assert.deepEqual(await stranger.invites.mine(), []);
    assert.deepEqual(await stranger.invites.resolve({ invitationId: sent!.id }), { kind: 'error', error: 'invite_not_found' });
    await refusedWith(stranger.invites.accept({ invitationId: sent!.id }), 'invite_not_found');
    const [waiting] = await john.invites.mine();
    assert.equal(waiting?.id, sent!.id);
    assert.equal(waiting?.roomName, 'Payment Reliability');
    assert.equal(waiting?.inviterName, 'Daniel');

    const preview = await john.invites.resolve({ invitationId: sent!.id });
    assert.equal(preview.kind, 'preview');
    if (preview.kind !== 'preview') return;
    assert.equal(preview.invite.boundEmail, `j•••@acme.test`);
    assert.equal(preview.room.goal, 'Stop double charges');
    assert.deepEqual(preview.room.members.map((m) => m.name), ['Daniel']);

    assert.equal(await john.invites.accept({ invitationId: sent!.id }), roomId);
    const members = await owner.rooms.listMembers(roomId);
    assert.deepEqual(members.map((m) => [m.userId, m.role]).sort(), [[owner.id, 'owner'], [john.id, 'member']].sort());
    // Single use, and a second accept is harmless.
    assert.equal(await john.invites.accept({ invitationId: sent!.id }), roomId);
    const [after] = await owner.invites.list(roomId);
    assert.equal(after?.status, 'accepted');
    assert.deepEqual(await john.invites.mine(), []);

    // Accepting is membership only: the log says joined, never call-started.
    const { data: activity } = await owner.cloud.from('room_activity').select('kind').eq('room_id', roomId);
    assert.ok(activity?.some((a) => a.kind === 'joined'));
    assert.ok(!activity?.some((a) => a.kind === 'call-started'));
  });

  it('skips existing members, and sending again replaces the expiry', async () => {
    const { owner, john, srikar } = people;
    assert.deepEqual(await owner.invites.send(roomId, [john.email], 'member'), []);
    const [first] = await owner.invites.send(roomId, [srikar.email], 'viewer');
    const [again] = await owner.invites.send(roomId, [srikar.email], 'viewer');
    assert.equal(again?.id, first?.id);
    assert.equal(again?.resends, 1);
    assert.ok(Date.parse(again!.sentAt) >= Date.parse(first!.sentAt));
  });

  it('withdrawn and expired invitations explain themselves', async () => {
    const { owner, srikar } = people;
    const [inv] = (await owner.invites.list(roomId)).filter((i) => i.email === srikar.email);
    await admin().from('room_invitations').update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq('id', inv!.id);
    const expired = await srikar.invites.resolve({ invitationId: inv!.id });
    assert.equal(expired.kind === 'error' && expired.error, 'invite_expired');
    await refusedWith(srikar.invites.accept({ invitationId: inv!.id }), 'invite_expired');
    assert.equal((await owner.invites.list(roomId)).find((i) => i.id === inv!.id)?.status, 'expired');

    const [fresh] = await owner.invites.send(roomId, [srikar.email], 'viewer');
    await owner.invites.revoke(fresh!.id);
    const revoked = await srikar.invites.resolve({ invitationId: fresh!.id });
    assert.equal(revoked.kind === 'error' && revoked.error, 'invite_revoked');
    await refusedWith(srikar.invites.accept({ invitationId: fresh!.id }), 'invite_revoked');
  });

  it('a link admits anyone signed in with a verified address, with its role; a new link turns the old one off', async () => {
    const { owner, srikar, maya } = people;
    const old = await owner.invites.createLink(roomId, { role: 'member', expiry: '24h', domain: null });
    const link = await owner.invites.createLink(roomId, { role: 'viewer', expiry: '7d', domain: null });
    const oldToken = parseInviteToken(old.url)!;
    const token = parseInviteToken(link.url)!;
    assert.match(token, /^[A-Za-z0-9_-]{22}$/);
    assert.notEqual(token, oldToken);

    const stale = await srikar.invites.resolve({ token: oldToken });
    assert.equal(stale.kind === 'error' && stale.error, 'link_revoked');
    assert.deepEqual(await srikar.invites.resolve({ token: 'AAAAAAAAAAAAAAAAAAAAAA' }), { kind: 'error', error: 'invite_not_found' });

    assert.equal(await srikar.invites.accept({ token }), roomId);
    assert.equal((await owner.rooms.listMembers(roomId)).find((m) => m.userId === srikar.id)?.role, 'viewer');
    assert.equal(await maya.invites.accept({ token }), roomId);
    assert.equal((await owner.invites.list(roomId)).find((i) => i.id === link.invitation.id)?.uses, 2);
    const already = await srikar.invites.resolve({ token });
    assert.equal(already.kind, 'already-member');

    // Members read invitations, never their token hashes; outsiders read nothing.
    const { error: hashError } = await srikar.cloud.from('room_invitations').select('token_hash').eq('room_id', roomId);
    assert.ok(hashError, 'token hashes are not readable');
    assert.deepEqual(await people.stranger.invites.list(roomId), []);
  });

  it('a link limited to a domain turns other domains away', async () => {
    const { owner, john, maya } = people;
    await owner.rooms.removeMember(roomId, maya.id);
    const link = await owner.invites.createLink(roomId, { role: 'member', expiry: '7d', domain: 'ACME.test' });
    assert.equal(link.invitation.domain, 'acme.test');
    const token = parseInviteToken(link.url)!;
    const refused = await maya.invites.resolve({ token });
    assert.equal(refused.kind === 'error' && refused.error, 'domain_not_allowed');
    await refusedWith(maya.invites.accept({ token }), 'domain_not_allowed');
    assert.equal((await john.invites.resolve({ token })).kind, 'already-member');
  });

  it('viewers read and comment, but don’t propose, sign or resolve', async () => {
    const { owner, srikar } = people;
    const ownerRecord = createRoomRecordService(async () => owner.cloud);
    const viewerRecord = createRoomRecordService(async () => srikar.cloud);
    const decision = await ownerRecord.propose(roomId, { title: 'Idempotency keys on retries', verify: 'No double charge in replay' });
    const thread = await viewerRecord.addThread(roomId, { kind: 'question', anchor: { id: 'retry-path', name: 'Retry path' }, body: 'Should retries share a key?' });
    await viewerRecord.reply(roomId, thread.id, 'Asking for the replay test.');
    await assert.rejects(viewerRecord.sign(roomId, decision.id, decision.version));
    await assert.rejects(viewerRecord.propose(roomId, { title: 'Mine', verify: 'x' }));
    await viewerRecord.resolve(roomId, thread.id).catch(() => undefined);
    const record = await ownerRecord.getRecord(roomId);
    assert.equal(record.threads.find((t) => t.id === thread.id)?.resolvedAt ?? null, null);
    assert.deepEqual(record.decisions.find((d) => d.id === decision.id)?.signatures.map((s) => s.userId), []);
  });

  it('a room always keeps an owner; owners change roles and remove people, and that is logged', async () => {
    const { owner, john, srikar } = people;
    await assert.rejects(owner.rooms.removeMember(roomId), (err: RoomError) => err.reason === 'last_owner');
    await assert.rejects(owner.rooms.setMemberRole(roomId, owner.id, 'member'), (err: RoomError) => err.reason === 'last_owner');
    await assert.rejects(john.rooms.setMemberRole(roomId, srikar.id, 'member'));

    await owner.rooms.setMemberRole(roomId, srikar.id, 'member');
    await owner.rooms.removeMember(roomId, srikar.id);
    await john.rooms.removeMember(roomId); // leaving
    const { data: activity } = await owner.cloud.from('room_activity').select('kind, subject').eq('room_id', roomId);
    const kinds = activity?.map((a) => a.kind) ?? [];
    for (const kind of ['role', 'removed', 'left'] as const) assert.ok(kinds.includes(kind), kind);

    // Removed: no longer in the room, its record, or its invitations.
    await assert.rejects(srikar.rooms.getRoom(roomId), (err: RoomError) => err.code === 'not-found');
    assert.deepEqual(await srikar.invites.list(roomId), []);
  });
});
