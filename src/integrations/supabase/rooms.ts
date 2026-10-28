import type { PostgrestError } from '@supabase/supabase-js';
import type {
  MembershipErrorCode,
  NewRoom,
  RoomDetails,
  SpaceRepository,
  RoomErrorCode,
  RoomMember,
  RoomPatch,
  RoomRole,
  RoomSummary,
  NewRoomSession,
  AttachedSession,
  RoomSessionReport,
  RoomSessionStatus,
} from '../../shared/api.js';
import type { Cloud } from './index.js';

/**
 * Persistent rooms: the shared, cloud-side record of a room and who belongs to it. RLS in
 * supabase/migrations/*_room_membership.sql is the authority; this module only shapes calls and
 * turns failures into a RoomError with a code the UI can act on.
 *
 * Opening a room here reads rows and nothing else: no call, no microphone, no coding agent, no
 * local files. Connecting to a room's call or channel is realtime.ts / livekit, and needs membership.
 *
 * Non-members get `not-found` rather than `permission-denied`, so a room's existence isn't leaked.
 * `permission-denied` means you can see the room but not do that to it (e.g. a member renaming it).
 */

export class RoomError extends Error {
  constructor(
    readonly code: RoomErrorCode,
    message: string,
    /** Which membership state explains it, for invitations and role changes. */
    readonly reason?: MembershipErrorCode,
  ) {
    super(message);
    this.name = 'RoomError';
  }
}

export type RoomService = ReturnType<typeof createRoomService>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NAME = 200;
const MAX_GOAL = 2000;

/**
 * `client` returns a signed-in Supabase client, or throws a RoomError (signed-out, not-configured,
 * network). The app passes getCloud; tests pass clients signed in as different people.
 */
