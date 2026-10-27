import { Fragment, h, render } from './vendor/preact.js';
import { useEffect, useLayoutEffect, useRef, useState } from './vendor/preact-hooks.js';
import { callLayout, joinPlan } from './features/call/continuity.js';
import { CallSession } from './features/call/session.js';
import { ConfirmDialog } from './features/membership/primitives.js';
import { CanvasHarness } from './features/canvas/Harness.js';
import { RoomPanelPreview } from './features/room/panel/RoomPanelPreview.js';
import { RoomScreen } from './features/room/RoomScreen.js';
import { useRooms } from './features/workspace/hooks.js';
import { ipcTransport } from './features/canvas/client.js';
import { clearDemo, demoLoaded, EXAMPLE_REPOS, loadDemo, resetWorkspace, workspace as demoWorkspace } from './features/workspace/mock/workspace.js';
import { demoCanvas } from './features/workspace/mock/canvas.js';
import { DEMO_ME, demoReply, demoVowe } from './features/workspace/mock/record.js';
import {
  addLocalRepo, attachErrors, callEnded, localRepos, realStatus, realWorkspace, RoomUnavailable, selfCloudId, startRealWorkspace, voice,
} from './features/workspace/real/workspace.js';
import type { LandingState, MembershipError } from './features/membership/model.js';
import { Home, type HomePage } from './features/home/Home.js';
import { bindInbox } from './features/inbox/real.js';
import { activeInbox } from './features/inbox/source.js';
import { LoginScreen, OpeningVowe } from './features/welcome/LoginScreen.js';
import { CreateRoomSheet } from './ui/pass2/rooms/CreateRoom.js';
import { InviteGate } from './ui/pass2/invites/InviteGate.js';
import { devFlags, type DevFlags } from './shared/devflags.js';
import { useStore } from './shared/store.js';
import { useAppearance, useThemeSetting } from './shared/theme/theme.js';
import { account, signIn } from './shared/account.js';
import type { NewRoom, RepoChoice } from './features/room/data/sources.js';
import type { InviteKey, Theme } from '../shared/api.js';

// Vowe's renderer: sign-in → Home, your Inbox (invitations arrive there) → a room's preview → its call, plus the design's reference
// sheets and a developer menu. Screens are hash routes kept in localStorage, so a relaunch lands back
// on the same one; a call is the exception, since it is never rejoined without you asking.
//
// Two workspaces, never mixed: your real rooms (#/home, #/room/…), and
// the Payment Reliability demo (#/demo/home, #/demo/room/…, and so on), reached from the developer menu and marked as a demo while it shows.
// The browser preview has no main process, so it only has the demo.

type Route =
  | { screen: 'login' }
  | { screen: 'home'; demo: boolean; page?: HomePage; item?: string }
  | { screen: 'room'; id: string; call: boolean; demo: boolean }
  | { screen: 'reference'; sheet: Sheet }
  | { screen: 'room-panel' }
  | { screen: 'canvas-dev'; room?: string };

const SHEETS = { Components: 3300, Grammar: 1180, Conversation: 1240, Decisions: 1300, Work: 1220 };
type Sheet = keyof typeof SHEETS;
const ROUTE_KEY = 'vowe.route';
/** No main process (the development preview, or a plain browser): only the demo exists here. */
const PREVIEW = !window.journey;
/** Home's pages, each its own route under the same shell. */
const PAGES: HomePage[] = ['home'];

const demoSession = new CallSession(demoWorkspace.call);
/** Your rooms' canvases: main's hub over IPC, acting as the signed-in person. */
const realCanvas = PREVIEW ? null : ipcTransport(() => ({ kind: 'human', id: selfCloudId() ?? 'me', name: account.state.user?.name ?? 'You' }));
/** The demo's rooms, as the room screen reads them; the same screens as your rooms' over example data. */
const demoRoom = {
  canvas: demoCanvas, vowe: demoVowe, self: () => DEMO_ME, example: true,
  agentReply: async (roomId: string, threadId: string, body: string) => { const r = demoReply(roomId, threadId, body, 'vowe'); if (!r.ok) throw new Error(r.error.message); },
};
const realSession = new CallSession(realWorkspace.call);
if (!PREVIEW) startRealWorkspace();
// The call ending without you asking: a lost connection offers a rejoin; being taken off it leaves.
callEnded.dropped = (roomId) => { if (realSession.state.roomId === roomId) realSession.lost(); };
callEnded.ended = (roomId) => { if (realSession.state.roomId === roomId) void realSession.leave(); };

