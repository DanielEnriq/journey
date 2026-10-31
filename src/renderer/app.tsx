import { Fragment, h, render } from './vendor/preact.js';
import { useEffect, useLayoutEffect, useState } from './vendor/preact-hooks.js';
import { callLayout, joinPlan } from './features/call/continuity.js';
import { CallSession } from './features/call/session.js';
import { ConfirmDialog } from './features/membership/primitives.js';
import { RoomScreen } from './features/room/RoomScreen.js';
import { useRooms } from './features/workspace/hooks.js';
import { ipcTransport } from './features/canvas/client.js';
import {
  addLocalRepo, attachErrors, callEnded, localRepos, realStatus, realWorkspace, RoomUnavailable, selfCloudId, startRealWorkspace, voice,
} from './features/workspace/real/workspace.js';
import type { LandingState, MembershipError } from './features/membership/model.js';
import { Home, type HomePage } from './features/home/Home.js';
import { bindInbox } from './features/inbox/real.js';
import { activeInbox } from './features/inbox/source.js';
import { LoginScreen, OpeningVowe } from './features/welcome/LoginScreen.js';
import { spaceSource } from './ui/pass2/shell/spaces.js';
import { InviteGate } from './ui/pass2/invites/InviteGate.js';
import { useStore } from './shared/store.js';
import { useAppearance } from './shared/theme/theme.js';
import { account, signIn } from './shared/account.js';
import { UNTITLED, type NewRoom, type RepoChoice } from './features/room/data/sources.js';
import { freshRoom } from './features/room/fresh.js';
import type { InviteKey } from '../shared/api.js';

// Vowe's renderer: sign-in → Home, your Inbox (invitations arrive there) → a room's preview → its call.
// Screens are hash routes kept in localStorage, so a relaunch lands back on the same one; a call is the
// exception, since it is never rejoined without you asking.

type Route =
  | { screen: 'login' }
  | { screen: 'home'; page?: HomePage; item?: string }
  | { screen: 'room'; id: string; call: boolean };

const ROUTE_KEY = 'vowe.route';
/** Home's pages, each its own route under the same shell. */
const PAGES: HomePage[] = ['home'];

/** Your rooms' canvases: main's hub over IPC, acting as the signed-in person. */
const canvas = ipcTransport(() => ({ kind: 'human', id: selfCloudId() ?? 'me', name: account.state.user?.name ?? 'You' }));
const session = new CallSession(realWorkspace.call);
startRealWorkspace();
// The call ending without you asking: a lost connection offers a rejoin; being taken off it leaves.
callEnded.dropped = (roomId) => { if (session.state.roomId === roomId) session.lost(); };
callEnded.ended = (roomId) => { if (session.state.roomId === roomId) void session.leave(); };

function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/');
  // The demo's routes (#/demo/…) are gone: an old one lands on the same screen of your rooms.
  if (parts[0] === 'demo') parts.shift();
  const [screen, a, b] = parts;
  if (screen === 'home' && a === 'i' && b) return { screen: 'home', item: decodeURIComponent(b) };
  // Invitations now arrive in the Inbox: an old #/invitations link lands there.
  if (screen === 'invitations') return { screen: 'home' };
  if (PAGES.includes(screen as HomePage)) return { screen: 'home', ...(screen === 'home' ? {} : { page: screen as HomePage }) };
  if (screen === 'room' && a) return { screen: 'room', id: decodeURIComponent(a), call: b === 'call' };
  return { screen: 'login' };
}