export function createRoomService(client: () => Promise<Cloud>) {
  async function signedIn(): Promise<{ supabase: Cloud; selfId: string }> {
    const supabase = await client();
    const { data, error } = await supabase.auth.getSession();
    if (error) throw toRoomError(error);
    if (!data.session) throw new RoomError('signed-out', 'Sign in to use rooms');
    return { supabase, selfId: data.session.user.id };
  }

  /** The room with your role, or not-found if it doesn't exist or you aren't a member. */
  async function getRoom(roomId: string): Promise<RoomDetails> {
    const id = requireId(roomId, 'Room');
    const { supabase, selfId } = await signedIn();
    const { data, error } = await supabase
      .from('rooms')
      .select('*, membership:room_members!inner(role, pin_order, archived_at), room_members(count)')
      .eq('id', id)
      .eq('membership.user_id', selfId)
      .maybeSingle();
    if (error) throw toRoomError(error);
    if (!data) throw notFound();
    const { membership, room_members, ...room } = data;
    return { ...summary(room, membership[0]!), memberCount: room_members[0]?.count ?? 0 };
  }

  return {
    /** Rooms you're a member of, most recently changed first; optionally only one workspace's. */
    async listRooms(workspaceId?: string): Promise<RoomSummary[]> {
      const { supabase, selfId } = await signedIn();
      let query = supabase
        .from('rooms')
        .select('*, membership:room_members!inner(role, pin_order, archived_at)')
        .eq('membership.user_id', selfId)
        .order('updated_at', { ascending: false });
      if (workspaceId !== undefined) query = query.eq('workspace_id', requireId(workspaceId, 'Workspace'));
      const { data, error } = await query;
      if (error) throw toRoomError(error);
      return data.map(({ membership, ...room }) => summary(room, membership[0]!));
    },

    getRoom,

    /** Creates a room in a workspace you belong to. You become its owner; nobody is connected to it. */
    async createRoom(input: NewRoom): Promise<RoomDetails> {
      if (!isRecord(input)) throw new RoomError('invalid', 'A new room needs a workspace id and a name');
      const workspaceId = requireId(input.workspaceId, 'Workspace');
      const row = {
        workspace_id: workspaceId,
        name: requireName(input.name),
        goal: optionalGoal(input.goal),
        repository: optionalRepository(input.repository),
      };
      const { supabase } = await signedIn();
      const { data, error } = await supabase.from('rooms').insert(row).select('id').single();
      if (error) {
        // RLS refuses rooms in workspaces you aren't in; the workspace may as well not exist.
        if (isRlsRefusal(error)) throw new RoomError('not-found', 'No such workspace, or you are not a member of it');
        throw toRoomError(error);
      }
      return getRoom(data.id);
    },

    /** Owners only. Fields left out stay as they are; null clears `goal` or `repository`. */
    async updateRoom(roomId: string, patch: RoomPatch): Promise<RoomDetails> {
      const id = requireId(roomId, 'Room');
      if (!isRecord(patch)) throw new RoomError('invalid', 'Room changes must be an object');
      const changes: { name?: string; goal?: string | null; repository?: string | null } = {};
      if (patch.name !== undefined) changes.name = requireName(patch.name);
      if (patch.goal !== undefined) changes.goal = optionalGoal(patch.goal);
      if (patch.repository !== undefined) changes.repository = optionalRepository(patch.repository);
      if (!Object.keys(changes).length) return getRoom(id);

      const { supabase } = await signedIn();
      const { data, error } = await supabase.from('rooms').update(changes).eq('id', id).select('id');
      if (error) throw toRoomError(error);
      // RLS filters out rooms you may not change: tell "member, not owner" apart from "no such room".
      if (!data.length) throw await refusalFor(id);
      return getRoom(id);
    },

    /** Owners only. Removes the room for everyone, with its membership. */
    async deleteRoom(roomId: string): Promise<void> {
      const id = requireId(roomId, 'Room');
      const { supabase } = await signedIn();
      const { data, error } = await supabase.from('rooms').delete().eq('id', id).select('id');
      if (error) throw toRoomError(error);
      if (!data.length) throw await refusalFor(id);
    },

    /** The room's members, owners first, then by when they joined. */
    async listMembers(roomId: string): Promise<RoomMember[]> {
      const id = requireId(roomId, 'Room');
      const { supabase } = await signedIn();
      const { data, error } = await supabase
        .from('room_members')
        .select('*, user:users!inner(*)')
        .eq('room_id', id)
        .order('role')
        .order('joined_at');
      if (error) throw toRoomError(error);
      if (!data.length) throw notFound(); // a member always sees at least themselves
      return data.map(member);
    },

    /**
     * Owners only. `userId` is a cloud user id of someone already in the room's workspace; there's no
     * invitation by email yet. Adding an existing member returns them unchanged.
     */
    async addMember(roomId: string, userId: string, role: RoomRole = 'member'): Promise<RoomMember> {
      const id = requireId(roomId, 'Room');
      const target = requireId(userId, 'User');
      if (!isRole(role)) throw new RoomError('invalid', 'Role must be owner, member or viewer');
      const { supabase } = await signedIn();
      const room = await getRoom(id);

      const { error } = await supabase.from('room_members').insert({ room_id: id, user_id: target, role });
      if (error && error.code !== '23505') {
        if (!isRlsRefusal(error)) throw toRoomError(error);
        if (room.role !== 'owner') throw new RoomError('permission-denied', 'Only room owners can add members');
        throw new RoomError('invalid', 'Only members of the room’s workspace can be added');
      }
      const added = await findMember(supabase, id, target);
      if (!added) throw notFound();
      return added;
    },

    /** Owners only; hands on or shares ownership. A room always keeps at least one owner. */
    async setMemberRole(roomId: string, userId: string, role: RoomRole): Promise<RoomMember> {
      const id = requireId(roomId, 'Room');
      const target = requireId(userId, 'User');
      if (!isRole(role)) throw new RoomError('invalid', 'Role must be owner, member or viewer');
      const { supabase } = await signedIn();
      const { data, error } = await supabase
        .from('room_members')
        .update({ role })
        .eq('room_id', id)
        .eq('user_id', target)
        .select('user_id');
      if (error) throw toRoomError(error);
      if (!data.length) throw await memberRefusal(supabase, id, target, 'change roles');
      const updated = await findMember(supabase, id, target);
      if (!updated) throw notFound();
      return updated;
    },

    /**
     * Leaves the room (no `userId`, or your own), or as an owner removes someone else. The last
     * owner can't leave: hand ownership on or delete the room. This is room membership, not the call.
     */
    async removeMember(roomId: string, userId?: string): Promise<void> {
      const id = requireId(roomId, 'Room');
      const { supabase, selfId } = await signedIn();
      const target = userId === undefined ? selfId : requireId(userId, 'User');
      const { data, error } = await supabase
        .from('room_members')
        .delete()
        .eq('room_id', id)
        .eq('user_id', target)
        .select('user_id');
      if (error) throw toRoomError(error);
      if (!data.length) throw await memberRefusal(supabase, id, target, 'remove members');
    },
    /**
     * Keeps a room, or lets it be quick again (owners and members). A room also keeps itself once it holds a
     * decision or a plan; a quick room that goes quiet only drops out of the sidebar, it's never deleted.
     */
    async keepRoom(roomId: string, keep: boolean): Promise<RoomDetails> {
      const id = requireId(roomId, 'Room');
      const { supabase } = await signedIn();
      const { error } = await supabase.rpc('keep_room', { room: id, keep: keep === true });
      if (error) {
        if (error.code === '42501') {
          await getRoom(id);
          throw new RoomError('permission-denied', 'Only the room’s owners and members can keep it');
        }
        throw toRoomError(error);
      }
      return getRoom(id);
    },

    /**
     * Pins a room to the top of your sidebar at `order` among your pins (smallest first), moves it there, or
     * unpins it (null). Yours alone: nobody else's sidebar changes. Pinning a quick room keeps it too.
     */
    async pinRoom(roomId: string, order: number | null): Promise<RoomDetails> {
      const id = requireId(roomId, 'Room');
      if (order !== null && (typeof order !== 'number' || !Number.isFinite(order) || Math.abs(order) > 1e15)) {
        throw new RoomError('invalid', 'A pin’s place must be a finite number');
      }
      const { supabase } = await signedIn();
      const { error } = await supabase.rpc('pin_room', { room: id, pin_order: order as number });
      if (error) throw toRoomError(error);
      return getRoom(id);
    },
    /** Archives a room out of your sidebar (unpinning it), or brings it back. Yours alone; the room is untouched. */
    async archiveRoom(roomId: string, archive: boolean): Promise<RoomDetails> {
      const id = requireId(roomId, 'Room');
      const { supabase } = await signedIn();
      const { error } = await supabase.rpc('archive_room', { room: id, archive: archive === true });
      if (error) throw toRoomError(error);
      return getRoom(id);
    },

    /** The coding sessions attached to the room, the order they were attached in. Members. */
    async listSessions(roomId: string): Promise<AttachedSession[]> {
      const id = requireId(roomId, 'Room');
      const { supabase } = await signedIn();
      const { data, error } = await supabase.from('room_sessions').select().eq('room_id', id).order('attached_at');
      if (error) throw toRoomError(error);
      // RLS returns nothing to non-members; say so rather than "no sessions".
      if (!data.length) await getRoom(id);
      return data.map(roomSession);
    },

    /**
     * Attaches one of your Claude Code sessions to the room, in one of its Space's repositories. Owners and
     * members. Attaching a session that's already attached returns it as it is.
     */
    async attachSession(roomId: string, session: NewRoomSession): Promise<AttachedSession> {
      const id = requireId(roomId, 'Room');
      if (!isRecord(session)) throw new RoomError('invalid', 'A session is needed');
      const sessionId = requireId(session.sessionId, 'Session');
      const repository = optionalRepository(session.repository);
      if (!repository) throw new RoomError('invalid', 'A repository is needed');
      const title = requireText(session.title, 'A session’s title', MAX_NAME) ?? sessionId.slice(0, 8);
      const branch = requireText(session.branch, 'A branch', 255);
      const report = session.status === undefined ? null : requireReport(session as RoomSessionReport);
      const { supabase, selfId } = await signedIn();
      const { error } = await supabase.from('room_sessions').insert({
        room_id: id, session_id: sessionId, repository, title, branch, attached_by: selfId,
        ...(report && { status: report.status, activity: report.activity, changed_files: report.changedFiles, status_at: new Date().toISOString() }),
      });
      if (error && error.code !== '23505') {
        if (isRlsRefusal(error)) {
          const room = await getRoom(id);
          if (room.role === 'viewer') throw new RoomError('permission-denied', 'Only the room’s owners and members can attach sessions');
          throw new RoomError('invalid', 'That session isn’t in one of this Space’s repositories');
        }
        throw toRoomError(error);
      }
      const { data, error: readError } = await supabase.from('room_sessions').select().eq('room_id', id).eq('session_id', sessionId).maybeSingle();
      if (readError) throw toRoomError(readError);
      if (!data) throw notFound();
      return roomSession(data);
    },

    /** Detaches a session from the room: whoever attached it, or a room owner. Nothing on any machine changes. */
    async detachSession(roomId: string, sessionId: string): Promise<void> {
      const id = requireId(roomId, 'Room');
      const session = requireId(sessionId, 'Session');
      const { supabase } = await signedIn();
      const { data, error } = await supabase.from('room_sessions').delete().eq('room_id', id).eq('session_id', session).select('session_id');
      if (error) throw toRoomError(error);
      if (!data.length) {
        await getRoom(id);
        const { data: there } = await supabase.from('room_sessions').select('session_id').eq('room_id', id).eq('session_id', session).maybeSingle();
        if (there) throw new RoomError('permission-denied', 'Only whoever attached a session, or the room’s owners, can detach it');
      }
    },

    /** Publishes what a session you attached is doing now, from the machine it runs on. */
    async reportSession(roomId: string, sessionId: string, report: RoomSessionReport): Promise<void> {
      const id = requireId(roomId, 'Room');
      const session = requireId(sessionId, 'Session');
      const r = requireReport(report);
      const { supabase } = await signedIn();
      const { data, error } = await supabase.from('room_sessions')
        .update({ status: r.status, activity: r.activity, changed_files: r.changedFiles, status_at: new Date().toISOString() })
        .eq('room_id', id).eq('session_id', session).select('session_id');
      if (error) throw toRoomError(error);
      if (!data.length) throw new RoomError('permission-denied', 'Only whoever attached a session publishes what it’s doing');
    },

    /** The Space's repositories, the order they were linked in. Every room in the Space can use all of them. */
    async listSpaceRepositories(workspaceId: string): Promise<SpaceRepository[]> {
      const ws = requireId(workspaceId, 'Space');
      const { supabase } = await signedIn();
      const { data, error } = await supabase
        .from('workspace_repositories')
        .select()
        .eq('workspace_id', ws)
        .order('added_at');
      if (error) throw toRoomError(error);
      return data.map(spaceRepository);
    },

    /** Links a repository to a Space you're in, by its remote; linking one that's already there returns it. */
    async linkRepository(workspaceId: string, remote: string): Promise<SpaceRepository> {
      const ws = requireId(workspaceId, 'Space');
      const repository = optionalRepository(remote);
      if (!repository) throw new RoomError('invalid', 'A repository is needed');
      const { supabase, selfId } = await signedIn();
      const { error } = await supabase.from('workspace_repositories').insert({ workspace_id: ws, repository, added_by: selfId });
      if (error && error.code !== '23505') {
        if (isRlsRefusal(error)) throw new RoomError('not-found', 'No such Space, or you are not a member of it');
        throw toRoomError(error);
      }
      const linked = (await this.listSpaceRepositories(ws)).find((r) => r.repository.toLowerCase() === repository.toLowerCase());
      if (!linked) throw new RoomError('not-found', 'No such Space, or you are not a member of it');
      return linked;
    },

    /** Owners only. Renames the Space for everyone in it. */
    async renameSpace(workspaceId: string, name: string): Promise<void> {
      const ws = requireId(workspaceId, 'Space');
      const named = requireName(name);
      const { supabase } = await signedIn();
      const { data, error } = await supabase.from('workspaces').update({ name: named }).eq('id', ws).select('id');
      if (error) throw toRoomError(error);
      if (!data.length) throw new RoomError('permission-denied', 'Only the Space’s owners can rename it');
    },

    /** Unlinks a repository: whoever linked it, or a Space owner. Rooms keep their history of it. */
    async unlinkRepository(workspaceId: string, repository: string): Promise<void> {
      const ws = requireId(workspaceId, 'Space');
      if (typeof repository !== 'string' || !repository) throw new RoomError('invalid', 'A repository is needed');
      const { supabase } = await signedIn();
      const { data, error } = await supabase
        .from('workspace_repositories')
        .delete()
        .eq('workspace_id', ws)
        .eq('repository', repository)
        .select('repository');
      if (error) throw toRoomError(error);
      if (!data.length) {
        const there = (await this.listSpaceRepositories(ws)).some((r) => r.repository === repository);
        if (there) throw new RoomError('permission-denied', 'Only whoever linked a repository, or the Space’s owners, can unlink it');
        throw new RoomError('not-found', 'That repository isn’t linked to this Space');
      }
    },
  };

  /** Why a write to a room matched nothing: you can read it but not change it, or it isn't yours to see. */
  async function refusalFor(roomId: string): Promise<RoomError> {
    await getRoom(roomId); // throws not-found
    return new RoomError('permission-denied', 'Only room owners can do that');
  }

  async function memberRefusal(supabase: Cloud, roomId: string, userId: string, action: string): Promise<RoomError> {
    await getRoom(roomId);
    if (!(await findMember(supabase, roomId, userId))) return new RoomError('not-found', 'Not a member of this room');
    return new RoomError('permission-denied', `Only room owners can ${action}`);
  }
}

