import type { RealtimeChannel } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Participant, RoomEvent, RoomEvents, RoomEventType, RoomSession, RoomStatus } from '../../shared/api.js';
import { onUserChange } from '../google/auth.js';
import { getCloud, getCloudUserId } from './index.js';
import { joinRoom as addRoomMember } from './workspaces.js';

/**
 * Live rooms over Supabase Realtime. Each connected room is one private channel,
 * `room:<room id>`, which RLS on realtime.messages opens to the room's members only
 * (supabase/migrations/*_room_realtime.sql). On it:
 *   broadcast  RoomEvents between connected members. Not stored: only those connected at the time get them.
 *   presence   who's connected, keyed by cloud user id so several windows or devices count once.
 *
 * Runs in main, which owns the Supabase session; renderers reach it through IPC.
 * Everything arriving from the network is validated before it's emitted.
 */

const BROADCAST_EVENT = 'room-event';

type Validators = { [K in RoomEventType]: (payload: unknown) => payload is RoomEvents[K] };

/** One per RoomEvents entry; the compiler flags a missing one. */
const validators: Validators = {
  'chat:message': (p): p is RoomEvents['chat:message'] => isRecord(p) && typeof p.text === 'string',
};

export const roomActivity = new EventEmitter<{
  event: [RoomEvent];
  presence: [{ roomId: string; participants: Participant[] }];
  status: [{ roomId: string; status: RoomStatus }];
}>();

interface LiveRoom {
  channel: RealtimeChannel;
  selfId: string;
}

const live = new Map<string, LiveRoom>();
const joining = new Map<string, Promise<RoomSession>>();

/** Joins a room (as a member, if not already) and connects to it. Joining twice returns the same session. */
export function connectRoom(roomId: string): Promise<RoomSession> {
  const room = live.get(roomId);
  if (room) return Promise.resolve(session(roomId, room));
  let pending = joining.get(roomId);
  if (!pending) {
    pending = connect(roomId).finally(() => joining.delete(roomId));
    joining.set(roomId, pending);
  }
  return pending;
}

async function connect(roomId: string): Promise<RoomSession> {
  const supabase = await getCloud();
  const selfId = await getCloudUserId();
  await addRoomMember(roomId); // RLS: only workspace members can join; the channel policy checks this row

  const { data: profile, error } = await supabase.from('users').select('name, avatar_url').eq('id', selfId).single();
  if (error) throw error;
  const self: Participant = {
    userId: selfId,
    name: profile.name,
    avatarUrl: profile.avatar_url,
    joinedAt: new Date().toISOString(),
  };

  const channel = supabase.channel(`room:${roomId}`, {
    config: { private: true, broadcast: { self: false, ack: true }, presence: { key: selfId, enabled: true } },
  });
  channel.on('broadcast', { event: BROADCAST_EVENT }, ({ payload }) => {
    const event = parseEvent(roomId, payload);
    if (event) roomActivity.emit('event', event);
    else console.warn(`[rooms] dropped malformed event in ${roomId}`);
  });
  channel.on('presence', { event: 'sync' }, () => {
    roomActivity.emit('presence', { roomId, participants: participants(channel) });
  });

  await new Promise<void>((resolve, reject) => {
    let joined = false;
    channel.subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        // Presence belongs to the connection, so announce again after every rejoin.
        channel.track(self).then(
          (result) => result !== 'ok' && console.warn(`[rooms] presence not tracked in ${roomId}: ${result}`),
          (trackErr: Error) => console.warn(`[rooms] presence not tracked in ${roomId}:`, trackErr.message),
        );
        if (joined) roomActivity.emit('status', { roomId, status: 'connected' });
        joined = true;
        resolve();
      } else if (!joined) {
        // Typically RLS refusing the channel. Remove it, or the client keeps retrying.
        void supabase.removeChannel(channel);
        reject(err ?? new Error(`Could not connect to room (${status})`));
      } else if (status === 'CLOSED') {
        // Closed by the server rather than by disconnectRoom or sign-out.
        if (live.get(roomId)?.channel !== channel) return;
        live.delete(roomId);
        roomActivity.emit('status', { roomId, status: 'left' });
      } else {
        roomActivity.emit('status', { roomId, status: 'reconnecting' }); // the client rejoins on its own
      }
    });
  });

  const room = { channel, selfId };
  live.set(roomId, room);
  return session(roomId, room);
}

/** Disconnects from a room. Membership stays, so connecting again needs no invite. */
export async function disconnectRoom(roomId: string): Promise<void> {
  const room = live.get(roomId);
  if (!room) return;
  live.delete(roomId);
  await (await getCloud()).removeChannel(room.channel); // leaving the channel also ends our presence there
}

export async function disconnectAllRooms(): Promise<void> {
  await Promise.all([...live.keys()].map(disconnectRoom));
}

/** Sends an event to everyone else connected to the room; resolves once the server acknowledges it. */
export async function sendRoomEvent<K extends RoomEventType>(
  roomId: string,
  type: K,
  payload: RoomEvents[K],
): Promise<RoomEvent<K>> {
  const room = live.get(roomId);
  if (!room) throw new Error('Join the room before sending to it');
  if (!isEventType(type) || !validators[type](payload)) throw new Error(`Invalid room event: ${String(type)}`);

  const event = { id: randomUUID(), roomId, type, payload, senderId: room.selfId, sentAt: new Date().toISOString() };
  const result = await room.channel.send({ type: 'broadcast', event: BROADCAST_EVENT, payload: event });
  if (result !== 'ok') throw new Error(`Room event not delivered (${result})`);
  return event as RoomEvent<K>;
}

function session(roomId: string, room: LiveRoom): RoomSession {
  return { roomId, selfId: room.selfId, participants: participants(room.channel) };
}

/** One entry per user (their earliest connection), oldest first. */
function participants(channel: RealtimeChannel): Participant[] {
  const people: Participant[] = [];
  for (const presences of Object.values(channel.presenceState())) {
    const [first] = (presences as unknown[]) // shaped by whoever tracked it; check before trusting
      .filter(isParticipant)
      .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
    if (first) people.push({ userId: first.userId, name: first.name, avatarUrl: first.avatarUrl, joinedAt: first.joinedAt });
  }
  return people.sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
}

function parseEvent(roomId: string, raw: unknown): RoomEvent | undefined {
  if (!isRecord(raw)) return undefined;
  const { id, type, payload, senderId, sentAt } = raw;
  if (typeof id !== 'string' || typeof senderId !== 'string' || typeof sentAt !== 'string') return undefined;
  if (!isEventType(type) || !validators[type](payload)) return undefined;
  // roomId comes from the channel, never from the sender.
  return { id, roomId, type, payload, senderId, sentAt } as RoomEvent;
}

function isEventType(type: unknown): type is RoomEventType {
  return typeof type === 'string' && Object.hasOwn(validators, type);
}

function isParticipant(value: unknown): value is Participant {
  return (
    isRecord(value) &&
    typeof value.userId === 'string' &&
    typeof value.joinedAt === 'string' &&
    (value.name === null || typeof value.name === 'string') &&
    (value.avatarUrl === null || typeof value.avatarUrl === 'string')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// On sign-out the cloud module removes every channel; forget them here too.
onUserChange((user) => {
  if (user) return;
  for (const roomId of live.keys()) roomActivity.emit('status', { roomId, status: 'left' });
  live.clear();
});
