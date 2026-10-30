import { Fragment, h, type ComponentChildren } from '../../vendor/preact.js';
import { useEffect, useMemo, useRef, useState } from '../../vendor/preact-hooks.js';
import { account } from '../../shared/account.js';
import { useStore } from '../../shared/store.js';
import type { VoiceStatus } from '../../../shared/api.js';
import { snapshotOf } from '../../../shared/canvas/index.js';
import { MICROPHONE_DENIED, type CallService } from '../../calls/service.js';
import { CallVoice } from '../../voice/call-voice.js';
import { AskVowe, AskVowePanel } from '../canvas/AskVowe.js';
import { CanvasClient, type CanvasTransport } from '../canvas/client.js';
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
import { selfCloudId } from '../workspace/real/workspace.js';
import { agentNameOf } from '../workspace/real/vowe-services.js';
import type { CallControls } from './call/CallBar.js';
import { Captions, captionText, type CaptionLine } from './captions.js';
import type { CallDataSource, RoomDataSource, RoomWorkContext, WorkstreamDataSource } from './data/sources.js';
import { freshRoom } from './fresh.js';
import { CallButton, LeaveButton } from './call/CallButton.js';
import { RoomCards } from './panel/RoomCards.js';
import { waitsOnYou } from './panel/WorkContext.js';
import type { MentionItem } from '../vowe-room/state/mentions.js';
import { Lights } from './shell.js';
import { repoName } from '../../ui/pass2/shell/sidebar-model.js';
import type { VoweServices } from '../vowe-room/contracts/services.js';
import { RealRoom } from '../vowe-room/host/RealRoom.js';
import type { Chime } from './types.js';

// A room is its canvas and its Desk, in the call or not: opening one opens the room, and the call is something
// you start, join or leave from its band. The same screen stays mounted across joining and leaving, so the
// canvas never reloads. Its side panel carries the room itself (what it's for, its repositories, people and
// shared sessions) above the Desk. A room also carries its membership (Share, People) and a LiveKit voice call.

export interface RoomScreenProps {
  /** The workspace: rooms, calls and work context. */
  sources: { room: RoomDataSource; call: CallDataSource; work: WorkstreamDataSource };
  roomId: string;
  /** Show the call: the route asks for it and the session is in this room's call. */
  inCall: boolean;
  session: CallSession;
  /** Where the room's canvas is kept: main's hub over IPC. */
  canvas: CanvasTransport;
  /** The room's record (decisions, plans, threads, attention): the Desk's and the Inbox's services. */
  vowe: VoweServices;
  /** Records Vowe's answer to a comment as its reply in that thread. */
  agentReply(roomId: string, threadId: string, body: string, parentId?: string | null): Promise<void>;
  /** You, as the record names you. */
  self(): string;
  /** Why the room's repository couldn't be attached when it was made. */
  attachError?: string;
  light: boolean;
  onOpenRoom(id: string): void;
  onNewRoom(space?: string | null): void;
  onHome(): void;
  /** Joins the call: muted, unless you chose to talk (which is what asks for the microphone). */
  onJoin(opts?: { talk: boolean }): void;
  /** Ends your part in the call; the app decides what's on screen after. */
  onLeave(): void | Promise<void>;
  /** Who's in the room and their invitations. */
  membership?: MembershipSource;
  /** The room's voice call; null until it's connected. */
  voice?: CallService | null;
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

/** The call dropped: say so on the canvas, and let you rejoin or step back out to the room. */
function Dropped({ session, onJoin, onLeave }: { session: CallSession; onJoin(): void; onLeave(): void }) {
  const cs = useStore(session.store);
  if (cs.status !== 'dropped') return null;
  return (
    <div class="receipt dropped" role="alert">
      <span class="dot needs"></span>
      <span>The call disconnected. The canvas stays as it was.</span>
      <button class="mini ghost" type="button" onClick={onLeave}>Leave the call</button>
      <button class="mini" type="button" onClick={onJoin}>Rejoin</button>
    </div>
  );
}

/** The coding sessions attached to the room, as the Desk's @ menu lists them: what needs you first. */
function sessionMentions(ctx: RoomWorkContext | null | undefined): MentionItem[] {
  const state = (w: RoomWorkContext['workstreams'][number]) => w.status === 'attention' ? (waitsOnYou(w) ? 'attention' : 'waiting') : w.status === 'unknown' ? undefined : w.status;
  const order = ['attention', 'active', 'waiting', 'completed', undefined];
  return (ctx?.workstreams ?? []).filter((w) => w.visibility === 'room')
    .map((w): MentionItem => ({ kind: 'session', id: w.id, label: w.title, key: w.branch ?? undefined, also: `${w.agent} ${w.repo ?? ''}`, state: state(w) }))
    .sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state));
}

