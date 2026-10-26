import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RoomSummary } from '../../../features/room/types.js';
import { countByRoom, groupRooms, openByDefault, repoName, since, sidebarRooms } from './sidebar-model.js';

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
});
