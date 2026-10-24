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
    signIn: () => invoke('auth:signIn'),
    signOut: () => invoke('auth:signOut'),
    onChange: (listener) => subscribe('auth:changed', listener),
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
  workspaces: {
    list: () => invoke('workspaces:list'),
    create: (name) => invoke('workspaces:create', name),
  },
  rooms: {
    list: (workspaceId) => invoke('rooms:list', workspaceId),
    create: (workspaceId, name) => invoke('rooms:create', workspaceId, name),
    join: (roomId) => invoke('rooms:join', roomId),
    leave: (roomId) => invoke('rooms:leave', roomId),
    send: (roomId, type, payload) => invoke('rooms:send', roomId, type, payload) as Promise<never>,
    onEvent: (listener) => subscribe('rooms:event', listener),
    onPresence: (listener) => subscribe('rooms:presence', listener),
    onStatus: (listener) => subscribe('rooms:status', listener),
  },
  calls: {
    access: (roomId) => invoke('calls:access', roomId),
    requestMicrophone: () => invoke('calls:requestMicrophone'),
  },
};

contextBridge.exposeInMainWorld('journey', api);
