import { Fragment, h, type ComponentChildren } from '../../vendor/preact.js';
import { useEffect, useRef, useState } from '../../vendor/preact-hooks.js';
import { account, firstName } from '../../shared/account.js';
import { AccountFoot } from '../../shared/components/Account.js';
import { Compose, HomeMic, PanelLeft, Repo } from '../../shared/components/icons.js';
import { mockLog } from '../../shared/mock.js';
import { useStore } from '../../shared/store.js';
import { ago } from '../../shared/time.js';
import { roomLine, Who } from '../room/shell.js';
import type { RepoChoice } from '../room/data/sources.js';
import type { RoomSummary } from '../room/types.js';

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
  light: boolean;
  /** The app's Google sign-in; absent in the preview, which simulates it. The app leaves this screen once a user is signed in. */
  signIn?: () => Promise<unknown>;
  /** Preview only: what "Continue as" does. */
  onSignedIn(): void;
}

export function LoginScreen({ light, signIn: realSignIn, onSignedIn }: LoginProps) {
  const [login, setLogin] = useState<'idle' | 'waiting'>('idle');
  const [failed, setFailed] = useState<string | null>(null);
  const signIn = () => {
    setFailed(null);
    setLogin('waiting');
    if (!realSignIn) { mockLog('auth', 'Continue with Google: preview sign-in; no browser opens and no account is touched'); return; }
    realSignIn().catch((err: Error) => { setLogin('idle'); setFailed(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') || 'Sign-in did not complete.'); });
  };
  // Cancel only stops waiting here; the browser's sign-in times out on its own, and pressing again reuses it.
  const cancel = () => setLogin('idle');
  return (
    <div class="welcome-screen">
      <div class={`win ${light ? 'light ' : ''}login-mode`}>
        <Lights />
        <main class="login">
          <div class="ghost" aria-hidden="true">
            <svg viewBox="0 0 1440 900" preserveAspectRatio="none">
              <path pathLength="1" d="M234 258 C234 330 274 350 274 420"></path>
              <path pathLength="1" d="M274 488 C274 560 234 580 234 650" style="animation-delay:.6s"></path>
              <path pathLength="1" d="M358 446 C620 300 860 250 1110 232" style="animation-delay:1.2s"></path>
              <path pathLength="1" d="M1194 270 C1194 360 1214 380 1214 460" style="animation-delay:1.8s"></path>
              <path class="prop" d="M1214 530 C1214 600 1164 610 1164 670"></path>
            </svg>
            <div class="gp" style="left:150px;top:190px;animation-delay:.2s"><div class="k">Client</div><div class="n">Checkout</div></div>
            <div class="gp" style="left:190px;top:420px;animation-delay:.5s"><div class="k">Service</div><div class="n">Webhook API</div><div class="bars"><i class="on"></i><i class="on"></i><i class="on"></i><i></i></div></div>
            <div class="gp queue" style="left:150px;top:650px;animation-delay:.8s"><div class="k">Queue</div><div class="n">jobs</div><div class="bars"><i class="on"></i><i class="on"></i><i></i><i></i><i></i><i></i></div></div>
            <div class="gp" style="left:1110px;top:200px;animation-delay:1.1s"><div class="k">Store</div><div class="n">Payments DB</div></div>
            <div class="gp" style="left:1130px;top:460px;animation-delay:1.4s"><div class="k">External</div><div class="n">Stripe</div><div class="bars"><i class="on"></i><i class="on"></i><i class="on"></i><i class="on"></i></div></div>
            <div class="gp prop" style="left:1080px;top:670px;animation-delay:2s"><div class="k">Proposed</div><div class="n">Idempotency key</div></div>
            <div class="cur a" style="left:330px;top:250px"><svg viewBox="0 0 14 14"><path d="M1 1l11 5-5 1.6L5 13z" style="fill:var(--peer);stroke:var(--pane);stroke-width:1;animation:none;stroke-dasharray:none"></path></svg><span style="background:var(--peer)">John</span></div>
            <div class="cur b" style="left:1260px;top:600px"><svg viewBox="0 0 14 14"><path d="M1 1l11 5-5 1.6L5 13z" style="fill:var(--peer2);stroke:var(--pane);stroke-width:1;animation:none;stroke-dasharray:none"></path></svg><span style="background:var(--peer2)">Srikar</span></div>
          </div>
          <div class="veil"></div>

          <section class="gate">
            <div class="mark" aria-hidden="true"><span class="ring"></span><span class="ring r2"></span><span class="core"></span></div>
            <div class="word"><b>Vowe</b><span class="sep"></span>Engineering rooms</div>
            <h1 class="hero-h">Talk through the system.<span>Watch it take shape.</span></h1>
            <p class="hero-p">Say what you’re building. Vowe draws it live for the whole room, and coding agents build what you agree on.</p>
            <div>
              {login === 'idle' ? (
                <>
                  <button class="gbtn" type="button" onClick={signIn}><span class="gslot" title="Official Google “G” mark goes here">G</span>Continue with Google</button>
                  <div class="fine">{failed ? `Sign-in didn’t finish: ${failed} · ` : 'Opens your browser to sign in · '}<NotYet link label="Terms" note="Not written yet." /> · <NotYet link label="Privacy" note="Not written yet." /></div>
                </>
              ) : (
                <div class="wait">
                  <div class="wait-row"><span class="spin"></span><span>Finish signing in in your browser</span><button class="x" type="button" onClick={cancel}>Cancel</button></div>
                  {realSignIn
                    ? <div class="fine">Waiting for Google in your browser.</div>
                    : <div class="fine">Preview build: no browser opens. <a href="#" onClick={(e) => { e.preventDefault(); onSignedIn(); }}>Continue as Daniel</a></div>}
                </div>
              )}
            </div>
          </section>
          <div class="login-foot"><span>VOWE 0.1 · MACOS</span><span>BUILT FOR TEAMS WHO THINK OUT LOUD</span></div>
        </main>
      </div>
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
  const me = firstName(useStore(account).user);
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
          <AccountFoot sub="Signed in with Google" />
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
