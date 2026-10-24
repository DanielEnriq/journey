import { getCloud, getCloudUserId } from './index.js';
import type { Enums, Tables } from './types.js';

// Typed access to the shared tables. RLS decides what each call can see or change;
// a query that RLS filters out returns no rows rather than an error.

export type CloudUser = Tables<'users'>;
export type Workspace = Tables<'workspaces'>;
export type WorkspaceRole = Enums<'workspace_role'>;
export type WorkspaceMember = Tables<'workspace_members'> & { user: CloudUser };
export type Room = Tables<'rooms'>;
export type RoomMember = Tables<'room_members'>;

/** Workspaces the signed-in user belongs to, oldest first. */
export async function listWorkspaces(): Promise<Workspace[]> {
  const { data, error } = await (await getCloud()).from('workspaces').select().order('created_at');
  if (error) throw error;
  return data;
}

/** Creates a workspace; the database makes the creator its owner. */
export async function createWorkspace(name: string): Promise<Workspace> {
  const { data, error } = await (await getCloud()).from('workspaces').insert({ name }).select().single();
  if (error) throw error;
  return data;
}

export async function renameWorkspace(id: string, name: string): Promise<void> {
  const { error } = await (await getCloud()).from('workspaces').update({ name }).eq('id', id);
  if (error) throw error;
}

export async function deleteWorkspace(id: string): Promise<void> {
  const { error } = await (await getCloud()).from('workspaces').delete().eq('id', id); // cascades to members and rooms
  if (error) throw error;
}

export async function listWorkspaceMembers(workspaceId: string): Promise<WorkspaceMember[]> {
  const { data, error } = await (await getCloud())
    .from('workspace_members')
    .select('*, user:users!inner(*)')
    .eq('workspace_id', workspaceId)
    .order('joined_at');
  if (error) throw error;
  return data;
}

/** Owners only. `userId` is a cloud user id (see getCloudUserId), not a Google sub. */
export async function addWorkspaceMember(workspaceId: string, userId: string, role: WorkspaceRole = 'member') {
  const { error } = await (await getCloud()).from('workspace_members').insert({ workspace_id: workspaceId, user_id: userId, role });
  if (error) throw error;
}

/** Owners can remove anyone; members can remove themselves. */
export async function removeWorkspaceMember(workspaceId: string, userId: string) {
  const { error } = await (await getCloud())
    .from('workspace_members')
    .delete()
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId);
  if (error) throw error;
}

// ─── Rooms ───────────────────────────────────────────────────────────────────

export async function listRooms(workspaceId: string): Promise<Room[]> {
  const { data, error } = await (await getCloud()).from('rooms').select().eq('workspace_id', workspaceId).order('created_at');
  if (error) throw error;
  return data;
}

/** Creates a room and joins it. */
export async function createRoom(workspaceId: string, name: string): Promise<Room> {
  const supabase = await getCloud();
  const { data: room, error } = await supabase.from('rooms').insert({ workspace_id: workspaceId, name }).select().single();
  if (error) throw error;
  await joinRoom(room.id);
  return room;
}

export async function deleteRoom(id: string): Promise<void> {
  const { error } = await (await getCloud()).from('rooms').delete().eq('id', id);
  if (error) throw error;
}

export async function listRoomMembers(roomId: string): Promise<RoomMember[]> {
  const { data, error } = await (await getCloud()).from('room_members').select().eq('room_id', roomId).order('joined_at');
  if (error) throw error;
  return data;
}

/** Adds a workspace member to a room; defaults to the signed-in user. Already a member is a no-op. */
export async function joinRoom(roomId: string, userId?: string): Promise<void> {
  const { error } = await (await getCloud())
    .from('room_members')
    .upsert({ room_id: roomId, user_id: userId ?? (await getCloudUserId()) }, { ignoreDuplicates: true });
  if (error) throw error;
}

/** Leaves a room, or (as its creator or a workspace owner) removes someone else. */
export async function leaveRoom(roomId: string, userId?: string): Promise<void> {
  const { error } = await (await getCloud())
    .from('room_members')
    .delete()
    .eq('room_id', roomId)
    .eq('user_id', userId ?? (await getCloudUserId()));
  if (error) throw error;
}
