import { h, Fragment, useEffect, useMemo, useState, useStore, Store, type CallControls, type CanvasClient, type ComponentChildren, type PersonRef, type RoomSummary } from '../journey.js';
import type { RoomAccess } from '../../membership/model.js';
import type { AskState, AskVowe } from '../../canvas/AskVowe.js';
import type { RoomRole, VoweRecord } from '../contracts/model.js';
import { capabilitiesOf, type VoweServices } from '../contracts/services.js';
import { names } from '../state/directory.js';
import { directoryOf, EMPTY_RECORD, mentionsAgent } from './people.js';

export { directoryOf, EMPTY_RECORD, mentionsAgent };
import { makeUi } from '../state/ui.js';
import { marksOf } from '../room/marks.js';
import { Pins } from '../room/Pins.js';
import { anchorPatch, useDeskHistory, useDeskKeys, useToastTimeout } from '../room/navigation.js';
import { pendingAnchor, takeAnchor } from '../../../shared/nav.js';
import { VoweRoom, type DeskStatus } from '../room/VoweRoom.js';
import { createDeskActions } from './actions.js';

// The Pass 3 room on a real Journey room: the record comes from VoweServices (load + record:changed), the
// canvas is the room's CanvasClient, the call is RoomScreen's LiveKit call, and people come from the room's
// access. Nothing here is scripted: an empty room shows the Desk's empty states, and anything the services
// can't do is null and shown as unavailable.


export interface RealRoomProps {
  roomId: string;
  room: Pick<RoomSummary, 'id' | 'name' | 'repo'>;
  rooms: RoomSummary[];
  services: VoweServices;
  client: CanvasClient;
  /** Asking Vowe by text and voice (features/canvas/AskVowe.ts); null when there's no model sign-in path. */
  asker: AskVowe | null;
  /** Records Vowe's answer to a new comment as its reply (RoomRecordSource.reply with the agent's kind). */
  agentReply(threadId: string, body: string): Promise<void>;
  access: RoomAccess | null;
  role: RoomRole | null;
  /** You, as the record names you (your cloud user id). */
  me: string;
  /** The call's controls while you're in it; null outside it. */
  call: CallControls | null;
  /** Start Call, Join or Leave, in the band. */
  callAction?: ComponentChildren;
  /** The room itself (what it's for, its repositories, people, sessions), above the Desk. */
  deskTop?: ComponentChildren;
  /** Renames the room from its title (owners only). */
  onRename?(name: string): Promise<void>;
  /** The Space the room is in, beside its name. */
  space?: string | null;
  /** Who's here and in the call, as the band draws them, and who's talking now (initials). */
  people: PersonRef[];
  speaking: string | null;
  inCall: number;
  /** Journey's call overlays: captions, Ask Vowe, notices, the call bar is drawn by the room. */
  overlays: ComponentChildren;
  /** Journey's Share control (button + ShareDialog), shown as Invite. */
  share: ComponentChildren;
  openShare(): void;
  /** Journey's People drill-in (members and roles), shown in the Desk while it's open. */
  peoplePanel?: ComponentChildren;
  /** Journey's New room sheet and toasts, drawn over the window. */
  windowOverlay?: ComponentChildren;
  light: boolean;
  onOpenRoom(id: string): void;
  onNewRoom(space?: string | null): void;
  onHome(): void;
}

/** Stands in for Ask Vowe's state when the room has no model sign-in path. */
const NO_ASK = new Store<Pick<AskState, 'reviewing' | 'error' | 'open'>>({ reviewing: null, error: null, open: false });

/** The services, with Vowe answering threads that @mention it. Its answer is a separate, attributed write. */
function withMentions(s: VoweServices, roomId: string, rec: () => VoweRecord, agentName: () => string, asker: AskVowe | null, agentReply: (threadId: string, body: string) => Promise<void>, notice: (text: string) => void): VoweServices {
  const ask = (threadId: string, body: string) => {
    if (!mentionsAgent(body, agentName())) return;
    if (!rec().vowe) { notice(`${agentName()} is off in this room, so it won’t answer. Your message is saved.`); return; }
    if (!asker) { notice(`${agentName()} can’t answer from this computer: there’s no model sign-in. Your message is saved.`); return; }
    if (asker.busy) { notice(`${agentName()} is answering something else. Mention it again in a moment.`); return; }
    const t = rec().threads.find((x) => x.id === threadId);
    const on = t && t.about.kind === 'part' && t.about.id !== 'canvas' ? { component: t.about.id, name: t.about.name } : null;
    asker.feedback(threadId, body, on, (said) => agentReply(threadId, said));
  };
  return {
    ...s,
    threads: {
      ...s.threads,
      create: async (r, t) => { const res = await s.threads.create(r, t); if (res.ok && r === roomId) ask(res.value.id, t.body); return res; },
      reply: async (r, id, body) => { const res = await s.threads.reply(r, id, body); if (res.ok && r === roomId) ask(id, body); return res; },
    },
  };
}

