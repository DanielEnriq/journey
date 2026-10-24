import { BrowserWindow, dialog, ipcMain, nativeTheme, systemPreferences, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { ClaudeCodeAdapter } from '../agents/claude-code.js';
import { Collaborator } from '../assistant/index.js';
import { workContextTools } from '../assistant/tools.js';
import { claudeCodeActivity, getHooksStatus, installHooks, sessionActivity, uninstallHooks } from '../agents/claude-code-hooks.js';
import { WorkContextService } from '../context/index.js';
import { addRepository, getRepository, listRepositories, markRepositoryOpened, removeRepository } from '../database/repositories.js';
import { getAllSettings, updateSettings } from '../database/settings.js';
import { detectRepositories } from '../git/detect.js';
import { findWorkingTreeRoot, getStatus, listBranches, listWorktrees } from '../git/index.js';
import { getCurrentUser, onUserChange, signIn, signOut } from '../integrations/google/auth.js';
import { anthropic } from '../integrations/anthropic/index.js';
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

const claudeCode = new ClaudeCodeAdapter(sessionActivity);
const workContext = new WorkContextService(claudeCode);

/** Parses an untrusted IPC argument, naming it in the error. */
function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`${what} is invalid: ${result.error.issues[0]?.message ?? 'unexpected value'}`);
  return result.data;
}
const id = z.string().trim().min(1).max(200);
const messagePage = z.object({ offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).optional() }).strict().default({});
const agentContext = z.object({ repositoryId: id, workstreamId: id.nullable() }).strict();
const agentText = z.string().trim().min(1).max(8000);

/** Unanswered approval prompts; one left alone this long counts as declined, so a turn can't hang. */
const APPROVAL_TIMEOUT_MS = 5 * 60_000;
const approvals = new Map<string, { conversationId: string; settle: (approved: boolean) => void }>();

const collaborator = new Collaborator({
  provider: anthropic, // swap model providers here
  work: workContext,
  tools: workContextTools,
  approve: (request) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => settle(false), APPROVAL_TIMEOUT_MS);
      const settle = (approved: boolean) => {
        clearTimeout(timer);
        approvals.delete(request.id);
        resolve(approved);
      };
      approvals.set(request.id, { conversationId: request.conversationId, settle });
      broadcast('agent:approval', request);
    }),
  onToolCall: (conversationId, call) => broadcast('agent:toolCall', { conversationId, call }),
});

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

  // Local transcripts and hook events only; nothing here reaches the cloud. The adapter checks each
  // session belongs to the named repository.
  handle('claudeCode:sessions', (repoId) => workContext.listSessions(parse(id, repoId, 'Repository id')));
  handle('claudeCode:session', (repoId, sessionId) => claudeCode.getSession(repositoryPath(repoId), parse(id, sessionId, 'Session id')));
  handle('claudeCode:messages', (repoId, sessionId, page) =>
    claudeCode.getMessages(repositoryPath(repoId), parse(id, sessionId, 'Session id'), parse(messagePage, page, 'Page')),
  );
  handle('claudeCode:activity', (repoId) => workContext.getRecentActivity(parse(id, repoId, 'Repository id')));
  handle('claudeCode:hooksStatus', () => getHooksStatus());
  handle('claudeCode:installHooks', () => installHooks());
  handle('claudeCode:uninstallHooks', () => uninstallHooks());

  handle('context:work', (repoId) => workContext.getWorkContext(parse(id, repoId, 'Repository id')));
  handle('context:repository', (repoId) => workContext.getRepositoryContext(parse(id, repoId, 'Repository id')));
  handle('context:workstreams', (repoId) => workContext.listWorkstreams(parse(id, repoId, 'Repository id')));
  handle('context:workstream', (workstreamId) => workContext.getWorkstreamContext(parse(id, workstreamId, 'Workstream id')));
  handle('context:session', (sessionId) => workContext.getSessionContext(parse(id, sessionId, 'Session id')));

  // The model provider only sees what the tools return; transcript excerpts need the user's approval.
  handle('agent:status', () => collaborator.status());
  handle('agent:send', (conversationId, context, text) =>
    collaborator.send(
      parse(id.nullable(), conversationId, 'Conversation id'),
      parse(agentContext, context, 'Agent context'),
      parse(agentText, text, 'Message'),
    ),
  );
  handle('agent:approve', (approvalId, approved) => {
    approvals.get(parse(id, approvalId, 'Approval id'))?.settle(parse(z.boolean(), approved, 'Answer'));
  });
  handle('agent:reset', (conversationId) => {
    const conversation = parse(id, conversationId, 'Conversation id');
    for (const pending of approvals.values()) if (pending.conversationId === conversation) pending.settle(false);
    collaborator.reset(conversation);
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
  handle('calls:access', (roomId) => getCallAccess(requireString(roomId, 'Room id')));
  handle('calls:requestMicrophone', () => requestMicrophone());

  onUserChange((user) => broadcast('auth:changed', user));
  claudeCodeActivity.on('event', (event) => broadcast('claudeCode:event', event));
  roomActivity.on('event', (event) => broadcast('rooms:event', event));
  roomActivity.on('presence', (update) => broadcast('rooms:presence', update));
  roomActivity.on('status', (update) => broadcast('rooms:status', update));
}
