import { h, type ComponentChildren } from '../../../vendor/preact.js';
import { useEffect, useRef, useState } from '../../../vendor/preact-hooks.js';
import { useLoaded } from '../../workspace/hooks.js';
import { nameFromGoal, UNTITLED, type RoomDataSource, type RoomWorkContext, type RoomWorkstream, type WorkstreamDataSource } from '../data/sources.js';
import { Icon } from '../../../ui/icons.js';
import { repoName } from '../../../ui/pass2/shell/sidebar-model.js';
import { Card } from './Cards.js';
import { WorkContext, waitsOnYou } from './WorkContext.js';

// The room itself, at the top of its side panel: what it's for, the repositories it works in, its people, and
// the coding sessions shared with it. Folded, each card is one line, so the Desk below keeps the room.

/** What a new room is for, asked once in its own words: Return keeps it (and names an untitled room from it). */
function GoalField({ onSave }: { onSave(goal: string): Promise<void> }) {
  const field = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(false);
  const save = () => {
    const goal = field.current?.value.trim() ?? '';
    if (!goal || busy) return;
    setBusy(true);
    onSave(goal).catch(() => setBusy(false));
  };
  return (
    <textarea ref={field} class="icard-goal goal-field" rows={1} placeholder="What are we figuring out?" aria-label="What this room is for" disabled={busy}
      onInput={(e) => { const t = e.currentTarget; t.style.height = 'auto'; t.style.height = `${t.scrollHeight}px`; }}
      onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); } else if (e.key === 'Escape') e.currentTarget.blur(); }}
      onBlur={save} />
  );
}

// What the room's sessions are doing, in a few words: how many run, how many wait on you, how many on someone else.
function sessionsSummary(ctx: RoomWorkContext | null | undefined): { text?: string; needs: boolean } {
  const ws = ctx?.workstreams.filter((w) => w.visibility === 'room' || ctx.unattached) ?? [];
  if (!ws.length) return { needs: false };
  const count = (f: (w: RoomWorkstream) => boolean) => ws.filter(f).length;
  const running = count((w) => w.status === 'active');
  const yours = count((w) => w.status === 'attention' && waitsOnYou(w)), theirs = count((w) => w.status === 'attention' && !waitsOnYou(w));
  const parts = [running ? `${running} running` : '', yours ? `${yours} need${yours === 1 ? 's' : ''} you` : '', theirs ? `${theirs} waiting` : ''].filter(Boolean);
  return { text: parts.length ? parts.join(' · ') : String(ws.length), needs: yours > 0 };
}

export function RoomCards({ room, work, roomId, attachError, onJoin, people }: {
  room: RoomDataSource;
  work: WorkstreamDataSource;
  roomId: string;
  /** Why the room's repository couldn't be attached when it was made. */
  attachError?: string;
  /** Starts or joins the call (a session waiting on you can ask for it). */
  onJoin(): void;
  /** The room's people, under its repositories. */
  people?: ComponentChildren;
}) {
  const preview = useLoaded(() => room.preview(roomId), (fn) => room.subscribe(fn), roomId);
  const ctx = useLoaded(() => work.context(roomId), (fn) => room.subscribe(fn), roomId);
  const [openId, setOpen] = useState<string | null>(null);
  // Leaving the room counts as a visit: the Inbox's "since you were last here" starts from then.
  useEffect(() => { setOpen(null); return () => room.visited(roomId); }, [roomId]);

  const p = preview.value;
  const sessions = sessionsSummary(ctx.value);
  const repos = ctx.value?.repos?.map((r) => r.repo) ?? p?.room.repos ?? (p?.room.repo ? [p.room.repo] : []);
  const owner = (p?.room.role ?? 'owner') === 'owner';

  return (
    <div class="desk-cards">
      <Card id="room" title="Room" summary={repos.length > 1 ? `${repos.length} repositories` : repos.length ? repoName(repos[0]) : undefined}>
        {p?.goal ? <p class="icard-goal" title={`${p.goal.by.tone === 'me' ? 'Your' : p.goal.by.name + '’s'} goal`}>{p.goal.text}</p>
          : p && room.update && owner ? <GoalField onSave={(goal) => room.update!(roomId, p.room.name === UNTITLED ? { goal, name: nameFromGoal(goal) } : { goal })} />
          : null}
        {repos.length > 0 && (
          <ul class="icard-repos">
            {repos.map((r) => <li key={r} title={r}><Icon name="branch" size={14} /><span>{repoName(r)}</span></li>)}
          </ul>
        )}
        {people}
      </Card>
      <Card id="sessions" title="Sessions" summary={sessions.text} needs={sessions.needs}>
        <WorkContext bare work={ctx} repo={p?.room.repo ?? null} openId={openId} setOpen={setOpen} onJoin={onJoin}
          attach={work.attach && ((id) => work.attach!(roomId, id))}
          detach={work.detach && ((id) => work.detach!(roomId, id))}
          transcript={work.transcript && ((id) => work.transcript!(roomId, id))}
          connect={room.repos && room.addRepo && room.attach ? {
            repos: room.repos, addRepo: room.addRepo, attach: (id) => room.attach!(roomId, id), error: attachError,
          } : undefined}
          addClone={room.addRepo && (async () => { await room.addRepo!(); })} />
      </Card>
    </div>
  );
}
