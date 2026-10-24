import { Fragment, h, type ComponentChildren } from '../../../vendor/preact.js';
import { useEffect, useState } from '../../../vendor/preact-hooks.js';
import { Store, useStore } from '../../../shared/store.js';
import { ago } from '../../../shared/time.js';
import type { CallSession } from '../../call/session.js';
import { useLoaded } from '../../workspace/hooks.js';
import type { RoomController } from '../controller.js';
import type { RoomDataSource, RoomEvent, RoomPreview as Preview, WorkstreamDataSource } from '../data/sources.js';
import { listNames, Who } from '../shell.js';
import { Glimpse } from './Glimpse.js';
import { WorkContext } from './WorkContext.js';

// A room from outside its call: what it is for, who is talking in it, what changed, what waits on
// someone, and the coding work behind it. It answers "do I want to join?"; the canvas itself only
// opens in the call.

type Sources = { room: RoomDataSource; work: WorkstreamDataSource };
const NO_CANVAS = new Store({});

function EventRow({ e }: { e: RoomEvent }) {
  return (
    <li class={e.tone ? 'ev ' + e.tone : 'ev'}>
      <span class={'dot' + (e.tone === 'needs' ? ' needs' : e.tone === 'pass' ? ' live' : '')}></span>
      <span class="et">{e.text}</span>
      <span class="when">{ago(e.at)}</span>
    </li>
  );
}

function CallCard({ p, session, onJoin, sheet }: { p: Preview; session: CallSession; onJoin(): void; sheet?: ComponentChildren }) {
  const cs = useStore(session.store);
  const mine = cs.roomId === p.room.id;
  const connecting = mine && cs.status === 'connecting', failed = mine && cs.status === 'failed';
  const others = p.room.inCall.filter((x) => x.tone !== 'me');
  const live = others.length > 0;
  return (
    <div class={'callcard' + (live ? ' live' : '')}>
      <div class="cc-who">
        {live ? <Who people={others} vowe /> : <span class="orb small" title="Vowe"></span>}
        <div class="cc-txt">
          <b>{live ? `${listNames(others.map((x) => x.name))} in the call` : 'No one is in the call'}</b>
          <span>{live ? 'Vowe is with them. Join to see the canvas and talk it through.' : 'Start one to open the canvas. Vowe joins every call.'}</span>
        </div>
      </div>
      <div class="cc-act vm-prejoin-anchor">
        {sheet && <div class="vm-prejoin-pop">{sheet}</div>}
        <button class="cta" type="button" disabled={connecting} aria-expanded={sheet ? true : undefined} onClick={onJoin}>
          {connecting ? <><span class="spinlet"></span>Connecting…</> : live ? 'Join call' : 'Start call'}
        </button>
        <span class="cc-fine">{failed ? <span class="err">{cs.error}</span> : 'Your microphone stays off until you turn it on.'}</span>
      </div>
    </div>
  );
}