function Room(props: InnerProps) {
  const { sources, roomId, session, onOpenRoom, onNewRoom, onLeave, onJoin, light, ui, membership, voice, inCall } = props;
  const snap = useVoice(voice);
  const now = useNow();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [viewerNote, setViewerNote] = useState(true);
  const rooms = useRooms(sources.room);
  const cs = useStore(session.store);
  const summary = rooms.find((r) => r.id === roomId);
  const me = sources.room.me();
  const work = useLoaded(() => sources.work.context(roomId), (fn) => sources.room.subscribe(fn), roomId);
  const sessions = useMemo(() => sessionMentions(work.value), [work.value]);
  const [muted, setMuted] = useState(true);
  const [cc, setCc] = useState(false);
  // What this room calls its agent (renamed by an owner), for the call cluster on other screens.
  const [agentName, setAgentName] = useState('Vowe');
  useEffect(() => { agentNameOf(roomId).then(setAgentName, () => { /* keeps Vowe */ }); }, [roomId]);
  const [partOpen, setPartOpen] = useState(false);
  const [chime, setChime] = useState<Chime>('pauses');
  // Read by your Vowe as you finish each thing you say: whether it chimes in, or waits to be asked.
  const chimeNow = useRef(chime);
  chimeNow.current = chime;
  const [failure, setFailure] = useState<string | null>(null);
  // The room's semantic canvas: kept with the room, changed by Canvas Commands, shared with its call.
  const board = useMemo(() => new CanvasClient(roomId, props.canvas), [roomId, props.canvas]);
  useEffect(() => () => board.dispose(), [board]);
  // Asking Vowe by text, on this person's own model sign-in; what it changes on the canvas is shared.
  const asker = useMemo(() => new AskVowe(roomId, board, () => ({ userId: selfCloudId(), name: account.state.user?.name ?? null })), [board]);
  useEffect(() => () => asker?.close(), [asker]);

  useEffect(() => { if (snap?.error === MICROPHONE_DENIED) micRefused = true; else if (snap?.micEnabled) micRefused = false; }, [snap?.error, snap?.micEnabled]);
  const shown = useShownRef();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (shown.current && e.key === 'Escape') setPartOpen(false); };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  /** Runs a change to the record, and says so on the canvas if it didn't go through. */
  const act = (p: Promise<void>) => p.then(() => setFailure(null), (err: Error) => { setFailure(err.message); throw err; });

  const others = summary?.inCall.filter((p) => p.tone !== 'me') ?? [];
  // Outside the call: who else has the room open, beside you.
  const looking = summary?.here?.filter((p) => p.tone !== 'me' && !summary.inCall.some((c) => c.initials === p.initials)) ?? [];
  const [sheetOpen, setSheetOpen] = useState(false);
  const joinSheet = membership && voice ? (
    <PreJoinSheet talking={others.map((p) => p.name)} canTalk={can(summary?.role, 'talk')} micDenied={micRefused}
      onJoin={(o) => { setSheetOpen(false); onJoin(o); }} onCancel={() => setSheetOpen(false)} onOpenSystemSettings={() => { void window.journey.calls.openMicrophoneSettings(); }} />
  ) : undefined;
  // Joining asks how first (muted or talking) where there's a sheet for it; otherwise it's immediate.
  const join = joinSheet ? () => setSheetOpen(!sheetOpen) : () => onJoin();
  // A room's call is people talking on LiveKit. Without a voice connection, the mic is off and says so.
  const live = inCall && !!(voice && snap);
  const talks = can(summary?.role, 'talk');
  const micMuted = live ? !snap!.micEnabled : muted;
  const voiceOff = !voice ? 'Voice isn’t connected in this build' : undefined;
  // Your Vowe in this call: it hears your microphone while it's on, answers on your model sign-in, and
  // speaks into the call as "Vowe (for you)". Its turns show in the Ask Vowe panel, like typed asks.
  const callVoice = useMemo(() => {
    const userId = selfCloudId();
    if (!live || !asker || !voice || !window.journey.voice || !userId) return null;
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
    const api = window.journey.voice;
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
    const api = window.journey.voice;
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
  const link = inCall && cs.roomId === roomId ? callLink(cs.status, live ? snap!.status : null) : null;
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
      {!inCall && cs.roomId === roomId && cs.status === 'failed' ? (
        <div class="receipt dropped" role="alert"><span class="dot needs"></span><span>Couldn’t join the call: {cs.error}</span></div>
      ) : null}
    </>
  );
  const leave = call.leave;
  const space = summary?.spaceId ? sources.room.spaces?.().find((s) => s.id === summary.spaceId)?.name ?? null : null;
  const rename = summary && sources.room.update && (summary.role ?? 'owner') === 'owner'
    ? (name: string) => sources.room.update!(roomId, { name }) : undefined;
  const callAction = inCall
    ? <LeaveButton leaving={cs.status === 'leaving'} onLeave={leave} />
    : summary ? <CallButton room={summary} session={session} onJoin={join} sheet={sheetOpen ? joinSheet : undefined} /> : null;

  const speaking = Object.keys(ring)[0] ?? null;
  return (
    <RealRoom roomId={roomId} room={summary ?? { id: roomId, name: 'Room', repo: null }} rooms={rooms} services={props.vowe} client={board} asker={asker}
      agentReply={(threadId, body, parentId) => act(props.agentReply(roomId, threadId, body, parentId))}
      access={ui.access} role={summary?.role ?? ui.access?.members.find((m) => m.userId === ui.access?.viewerId)?.role ?? null} me={props.self()}
      call={inCall ? call : null} callAction={callAction} onRename={rename} space={space ?? (summary?.repo ? repoName(summary.repo) : null)} people={inCall ? [me, ...others] : [me, ...looking]} sessions={sessions} speaking={speaking} inCall={summary?.inCall.length ?? 0} overlays={notices}
      deskTop={summary ? <RoomCards room={sources.room} work={sources.work} roomId={roomId} attachError={props.attachError} onJoin={join}
        people={membership && ui.access ? <PeopleSection source={membership} access={ui.access} onInvite={ui.openShare} onLeft={() => {}} onNote={ui.note} /> : undefined} /> : null}
      share={ui.share} openShare={ui.openShare} light={light} windowOverlay={ui.toasts}
      peoplePanel={ui.people && membership && ui.access ? (
        <div class="vm-desk-people">
          <MembersPanel access={ui.access} source={membership} now={now} onBack={() => ui.setPeople(false)} onInvite={ui.openShare} onLeft={() => {}} onNote={ui.note} />
        </div>
      ) : null}
      onOpenRoom={onOpenRoom} onNewRoom={onNewRoom} onHome={props.onHome} />
  );
}

