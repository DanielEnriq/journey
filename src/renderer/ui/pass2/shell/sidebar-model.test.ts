import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RoomSummary } from '../../../features/room/types.js';
import { countByRoom, groupRooms, groupSpaces, NO_FILTER, openByDefault, pinnedRooms, pinPlace, repoName, since, sidebarRooms, suggestSpaceName } from './sidebar-model.js';
import type { SpaceSummary } from '../../../features/room/types.js';

const NOW = '2026-10-26T12:00:00.000Z';
const room = (id: string, repo: string | null, activityAt: string | null, o: Partial<RoomSummary> = {}): RoomSummary =>
  ({ id, name: id, repo, inCall: [], needs: null, activity: '', activityAt, ...o }) as RoomSummary;

describe('sidebar model', () => {
  it('names repositories by their last segment', () => {
    assert.equal(repoName('github.com/halyard/workflows'), 'workflows');
    assert.equal(repoName(null), 'No repository');
  });
  it('says how long since, briefly', () => {
    assert.equal(since(NOW, NOW), 'now');
    assert.equal(since('2026-10-26T11:32:00.000Z', NOW), '28m');
    assert.equal(since('2026-10-26T07:00:00.000Z', NOW), '5h');
    assert.equal(since('2026-10-23T12:00:00.000Z', NOW), '3d');
    assert.equal(since('2026-08-26T12:00:00.000Z', NOW), '2mo');
    assert.equal(since('nonsense', NOW), '');
  });
  it('orders repositories by their most recent room, rooms most recent first', () => {
    const rooms = sidebarRooms([
      room('a', 'x/one', '2026-10-20T00:00:00.000Z'),
      room('b', 'x/two', '2026-10-26T10:00:00.000Z'),
      room('c', 'x/one', '2026-10-26T11:00:00.000Z'),
      room('d', null, '2026-10-25T00:00:00.000Z'),
    ], { now: NOW, callRoomId: null });
    const g = groupRooms(rooms);
    assert.deepEqual(g.map((x) => x.name), ['one', 'two', 'No repository']);
    assert.deepEqual(g[0].rooms.map((r) => r.id), ['c', 'a']);
  });
  it('opens a repository when something there is current, live, needs you, or moved this week', () => {
    const old = '2026-09-01T00:00:00.000Z';
    const one = (o: Partial<RoomSummary> = {}, callRoomId: string | null = null, needsByRoom: Record<string, number> | null = null) =>
      groupRooms(sidebarRooms([room('a', 'x/one', old, o)], { now: NOW, callRoomId, needsByRoom }))[0];
    assert.equal(openByDefault(one(), null), false);
    assert.equal(openByDefault(one(), 'a'), true);
    assert.equal(openByDefault(one({}, 'a'), null), true);
    assert.equal(openByDefault(one({}, null, { a: 2 }), null), true);
    assert.equal(openByDefault(one({ needs: 'Sign the plan' }), null), true);
    assert.equal(openByDefault(groupRooms(sidebarRooms([room('a', 'x/one', '2026-10-25T00:00:00.000Z')], { now: NOW, callRoomId: null }))[0], null), true);
  });
  it('takes needs from the Inbox when it has read, else from the room', () => {
    const rs = [room('a', null, NOW, { needs: 'x' }), room('b', null, NOW)];
    assert.deepEqual(sidebarRooms(rs, { now: NOW, callRoomId: null }).map((r) => r.needs), [1, 0]);
    assert.deepEqual(sidebarRooms(rs, { now: NOW, callRoomId: null, needsByRoom: { b: 3 } }).map((r) => r.needs), [0, 3]);
  });
  it('marks the call room live and in-call', () => {
    const [r] = sidebarRooms([room('a', null, NOW)], { now: NOW, callRoomId: 'a' });
    assert.equal(r.live && r.inCall, true);
  });
  it('counts per room', () => {
    assert.deepEqual(countByRoom([{ room: { id: 'a' } }, { room: { id: 'a' } }, { room: { id: 'b' } }]), { a: 2, b: 1 });
  });
  it('groups rooms by Space in the Spaces’ own order, quiet quick rooms under Earlier', () => {
    const spaces: SpaceSummary[] = [
      { id: 's1', name: 'Payments', repos: ['github.com/acme/payments', 'github.com/acme/ledger'], role: 'owner' },
      { id: 's2', name: 'Storefront', repos: ['github.com/acme/web'], role: 'member' },
      { id: 's3', name: 'Empty', repos: [], role: 'owner' },
    ];
    const rooms = sidebarRooms([
      room('kept', 'acme/payments', '2026-10-20T00:00:00.000Z', { spaceId: 's1', keptAt: '2026-10-01T00:00:00.000Z' }),
      room('quick', 'acme/payments', '2026-10-26T11:00:00.000Z', { spaceId: 's1', keptAt: null }),
      room('old', 'acme/ledger', '2026-10-24T00:00:00.000Z', { spaceId: 's1', keptAt: null }),
      room('web', 'acme/web', '2026-10-26T11:30:00.000Z', { spaceId: 's2', needs: 'Sign it' }),
      room('lost', null, NOW, { spaceId: 'unknown' }),
    ], { now: NOW, callRoomId: null });
    const g = groupSpaces(spaces, rooms);
    assert.deepEqual(g.map((s) => s.name), ['Payments', 'Storefront', 'Empty', 'Rooms']);
    assert.deepEqual(g[0].rooms.map((r) => r.id), ['quick', 'kept']);
    assert.deepEqual(g[0].earlier.map((r) => r.id), ['old']);
    assert.equal(g[0].rooms[0].quick, true);
    assert.equal(g[0].rooms[1].quick, false);
    assert.deepEqual(groupSpaces(spaces, rooms, { ...NO_FILTER, earlier: true })[0].rooms.map((r) => r.id), ['quick', 'old', 'kept']);
    // Filters leave out what doesn't match, and Spaces with nothing left.
    assert.deepEqual(groupSpaces(spaces, rooms, { ...NO_FILTER, needs: true }).map((s) => s.name), ['Storefront']);
    assert.deepEqual(groupSpaces(spaces, rooms, { ...NO_FILTER, repo: 'github.com/acme/ledger' }).map((s) => s.name), ['Payments']);
  });
  it('puts you first among the faces in a call, and carries the agents’ mark', () => {
    const [r] = sidebarRooms([room('a', null, NOW, { inCall: [{ name: 'Priya', initials: 'P', tone: 'peer' }, { name: 'You', initials: 'DE', tone: 'me' }], work: 'waiting' })], { now: NOW, callRoomId: 'a' });
    assert.deepEqual(r.faces.map((f) => f.initials), ['DE', 'P']);
    assert.equal(r.work, 'waiting');
  });
  it('pins rooms above every Space in your order, out of their Spaces, and hides archived rooms unless asked', () => {
    const spaces: SpaceSummary[] = [
      { id: 's1', name: 'Payments', repos: ['github.com/acme/payments'], role: 'owner' },
      { id: 's2', name: 'Storefront', repos: ['github.com/acme/web'], role: 'member' },
    ];
    const old = '2026-10-20T00:00:00.000Z';
    const rooms = sidebarRooms([
      room('a', 'acme/payments', NOW, { spaceId: 's1', keptAt: old, pinOrder: 2 }),
      room('b', 'acme/web', NOW, { spaceId: 's2', keptAt: old, pinOrder: 1, needs: 'Sign it' }),
      room('c', 'acme/web', NOW, { spaceId: 's2', keptAt: old }),
      room('gone', 'acme/web', NOW, { spaceId: 's2', keptAt: old, archivedAt: NOW, pinOrder: 3 }),
      room('quiet', 'acme/payments', old, { spaceId: 's1', keptAt: null, pinOrder: 4 }),
    ], { now: NOW, callRoomId: null });
    assert.deepEqual(pinnedRooms(rooms).map((r) => r.id), ['b', 'a', 'quiet'], 'archived rooms are never pinned');
    assert.equal(rooms.find((r) => r.id === 'quiet')!.earlier, false, 'a pinned quick room doesn’t fold into Earlier');
    const g = groupSpaces(spaces, rooms);
    assert.deepEqual(g.map((s) => s.rooms.map((r) => r.id)), [[], ['c']]);
    assert.deepEqual(groupSpaces(spaces, rooms, { ...NO_FILTER, archived: true })[1].rooms.map((r) => r.id), ['c', 'gone']);
    // The filter applies to pins as to the rest.
    assert.deepEqual(pinnedRooms(rooms, { ...NO_FILTER, needs: true }).map((r) => r.id), ['b']);
    assert.deepEqual(pinnedRooms(rooms, { ...NO_FILTER, repo: 'github.com/acme/payments' }, spaces).map((r) => r.id), ['a', 'quiet']);
  });
  it('places a dropped pin between its new neighbours without moving the others', () => {
    const pins = [{ pin: 1 }, { pin: 2 }, { pin: 4 }];
    assert.equal(pinPlace(pins, 0), 0);
    assert.equal(pinPlace(pins, 1), 1.5);
    assert.equal(pinPlace(pins, 2), 3);
    assert.equal(pinPlace(pins, 3), 5);
    assert.equal(pinPlace([], 0), 1);
  });
  it('suggests a Space’s name from its repositories', () => {
    assert.equal(suggestSpaceName([]), 'New Space');
    assert.equal(suggestSpaceName([{ label: 'payments', identity: 'github.com/acme/payments' }]), 'payments');
    assert.equal(suggestSpaceName([{ label: 'web', identity: 'github.com/Acme/web' }, { label: 'api', identity: 'github.com/acme/api' }]), 'Acme');
    assert.equal(suggestSpaceName([{ label: 'web', identity: 'github.com/acme/web' }, { label: 'notes', identity: null }]), 'web + 1');
  });
});
