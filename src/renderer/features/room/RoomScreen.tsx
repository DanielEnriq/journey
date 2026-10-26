import { Fragment, h, type ComponentChildren } from '../../vendor/preact.js';
import { useEffect, useMemo, useRef, useState } from '../../vendor/preact-hooks.js';
import { ClearInk, ToolComment, ToolDraw, ToolSelect } from '../../shared/components/icons.js';
import { account } from '../../shared/account.js';
import { Store, useStore } from '../../shared/store.js';
import type { VoiceStatus } from '../../../shared/api.js';
import { snapshotOf } from '../../../shared/canvas/index.js';
import { MICROPHONE_DENIED, type CallService } from '../../calls/service.js';
import { CallVoice } from '../../voice/call-voice.js';
import { AskVowe, AskVowePanel } from '../canvas/AskVowe.js';
import { CanvasClient, ipcTransport } from '../canvas/client.js';
import { LiveSurface } from '../canvas/LiveSurface.js';
import type { CallSession } from '../call/session.js';
import { callLink } from '../call/continuity.js';
import type { CallPresence } from '../call/presence.js';
import { RoomShown, usePublishCall, useShownRef } from '../call/shown.js';
import { AccessLostScreen, AccessNotice } from '../membership/AccessNotice.js';
import { PeopleSection, ShareControl, useAccess, useNow, useVoice } from '../membership/hooks.js';
import { MembersPanel } from '../membership/MembersPanel.js';
import { can, type MembershipSource, type RoomAccess } from '../membership/model.js';
import { PreJoinSheet } from '../membership/PreJoinSheet.js';
import { Toasts, useToasts } from '../membership/primitives.js';
import { useLoaded, useRooms } from '../workspace/hooks.js';
import { selfCloudId, VOWE } from '../workspace/real/workspace.js';
import { agentNameOf } from '../workspace/real/vowe-services.js';
import type { CallControls } from './call/CallBar.js';
import { CallBar } from './call/CallBar.js';
import { Surface } from './canvas/Surface.js';
import { Captions, captionText, type CaptionLine } from './captions.js';
import type { RoomController } from './controller.js';
import type { CallDataSource, RoomDataSource, RoomRecordSource, WorkstreamDataSource } from './data/sources.js';
import { Desk } from './intent/Desk.js';
import { ProposeDecision, RoomPanel } from './panel/index.js';
import { deriveRoom } from './model.js';
import { RoomPreview } from './preview/RoomPreview.js';
import { Chrome, Lights, RoomsPanel, Who } from './shell.js';
import type { VoweServices } from '../vowe-room/contracts/services.js';
import { RealRoom } from '../vowe-room/host/RealRoom.js';
import { AccountFoot } from '../../shared/components/Account.js';
import { shellPrefs, toggleSidebar, useSidebarKey } from '../../ui/pass2/shell/prefs.js';
import { ShellSidebar } from '../../ui/pass2/shell/Sidebar.js';
import type { Chime, RoomSummary } from './types.js';

// A room, in one of two states. Outside the call it is a preview: what the room is for, who is in it and
// in its call, what changed, the work behind it. Joining the call opens the shared canvas in the same
// window, under the same band; leaving it comes back to the preview, still in the room. Only the demo's
// Payment Reliability has a scripted canvas; any other room's call opens on an empty one, with the room's
// record beside it. Real rooms also carry their membership (Share, People) and a LiveKit voice call.

export interface RoomScreenProps {
  /** The workspace: rooms, calls and work context. */
  sources: { room: RoomDataSource; call: CallDataSource; work: WorkstreamDataSource };
  /** The room's persisted record, for the call's right column; absent in the demo, whose call is scripted. */
  record?: RoomRecordSource;
  roomId: string;
  /** Show the call: the route asks for it and the session is in this room's call. */
  inCall: boolean;
  session: CallSession;
  /** The room's scripted canvas, if it has one. */
  canvas: RoomController | null;
  /** Why the room's repository couldn't be attached when it was made. */
  attachError?: string;
  light: boolean;
  onOpenRoom(id: string): void;
  onNewRoom(repo?: string | null): void;
  onHome(): void;
  /** Joins the call: muted, unless you chose to talk (which is what asks for the microphone). */
  onJoin(opts?: { talk: boolean }): void;
  /** Ends your part in the call; the app decides what's on screen after. */
  onLeave(): void | Promise<void>;
  /** Drawn inside the window, over everything: the New room sheet. */
  overlay?: ComponentChildren;
  /** Who's in the room and their invitations; absent in the demo. */
  membership?: MembershipSource;
  /** The room's voice call; absent in the demo, whose call is scripted. */
  voice?: CallService | null;
  /** The Pass 3 room's services (decisions, plans, work, attention); absent in the demo. With them, a real
   *  room's call opens the Vowe room: the semantic canvas and the Desk (Discuss, Decide, Work). */
  vowe?: VoweServices;
  /** Kept mounted for its call while you're elsewhere: drawn hidden and inert, deaf to the keyboard. */
  hidden?: boolean;
}

/** Membership, as each state of the room draws it. */
interface RoomUi {
  access: RoomAccess | null;
  note(text: string): void;
  toasts: ComponentChildren;
  /** The Share button and popover, for the band. */
  share: ComponentChildren;
  openShare(): void;
  /** The People drill-in is showing in the call's right column. */
  people: boolean;
  setPeople(open: boolean): void;
}
type InnerProps = RoomScreenProps & { ui: RoomUi };