export function RoomScreen(props: RoomScreenProps) {
  const { inCall, sources, roomId, membership, session, light } = props;
  // Having the room open puts you in it for its other members (never in its call).
  useEffect(() => {
    const room = sources.room;
    void room.enter?.(roomId).catch(() => { /* the Desk says why it couldn't read the room */ });
    return () => { void room.exit?.(roomId).catch(() => {}); };
  }, [sources, roomId]);
  const access = useAccess(membership, roomId);
  const [toasts, note] = useToasts();
  const [shareOpen, setShareOpen] = useState(false);
  // A room just made with New Room opens with Share showing: asking someone in is what comes next.
  const fresh = useStore(freshRoom).id;
  useEffect(() => { if (fresh === roomId) { setShareOpen(true); freshRoom.setState({ id: null }); } }, [fresh, roomId]);
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
        onManage={() => setPeople(true)} />
    ) : null,
    openShare: () => setShareOpen(true),
    people, setPeople,
  };
  const inner = { ...props, ui };
  const hidden = !!props.hidden;
  return (
    <RoomShown.Provider value={!hidden}>
      <div class="room-screen" hidden={hidden} inert={hidden} aria-hidden={hidden || undefined}>
        <Room {...inner} />
      </div>
    </RoomShown.Provider>
  );
}
