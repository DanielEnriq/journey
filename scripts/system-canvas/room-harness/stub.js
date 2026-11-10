// The room harness's stand-in for Electron's preload (src/preload/index.cts): the real Vowe renderer
// (vowe.html + app.js, the actual RoomScreen and VoweRoom) runs in a plain browser with this as
// `window.journey`. Everything a room reads is served from the fixed, fictional data below, kept in memory
// (writes land there too, so the Desk works); `journey.system.*` goes to the real system-canvas dev server
// over HTTP, so the System view draws Journey's actual registry. Loaded as a module before app.js; module
// scripts run in document order, so this has run before any of the app's modules read window.journey.
//
// Nothing here talks to Supabase, LiveKit or a model provider; there are no keys. Calls the harness doesn't
// serve resolve to a "not-configured" failure (or an empty value) and are logged once, so gaps are visible.
import { httpSystemApi } from '../features/system-canvas/api-client.js';
import { applyCommand, command, emptyDocument } from '../../shared/canvas/index.js';

const T0 = '2026-11-10T09:00:00.000Z';
const ago = (min) => new Date(Date.parse('2026-11-10T12:00:00.000Z') - min * 60000).toISOString();
const ME = { id: 'u-dana', email: 'dana@vowe.test', name: 'Dana Eberly', picture: null, provider: 'github' };
const PEOPLE = [
  { userId: ME.id, name: ME.name, email: ME.email, role: 'owner' },
  { userId: 'u-kevin', name: 'Kevin Pei', email: 'kevin@vowe.test', role: 'member' },
  { userId: 'u-anu', name: 'Anuraghav', email: 'anu@vowe.test', role: 'member' },
];
const WS = { id: 'ws-journey', name: 'Journey', created_at: T0, created_by: ME.id };
const REPO = 'github.com/vowe/journey';
const room = (id, name, goal, extra = {}) => ({
  id, workspaceId: WS.id, name, goal, repository: REPO, createdBy: ME.id, createdAt: T0, updatedAt: T0,
  keptAt: T0, role: 'owner', pinOrder: null, archivedAt: null, memberCount: 3, ...extra,
});
const ROOMS = [
  room('room-voice', 'Voice test', 'Make session restore never block the first window', { pinOrder: 1 }),
  room('room-canvas', 'Canvas saves', 'Two people drawing never lose a stroke'),
  room('room-signin', 'Sign-in flow', null, { keptAt: null }),
];

// The room's canvas: the architecture the mocks draw, as an ordinary vowe.canvas/1 document.
const ARCH = {
  components: [
    { id: 'renderer', kind: 'service', name: 'Renderer', tech: 'Room UI · canvas surface' },
    { id: 'livekit', kind: 'external', name: 'LiveKit calls', tech: 'WebRTC audio rooms' },
    { id: 'agent-runtime', kind: 'service', name: 'Vowe agent runtime', tech: 'In main · model sign-in' },
    { id: 'auth', kind: 'boundary', name: 'Auth' },
    { id: 'electron-main', kind: 'service', name: 'Electron main process', tech: 'Node · IPC · auth · git', parent: 'auth' },
    { id: 'supabase', kind: 'database', name: 'Supabase', tech: 'Auth · Postgres/RLS · Realtime', parent: 'auth' },
  ],
  relationships: [
    { from: 'renderer', to: 'livekit', kind: 'calls', label: 'WebRTC' },
    { from: 'renderer', to: 'electron-main', kind: 'calls', label: 'IPC requests' },
    { from: 'agent-runtime', to: 'electron-main', kind: 'depends_on', label: 'hosts agent' },
    { from: 'electron-main', to: 'supabase', kind: 'reads_writes', label: 'Auth · record · Realtime' },
  ],
};
const actor = { kind: 'human', id: ME.id, name: ME.name };
let canvas = { roomId: 'room-voice', revision: 1, doc: applyCommand(emptyDocument(), command('load_system', ARCH, 'cmd-h-1'), actor, T0).doc };

const reply = (id, by, body, min, extra = {}) => ({ id, by, body, ago: `${min}m`, ...extra });
const RECORD = {
  goal: { text: 'Make session restore never block the first window', by: ME.id },
  threads: [
    { id: 't-main', about: { kind: 'part', id: 'electron-main', name: 'Electron main process' }, status: 'open', waiting: ME.id,
      replies: [reply('t-main', 'u-kevin', 'Can we open the window first and restore behind the splash?', 9), reply('t-main-2', 'u-anu', 'Restore takes ~400 ms cold; the splash covers it.', 7)] },
    { id: 't-livekit', about: { kind: 'edge', id: 'renderer--calls--livekit', name: 'Renderer → LiveKit calls' }, status: 'open',
      replies: [reply('t-livekit', 'u-kevin', 'The call log is full of TURN lookups failing during network changes. Expected?', 4)] },
    { id: 't-auth', about: { kind: 'part', id: 'auth', name: 'Auth' }, status: 'open',
      replies: [reply('t-auth', 'u-anu', 'Who owns the IPC sender checks once auth moves behind the splash?', 22)] },
    { id: 't-ops', about: { kind: 'part', id: 'renderer', name: 'Renderer' }, status: 'open',
      replies: [reply('t-ops', ME.id, 'Should canvas ops batch before they go out on Realtime, or stay one write each?', 60)] },
  ],
  decisions: [], work: [], notices: [], call: false,
  members: PEOPLE.map((p) => ({ who: p.userId, role: p.role, name: p.name })),
  done: [], vowe: true, agentName: 'dot', agents: [{ name: 'Claude Code', status: 'not-connected', note: 'No coding agent on this machine (harness).' }],
  me: ME.id, times: {}, log: [],
};