/** The OS refused the microphone in this session: the join sheet says so before you choose to talk. */
let micRefused = false;
/** For rooms without a canvas: nobody is asking Vowe. */
const NOT_ASKING = new Store<{ reviewing: string | null }>({ reviewing: null });

const typing = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) || e.metaKey || e.ctrlKey || e.altKey;
};

/**
 * What you and your Vowe say (captions.ts). Your speech is only recognized while your Vowe is in the
 * call (`hearing`), so until then it says how to get captions instead.
 */
function CaptionsPanel({ captions, hearing }: { captions: Captions; hearing: boolean }) {
  const { prev, cur } = useStore(captions.store);
  if (!cur) {
    const note = hearing ? 'Captions are on. Nothing has been said yet.' : 'Captions are on. Bring Vowe into the call from the orb to caption what you say.';
    return <div class="captions" aria-live="polite"><div class="curline"><span class="words" style="color:var(--ink-7)">{note}</span></div></div>;
  }
  const who = (line: CaptionLine) => (line.who === 'vowe' ? 'Vowe' : 'You');
  return (
    <div class="captions" aria-live="polite">
      {prev && <div class="prevline">{who(prev)} · {captionText(prev.text)}</div>}
      <div class="curline">
        <span class="spk">{who(cur)}</span>
        <span class="words" style={cur.live ? 'color:var(--ink-5)' : undefined}>{captionText(cur.text)}</span>
      </div>
    </div>
  );
}

/** The captions panel: asking Vowe takes it over while open. */
function CallCaptions({ ask, cc, captions, hearing }: { ask: AskVowe; cc: boolean; captions: Captions; hearing: boolean }) {
  const open = useStore(ask.store).open;
  return open ? <AskVowePanel ask={ask} /> : cc ? <CaptionsPanel captions={captions} hearing={hearing} /> : null;
}

/** A real room's canvas with nothing on it yet: the fresh call's empty state, told what works now. */
function LiveEmpty({ client, onAsk }: { client: CanvasClient; onAsk?(): void }) {
  const c = useStore(client.store);
  if (c.status === 'loading' || Object.keys(c.doc.components).length) return null;
  return (
    <div class="fresh-empty">
      <span class="orb"></span>
      <b>{c.status === 'failed' ? 'Couldn’t read this room’s canvas' : 'Nothing drawn yet'}</b>
      {c.status === 'failed' ? <span>{c.error}</span> : (
        <>
          <span>When Vowe sketches the system it lands here for everyone in the call, saved with the room. Circle, draw and pin comments on it together.</span>
          <span class="fine">Ask Vowe about the system and it can sketch it here; structural changes wait for someone to accept them.</span>
          {onAsk && <button class="mini ask" type="button" onClick={onAsk}>Ask Vowe</button>}
        </>
      )}
    </div>
  );
}

/** The call dropped: say so on the canvas, and let you rejoin or step back out to the room. */
function Dropped({ session, onJoin, onLeave }: { session: CallSession; onJoin(): void; onLeave(): void }) {
  const cs = useStore(session.store);
  if (cs.status !== 'dropped') return null;
  return (
    <div class="receipt dropped" role="alert">
      <span class="dot needs"></span>
      <span>The call disconnected. The canvas stays as it was.</span>
      <button class="mini ghost" type="button" onClick={onLeave}>Back to the room</button>
      <button class="mini" type="button" onClick={onJoin}>Rejoin</button>
    </div>
  );
}

/** The app's one sidebar, as the room's left column (the same one Home and a call show). */
function RoomSidebar(p: { rooms: RoomSummary[]; current: string; side: boolean; onOpenRoom(id: string): void; onNewRoom(repo?: string | null): void }) {
  return (
    <aside class="sidebar vh-sb-host" aria-hidden={!p.side} inert={!p.side}>
      <ShellSidebar place={null} rooms={p.rooms} current={p.current} onRoom={p.onOpenRoom} onNew={(repo) => p.onNewRoom(repo)} foot={<AccountFoot />} />
    </aside>
  );
}

function PreviewRoom(props: InnerProps) {
  const { sources, roomId, light, onOpenRoom, onNewRoom, onHome, canvas, session, onJoin, ui, membership } = props;
  const rooms = useRooms(sources.room);
  const side = useStore(shellPrefs).sidebar;
  useSidebarKey();
  const summary = rooms.find((r) => r.id === roomId);
  const others = summary?.inCall.filter((p) => p.tone !== 'me') ?? [];
  const access = ui.access;
  const joinSheet = membership && props.voice ? (close: () => void) => (
    <PreJoinSheet talking={others.map((p) => p.name)} canTalk={can(summary?.role, 'talk')} micDenied={micRefused}
      onJoin={(o) => { close(); onJoin(o); }} onCancel={close} onOpenSystemSettings={() => { void window.journey.calls.openMicrophoneSettings(); }} />
  ) : undefined;
  return (
    <div class={`win ${light ? 'light ' : ''}${side ? 'side-open' : ''} outside`}>
      <Lights />
      {props.overlay}
      {ui.toasts}
      <Chrome side={side} sideName="sidebar" toggleSide={toggleSidebar} onNewRoom={() => onNewRoom(null)} onHome={onHome} actions={ui.share} />
      <RoomSidebar rooms={rooms} current={roomId} side={side} onOpenRoom={onOpenRoom} onNewRoom={onNewRoom} />
      <main class="room">
        <div class="room-identity">
          <h1>{summary?.name ?? 'Room'}</h1>
          {summary?.repo && <span class="meta">{summary.repo}</span>}
          {others.length > 0 && (
            <div class="presence">
              <span class="who-label">In the call</span>
              <Who people={others} vowe />
            </div>
          )}
        </div>
        {summary ? (
          <RoomPreview sources={sources} roomId={roomId} session={session} canvas={canvas} attachError={props.attachError} onJoin={() => onJoin()}
            joinSheet={joinSheet}
            people={membership && access ? <PeopleSection source={membership} access={access} onInvite={ui.openShare} onLeft={() => {}} onNote={ui.note} /> : undefined} />
        ) : (
          <section class="lobby"><div class="lobby-in"><p class="wnote">This room isn’t in your workspace any more. <button class="linkish" type="button" onClick={onHome}>Back to your rooms</button></p></div></section>
        )}
      </main>
    </div>
  );
}