function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/');
  const demo = PREVIEW || parts[0] === 'demo';
  if (parts[0] === 'demo') parts.shift();
  const [screen, a, b] = parts;
  if (screen === 'home' && a === 'i' && b) return { screen: 'home', demo, item: decodeURIComponent(b) };
  // Invitations now arrive in the Inbox: an old #/invitations link lands there.
  if (screen === 'invitations') return { screen: 'home', demo };
  if (PAGES.includes(screen as HomePage)) return { screen: 'home', demo, ...(screen === 'home' ? {} : { page: screen as HomePage }) };
  if (screen === 'room' && a) return { screen: 'room', id: decodeURIComponent(a), call: b === 'call', demo };
  if (screen === 'reference') return { screen: 'reference', sheet: a in SHEETS ? a as Sheet : 'Components' };
  if (screen === 'dev' && a === 'room-panel') return { screen: 'room-panel' };
  if (screen === 'dev' && a === 'canvas') return { screen: 'canvas-dev', ...(b ? { room: decodeURIComponent(b) } : {}) };
  return { screen: 'login' };
}

function routeHash(r: Route) {
  const d = (r.screen === 'home' || r.screen === 'room') && r.demo && !PREVIEW ? '#/demo' : '#';
  if (r.screen === 'home') return r.item && !r.page ? `${d}/home/i/${encodeURIComponent(r.item)}` : `${d}/${r.page ?? 'home'}`;
  if (r.screen === 'room') return `${d}/room/${encodeURIComponent(r.id)}` + (r.call ? '/call' : '');
  if (r.screen === 'reference') return `#/reference/${r.sheet}`;
  if (r.screen === 'room-panel') return '#/dev/room-panel';
  if (r.screen === 'canvas-dev') return '#/dev/canvas' + (r.room ? `/${encodeURIComponent(r.room)}` : '');
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

/**
 * An invite, opened from the Inbox: checked against the account you're signed in with, then
 * previewed, then joined, in place of the page inside the shell. The key (a link's token, or your email
 * invitation's id) lives only in this screen's memory.
 */
function InviteScreen({ inviteKey, onDone, onOpenRoom }: { inviteKey: InviteKey; onDone(): void; onOpenRoom(id: string): void }) {
  const [state, setState] = useState<LandingState>({ kind: 'checking' });
  const [attempt, setAttempt] = useState(0);
  const errorOf = (err: unknown): MembershipError => (err as { reason?: MembershipError }).reason
    ?? ((err as RoomUnavailable).code === 'network' ? 'network' : (err as RoomUnavailable).code === 'not-found' ? 'invite_not_found' : 'network');
  useEffect(() => {
    setState({ kind: 'checking' });
    realWorkspace.invites.resolve(inviteKey).then(
      (r) => setState(r.kind === 'already-member' ? { kind: 'already-member', roomId: r.roomId, roomName: r.roomName } : r),
      (err) => setState({ kind: 'error', error: errorOf(err) }),
    );
  }, [inviteKey, attempt]);
  const join = async () => {
    if (state.kind !== 'preview') return;
    setState({ ...state, joining: true });
    try { onOpenRoom(await realWorkspace.invites.accept(inviteKey)); }
    catch (err) { setState({ kind: 'error', error: errorOf(err), invite: state.invite }); }
  };
  return (
    <InviteGate state={state} onJoinRoom={() => void join()} onNotNow={onDone} onHome={onDone} onOpenRoom={onOpenRoom}
      onRetry={() => setAttempt((n) => n + 1)} onSwitchAccount={() => { void window.journey.auth.signOut(); }} />
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
  const loaded = demoLoaded();
  const demo = () => { void demoSession.leave(); void loadDemo().then(() => go({ screen: 'home', demo: true })); };
  return (
    <div class="devmenu" role="dialog" aria-label="Developer menu">
      <h2>Developer<button type="button" onClick={onClose} aria-label="Close developer menu">Ctrl ⇧ D</button></h2>
      <div class="grp">
        <b>Demo</b>
        <button type="button" onClick={demo}>{loaded ? 'Reload Payment Reliability' : 'Load Payment Reliability'}</button>
        <button type="button" class={on(route.screen === 'home' && route.demo)} onClick={() => go({ screen: 'home', demo: true })}>Demo home</button>
        {loaded && <button type="button" onClick={() => { void demoSession.leave(); clearDemo(); go({ screen: 'home', demo: true }); }}>Remove example rooms</button>}
      </div>
      <div class="grp">
        <b>Screens</b>
        <button type="button" class={on(route.screen === 'login')} onClick={() => go({ screen: 'login' })}>Sign in</button>
        <button type="button" class={on(route.screen === 'home' && !route.demo)} onClick={() => go({ screen: 'home', demo: false })}>{PREVIEW ? 'Home' : 'Your rooms'}</button>
        <button type="button" class={on(route.screen === 'reference')} onClick={() => go({ screen: 'reference', sheet: 'Components' })}>Reference sheets</button>
        <button type="button" class={on(route.screen === 'room-panel')} onClick={() => go({ screen: 'room-panel' })}>Room panel, on fixtures</button>
        <button type="button" class={on(route.screen === 'canvas-dev')} onClick={() => go({ screen: 'canvas-dev' })}>Canvas engine harness</button>
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
        <button type="button" onClick={() => { void demoSession.leave(); resetWorkspace(); go({ screen: 'home', demo: true }); }}>Reset the demo, with rooms you made in it</button>
        {!PREVIEW && <button type="button" onClick={() => { location.href = 'index.html'; }}>Earlier setup screen</button>}
      </div>
      <p class="note">{PREVIEW ? '' : 'Your rooms are real: Supabase rooms and their record, and Claude Code work on this machine. '}The demo’s rooms, calls, decisions and coding agents are mock data, kept in this window’s local storage, and never mix with real rooms. Mocks log what they pretend to do: filter the console by <code>[vowe mock]</code>.</p>
    </div>
  );
}

function App() {
  const [route, go] = useRoute();
  const [dev, setDev] = useState(false);
  /** The New room sheet, open with the repository it starts on (null: none). */
  const [newRoom, setNewRoom] = useState<{ repo: string | null } | null>(null);
  /** Joining another room's call while you're in one asks first. */
  const [switching, setSwitching] = useState<{ id: string; talk: boolean } | null>(null);
  const [repos, setRepos] = useState<RepoChoice[]>([]);
  /** An invite being opened; kept in memory only, never in the route or storage. */
  const [invite, setInvite] = useState<InviteKey | null>(null);
  const light = useAppearance() === 'light';
  // Pass 1's tokens pick light or dark from <html data-theme>; keep it on the Theme setting.
  useLayoutEffect(() => { document.documentElement.dataset.theme = light ? 'light' : 'dark'; }, [light]);
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
  useEffect(() => { if (route.screen === 'login') { void demoSession.leave(); void realSession.leave(); setInvite(null); } }, [route.screen]);
  useEffect(() => { void (demo ? realSession : demoSession).leave(); }, [demo]);
  // The Inbox follows the workspace on screen: the example rooms, your rooms, or none when signed out.
  const inboxOf = signedOut || route.screen === 'login' ? null : demo ? 'demo' : 'real';
  useEffect(() => { bindInbox(inboxOf); }, [inboxOf]);
  // Repositories added on this machine, for the room pickers.
  const loadRepos = () => { if (!PREVIEW && user) localRepos().then(setRepos, () => setRepos([])); };
  useEffect(loadRepos, [user, !!newRoom]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd') { e.preventDefault(); setDev((d) => !d); }
      // ⌘[ and ⌘]: back and forward through the app's screens, unless something on screen used the key
      // (the Desk's own history goes first while it has somewhere to go).
      else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
        const back = e.code === 'BracketLeft';
        setTimeout(() => { if (!e.defaultPrevented) { if (back) history.back(); else history.forward(); } }, 0);
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  // A call route with no call behind it (a reload, a failed join, hanging up) shows the room from outside.
  const inCall = route.screen === 'room' && route.call && session.inRoom(route.id);
  useEffect(() => {
    if (!signedOut && route.screen === 'room' && route.call && !inCall) go({ ...route, call: false });
  }, [route, inCall, cs.status]);
  // The call outlives the screen: its room stays mounted (hidden) while you're Home or in another room.
  const layout = callLayout(cs, signedOut || route.screen !== 'room' ? null : route.id);

  // Going Home or to another room is navigation, never leaving the call.
  const home = () => go({ screen: 'home', demo });
  const openRoom = (id: string) => go({ screen: 'room', id, call: layout.keep === id, demo });
  const create = async (r: NewRoom) => {
    const made = await ws.room.create(r);
    setNewRoom(null);
    openRoom(made.id);
  };
  const join = async (id: string, talk: boolean) => {
    // Out of a dropped call in another room first; a connected one is left by session.join.
    if (session.state.roomId && session.state.roomId !== id) await session.leave();
    if (!(await session.join(id))) return;
    go({ screen: 'room', id, call: true, demo });
    // Chose "Join and talk": that choice, not the join, opens the mic (and asks the OS the first time).
    if (talk && !demo) void voice()?.setMicrophoneEnabled(true).catch(() => { /* the call bar says why */ });
  };
  const askJoin = (id: string, talk: boolean) => {
    const plan = joinPlan(session.state, id);
    if (plan === 'switch') setSwitching({ id, talk });
    else if (plan === 'join') void join(id, talk);
  };
  const leave = async () => { await session.leave(); };
  // The Inbox item the route selects; opening one marks it seen.
  const inbox = useStore(activeInbox).source;
  const selected = route.screen === 'home' ? route.item ?? null : null;
  useEffect(() => {
    if (!inbox || !selected) return;
    // Waits for the item to load (a relaunch on #/home/i/…), then marks it seen once.
    const mark = () => {
      const v = inbox.store.state.view;
      const item = [...v.needs, ...v.following, ...v.activity].find((i) => i.id === selected);
      if (item) inbox.seen(item);
      return !!item;
    };
    if (mark()) return;
    const off = inbox.store.subscribe(() => { if (mark()) off(); });
    return off;
  }, [inbox, selected]);
  const choices = demo ? EXAMPLE_REPOS : repos;
  const repoNote = demo ? 'examples · this is the demo' : repos.length ? 'added on this machine · only its remote is shared' : 'none added on this machine yet';
  const addRepo = demo ? undefined : () => addLocalRepo().then((r) => { loadRepos(); return r; });
  const overlay = newRoom ? <CreateRoomSheet repos={choices} repoNote={repoNote} onAddRepo={addRepo} onCreate={create} onClose={() => setNewRoom(null)} initialRepo={newRoom.repo} /> : null;
  const onNewRoom = (repo?: string | null) => setNewRoom({ repo: repo ?? null });
  const roomProps = (id: string) => ({
    sources: ws, roomId: id, session, light,
    ...(demo || !realCanvas ? demoRoom : {
      canvas: realCanvas, vowe: realWorkspace.vowe, self: () => selfCloudId() ?? '',
      agentReply: (roomId: string, threadId: string, body: string) => realWorkspace.record.reply(roomId, threadId, body, 'vowe'),
      attachError: attachErrors.get(id), membership: realWorkspace.membership, voice: voice(),
    }),
    onOpenRoom: openRoom, onNewRoom, onHome: home,
    onJoin: (o?: { talk: boolean }) => askJoin(id, !!o?.talk), onLeave: leave,
  });
  // The room whose call you're in, mounted wherever you are; on screen only when the route shows it.
  // Same key as the room's own screen, so joining or coming back moves it rather than remounting it.
  const kept = layout.keep && !signedOut
    ? <RoomScreen key={`${demo}:${layout.keep}`} {...roomProps(layout.keep)} inCall hidden={!layout.visible} overlay={layout.visible ? overlay : undefined} />
    : null;
  const notice = !demo && real.state === 'failed' ? `Couldn’t read your rooms: ${real.error}` : null;

  let screen;
  if (signedOut && user === undefined) screen = <><div class="drag-strip"></div><OpeningVowe /></>;
  else if (signedOut || route.screen === 'login') screen = <><div class="drag-strip"></div><LoginScreen signIn={PREVIEW ? undefined : signIn} onSignedIn={home} /></>;
  else if (route.screen === 'home') {
    const page = route.page ?? 'home';
    // Keyed by workspace: nothing Home read for your rooms carries over into the demo, or back.
    screen = <Home key={demo ? 'demo' : 'real'} page={page} demo={demo} rooms={rooms} repos={choices} repoNote={repoNote} onAddRepo={addRepo} notice={notice}
      onNavigate={(to) => { setInvite(null); go({ screen: 'home', demo, ...(to === 'home' ? {} : { page: to }) }); }}
      onOpenRoom={(id) => { setInvite(null); openRoom(id); }} onCreate={create} onNewRoom={onNewRoom}
      inbox={inbox} selected={selected} onSelect={(item) => go({ screen: 'home', demo, ...(item ? { item } : {}) })}
      onJoinCall={(id) => { openRoom(id); askJoin(id, false); }}
      onOpenInvite={demo ? undefined : setInvite} overlay={overlay}
      invite={invite && !demo ? <InviteScreen inviteKey={invite} onDone={() => setInvite(null)} onOpenRoom={(id) => { setInvite(null); openRoom(id); }} /> : undefined} />;
  } else if (route.screen === 'room') {
    // The call's own room is the kept one, shown in place.
    screen = layout.visible ? null : <RoomScreen key={`${demo}:${route.id}`} {...roomProps(route.id)} inCall={inCall} overlay={overlay} />;
  }
  else if (route.screen === 'room-panel') screen = <div class={'win panel-dev' + (light ? ' light' : '')}><RoomPanelPreview /></div>;
  else if (route.screen === 'canvas-dev') screen = <CanvasHarness key={route.room ?? ''} roomId={route.room} light={light} />;
  else screen = <ReferenceScreen sheet={route.sheet} go={(sheet) => go({ screen: 'reference', sheet })} onClose={home} />;

  const callName = (id: string | null) => (id ? rooms.find((r) => r.id === id)?.name : null) ?? 'this room';
  return (
    <>
      {kept}
      {screen}
      {switching && (
        <ConfirmDialog title={`Leave the call in ${callName(session.state.roomId)}?`} destructive={false} confirmLabel="Leave and join"
          body={<>You can be in one call at a time. Joining {callName(switching.id)} ends your part in the call in {callName(session.state.roomId)}.</>}
          onCancel={() => setSwitching(null)}
          onConfirm={() => { const s = switching; setSwitching(null); void join(s.id, s.talk); }} />
      )}
      {PREVIEW && !dev && <button class="devpill" type="button" title="Developer menu · Ctrl ⇧ D" onClick={() => setDev(true)}>Preview · mock data</button>}
      {!PREVIEW && demo && !signedOut && (
        <button class="devpill" type="button" title="Leave the demo for your own rooms" onClick={() => { void demoSession.leave(); go({ screen: 'home', demo: false }); }}>Demo · example data · Exit</button>
      )}
      {dev && <DevMenu route={route} go={go} onClose={() => setDev(false)} />}
    </>
  );
}

if (navigator.userAgent.includes('Electron')) document.documentElement.classList.add('in-electron');
// In full screen there are no traffic lights, so the top-left controls move into their corner.
window.journey?.window.onFullScreen((on) => document.documentElement.classList.toggle('full-screen', on));
// The first paint already wears the right theme; App takes over once the setting has loaded.
document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
render(<App />, document.getElementById('app')!);
