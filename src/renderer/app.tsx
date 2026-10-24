import { Fragment, h, render } from './vendor/preact.js';
import { useEffect, useLayoutEffect, useRef, useState } from './vendor/preact-hooks.js';
import { CallSession } from './features/call/session.js';
import { RoomScreen } from './features/room/RoomScreen.js';
import { useRooms } from './features/workspace/hooks.js';
import {
  clearDemo, demoCanvas, demoScenario, EXAMPLE_REPOS, loadDemo, resetWorkspace, workspace,
} from './features/workspace/mock/workspace.js';
import { NewRoomSheet } from './features/workspace/NewRoom.js';
import { HomeScreen, LoginScreen } from './features/welcome/WelcomeScreen.js';
import { devFlags, type DevFlags } from './shared/devflags.js';
import { useStore } from './shared/store.js';
import { localTheme, useAppearance } from './shared/theme/theme.js';
import type { NewRoom } from './features/room/data/sources.js';
import type { Theme, User } from '../shared/api.js';

// Vowe's renderer: sign-in → your rooms → a room's preview → its call, plus the design's reference
// sheets and a developer menu. Screens are hash routes kept in localStorage, so a relaunch lands back
// on the same one; a call is the exception, since it is never rejoined without you asking.

type Route =
  | { screen: 'login' }
  | { screen: 'home' }
  | { screen: 'room'; id: string; call: boolean }
  | { screen: 'reference'; sheet: Sheet };

const SHEETS = { Components: 3300, Grammar: 1180, Conversation: 1240, Decisions: 1300, Work: 1220 };
type Sheet = keyof typeof SHEETS;
const ROUTE_KEY = 'vowe.route';
/** No main process (the development preview, or a plain browser): everything here is the mock. */
const PREVIEW = !window.journey;

const session = new CallSession(workspace.call);