function DemoCall(props: InnerProps & { canvas: RoomController }) {
  const { sources, canvas: ctrl, session, onOpenRoom, onNewRoom, onLeave, onJoin, light, roomId } = props;
  useEffect(() => { ctrl.resume(); return () => ctrl.suspend(); }, [ctrl]);
  const shown = useShownRef();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (shown.current) ctrl.key(e); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ctrl]);
  const s = useStore(ctrl.store);
  const cs = useStore(session.store);
  const rooms = useRooms(sources.room);
  const m = deriveRoom(ctrl);
  const summary = rooms.find((r) => r.id === roomId);

  const call: CallControls = {
    voweCls: m.voweCls, agentLabel: m.agentLabel, partOpen: s.partOpen, chime: s.chime,
    togglePart: () => ctrl.setState({ partOpen: !s.partOpen }), pickChime: (c) => ctrl.setState({ chime: c, partOpen: false }),
    micCls: m.micCls, micLabel: m.micLabel, muted: s.muted, micDown: () => ctrl.micDown(), micUp: () => ctrl.micUp(),
    cc: s.cc, ccCls: m.ccCls, toggleCc: () => ctrl.toggleCc(),
    leaving: cs.status === 'leaving', leave: () => { void onLeave(); },
  };
  // The call, for every other screen while you look elsewhere (the demo's people are scripted).
  const link = cs.roomId === roomId ? callLink(cs.status, null) : null;
  usePublishCall(link ? {
    roomId, roomName: summary?.name ?? 'Payment Reliability', link, muted: s.muted, vowe: true, agentName: 'Vowe',
    people: [
      sources.room.me(),
      ...(ctrl.options.scenario === 'live' ? [{ name: 'John', initials: 'JM', tone: 'peer' as const }] : []),
      ...(s.srikar === 'present' ? [{ name: 'Srikar', initials: 'SR', tone: 'p2' as const }] : []),
    ],
    speaking: m.ring.daniel ? 'me' : m.ring.john ? 'JM' : m.ring.srikar ? 'SR' : null,
    act: {
      mic: () => { ctrl.micDown(); ctrl.micUp(); },
      leave: async () => { await onLeave(); },
      rejoin: link === 'dropped' ? () => onJoin() : undefined,
    },
  } : null);

  return (
    <div class={`win ${light ? 'light ' : ''}${m.winClass} in-call`}>
      <Lights />
      {props.overlay}
      <Chrome side={s.side} desk={s.desk} deskUnseen={m.deskUnseen} toggleSide={() => ctrl.setState({ side: !s.side })} toggleDesk={() => ctrl.setState({ desk: !s.desk })} onNewRoom={onNewRoom} />
      <RoomsPanel rooms={rooms} current={roomId} hidden={!s.side} onOpenRoom={onOpenRoom}
        ask={m.qOpen ? { text: `${s.handedTo} is asking about refunds`, go: () => ctrl.goTo('provider', { asideOpen: 'q', sel: [] }) } : null} />
      <main class="room">
        <div class="room-identity">
          <h1>{summary?.name ?? 'Payment Reliability'}</h1>
          <span class="q" title={summary?.repo ?? ''}>{m.def.question}</span>
          {m.def.parent && <button class="lineage" type="button" title="Go to the view this one grew from" onClick={() => ctrl.go(m.def.parent!, { last: null })}>from {m.parentName}</button>}
          <div class="presence">
            {s.toast && <span class="who-label" style="color:var(--ink-3)">{s.toast}</span>}
            <div class="who">
              <span class={`avatar ${m.ring.daniel}`} title="Daniel">DE</span>
              {ctrl.options.scenario === 'live' && <span class={`avatar peer ${m.ring.john}`} title="John">JM</span>}
              {s.srikar === 'present' && <span class={`avatar p2 arrive ${m.ring.srikar}`} title="Srikar">SR</span>}
              <span class={`orb small ${m.ring.vowe}`} title="Vowe"></span>
            </div>
          </div>
        </div>
        <Surface ctrl={ctrl} m={m} call={call} banner={<Dropped session={session} onJoin={() => onJoin()} onLeave={onLeave} />} />
      </main>
      <Desk ctrl={ctrl} m={m} />
    </div>
  );
}

const FRESH_TOOLS = [
  { id: 'select' as const, label: 'Select', title: 'Select · V', Icon: ToolSelect },
  { id: 'draw' as const, label: 'Draw', title: 'Draw · P', Icon: ToolDraw },
  { id: 'comment' as const, label: 'Comment', title: 'Comment · C', Icon: ToolComment },
];
type FreshTool = (typeof FRESH_TOOLS)[number]['id'];

