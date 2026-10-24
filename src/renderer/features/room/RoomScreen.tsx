import { h, type ComponentChildren } from '../../vendor/preact.js';
import { useEffect, useRef, useState } from '../../vendor/preact-hooks.js';
import { ClearInk, ToolComment, ToolDraw, ToolSelect } from '../../shared/components/icons.js';
import { useStore } from '../../shared/store.js';
import type { CallSession } from '../call/session.js';
import { useRooms } from '../workspace/hooks.js';
import type { CallControls } from './call/CallBar.js';
import { CallBar } from './call/CallBar.js';
import { Surface } from './canvas/Surface.js';
import type { RoomController } from './controller.js';
import type { RoomSources } from './data/sources.js';
import { Desk } from './intent/Desk.js';
import { deriveRoom } from './model.js';
import { RoomPreview } from './preview/RoomPreview.js';
import { Chrome, Lights, RoomsPanel, Who } from './shell.js';
import type { Chime, PersonRef } from './types.js';

// A room, in one of two states. Outside the call it is a preview: what the room is for, who is in its
// call, what changed, the work behind it. Joining the call opens the shared canvas in the same window,
// under the same band; leaving it comes back to the preview. Only Payment Reliability has a scripted
// canvas; any other room's call opens on an empty one.

export interface RoomScreenProps {
  /** The workspace: rooms, calls and work context. */
  sources: Pick<RoomSources, 'room' | 'call' | 'work'>;
  roomId: string;
  /** Show the call: the route asks for it and the session is in this room's call. */
  inCall: boolean;
  session: CallSession;
  /** The room's scripted canvas, if it has one. */
  canvas: RoomController | null;
  light: boolean;
  onOpenRoom(id: string): void;
  onNewRoom(): void;
  onHome(): void;
  onJoin(): void;
  onLeave(): void;
  /** Drawn inside the window, over everything: the New room sheet. */
  overlay?: ComponentChildren;
}

const YOU: PersonRef = { name: 'You', initials: 'DE', tone: 'me' };

const typing = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) || e.metaKey || e.ctrlKey || e.altKey;
};

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

function PreviewRoom(props: RoomScreenProps) {
  const { sources, roomId, light, onOpenRoom, onNewRoom, onHome, canvas, session, onJoin } = props;
  const rooms = useRooms(sources.room);
  const [side, setSide] = useState(true);
  const summary = rooms.find((r) => r.id === roomId);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (!typing(e) && e.key === '[') { setSide((v) => !v); e.preventDefault(); } };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);
  const others = summary?.inCall.filter((p) => p.tone !== 'me') ?? [];
  return (
    <div class={`win ${light ? 'light ' : ''}${side ? 'side-open' : ''} outside`}>
      <Lights />
      {props.overlay}
      <Chrome side={side} toggleSide={() => setSide(!side)} onNewRoom={onNewRoom} onHome={onHome} />
      <RoomsPanel rooms={rooms} current={roomId} hidden={!side} onOpenRoom={onOpenRoom} />
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
          <RoomPreview sources={sources} roomId={roomId} session={session} canvas={canvas} onJoin={onJoin} />
        ) : (
          <section class="lobby"><div class="lobby-in"><p class="wnote">This room isn’t in your workspace any more. <button class="linkish" type="button" onClick={onHome}>Back to your rooms</button></p></div></section>
        )}
      </main>
    </div>
  );
}

