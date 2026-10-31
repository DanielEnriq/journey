import { h, Fragment, type ComponentChildren } from '../../../vendor/preact.js';
import { useEffect, useRef, useState } from '../../../vendor/preact-hooks.js';
import { useLoaded } from '../../workspace/hooks.js';
import { nameFromGoal, UNTITLED, type RoomDataSource, type RoomWorkContext, type RoomWorkstream, type WorkstreamDataSource } from '../data/sources.js';
import { Icon } from '../../../ui/icons.js';
import { repoName } from '../../../ui/pass2/shell/sidebar-model.js';
import { Avatar } from '../../membership/primitives.js';
import type { RoomAccess } from '../../membership/model.js';
import { WorkContext, waitsOnYou } from './WorkContext.js';

// The room itself, at the top of its side panel: what it's for, the repositories it works in, its people, and
// the coding sessions shared with it, as a title and one line.

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
    <textarea ref={field} class="rh-goal goal-field" rows={1} placeholder="What are we figuring out?" aria-label="What this room is for" disabled={busy}
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

type Pop = 'repos' | 'people' | 'sessions' | null;

/**
 * The room at the top of its side panel: what it's for as the title, then one line of what it has. The repositories,
 * the people (a ring on whoever's here) and the coding sessions each open a popover with the full list, so the
 * Desk below keeps the column.
 */
export function RoomCards({ room, work, roomId, attachError, onJoin, people, access }: {
  room: RoomDataSource;
  work: WorkstreamDataSource;
  roomId: string;
  /** Why the room's repository couldn't be attached when it was made. */
  attachError?: string;
  /** Starts or joins the call (a session waiting on you can ask for it). */
  onJoin(): void;
  /** The room's people, managed in the People popover. */
  people?: ComponentChildren;
  /** Who's in the room, for the faces on the meta line. */
  access?: RoomAccess | null;
}) {
  const preview = useLoaded(() => room.preview(roomId), (fn) => room.subscribe(fn), roomId);
  const ctx = useLoaded(() => work.context(roomId), (fn) => room.subscribe(fn), roomId);
  const [openId, setOpen] = useState<string | null>(null);
  const [pop, setPop] = useState<Pop>(null);
  const box = useRef<HTMLDivElement>(null);
  // Leaving the room counts as a visit: the Inbox's "since you were last here" starts from then.
  useEffect(() => { setOpen(null); setPop(null); return () => room.visited(roomId); }, [roomId]);
  // A popover closes on Esc or a click outside the header.
  useEffect(() => {
    if (!pop) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setPop(null); } };
    const down = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('.v-menu, dialog, .vm-dialog')) setPop(null); };
    addEventListener('keydown', key, true);
    addEventListener('pointerdown', down, true);
    return () => { removeEventListener('keydown', key, true); removeEventListener('pointerdown', down, true); };
  }, [pop]);

  const p = preview.value;
  const sessions = sessionsSummary(ctx.value);
  const nSessions = ctx.value?.workstreams.filter((w) => w.visibility === 'room' || ctx.value!.unattached).length ?? 0;
  const repos = ctx.value?.repos?.map((r) => r.repo) ?? p?.room.repos ?? (p?.room.repo ? [p.room.repo] : []);
  const owner = (p?.room.role ?? 'owner') === 'owner';
  const members = access ? [...access.members].sort((a, b) => Number(a.presence === 'away') - Number(b.presence === 'away')) : [];
  const here = members.filter((m) => m.presence !== 'away').length;
  const toggle = (k: Pop) => setPop(pop === k ? null : k);
  const meta = (k: Exclude<Pop, null>, label: string, body: ComponentChildren) => (
    <button type="button" class={'rh-m' + (pop === k ? ' on' : '')} aria-expanded={pop === k} aria-haspopup="dialog" aria-label={label} onClick={() => toggle(k)}>{body}</button>
  );

  return (
    <div class="desk-cards rh" ref={box}>
      {p?.goal ? <h2 class="rh-goal" title={`${p.goal.by.tone === 'me' ? 'Your' : p.goal.by.name + '’s'} goal`}>{p.goal.text}</h2>
        : p && room.update && owner ? <GoalField onSave={(goal) => room.update!(roomId, p.room.name === UNTITLED ? { goal, name: nameFromGoal(goal) } : { goal })} />
        : null}
      <div class="rh-meta">
        {repos.length ? meta('repos', `${repos.length} ${repos.length === 1 ? 'repository' : 'repositories'}`,
          <><Icon name="branch" size={14} /><b>{repoName(repos[0])}</b>{repos.length > 1 ? <span>+{repos.length - 1}</span> : null}</>) : null}
        {members.length ? meta('people', `${members.length} people, ${here} here`,
          <span class="rh-faces">{members.slice(0, 5).map((m) => {
            const u = access!.users[m.userId];
            return <span key={m.userId} class={'rh-face' + (m.presence !== 'away' ? ' here' : '')}><Avatar user={u} size={20} /></span>;
          })}{members.length > 5 ? <span class="rh-more">+{members.length - 5}</span> : null}</span>) : null}
        {meta('sessions', 'Sessions', <><Icon name="terminal" size={14} />{nSessions ? `${nSessions} ${nSessions === 1 ? 'session' : 'sessions'}` : 'Sessions'}{sessions.needs ? <em class="rh-needs">{sessions.text?.split(' · ').find((x) => x.includes('need'))}</em> : null}</>)}
      </div>
      {pop ? (
        <div class="rh-pop" role="dialog" aria-label={{ repos: 'Repositories', people: 'People', sessions: 'Sessions' }[pop]}>
          {pop === 'repos' ? (
            <ul class="icard-repos">{repos.map((r) => <li key={r} title={r}><Icon name="branch" size={14} /><span>{repoName(r)}</span></li>)}</ul>
          ) : pop === 'people' ? people ?? null : (
            <WorkContext bare work={ctx} repo={p?.room.repo ?? null} openId={openId} setOpen={setOpen} onJoin={onJoin}
              attach={work.attach && ((id) => work.attach!(roomId, id))}
              detach={work.detach && ((id) => work.detach!(roomId, id))}
              transcript={work.transcript && ((id) => work.transcript!(roomId, id))}
              connect={room.repos && room.addRepo && room.attach ? {
                repos: room.repos, addRepo: room.addRepo, attach: (id) => room.attach!(roomId, id), error: attachError,
              } : undefined}
              addClone={room.addRepo && (async () => { await room.addRepo!(); })} />
          )}
        </div>
      ) : null}
    </div>
  );
}