async function findMember(supabase: Cloud, roomId: string, userId: string): Promise<RoomMember | undefined> {
  const { data, error } = await supabase
    .from('room_members')
    .select('*, user:users!inner(*)')
    .eq('room_id', roomId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw toRoomError(error);
  return data ? member(data) : undefined;
}

type RoomRow = Omit<RoomSummary, 'role' | 'workspaceId' | 'createdBy' | 'createdAt' | 'updatedAt' | 'keptAt' | 'pinOrder' | 'archivedAt'> & {
  workspace_id: string;
  kept_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};

/** Your own membership row: your role, and where the room sits in your sidebar. */
type Membership = { role: RoomRole; pin_order: number | null; archived_at: string | null };

function summary(row: RoomRow, mine: Membership): RoomSummary {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    goal: row.goal,
    repository: row.repository,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    keptAt: row.kept_at,
    role: mine.role,
    pinOrder: mine.pin_order,
    archivedAt: mine.archived_at,
  };
}

function spaceRepository(row: { workspace_id: string; repository: string; added_by: string | null; added_at: string }): SpaceRepository {
  return { workspaceId: row.workspace_id, repository: row.repository, addedBy: row.added_by, addedAt: row.added_at };
}

function roomSession(row: {
  room_id: string; session_id: string; repository: string; title: string; branch: string | null; attached_by: string | null;
  attached_at: string; status: string; activity: string | null; changed_files: number | null; status_at: string | null;
}): AttachedSession {
  return {
    roomId: row.room_id,
    sessionId: row.session_id,
    repository: row.repository,
    title: row.title,
    branch: row.branch,
    attachedBy: row.attached_by,
    attachedAt: row.attached_at,
    status: isSessionStatus(row.status) ? row.status : 'unknown',
    activity: row.activity,
    changedFiles: row.changed_files,
    statusAt: row.status_at,
  };
}