function DemoCall(props: RoomScreenProps & { canvas: RoomController }) {
  const { sources, canvas: ctrl, session, onOpenRoom, onNewRoom, onLeave, onJoin, light, roomId } = props;
  useEffect(() => { ctrl.resume(); return () => ctrl.suspend(); }, [ctrl]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => ctrl.key(e);
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
    leaving: cs.status === 'leaving', leave: onLeave,
  };

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
              <span class={`avatar peer ${m.ring.john}`} title="John">JM</span>
              {s.srikar === 'present' && <span class={`avatar p2 arrive ${m.ring.srikar}`} title="Srikar">SR</span>}
              <span class={`orb small ${m.ring.vowe}`} title="Vowe"></span>
            </div>
          </div>
        </div>
        <Surface ctrl={ctrl} m={m} call={call} banner={<Dropped session={session} onJoin={onJoin} onLeave={onLeave} />} />
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
function FreshCall(props: RoomScreenProps) {
  const { sources, roomId, session, onOpenRoom, onNewRoom, onLeave, onJoin, light } = props;
  const rooms = useRooms(sources.room);
  const cs = useStore(session.store);
  const summary = rooms.find((r) => r.id === roomId);
  const [side, setSide] = useState(false);
  const [tool, setTool] = useState<FreshTool>('select');
  const [ink, setInk] = useState<string[]>([]);
  const [pins, setPins] = useState<{ x: number; y: number }[]>([]);
  const [stroke, setStroke] = useState<string | null>(null);
  const [muted, setMuted] = useState(true);
  const [cc, setCc] = useState(false);
  const [partOpen, setPartOpen] = useState(false);
  const [chime, setChime] = useState<Chime>('pauses');
  const surf = useRef<HTMLElement>(null);
  const pts = useRef<[number, number][] | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e)) return;
      const tools: Record<string, FreshTool> = { v: 'select', p: 'draw', c: 'comment' };
      if (tools[e.key]) { setTool(tools[e.key]); e.preventDefault(); }
      else if (e.key === '[') { setSide((v) => !v); e.preventDefault(); }
      else if (e.key === 'Escape') setPartOpen(false);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  const at = (e: PointerEvent): [number, number] => { const r = surf.current!.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const path = (p: [number, number][]) => p.map((q, i) => (i ? 'L' : 'M') + q[0].toFixed(1) + ' ' + q[1].toFixed(1)).join(' ');
  const down = (e: PointerEvent) => {
    if ((e.target as Element).closest('button, input, label, .call, .tools, .pin, .receipt')) return;
    if (tool === 'comment') { const [x, y] = at(e); setPins(pins.concat([{ x: x - 10, y: y - 20 }])); return; }
    if (tool !== 'draw') return;
    surf.current!.setPointerCapture(e.pointerId);
    pts.current = [at(e)];
  };
  const move = (e: PointerEvent) => { if (pts.current) { pts.current.push(at(e)); setStroke(path(pts.current)); } };
  const up = () => { if (pts.current && pts.current.length > 2) setInk(ink.concat([path(pts.current)])); pts.current = null; setStroke(null); };

  const others = summary?.inCall.filter((p) => p.tone !== 'me') ?? [];
  const call: CallControls = {
    voweCls: 'vowe-btn listening', agentLabel: 'Listening', partOpen, chime,
    togglePart: () => setPartOpen(!partOpen), pickChime: (c) => { setChime(c); setPartOpen(false); },
    micCls: 'cbtn' + (muted ? ' muted' : ''), micLabel: muted ? 'Unmute' : 'Mute', muted,
    micDown: () => {}, micUp: () => { setMuted(!muted); sources.call.setMuted(!muted); },
    cc, ccCls: 'cbtn' + (cc ? ' on' : ''), toggleCc: () => { setCc(!cc); sources.call.setCaptions(!cc); },
    leaving: cs.status === 'leaving', leave: onLeave,
  };

  return (
    <div class={`win ${light ? 'light ' : ''}${side ? 'side-open' : ''} in-call`}>
      <Lights />
      {props.overlay}
      <Chrome side={side} toggleSide={() => setSide(!side)} onNewRoom={onNewRoom} />
      <RoomsPanel rooms={rooms} current={roomId} hidden={!side} onOpenRoom={onOpenRoom} />
      <main class="room">
        <div class="room-identity">
          <h1>{summary?.name ?? 'Room'}</h1>
          <span class="q">{summary?.repo ?? 'No repository'}</span>
          <div class="presence"><Who people={[YOU, ...others]} vowe /></div>
        </div>
        <section ref={surf} class={'surface fresh tool-' + tool} tabIndex={0} aria-label="Shared canvas · V select, P draw, C comment, [ rooms"
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
          <svg class="ink fresh-ink" aria-hidden="true">
            {ink.map((d, i) => <path key={i} class="stroke" d={d}></path>)}
            {stroke && <path class="stroke" d={stroke}></path>}
          </svg>
          {pins.map((p, i) => (
            <div key={i} class="pin" style={`transform: translate(${p.x}px, ${p.y}px)`}>
              <span class="head">DE</span>
              <label style="display:flex"><span class="sr">Comment</span><input type="text" placeholder="Add a comment…" /></label>
            </div>
          ))}
          {!ink.length && !pins.length && (
            <div class="fresh-empty">
              <span class="orb"></span>
              <b>Nothing drawn yet</b>
              <span>Say what you’re building. Vowe sketches it here for everyone in the call, and you can point, circle and draw on it together.</span>
              <span class="fine">This build has no voice pipeline, so only the Payment Reliability demo draws by itself. Draw and comment work here.</span>
            </div>
          )}
          <div class="tools" role="toolbar" aria-label="Canvas tools" aria-orientation="vertical">
            {FRESH_TOOLS.map(({ id, label, title, Icon }) => (
              <button key={id} class={tool === id ? 'on' : ''} type="button" aria-label={label} title={title} aria-pressed={tool === id} onClick={() => setTool(id)}><Icon /></button>
            ))}
            {(ink.length > 0 || pins.length > 0) && <button type="button" aria-label="Clear your ink" title="Clear your ink" onClick={() => { setInk([]); setPins([]); }}><ClearInk /></button>}
          </div>
          {cc && <div class="captions" aria-live="polite"><div class="curline"><span class="words" style="color:var(--ink-7)">Captions are on. Nothing has been said yet.</span></div></div>}
          <Dropped session={session} onJoin={onJoin} onLeave={onLeave} />
          <CallBar c={call} />
        </section>
      </main>
    </div>
  );
}

export function RoomScreen(props: RoomScreenProps) {
  const { inCall, canvas } = props;
  return (
    <div class="room-screen">
      {!inCall ? <PreviewRoom {...props} /> : canvas ? <DemoCall {...props} canvas={canvas} /> : <FreshCall {...props} />}
    </div>
  );
}
