import { h } from '../../../vendor/preact.js';
import { useEffect, useState } from '../../../vendor/preact-hooks.js';
import type { Scene } from '../../../../shared/canvas/index.js';
import { useStore } from '../../../shared/store.js';
import { SceneGlimpse } from '../../canvas/SceneGlimpse.js';
import { callPresence } from '../../call/presence.js';
import type { RoomSummary } from '../../room/types.js';
import { STATUS_WORDS } from '../../work/status.js';
import type { WorkItem } from '../../../ui/pass2/types.js';
import { ago } from './time.js';

// Home's reading page with nothing selected: your rooms, the ongoing spaces the Inbox's items come from.
// The room with your call (else one with a call on, else one that needs you, else the one that moved last) is shown large with its
// canvas; the rest are rows with what's happening and the parts on their canvas. Everything is the room list
// Home already has, plus each room's current canvas view.

const QUIET = 7 * 86_400_000;

export interface YourRoomsProps {
  rooms: RoomSummary[];
  now: string;
  /** Items in Needs you, per room id (the same count the sidebar's Home shows, split by room). */
  needs: Record<string, number>;
  /** A room's current canvas view, or null when it has none (or can't be read). */
  scene(roomId: string): Promise<Scene | null>;
  onRoom(id: string): void;
  onJoin(id: string): void;
  /** Claude Code sessions in your repositories on this machine; null when they can't be read here. */
  work?: WorkItem[] | null;
  /** Rooms whose repository isn't cloned on this machine. */
  missing?: ReadonlySet<string>;
}

function useScenes(ids: string[], load: (id: string) => Promise<Scene | null>) {
  const [scenes, setScenes] = useState<Record<string, Scene | null>>({});
  const key = ids.join(',');
  useEffect(() => {
    let live = true;
    for (const id of ids) {
      if (id in scenes) continue;
      load(id).then((s) => s, () => null).then((s) => { if (live) setScenes((m) => ({ ...m, [id]: s })); });
    }
    return () => { live = false; };
  }, [key]);
  return scenes;
}

/** In place of Needs you when nothing needs you: which room has a call on, and how the others stand. */
export function RoomsQuiet({ rooms, now }: { rooms: RoomSummary[]; now: string }) {
  const live = rooms.find((r) => r.inCall.length > 0);
  const recent = rooms.filter((r) => r !== live && !(r.activityAt && Date.parse(now) - Date.parse(r.activityAt) > QUIET))
    .sort((a, b) => ((a.activityAt ?? '') < (b.activityAt ?? '') ? 1 : -1)).slice(0, 2);
  const state = (r: RoomSummary) => r.activity.replace(/\.$/, '').replace(/^(You|Nothing|No|A|An|The)\b/, (w) => w.toLowerCase());
  return (
    <p class="vi-quietline">
      {live ? `${live.name} has a call on. ` : null}
      {recent.length ? `${recent.map((r) => `${r.name}: ${state(r)}`).join('. ')}.` : live ? null : 'Your rooms are quiet.'}
    </p>
  );
}

