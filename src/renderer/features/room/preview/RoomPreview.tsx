import { Fragment, h, type ComponentChildren } from '../../../vendor/preact.js';
import { useEffect, useState } from '../../../vendor/preact-hooks.js';
import { useStore } from '../../../shared/store.js';
import { ago } from '../../../shared/time.js';
import type { CallSession } from '../../call/session.js';
import { useLoaded } from '../../workspace/hooks.js';
import type { RoomDataSource, RoomEvent, WorkstreamDataSource } from '../data/sources.js';
import type { RoomSummary } from '../types.js';
import { Icon } from '../../../ui/icons.js';
import { listNames, Who } from '../shell.js';
import { SceneGlimpse } from '../../canvas/SceneGlimpse.js';
import { WorkContext } from './WorkContext.js';
import { pendingAnchor } from '../../../shared/nav.js';

// A room from outside its call, laid out the way a Mac window would: the call is an action, so it sits in the
// toolbar (who's there, and a phone); the page is the room itself (its goal, what waits on you, where the
// canvas was left); and what's been going on (the work behind it, its history) is in an inspector on the right.
// It answers "do I want to join?"; the canvas itself only opens in the call.

type Sources = { room: RoomDataSource; work: WorkstreamDataSource };

function EventRow({ e }: { e: RoomEvent }) {
  return (
    <li class={e.tone ? 'ev ' + e.tone : 'ev'}>
      <span class="et">{e.text}</span>
      <span class="when">{ago(e.at)}</span>
    </li>
  );
}

const MIC_NOTE = 'Your microphone stays off until you turn it on.';

/** The call, in the toolbar: who's in it (Vowe last, since it joins every call) and a phone to start or join it. */
export function CallButton({ room, session, onJoin, sheet }: { room: RoomSummary; session: CallSession; onJoin(): void; sheet?: ComponentChildren }) {
  const cs = useStore(session.store);
  const connecting = cs.roomId === room.id && cs.status === 'connecting';
  const others = room.inCall.filter((x) => x.tone !== 'me');
  const live = others.length > 0;
  const tip = live ? `Join ${listNames(others.map((x) => x.name))} in the call · ${MIC_NOTE}` : `Start a call · Vowe joins every call. ${MIC_NOTE}`;
  return (
    <div class="tb-call vm-prejoin-anchor">
      {live ? <Who people={others} vowe /> : null}
      <button class={'tb-callbtn' + (live ? ' live' : '')} type="button" disabled={connecting} aria-label={live ? 'Join the call' : 'Start a call'}
        data-tip={sheet || connecting ? undefined : tip} data-tip-end="" aria-expanded={sheet ? true : undefined} onClick={onJoin}>
        {connecting ? <span class="spinlet"></span> : <Icon name="phone" />}
        {live ? <span>{connecting ? 'Joining…' : 'Join'}</span> : connecting ? <span>Connecting…</span> : null}
      </button>
      {sheet && <div class="vm-prejoin-pop">{sheet}</div>}
    </div>
  );
}

/** What the toolbar's call can't say: that it failed, or where joining will land. */
function CallNote({ roomId, session }: { roomId: string; session: CallSession }) {
  const cs = useStore(session.store);
  const failed = cs.roomId === roomId && cs.status === 'failed';
  // Where an Inbox item asked to land: the Desk only exists in a call, so it waits here until you join.
  const pending = useStore(pendingAnchor).anchor;
  const anchor = pending?.roomId === roomId ? pending : null;
  if (failed) return <p class="lnote err" role="alert"><Icon name="warn" size={14} />Couldn’t join the call: {cs.error}</p>;
  if (!anchor) return null;
  return (
    <p class="lnote"><Icon name="info" size={14} /><span>Joining the call opens <b>{anchor.label}</b></span>
      <button class="linkish" type="button" onClick={() => pendingAnchor.setState({ anchor: null })}>Not now</button></p>
  );
}

