import { Fragment, h, type ComponentChildren } from '../../vendor/preact.js';
import { useEffect, useRef, useState } from '../../vendor/preact-hooks.js';
import { account, cancelSignIn, firstName, initials } from '../../shared/account.js';
import { AccountFoot } from '../../shared/components/Account.js';
import { Compose, HomeMic, PanelLeft, Repo } from '../../shared/components/icons.js';
import { mockLog } from '../../shared/mock.js';
import { useStore } from '../../shared/store.js';
import { ago } from '../../shared/time.js';
import { roomLine, Who } from '../room/shell.js';
import type { RepoChoice } from '../room/data/sources.js';
import type { RoomSummary } from '../room/types.js';
import { SignIn, type SignInState } from '../../ui/SignIn.js';
import type { SignInProvider } from '../../../shared/api.js';

// Sign-in and the workspace home, from the design prototype (Welcome.dc.html). With no rooms, home is
// the design's first-run composer; with rooms, the same page leads with what needs you and which calls
// are on. The microphone is simulated, and so is sign-in in the preview; in the app, sign-in is the main
// process's Google sign-in. Anything this build can't do says so where it is pressed instead of pretending.

const TRIES = ['Retries are double-charging customers', 'Redesign the checkout states', 'Walk me through this repo'];

interface Part { k: string; n: string; cls: string; style: string }
const P = (x: number, y: number, k: string, n: string, cls: string, d: number): Part => ({ k, n, cls, style: `left:${x}px;top:${y}px;animation-delay:${d}s` });
const C = (x1: number, y1: number, x2: number, y2: number) => { const m = (x1 + x2) / 2; return `M${x1} ${y1} C${m} ${y1} ${m} ${y2} ${x2} ${y2}`; };
const SCENES = [
  {
    cap: 'Vowe drafts as you talk. Dashed stays a proposal until the room agrees.',
    parts: [P(40, 36, 'Service', 'Webhook API', '', .1), P(265, 36, 'Queue', 'jobs', 'queue', .4), P(490, 36, 'External', 'Stripe', '', .7), P(265, 140, 'Proposed', 'Idempotency key', 'prop', 1.2)],
    wires: [C(190, 62, 265, 62), C(415, 62, 490, 62)], prop: ['M340 88 L340 140'],
  },
  {
    cap: 'Not just services: screens, states and diffs are drawn the same way.',
    parts: [P(40, 88, 'Screen', 'Pay', '', .1), P(265, 88, 'Proposed', 'Confirming', 'prop', .4), P(490, 30, 'Screen', 'Paid', '', .7), P(490, 146, 'Screen', 'Failed', '', .9)],
    wires: [], prop: [C(190, 114, 265, 114), C(415, 114, 490, 56), C(415, 114, 490, 172)],
  },
  {
    cap: 'Point Vowe at a repo and it maps what’s there before you change it.',
    parts: [P(40, 88, 'App', 'apps/desktop', '', .1), P(265, 30, 'Process', 'main', '', .4), P(265, 146, 'Process', 'renderer', '', .6), P(490, 88, 'Package', 'packages/shared', '', .9)],
    wires: [C(190, 114, 265, 56), C(190, 114, 265, 172), C(415, 56, 490, 114), C(415, 172, 490, 114)], prop: [],
  },
];

const srOnly = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)';
/** An entry point this build can't do yet: pressing it says so in place, rather than seeming to work. */
function NotYet({ label, note, link }: { label: string; note: string; link?: boolean }) {
  const [open, setOpen] = useState(false);
  const toggle = (e: Event) => { e.preventDefault(); if (!open) mockLog('welcome', `${label}: not in this build`); setOpen(!open); };
  return (
    <span class="notyet">
      {link ? <a href="#" aria-disabled="true" onClick={toggle}>{label}</a> : <button type="button" aria-disabled="true" aria-expanded={open} onClick={toggle}>{label}</button>}
      {open && <span class="notyet-note" role="status">{note}</span>}
    </span>
  );
}

function useTimers() {
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  return (fn: () => void, ms: number) => { timers.current.push(setTimeout(fn, ms)); };
}

function Lights() {
  return <div class="lights" aria-hidden="true"><span style="background:#ff5f57"></span><span style="background:#febc2e"></span><span style="background:#28c840"></span></div>;
}

export interface LoginProps {
  /** The app's sign-in; absent in the preview, which simulates it. The app leaves this screen once a user is signed in. */
  signIn?: (provider: SignInProvider) => Promise<unknown>;
  /** Preview only: where the simulated sign-in lands. */
  onSignedIn(): void;
}