/** A call in a room with nothing drawn yet: the same canvas and call bar, ready for a fresh start. */
function FreshCall(props: InnerProps) {
  const { sources, record, roomId, session, onOpenRoom, onNewRoom, onLeave, onJoin, light, ui, membership, voice } = props;
  const snap = useVoice(voice);
  const now = useNow();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [viewerNote, setViewerNote] = useState(true);
  const rooms = useRooms(sources.room);
  const cs = useStore(session.store);
  const summary = rooms.find((r) => r.id === roomId);
  const me = sources.room.me();
  const side = useStore(shellPrefs).sidebar;
  useSidebarKey();
  const [desk, setDesk] = useState(!!record);
  const [tool, setTool] = useState<FreshTool>('select');
  const [ink, setInk] = useState<string[]>([]);
  /** Comments placed but not yet written; with a record, Enter saves one as a thread. */
  // At most one unwritten comment: placing another moves it. On the real canvas, x/y are stage units.
  const [drafts, setDrafts] = useState<{ x: number; y: number; on?: { component: string; name: string } | null }[]>([]);
  const [stroke, setStroke] = useState<string | null>(null);
  const [muted, setMuted] = useState(true);
  const [cc, setCc] = useState(false);
  // What this room calls its agent (renamed by an owner), for the call cluster on other screens.
  const [agentName, setAgentName] = useState('Vowe');
  useEffect(() => { if (window.journey) agentNameOf(roomId).then(setAgentName, () => { /* keeps Vowe */ }); }, [roomId]);
  const [partOpen, setPartOpen] = useState(false);
  const [chime, setChime] = useState<Chime>('pauses');
  // Read by your Vowe as you finish each thing you say: whether it chimes in, or waits to be asked.
  const chimeNow = useRef(chime);
  chimeNow.current = chime;
  const [drafting, setDrafting] = useState<'new' | 'amend' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [lit, setLit] = useState<string | null>(null);
  const surf = useRef<HTMLElement>(null);
  const pts = useRef<[number, number][] | null>(null);
  const rec = useLoaded(
    () => record ? record.load(roomId) : Promise.resolve(null),
    (fn) => record ? record.subscribe(roomId, fn) : () => {},
    roomId,
  );
  const view = rec.value;
  // A real room's semantic canvas: kept with the room, changed by Canvas Commands, shared with its call.
  const board = useMemo(() => record && window.journey
    ? new CanvasClient(roomId, ipcTransport(() => ({ kind: 'human', id: selfCloudId() ?? 'me', name: account.state.user?.name ?? 'You' })))
    : null, [roomId, !!record]);
  useEffect(() => () => board?.dispose(), [board]);
  // Asking Vowe by text, on this person's own model sign-in; what it changes on the canvas is shared.
  const asker = useMemo(() => board
    ? new AskVowe(roomId, board, () => ({ userId: selfCloudId(), name: account.state.user?.name ?? null }))
    : null, [board]);
  useEffect(() => () => asker?.close(), [asker]);
  const reviewing = useStore<{ reviewing: string | null }>(asker?.store ?? NOT_ASKING).reviewing;

  // Opening People (from Share's Manage access) opens the column it lives in.
  useEffect(() => { if (ui.people) setDesk(true); }, [ui.people]);
  useEffect(() => { if (snap?.error === MICROPHONE_DENIED) micRefused = true; else if (snap?.micEnabled) micRefused = false; }, [snap?.error, snap?.micEnabled]);
  const shown = useShownRef();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!shown.current || typing(e)) return;
      const tools: Record<string, FreshTool> = { v: 'select', p: 'draw', c: 'comment' };
      if (tools[e.key]) { setTool(tools[e.key]); e.preventDefault(); }
      else if (e.key === ']' && record) { setDesk((v) => !v); e.preventDefault(); }
      else if (e.key === 'Escape') setPartOpen(false);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  /** Runs a change to the record, and says so on the canvas if it didn't go through. */
  const act = (p: Promise<void>) => p.then(() => setFailure(null), (err: Error) => { setFailure(err.message); throw err; });

  const at = (e: PointerEvent): [number, number] => { const r = surf.current!.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const path = (p: [number, number][]) => p.map((q, i) => (i ? 'L' : 'M') + q[0].toFixed(1) + ' ' + q[1].toFixed(1)).join(' ');
  const down = (e: PointerEvent) => {
    if ((e.target as Element).closest('button, input, label, .call, .tools, .pin, .receipt')) return;
    if (tool === 'comment') { const [x, y] = at(e); setDrafts([{ x: x - 10, y: y - 20 }]); return; }
    if (tool !== 'draw') return;
    surf.current!.setPointerCapture(e.pointerId);
    pts.current = [at(e)];
  };
  const move = (e: PointerEvent) => { if (pts.current) { pts.current.push(at(e)); setStroke(path(pts.current)); } };
  const up = () => { if (pts.current && pts.current.length > 2) setInk(ink.concat([path(pts.current)])); pts.current = null; setStroke(null); };
  const save = (i: number, body: string) => {
    const d = drafts[i];
    if (!record || !body.trim()) return;
    const text = body.trim();
    record.pin(roomId, d, text, d.on).then((threadId) => {
      setFailure(null);
      setDrafts((all) => all.filter((x) => x !== d));
      // Vowe answers each new comment in its thread, on this person's model.
      asker?.feedback(threadId, text, d.on ?? null, (said) => act(record.reply(roomId, threadId, said, 'vowe')));
    }, (err: Error) => setFailure(err.message));
  };
  // A thread opened in the panel lights its comment on the canvas (or every comment on that part).
  const show = (anchor: string) => {
    setLit(anchor);
    setTimeout(() => setLit(null), 1600);
  };

  const others = summary?.inCall.filter((p) => p.tone !== 'me') ?? [];
  // A real room's call is people talking on LiveKit. Vowe's voice and captions aren't in this build, so
  // they're off and say so; your mic is real, starts off, and only a viewer can't turn it on.
  const live = !!(record && voice && snap);
  const talks = !record || can(summary?.role, 'talk');
  /** Viewers read the decision and comment on it; proposing and signing is for owners and members. */
  const decides = !summary?.role || can(summary.role, 'sign_decision');
  const micMuted = live ? !snap!.micEnabled : muted;
  const voiceOff = record && !voice ? 'Voice isn’t connected in this build' : undefined;
  // Your Vowe in this call: it hears your microphone while it's on, answers on your model sign-in, and
  // speaks into the call as "Vowe (for you)". Its turns show in the Ask Vowe panel, like typed asks.
  const callVoice = useMemo(() => {
    const userId = selfCloudId();
    if (!live || !board || !asker || !voice || !window.journey?.voice || !userId) return null;
    return new CallVoice({
      api: window.journey,
      roomId,
      localUser: { userId, name: account.state.user?.name ?? null },
      canvas: () => snapshotOf(board.store.state.doc, { selected: [], circled: [] }),
      call: voice,
      microphone: () => voice.microphoneTrack(),
      answers: () => chimeNow.current,
      onOverheard: (question) => asker.overheard(question),
      onEvent: (event) => asker.follow(event),
    });
  }, [live, board, asker, voice, roomId]);
  useEffect(() => () => { void callVoice?.stop().catch(() => {}); }, [callVoice]);
  const [vowe, setVowe] = useState<VoiceStatus | null>(null);
  const [voweError, setVoweError] = useState<string | null>(null);
  useEffect(() => {
    const api = window.journey?.voice;
    if (!api || !asker) return;
    void api.status().then(setVowe, () => {});
    const offStatus = api.onStatus((s) => { setVowe(s); if (s.status === 'failed' && s.error) setVoweError(s.error); });
    const offSpeech = api.onSpeech(({ roomId: r, speech }) => {
      if (r === roomId && speech.final && speech.addressed) asker.heard(speech.text.replace(/^vowe,\s*/i, ''));
    });
    return () => { offStatus(); offSpeech(); };
  }, [roomId, asker]);
  // Captions: your speech while your Vowe hears you, and what it says back.
  const captions = useMemo(() => new Captions(), [roomId]);
  useEffect(() => {
    const api = window.journey?.voice;
    if (!api) return;
    const offSpeech = api.onSpeech(({ roomId: r, speech }) => { if (r === roomId) captions.heard(speech); });
    const offSaid = api.onSaid(({ roomId: r, turnId, text }) => { if (r === roomId) captions.said(turnId, text); });
    return () => { offSpeech(); offSaid(); };
  }, [roomId, captions]);
  const mine = vowe?.roomId === roomId ? vowe : null;
  const voweOn = mine?.status === 'on' || mine?.status === 'joining';
  const voweState = !mine || !voweOn ? null : mine.status === 'joining' ? 'thinking' : mine.state;
  const toggleVowe = () => {
    if (!callVoice) return;
    setVoweError(null);
    if (voweOn) void callVoice.stop().catch((err: Error) => setVoweError(err.message));
    else callVoice.start().catch((err: Error) => setVoweError(err.message)); // from the click: speech needs a gesture
  };
  const agentOff = live && !callVoice ? 'Vowe’s voice isn’t connected in this build' : undefined;
  const micOff = !live ? undefined
    : !talks ? 'Viewers listen. Ask an owner to make you a member to talk.'
    : snap!.status !== 'connected' ? 'Connecting to the call…' : undefined;
  const meSpeaking = live && snap!.participants.some((p) => p.isLocal && p.isSpeaking);
  const toggleMic = () => {
    if (!voice || !snap || snap.micPending) return;
    voice.setMicrophoneEnabled(!snap.micEnabled).catch(() => { /* the snapshot says why */ });
  };
  const call: CallControls = {
    voweCls: callVoice ? 'vowe-btn' + (voweState ? ' ' + voweState : '') : 'vowe-btn' + (voiceOff || agentOff ? '' : ' listening'),
    agentLabel: callVoice
      ? (mine?.status === 'joining' ? 'joining the call…' : voweState === 'listening' && micMuted ? 'in the call · unmute so it can hear you' : voweState ? { listening: chime === 'pauses' ? 'Listening · chimes in when you pause' : 'Listening · say “Vowe, …”', thinking: 'Thinking', speaking: 'Speaking' }[voweState] : 'not in this call')
      : voiceOff || agentOff ? 'not in this call' : 'Listening',
    partOpen, chime,
    toggleVowe: callVoice ? toggleVowe : undefined, voweOn,
    togglePart: () => setPartOpen(!partOpen), pickChime: (c) => { setChime(c); setPartOpen(false); },
    micCls: 'cbtn' + (micMuted ? ' muted' : '') + (meSpeaking ? ' talking' : '') + (live && snap!.micPending ? ' pending' : ''),
    micLabel: voiceOff ?? (live && snap!.micPending ? 'Turning the mic on…' : micMuted ? 'Unmute' : 'Mute'), muted: micMuted,
    micDown: () => {}, micUp: () => { if (voiceOff) return; setMuted(!muted); sources.call.setMuted(!muted); },
    micToggle: live ? toggleMic : undefined,
    cc, ccCls: 'cbtn' + (cc ? ' on' : ''), toggleCc: () => { setCc(!cc); sources.call.setCaptions(!cc); },
    voiceOff, agentOff, micOff, leaving: cs.status === 'leaving',
    leave: () => { if (voweOn) void callVoice?.stop().catch(() => {}); void onLeave(); },
    askByText: asker ? () => asker.open() : undefined,
  };
  // Who's speaking, by initials (how the band draws people).
  const ring: Record<string, string> = {};
  if (live && ui.access) {
    for (const p of snap!.participants) {
      const u = ui.access.users[p.identity];
      if (u && p.isSpeaking) ring[u.initials] = 'speaking';
    }
  }
  // The call, for every other screen while you look elsewhere: published from here, the room that owns it.
  const link = cs.roomId === roomId ? callLink(cs.status, live ? snap!.status : null) : null;
  const cantTalk = voiceOff ?? (live && !talks ? 'Viewers listen. Ask an owner to make you a member to talk.' : undefined);
  const presence: CallPresence | null = link ? {
    roomId, roomName: summary?.name ?? 'Room', link,
    muted: micMuted || !!cantTalk, micOff: cantTalk,
    vowe: callVoice ? voweOn : false, agentName,
    people: [me, ...others],
    speaking: meSpeaking ? 'me' : Object.keys(ring).find((i) => i !== me.initials) ?? null,
    act: {
      mic: () => { if (cantTalk) return; if (live) toggleMic(); else { setMuted(!muted); sources.call.setMuted(!muted); } },
      leave: async () => { if (voweOn) await callVoice?.stop().catch(() => {}); await onLeave(); },
      rejoin: link === 'dropped' ? () => { if (cs.status === 'dropped' || !voice) onJoin(); else void voice.reconnect().catch(() => { /* the snapshot says why */ }); } : undefined,
    },
  } : null;
  usePublishCall(presence);
  const callError = live && snap!.error && snap!.error !== dismissed ? snap!.error : null;
  const pins = view?.pins ?? [];
  const empty = !ink.length && !drafts.length && !pins.length;
  // Comments: saved pins from the room's record, and ones you placed but haven't written yet.
  // `place` puts a point on screen: as-is on the sketch surface, through the camera on the real canvas.
  const marksAt = (place: (x: number, y: number) => { x: number; y: number }, nudge: [number, number]) => (
    <>
      {pins.map((p) => { const q = place(p.x, p.y); return (
        <div key={p.threadId} class={'pin saved' + (lit === p.anchor ? ' lit' : '')} style={`transform: translate(${q.x + nudge[0]}px, ${q.y + nudge[1]}px)`}>
          <span class={'head ' + p.author.tone} title={p.author.name}>{p.author.initials}</span>
          <span class="pin-note">{p.body}</span>
          {record && p.author.tone === 'me' && (
            <button class="pin-x" type="button" aria-label="Remove comment" title="Remove from the canvas (kept in the room's history)"
              onClick={() => act(record.resolve(roomId, p.threadId)).catch(() => {})}>×</button>
          )}
        </div>
      ); })}
      {drafts.map((p, i) => { const q = place(p.x, p.y); return (
        <div key={`${p.x},${p.y}`} class="pin" style={`transform: translate(${q.x + nudge[0]}px, ${q.y + nudge[1]}px)`}>
          <span class="head">{me.initials}</span>
          <label style="display:flex"><span class="sr">Comment</span>
            <input type="text" placeholder={record ? 'Add a comment, then Enter' : 'Add a comment…'}
              onKeyDown={(e) => { if (e.key === 'Enter') save(i, (e.currentTarget as HTMLInputElement).value); if (e.key === 'Escape') setDrafts(drafts.filter((x) => x !== p)); }} />
          </label>
          <button class="pin-x" type="button" aria-label="Discard comment" title="Discard" onClick={() => setDrafts(drafts.filter((x) => x !== p))}>×</button>
        </div>
      ); })}
    </>
  );
  const notices = (
    <>
      {asker ? <CallCaptions ask={asker} cc={cc} captions={captions} hearing={mine?.status === 'on'} /> : cc && <CaptionsPanel captions={captions} hearing={mine?.status === 'on'} />}
      {voweOn && micMuted && !voweError && (
        <div class="receipt" role="status">
          <span class="dot"></span><span>Vowe is in the call. Unmute to talk to it: say “Vowe, …” and your question.</span>
          <button class="mini ask" type="button" onClick={toggleMic}>Unmute</button>
        </div>
      )}
      {voweError && (
        <div class="receipt dropped" role="alert">
          <span class="dot needs"></span><span>Vowe: {voweError}</span>
          <button class="mini ghost" type="button" onClick={() => setVoweError(null)}>Dismiss</button>
        </div>
      )}
      {failure && (
        <div class="receipt dropped" role="alert">
          <span class="dot needs"></span><span>Not saved: {failure}</span>
          <button class="mini ghost" type="button" onClick={() => setFailure(null)}>Dismiss</button>
        </div>
      )}
      {live && snap!.status === 'reconnecting' && (
        <div class="receipt dropped" role="status"><span class="spinlet"></span><span>Reconnecting to the call. Audio is paused until it’s back.</span></div>
      )}
      {live && snap!.audioBlocked && (
        <div class="receipt dropped" role="alert">
          <span class="dot needs"></span><span>Your system paused the call’s audio.</span>
          <button class="mini" type="button" onClick={() => { void voice!.startAudio(); }}>Play audio</button>
        </div>
      )}
      {callError === MICROPHONE_DENIED ? (
        <div class="vm-micdenied vm-call-notice" role="alert">
          <b>Microphone is blocked for Vowe</b>
          <span>Allow it in System Settings › Privacy &amp; Security › Microphone. You’re still on the call, muted.</span>
          <span class="vm-gate-acts">
            <button type="button" class="vm-link-btn" onClick={() => setDismissed(callError)}>Not now</button>
            <button type="button" class="vm-btn vm-btn-small" onClick={() => { void window.journey.calls.openMicrophoneSettings(); }}>Open System Settings</button>
          </span>
        </div>
      ) : callError ? (
        <div class="receipt dropped" role="alert">
          <span class="dot needs"></span><span>{callError}</span>
          <button class="mini ghost" type="button" onClick={() => setDismissed(callError)}>Dismiss</button>
        </div>
      ) : live && !talks && viewerNote ? (
        <div class="vm-call-notice">
          <AccessNotice title="You’re listening as a viewer" body={<>Viewers hear the call and comment, with the mic off. Ask {ui.access?.ownerName ?? 'an owner'} to make you a member to talk.</>}
            action="OK" onAction={() => setViewerNote(false)} />
        </div>
      ) : null}
      <Dropped session={session} onJoin={() => onJoin()} onLeave={onLeave} />
    </>
  );
  const overlays = <>{notices}<CallBar c={call} /></>;

  if (board && record && props.vowe) {
    const speaking = Object.keys(ring)[0] ?? null;
    return (
      <RealRoom roomId={roomId} room={summary ?? { id: roomId, name: 'Room', repo: null }} rooms={rooms} services={props.vowe} client={board} asker={asker}
        agentReply={(threadId, body) => act(record.reply(roomId, threadId, body, 'vowe'))}
        access={ui.access} role={summary?.role ?? ui.access?.members.find((m) => m.userId === ui.access?.viewerId)?.role ?? null} me={selfCloudId() ?? ''}
        call={call} people={[me, ...others]} speaking={speaking} inCall={summary?.inCall.length ?? 1} overlays={notices}
        share={ui.share} openShare={ui.openShare} light={light} windowOverlay={<>{props.overlay}{ui.toasts}</>}
        peoplePanel={ui.people && membership && ui.access ? (
          <div class="vm-desk-people">
            <MembersPanel access={ui.access} source={membership} now={now} onBack={() => ui.setPeople(false)} onInvite={ui.openShare} onLeft={() => {}} onNote={ui.note} />
          </div>
        ) : null}
        onOpenRoom={onOpenRoom} onNewRoom={onNewRoom} onHome={props.onHome} />
    );
  }

  return (
    <div class={`win ${light ? 'light ' : ''}${side ? 'side-open ' : ''}${record && desk ? 'desk-open ' : ''}in-call`}>
      <Lights />
      {props.overlay}
      {ui.toasts}
      <Chrome side={side} sideName="sidebar" desk={record ? desk : null} toggleSide={toggleSidebar} toggleDesk={() => setDesk(!desk)} onNewRoom={() => onNewRoom(null)} actions={ui.share} />
      <RoomSidebar rooms={rooms} current={roomId} side={side} onOpenRoom={onOpenRoom} onNewRoom={onNewRoom} />
      <main class="room">
        <div class="room-identity">
          <h1>{summary?.name ?? 'Room'}</h1>
          <span class="q">{summary?.repo ?? 'No repository'}</span>
          <div class="presence"><Who people={[me, ...others]} vowe={callVoice ? voweOn : !voiceOff && !agentOff} ring={ring} /></div>
        </div>
        {board ? (
          <LiveSurface client={board} onComment={(x, y, on) => setDrafts([{ x, y, on }])} onAsk={asker ? (about) => asker.open(about) : undefined}
            anchored={(place) => marksAt(place, [-10, -20])}>
            {!pins.length && !drafts.length && <LiveEmpty client={board} onAsk={asker ? () => asker.open() : undefined} />}
            {overlays}
          </LiveSurface>
        ) : (
          <section ref={surf} class={'surface fresh tool-' + tool} tabIndex={0} aria-label="Shared canvas · V select, P draw, C comment, [ rooms"
            onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
            <svg class="ink fresh-ink" aria-hidden="true">
              {ink.map((d, i) => <path key={i} class="stroke" d={d}></path>)}
              {stroke && <path class="stroke" d={stroke}></path>}
            </svg>
            {marksAt((x, y) => ({ x, y }), [0, 0])}
            {empty && (
              <div class="fresh-empty">
                <span class="orb"></span>
                <b>Nothing drawn yet</b>
                {record ? (
                  <>
                    <span>Draw and pin comments here. Comments become the room’s threads and stay after the call; ink stays on your screen only.</span>
                    <span class="fine">{voice ? 'Your mic starts off: unmute below to talk. Vowe’s own voice, and drawing as you talk, aren’t connected in this build.' : 'Voice, and Vowe drawing as you talk, aren’t connected in this build.'}</span>
                  </>
                ) : (
                  <>
                    <span>Say what you’re building. Vowe sketches it here for everyone in the call, and you can point, circle and draw on it together.</span>
                    <span class="fine">This build has no voice pipeline, so only the Payment Reliability demo draws by itself. Draw and comment work here.</span>
                  </>
                )}
              </div>
            )}
            <div class="tools" role="toolbar" aria-label="Canvas tools" aria-orientation="vertical">
              {FRESH_TOOLS.map(({ id, label, title, Icon }) => (
                <button key={id} class={tool === id ? 'on' : ''} type="button" aria-label={label} title={title} aria-pressed={tool === id} onClick={() => setTool(id)}><Icon /></button>
              ))}
              {(ink.length > 0 || drafts.length > 0) && <button type="button" aria-label="Clear your ink" title="Clear your ink and unsaved comments" onClick={() => { setInk([]); setDrafts([]); }}><ClearInk /></button>}
            </div>
            {overlays}
          </section>
        )}
      </main>
      {record && (
        <aside class="desk" aria-label="Where the room is" aria-hidden={!desk}>
          {ui.people && membership && ui.access ? (
            <div class="vm-desk-people">
              <MembersPanel access={ui.access} source={membership} now={now} onBack={() => ui.setPeople(false)} onInvite={ui.openShare} onLeft={() => {}} onNote={ui.note} />
            </div>
          ) : !view ? (
            <div class="desk-inner">
              {rec.state === 'failed'
                ? <p class="wnote">Couldn’t read this room’s record: {rec.error} <button class="linkish" type="button" onClick={rec.retry}>Try again</button></p>
                : <p class="wnote"><span class="spinlet"></span>Reading the room…</p>}
            </div>
          ) : drafting ? (
            <div class="desk-panel">
              <ProposeDecision initial={drafting === 'amend' ? view.decision ?? undefined : undefined} onCancel={() => setDrafting(null)}
                onSubmit={(d) => act(drafting === 'amend' && view.decision ? record.amend(roomId, view.decision.id, d) : record.propose(roomId, d)).then(() => setDrafting(null))} />
            </div>
          ) : (
            <div class="desk-panel">
              <RoomPanel
                {...view.panel}
                people={reviewing ? { ...view.panel.people, [VOWE.id]: VOWE } : view.panel.people}
                threads={reviewing ? view.panel.threads.map((t) => t.id === reviewing ? { ...t, presence: { personId: VOWE.id, mode: 'typing' as const } } : t) : view.panel.threads}
                onSign={(id, v) => { act(record.sign(roomId, id, v)).catch(() => {}); }}
                onProposeChange={decides ? () => setDrafting('amend') : undefined}
                onPropose={decides ? () => setDrafting('new') : undefined}
                onReply={(id, body) => { act(record.reply(roomId, id, body)).catch(() => {}); }}
                onShowAnchor={show}
              >
                {membership && ui.access && (
                  <button class="rp-link" type="button" onClick={() => ui.setPeople(true)}>
                    People · {ui.access.members.length} in the room
                  </button>
                )}
              </RoomPanel>
            </div>
          )}
        </aside>
      )}
    </div>
  );
}