export function YourRooms(p: YourRoomsProps) {
  const call = useStore(callPresence).call;
  const quiet = (r: RoomSummary) => !!r.activityAt && Date.parse(p.now) - Date.parse(r.activityAt) > QUIET;
  const at = (r: RoomSummary) => r.activityAt ?? '';
  const byRecent = [...p.rooms].sort((a, b) => (at(a) < at(b) ? 1 : -1));
  const lead = byRecent.find((r) => r.id === call?.roomId) ?? byRecent.find((r) => r.inCall.length > 0)
    ?? byRecent.find((r) => (p.needs[r.id] ?? 0) > 0) ?? byRecent.find((r) => !quiet(r)) ?? byRecent[0];
  const rest = byRecent.filter((r) => r !== lead);
  const ordered = [...rest.filter((r) => !quiet(r)), ...rest.filter(quiet)];
  const scenes = useScenes(byRecent.map((r) => r.id), p.scene);
  const quietN = p.rooms.filter(quiet).length;
  const parts = (id: string) => [...new Set((scenes[id]?.nodes ?? []).map((n) => n.name))].slice(0, 6);

  if (!lead) {
    return (
      <div class="vi-rooms">
        <h2>Your rooms</h2>
        <p class="vi-rooms-sub">None yet. A room keeps a canvas, its conversations, decisions and work: start one from the sidebar’s +.</p>
      </div>
    );
  }
  const mine = call?.roomId === lead.id;
  const others = lead.inCall.filter((x) => x.tone !== 'me').map((x) => x.name);
  const leadScene = scenes[lead.id];
  return (
    <div class="vi-rooms">
      <h2>Your rooms</h2>
      <p class="vi-rooms-sub">{p.rooms.length - quietN} ongoing{quietN ? ` · ${quietN} quiet` : ''} · each keeps its canvas, conversations, decisions and work</p>
      <div class="vi-lead">
        {leadScene ? <SceneGlimpse scene={leadScene} height={300} /> : <div class="vi-lead-blank">{leadScene === null ? 'The canvas fills in as the room talks.' : ''}</div>}
        <div class="vi-lead-cap">
          {lead.inCall.length ? <span class="vi-live" aria-hidden="true"></span> : null}
          <div class="vi-lead-txt">
            <b>{lead.name}</b>
            <span>{lead.inCall.length
              ? `${mine ? 'You’re in this call' : 'A call is on'}${others.length ? ` with ${others.join(', ')}` : ''}${leadScene ? ` · on ${leadScene.name}` : ''}`
              : lead.activity}{p.missing?.has(lead.id) ? <i class="vi-miss" title={`${lead.repo} isn’t cloned on this machine`}> · repository not on this machine</i> : null}</span>
          </div>
          {lead.inCall.length && !mine
            ? <button type="button" class="v-btn v-btn-ink v-btn-sm" onClick={() => p.onJoin(lead.id)}>Join the call</button>
            : <button type="button" class="v-btn v-btn-ink v-btn-sm" onClick={() => p.onRoom(lead.id)}>{mine ? 'Return to the room' : 'Open the room'}</button>}
        </div>
      </div>
      <div class="vi-roomlist">
        {ordered.map((r) => {
          const n = p.needs[r.id] ?? 0;
          const ps = parts(r.id);
          return (
            <button key={r.id} type="button" class="vi-roomrow" onClick={() => p.onRoom(r.id)}>
              <div>
                <div class="vi-roomrow-nm">{r.name}</div>
                <div class="vi-roomrow-st">{n ? <b>{n} need{n > 1 ? '' : 's'} you · </b> : null}{r.activity}{p.missing?.has(r.id) ? <i class="vi-miss" title={`${r.repo} isn’t cloned on this machine`}> · repository not on this machine</i> : null}</div>
                {ps.length ? <div class="vi-roomrow-parts">{ps.join(' · ')}</div> : null}
              </div>
              {r.activityAt ? <span class="vi-roomrow-ts">{ago(r.activityAt, p.now)}</span> : null}
            </button>
          );
        })}
      </div>
      {p.work ? <OngoingWork items={p.work} now={p.now} /> : null}
    </div>
  );
}

const WORK_TONE = { active: 'is-live', attention: 'is-signal', completed: '', unknown: '' } as const;

/** What Claude Code is doing in your repositories on this machine, newest first. */
function OngoingWork({ items, now }: { items: WorkItem[]; now: string }) {
  const at = (w: WorkItem) => w.lastActivityAt ?? '';
  const rows = [...items].sort((a, b) => (at(a) < at(b) ? 1 : -1)).slice(0, 5);
  return (
    <section class="vi-work" aria-label="Ongoing work on this machine">
      <div class="vi-work-h"><span>Ongoing work</span><em>on this machine</em></div>
      {rows.length ? rows.map((w) => (
        <div key={w.id} class="vi-work-row">
          <span class={`vi-work-dot ${WORK_TONE[w.status]}`} aria-hidden="true"></span>
          <div class="vi-work-main">
            <div class="vi-work-t">{w.title}</div>
            <div class="vi-work-m">{STATUS_WORDS[w.status]} · {w.agent} · {w.repository}{w.branch ? ` · ${w.branch}` : ''}</div>
          </div>
          {w.lastActivityAt ? <span class="vi-roomrow-ts">{ago(w.lastActivityAt, now)}</span> : null}
        </div>
      )) : <p class="vi-work-none">No Claude Code sessions in your repositories yet. Sessions you run in a room’s repository show here.</p>}
    </section>
  );
}