export function RoomPreview({ sources, roomId, session, attachError, onJoin, inspector = true, people }: {
  sources: Sources;
  roomId: string;
  session: CallSession;
  /** Why the room's repository couldn't be attached when it was made. */
  attachError?: string;
  /** Starts or joins the call (through the join sheet, where there is one). */
  onJoin(): void;
  /** Whether the inspector (the room's people, work and history) is shown. */
  inspector?: boolean;
  /** The room's people, at the top of the inspector. */
  people?: ComponentChildren;
}) {
  const { room, work } = sources;
  const preview = useLoaded(() => room.preview(roomId), (fn) => room.subscribe(fn), roomId);
  const ctx = useLoaded(() => work.context(roomId), (fn) => room.subscribe(fn), roomId);
  const [openId, setOpen] = useState<string | null>(null);
  const [sinceShown, setSinceShown] = useState(true);
  // Leaving the preview counts as a visit: next time, "since you were last here" starts from now.
  useEffect(() => { setOpen(null); setSinceShown(true); return () => room.visited(roomId); }, [roomId]);

  const p = preview.value;
  if (!p) {
    return (
      <section class="lobby" aria-busy={preview.state === 'loading'}>
        <div class="lobby-main"><div class="lobby-col">{preview.state === 'failed' && <p class="wnote">Couldn’t open this room: {preview.error}</p>}</div></div>
      </section>
    );
  }
  const inspect = (id?: string) => { if (id) setOpen(id); document.getElementById('work')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  const live = p.room.inCall.some((x) => x.tone !== 'me');

  return (
    <section class={'lobby' + (inspector ? '' : ' no-inspector')} aria-label={`${p.room.name}, outside the call`}>
      <div class="lobby-main">
        <div class="lobby-col">
          <div class="lhead">
            {p.goal ? (
              <>
                <h2 class="goal-line">{p.goal.text}</h2>
                <span class="goal-by"><span class={'mav' + (p.goal.by.tone === 'me' ? '' : ' ' + p.goal.by.tone)}>{p.goal.by.initials}</span>{p.goal.by.tone === 'me' ? 'Your' : p.goal.by.name + '’s'} goal</span>
              </>
            ) : (
              <h2 class="goal-line quiet">No goal written down yet. The first call usually finds one.</h2>
            )}
          </div>

          <CallNote roomId={roomId} session={session} />

          {sinceShown && p.since.length > 0 && (
            <div class="since" role="status">
              <b>Since you were last here</b>
              <ul>{p.since.map((e) => <li key={e.id}><span class={'dot' + (e.tone === 'needs' ? ' needs' : e.tone === 'pass' ? ' live' : e.who ? ' ask' : '')}></span><span>{e.text}</span></li>)}</ul>
              <div style="display:flex;gap:8px;justify-content:flex-end">
                <button class="mini ghost" type="button" onClick={() => setSinceShown(false)}>Dismiss</button>
              </div>
            </div>
          )}

          {p.attention.length > 0 && (
            <div class="lsec">
              <span class="lk">Needs you</span>
              <ul class="needlist">
                {p.attention.map((a) => (
                  <li key={a.id} class="needrow">
                    <span class="dot needs"></span>
                    <span class="nr-txt"><b>{a.text}</b><span>{a.detail}</span></span>
                    <span class="nr-acts">
                      {a.streamId && <button class="mini ghost" type="button" onClick={() => inspect(a.streamId)}>Inspect</button>}
                      <button class="mini" type="button" onClick={onJoin}>{live ? 'Join the call' : 'Open in call'}</button>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div class="lsec glimpse">
            <span class="lk">Where the canvas was left</span>
            {p.lastView?.scene ? (
              <>
                <SceneGlimpse scene={p.lastView.scene} />
                <span class="gl-cap"><b>{p.lastView.name}</b>{p.lastView.question ? <> · {p.lastView.question}</> : null}
                  <span class="gl-meta">{p.lastView.by ? (p.lastView.by.tone === 'me' ? 'You' : p.lastView.by.name) + ', ' : ''}{ago(p.lastView.at)}</span></span>
              </>
            ) : (
              <div class="gl-empty">Nothing has been drawn here yet. Vowe draws on the shared canvas once the room starts talking in a call.</div>
            )}
          </div>
        </div>
      </div>

      {inspector && (
        <aside class="lobby-side" id="work" aria-label="Inspector">
          {people}
          <WorkContext work={ctx} repo={p.room.repo} openId={openId} setOpen={setOpen} onJoin={onJoin}
            share={work.share && ((id) => { void work.share!(roomId, id); })}
            transcript={work.transcript && ((id) => work.transcript!(roomId, id))}
            connect={room.repos && room.addRepo && room.attach ? {
              repos: room.repos, addRepo: room.addRepo, attach: (id) => room.attach!(roomId, id), error: attachError,
            } : undefined}
            addClone={room.addRepo && (async () => { await room.addRepo!(); })} />
          {p.recent.length > 0 && (
            <div class="rsec">
              <span class="rk">Activity</span>
              <ul class="evlist">{p.recent.map((e) => <EventRow key={e.id} e={e} />)}</ul>
            </div>
          )}
        </aside>
      )}
    </section>
  );
}