const SESSION_STATUSES: RoomSessionStatus[] = ['active', 'completed', 'attention', 'unknown'];
function isSessionStatus(value: unknown): value is RoomSessionStatus {
  return SESSION_STATUSES.includes(value as RoomSessionStatus);
}

function member(row: {
  room_id: string;
  user_id: string;
  role: RoomRole;
  joined_at: string;
  user: { email: string; name: string | null; avatar_url: string | null };
}): RoomMember {
  return {
    roomId: row.room_id,
    userId: row.user_id,
    role: row.role,
    joinedAt: row.joined_at,
    email: row.user.email,
    name: row.user.name,
    avatarUrl: row.user.avatar_url,
  };
}

function isRole(value: unknown): value is RoomRole {
  return value === 'owner' || value === 'member' || value === 'viewer';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const notFound = () => new RoomError('not-found', 'No such room, or you are not a member of it');

// ─── Input ───────────────────────────────────────────────────────────────────

function requireId(value: unknown, what: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new RoomError('invalid', `${what} id must be a UUID`);
  return value.toLowerCase();
}

function requireName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) throw new RoomError('invalid', 'Room name must not be empty');
  if (name.length > MAX_NAME) throw new RoomError('invalid', `Room name must be at most ${MAX_NAME} characters`);
  return name;
}

