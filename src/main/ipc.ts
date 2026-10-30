import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell, systemPreferences, type IpcMainInvokeEvent } from 'electron';
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
import {
  cancelAuthFlow,
  getCurrentUser,
  getSessionEnded,
  linkSignInMethod,
  listSignInMethods,
  onSessionEnded,
  onUserChange,
  signIn,
  signOut,
  unlinkSignInMethod,
} from '../integrations/account/index.js';
import { anthropic } from '../integrations/anthropic/index.js';
import { chatgptAuth, chatgptPlan, openaiApiKey } from '../integrations/openai/index.js';
import { getCloudUserId } from '../integrations/supabase/index.js';
import { getCallAccess, syncCallParticipant } from '../integrations/livekit/index.js';
import { connectRoom, disconnectRoom, roomActivity, sendRoomEvent, setRoomCall } from '../integrations/supabase/realtime.js';
import { repositoryIdentity, RoomError, toRoomError } from '../integrations/supabase/rooms.js';
import { createWorkspace, inboxState, invitations, listWorkspaces, roomRecord, rooms, voweRecord } from '../integrations/supabase/workspaces.js';
import { decisionVersionId } from '../shared/vowe/ids.js';
import type { VoweRecord } from '../shared/vowe/model.js';
import type {
  AgentEvent,
  Channels,
  EventChannel,
  InvokeArgs,
  InvokeChannel,
  InvokeResult,
  MicrophoneAccess,
  RoomAgentTurn,
  RoomCheckout,
  RoomDetails,
  RoomRepositoryCheckout,
  RoomResult,
} from '../shared/api.js';
import { createVoiceHost } from '../voice/index.js';
import { canvas, executeAsPerson, loadRoomCanvas, sharePresence } from './canvas.js';
import { roomCanvasEvents, withRoomCanvas } from './vowe-canvas.js';
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
const signInProvider = z.enum(['google', 'github']);
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
    const { code, message, reason } = toRoomError(err);
    if (code === 'unknown') console.warn('[rooms]', err);
    return { ok: false, error: reason ? { code, message, reason } : { code, message } };
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
 * The repositories a room can use: every one linked to its Space, its own first (rooms made before Spaces
 * named one each). Read from the cloud as you; nothing local.
 */
async function roomRepositories(roomId: string): Promise<{ room: RoomDetails; repositories: string[] }> {
  const room = await rooms.getRoom(roomId);
  // A database without Spaces yet (the space_repositories migration) still has the room's own repository.
  const linked = (await rooms.listSpaceRepositories(room.workspaceId).catch(() => [])).map((r) => r.repository);
  const own = room.repository && !linked.some((r) => r.toLowerCase() === room.repository!.toLowerCase()) ? [room.repository] : [];
  const first = room.repository?.toLowerCase();
  const repositories = [...own, ...linked].sort((a, b) => Number(b.toLowerCase() === first) - Number(a.toLowerCase() === first));
  return { room, repositories };
}

/**
 * Where each of a room's repositories is checked out here: the most recently opened added repository whose
 * origin has its identity, or nulls when it isn't cloned on this machine. Computed here, never sent to the cloud.
 */
async function roomCheckouts(roomId: string): Promise<RoomRepositoryCheckout[]> {
  const { repositories } = await roomRepositories(roomId);
  if (!repositories.length) return [];
  const local = new Map<string, { id: string; path: string }>();
  const repos = listRepositories().sort((a, b) => (a.lastOpenedAt ?? '').localeCompare(b.lastOpenedAt ?? ''));
  for (const repo of repos) { // oldest first, so the most recently opened clone wins
    const remote = await getRemoteUrl(repo.path).catch(() => null);
    const identity = remote && repositoryIdentity(remote);
    if (identity) local.set(identity.toLowerCase(), { id: repo.id, path: repo.path });
  }
  return repositories.map((repository) => {
    const here = local.get(repository.toLowerCase());
    return { repository, repositoryId: here?.id ?? null, path: here?.path ?? null };
  });
}

/** The room's first repository that's checked out here, for what reads one repository at a time. */
async function roomCheckout(roomId: string): Promise<RoomCheckout | null> {
  const here = (await roomCheckouts(roomId)).find((c) => c.repositoryId && c.path);
  return here ? { roomId, repository: here.repository, repositoryId: here.repositoryId!, path: here.path! } : null;
}

/**
 * Whether a coding agent is reachable from this room on this machine, for the Desk's "who does it". Only
 * Claude Code, and only where the room's repository is checked out here; worked out locally, never sent
 * anywhere. Reachable means a person can hand it an authorized plan in Claude Code: Journey starts no runs.
 */
