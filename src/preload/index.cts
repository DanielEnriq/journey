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
    identities: () => invoke('repos:identities'),
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
    repositories: (workspaceId) => invoke('spaces:repositories', workspaceId),
    link: (workspaceId, repositoryId) => invoke('spaces:link', workspaceId, repositoryId),
    unlink: (workspaceId, repository) => invoke('spaces:unlink', workspaceId, repository),
    rename: (workspaceId, name) => invoke('spaces:rename', workspaceId, name),
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
    checkouts: (roomId) => invoke('rooms:checkouts', roomId),
    keep: (roomId, keep) => invoke('rooms:keep', roomId, keep),
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
    decline: (invitationId) => invoke('invites:decline', invitationId),
    resolve: (key) => invoke('invites:resolve', key),
    accept: (key) => invoke('invites:accept', key),
  },
  inbox: {
    getState: () => invoke('inbox:state:get'),
    saveState: (marks) => invoke('inbox:state:save', marks),
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
  vowe: {
    load: (roomId) => invoke('vowe:load', roomId),
    thread: (roomId, thread, authorKind) => invoke('vowe:thread', roomId, thread, authorKind),
    offer: (roomId, threadId, body, offer) => invoke('vowe:offer', roomId, threadId, body, offer),
    answerOffer: (roomId, threadId, replyId, accept) => invoke('vowe:answerOffer', roomId, threadId, replyId, accept),
    link: (roomId, threadId, about) => invoke('vowe:link', roomId, threadId, about),
    decisions: {
      create: (roomId, decision, authorKind) => invoke('vowe:decision:create', roomId, decision, authorKind),
      addLine: (roomId, decisionId, kind, text, authorKind) => invoke('vowe:decision:addLine', roomId, decisionId, kind, text, authorKind),
      editLine: (roomId, decisionId, lineId, text) => invoke('vowe:decision:editLine', roomId, decisionId, lineId, text),
      suggestLine: (roomId, decisionId, lineId, text, why, authorKind) => invoke('vowe:decision:suggestLine', roomId, decisionId, lineId, text, why, authorKind),
      editDoc: (roomId, decisionId, field, text) => invoke('vowe:decision:editDoc', roomId, decisionId, field, text),
      takeSuggestion: (roomId, decisionId, lineId, accept) => invoke('vowe:decision:takeSuggestion', roomId, decisionId, lineId, accept),
      requestSignatures: (roomId, decisionId, who) => invoke('vowe:decision:requestSignatures', roomId, decisionId, who),
      requestChanges: (roomId, decisionId, version, text) => invoke('vowe:decision:requestChanges', roomId, decisionId, version, text),
      amend: (roomId, decisionId) => invoke('vowe:decision:amend', roomId, decisionId),
      setSuggested: (roomId, decisionId, state) => invoke('vowe:decision:setSuggested', roomId, decisionId, state),
    },
    work: {
      create: (roomId, work, authorKind) => invoke('vowe:work:create', roomId, work, authorKind),
      plan: (roomId, workId, op, base) => invoke('vowe:work:plan', roomId, workId, op, base),
      suggest: (roomId, workId, revision, authorKind) => invoke('vowe:work:suggest', roomId, workId, revision, authorKind),
      decideChange: (roomId, workId, changeId, accept) => invoke('vowe:work:decideChange', roomId, workId, changeId, accept),
      authorize: (roomId, workId, version) => invoke('vowe:work:authorize', roomId, workId, version),
      requestScope: (roomId, workId, ask, authorKind) => invoke('vowe:work:requestScope', roomId, workId, ask, authorKind),
      allowScope: (roomId, workId, allow) => invoke('vowe:work:allowScope', roomId, workId, allow),
      ask: (roomId, workId, question, authorKind) => invoke('vowe:work:ask', roomId, workId, question, authorKind),
      answer: (roomId, workId, questionId, text) => invoke('vowe:work:answer', roomId, workId, questionId, text),
      defer: (roomId, workId, questionId) => invoke('vowe:work:defer', roomId, workId, questionId),
      finding: (roomId, workId, finding, authorKind) => invoke('vowe:work:finding', roomId, workId, finding, authorKind),
      trackPr: (roomId, workId, pr) => invoke('vowe:work:trackPr', roomId, workId, pr),
      resolve: (roomId, workId) => invoke('vowe:work:resolve', roomId, workId),
    },
    markDone: (roomId, ids) => invoke('vowe:attention:done', roomId, ids),
    setAgentName: (roomId, name) => invoke('vowe:settings:agentName', roomId, name),
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
  window: {
    onFullScreen: (listener) => subscribe('window:fullScreen', listener),
  },
};

contextBridge.exposeInMainWorld('journey', api);
