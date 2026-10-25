// Source: vowe-home-pass2.zip (approved Claude Design package, Pass 2), imports adapted to the vendored Preact.
/**
 * Home once you have rooms. It leads with what needs you, then your rooms, then
 * the work and decisions around them. Every section maps to Journey data
 * (INTEGRATION.md §3). A section the build can't fill is left out (`null`); a
 * section with nothing in it says so plainly.
 */
import { h } from '../../../vendor/preact.js';
import { AvatarStack, Badge, Button, Dot, Skeleton } from '../../components.js';
import { Icon } from '../../icons.js';

import { ago, CanvasThumb, RepoChip } from '../common.js';
import { STATUS_WORDS } from '../../../features/work/status.js';
import type { InviteKey } from '../../../../shared/api.js';
import { JoinByLink } from '../invites/JoinByLink.js';
import type { DecisionItem, LocalRepoView, MissingRepoView, NeedItem, RoomCard, WorkItem } from '../types.js';
import { Composer, type ComposerProps } from './Composer.js';

export interface HomeReturningProps {
  firstName: string;
  /** null while the rooms are read the first time. */
  rooms: RoomCard[] | null;
  needs: NeedItem[];
  /** Claude Code workstreams in repositories on this machine; null hides the section. */
  work: WorkItem[] | null;
  /** The decision each room is working on; null hides the section. */
  decisions: DecisionItem[] | null;
  repos: LocalRepoView[] | null;
  missing: MissingRepoView[];
  composer: Omit<ComposerProps, 'tries'>;
  notice?: string | null;
  onOpenRoom: (id: string) => void;
  /** Opens an invite; absent in the demo, which hides the link field. */
  onOpenInvite?: (key: InviteKey) => void;
  onNewRoom: () => void;
  onSeeRooms: () => void;
  onSeeProjects: () => void;
  onAddRepo?: () => void;
  now?: number;
}

function hour(d = new Date()) {
  const h = d.getHours();
  return h < 12 ? 'Morning' : h < 18 ? 'Afternoon' : 'Evening';
}

