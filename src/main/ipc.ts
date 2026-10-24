import { BrowserWindow, dialog, ipcMain, nativeTheme, type IpcMainInvokeEvent } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { addRepository, listRepositories, removeRepository } from '../database/repositories.js';
import { getAllSettings, updateSettings } from '../database/settings.js';
import { getCurrentUser, onUserChange, signIn, signOut } from '../integrations/google/auth.js';
import { connectRoom, disconnectRoom, roomActivity, sendRoomEvent } from '../integrations/supabase/realtime.js';
import { createRoom, createWorkspace, listRooms, listWorkspaces } from '../integrations/supabase/workspaces.js';
import type { Channels, EventChannel, InvokeArgs, InvokeChannel, InvokeResult } from '../shared/api.js';
import { isAppPage } from './window.js';

function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${what} must be a non-empty string`);
  return value;
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
    if (!existsSync(join(filePaths[0], '.git'))) throw new Error(`Not a Git repository: ${filePaths[0]}`);
    return addRepository(filePaths[0]);
  });
  handle('repos:remove', (id) => {
    if (typeof id !== 'string') throw new Error('Repository id must be a string');
    removeRepository(id);
  });

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

  onUserChange((user) => broadcast('auth:changed', user));
  roomActivity.on('event', (event) => broadcast('rooms:event', event));
  roomActivity.on('presence', (update) => broadcast('rooms:presence', update));
  roomActivity.on('status', (update) => broadcast('rooms:status', update));
}
