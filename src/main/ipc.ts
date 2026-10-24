import { BrowserWindow, dialog, ipcMain, nativeTheme, systemPreferences, type IpcMainInvokeEvent } from 'electron';
import { addRepository, getRepository, listRepositories, markRepositoryOpened, removeRepository } from '../database/repositories.js';
import { getAllSettings, updateSettings } from '../database/settings.js';
import { detectRepositories } from '../git/detect.js';
import { findWorkingTreeRoot, getRemoteUrl, getStatus, listBranches, listWorktrees } from '../git/index.js';
import { getCurrentUser, onUserChange, signIn, signOut } from '../integrations/google/auth.js';
import { getCallAccess } from '../integrations/livekit/index.js';
import { connectRoom, disconnectRoom, roomActivity, sendRoomEvent } from '../integrations/supabase/realtime.js';
import { repositoryIdentity, RoomError, toRoomError } from '../integrations/supabase/rooms.js';
import { createWorkspace, listWorkspaces, rooms } from '../integrations/supabase/workspaces.js';
import type {
  Channels,
  EventChannel,
  InvokeArgs,
  InvokeChannel,
  InvokeResult,
  MicrophoneAccess,
  RoomResult,
} from '../shared/api.js';
import { isAppPage } from './window.js';

function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${what} must be a non-empty string`);
  return value;
}

/** Paths the last repos:detect returned: the only paths repos:addDetected accepts from a renderer. */
let detected = new Set<string>();

/** The stored path of a repository the renderer names by id; renderers never send paths. */
function repositoryPath(id: unknown): string {
  const repo = getRepository(requireString(id, 'Repository id'));
  if (!repo) throw new Error('No such repository');
  return repo.path;
}

/**
 * Registers a handler for a channel from the contract. Rejects calls from any frame
 * that isn't our own bundled renderer (e.g. an iframe or a page navigated elsewhere).
 */
function handle<K extends InvokeChannel>(
  channel: K,
  handler: (...args: InvokeArgs<K>) => InvokeResult<K> | Promise<InvokeResult<K>>,
) {
  ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    if (!event.senderFrame || !isAppPage(event.senderFrame.url)) {
      throw new Error(`Blocked ${channel} from untrusted sender ${event.senderFrame?.url ?? '(gone)'}`);
    }
    return handler(...(args as InvokeArgs<K>));
  });
}

/** Pushes an event to every open window. */
export function broadcast<K extends EventChannel>(channel: K, payload: Channels['event'][K]) {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload);
}

/** Runs a room operation, resolving with a RoomResult so the error code survives IPC. */
async function roomResult<T>(run: () => Promise<T>): Promise<RoomResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (err) {
    const { code, message } = toRoomError(err);
    if (code === 'unknown') console.warn('[rooms]', err);
    return { ok: false, error: { code, message } };
  }
}

/** The shared identity of a local repository's `origin`. Only the identity leaves this machine, never the path. */
async function originIdentity(repositoryId: unknown): Promise<string> {
  const repo = typeof repositoryId === 'string' ? getRepository(repositoryId) : undefined;
  if (!repo) throw new RoomError('invalid', 'No such local repository');
  const remote = await getRemoteUrl(repo.path);
  const identity = remote && repositoryIdentity(remote);
  if (!identity) throw new RoomError('invalid', `${repo.name} has no shareable origin remote`);
  return identity;
}

/**
 * macOS asks once per app and remembers; Windows reports the privacy setting; elsewhere there's
 * no OS gate, so getUserMedia decides. Electron's own permission check is in window.ts.
 */
async function requestMicrophone(): Promise<MicrophoneAccess> {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return 'granted';
  const status = systemPreferences.getMediaAccessStatus('microphone');
  if (status === 'not-determined' && process.platform === 'darwin') {
    return (await systemPreferences.askForMediaAccess('microphone')) ? 'granted' : 'denied';
  }
  return status === 'denied' || status === 'restricted' ? status : 'granted'; // 'unknown': let getUserMedia find out
}

/** Applies settings that main acts on directly. Called at startup and after every update. */
export function applySettings() {
  nativeTheme.themeSource = getAllSettings().theme;
}

/**
 * The whole renderer-facing surface lives here. Main owns the database, filesystem,
 * git, and process execution; expose a narrow, intent-level channel for each thing
 * the UI needs ("save canvas", "run tests"), never raw paths or shell commands.
 * Argument types aren't enforced at runtime, so handlers validate what they receive.
 */
export function registerIpc() {
  handle('auth:getUser', () => getCurrentUser() ?? null);
  handle('auth:signIn', () => signIn());
  handle('auth:signOut', () => signOut());

  handle('settings:get', () => getAllSettings());
  handle('settings:update', (patch) => {
    const next = updateSettings(patch);
    applySettings();
    return next;
  });

  handle('repos:list', () => listRepositories());
  handle('repos:add', async () => {
    const parent = BrowserWindow.getFocusedWindow();
    const options = { title: 'Add repository', properties: ['openDirectory' as const] };
    const { canceled, filePaths } = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    if (canceled || !filePaths[0]) return null;
    // Picking a subfolder adds the working tree it belongs to.
    const root = await findWorkingTreeRoot(filePaths[0]);
    if (!root) throw new Error(`Not a Git repository: ${filePaths[0]}`);
    return addRepository(root);
  });
  handle('repos:remove', (id) => {
    if (typeof id !== 'string') throw new Error('Repository id must be a string');
    removeRepository(id);
  });
  handle('repos:detect', async () => {
    const known = new Set(listRepositories().map((r) => r.path));
    const found = (await detectRepositories()).filter((r) => !known.has(r.path));
    detected = new Set(found.map((r) => r.path));
    return found;
  });
  handle('repos:addDetected', async (path) => {
    if (typeof path !== 'string' || !detected.has(path)) throw new Error('Not a detected repository');
    const root = await findWorkingTreeRoot(path); // it may have moved or been deleted since
    if (root !== path) throw new Error(`Not a Git repository: ${path}`);
    return addRepository(root);
  });
  handle('repos:open', (id) => {
    const repo = markRepositoryOpened(requireString(id, 'Repository id'));
    if (!repo) throw new Error('No such repository');
    return repo;
  });

  handle('git:status', (id) => getStatus(repositoryPath(id)));
  handle('git:branches', (id) => listBranches(repositoryPath(id)));
  handle('git:worktrees', (id) => listWorktrees(repositoryPath(id)));

  // Cloud: RLS decides what each call may see or change, so these only check argument shapes.
  handle('workspaces:list', () => listWorkspaces());
  handle('workspaces:create', (name) => createWorkspace(requireString(name, 'Workspace name').trim()));
  // The room service validates its own arguments. Opening a room only reads it: no call, mic, agent, or files.
  handle('rooms:list', (workspaceId) => roomResult(() => rooms.listRooms(workspaceId)));
  handle('rooms:get', (roomId) => roomResult(() => rooms.getRoom(roomId)));
  handle('rooms:create', (room) => roomResult(() => rooms.createRoom(room)));
  handle('rooms:update', (roomId, patch) => roomResult(() => rooms.updateRoom(roomId, patch)));
  handle('rooms:delete', (roomId) => roomResult(() => rooms.deleteRoom(roomId)));
  handle('rooms:members', (roomId) => roomResult(() => rooms.listMembers(roomId)));
  handle('rooms:addMember', (roomId, userId, role) => roomResult(() => rooms.addMember(roomId, userId, role)));
  handle('rooms:setMemberRole', (roomId, userId, role) => roomResult(() => rooms.setMemberRole(roomId, userId, role)));
  handle('rooms:removeMember', (roomId, userId) => roomResult(() => rooms.removeMember(roomId, userId)));
  handle('rooms:attachRepository', (roomId, repositoryId) =>
    roomResult(async () => rooms.updateRoom(roomId, { repository: await originIdentity(repositoryId) })),
  );
  handle('rooms:join', (roomId) => connectRoom(requireString(roomId, 'Room id')));
  handle('rooms:leave', (roomId) => disconnectRoom(requireString(roomId, 'Room id')));
  // sendRoomEvent validates the type and payload against RoomEvents.
  handle('rooms:send', (roomId, type, payload) => sendRoomEvent(requireString(roomId, 'Room id'), type, payload));
  handle('calls:access', (roomId) => getCallAccess(requireString(roomId, 'Room id')));
  handle('calls:requestMicrophone', () => requestMicrophone());

  onUserChange((user) => broadcast('auth:changed', user));
  roomActivity.on('event', (event) => broadcast('rooms:event', event));
  roomActivity.on('presence', (update) => broadcast('rooms:presence', update));
  roomActivity.on('status', (update) => broadcast('rooms:status', update));
}
