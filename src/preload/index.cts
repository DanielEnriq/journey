// CommonJS (.cts) because sandboxed preloads can't be ES modules, and they can only
// require 'electron' at runtime, so local imports here must be type-only.
//
// Never expose ipcRenderer itself or a generic invoke(channel): the renderer gets
// named functions only, so it can't reach a channel we didn't mean to give it.
import { contextBridge, ipcRenderer } from 'electron';
import type { Channels, EventChannel, InvokeArgs, InvokeChannel, InvokeResult, JourneyApi } from '../shared/api.js';

function invoke<K extends InvokeChannel>(channel: K, ...args: InvokeArgs<K>): Promise<InvokeResult<K>> {
  return ipcRenderer.invoke(channel, ...args);
}

function subscribe<K extends EventChannel>(channel: K, listener: (payload: Channels['event'][K]) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: Channels['event'][K]) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

const api: JourneyApi = {
  auth: {
    getUser: () => invoke('auth:getUser'),
    getEnded: () => invoke('auth:getEnded'),
    signIn: (provider) => invoke('auth:signIn', provider),
    cancel: () => invoke('auth:cancel'),
    signOut: () => invoke('auth:signOut'),
    onChange: (listener) => subscribe('auth:changed', listener),
    onEnded: (listener) => subscribe('auth:ended', listener),
    methods: () => invoke('auth:methods'),
    link: (provider) => invoke('auth:link', provider),
    unlink: (provider) => invoke('auth:unlink', provider),
  },
  settings: {
    get: () => invoke('settings:get'),
    update: (patch) => invoke('settings:update', patch),
  },
  repos: {
    list: () => invoke('repos:list'),
    add: () => invoke('repos:add'),
    remove: (id) => invoke('repos:remove', id),
    detect: () => invoke('repos:detect'),
    addDetected: (path) => invoke('repos:addDetected', path),
    open: (id) => invoke('repos:open', id),
  },
  git: {
    status: (repositoryId) => invoke('git:status', repositoryId),
    branches: (repositoryId) => invoke('git:branches', repositoryId),
    worktrees: (repositoryId) => invoke('git:worktrees', repositoryId),
  },
  claudeCode: {
    sessions: (repositoryId) => invoke('claudeCode:sessions', repositoryId),
    session: (repositoryId, sessionId) => invoke('claudeCode:session', repositoryId, sessionId),
    messages: (repositoryId, sessionId, page = {}) => invoke('claudeCode:messages', repositoryId, sessionId, page),
    activity: (repositoryId) => invoke('claudeCode:activity', repositoryId),
    hooksStatus: () => invoke('claudeCode:hooksStatus'),
    installHooks: () => invoke('claudeCode:installHooks'),
    uninstallHooks: () => invoke('claudeCode:uninstallHooks'),
    onEvent: (listener) => subscribe('claudeCode:event', listener),
  },
  context: {
    work: (repositoryId) => invoke('context:work', repositoryId),
    repository: (repositoryId) => invoke('context:repository', repositoryId),
    workstreams: (repositoryId) => invoke('context:workstreams', repositoryId),
    workstream: (workstreamId) => invoke('context:workstream', workstreamId),
    session: (sessionId) => invoke('context:session', sessionId),
  },
  workspaces: {
    list: () => invoke('workspaces:list'),
    create: (name) => invoke('workspaces:create', name),
  },
  rooms: {
    list: (workspaceId) => invoke('rooms:list', workspaceId),
    get: (roomId) => invoke('rooms:get', roomId),
    create: (room) => invoke('rooms:create', room),
    update: (roomId, patch) => invoke('rooms:update', roomId, patch),
    delete: (roomId) => invoke('rooms:delete', roomId),
    members: (roomId) => invoke('rooms:members', roomId),
    addMember: (roomId, userId, role) => invoke('rooms:addMember', roomId, userId, role),
    setMemberRole: (roomId, userId, role) => invoke('rooms:setMemberRole', roomId, userId, role),
    removeMember: (roomId, userId) => invoke('rooms:removeMember', roomId, userId),
    attachRepository: (roomId, repositoryId) => invoke('rooms:attachRepository', roomId, repositoryId),
    checkout: (roomId) => invoke('rooms:checkout', roomId),
    join: (roomId) => invoke('rooms:join', roomId),
    leave: (roomId) => invoke('rooms:leave', roomId),
    send: (roomId, type, payload) => invoke('rooms:send', roomId, type, payload) as Promise<never>,
    onEvent: (listener) => subscribe('rooms:event', listener),
    onPresence: (listener) => subscribe('rooms:presence', listener),
    onStatus: (listener) => subscribe('rooms:status', listener),
    setCall: (roomId, call) => invoke('rooms:setCall', roomId, call),
  },
  invites: {
    list: (roomId) => invoke('invites:list', roomId),
    send: (roomId, emails, role) => invoke('invites:send', roomId, emails, role),
    createLink: (roomId, settings) => invoke('invites:createLink', roomId, settings),
    revoke: (invitationId) => invoke('invites:revoke', invitationId),
    mine: () => invoke('invites:mine'),
    resolve: (key) => invoke('invites:resolve', key),
    accept: (key) => invoke('invites:accept', key),
  },
  record: {
    get: (roomId) => invoke('record:get', roomId),
    addThread: (roomId, thread) => invoke('record:addThread', roomId, thread),
    reply: (roomId, threadId, body, authorKind) => invoke('record:reply', roomId, threadId, body, authorKind),
    resolve: (roomId, threadId) => invoke('record:resolve', roomId, threadId),
    propose: (roomId, decision) => invoke('record:propose', roomId, decision),
    amend: (roomId, decisionId, change) => invoke('record:amend', roomId, decisionId, change),
    sign: (roomId, decisionId, version) => invoke('record:sign', roomId, decisionId, version),
    seen: (roomId) => invoke('record:seen', roomId),
    call: (roomId, what) => invoke('record:call', roomId, what),
  },
  canvas: {
    load: (roomId) => invoke('canvas:load', roomId),
    execute: (roomId, command) => invoke('canvas:execute', roomId, command),
    presence: (roomId, presence) => invoke('canvas:presence', roomId, presence),
    onChanged: (listener) => subscribe('canvas:changed', listener),
  },
  calls: {
    access: (roomId) => invoke('calls:access', roomId),
    requestMicrophone: () => invoke('calls:requestMicrophone'),
    openMicrophoneSettings: () => invoke('calls:openMicrophoneSettings'),
  },
  agent: {
    status: () => invoke('agent:status'),
    send: (conversationId, context, text) => invoke('agent:send', conversationId, context, text),
    approve: (approvalId, approved) => invoke('agent:approve', approvalId, approved),
    reset: (conversationId) => invoke('agent:reset', conversationId),
    onApproval: (listener) => subscribe('agent:approval', listener),
    onToolCall: (listener) => subscribe('agent:toolCall', listener),
    ask: (turn) => invoke('agent:ask', turn),
    cancel: (turnId) => invoke('agent:cancel', turnId),
    onEvent: (listener) => subscribe('agent:event', listener),
  },
  chatgpt: {
    status: () => invoke('chatgpt:status'),
    signIn: (account) => invoke('chatgpt:signIn', account),
    signOut: () => invoke('chatgpt:signOut'),
    dismissWelcome: () => invoke('chatgpt:dismissWelcome'),
    onChange: (listener) => subscribe('chatgpt:changed', listener),
  },
  voice: {
    start: (roomId) => invoke('voice:start', roomId),
    stop: () => invoke('voice:stop'),
    status: () => invoke('voice:status'),
    audio: (roomId, pcm) => invoke('voice:audio', roomId, pcm),
    begin: (turnId) => invoke('voice:begin', turnId),
    say: (turnId, text) => invoke('voice:say', turnId, text),
    end: (turnId) => invoke('voice:end', turnId),
    cancel: (turnId) => invoke('voice:cancel', turnId),
    onStatus: (listener) => subscribe('voice:status', listener),
    onSpeech: (listener) => subscribe('voice:speech', listener),
    onSaid: (listener) => subscribe('voice:said', listener),
  },
};

contextBridge.exposeInMainWorld('journey', api);