export function RoomPreview({ sources, roomId, session, canvas, attachError, onJoin: join, joinSheet, people }: {
  sources: Sources;
  roomId: string;
  session: CallSession;
  /** The room's canvas, if it has one, for the still of its last view. */
  canvas: RoomController | null;
  /** Why the room's repository couldn't be attached when it was made. */
  attachError?: string;
  onJoin(): void;
  /** How to join, chosen before joining (muted or talking); without it, joining is immediate. */
  joinSheet?(close: () => void): ComponentChildren;
  /** The room's people, at the top of the side column. */
  people?: ComponentChildren;
}) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const onJoin = joinSheet ? () => setSheetOpen(true) : join;
  const { room, work } = sources;
  const preview = useLoaded(() => room.preview(roomId), (fn) => room.subscribe(fn), roomId);
  const ctx = useLoaded(() => work.context(roomId), (fn) => room.subscribe(fn), roomId);
  const [openId, setOpen] = useState<string | null>(null);
  const [sinceShown, setSinceShown] = useState(true);
  useStore<object>(canvas?.store ?? NO_CANVAS);
  // Leaving the preview counts as a visit: next time, "since you were last here" starts from now.
  useEffect(() => { setOpen(null); setSinceShown(true); return () => room.visited(roomId); }, [roomId]);

  const p = preview.value;
  if (!p) {
    return (
      <section class="lobby" aria-busy={preview.state === 'loading'}>
        <div class="lobby-in">{preview.state === 'failed' && <p class="wnote">Couldn’t open this room: {preview.error}</p>}</div>
      </section>
    );
  }
  const inspect = (id?: string) => { if (id) setOpen(id); document.getElementById('work')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };

  return (
    <section class="lobby" aria-label={`${p.room.name}, outside the call`}>
      <div class="lobby-in">
        <div class="lobby-main">
          <div class="lhead">
            <span class="eyebrow">{p.room.repo ?? 'No repository'}</span>
            {p.goal ? (
              <>
                <h2 class="goal-line">{p.goal.text}</h2>
                <span class="goal-by"><span class={'mav' + (p.goal.by.tone === 'me' ? '' : ' ' + p.goal.by.tone)}>{p.goal.by.initials}</span>{p.goal.by.tone === 'me' ? 'Your' : p.goal.by.name + '’s'} goal for this room</span>
              </>
            ) : (
              <h2 class="goal-line quiet">No goal written down yet. The first call usually finds one.</h2>
            )}
          </div>

          <CallCard p={p} session={session} onJoin={sheetOpen ? () => setSheetOpen(false) : onJoin} sheet={sheetOpen && joinSheet ? joinSheet(() => setSheetOpen(false)) : undefined} />

          {sinceShown && p.since.length > 0 && (
            <div class="since" role="status">
              <b>Since you were last here</b>
              <ul>{p.since.map((e) => <li key={e.id}><span class={'dot' + (e.tone === 'needs' ? ' needs' : e.tone === 'pass' ? ' live' : e.who ? ' ask' : '')}></span><span>{e.text}</span></li>)}</ul>
              <div style="display:flex;gap:8px;justify-content:flex-end">
                <button class="mini ghost" type="button" onClick={() => setSinceShown(false)}>Dismiss</button>
              </div>
            </div>
          )}

          <div class="glimpse">
            <div class="gl-head">
              <span class="rk">Last shared view</span>
              {p.lastView && <span class="gl-meta"><b>{p.lastView.name}</b> · {p.lastView.by ? (p.lastView.by.tone === 'me' ? 'you' : p.lastView.by.name) + ' · ' : ''}{ago(p.lastView.at)}</span>}
            </div>
            {p.lastView && canvas ? (
              <>
                <Glimpse ctrl={canvas} />
                <span class="gl-q">{p.lastView.question}</span>
              </>
            ) : (
              <div class="gl-empty">Nothing has been drawn here yet. Vowe draws on the shared canvas once the room starts talking in a call.</div>
            )}
          </div>

          {p.recent.length > 0 && (
            <div class="rsec">
              <span class="rk">Recently</span>
              <ul class="evlist">{p.recent.map((e) => <EventRow key={e.id} e={e} />)}</ul>
            </div>
          )}
        </div>

        <div class="lobby-side" id="work">
          {people}
          {p.attention.length > 0 && (
            <div class="rsec">
              <span class="rk">Needs you<span>{p.attention.length}</span></span>
              {p.attention.map((a) => (
                <div key={a.id} class="needcard">
                  <b><span class="dot needs"></span>{a.text}</b>
                  <p>{a.detail}</p>
                  <span class="acts">
                    <button class="mini strong" type="button" onClick={onJoin}>{p.room.inCall.some((x) => x.tone !== 'me') ? 'Join the call' : 'Start a call'}</button>
                    {a.streamId && <button class="mini ghost" type="button" onClick={() => inspect(a.streamId)}>Inspect the work</button>}
                  </span>
                </div>
              ))}
            </div>
          )}
          <WorkContext work={ctx} repo={p.room.repo} openId={openId} setOpen={setOpen} onJoin={onJoin}
            share={work.share && ((id) => { void work.share!(roomId, id); })}
            transcript={work.transcript && ((id) => work.transcript!(roomId, id))}
            connect={room.repos && room.addRepo && room.attach ? {
              repos: room.repos, addRepo: room.addRepo, attach: (id) => room.attach!(roomId, id), error: attachError,
            } : undefined}
            addClone={room.addRepo && (async () => { await room.addRepo!(); })} />
        </div>
      </div>
    </section>
  );
}