/** Trimmed text of at most `max` characters, or null when there's none. */
function requireText(value: unknown, what: string, max: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new RoomError('invalid', `${what} must be text`);
  const text = value.trim();
  if (text.length > max) return text.slice(0, max - 1) + '…';
  return text || null;
}

function requireReport(value: unknown): RoomSessionReport {
  if (!isRecord(value) || !isSessionStatus(value.status)) throw new RoomError('invalid', 'A session’s status must be active, completed, attention or unknown');
  const files = value.changedFiles;
  if (files !== null && files !== undefined && !(Number.isInteger(files) && (files as number) >= 0)) throw new RoomError('invalid', 'Changed files must be a count');
  return { status: value.status, activity: requireText(value.activity, 'Activity', 300), changedFiles: (files as number | null | undefined) ?? null };
}

function optionalGoal(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new RoomError('invalid', 'Room goal must be text');
  const goal = value.trim();
  if (goal.length > MAX_GOAL) throw new RoomError('invalid', `Room goal must be at most ${MAX_GOAL} characters`);
  return goal || null;
}

function optionalRepository(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const identity = typeof value === 'string' ? repositoryIdentity(value) : null;
  if (!identity) {
    throw new RoomError('invalid', 'Repository must be a remote such as github.com/owner/repo, not a local path');
  }
  return identity;
}