function routeHash(r: Route) {
  if (r.screen === 'home') return r.item && !r.page ? `#/home/i/${encodeURIComponent(r.item)}` : `#/${r.page ?? 'home'}`;
  if (r.screen === 'room') return `#/room/${encodeURIComponent(r.id)}` + (r.call ? '/call' : '');
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

function App() {
  const [route, go] = useRoute();
  /** Making a room didn't work: says why, and offers to try again. */
  const [newFailed, setNewFailed] = useState<{ space: string | null; message: string } | null>(null);
  /** Joining another room's call while you're in one asks first. */
  const [switching, setSwitching] = useState<{ id: string; talk: boolean } | null>(null);
  const [repos, setRepos] = useState<RepoChoice[]>([]);
  /** An invite being opened; kept in memory only, never in the route or storage. */
  const [invite, setInvite] = useState<InviteKey | null>(null);
  const light = useAppearance() === 'light';
  // Pass 1's tokens pick light or dark from <html data-theme>; keep it on the Theme setting.
  useLayoutEffect(() => { document.documentElement.dataset.theme = light ? 'light' : 'dark'; }, [light]);
  const ws = realWorkspace;
  const rooms = useRooms(ws.room);
  // Every screen's sidebar reads Spaces from the workspace.
  useLayoutEffect(() => { spaceSource.setState({ source: ws.room }); }, []);
  const cs = useStore(session.store);
  const real = useStore(realStatus);
  const { user } = useStore(account);
  // The main process's sign-in decides: signed out shows only sign-in, and signing in leaves it.
  const signedOut = !user;
  useEffect(() => {
    if (user === undefined) return;
    if (!user && route.screen !== 'login') go({ screen: 'login' });
    if (user && route.screen === 'login') go({ screen: 'home' });
  }, [user, route.screen]);
  // Signing out ends any call.
  useEffect(() => { if (route.screen === 'login') { void session.leave(); setInvite(null); } }, [route.screen]);
  // The Inbox follows your rooms, or none when signed out.
  const inboxOn = !signedOut && route.screen !== 'login';
  useEffect(() => { bindInbox(inboxOn); }, [inboxOn]);
  // Repositories added on this machine, for the room pickers.
  const loadRepos = () => { if (user) localRepos().then(setRepos, () => setRepos([])); };
  useEffect(loadRepos, [user]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ⌘[ and ⌘]: back and forward through the app's screens, unless something on screen used the key
      // (the Desk's own history goes first while it has somewhere to go).
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
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
  const home = () => go({ screen: 'home' });
  const openRoom = (id: string) => go({ screen: 'room', id, call: layout.keep === id });
  const create = async (r: NewRoom) => {
    const made = await ws.room.create(r);
    openRoom(made.id);
    return made.id;
  };
  const join = async (id: string, talk: boolean) => {
    // Out of a dropped call in another room first; a connected one is left by session.join.
    if (session.state.roomId && session.state.roomId !== id) await session.leave();
    if (!(await session.join(id))) return;
    go({ screen: 'room', id, call: true });
    // Chose "Join and talk": that choice, not the join, opens the mic (and asks the OS the first time).
    if (talk) void voice()?.setMicrophoneEnabled(true).catch(() => { /* the call bar says why */ });
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
  const repoNote = repos.length ? 'added on this machine · only its remote is shared' : 'none added on this machine yet';
  const addRepo = () => addLocalRepo().then((r) => { loadRepos(); return r; });
  // New Room is FaceTime's Create Link: no form. It makes an untitled room at once, in the Space asked for (else
  // the room on screen's Space, else the first), and opens it with Share showing, so the next step is asking
  // someone in. Where there are no Spaces, what's passed is a repository, and the room uses it.
  const onNewRoom = (space?: string | null) => {
    const spaces = ws.room.spaces?.() ?? null;
    const here = route.screen === 'room' ? rooms.find((r) => r.id === route.id)?.spaceId : undefined;
    const spaceId = spaces ? (spaces.find((s) => s.id === space) ?? spaces.find((s) => s.id === here) ?? spaces[0])?.id : undefined;
    setNewFailed(null);
    create({ name: UNTITLED, goal: '', repo: spaces ? null : space ?? null, ...(spaceId ? { spaceId } : {}) })
      .then((id) => freshRoom.setState({ id }), (err: Error) => setNewFailed({ space: space ?? null, message: err.message }));
  };
  const roomProps = (id: string) => ({
    sources: ws, roomId: id, session, light,
    canvas, vowe: realWorkspace.vowe, self: () => selfCloudId() ?? '',
    agentReply: (roomId: string, threadId: string, body: string, parentId?: string | null) => realWorkspace.record.reply(roomId, threadId, body, 'vowe', parentId),
    attachError: attachErrors.get(id), membership: realWorkspace.membership, voice: voice(),
    onOpenRoom: openRoom, onNewRoom, onHome: home,
    onJoin: (o?: { talk: boolean }) => askJoin(id, !!o?.talk), onLeave: leave,
  });
  // The room whose call you're in, mounted wherever you are; on screen only when the route shows it.
  // Same key as the room's own screen, so joining or coming back moves it rather than remounting it.
  const kept = layout.keep && !signedOut
    ? <RoomScreen key={layout.keep} {...roomProps(layout.keep)} inCall hidden={!layout.visible} />
    : null;
  const notice = real.state === 'failed' ? `Couldn’t read your rooms: ${real.error}` : null;

  let screen;
  if (signedOut && user === undefined) screen = <><div class="drag-strip"></div><OpeningVowe /></>;
  else if (signedOut || route.screen === 'login') screen = <><div class="drag-strip"></div><LoginScreen signIn={signIn} /></>;
  else if (route.screen === 'home') {
    const page = route.page ?? 'home';
    screen = <Home page={page} rooms={rooms} repos={repos} repoNote={repoNote} onAddRepo={addRepo} notice={notice}
      onNavigate={(to) => { setInvite(null); go({ screen: 'home', ...(to === 'home' ? {} : { page: to }) }); }}
      onOpenRoom={(id) => { setInvite(null); openRoom(id); }} onCreate={async (r) => { await create(r); }} onNewRoom={onNewRoom}
      inbox={inbox} selected={selected} onSelect={(item) => go({ screen: 'home', ...(item ? { item } : {}) })}
      onJoinCall={(id) => { openRoom(id); askJoin(id, false); }}
      onOpenInvite={setInvite}
      invite={invite ? <InviteScreen inviteKey={invite} onDone={() => setInvite(null)} onOpenRoom={(id) => { setInvite(null); openRoom(id); }} /> : undefined} />;
  } else {
    // The call's own room is the kept one, shown in place.
    screen = layout.visible ? null : <RoomScreen key={route.id} {...roomProps(route.id)} inCall={inCall} />;
  }

  const callName = (id: string | null) => (id ? rooms.find((r) => r.id === id)?.name : null) ?? 'this room';
  return (
    <>
      {kept}
      {screen}
      {newFailed && (
        <ConfirmDialog title="Couldn’t make a room" destructive={false} confirmLabel="Try Again" body={newFailed.message}
          onCancel={() => setNewFailed(null)} onConfirm={() => onNewRoom(newFailed.space)} />
      )}
      {switching && (
        <ConfirmDialog title={`Leave the call in ${callName(session.state.roomId)}?`} destructive={false} confirmLabel="Leave and join"
          body={<>You can be in one call at a time. Joining {callName(switching.id)} ends your part in the call in {callName(session.state.roomId)}.</>}
          onCancel={() => setSwitching(null)}
          onConfirm={() => { const s = switching; setSwitching(null); void join(s.id, s.talk); }} />
      )}
    </>
  );
}

if (navigator.userAgent.includes('Electron')) document.documentElement.classList.add('in-electron');
// In full screen there are no traffic lights, so the top-left controls move into their corner.
window.journey.window.onFullScreen((on) => document.documentElement.classList.toggle('full-screen', on));
// The first paint already wears the right theme; App takes over once the setting has loaded.
document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
render(<App />, document.getElementById('app')!);