function parseRoute(hash: string): Route {
  const [screen, a, b] = hash.replace(/^#\/?/, '').split('/');
  if (screen === 'home') return { screen: 'home' };
  if (screen === 'room' && a) return { screen: 'room', id: decodeURIComponent(a), call: b === 'call' };
  if (screen === 'reference') return { screen: 'reference', sheet: a in SHEETS ? a as Sheet : 'Components' };
  return { screen: 'login' };
}

function routeHash(r: Route) {
  if (r.screen === 'home') return '#/home';
  if (r.screen === 'room') return `#/room/${encodeURIComponent(r.id)}` + (r.call ? '/call' : '');
  if (r.screen === 'reference') return `#/reference/${r.sheet}`;
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

/** The app's signed-in user, from the main process: undefined until it answers. The preview has none. */
function useUser(): User | null | undefined {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  useEffect(() => {
    if (PREVIEW) return;
    window.journey.auth.getUser().then(setUser, () => setUser(null));
    return window.journey.auth.onChange(setUser);
  }, []);
  return user;
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

function DevMenu({ route, go, onClose }: { route: Route; go(r: Route): void; onClose(): void }) {
  const [theme, setTheme] = useState<Theme | null>(PREVIEW ? localTheme.state.theme : null);
  useEffect(() => { if (!PREVIEW) window.journey.settings.get().then((s) => setTheme(s.theme)).catch(() => setTheme(null)); }, []);
  const pickTheme = (t: Theme) => { setTheme(t); if (PREVIEW) localTheme.setState({ theme: t }); else void window.journey.settings.update({ theme: t }); };
  const flags = useStore(devFlags);
  const cs = useStore(session.store);
  const on = (cond: boolean) => cond ? 'on' : '';
  const scenario = demoScenario();
  const demo = (s: 'live' | 'returning') => { void session.leave(); loadDemo(s); go({ screen: 'room', id: 'payments', call: false }); };
  return (
    <div class="devmenu" role="dialog" aria-label="Developer menu">
      <h2>Developer<button type="button" onClick={onClose} aria-label="Close developer menu">Ctrl ⇧ D</button></h2>
      <div class="grp">
        <b>Demo scenario</b>
        <button type="button" class={on(scenario === 'live')} onClick={() => demo('live')}>Payment Reliability · live</button>
        <button type="button" class={on(scenario === 'returning')} onClick={() => demo('returning')}>· returning later</button>
        {scenario && <button type="button" onClick={() => { void session.leave(); clearDemo(); go({ screen: 'home' }); }}>Remove example rooms</button>}
      </div>
      <div class="grp">
        <b>Screens</b>
        <button type="button" class={on(route.screen === 'login')} onClick={() => go({ screen: 'login' })}>Sign in</button>
        <button type="button" class={on(route.screen === 'home')} onClick={() => go({ screen: 'home' })}>Home</button>
        <button type="button" class={on(route.screen === 'reference')} onClick={() => go({ screen: 'reference', sheet: 'Components' })}>Reference sheets</button>
      </div>
      <div class="grp">
        <b>Mock conditions</b>
        {FLAG_LABELS.map(([k, label]) => <button key={k} type="button" class={on(flags[k])} aria-pressed={flags[k]} onClick={() => devFlags.setState({ [k]: !flags[k] })}>{label}</button>)}
        <button type="button" disabled={cs.status !== 'connected'} onClick={() => session.drop()}>Drop the call</button>
      </div>
      <div class="grp">
        <b>Theme</b>
        {(['system', 'light', 'dark'] as Theme[]).map((t) => <button key={t} type="button" class={on(theme === t)} onClick={() => pickTheme(t)}>{t[0].toUpperCase() + t.slice(1)}</button>)}
      </div>
      <div class="grp">
        <b>Data</b>
        <button type="button" onClick={() => { void session.leave(); resetWorkspace(); go({ screen: 'home' }); }}>Clear all rooms</button>
        {!PREVIEW && <button type="button" onClick={() => { location.href = 'index.html'; }}>Earlier setup screen</button>}
      </div>
      <p class="note">Rooms, calls, decisions and coding agents here are mock data, kept in this window’s local storage. Mocks log what they pretend to do: filter the console by <code>[vowe mock]</code>.</p>
    </div>
  );
}

function App() {
  const [route, go] = useRoute();
  const [dev, setDev] = useState(false);
  const [newRoom, setNewRoom] = useState(false);
  const light = useAppearance() === 'light';
  const rooms = useRooms(workspace.room);
  const cs = useStore(session.store);
  const user = useUser();
  // In the app, the main process's sign-in decides: signed out shows only sign-in, and signing in leaves it.
  const signedOut = !PREVIEW && !user;
  useEffect(() => {
    if (PREVIEW || user === undefined) return;
    if (!user && route.screen !== 'login') { void session.leave(); go({ screen: 'login' }); }
    if (user && route.screen === 'login') go({ screen: 'home' });
  }, [user, route.screen]);
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
    if (!signedOut && route.screen === 'room' && route.call && !inCall) go({ screen: 'room', id: route.id, call: false });
  }, [route, inCall, cs.status]);

  /** Leaving a room leaves its call: the call belongs to the room. */
  const leaveCallUnlessIn = (id: string | null) => { if (session.state.roomId && session.state.roomId !== id) void session.leave(); };
  const home = () => { leaveCallUnlessIn(null); go({ screen: 'home' }); };
  const openRoom = (id: string) => { leaveCallUnlessIn(id); go({ screen: 'room', id, call: false }); };
  const create = (r: NewRoom) => { setNewRoom(false); const made = workspace.room.create(r); openRoom(made.id); };
  const overlay = newRoom ? <NewRoomSheet repos={EXAMPLE_REPOS} onCreate={create} onClose={() => setNewRoom(false)} /> : null;

  let screen;
  if (signedOut && user === undefined) screen = null;
  else if (signedOut || route.screen === 'login') screen = <><div class="drag-strip"></div><LoginScreen light={light} signIn={PREVIEW ? undefined : () => window.journey.auth.signIn()} onSignedIn={home} /></>;
  else if (route.screen === 'home') screen = <HomeScreen light={light} rooms={rooms} repos={EXAMPLE_REPOS} onOpenRoom={openRoom} onCreate={create} onNewRoom={() => setNewRoom(true)} overlay={overlay} />;
  else if (route.screen === 'room') {
    const id = route.id;
    screen = (
      <RoomScreen key={id} sources={workspace} roomId={id} inCall={inCall} session={session}
        canvas={id === 'payments' ? demoCanvas() : null} light={light} overlay={overlay}
        onOpenRoom={openRoom} onNewRoom={() => setNewRoom(true)} onHome={home}
        onJoin={async () => { if (await session.join(id)) go({ screen: 'room', id, call: true }); }}
        onLeave={async () => { await session.leave(); go({ screen: 'room', id, call: false }); }} />
    );
  }
  else screen = <ReferenceScreen sheet={route.sheet} go={(sheet) => go({ screen: 'reference', sheet })} onClose={home} />;

  return (
    <>
      {screen}
      {PREVIEW && !dev && <button class="devpill" type="button" title="Developer menu · Ctrl ⇧ D" onClick={() => setDev(true)}>Preview · mock data</button>}
      {dev && <DevMenu route={route} go={go} onClose={() => setDev(false)} />}
    </>
  );
}

if (navigator.userAgent.includes('Electron')) document.documentElement.classList.add('in-electron');
render(<App />, document.getElementById('app')!);
