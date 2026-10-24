import { getCloud, isCloudConfigured } from './index.js';
import { createRoomRecordService } from './record.js';
import { createRoomService, RoomError, toRoomError } from './rooms.js';
import type { Enums, Tables } from './types.js';

// Typed access to the shared tables. RLS decides what each call can see or change;
// a query that RLS filters out returns no rows rather than an error.

export type CloudUser = Tables<'users'>;
export type Workspace = Tables<'workspaces'>;
export type WorkspaceRole = Enums<'workspace_role'>;
export type WorkspaceMember = Tables<'workspace_members'> & { user: CloudUser };

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

/** The signed-in user's cloud client for room services, or the RoomError that explains why there isn't one. */
async function roomCloud() {
  if (!isCloudConfigured()) throw new RoomError('not-configured', 'Rooms need Supabase: set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in .env');
  try {
    return await getCloud();
  } catch (err) {
    const failure = toRoomError(err);
    if (failure.code === 'network') throw failure;
    throw new RoomError('signed-out', 'Sign in to use rooms');
  }
}

/** Persistent rooms and their membership (./rooms.ts), as the signed-in user. */
export const rooms = createRoomService(roomCloud);

/** Each room's threads, decisions and activity (./record.ts), as the signed-in user. */
export const roomRecord = createRoomRecordService(roomCloud);