const PROVIDER_NAMES: Record<SignInProvider, string> = { google: 'Google', github: 'GitHub' };
/** Where each provider's sign-in happens in the browser: Google's own page, or GitHub's by way of Supabase. */
const PROVIDER_HOSTS: Record<SignInProvider, string> = { google: 'accounts.google.com', github: 'github.com' };

/**
 * The approved Pass 1 sign-in (ui/SignIn.tsx), driven by the main process's real Google and GitHub sign-in.
 * Only the state mapping lives here. Both providers stay listed, as before: the renderer can't ask main
 * which are configured until someone is signed in, and an unconfigured one fails with its real reason.
 * No matching code (main issues none) and no "open again" (main can't reopen the URL).
 */
export function LoginScreen({ signIn: realSignIn, onSignedIn }: LoginProps) {
  const { user, ended } = useStore(account);
  const [login, setLogin] = useState<SignInProvider | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [previewDone, setPreviewDone] = useState(false);
  const later = useTimers();
  const signIn = (id: string) => {
    const provider = id as SignInProvider;
    setFailed(null);
    setLogin(provider);
    if (!realSignIn) {
      mockLog('auth', `Continue with ${PROVIDER_NAMES[provider]}: preview sign-in; no browser opens and no account is touched`);
      later(() => setPreviewDone(true), 1400);
      later(onSignedIn, 2200);
      return;
    }
    realSignIn(provider).catch((err: Error) => {
      setLogin((now) => (now === provider ? null : now)); // a newer sign-in replaced this one: leave it be
      if (!/was cancelled/.test(err.message)) setFailed(err.message || 'Sign-in did not complete.');
    });
  };
  // Stops the sign-in in main too, so the browser tab's answer no longer counts.
  const cancel = () => { setLogin(null); void cancelSignIn(); };
  const state: SignInState = previewDone
    ? { kind: 'signed-in', name: user?.name ?? firstName(user), email: 'Preview · mock data', initials: initials(user?.name ?? firstName(user)) }
    : login
      ? { kind: 'waiting', providerLabel: PROVIDER_NAMES[login], host: PROVIDER_HOSTS[login] }
      : failed
        ? { kind: 'error', message: failed }
        : ended
          ? { kind: 'error', title: 'You were signed out', message: ended.message }
          : { kind: 'idle' };
  return (
    <div class="welcome-screen">
      <SignIn
        providers={[
          { id: 'google', label: 'Google', available: true },
          { id: 'github', label: 'GitHub', available: true },
        ]}
        upcoming={[{ id: 'chatgpt', label: 'ChatGPT' }]}
        state={state}
        onSignIn={signIn}
        onCancel={cancel}
      />
    </div>
  );
}

export interface HomeProps {
  light: boolean;
  /** Your rooms; with none, home is the first-run composer from the design. */
  rooms: RoomSummary[];
  repos: RepoChoice[];
  /** What the repository list is: repositories on this machine, or the demo's examples. */
  repoNote: string;
  /** The demo only: the microphone types an example as if it were heard. */
  simulatedMic?: boolean;
  /** Why the rooms couldn't be read; shown instead of pretending there are none. */
  notice?: string | null;
  onOpenRoom(id: string): void;
  /** Start room: makes the room and opens its preview. */
  onCreate(room: { name: string; goal: string; repo: string | null }): void;
  onNewRoom(): void;
  overlay?: ComponentChildren;
  /** Invitations waiting for you, and joining with a link; your real rooms only. */
  invites?: ComponentChildren;
}

/** What the composer's text becomes: a short room name, and the whole sentence as its goal. */
function roomFrom(text: string) {
  const name = text.length > 40 ? text.slice(0, 38).replace(/\s+\S*$/, '') + '…' : text;
  return { name, goal: text };
}

function hour() {
  const h = new Date().getHours();
  return h < 12 ? 'Morning' : h < 18 ? 'Afternoon' : 'Evening';
}