const ok = (value) => ({ ok: true, value });
const notHere = (what) => ({ ok: false, error: { code: 'not-configured', message: `${what}: not served by the room harness` } });
const listeners = new Map();
const on = (name) => (fn) => { const l = listeners.get(name) ?? new Set(); l.add(fn); listeners.set(name, l); return () => l.delete(fn); };
const emit = (name, payload) => { for (const fn of listeners.get(name) ?? []) fn(payload); };
const members = (roomId) => PEOPLE.map((p) => ({ roomId, userId: p.userId, role: p.role, joinedAt: T0, email: p.email, name: p.name, avatarUrl: null }));
const participants = () => [
  { userId: ME.id, name: ME.name, avatarUrl: null, joinedAt: ago(30), call: null },
  { userId: 'u-kevin', name: 'Kevin Pei', avatarUrl: null, joinedAt: ago(20), call: null },
];

const served = {
  auth: {
    getUser: async () => ME, getEnded: async () => null, onChange: on('auth'), onEnded: on('ended'),
    methods: async () => ok([{ provider: 'github', linked: true, email: ME.email }]),
  },
  settings: { get: async () => ({ theme: new URLSearchParams(location.search).get('theme') ?? 'light' }), update: async (p) => ({ theme: 'light', ...p }) },
  repos: { list: async () => [], identities: async () => [], detect: async () => [] },
  workspaces: { list: async () => [WS], repositories: async () => ok([{ workspaceId: WS.id, repository: REPO, addedBy: ME.id, addedAt: T0 }]) },
  rooms: {
    list: async () => ok(ROOMS), get: async (id) => ok(ROOMS.find((r) => r.id === id) ?? ROOMS[0]), members: async (id) => ok(members(id)),
    checkouts: async () => ok([]), sessions: async () => ok([]),
    join: async (roomId) => { setTimeout(() => emit('presence', { roomId, participants: participants() }), 50); return { roomId, selfId: ME.id, participants: participants() }; },
    leave: async () => {}, send: async () => {}, setCall: async () => {},
    onEvent: on('roomEvent'), onPresence: on('presence'), onStatus: on('status'),
  },
  invites: { list: async () => ok([]), mine: async () => ok([]) },
  inbox: { getState: async () => ok(null), saveState: async () => ok(null) },
  record: {
    get: async (roomId) => ok({ roomId, threads: [], decisions: [], activity: [], lastSeenAt: ago(90) }),
    seen: async () => ok(null),
  },
  vowe: { load: async () => ok(structuredClone(RECORD)) },
  canvas: {
    load: async () => ok(canvas),
    execute: async (roomId, cmd) => {
      const r = applyCommand(canvas.doc, cmd, actor, new Date().toISOString());
      if (r.result.ok) canvas = { ...canvas, revision: canvas.revision + 1, doc: r.doc };
      setTimeout(() => emit('canvas', { roomId, revision: canvas.revision }), 0);
      return { result: r.result, canvas };
    },
    presence: async () => {}, onChanged: on('canvas'),
  },
  calls: { access: async () => notHere('calls.access') },
  agent: { status: async () => ({ provider: 'none', providerId: 'none', billing: 'none', model: 'none', configured: false, chatgpt: chatgpt() }), onEvent: on('agentEvent'), onApproval: on('approval'), onToolCall: on('toolCall') },
  chatgpt: { status: async () => chatgpt(), onChange: on('chatgpt') },
  claudeCode: { onEvent: on('cc'), sessions: async () => [], activity: async () => [], hooksStatus: async () => ({ installed: false }) },
  context: { work: async () => { throw new Error('context.work: not served by the room harness'); } },
  voice: { status: async () => ({ state: 'off' }), onStatus: on('voiceStatus'), onSpeech: on('speech'), onSaid: on('said') },
  window: { onFullScreen: on('fullscreen') },
  system: httpSystemApi(''),
};
function chatgpt() { return { enabled: false, account: null, signedIn: false, planUsage: null, welcome: false, problem: null, savedAccounts: [], usageUrl: '' }; }

// Anything else the app asks for: a subscription is a no-op, a call fails as "not configured", once logged.
const missed = new Set();
const fallback = (ns, name) => {
  if (/^on[A-Z]/.test(name)) return () => () => {};
  return async () => {
    if (!missed.has(`${ns}.${name}`)) { missed.add(`${ns}.${name}`); console.info(`[room-harness] ${ns}.${name} not served`); }
    return notHere(`${ns}.${name}`);
  };
};
window.journey = new Proxy({}, {
  get(_t, ns) {
    if (typeof ns !== 'string') return undefined;
    const have = served[ns] ?? {};
    if (ns === 'system') return have;
    return new Proxy(have, { get: (o, name) => (typeof name !== 'string' ? undefined : o[name] ?? fallback(ns, name)) });
  },
});
window.roomHarness = { missed, emit, record: RECORD };