export function HomeReturning(p: HomeReturningProps) {
  const n = p.needs.length;
  return (
    <div class="vh-page vh-ret">
      <header class="vh-ret-head vh-enter">
        <div>
          <div class="vh-eyebrow">Home</div>
          <h1>{hour(p.now ? new Date(p.now) : undefined)}, {p.firstName}.<em>{n ? ` ${n === 1 ? 'One thing needs' : `${n} things need`} you.` : ' Nothing needs you.'}</em></h1>
        </div>
        <div class="vh-ret-acts">
          <Button variant="ink" icon="plus" onClick={p.onNewRoom}>New room</Button>
        </div>
      </header>
      {p.notice ? <p class="vh-notice" role="alert"><Icon name="warn" size={14} />{p.notice}</p> : null}

      <div class="vh-ret-grid">
        <div class="vh-col">
          {n ? (
            <section>
              <div class="vh-sec-h"><span class="v-label">Needs you</span></div>
              <Needs items={p.needs} onOpenRoom={p.onOpenRoom} onOpenInvite={p.onOpenInvite ?? (() => {})} now={p.now} />
            </section>
          ) : null}

          <section>
            <div class="vh-sec-h"><span class="v-label">Your rooms</span><button type="button" class="v-link" onClick={p.onSeeRooms}>All rooms</button></div>
            {p.rooms === null ? (
              <div class="vh-rooms" aria-busy="true">{[0, 1, 2].map((i) => <div key={i} class="vh-room is-skel"><div class="vh-room-cv"><CanvasThumb preview={{ status: 'loading' }} /></div><div class="vh-room-body"><Skeleton width="60%" height={16} /><Skeleton width="85%" /></div></div>)}</div>
            ) : (
              <div class="vh-rooms vh-stagger">{p.rooms.slice(0, 6).map((r) => <RoomTile key={r.id} room={r} onOpen={() => p.onOpenRoom(r.id)} now={p.now} />)}</div>
            )}
          </section>

          <section>
            <div class="vh-sec-h"><span class="v-label">Start another room</span></div>
            <Composer {...p.composer} primary={false} placeholder="A change, a bug, a system…" />
          </section>
        </div>

        <aside class="vh-col vh-col-side">
          {p.onOpenInvite ? (
            <section>
              <div class="vh-sec-h"><span class="v-label">Join with a link</span></div>
              <JoinByLink onOpen={p.onOpenInvite} compact />
            </section>
          ) : null}

          {p.work ? (
            <section>
              <div class="vh-sec-h"><span class="v-label">Ongoing work</span><span class="vh-sec-note">on this machine</span></div>
              {p.work.length ? <Work items={p.work} now={p.now} /> : <p class="vh-empty">No Claude Code sessions in your repositories yet. Sessions you run in a room’s repository show here.</p>}
            </section>
          ) : null}

          {p.decisions?.length ? (
            <section>
              <div class="vh-sec-h"><span class="v-label">Decisions</span></div>
              <div class="vh-work">
                {p.decisions.slice(0, 4).map((d) => (
                  <button key={d.id} type="button" class="vh-work-row" onClick={() => p.onOpenRoom(d.roomId)}>
                    <span class="vh-work-top"><Badge tone={d.agreed ? 'success' : 'proposed'}>{d.agreed ? 'Agreed' : 'Proposed'} · v{d.version}</Badge><span class="v-meta">{d.roomName}</span></span>
                    <span class="vh-dec-title">{d.title}</span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          {p.repos ? (
            <section>
              <div class="vh-sec-h"><span class="v-label">Projects</span><button type="button" class="v-link" onClick={p.onSeeProjects}>All</button></div>
              <div class="vh-projlist">
                {p.repos.slice(0, 4).map((r) => (
                  <div key={r.id} class="vh-proj">
                    <Icon name="project" size={16} />
                    <span class="vh-proj-main"><b>{r.name}</b><span class="v-meta">{r.rooms.length ? `${r.rooms.length} ${r.rooms.length === 1 ? 'room' : 'rooms'}` : 'No rooms yet'} · {r.pathLabel}</span></span>
                  </div>
                ))}
                {p.missing.slice(0, 2).map((m) => (
                  <div key={m.repository} class="vh-proj is-missing">
                    <Icon name="branch" size={16} />
                    <span class="vh-proj-main"><b>{m.repository.replace(/^github\.com\//, '')}</b><span class="v-meta">Not on this machine · {m.rooms.map((r) => r.name).join(', ')}</span></span>
                    {p.onAddRepo ? <Button size="sm" variant="quiet" onClick={p.onAddRepo}>Add clone…</Button> : null}
                  </div>
                ))}
                {!p.repos.length && !p.missing.length ? <p class="vh-empty">No repositories added on this machine.</p> : null}
              </div>
            </section>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

function Needs({ items, onOpenRoom, onOpenInvite, now }: { items: NeedItem[]; onOpenRoom: (id: string) => void; onOpenInvite: (k: InviteKey) => void; now?: number }) {
  return (
    <div class="vh-needs vh-stagger">
      {items.map((it) => it.kind === 'invitation' ? (
        <div key={it.invitation.id} class="vh-need">
          <span class="vh-need-ico"><Icon name="mail" size={14} /></span>
          <span class="vh-need-main"><b>{it.invitation.inviterName} invited you to {it.invitation.roomName}</b><span>As {it.invitation.role} · {ago(it.invitation.sentAt, now)}</span></span>
          <span class="vh-need-acts"><Button size="sm" onClick={() => onOpenInvite({ invitationId: it.invitation.id })}>Open</Button></span>
        </div>
      ) : it.kind === 'room' ? (
        <div key={it.roomId} class="vh-need">
          <span class="vh-need-ico"><Icon name="room" size={14} /></span>
          <span class="vh-need-main"><b>{it.text}</b><span>{it.roomName}</span></span>
          <span class="vh-need-acts"><Button size="sm" onClick={() => onOpenRoom(it.roomId)}>Open room</Button></span>
        </div>
      ) : (
        <div key={it.id} class="vh-need">
          <span class="vh-need-ico"><Icon name="decision" size={14} /></span>
          <span class="vh-need-main"><b>Decision v{it.version} needs your signature</b><span>{it.roomName} · {it.proposedBy} proposed: {it.title}</span></span>
          <span class="vh-need-acts"><Button size="sm" onClick={() => onOpenRoom(it.roomId)}>Open room</Button></span>
        </div>
      ))}
    </div>
  );
}

const WORK_DOT = { active: 'live', attention: 'signal', completed: 'idle', unknown: 'idle' } as const;

function Work({ items, now }: { items: WorkItem[]; now?: number }) {
  return (
    <div class="vh-work">
      {items.slice(0, 4).map((w) => (
        <div key={w.id} class="vh-work-row">
          <span class="vh-work-top"><Dot tone={WORK_DOT[w.status]} /><span>{w.title}</span><span class="v-meta">{ago(w.lastActivityAt, now)}</span></span>
          <span class="v-meta">{STATUS_WORDS[w.status]} · {w.agent} · {w.repository}{w.branch ? ` · ${w.branch}` : ''}</span>
        </div>
      ))}
    </div>
  );
}

/** One room: its last shared view, name, repository and latest activity. Presence only when known. */
export function RoomTile({ room, onOpen, now }: { room: RoomCard; onOpen: () => void; now?: number }) {
  const live = room.presence?.inCall.length ?? 0;
  return (
    <button type="button" class="vh-room" onClick={onOpen} aria-label={`${room.name}${room.needs ? `, ${room.needs}` : ''}`}>
      <div class="vh-room-cv">
        <CanvasThumb preview={room.preview} />
        <div class="vh-room-tags">
          {room.needs ? <Badge tone="signal">Needs you</Badge> : null}
          {live ? <Badge tone="success" icon="mic">{live} in call</Badge> : null}
          {room.role === 'viewer' ? <Badge>Viewer</Badge> : null}
        </div>
      </div>
      <div class="vh-room-body">
        <span class="vh-room-name">{room.name}</span>
        <span class="vh-room-act">{room.needs ?? room.activity.text}</span>
        <span class="vh-room-foot">
          <RepoChip repository={room.repository} checkout={room.checkout} />
          {room.presence?.here.length ? <AvatarStack size={20} max={3} people={room.presence.here.map((x) => ({ initials: x.initials, tone: x.tone, name: x.name }))} /> : null}
          <span class="vh-resume">{ago(room.activity.at, now)}<Icon name="arrow-r" size={14} /></span>
        </span>
      </div>
    </button>
  );
}
