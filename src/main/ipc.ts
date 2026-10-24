import { BrowserWindow, dialog, ipcMain, nativeTheme, systemPreferences, type IpcMainInvokeEvent } from 'electron';
import { addRepository, getRepository, listRepositories, markRepositoryOpened, removeRepository } from '../database/repositories.js';
import { getAllSettings, updateSettings } from '../database/settings.js';
import { detectRepositories } from '../git/detect.js';
import { findWorkingTreeRoot, getStatus, listBranches, listWorktrees } from '../git/index.js';
import { getCurrentUser, onUserChange, signIn, signOut } from '../integrations/google/auth.js';
import { getCallAccess } from '../integrations/livekit/index.js';
import { connectRoom, disconnectRoom, roomActivity, sendRoomEvent } from '../integrations/supabase/realtime.js';
import { createRoom, createWorkspace, listRooms, listWorkspaces } from '../integrations/supabase/workspaces.js';
import type { Channels, EventChannel, InvokeArgs, InvokeChannel, InvokeResult, MicrophoneAccess } from '../shared/api.js';
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
  handle('rooms:list', (workspaceId) => listRooms(requireString(workspaceId, 'Workspace id')));
  handle('rooms:create', (workspaceId, name) =>
    createRoom(requireString(workspaceId, 'Workspace id'), requireString(name, 'Room name').trim()),
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
