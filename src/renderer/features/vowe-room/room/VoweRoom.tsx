import { h, Fragment, useEffect, useMemo, useState, useStore, Lights, Chrome, Who, CallBar, type CallControls, type CanvasClient, type ComponentChildren, type PersonRef, type RoomSummary, type Store } from '../journey.js';
import { AccountFoot } from '../../../shared/components/Account.js';
import { shellPrefs, toggleSidebar, useSidebarKey } from '../../../ui/pass2/shell/prefs.js';
import { ShellSidebar } from '../../../ui/pass2/shell/Sidebar.js';
import { RoomTitle } from '../../room/shell.js';
import { Surface, type PartMarks } from '../canvas/Surface.js';
import { Desk, type DeskAct } from '../desk/Desk.js';
import { focusCrumbs } from '../desk/Focus.js';
import { FocusCrumbs } from '../desk/Crumbs.js';
import { doingOf } from '../state/agent-doing.js';
import { MentionSources } from '../desk/Mention.js';
import type { MentionItem } from '../state/mentions.js';
import type { Scenario, CanvasSemantics } from '../contracts/semantics.js';
import { NO_SEMANTICS } from '../contracts/semantics.js';
import type { RoomRole, VoweRecord } from '../contracts/model.js';
import { NO_CAPABILITIES, type Capabilities } from '../contracts/services.js';
import { actionable, attention } from '../state/attention.js';
import { DirectoryContext, names, type Directory } from '../state/directory.js';
import { SemanticsContext } from '../state/semantics.js';
import { exitDepth, type DeskNav } from './navigation.js';
import type { Depth, Ui } from '../state/ui.js';

// The room as Journey's call lays it out (FreshCall in RoomScreen.tsx): the band, the shared sidebar, the
// room's name and who's here, the canvas with its tool rail and the call under it, and the Desk.
// The Desk has three depths, reached by width alone: compact (Journey's 352px column), wider (drag the
// divider; the canvas keeps at least 440px) and full screen (the one expand button). Width never changes
// what's open; only full screen changes presentation. Depth is personal: it never moves anyone else's window.

export interface VoweRoomProps {
  room: Pick<RoomSummary, 'id' | 'name' | 'repo'>;
  /** Journey's rooms list (RoomDataSource.list()) for the sidebar. This room's `needs` is filled from attention. */
  rooms: RoomSummary[];
  onOpenRoom(id: string): void;
  /** New room, in the repository whose + was pressed in the sidebar (null: none chosen). */
  onNewRoom(space?: string | null): void;
  /** Journey's canvas client for this room (features/canvas/client.ts over ipcTransport). */
  client: CanvasClient;
  /** The room's record, kept current by the host from VoweServices.record (load + subscribe). */
  record: Store<VoweRecord>;
  /** Who is who, and the agent's name in this organization. */
  directory: Directory;
  /** Your role (Journey's RoomRole, from the room's access). */
  role: RoomRole;
  /** What the agent has read about the system. Omit: plain faces, no anatomy, no scenarios. */
  semantics?: CanvasSemantics;
  /** What the services can do. Omit: nothing beyond Journey's existing record. */
  capabilities?: Capabilities;
  /** Your UI state (state/ui.ts). Never shared. */
  ui: Ui;
  /** Everything the Desk can ask for: host/actions.ts builds it from VoweServices. */
  act: DeskAct;
  /** Marks on canvas parts, from the record (room/marks.ts). */
  marks: Record<string, PartMarks>;
  /** Parts the Desk is pointing at. */
  lit: string[];
  onAsk(about: { components: string[]; names: string[] }): void;
  onScenario(component: string, s: Scenario): void;
  /** Told after the canvas changed how many copies it shows (it runs the command itself). */
  onCopies?(n: number): void;
  onComment(x: number, y: number, on: { component: string; name: string } | null): void;
  onMarks(component: string): void;
  /** Journey's call controls; null when there's no call (the normal state). */
  call: CallControls | null;
  /** Start Call, Join or Leave, first among the band's actions. */
  callAction?: ComponentChildren;
  /** The room itself, above the Desk in its column: Journey's Room and Sessions cards. */
  deskTop?: ComponentChildren;
  /** Renames the room from its title (owners); absent, the name is plain. */
  onRename?(name: string): Promise<void>;
  /** The Space the room is in, grey beside its name; the repository when there's no Space. */
  space?: string | null;
  /** Who's here, as Journey's presence shows them. `speaking` rings one of them. */
  people: PersonRef[];
  speaking?: string | null;
  /** The coding sessions attached to the room, for the Desk's @ menu. */
  sessions?: MentionItem[];
  /** Under the room's name: "2 here · 2 on the call". */
  hereLine: string;
  /** History of what you've opened (room/navigation.ts useDeskHistory). */
  nav?: DeskNav;
  /** Things drawn over the canvas: Journey's captions, the agent's working state, a "start a call" strip. */
  overlays?: ComponentChildren;
  pins?(place: (x: number, y: number) => { x: number; y: number }, width: number, partRect: (component: string) => number[] | null): ComponentChildren;
  /** The prototype simulates window sizes; in the app this is the window. */
  size?: [number, number];
  /** Journey's light flag (RoomScreen passes the same to its .win). */
  light?: boolean;
  /** Journey's Share control (button and ShareDialog); without it, Invite calls act.invite(). */
  share?: ComponentChildren;
  /** Drawn inside the window over everything: Journey's New room sheet and its toasts. */
  windowOverlay?: ComponentChildren;
  /** Shown in the Desk instead of Discuss, Decide and Work while it's set: Journey's People drill-in. */
  deskOverride?: ComponentChildren;
  /** Whether the record has loaded. The canvas and the call never wait for it; the Desk says so. */
  deskStatus?: DeskStatus;
  /** The agent while it works: the thread it's answering (null for the Ask panel) and the tool call it's in. */
  agent?: AgentNow | null;
}

