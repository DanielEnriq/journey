// Source: vowe-home-pass2.zip (approved Claude Design package, Pass 2), imports adapted to the vendored Preact.
/** Every room you're a member of (`rooms.list()`), most recently changed first. */
import { h } from '../../../vendor/preact.js';
import { useState } from '../../../vendor/preact-hooks.js';

import { Badge, Button, Field, Skeleton } from '../../components.js';
import { Icon } from '../../icons.js';

import { ago, CanvasThumb, RepoChip } from '../common.js';
import { ROLE_LABEL } from '../../../features/membership/model.js';
import type { RoomCard } from '../types.js';

export function RoomsIndex({ rooms, onOpen, onNewRoom, onJoinLink, error, onRetry, now }: {
  /** null while loading. */
  rooms: RoomCard[] | null;
  onOpen: (id: string) => void;
  onNewRoom: () => void;
  onJoinLink: () => void;
  error?: string | null;
  onRetry?: () => void;
  now?: number;
}) {
  const [q, setQ] = useState('');
  const shown = rooms?.filter((r) => !q || `${r.name} ${r.repository ?? ''}`.toLowerCase().includes(q.toLowerCase())) ?? null;
  return (
    <div class="vh-page vh-enter">
      <header class="vh-index-head">
        <div><div class="vh-eyebrow">Rooms</div><h1>Your rooms</h1></div>
        <div class="vh-ret-acts">
          {rooms && rooms.length > 5 ? <Field search icon="search" label="Filter rooms" placeholder="Filter" value={q} onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)} /> : null}
          <Button icon="link" onClick={onJoinLink}>Join with a link</Button>
          <Button variant="ink" icon="plus" onClick={onNewRoom}>New room</Button>
        </div>
      </header>
      {error ? (
        <div class="vh-notice" role="alert"><Icon name="warn" size={14} />Couldn’t read your rooms: {error}{onRetry ? <button type="button" class="v-link" onClick={onRetry}>Try again</button> : null}</div>
      ) : null}
      {shown === null ? (
        [0, 1, 2, 3].map((i) => <div key={i} class="vh-list-row" aria-busy="true"><div class="vh-list-thumb"><CanvasThumb preview={{ status: 'loading' }} /></div><div><Skeleton width="40%" height={16} /></div><Skeleton width="70%" /><Skeleton width="50%" /></div>)
      ) : shown.length ? shown.map((r) => (
        <button key={r.id} type="button" class="vh-list-row" onClick={() => onOpen(r.id)}>
          <div class="vh-list-thumb"><CanvasThumb preview={r.preview} /></div>
          <div class="vh-list-main"><b>{r.name}</b><span>{r.needs ?? r.activity.text}</span></div>
          <RepoChip repository={r.repository} checkout={r.checkout} />
          <span class="vh-list-end">
            {r.needs ? <Badge tone="signal">Needs you</Badge> : r.presence?.inCall.length ? <Badge tone="success" icon="mic">{r.presence.inCall.length} in call</Badge> : <Badge>{ROLE_LABEL[r.role]}</Badge>}
            <span class="v-meta">{ago(r.activity.at, now)}</span>
          </span>
        </button>
      )) : rooms?.length ? (
        <p class="vh-empty" style={{ marginTop: '16px' }}>No rooms match “{q}”.</p>
      ) : (
        <p class="vh-empty" style={{ marginTop: '16px' }}>No rooms yet. Rooms you start or get invited to live here, with whatever needs you on top.</p>
      )}
    </div>
  );
}
