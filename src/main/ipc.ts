import { app, BrowserWindow, dialog, ipcMain, nativeTheme, systemPreferences, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { ClaudeCodeAdapter } from '../agents/claude-code.js';
import { Collaborator } from '../assistant/index.js';
import { reasoningTools, roomTools } from '../assistant/room-tools.js';
import { selectProvider } from '../assistant/select.js';
import { workContextTools } from '../assistant/tools.js';
import { config } from '../config.js';
import { claudeCodeActivity, getHooksStatus, installHooks, sessionActivity, uninstallHooks } from '../agents/claude-code-hooks.js';
import { WorkContextService } from '../context/index.js';
import { addRepository, getRepository, listRepositories, markRepositoryOpened, removeRepository } from '../database/repositories.js';
import { getAllSettings, updateSettings } from '../database/settings.js';
import { getWorkstream } from '../database/work-context.js';
import { detectRepositories } from '../git/detect.js';
import { findWorkingTreeRoot, getRemoteUrl, getStatus, listBranches, listWorktrees } from '../git/index.js';
import { getCurrentUser, onUserChange, signIn, signOut } from '../integrations/google/auth.js';
import { anthropic } from '../integrations/anthropic/index.js';
import { chatgptAuth, chatgptPlan, openaiApiKey } from '../integrations/openai/index.js';
import { getCloudUserId } from '../integrations/supabase/index.js';
import { getCallAccess } from '../integrations/livekit/index.js';
import { connectRoom, disconnectRoom, roomActivity, sendRoomEvent } from '../integrations/supabase/realtime.js';
import { repositoryIdentity, RoomError, toRoomError } from '../integrations/supabase/rooms.js';
import { createWorkspace, listWorkspaces, roomRecord, rooms } from '../integrations/supabase/workspaces.js';
import type {
  Channels,
  EventChannel,
  InvokeArgs,
  InvokeChannel,
  InvokeResult,
  MicrophoneAccess,
  RoomCheckout,
  RoomResult,
} from '../shared/api.js';
import { createVoiceHost } from '../voice/index.js';
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

/** Checks the context names a real repository (and one of its workstreams), and describes it for the model. */
function describeRepository({ repositoryId, workstreamId }: { repositoryId: string; workstreamId: string | null }): string {
  const repo = getRepository(repositoryId);
  if (!repo) throw new Error('No such repository');
  const workstream = workstreamId ? getWorkstream(workstreamId) : null;
  if (workstreamId && workstream?.repositoryId !== repositoryId) throw new Error('No such workstream in this repository');
  const focus = workstream
    ? `Selected workstream: ${workstream.branch || '(detached HEAD)'} in ${workstream.worktreePath} (id ${workstream.id}).`
    : 'No workstream selected: the whole repository.';
  return `[Vowe context] Repository: ${repo.name} at ${repo.path}. ${focus} Time: ${new Date().toISOString()}.`;
}

// The person's ChatGPT plan first; API keys only as fallbacks (or when VOWE_AGENT_PROVIDER pins one).
const provider = () => selectProvider(config.agent.provider, chatgptPlan, [openaiApiKey, anthropic]);

const collaborator = new Collaborator({
  provider,
  work: workContext,
  tools: workContextTools,
  roomTools,
  reasoningTools,
  describeRepository,
  approve: (request, signal) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => settle(false), APPROVAL_TIMEOUT_MS);
      const settle = (approved: boolean) => {
        clearTimeout(timer);
        approvals.delete(request.id);
        resolve(approved);
      };
      signal.addEventListener('abort', () => settle(false), { once: true });
      approvals.set(request.id, { conversationId: request.conversationId, settle });
      broadcast('agent:approval', request);
    }),
  onToolCall: (conversationId, call) => broadcast('agent:toolCall', { conversationId, call }),
  rooms: {
    // Read as the signed-in member: RLS lets a member see only their rooms.
    source: { room: (id) => rooms.getRoom(id), members: (id) => rooms.listMembers(id), record: (id) => roomRecord.getRecord(id) },
    checkout: (roomId) => roomCheckout(roomId),
    localUser: () => getCloudUserId(),
  },
});

/** Your Vowe's voice in calls: speech and audio only. Its turns go through the runtime (agent:ask) like typed ones. */
export const voice = createVoiceHost();
const turnId = z.string().min(1).max(100);
/** One chunk of microphone audio: 16-bit samples, at most a second of them at 16 kHz. */
const pcm = z.instanceof(Uint8Array).refine((b) => b.byteLength % 2 === 0 && b.byteLength <= 32_000, 'Expected up to 1 s of 16-bit PCM');

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
 * Where a room's repository is checked out here: the most recently opened added repository whose
 * origin has the room's identity. Computed on this machine and never sent to the cloud.
 */
