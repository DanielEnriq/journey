import { Fragment, h, render } from './vendor/preact.js';
import { useEffect, useLayoutEffect, useRef, useState } from './vendor/preact-hooks.js';
import { CallSession } from './features/call/session.js';
import { RoomPanelPreview } from './features/room/panel/RoomPanelPreview.js';
import { RoomScreen } from './features/room/RoomScreen.js';
import { useRooms } from './features/workspace/hooks.js';
import {
  clearDemo, demoCanvas, demoScenario, EXAMPLE_REPOS, loadDemo, resetWorkspace, workspace as demoWorkspace,
} from './features/workspace/mock/workspace.js';
import { addLocalRepo, attachErrors, localRepos, realStatus, realWorkspace, startRealWorkspace } from './features/workspace/real/workspace.js';
import { NewRoomSheet } from './features/workspace/NewRoom.js';
import { HomeScreen, LoginScreen } from './features/welcome/WelcomeScreen.js';
import { devFlags, type DevFlags } from './shared/devflags.js';
import { useStore } from './shared/store.js';
import { useAppearance, useThemeSetting } from './shared/theme/theme.js';
import { account } from './shared/account.js';
import type { NewRoom, RepoChoice } from './features/room/data/sources.js';
import type { Theme } from '../shared/api.js';

// Vowe's renderer: sign-in → your rooms → a room's preview → its call, plus the design's reference
// sheets and a developer menu. Screens are hash routes kept in localStorage, so a relaunch lands back
// on the same one; a call is the exception, since it is never rejoined without you asking.
//
// Two workspaces, never mixed: your real rooms (#/home, #/room/…), and the Payment Reliability demo
// (#/demo/home, #/demo/room/…), reached from the developer menu and marked as a demo while it shows.
// The browser preview has no main process, so it only has the demo.

type Route =
  | { screen: 'login' }
  | { screen: 'home'; demo: boolean }
  | { screen: 'room'; id: string; call: boolean; demo: boolean }
  | { screen: 'reference'; sheet: Sheet }
  | { screen: 'room-panel' };

const SHEETS = { Components: 3300, Grammar: 1180, Conversation: 1240, Decisions: 1300, Work: 1220 };
type Sheet = keyof typeof SHEETS;
const ROUTE_KEY = 'vowe.route';
/** No main process (the development preview, or a plain browser): only the demo exists here. */
const PREVIEW = !window.journey;

const demoSession = new CallSession(demoWorkspace.call);
const realSession = new CallSession(realWorkspace.call);
if (!PREVIEW) startRealWorkspace();

function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/');
  const demo = PREVIEW || parts[0] === 'demo';
  if (parts[0] === 'demo') parts.shift();
  const [screen, a, b] = parts;
  if (screen === 'home') return { screen: 'home', demo };
  if (screen === 'room' && a) return { screen: 'room', id: decodeURIComponent(a), call: b === 'call', demo };
  if (screen === 'reference') return { screen: 'reference', sheet: a in SHEETS ? a as Sheet : 'Components' };
  if (screen === 'dev' && a === 'room-panel') return { screen: 'room-panel' };
  return { screen: 'login' };
}

function routeHash(r: Route) {
  const d = (r.screen === 'home' || r.screen === 'room') && r.demo && !PREVIEW ? '#/demo' : '#';
  if (r.screen === 'home') return `${d}/home`;
  if (r.screen === 'room') return `${d}/room/${encodeURIComponent(r.id)}` + (r.call ? '/call' : '');
  if (r.screen === 'reference') return `#/reference/${r.sheet}`;
  if (r.screen === 'room-panel') return '#/dev/room-panel';
  return '#/login';
}

function initialRoute(): Route {
  let hash = location.hash;
  if (!hash) { try { hash = localStorage.getItem(ROUTE_KEY) || '#/login'; } catch { hash = '#/login'; } }
  const r = parseRoute(hash);
  return r.screen === 'room' ? { ...r, call: false } : r;
}

function useRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState(initialRoute);
  useEffect(() => {
    const onHash = () => setRoute(parseRoute(location.hash));
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    const hash = routeHash(route);
    if (location.hash !== hash) history.replaceState(null, '', hash);
    // Remember the room, not the call.
    try { localStorage.setItem(ROUTE_KEY, routeHash(route.screen === 'room' ? { ...route, call: false } : route)); } catch { /* storage may be unavailable */ }
  }, [route]);
  return [route, (r) => { location.hash = routeHash(r); }];
}