export function RoomScreen(props: RoomScreenProps) {
  const { inCall, canvas, sources, roomId, membership, session, light } = props;
  // Having the room open puts you in it for its other members (never in its call).
  useEffect(() => {
    const room = sources.room;
    void room.enter?.(roomId).catch(() => { /* the preview says why it couldn't open */ });
    return () => { void room.exit?.(roomId).catch(() => {}); };
  }, [sources, roomId]);
  const access = useAccess(membership, roomId);
  const [toasts, note] = useToasts();
  const [shareOpen, setShareOpen] = useState(false);
  const [people, setPeople] = useState(false);
  const lost = membership?.lost(roomId) ?? null;
  useEffect(() => { if (lost && session.state.roomId === roomId) void session.leave(); }, [lost]);

  if (lost && membership) {
    return (
      <div class="room-screen" hidden={props.hidden} inert={props.hidden}>
        <div class={`win ${light ? 'light ' : ''}outside`}>
          <Lights />
          <AccessLostScreen lost={lost} roomName={lost.roomName ?? 'this room'} onHome={() => { membership.dismissLost(roomId); props.onHome(); }} />
        </div>
      </div>
    );
  }

  const ui: RoomUi = {
    access, note, toasts: <Toasts toasts={toasts} />,
    share: membership && access ? (
      <ShareControl source={membership} access={access} open={shareOpen} setOpen={setShareOpen} onNote={note} label={inCall && props.vowe ? 'Invite' : undefined}
        onManage={() => { if (inCall) setPeople(true); else document.querySelector('.vm-lobby-people')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }} />
    ) : null,
    openShare: () => setShareOpen(true),
    people, setPeople,
  };
  const inner = { ...props, ui };
  const hidden = !!props.hidden;
  return (
    <RoomShown.Provider value={!hidden}>
      <div class="room-screen" hidden={hidden} inert={hidden} aria-hidden={hidden || undefined}>
        {!inCall ? <PreviewRoom {...inner} /> : canvas ? <DemoCall {...inner} canvas={canvas} /> : <FreshCall {...inner} />}
      </div>
    </RoomShown.Provider>
  );
}