async function roomCheckout(roomId: string): Promise<RoomCheckout | null> {
  const room = await rooms.getRoom(roomId);
  if (!room.repository) return null;
  const want = room.repository.toLowerCase();
  const repos = listRepositories().sort((a, b) => (b.lastOpenedAt ?? '').localeCompare(a.lastOpenedAt ?? ''));
  for (const repo of repos) {
    const remote = await getRemoteUrl(repo.path).catch(() => null);
    if (remote && repositoryIdentity(remote)?.toLowerCase() === want) {
      return { roomId: room.id, repository: room.repository, repositoryId: repo.id, path: repo.path };
    }
  }
  return null;
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
  handle('agent:status', () => ({ ...collaborator.status(), chatgpt: chatgptAuth().status() }));
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
  // Room turns: validated by the runtime, which also checks the asker is the person signed in here.
  handle('agent:ask', (turn) => {
    const { turnId } = collaborator.ask(turn, (event) => broadcast('agent:event', event));
    return { turnId };
  });
  handle('agent:cancel', (turnId) => {
    collaborator.cancel(parse(id, turnId, 'Turn id'));
  });

  // Sign in with ChatGPT: separate from Google. Tokens stay here; the renderer sees status only.
  handle('chatgpt:status', () => chatgptAuth().status());
  handle('chatgpt:signIn', (account) => chatgptAuth().signIn(account === undefined ? undefined : parse(id, account, 'Account')));
  handle('chatgpt:signOut', () => chatgptAuth().signOut());
  handle('chatgpt:dismissWelcome', () => chatgptAuth().dismissWelcome());

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
  handle('rooms:checkout', (roomId) => roomResult(() => roomCheckout(roomId)));
  handle('record:get', (roomId) => roomResult(() => roomRecord.getRecord(roomId)));
  handle('record:addThread', (roomId, thread) => roomResult(() => roomRecord.addThread(roomId, thread)));
  handle('record:reply', (roomId, threadId, body) => roomResult(() => roomRecord.reply(roomId, threadId, body)));
  handle('record:resolve', (roomId, threadId) => roomResult(() => roomRecord.resolve(roomId, threadId)));
  handle('record:propose', (roomId, decision) => roomResult(() => roomRecord.propose(roomId, decision)));
  handle('record:amend', (roomId, decisionId, change) => roomResult(() => roomRecord.amend(roomId, decisionId, change)));
  handle('record:sign', (roomId, decisionId, version) => roomResult(() => roomRecord.sign(roomId, decisionId, version)));
  handle('record:seen', (roomId) => roomResult(() => roomRecord.markSeen(roomId)));
  handle('record:call', (roomId, what) => roomResult(() => roomRecord.logCall(roomId, what)));
  handle('rooms:join', (roomId) => connectRoom(requireString(roomId, 'Room id')));
  handle('rooms:leave', (roomId) => disconnectRoom(requireString(roomId, 'Room id')));
  // sendRoomEvent validates the type and payload against RoomEvents.
  handle('rooms:send', (roomId, type, payload) => sendRoomEvent(requireString(roomId, 'Room id'), type, payload));
  handle('calls:access', (roomId) => getCallAccess(requireString(roomId, 'Room id')));
  handle('calls:requestMicrophone', () => requestMicrophone());
  // Vowe's voice: the Vowe API checks you may bring it into this room's call (members, not viewers).
  handle('voice:start', (roomId) => voice.start(parse(z.uuid(), roomId, 'Room id')));
  handle('voice:stop', () => voice.stop());
  handle('voice:status', () => voice.status);
  handle('voice:audio', (roomId, chunk) => {
    const bytes = parse(pcm, chunk, 'Audio');
    voice.audio(parse(z.uuid(), roomId, 'Room id'), new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
  });
  handle('voice:begin', (id) => voice.begin(parse(turnId, id, 'Turn id')));
  handle('voice:say', (id, text) => voice.say(parse(turnId, id, 'Turn id'), parse(z.string().max(8000), text, 'Text')));
  handle('voice:end', (id) => voice.end(parse(turnId, id, 'Turn id')));
  handle('voice:cancel', (id) => voice.cancel(parse(turnId, id, 'Turn id')));

  onUserChange((user) => {
    broadcast('auth:changed', user);
    if (!user) void voice.stop(); // signed out: your Vowe leaves the call
  });
  voice.onEvent((e) => {
    if (e.type === 'status') broadcast('voice:status', e.status);
    else if (e.type === 'speech') broadcast('voice:speech', { roomId: e.roomId, speech: e.speech });
    else broadcast('voice:said', { roomId: e.roomId, turnId: e.turnId, text: e.text });
  });
  // The sign-in reads the keychain, so it's created once the app is ready.
  void app.whenReady().then(() => chatgptAuth().onChange((status) => broadcast('chatgpt:changed', status)));
  claudeCodeActivity.on('event', (event) => broadcast('claudeCode:event', event));
  roomActivity.on('event', (event) => broadcast('rooms:event', event));
  roomActivity.on('presence', (update) => broadcast('rooms:presence', update));
  roomActivity.on('status', (update) => broadcast('rooms:status', update));
}