async function voweAgents(roomId: string): Promise<VoweRecord['agents']> {
  // The Desk re-reads the record after every write; looking through local remotes each time isn't needed.
  const hit = agentsSeen.get(roomId);
  if (hit && Date.now() - hit.at < 30_000) return hit.agents;
  const agents = await findAgents(roomId);
  agentsSeen.set(roomId, { at: Date.now(), agents });
  return agents;
}
const agentsSeen = new Map<string, { at: number; agents: VoweRecord['agents'] }>();

async function findAgents(roomId: string): Promise<VoweRecord['agents']> {
  const checkout = await roomCheckout(roomId).catch(() => null);
  if (!checkout) {
    const linked = await roomRepositories(roomId).catch(() => null);
    if (!linked?.repositories.length) return [];
    return [{ name: claudeCode.name, status: 'not-connected', note: 'None of this room’s repositories are checked out on this machine' }];
  }
  const sessions = await workContext.listSessions(checkout.repositoryId).catch(() => []);
  return [{
    name: claudeCode.name, status: 'connected',
    note: sessions.length ? 'Checked out here, with Claude Code sessions' : 'Checked out here; no Claude Code sessions yet',
  }];
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
  handle('auth:getEnded', () => getSessionEnded());
  handle('auth:signIn', (provider) => signIn(provider === undefined ? 'google' : parse(signInProvider, provider, 'Provider')));
  handle('auth:cancel', () => cancelAuthFlow());
  handle('auth:signOut', () => signOut());
  // Sign-in methods on the one Vowe account. Separate from tool access: none of these grant repository
  // or model access.
  handle('auth:methods', () => listSignInMethods());
  handle('auth:link', (provider) => linkSignInMethod(parse(signInProvider, provider, 'Provider')));
  handle('auth:unlink', (provider) => unlinkSignInMethod(parse(signInProvider, provider, 'Provider')));

  handle('settings:get', () => getAllSettings());
  handle('settings:update', (patch) => {
    const next = updateSettings(patch);
    applySettings();
    return next;
  });

  handle('repos:list', () => listRepositories());
  // Only the identity is returned for sharing; paths stay with repos:list on this machine.
  handle('repos:identities', () =>
    Promise.all(listRepositories().map(async (r) => {
      const remote = await getRemoteUrl(r.path).catch(() => null);
      return { id: r.id, identity: (remote && repositoryIdentity(remote)) || null };
    })));
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
  // Room turns: validated by the runtime, which also checks the asker is the person signed in here. The
  // turn sees the room's canvas as the hub has it, and its canvas requests run there (main/vowe-canvas.ts).
  handle('agent:ask', async (raw) => {
    // Still untrusted: the runtime checks the turn against roomTurnSchema before anything else.
    const turn = (await withRoomCanvas(raw)) as RoomAgentTurn;
    const roomId: unknown = turn?.roomId;
    const send = (event: AgentEvent) => broadcast('agent:event', event);
    const { turnId } = collaborator.ask(turn, typeof roomId === 'string' ? roomCanvasEvents(roomId, send) : send);
    return { turnId };
  });
  handle('agent:cancel', (turnId) => {
    collaborator.cancel(parse(id, turnId, 'Turn id'));
  });

  // Sign in with ChatGPT: separate from signing in to Vowe. Tokens stay here; the renderer sees status only.
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
  // The database decides; then the call follows, so a removed person is taken off it and a new viewer goes quiet.
  handle('rooms:setMemberRole', (roomId, userId, role) =>
    roomResult(async () => {
      const member = await rooms.setMemberRole(roomId, userId, role);
      void syncCallParticipant(roomId, userId);
      return member;
    }),
  );
  handle('rooms:removeMember', (roomId, userId) =>
    roomResult(async () => {
      await rooms.removeMember(roomId, userId);
      if (userId) void syncCallParticipant(roomId, userId); // without one you left: your client leaves the call itself
    }),
  );
  // Also links it to the room's Space, so every room there can use it.
  handle('rooms:attachRepository', (roomId, repositoryId) =>
    roomResult(async () => {
      const repository = await originIdentity(repositoryId);
      const room = await rooms.getRoom(roomId);
      const attached = await rooms.updateRoom(roomId, { repository });
      await rooms.linkRepository(room.workspaceId, repository).catch((err) => console.warn('[rooms] linking to the Space', err));
      return attached;
    }),
  );
  handle('rooms:checkout', (roomId) => roomResult(() => roomCheckout(roomId)));
  handle('rooms:checkouts', (roomId) => roomResult(() => roomCheckouts(roomId)));
  handle('rooms:keep', (roomId, keep) => roomResult(() => rooms.keepRoom(roomId, keep === true)));
  handle('rooms:pin', (roomId, order) => roomResult(() => rooms.pinRoom(roomId, order ?? null)));
  handle('rooms:archive', (roomId, archive) => roomResult(() => rooms.archiveRoom(roomId, archive === true)));
  handle('rooms:sessions', (roomId) => roomResult(() => rooms.listSessions(roomId)));
  handle('rooms:attachSession', (roomId, session) => roomResult(() => rooms.attachSession(roomId, session)));
  handle('rooms:detachSession', (roomId, sessionId) => roomResult(() => rooms.detachSession(roomId, sessionId)));
  handle('rooms:reportSession', (roomId, sessionId, report) => roomResult(() => rooms.reportSession(roomId, sessionId, report)));
  // A Space's repositories. Linking takes a local repository and sends only its origin's identity.
  handle('spaces:repositories', (workspaceId) => roomResult(() => rooms.listSpaceRepositories(workspaceId)));
  handle('spaces:link', (workspaceId, repositoryId) =>
    roomResult(async () => rooms.linkRepository(workspaceId, await originIdentity(repositoryId))));
  handle('spaces:unlink', (workspaceId, repository) => roomResult(() => rooms.unlinkRepository(workspaceId, repository)));
  handle('spaces:rename', (workspaceId, name) => roomResult(() => rooms.renameSpace(workspaceId, name)));
  handle('record:get', (roomId) => roomResult(() => roomRecord.getRecord(roomId)));
  handle('record:addThread', (roomId, thread) => roomResult(() => roomRecord.addThread(roomId, thread)));
  handle('record:reply', (roomId, threadId, body, authorKind, parentId) => roomResult(() => roomRecord.reply(roomId, threadId, body, authorKind === 'agent' ? 'agent' : 'human', parentId ?? null)));
  handle('record:resolve', (roomId, threadId) => roomResult(() => roomRecord.resolve(roomId, threadId)));
  handle('record:propose', (roomId, decision) => roomResult(() => roomRecord.propose(roomId, decision)));
  handle('record:amend', (roomId, decisionId, change) => roomResult(() => roomRecord.amend(roomId, decisionId, change)));
  handle('record:sign', (roomId, decisionId, version) => roomResult(() => roomRecord.sign(roomId, decisionId, version)));
  handle('record:seen', (roomId) => roomResult(() => roomRecord.markSeen(roomId)));
  handle('record:call', (roomId, what) => roomResult(() => roomRecord.logCall(roomId, what)));
  // The Vowe room's record: each write is one checked database function (vowe-record.ts).
  handle('vowe:load', (roomId) => roomResult(async () => voweRecord.load(roomId, { agents: await voweAgents(String(roomId)) })));
  handle('vowe:thread', (roomId, thread, authorKind) => roomResult(() => voweRecord.createThread(roomId, thread, authorKind)));
  handle('vowe:offer', (roomId, threadId, body, offer) => roomResult(() => voweRecord.reply(roomId, threadId, body, 'agent', offer)));
  handle('vowe:answerOffer', (roomId, threadId, replyId, accept) => roomResult(() => voweRecord.answerOffer(roomId, threadId, replyId, accept)));
  handle('vowe:link', (roomId, threadId, about) => roomResult(() => voweRecord.linkThread(roomId, threadId, about)));
  handle('vowe:decision:create', (roomId, decision, authorKind) => roomResult(() => voweRecord.createDecision(roomId, decision, authorKind)));
  handle('vowe:decision:addLine', (roomId, decisionId, kind, text, authorKind) => roomResult(() => voweRecord.addLine(roomId, decisionId, kind, text, authorKind)));
  handle('vowe:decision:editLine', (roomId, decisionId, lineId, text) => roomResult(() => voweRecord.editLine(roomId, decisionId, lineId, text)));
  handle('vowe:decision:suggestLine', (roomId, decisionId, lineId, text, why, authorKind) =>
    roomResult(() => voweRecord.suggestLine(roomId, decisionId, lineId, text, why, authorKind)));
  handle('vowe:decision:editDoc', (roomId, decisionId, field, text) => roomResult(() => voweRecord.editDoc(roomId, decisionId, field, text)));
  handle('vowe:decision:takeSuggestion', (roomId, decisionId, lineId, accept) => roomResult(() => voweRecord.takeSuggestion(roomId, decisionId, lineId, accept)));
  handle('vowe:decision:requestSignatures', (roomId, decisionId, who) => roomResult(() => voweRecord.requestSignatures(roomId, decisionId, who)));
  handle('vowe:decision:requestChanges', (roomId, decisionId, version, text) => roomResult(() => voweRecord.requestChanges(roomId, decisionId, version, text)));
  handle('vowe:decision:amend', (roomId, decisionId) =>
    roomResult(async () => { const v = await voweRecord.amend(roomId, decisionId); return { id: decisionVersionId(v.decisionId, v.version) }; }));
  handle('vowe:decision:setSuggested', (roomId, decisionId, state) => roomResult(() => voweRecord.setSuggested(roomId, decisionId, state)));
  handle('vowe:work:create', (roomId, work, authorKind) => roomResult(() => voweRecord.createWork(roomId, work, authorKind)));
  handle('vowe:work:plan', (roomId, workId, op, base) => roomResult(() => voweRecord.plan(roomId, workId, op, base)));
  handle('vowe:work:suggest', (roomId, workId, revision, authorKind) => roomResult(() => voweRecord.suggestRevision(roomId, workId, revision, authorKind)));
  handle('vowe:work:decideChange', (roomId, workId, changeId, accept) => roomResult(() => voweRecord.decideChange(roomId, workId, changeId, accept)));
  handle('vowe:work:authorize', (roomId, workId, version) => roomResult(() => voweRecord.authorize(roomId, workId, version)));
  handle('vowe:work:requestScope', (roomId, workId, ask, authorKind) => roomResult(() => voweRecord.requestScope(roomId, workId, ask, authorKind)));
  handle('vowe:work:allowScope', (roomId, workId, allow) => roomResult(() => voweRecord.allowScope(roomId, workId, allow)));
  handle('vowe:work:ask', (roomId, workId, question, authorKind) => roomResult(() => voweRecord.ask(roomId, workId, question, authorKind)));
  handle('vowe:work:answer', (roomId, workId, questionId, text) => roomResult(() => voweRecord.answer(roomId, workId, questionId, text)));
  handle('vowe:work:defer', (roomId, workId, questionId) => roomResult(() => voweRecord.defer(roomId, workId, questionId)));
  handle('vowe:work:finding', (roomId, workId, finding, authorKind) => roomResult(() => voweRecord.addFinding(roomId, workId, finding, authorKind)));
  handle('vowe:work:trackPr', (roomId, workId, pr) => roomResult(() => voweRecord.trackPr(roomId, workId, pr)));
  handle('vowe:work:resolve', (roomId, workId) => roomResult(() => voweRecord.resolve(roomId, workId)));
  handle('vowe:attention:done', (roomId, ids) => roomResult(() => voweRecord.markDone(roomId, ids)));
  handle('vowe:settings:agentName', (roomId, name) => roomResult(() => voweRecord.setAgentName(roomId, name)));
  // Invitations: the token in a link is passed through to the database and never logged or kept here.
  handle('invites:list', (roomId) => roomResult(() => invitations.list(roomId)));
  handle('invites:send', (roomId, emails, role) => roomResult(() => invitations.send(roomId, emails, role)));
  handle('invites:createLink', (roomId, settings) => roomResult(() => invitations.createLink(roomId, settings)));
  handle('invites:revoke', (invitationId) => roomResult(() => invitations.revoke(invitationId)));
  handle('invites:mine', () => roomResult(() => invitations.mine()));
  handle('invites:decline', (invitationId) => roomResult(() => invitations.decline(invitationId)));
  handle('inbox:state:get', () => roomResult(() => inboxState.get()));
  handle('inbox:state:save', (marks) => roomResult(() => inboxState.save(marks)));
  handle('invites:resolve', (key) => roomResult(() => invitations.resolve(key)));
  handle('invites:accept', (key) => roomResult(() => invitations.accept(key)));
  // The canvas: every command, a person's or Vowe's, goes through the one hub (main/canvas.ts).
  handle('canvas:load', (roomId) => roomResult(() => loadRoomCanvas(requireString(roomId, 'Room id'))));
  handle('canvas:execute', (roomId, command) => executeAsPerson(requireString(roomId, 'Room id'), command));
  handle('canvas:presence', (roomId, presence) => sharePresence(requireString(roomId, 'Room id'), presence));
  handle('rooms:join', (roomId) => connectRoom(requireString(roomId, 'Room id')));
  handle('rooms:leave', (roomId) => disconnectRoom(requireString(roomId, 'Room id')));
  // sendRoomEvent validates the type and payload against RoomEvents.
  handle('rooms:send', (roomId, type, payload) => sendRoomEvent(requireString(roomId, 'Room id'), type, payload));
  handle('rooms:setCall', (roomId, call) =>
    setRoomCall(requireString(roomId, 'Room id'), parse(z.object({ muted: z.boolean() }).strict().nullable(), call, 'Call')),
  );
  handle('calls:access', (roomId) => getCallAccess(requireString(roomId, 'Room id')));
  handle('calls:requestMicrophone', () => requestMicrophone());
  handle('calls:openMicrophoneSettings', async () => {
    if (process.platform === 'darwin') await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
    else if (process.platform === 'win32') await shell.openExternal('ms-settings:privacy-microphone');
  });

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

  onSessionEnded((failure) => broadcast('auth:ended', failure));
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
  canvas.events.on('changed', ({ roomId, canvas: saved, result }) => broadcast('canvas:changed', { roomId, ...saved, ...(result ? { result } : {}) }));
}