/** The record, loaded and kept current; failures are kept so the Desk can say so and retry. */
function useRecord(services: VoweServices, roomId: string, members: string) {
  const store = useMemo(() => new Store<VoweRecord>(EMPTY_RECORD), [roomId]);
  const [status, setStatus] = useState<{ state: 'loading' } | { state: 'ready' } | { state: 'failed'; error: string }>({ state: 'loading' });
  const [tries, setTries] = useState(0);
  useEffect(() => {
    let live = true;
    const load = async () => {
      const res = await services.record.load(roomId);
      if (!live) return;
      if (res.ok) { store.setState(res.value); setStatus({ state: 'ready' }); }
      else setStatus((s) => (s.state === 'ready' ? s : { state: 'failed', error: res.error.message || res.error.code }));
    };
    void load();
    const off = services.record.subscribe(roomId, () => { void load(); });
    return () => { live = false; off(); };
  // Joining, leaving and role changes are membership events, not record:changed: re-read on those too.
  }, [services, roomId, tries, members]);
  return { store, status, retry: () => { setStatus({ state: 'loading' }); setTries((n) => n + 1); } };
}

export function RealRoom(p: RealRoomProps) {
  const ui = useMemo(makeUi, [p.roomId]);
  const u = useStore(ui);
  const members = (p.access?.members ?? []).map((m) => `${m.userId}:${m.role}`).sort().join(',');
  const { store: record, status, retry } = useRecord(p.services, p.roomId, members);
  const rec = useStore(record);
  const directory = useMemo(() => directoryOf(p.me, p.access, rec.agentName, rec.members), [p.me, p.access, rec.agentName, rec.members]);
  const [lit, setLit] = useState<string[]>([]);
  /** A comment placed on the canvas but not yet written. */
  const [draft, setDraft] = useState<{ x: number; y: number; on: { component: string; name: string } | null } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // Vowe answering a thread runs out of sight (the Ask panel stays closed): say that it's replying, and
  // if it couldn't, why, instead of leaving the mention unanswered.
  const ask = useStore<Pick<AskState, 'reviewing' | 'error' | 'open'>>(p.asker?.store ?? NO_ASK);
  const [wasReviewing, setWasReviewing] = useState(false);
  const [askFailed, setAskFailed] = useState<string | null>(null);
  useEffect(() => {
    if (ask.reviewing) { setWasReviewing(true); setAskFailed(null); return; }
    if (wasReviewing) { setWasReviewing(false); if (ask.error && !ask.open) setAskFailed(`${names(directory).agentName()} couldn’t answer: ${ask.error.message}`); }
  }, [ask.reviewing, ask.error]);
  // Vowe joins a thread when someone @mentions it (by its displayed name or "vowe"): it answers in that
  // thread on this person's model sign-in, attributed to the agent. Nothing else in the Desk calls the model.
  const services = useMemo(() => withMentions(p.services, p.roomId, () => record.state, () => names(directoryOf(p.me, p.access, record.state.agentName, record.state.members)).agentName(), p.asker, p.agentReply, setAskFailed), [p.services, p.roomId, p.asker]);
  const act = useMemo(() => createDeskActions({
    roomId: p.roomId, ui, record, services, names: names(directory), light: (parts) => setLit(parts ?? []),
    invite: p.openShare,
    // main/window.ts sends https window opens to the system browser.
    openExternal: (url) => { window.open(url, '_blank', 'noopener'); },
    selection: () => {
      const sel = ui.state.sel;
      if (sel.length !== 1 || 'step' in sel[0]) return null;
      const id = sel[0].component;
      return { id, name: p.client.state.doc.components[id]?.name ?? id };
    },
  }), [p.roomId, services, record, directory]);
  const nav = useDeskHistory(ui, u, () => record.state);
  // People opens in the Desk's column: make sure it's showing, and not under full screen.
  useEffect(() => { if (p.peoplePanel) ui.setState({ deskOpen: true, depth: ui.state.depth === 'focus' ? 'compact' : ui.state.depth }); }, [!!p.peoplePanel]);
  useDeskKeys(ui, act, nav);
  // Landing somewhere exact from outside the room (an Inbox item): applied once the record is here, and
  // again whenever a new anchor for this room arrives, even while the room is kept hidden for its call.
  const anchorNonce = useStore(pendingAnchor).nonce;
  useEffect(() => {
    if (status.state !== 'ready') return;
    const a = takeAnchor(p.roomId);
    if (!a) return;
    ui.setState(anchorPatch(a, ui.state));
    if (!a.parts?.length) return;
    setLit(a.parts);
    const t = setTimeout(() => setLit([]), 1600);
    return () => clearTimeout(t);
  }, [status.state, anchorNonce, p.roomId]);
  useToastTimeout(ui, u);
  // Opening a thread lights what it's about on the canvas for a moment.
  useEffect(() => {
    if (!u.flash?.startsWith('thread:')) return;
    const t = rec.threads.find((x) => x.id === u.flash!.slice(7));
    if (t?.about.kind === 'part') { setLit([t.about.id]); const id = setTimeout(() => setLit([]), 1600); return () => clearTimeout(id); }
  }, [u.flash]);

  const saveDraft = async (body: string) => {
    const d = draft;
    const text = body.trim();
    if (!d || !text) return;
    const about = d.on ? { kind: 'part' as const, id: d.on.component, name: d.on.name } : { kind: 'part' as const, id: 'canvas', name: 'Canvas' };
    const res = await p.services.threads.create(p.roomId, { about, body: text, at: { x: d.x, y: d.y } });
    if (!res.ok) { setFailed(res.error.message || 'That comment wasn’t saved.'); return; }
    setDraft(null);
    setFailed(null);
    // Vowe answers each new comment in its thread, on this person's model sign-in (as in Journey's call).
    p.asker?.feedback(res.value.id, text, d.on, (said) => p.agentReply(res.value.id, said));
  };

  const pins = (place: (x: number, y: number) => { x: number; y: number }, width: number, partRect: (component: string) => number[] | null) => (
    <>
      <Pins rec={rec} place={place} width={width} partRect={partRect} hidden={u.sel.length > 0} open={(id) => act.thread(id)} />
      {draft ? (() => { const q = place(draft.x, draft.y); return (
        <div class="pin nx-draft-pin" style={`transform: translate(${q.x - 10}px, ${q.y - 20}px)`}>
          <span class="head">{directory.people[p.me]?.initials ?? 'Y'}</span>
          <label style="display:flex"><span class="sr">Comment{draft.on ? ` on ${draft.on.name}` : ''}</span>
            <input type="text" autoFocus placeholder={draft.on ? `Comment on ${draft.on.name}, then Enter` : 'Add a comment, then Enter'}
              onKeyDown={(e) => { if (e.key === 'Enter') void saveDraft((e.currentTarget as HTMLInputElement).value); if (e.key === 'Escape') setDraft(null); }} />
          </label>
          <button class="pin-x" type="button" aria-label="Discard comment" title="Discard" onClick={() => setDraft(null)}>×</button>
        </div>
      ); })() : null}
    </>
  );

  const n = names(directory);
  const speaker = p.speaking;
  const here = p.access ? p.access.members.filter((m) => m.presence !== 'away').length : p.people.length;
  const hereLine = p.inCall ? `${here} here · ${p.inCall} on the call` : `${here} here`;
  const deskStatus: DeskStatus = status.state === 'ready' ? { state: 'ready' } : status.state === 'loading' ? { state: 'loading' } : { state: 'failed', error: status.error, retry };
  const role: RoomRole = p.role ?? 'viewer';
  const one = (comp: string) => ui.setState({ sel: [{ component: comp }], deskOpen: true, focusOn: true, tab: 'discuss', fsec: 'discuss', inspect: null });

  return (
    <VoweRoom room={p.room} rooms={p.rooms} onOpenRoom={p.onOpenRoom} onNewRoom={p.onNewRoom}
      client={p.client} record={record} directory={directory} role={role} capabilities={capabilitiesOf(services)}
      ui={ui} act={act} marks={marksOf(rec)} lit={lit} call={p.call} callAction={p.callAction} deskTop={p.deskTop} onRename={p.onRename} space={p.space} people={p.people} speaking={speaker} hereLine={hereLine} nav={nav}
      light={p.light} share={p.share} deskStatus={deskStatus} windowOverlay={p.windowOverlay} deskOverride={p.peoplePanel}
      overlays={<>{p.overlays}{ask.reviewing ? <div class="receipt" role="status"><span class="dot"></span><span>{n.agentName()} is replying in the thread…</span></div> : null}
      {askFailed ? <div class="receipt dropped" role="alert"><span class="dot needs"></span><span>{askFailed}</span><button class="mini ghost" type="button" onClick={() => setAskFailed(null)}>Dismiss</button></div> : null}
      {failed ? <div class="receipt dropped" role="alert"><span class="dot needs"></span><span>Not saved: {failed}</span><button class="mini ghost" type="button" onClick={() => setFailed(null)}>Dismiss</button></div> : null}</>}
      pins={pins}
      onAsk={(about) => p.asker?.open({ selected: about.components, circled: [], names: about.names })}
      onScenario={(component, s) => { void p.client.run('show_view', s.view === 'concurrency' ? { view: 'concurrency', focus: component, instances: 2 } : { view: s.view, focus: component }); }}
      onComment={(x, y, on) => setDraft({ x, y, on })}
      onMarks={one}
    />
  );
}