/** Home once you have rooms: what needs you, which calls are on, and what happened lately. Calm on purpose. */
function Overview({ rooms, onOpenRoom }: { rooms: RoomSummary[]; onOpenRoom(id: string): void }) {
  const needs = rooms.filter((r) => r.needs);
  const live = rooms.filter((r) => r.inCall.some((p) => p.tone !== 'me'));
  const recent = rooms.filter((r) => !r.needs && r.activityAt).sort((a, b) => Date.parse(b.activityAt!) - Date.parse(a.activityAt!)).slice(0, 4);
  return (
    <div class="ws">
      {needs.length > 0 && (
        <div class="ws-sec">
          <span class="ws-k">Needs you</span>
          {needs.map((r) => (
            <button key={r.id} class="ws-row" type="button" onClick={() => onOpenRoom(r.id)}>
              <span class="dot needs"></span><span class="ws-n">{r.name}</span><span class="ws-a needs">{r.needs}</span>
            </button>
          ))}
        </div>
      )}
      {live.length > 0 && (
        <div class="ws-sec">
          <span class="ws-k">In a call now</span>
          {live.map((r) => (
            <button key={r.id} class="ws-row" type="button" onClick={() => onOpenRoom(r.id)}>
              <Who people={r.inCall.filter((p) => p.tone !== 'me')} vowe /><span class="ws-n">{r.name}</span><span class="ws-a">{roomLine(r).act}</span>
            </button>
          ))}
        </div>
      )}
      {recent.length > 0 && (
        <div class="ws-sec">
          <span class="ws-k">Lately</span>
          {recent.map((r) => (
            <button key={r.id} class="ws-row" type="button" onClick={() => onOpenRoom(r.id)}>
              <span class="dot"></span><span class="ws-n">{r.name}</span><span class="ws-a">{r.activity}</span><span class="ws-t">{ago(r.activityAt)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function HomeScreen({ light, rooms, repos, repoNote, simulatedMic, notice, onOpenRoom, onCreate, onNewRoom, overlay, invites }: HomeProps) {
  const { user } = useStore(account);
  const me = firstName(user);
  const [text, setText] = useState('');
  const [focus, setFocus] = useState(false);
  const [listening, setListening] = useState(false);
  const [heard, setHeard] = useState('');
  const [scen, setScen] = useState(-1);
  const [repo, setRepo] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [side, setSide] = useState(true);
  const listen = useRef(false);
  const later = useTimers();
  const firstRun = rooms.length === 0 && !notice;
  const repoLabel = repos.find((r) => r.id === repo)?.label ?? null;

  const mic = () => {
    if (listen.current) { listen.current = false; setListening(false); setText(heard); return; }
    mockLog('welcome', 'microphone simulated: types the first example as if spoken; nothing is recorded');
    const words = TRIES[0].split(' ');
    let i = 0;
    listen.current = true;
    setListening(true); setHeard(''); setScen(0);
    const tick = () => {
      if (!listen.current) return;
      i++;
      setHeard(words.slice(0, i).join(' '));
      if (i < words.length) later(tick, 230);
      else later(() => { if (listen.current) { listen.current = false; setListening(false); setText(TRIES[0]); } }, 700);
    };
    later(tick, 450);
  };
  const start = () => {
    const t = text.trim();
    if (!t) return;
    onCreate({ ...roomFrom(t), repo });
  };

  const scene = SCENES[scen < 0 ? 0 : scen];
  const needCount = rooms.filter((r) => r.needs).length;
  return (
    <div class="welcome-screen">
      <div class={`win ${light ? 'light ' : ''}home-mode${side ? ' side-open' : ''}`}>
        <Lights />
        {overlay}
        <header class="top-chrome">
          <div class="chrome-controls">
            <button class={'panel-toggle' + (side ? ' open' : '')} type="button" aria-label="Rooms" title="Rooms · [" aria-expanded={side} onClick={() => setSide(!side)}><PanelLeft /></button>
            <button class="panel-toggle" type="button" aria-label="New room" title="New room" onClick={onNewRoom}><Compose /></button>
          </div>
        </header>

        <aside class="sidebar" aria-hidden={!side}>
          <div class="sidebar-title"><span class="eyebrow">Rooms</span></div>
          {rooms.length ? (
            <nav class="sidebar-nav" aria-label="Rooms">
              {rooms.map((r) => {
                const l = roomLine(r);
                return (
                  <button key={r.id} class="row" type="button" onClick={() => onOpenRoom(r.id)}>
                    <span class={l.dot}></span>
                    <span class="txt"><span class="name">{r.name}</span><span class={l.actCls}>{l.act}</span></span>
                  </button>
                );
              })}
            </nav>
          ) : (
            <div class="side-empty"><b>No rooms yet</b>Rooms you start or get invited to will live here, with whatever needs you on top.</div>
          )}
          <AccountFoot sub={`Signed in with ${user?.provider === 'github' ? 'GitHub' : 'Google'}`} />
        </aside>

        <main class="home">
          <div class={'home-in' + (firstRun ? '' : ' has-rooms')}>
            <div class="hello"><span class="orb"></span>{firstRun ? 'Welcome to Vowe' : 'Your rooms'}</div>
            {notice && <p class="wnote" role="alert">{notice}</p>}
            {invites}
            {firstRun ? (
              <>
                <h1 class="home-h">What are we building<span>, {me}?</span></h1>
                <p class="home-p">Start a room and say it out loud. Vowe sketches the system as you talk, and you can bring your team in whenever you’re ready.</p>
              </>
            ) : (
              <h1 class="home-h">{hour()}, {me}.<span>{needCount ? ` ${needCount === 1 ? 'One room needs' : needCount + ' rooms need'} you.` : ' Nothing needs you.'}</span></h1>
            )}

            <div class="composer">
              <div class={'ask-box ' + (listening ? 'listening' : focus ? 'focus' : '')}>
                {listening ? (
                  <div class="heard">{heard}<i></i></div>
                ) : (
                  <label style="display:flex">
                    <span style={srOnly}>What are you building</span>
                    <input type="text" placeholder={firstRun ? 'Describe a change, a bug, or a system…' : 'Start another room: a change, a bug, a system…'} value={text}
                      onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)}
                      onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
                      onKeyDown={(e) => { if (e.key === 'Enter') start(); }} />
                  </label>
                )}
                <div class="ask-row">
                  <span class="repo-wrap">
                    <button class="repo" type="button" title="Pick a repository" aria-expanded={picking} onClick={() => setPicking(!picking)}>
                      <Repo />
                      {repoLabel ?? 'No repo yet'}
                    </button>
                    {picking && (
                      <span class="repo-pop" role="listbox" aria-label="Repository">
                        <span class="rp-note">{repoNote}</span>
                        {[null, ...repos].map((r) => (
                          <button key={r?.id ?? 'none'} type="button" role="option" aria-selected={repo === (r?.id ?? null)} class={repo === (r?.id ?? null) ? 'on' : ''} onClick={() => { setRepo(r?.id ?? null); setPicking(false); }}>{r?.label ?? 'No repository'}</button>
                        ))}
                      </span>
                    )}
                  </span>
                  {simulatedMic && <button class={'mic ' + (listening ? 'on' : '')} type="button" aria-label={listening ? 'Stop listening' : 'Say it instead'} title={listening ? 'Stop listening' : 'Say it instead (simulated)'} onClick={mic}><HomeMic /></button>}
                  <button class={'go ' + (text.trim() ? '' : 'dim')} type="button" onClick={start}>Start room <kbd>↵</kbd></button>
                </div>
              </div>
              {firstRun && (
                <div class="tries">
                  {TRIES.map((t, i) => (
                    <button key={t} class={'try ' + (scen === i ? 'sel' : '')} type="button" onClick={() => { listen.current = false; setText(t); setScen(i); setListening(false); }}>{t}</button>
                  ))}
                </div>
              )}
            </div>

            {firstRun ? (
              <>
                <div class="preview" aria-label="Example of what Vowe draws">
                  <svg key={scen} viewBox="0 0 680 232" preserveAspectRatio="none">
                    {scene.wires.map((d, i) => <path key={'w' + i} pathLength="1" d={d} style={`animation-delay:${0.3 + i * 0.35}s`}></path>)}
                    {scene.prop.map((d, i) => <path key={'p' + i} class="prop" d={d}></path>)}
                  </svg>
                  {scene.parts.map((p) => <div key={`${scen}-${p.n}`} class={'pp ' + p.cls} style={p.style}><div class="k">{p.k}</div><div class="n">{p.n}</div></div>)}
                  <div class="cap"><span class="orb"></span>{scene.cap}</div>
                  <div class="cap-r">{scen < 0 ? 'Example' : 'Preview'}</div>
                </div>

                <div class="setup">
                  {simulatedMic
                    ? <span class="s"><span class="todo"></span><NotYet label="Voice" note="Not in the demo. Its call is scripted." /></span>
                    : <span class="s"><span class="ok"></span>Voice calls, mic off until you talk</span>}
                  <span class="s"><span class="todo"></span><NotYet label="Connect GitHub" note={simulatedMic ? 'Not in this build. The demo uses example repositories.' : 'Not in this build. Rooms use repositories added on this machine; only their remote is shared.'} /></span>
                  {simulatedMic
                    ? <span class="s"><span class="todo"></span><NotYet label="Invite your team" note="Not in the demo. Demo rooms are only on this machine." /></span>
                    : <span class="s"><span class="ok"></span>Invite your team from a room’s Share</span>}
                </div>
              </>
            ) : (
              <Overview rooms={rooms} onOpenRoom={onOpenRoom} />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