/**
 * The shared identity of a repository: host and path of its remote, lowercase host, no scheme, user,
 * port, or `.git`. `git@github.com:Acme/Payments.git` and `https://github.com/Acme/Payments` both give
 * `github.com/Acme/Payments`; `acme/payments` (no host) is kept as given. Local paths and file URLs
 * give null: what's on someone's disk never becomes room data.
 */
export function repositoryIdentity(remote: string): string | null {
  let value = remote.trim();
  if (!value || /\s/.test(value)) return null;
  let host: string | undefined;
  let path: string;

  const url = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(value);
  const scp = /^(?:[^@/:]+@)?([^/:]+):(?!\/)(.+)$/.exec(value); // git@host:owner/repo
  if (url) {
    if (!['https', 'http', 'ssh', 'git', 'git+ssh', 'ssh+git'].includes(url[1]!.toLowerCase())) return null;
    const rest = url[2]!;
    const slash = rest.indexOf('/');
    if (slash <= 0) return null;
    host = rest.slice(0, slash).replace(/^.*@/, '').replace(/:\d*$/, '');
    path = rest.slice(slash + 1);
  } else if (scp && !/^[a-z]$/i.test(scp[1]!)) {
    // A single letter before the colon is a Windows drive (C:\…, C:/…), not a host.
    host = scp[1];
    path = scp[2]!;
  } else {
    if (/^[/\\~.]/.test(value) || /^[a-z]:/i.test(value) || value.includes('\\') || value.includes(':')) return null;
    path = value;
  }

  path = path.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  const segments = path.split('/');
  if (segments.some((s) => !s || s === '.' || s === '..' || /[:@]/.test(s))) return null;
  if (host !== undefined) {
    host = host.toLowerCase();
    if (!host || /[/:@\s]/.test(host)) return null;
    value = `${host}/${segments.join('/')}`;
  } else {
    if (segments.length < 2) return null;
    value = segments.join('/');
  }
  return value.length <= 512 ? value : null;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

function isRlsRefusal(error: PostgrestError): boolean {
  return error.code === '42501';
}

/** Maps a Supabase/Postgres failure to a RoomError. Already-mapped errors pass through. */
export function toRoomError(error: unknown): RoomError {
  if (error instanceof RoomError) return error;
  const e = (error ?? {}) as { code?: unknown; message?: unknown; name?: unknown; status?: unknown };
  const code = typeof e.code === 'string' ? e.code : '';
  const message = typeof e.message === 'string' && e.message ? e.message : 'Something went wrong';

  if (isNetworkFailure(e, code, message)) return new RoomError('network', `Could not reach the cloud: ${message}`);
  switch (code) {
    case '42501': // RLS or column privileges
      return new RoomError('permission-denied', 'You don’t have permission to do that');
    case 'P0002': // pin_room, archive_room: not a member, or no such room
      return notFound();
    case 'VR001': // keep_room_owner
      return new RoomError('conflict', message, 'last_owner');
    case 'VI001': // the invitation functions: the message is the reason
      return invitationError(message);
    case '23505':
      return new RoomError('conflict', 'That already exists');
    case '23503': // e.g. adding a user id that isn't a user
    case '23502':
    case '23514':
    case '22P02':
    case '22001':
      return new RoomError('invalid', message);
    case 'PGRST301': // JWT expired or invalid
    case 'PGRST302':
      return new RoomError('signed-out', 'Your cloud session ended; sign in again');
  }
  return new RoomError('unknown', message);
}

const INVITATION_ERRORS: Record<string, [RoomErrorCode, string]> = {
  not_permitted: ['permission-denied', 'Only the room’s owners can do that'],
  invalid_email: ['invalid', 'That doesn’t look like an email address'],
  rate_limited: ['conflict', 'Too many invitations at once; wait a minute and try again'],
  wrong_account: ['permission-denied', 'This invitation is for a different account'],
  invite_not_found: ['not-found', 'This invitation isn’t valid'],
  invite_expired: ['invalid', 'This invitation has expired'],
  invite_revoked: ['invalid', 'This invitation was withdrawn'],
  invite_used: ['invalid', 'This invitation was already used'],
  link_revoked: ['invalid', 'This link was turned off'],
  domain_not_allowed: ['permission-denied', 'This link is limited to another email domain'],
};

function invitationError(reason: string): RoomError {
  const known = INVITATION_ERRORS[reason];
  if (!known) return new RoomError('unknown', reason);
  return new RoomError(known[0], known[1], reason as MembershipErrorCode);
}

function isNetworkFailure(e: { name?: unknown; status?: unknown }, code: string, message: string): boolean {
  // postgrest-js reports a failed fetch as { code: '', message: 'TypeError: fetch failed' } (status 0).
  if (e.name === 'AuthRetryableFetchError') return true;
  if (e.name === 'TypeError' && /fetch|network/i.test(message)) return true; // undici's "fetch failed"
  if (code === '' && /^(TypeError|FetchError|AbortError)\b|fetch failed|network|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(message)) return true;
  return typeof e.status === 'number' && (e.status === 0 || e.status === 502 || e.status === 503 || e.status === 504);
}