/** The design's static boards, each scaled to the window width. */
function ReferenceScreen({ sheet, go, onClose }: { sheet: Sheet; go(s: Sheet): void; onClose(): void }) {
  const scroll = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1440);
  useLayoutEffect(() => {
    const el = scroll.current!;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const k = width / 1440, height = SHEETS[sheet];
  return (
    <div class="reference">
      <div class="bar">
        {(Object.keys(SHEETS) as Sheet[]).map((s) => <button key={s} type="button" class={s === sheet ? 'on' : ''} onClick={() => go(s)}>{s}</button>)}
        <span class="grow"></span>
        <button type="button" onClick={onClose}>Back to the app</button>
      </div>
      <div class="scroll" ref={scroll}>
        <div class="sheet" style={`height:${height * k}px`}>
          <iframe key={sheet} src={`reference/${sheet}.html`} title={`${sheet} reference sheet`} style={`height:${height}px;transform:scale(${k})`}></iframe>
        </div>
      </div>
    </div>
  );
}

const FLAG_LABELS: [keyof DevFlags, string][] = [
  ['slowCall', 'Slow call connection'], ['failCall', 'Call can’t connect'], ['slowWork', 'Slow work context'], ['failWork', 'Work context unavailable'],
];

const inDemo = (r: Route) => (r.screen === 'home' || r.screen === 'room') && r.demo;

function DevMenu({ route, go, onClose }: { route: Route; go(r: Route): void; onClose(): void }) {
  const [theme, pickTheme] = useThemeSetting();
  const flags = useStore(devFlags);
  const cs = useStore(demoSession.store);
  const on = (cond: boolean) => cond ? 'on' : '';
  const scenario = demoScenario();
  const demo = (s: 'live' | 'returning') => { void demoSession.leave(); loadDemo(s); go({ screen: 'room', id: 'payments', call: false, demo: true }); };
  return (
    <div class="devmenu" role="dialog" aria-label="Developer menu">
      <h2>Developer<button type="button" onClick={onClose} aria-label="Close developer menu">Ctrl ⇧ D</button></h2>
      <div class="grp">
        <b>Demo scenario</b>
        <button type="button" class={on(scenario === 'live')} onClick={() => demo('live')}>Payment Reliability · live</button>
        <button type="button" class={on(scenario === 'returning')} onClick={() => demo('returning')}>· returning later</button>
        <button type="button" class={on(route.screen === 'home' && route.demo)} onClick={() => go({ screen: 'home', demo: true })}>Demo home</button>
        {scenario && <button type="button" onClick={() => { void demoSession.leave(); clearDemo(); go({ screen: 'home', demo: true }); }}>Remove example rooms</button>}
      </div>
      <div class="grp">
        <b>Screens</b>
        <button type="button" class={on(route.screen === 'login')} onClick={() => go({ screen: 'login' })}>Sign in</button>
        <button type="button" class={on(route.screen === 'home' && !route.demo)} onClick={() => go({ screen: 'home', demo: false })}>{PREVIEW ? 'Home' : 'Your rooms'}</button>
        <button type="button" class={on(route.screen === 'reference')} onClick={() => go({ screen: 'reference', sheet: 'Components' })}>Reference sheets</button>
        <button type="button" class={on(route.screen === 'room-panel')} onClick={() => go({ screen: 'room-panel' })}>Room panel, on fixtures</button>
      </div>
      <div class="grp">
        <b>Demo conditions</b>
        {FLAG_LABELS.map(([k, label]) => <button key={k} type="button" class={on(flags[k])} aria-pressed={flags[k]} onClick={() => devFlags.setState({ [k]: !flags[k] })}>{label}</button>)}
        <button type="button" disabled={cs.status !== 'connected'} onClick={() => demoSession.drop()}>Drop the call</button>
      </div>
      <div class="grp">
        <b>Theme</b>
        {(['system', 'light', 'dark'] as Theme[]).map((t) => <button key={t} type="button" class={on(theme === t)} onClick={() => pickTheme(t)}>{t[0].toUpperCase() + t.slice(1)}</button>)}
      </div>
      <div class="grp">
        <b>Data</b>
        <button type="button" onClick={() => { void demoSession.leave(); resetWorkspace(); go({ screen: 'home', demo: true }); }}>Clear the demo’s rooms</button>
        {!PREVIEW && <button type="button" onClick={() => { location.href = 'index.html'; }}>Earlier setup screen</button>}
      </div>
      <p class="note">{PREVIEW ? '' : 'Your rooms are real: Supabase rooms and their record, and Claude Code work on this machine. '}The demo’s rooms, calls, decisions and coding agents are mock data, kept in this window’s local storage, and never mix with real rooms. Mocks log what they pretend to do: filter the console by <code>[vowe mock]</code>.</p>
    </div>
  );
}

function App() {
  const [route, go] = useRoute();
  const [dev, setDev] = useState(false);
  const [newRoom, setNewRoom] = useState(false);
  const [homeError, setHomeError] = useState<string | null>(null);
  const [repos, setRepos] = useState<RepoChoice[]>([]);
  const light = useAppearance() === 'light';
  const demo = inDemo(route);
  const ws = demo ? demoWorkspace : realWorkspace;
  const session = demo ? demoSession : realSession;
  const rooms = useRooms(ws.room);
  const cs = useStore(session.store);
  const real = useStore(realStatus);
  const { user } = useStore(account);
  // In the app, the main process's sign-in decides: signed out shows only sign-in, and signing in leaves it.
  const signedOut = !PREVIEW && !user;
  useEffect(() => {
    if (PREVIEW || user === undefined) return;
    if (!user && route.screen !== 'login') go({ screen: 'login' });
    if (user && route.screen === 'login') go({ screen: 'home', demo: false });
  }, [user, route.screen]);
  // Signing out, in the app or the preview, ends any call; so does crossing between the demo and your rooms.
  useEffect(() => { if (route.screen === 'login') { void demoSession.leave(); void realSession.leave(); } }, [route.screen]);
  useEffect(() => { void (demo ? realSession : demoSession).leave(); }, [demo]);
  // Repositories added on this machine, for the room pickers.
  const loadRepos = () => { if (!PREVIEW && user) localRepos().then(setRepos, () => setRepos([])); };
  useEffect(loadRepos, [user, newRoom]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd') { e.preventDefault(); setDev((d) => !d); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  // A call route with no call behind it (a reload, a failed join) shows the room from outside.
  const inCall = route.screen === 'room' && route.call && session.inRoom(route.id);
  useEffect(() => {
    if (!signedOut && route.screen === 'room' && route.call && !inCall) go({ ...route, call: false });
  }, [route, inCall, cs.status]);

  /** Leaving a room leaves its call: the call belongs to the room. */
  const leaveCallUnlessIn = (id: string | null) => { if (session.state.roomId && session.state.roomId !== id) void session.leave(); };
  const home = () => { leaveCallUnlessIn(null); go({ screen: 'home', demo }); };
  const openRoom = (id: string) => { leaveCallUnlessIn(id); go({ screen: 'room', id, call: false, demo }); };
  const create = async (r: NewRoom) => {
    setHomeError(null);
    const made = await ws.room.create(r);
    setNewRoom(false);
    openRoom(made.id);
  };
  const choices = demo ? EXAMPLE_REPOS : repos;
  const repoNote = demo ? 'examples · this is the demo' : repos.length ? 'added on this machine · only its remote is shared' : 'none added on this machine yet';
  const addRepo = demo ? undefined : () => addLocalRepo().then((r) => { loadRepos(); return r; });
  const overlay = newRoom ? <NewRoomSheet repos={choices} repoNote={repoNote} onAddRepo={addRepo} onCreate={create} onClose={() => setNewRoom(false)} /> : null;
  const notice = homeError ?? (!demo && real.state === 'failed' ? `Couldn’t read your rooms: ${real.error}` : null);

  let screen;
  if (signedOut && user === undefined) screen = null;
  else if (signedOut || route.screen === 'login') screen = <><div class="drag-strip"></div><LoginScreen light={light} signIn={PREVIEW ? undefined : () => window.journey.auth.signIn()} onSignedIn={home} /></>;
  else if (route.screen === 'home') {
    screen = <HomeScreen light={light} rooms={rooms} repos={choices} repoNote={repoNote} simulatedMic={demo} notice={notice} onOpenRoom={openRoom}
      onCreate={(r) => { create(r).catch((err: Error) => setHomeError(`Couldn’t create the room: ${err.message}`)); }} onNewRoom={() => setNewRoom(true)} overlay={overlay} />;
  } else if (route.screen === 'room') {
    const id = route.id;
    screen = (
      <RoomScreen key={`${demo}:${id}`} sources={ws} record={demo ? undefined : realWorkspace.record} roomId={id} inCall={inCall} session={session}
        canvas={demo && id === 'payments' ? demoCanvas() : null} attachError={demo ? undefined : attachErrors.get(id)} light={light} overlay={overlay}
        onOpenRoom={openRoom} onNewRoom={() => setNewRoom(true)} onHome={home}
        onJoin={async () => { if (await session.join(id)) go({ screen: 'room', id, call: true, demo }); }}
        onLeave={async () => { await session.leave(); go({ screen: 'room', id, call: false, demo }); }} />
    );
  }
  else if (route.screen === 'room-panel') screen = <div class={'win panel-dev' + (light ? ' light' : '')}><RoomPanelPreview /></div>;
  else screen = <ReferenceScreen sheet={route.sheet} go={(sheet) => go({ screen: 'reference', sheet })} onClose={home} />;

  return (
    <>
      {screen}
      {PREVIEW && !dev && <button class="devpill" type="button" title="Developer menu · Ctrl ⇧ D" onClick={() => setDev(true)}>Preview · mock data</button>}
      {!PREVIEW && demo && !signedOut && (
        <button class="devpill" type="button" title="Leave the demo for your own rooms" onClick={() => { void demoSession.leave(); go({ screen: 'home', demo: false }); }}>Demo · example data · Exit</button>
      )}
      {dev && <DevMenu route={route} go={go} onClose={() => setDev(false)} />}
    </>
  );
}

if (navigator.userAgent.includes('Electron')) document.documentElement.classList.add('in-electron');
render(<App />, document.getElementById('app')!);