export interface AgentNow { thread: string | null; doing: { tool: string; input: unknown } | null }

export type DeskStatus = { state: 'ready' } | { state: 'loading' } | { state: 'failed'; error: string; retry(): void };

/** The Desk while the record loads, or after it couldn't be read. */
function DeskPending({ status }: { status: DeskStatus }) {
  return (
    <div class="desk-inner nx-pending">
      {status.state === 'failed'
        ? <p class="wnote">Couldn’t read this room’s record: {status.error} <button class="linkish" type="button" onClick={status.retry}>Try again</button></p>
        : <p class="wnote"><span class="spinlet"></span>Reading the room…</p>}
    </div>
  );
}

/** One control: full screen in, full screen out. Everything between compact and wide is the divider. */
function ExpandButton({ on, toggle }: { on: boolean; toggle(): void }) {
  return (
    <button type="button" class={'panel-toggle nx-expand' + (on ? ' open' : '')} aria-pressed={on} aria-label={on ? 'Exit full screen' : 'Full screen'} title={`${on ? 'Exit full screen' : 'Full screen'} · ⇧F`} onClick={toggle}>
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
        {on ? <path d="M6.5 2.5v4h-4M9.5 13.5v-4h4M2.5 2.5l4 4M13.5 13.5l-4-4" /> : <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5l-4.5 4.5M2.5 13.5L7 9" />}
      </svg>
    </button>
  );
}

function useWindowSize(): [number, number] {
  const read = (): [number, number] => [window.innerWidth, window.innerHeight];
  const [s, set] = useState(read);
  useEffect(() => { const on = () => set(read()); addEventListener('resize', on); return () => removeEventListener('resize', on); }, []);
  return s;
}

export function VoweRoom(p: VoweRoomProps) {
  const u = useStore(p.ui);
  const { sidebar: side, width: sideW } = useStore(shellPrefs);
  useSidebarKey();
  const rec = useStore(p.record);
  const s = useStore(p.client.store);
  const win = useWindowSize();
  const dir = p.directory;
  const n = names(dir);
  const caps = p.capabilities ?? NO_CAPABILITIES;
  const one = u.sel.length === 1 && !('step' in u.sel[0]) ? u.sel[0].component : null;
  const focus = one ? { id: one, name: s.doc.components[one]?.name ?? one } : null;
  const depth: Depth = u.deskOpen ? u.depth : 'compact';
  const wide = depth === 'expanded' && u.deskOpen;
  const focusMode = depth === 'focus';
  // Sizes: the compact column, and the widened Desk, which never leaves the canvas less than 440px.
  // Below 1180px the widened Desk becomes a sheet over the canvas.
  const [W, H] = p.size ?? win;
  const left = side ? sideW : 0;
  const compact = W < 1200 ? 320 : 352;
  const sheet = W < 1180;
  const maxW = Math.max(compact, W - left - 440);
  const insW = sheet ? Math.min(W - left - 56, 720) : Math.max(compact, Math.min(u.insW, maxW));
  const deskProps = {
    fsec: u.fsec, fwrite: u.fwrite, rec, me: dir.me, tab: u.tab, inspect: u.inspect, depth, compare: u.compare, openThread: u.thread, focus, focusOn: u.focusOn, hereLine: p.hereLine,
    flash: u.flash, noticesOpen: u.noticesOpen, sinceOpen: u.sinceOpen, act: p.act, role: p.role, caps, narrow: !wide || insW < 660, everywhere: u.everywhere,
    room: { name: p.room.name, repo: p.room.repo }, scene: s.scenes[s.doc.activeView] ?? null,
  };
  // The @ menu's other sources: the room's sessions, and the parts on the canvas as it shows now.
  const scene = s.scenes[s.doc.activeView];
  const mention = useMemo(() => {
    const seen = new Set<string>(), parts: MentionItem[] = [];
    for (const n of scene?.nodes ?? []) {
      if (seen.has(n.component)) continue;
      seen.add(n.component);
      parts.push({ kind: 'part', id: n.component, label: n.name, also: `${n.short} ${n.tech}` });
    }
    return { sessions: p.sessions ?? [], parts };
  }, [scene, p.sessions]);
  const crumbs = focusMode && (!p.deskStatus || p.deskStatus.state === 'ready') && !p.deskOverride ? focusCrumbs(deskProps) : null;
  // The agent's own trail after yours: what it's doing, and where, when that isn't what you're looking at.
  const partName = (id: string) => scene?.nodes.find((x) => x.component === id)?.name ?? id;
  const doing = p.agent ? (p.agent.doing ? doingOf(p.agent.doing.tool, p.agent.doing.input, partName) : { verb: 'Thinking' }) : null;
  const away = p.agent?.thread && p.agent.thread !== crumbs?.thread ? rec.threads.find((t) => t.id === p.agent!.thread) ?? null : null;
  const top = attention(rec, n).find(actionable);
  const rooms = p.rooms.map((r) => (r.id === p.room.id ? { ...r, needs: top ? top.text : null } : r));
  // The divider is the only way between compact and wide: drag it and the Desk follows the pointer; let go
  // near the compact width and it settles there.
  const startDrag = (e: PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX, w0 = depth === 'expanded' ? insW : compact, last = u.insW > compact + 80 ? u.insW : 760;
    let w = w0;
    const move = (ev: PointerEvent) => { w = Math.max(compact, Math.min(maxW, w0 + (x0 - ev.clientX))); p.ui.setState({ insW: w, depth: w > compact + 24 ? 'expanded' : 'compact' }); };
    const up = () => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up); document.body.classList.remove('nx-resizing');
      if (w < compact + 80) p.ui.setState({ depth: 'compact', insW: last });
    };
    document.body.classList.add('nx-resizing');
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  };
  const size = p.size ? `width:${W}px;height:${H}px;` : '';
  const style = `${size}${u.deskOpen ? `--right-column:${(wide || (focusMode && u.prevDepth === 'expanded')) && !sheet ? insW : compact}px;` : ''}--nx-ins-w:${sheet ? insW : Math.max(insW, 480)}px`;
  const cls = `win ${p.light ? 'light ' : ''}${side ? 'side-open ' : ''}${u.deskOpen ? 'desk-open ' : ''}${wide ? 'nx-wide-desk ' : ''}${wide && sheet ? 'nx-sheet ' : ''}${focusMode ? 'nx-fws ' : ''}${rec.vowe ? '' : 'nx-novowe '}${W < 1300 ? 'nx-small ' : ''}in-call nx-win`;
  return (
    <DirectoryContext.Provider value={dir}>
      <MentionSources.Provider value={mention}>
      <SemanticsContext.Provider value={p.semantics ?? NO_SEMANTICS}>
        <div style={style} class={cls}>
          <Lights />
          {p.windowOverlay}
          <Chrome side={side} sideName="sidebar" desk={u.deskOpen} deskUnseen={!u.deskOpen && !!top} toggleSide={toggleSidebar} toggleDesk={() => p.ui.setState(u.deskOpen ? { deskOpen: false } : { deskOpen: true, depth: 'compact' })}
            nav={p.nav} call={{ looking: p.room.id, canvasShown: !focusMode && !(wide && sheet) }} actions={<>{p.callAction}{p.share ?? <div class="vm-share-anchor"><button type="button" data-share-anchor class="vm-sharebtn" onClick={() => p.act.invite()}>Invite</button></div>}{u.deskOpen ? <ExpandButton on={focusMode} toggle={() => p.act.depth(focusMode ? exitDepth(u) : 'focus')} /> : null}</>} />
          <aside class="sidebar vh-sb-host" aria-hidden={!side} inert={!side}>
            <ShellSidebar place={null} rooms={rooms} current={p.room.id} onRoom={p.onOpenRoom} onNew={(space) => p.onNewRoom(space)} foot={<AccountFoot />} />
          </aside>
          <main class="room">
            <div class="room-identity">
              <RoomTitle name={p.room.name} space={p.space ?? p.room.repo} onRename={p.onRename} />
              <div class="presence"><Who people={p.people} vowe={!!p.call && rec.vowe && u.vowe !== 'off'} ring={p.speaking ? { [p.speaking]: 'speaking' } : {}} /></div>
            </div>
            <Surface client={p.client} ui={p.ui} marks={p.marks} lit={p.lit} onAsk={rec.vowe ? p.onAsk : undefined} onScenario={p.onScenario} onCopies={p.onCopies}
              onComment={p.onComment} onMarks={p.onMarks} anchored={p.pins} reserve={p.call && u.cc ? 58 : 0} inCall={!!p.call}>
              {p.overlays}
              {p.call ? <CallBar c={p.call} /> : null}
            </Surface>
          </main>
          {wide && sheet ? <button type="button" class="nx-sheet-edge" aria-label="Back to the canvas" title="Back to the canvas · Esc" onClick={() => p.act.depth('compact')}><span>‹ Canvas</span></button> : null}
          {crumbs ? <FocusCrumbs room={p.room.name} crumbs={crumbs} rec={rec} act={p.act} back={() => p.act.depth(exitDepth(u))}
            agent={doing ? { name: n.agentName(), doing, away } : null} /> : null}
          <aside class="desk" aria-label="Where the room is" aria-hidden={!u.deskOpen}>
            {u.deskOpen && !sheet && !focusMode ? <div class="nx-split" role="separator" aria-orientation="vertical" aria-label="Resize the Desk" title="Drag to widen or narrow · double-click to switch" onPointerDown={startDrag} onDblClick={() => p.act.depth(depth === 'expanded' ? 'compact' : 'expanded')}><i></i></div> : null}
            <div class="desk-panel">
              {p.deskTop && !p.deskOverride && !focusMode ? p.deskTop : null}
              {p.deskOverride ? p.deskOverride : !p.deskStatus || p.deskStatus.state === 'ready' ? <Desk {...deskProps} /> : <DeskPending status={p.deskStatus} />}
            </div>
          </aside>
          {u.toast ? <div class="nx-toast" role="status"><span>{u.toast.text}</span>{u.toast.undo ? <button type="button" onClick={() => { u.toast!.undo!(); p.ui.setState({ toast: null }); }}>Undo</button> : null}</div> : null}
        </div>
      </SemanticsContext.Provider>
      </MentionSources.Provider>
    </DirectoryContext.Provider>
  );
}
